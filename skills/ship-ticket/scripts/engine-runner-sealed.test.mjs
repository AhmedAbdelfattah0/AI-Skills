/**
 * S-01b2 FX: sealed runner results (design rev 6 §2). The threat: test or worker code in the
 * candidate runs with the engine's uid and can leave a detached (setsid) survivor that escapes
 * group quiescence. Before FX such a survivor could plant FIFOs at the launcher's `.out` and
 * envelope paths (both visible in the launcher's argv) and replace the recorded outcome of a RED,
 * PROVE or unit-check run, or hang the engine in a synchronous read.
 *
 * Every row drives the REAL `io.gateRunner` and the REAL launcher. The gateRunner runs in a child
 * "driver" process so a synchronous engine hang (the pre-FX FIFO read) is observable and killable
 * from this process: a hang is an assertion failure here, never a stuck suite.
 *
 * Rows (design §2.4 and §5.2 FX ACs):
 * - S1   (POSIX)  FIFO forger, both write orders: fired, never accepted, no hang.
 * - S1w  (all)    1 ms path-overwrite forger of `.out` and the envelope: result equals the genuine run.
 * - S2a  (darwin) a survivor rewriting the argv report path (/dev/fd/3) has no effect.
 * - S2b  (darwin) a survivor holding the report channel past the runner's exit: `runner_survivor`.
 * - S3            positive: exit code, stdout and report bytes exactly as the runner wrote them.
 * - AC5           workers' launch is byte-identical to fe5d075 (argv hashes, stdio, options).
 * - AC6  (POSIX)  the result pipe (launcher fd 1) is not open in the runner or its descendants.
 * - frame         a frame for another attempt, or an exit status that disagrees, is refused.
 * Off darwin the report channel is refused as `channel_unsupported` (Linux: /dev/fd/N on a
 * socketpair fails ENXIO, measured in Docker node:18; win32: no /dev/fd).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launcherArgs } from './launcher.mjs';
import * as io from './engine-io.mjs';

const POSIX = process.platform !== 'win32';
const DARWIN = process.platform === 'darwin';
const POSIX_SKIP = POSIX ? false : 'win32: no mkfifo/sh and no POSIX process groups (S1w covers the path forger on win32)';
const ENGINE_IO = pathToFileURL(fileURLToPath(new URL('./engine-io.mjs', import.meta.url))).href;
const J = JSON.stringify;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const FORGED_OUT = 'ok 1 - [kind:negative] forged\n';
const GENUINE_FAIL = 'not ok 1 - real\n';

/** The gateRunner driver: runs one attempt and prints one JSON line; prints `PID <pid>` on stderr first. */
const DRIVER = `
const io = await import(${J(ENGINE_IO)});
const cfg = JSON.parse(process.argv[2]);
const run = io.gateRunner({ repoRoot: cfg.repoRoot, dir: cfg.dir, platform: process.platform, env: process.env,
  toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: (g) => io.groupAlive(g) });
const t0 = Date.now();
let out;
try {
  const launch = await run({ attempt_id: cfg.id, command: { cmd: cfg.cmd, args: cfg.args }, timeoutMs: cfg.timeoutMs, ...(cfg.report ? { report: true } : {}) });
  process.stderr.write('PID ' + launch.pid + '\\n');
  launch.release();
  const r = await launch.done;
  out = { settled: 'resolved', exitCode: r.exitCode, stdout: r.stdout, timedOut: r.timedOut, quiescent: r.quiescent,
    report: r.report ? Buffer.from(r.report).toString('base64') : null, report_eof: r.report_eof ?? null };
} catch (e) { out = { settled: 'rejected', code: e.code ?? null, message: String(e.message) }; }
out.ms = Date.now() - t0;
process.stdout.write(JSON.stringify(out));
`;

/**
 * The runner fixture (CommonJS). argv: <mode> ...; modes are described inline. Every forger
 * publishes readiness only after its plant is installed, and the fixture waits for it (L2).
 */
const FIXTURE = String.raw`'use strict';
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const [mode, ...rest] = process.argv.slice(2);
const exitWith = (text, code) => process.stdout.write(text, () => process.exit(code));
/** The launcher's own argv (it is our parent): the forensic paths are visible there. */
const launcherArgv = () => {
  const a = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8' });
  const pick = (k) => (a.match(new RegExp('"' + k + '":"([^"]+)"')) || [])[1];
  return { out: pick('outFile'), env: pick('envelopeFile'), id: pick('attemptId') };
};
/** Wait for "R" on a detached child's stdout, then let it go. */
const whenReady = (child, cb) => {
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; if (buf.includes('R')) { child.stdout.destroy(); child.unref(); cb(); } });
  child.on('exit', (c) => { if (!buf.includes('R')) { process.stderr.write('forger failed ' + c); process.exit(99); } });
};
if (mode === 'plain') exitWith(rest[0], Number(rest[1]));
else if (mode === 'fifo-forge') {
  // E2: plant FIFOs (via symlinks) where the launcher writes; swallow its bytes; then feed the engine a forged pass.
  const [order, dir] = rest;
  const L = launcherArgv();
  const forged = JSON.stringify({ schema: 'ship-ticket-engine-envelope-v1', attempt_id: L.id, exit_code: 0, signal: null, spawn_error: null, stdout_file: L.out });
  const writeE = 'printf %s "$4" > "$1/e.fifo"', writeO = 'printf "ok 1 - [kind:negative] forged\\n" > "$1/o.fifo"';
  const sh = 'set -e; mkfifo "$1/o.fifo" "$1/e.fifo"; ln -s "$1/o.fifo" "$2"; ln -s "$1/e.fifo" "$3.tmp"; echo $$ > "$1/forger.pid"; echo R; exec >/dev/null; '
    + 'cat "$1/o.fifo" >/dev/null; cat "$1/e.fifo" >/dev/null; echo swallowed > "$1/forger.swallowed"; '
    + (order === 'eo' ? writeE + '; ' + writeO : writeO + '; ' + writeE) + '; echo fed > "$1/forger.fed"';
  whenReady(spawn('sh', ['-c', sh, 'forger', dir, L.out, L.env, forged], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }), () => exitWith('not ok 1 - real\n', 1));
} else if (mode === 'poll-forge') {
  // S1w: overwrite .out and the envelope by path every 1 ms for 8 s (paths from argv: works on win32 too).
  const [out, envelope, dir, forged] = rest;
  const src = 'const fs=require("fs");const [o,e,d,f]=process.argv.slice(1);fs.writeFileSync(d+"/poller.pid",String(process.pid));let n=0;const end=Date.now()+8000;'
    + 'const tick=()=>{try{fs.writeFileSync(o,"ok 1 - [kind:negative] forged\\n");fs.writeFileSync(e,f);n++;}catch{}'
    + 'try{fs.writeFileSync(d+"/poller.count",String(n));}catch{}if(n===1){try{process.stdout.write("R");}catch{}}if(Date.now()<end)setTimeout(tick,1);};tick();';
  whenReady(spawn(process.execPath, ['-e', src, out, envelope, dir, forged], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }), () => exitWith('not ok 1 - real\n', 1));
} else if (mode === 'report') {
  // Write the report THROUGH THE PATH (as vitest --outputFile=/dev/fd/3 does), then stdout, then exit.
  const [reportSrc, stdoutSrc, code, reportPath] = rest;
  fs.writeFileSync(reportPath, fs.readFileSync(reportSrc));
  process.stdout.write(fs.readFileSync(stdoutSrc), () => process.exit(Number(code)));
} else if (mode === 'report-path-forge') {
  // S2a: a survivor rewrites the argv report path after the runner exits (barrier: its stdin hits EOF when we exit).
  const [reportSrc, reportPath, dir] = rest;
  const src = 'const fs=require("fs");const [p,d]=process.argv.slice(1);fs.writeFileSync(d+"/pathforger.pid",String(process.pid));process.stdout.write("R");process.stdout.destroy();'
    + 'process.stdin.resume();process.stdin.on("end",()=>{const errs={};let ok=0;for(let i=0;i<300;i++){try{fs.writeFileSync(p,"FORGED-REPORT");ok++;}catch(x){errs[x.code]=(errs[x.code]||0)+1;}}'
    + 'fs.writeFileSync(d+"/pathforger.done",JSON.stringify({ok,errs}));process.exit(0);});';
  const f = spawn(process.execPath, ['-e', src, reportPath, dir], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  whenReady(f, () => { fs.writeFileSync(reportPath, fs.readFileSync(reportSrc)); exitWith('ok 1 - real\n', 0); });
} else if (mode === 'report-holder') {
  // S2b: a survivor inherits the report channel (fd 3), writes into it after the runner exits and keeps it open.
  const [reportSrc, reportPath, dir] = rest;
  const src = 'const fs=require("fs");const d=process.argv[1];fs.writeFileSync(d+"/holder.pid",String(process.pid));process.stdout.write("R");process.stdout.destroy();'
    + 'process.stdin.resume();process.stdin.on("end",()=>{try{fs.writeSync(3,"INJECT-AFTER-EXIT");}catch{}fs.writeFileSync(d+"/holder.injected","1");setTimeout(()=>{},20000);});';
  const f = spawn(process.execPath, ['-e', src, dir], { detached: true, stdio: ['pipe', 'pipe', 'ignore', 3] });
  whenReady(f, () => { fs.writeFileSync(reportPath, fs.readFileSync(reportSrc)); exitWith('ok 1 - real\n', 0); });
} else if (mode === 'probe') {
  // AC6: descriptor identities of the launcher's fd 1 (the result pipe) versus the runner and its descendants.
  const ids = (pid, fds) => {
    if (process.platform === 'linux') {
      const out = {};
      for (const fd of fs.readdirSync('/proc/' + pid + '/fd')) { if (fds && !fds.includes(Number(fd))) continue; try { out[fd] = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch {} }
      return Object.values(out).filter((v) => /^(socket|pipe):/.test(v));
    }
    const text = execFileSync('lsof', ['-a', '-p', String(pid), '-d', fds ? fds.join(',') : '0-255', '-F', 'ftd'], { encoding: 'utf8' });
    const rows = []; let cur = null;
    for (const l of text.split('\n')) {
      if (l[0] === 'f') { cur = { fd: l.slice(1) }; rows.push(cur); } else if (cur && l[0] === 't') cur.t = l.slice(1); else if (cur && l[0] === 'd') cur.d = l.slice(1);
    }
    return rows.filter((r) => (r.t === 'unix' || r.t === 'PIPE') && r.d).map((r) => r.t + ':' + r.d);
  };
  const kids = [
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'inherit' }),
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'pipe' }),
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'inherit', detached: true }),
    spawn('sh', ['-c', 'sleep 30'], { stdio: 'inherit' }),
  ];
  setTimeout(() => {
    const result = { launcherFd1: ids(process.ppid, [1]), runnerFd1: ids(process.pid, [1]), runner: ids(process.pid), kids: kids.map((k) => ids(k.pid)) };
    for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
    exitWith(JSON.stringify(result) + '\n', 0);
  }, 300);
} else { process.stderr.write('unknown mode ' + mode); process.exit(98); }
`;

/** A fresh work dir with the driver and fixture; cleanup kills every recorded survivor (by its group on POSIX). */
function world(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-')));
  writeFileSync(join(dir, 'driver.mjs'), DRIVER);
  writeFileSync(join(dir, 'fixture.cjs'), FIXTURE);
  t.after(() => {
    for (const f of ['forger.pid', 'poller.pid', 'pathforger.pid', 'holder.pid']) {
      if (!existsSync(join(dir, f))) continue;
      const pid = Number(readFileSync(join(dir, f), 'utf8').trim());
      if (!pid) continue;
      try { process.kill(POSIX ? -pid : pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, attempts: join(dir, 'attempts'), fixture: join(dir, 'fixture.cjs') };
}

/**
 * Run one gateRunner attempt in a driver child; `{ hung: true }` when it has not printed a result
 * within `deadlineMs` (the driver and its launcher group are then SIGKILLed).
 */
function drive(w, { id = 'att-' + randomUUID(), args, timeoutMs = 20000, report = false, deadlineMs = 30000 }) {
  const cfg = { repoRoot: w.dir, dir: w.attempts, id, cmd: process.execPath, args: [w.fixture, ...args], timeoutMs, report };
  const child = spawn(process.execPath, [join(w.dir, 'driver.mjs'), J(cfg)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const m = /PID (\d+)/.exec(err);
      if (m && POSIX) { try { process.kill(-Number(m[1]), 'SIGKILL'); } catch { /* gone */ } }
      child.kill('SIGKILL');
      resolve({ id, hung: true, stderr: err });
    }, deadlineMs);
    child.on('close', () => {
      clearTimeout(timer);
      let r;
      try { r = JSON.parse(out); } catch { r = { settled: 'driver_failed', raw: out, stderr: err }; }
      resolve({ id, ...r });
    });
  });
}

const accepted = (r) => r.settled === 'resolved' && !r.timedOut;

for (const order of ['eo', 'oe']) {
  test(`S1 FIFO forger (${order === 'eo' ? 'envelope then out: forged pass on fe5d075' : 'out then envelope: engine hang on fe5d075'}): fired, never accepted, no hang`, { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
    const w = world(t);
    const r = await drive(w, { args: ['fifo-forge', order, w.dir] });
    // The forger fired: its ready marker is published only after both symlinks were planted (set -e).
    assert.ok(existsSync(join(w.dir, 'forger.pid')), 'the forger never planted (the row would prove nothing)');
    assert.ok(lstatSync(join(w.dir, 'o.fifo')).isFIFO() && lstatSync(join(w.dir, 'e.fifo')).isFIFO());
    t.diagnostic(`result: ${J(r)}`);
    assert.notEqual(r.hung, true, `gateRunner.done did not settle within 30 s (forger order ${order})`);
    assert.ok(r.ms < 20000, `done settled after ${r.ms} ms (> 20 s)`);
    assert.doesNotMatch(J(r), /forged/, 'a forged byte reached the result');
    if (r.settled === 'resolved') {
      assert.equal(r.exitCode, 1, J(r));
      assert.equal(r.stdout, GENUINE_FAIL);
    } else assert.equal(r.code, 'runner_output_tampered', J(r));
  });
}

test('S1w path-overwrite forger (1 ms poll of .out and the envelope): the result equals the genuine run', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const id = 'att-' + randomUUID();
  const forged = J({ schema: 'ship-ticket-engine-envelope-v1', attempt_id: id, exit_code: 0, signal: null, spawn_error: null });
  const r = await drive(w, { id, args: ['poll-forge', join(w.attempts, id + '.out'), join(w.attempts, id + '.envelope.json'), w.dir, forged] });
  assert.ok(Number(readFileSync(join(w.dir, 'poller.count'), 'utf8')) >= 1, 'the poller never wrote (the row would prove nothing)');
  assert.notEqual(r.hung, true);
  assert.equal(r.settled, 'resolved', J(r));
  assert.equal(r.exitCode, 1, J(r));
  assert.equal(r.stdout, GENUINE_FAIL);
});

/** A deterministic vitest-json-shaped report of about `n` bytes (S3 wants one larger than any pipe buffer). */
function vitestReport(n) {
  const results = [];
  for (let i = 0; results.length * 120 < n; i++) results.push({ ancestorTitles: ['suite'], title: `[kind:negative] case ${i}`, status: 'passed', fullName: `suite case ${i}` });
  return Buffer.from(J({ numTotalTests: results.length, numPassedTests: results.length, success: true, testResults: [{ name: '/repo/a.spec.ts', status: 'passed', assertionResults: results }] }));
}

test('S3 positive: exit code, stdout and report bytes arrive exactly as the runner wrote them', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const report = vitestReport(2.5 * 1024 * 1024);
  const stdout = Buffer.from('x'.repeat(1024 * 1024) + '\nok 1 - real\n');
  writeFileSync(join(w.dir, 'report.json'), report);
  writeFileSync(join(w.dir, 'stdout.txt'), stdout);
  const args = ['report', join(w.dir, 'report.json'), join(w.dir, 'stdout.txt'), '0', '/dev/fd/3'];
  if (!DARWIN) {
    const r = await drive(w, { args, report: true });
    assert.equal(r.settled, 'rejected', J(r));
    assert.equal(r.code, 'channel_unsupported', J(r));
    return;
  }
  const r = await drive(w, { args, report: true });
  assert.equal(r.settled, 'resolved', J(r).slice(0, 400));
  assert.equal(r.exitCode, 0);
  assert.equal(r.report_eof, true);
  assert.equal(sha256(Buffer.from(r.report, 'base64')), sha256(report), 'report bytes differ');
  assert.equal(sha256(r.stdout), sha256(stdout), 'stdout bytes differ');
});

test('S3 positive without a report: a genuine exit code and stdout, on every OS', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const fail = await drive(w, { args: ['plain', 'not ok 1 - three\n', '3'] });
  assert.equal(fail.settled, 'resolved', J(fail));
  assert.deepEqual([fail.exitCode, fail.stdout, fail.report], [3, 'not ok 1 - three\n', null]);
  const pass = await drive(w, { args: ['plain', 'ok 1 - fine\n', '0'] });
  assert.deepEqual([pass.settled, pass.exitCode, pass.stdout], ['resolved', 0, 'ok 1 - fine\n']);
});

test('S2a a survivor rewriting the argv report path (/dev/fd/3) after the runner exits has no effect', { skip: DARWIN ? false : 'report channel is darwin-only (Linux: /dev/fd/N on a socketpair is ENXIO; win32: no /dev/fd): S3 asserts channel_unsupported', timeout: 60000 }, async (t) => {
  const w = world(t);
  const report = vitestReport(4096);
  writeFileSync(join(w.dir, 'report.json'), report);
  const r = await drive(w, { args: ['report-path-forge', join(w.dir, 'report.json'), '/dev/fd/3', w.dir], report: true });
  assert.equal(r.settled, 'resolved', J(r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.report_eof, true);
  assert.equal(Buffer.from(r.report, 'base64').toString(), report.toString());
  // The forger fired after the runner exited (its stdin EOF is the barrier) and attempted every write.
  const fired = await waitFor(() => existsSync(join(w.dir, 'pathforger.done')));
  assert.ok(fired, 'the path forger never ran (the row would prove nothing)');
  const done = JSON.parse(readFileSync(join(w.dir, 'pathforger.done'), 'utf8'));
  t.diagnostic(`path forger writes: ${J(done)}`);
  assert.equal(done.ok + Object.values(done.errs).reduce((a, b) => a + b, 0), 300, J(done));
});

test('S2b a survivor holding the report channel past the runner exit: runner_survivor, nothing accepted', { skip: DARWIN ? false : 'report channel is darwin-only (see S2a)', timeout: 60000 }, async (t) => {
  const w = world(t);
  writeFileSync(join(w.dir, 'report.json'), vitestReport(4096));
  const r = await drive(w, { args: ['report-holder', join(w.dir, 'report.json'), '/dev/fd/3', w.dir], report: true });
  assert.ok(existsSync(join(w.dir, 'holder.pid')), 'the holder never started (the row would prove nothing)');
  assert.notEqual(r.hung, true);
  assert.equal(r.settled, 'rejected', J(r).slice(0, 300));
  assert.equal(r.code, 'runner_survivor', J(r));
  assert.doesNotMatch(J(r), /INJECT/);
});

/** Bounded wait for a marker another process publishes after its state is installed (never a sync sleep). */
async function waitFor(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return pred();
}

// AC5 pins: sha256(JSON.stringify(launcherArgs(spec))) on fe5d075 for these exact specs.
const WORKER = { file: '/bin/echo', args: ['a', 'b c'], shell: false, promptFile: '/p/x.prompt', outFile: '/p/x.out', envelopeFile: '/p/x.envelope.json', attemptId: 'att-1' };
const PINS = {
  worker: 'dd74767280ecca2c74a70758a35a951a384d443666dad13816e3c39398963bec',
  workerNoSample: 'ee08ed9351c22f823dbb05da1abbb35a7862df595302aa3341ac4432f475401b',
  carrier: '0e8d0c0bdbbab45dc8556ac137e7b2bef9907b992f84d9c0ef37d5b721d7f2f6',
};

test('AC5 workers launch byte-identical to fe5d075: launcher argv (worker and carrier), stdio and spawn options', () => {
  const off = process.env.SHIP_TICKET_SAMPLER_OFF === '1';
  assert.equal(sha256(J(launcherArgs({ ...WORKER, sample: false }))), PINS.workerNoSample);
  assert.equal(sha256(J(launcherArgs(WORKER))), off ? PINS.workerNoSample : PINS.worker);
  if (!off) assert.equal(sha256(J(launcherArgs({ file: '/bin/echo', args: ['a'], shell: false }))), PINS.carrier);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    const spawnFn = (file, args, opts) => { calls.push({ file, args, opts }); return {}; };
    const env = { A: '1' };
    io.startLauncher({ spawnFn, spec: { file: WORKER.file, args: WORKER.args, shell: false }, cwd: '/repo', env, platform,
      files: { promptFile: WORKER.promptFile, outFile: WORKER.outFile, envelopeFile: WORKER.envelopeFile, attemptId: WORKER.attemptId } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args, launcherArgs(WORKER));
    assert.deepEqual(calls[0].opts, { cwd: '/repo', env, detached: platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  }
});

test('AC6 the result pipe (launcher fd 1) is open in no runner process or descendant', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  if (process.platform !== 'linux' && spawnSync('lsof', ['-v']).error) return t.skip('lsof is not installed (darwin probe needs it)');
  const w = world(t);
  const r = await drive(w, { args: ['probe'] });
  assert.equal(r.settled, 'resolved', J(r));
  assert.equal(r.exitCode, 0, J(r));
  const p = JSON.parse(r.stdout);
  // Positive controls: the probe sees the launcher's fd 1, and it detects a descriptor shared by
  // inheritance (the runner's own stdout pipe is found in its stdio-inheriting children).
  assert.equal(p.launcherFd1.length, 1, `probe did not see the launcher's fd 1 as a pipe/socket: ${J(p)}`);
  assert.equal(p.runnerFd1.length, 1, J(p));
  assert.ok(p.kids[0].includes(p.runnerFd1[0]) && p.kids[2].includes(p.runnerFd1[0]), `probe cannot detect shared descriptors: ${J(p)}`);
  for (const [who, list] of [['runner', p.runner], ...p.kids.map((k, i) => [`descendant ${i}`, k])]) {
    assert.ok(!list.includes(p.launcherFd1[0]), `${who} holds the result pipe ${p.launcherFd1[0]}`);
  }
});

/** A gateRunner whose launcher is replaced (through spawnFn) by `script`: it emits whatever frame the row wants. */
function fakeLauncherRun(w, script, id) {
  const run = io.gateRunner({ repoRoot: w.dir, dir: w.attempts, platform: process.platform, env: process.env,
    toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: (g) => io.groupAlive(g),
    spawnFn: (file, args, opts) => spawn(file, ['-e', script, args[2]], opts) });
  return run({ attempt_id: id, command: { cmd: process.execPath, args: ['-e', ''] }, timeoutMs: 20000 })
    .then(async (launch) => { launch.release(); return launch.done; });
}

/** Launcher stand-in: waits for the release byte, writes `frame(spec)` to fd 1, exits with `code`. */
const fakeLauncher = (frameExpr, code) => `const fs=require('fs');const spec=JSON.parse(process.argv[1]);process.stdin.once('data',()=>{
  const head=(o)=>Buffer.from(JSON.stringify(Object.assign({schema:'ship-ticket-sealed-result-v1',attempt_id:spec.attemptId,exit_code:0,signal:null,spawn_error:null,out_len:0,truncated:false,stdout_bytes:0,out_eof:true,report:false,report_len:0,report_truncated:false,report_bytes:0,report_eof:false},o))+'\\n');
  fs.writeSync(1, ${frameExpr});process.exit(${code});});`;

test('frame: a frame for another attempt, a disagreeing exit status, two frames or trailing bytes are refused (runner_output_tampered)', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const cases = {
    other_attempt: [fakeLauncher(`Buffer.concat([head({attempt_id:'att-other',out_len:3}),Buffer.from('ok\\n')])`, 0)],
    exit_disagrees: [fakeLauncher(`Buffer.concat([head({exit_code:0,out_len:3}),Buffer.from('ok\\n')])`, 1)],
    two_frames: [fakeLauncher(`Buffer.concat([head({out_len:3}),Buffer.from('ok\\n'),head({out_len:3}),Buffer.from('ok\\n')])`, 0)],
    trailing: [fakeLauncher(`Buffer.concat([head({out_len:3}),Buffer.from('ok\\nok 2\\n')])`, 0)],
    short: [fakeLauncher(`Buffer.concat([head({out_len:30}),Buffer.from('ok\\n')])`, 0)],
    no_frame: [fakeLauncher(`Buffer.from('ok 1 - forged\\n')`, 0)],
  };
  for (const [name, [script]] of Object.entries(cases)) {
    const res = await fakeLauncherRun(w, script, 'att-' + randomUUID()).then((r) => ({ resolved: r }), (e) => ({ code: e.code, message: e.message }));
    assert.equal(res.code, 'runner_output_tampered', `${name}: ${J(res)}`);
  }
  // Control: the same stand-in with a well-formed frame for this attempt and an agreeing status is accepted.
  const ok = await fakeLauncherRun(w, fakeLauncher(`Buffer.concat([head({out_len:3}),Buffer.from('ok\\n')])`, 0), 'att-' + randomUUID());
  assert.deepEqual([ok.exitCode, ok.stdout], [0, 'ok\n']);
});
