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
 * Rows (design §2.4 and §5.2 FX ACs, plus the exit-boundary latch of the PR #94 repair):
 * - S1   (POSIX)  FIFO forger, both write orders: fired, never accepted, no hang.
 * - S1w  (all)    1 ms path-overwrite forger of `.out` and the envelope: result equals the genuine run.
 * - S2a  (darwin) a survivor rewriting the argv report path (/dev/fd/3) has no effect.
 * - S2b  (darwin) a survivor holding the report channel past the runner's exit: `runner_survivor`.
 * - (a)-(d)       a survivor that writes to the report channel or stdout after the runner exits
 *                 and keeps it open through that channel's EOF check in the launcher's exit
 *                 callback (it closes only on EPIPE, or inside the old 1 s drain): `runner_survivor`.
 * - boundary      deterministic through the launcher's testHooks: a survivor that writes and closes
 *                 DURING the exit callback's reads (after the one latching read) is refused; output
 *                 still unread when `exit` fires is collected by those reads (not refused).
 * - S3            positive: exit code, stdout and report bytes exactly as the runner wrote them;
 *                 a non-detached child that exits before the runner is not a survivor.
 * - AC5           workers' launch is byte-identical to fe5d075 (argv hashes, stdio, options).
 * - AC6  (POSIX)  the result pipe (launcher fd 1) is not open in the runner or its descendants.
 * - frame         another attempt, a disagreeing exit, a malformed header, a non-exit boundary or
 *                 an oversized frame is refused; forensic tmp plants are never written through.
 * - callers       gateRed, unit checks and proof keep the typed code; unit checks never retry it.
 * Claim (exact): the decision predicate is the OBSERVED EOF/open/read-error state of each
 * channel at its latching read in the exit callback, per channel, platform and read cap (runner
 * stdout on POSIX; plus the report channel on darwin, whose latching read comes after stdout's).
 * A channel still open there (EAGAIN), returning bytes after that read, or failing to read is
 * refused. Writes made earlier, or during earlier reads before the latch, are accepted, including
 * those of a process handed the descriptor by an in-run holder; no additional verdict manipulation
 * has been demonstrated under the current adapters and the tested threat model (see the in-run
 * injection risk R-T2). This is not an atomic snapshot and writers are not authenticated.
 * Measured in the PR body, not asserted here: a fast write-then-close survivor is accepted on
 * 4180cbc in Linux N18 100/100, N22 91/100; darwin N18 84/100, N22 6/100. RECOMMENDED for temporary risk
 * acceptance; the owner's decision is PENDING (HANDOVER OD-D4 reverted on 2026-11-18); FX-R1.
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
import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';
import { gateRed } from './gate.mjs';
import { fixture, passReview } from './engine-test-fixture.mjs';

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
  const launch = await run(cfg.request);
  process.stderr.write('PID ' + launch.pid + '\\n');
  launch.release();
  const r = await launch.done;
  out = { settled: 'resolved', exitCode: r.exitCode, stdout: r.stdout, timedOut: r.timedOut, quiescent: r.quiescent,
    stdout_eof: r.stdout_eof ?? null, report: r.report ? Buffer.from(r.report).toString('base64') : null, report_eof: r.report_eof ?? null };
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
} else if (mode === 'fifo-block') {
  // A FIFO with no reader at the .out path and the envelope's tmp path: any open of them for write blocks forever.
  const L = launcherArgv();
  execFileSync('mkfifo', [L.out, L.env + '.tmp']);
  exitWith('not ok 1 - real\n', 1);
} else if (mode === 'poll-forge') {
  // S1w: overwrite .out and the envelope by path every 1 ms for 8 s (paths from argv: works on win32 too).
  const [out, envelope, dir, forged] = rest;
  const src = 'const fs=require("fs");const [o,e,d,f]=process.argv.slice(1);fs.writeFileSync(d+"/poller.pid",String(process.pid));let n=0;const end=Date.now()+8000;'
    + 'const tick=()=>{try{fs.writeFileSync(o,"ok 1 - [kind:negative] forged\\n");fs.writeFileSync(e,f);n++;}catch{}'
    + 'try{fs.writeFileSync(d+"/poller.count",String(n));}catch{}if(n===1){try{process.stdout.write("R");}catch{}}if(Date.now()<end)setTimeout(tick,1);};tick();';
  whenReady(spawn(process.execPath, ['-e', src, out, envelope, dir, forged], { detached: true, cwd: require('os').tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }), () => exitWith('not ok 1 - real\n', 1));
} else if (mode === 'late-writer') {
  // A detached survivor that inherits the runner's stdout (fd 1) or report channel (fd 3), learns of
  // the runner's exit (its stdin, held only by the runner, hits EOF), then writes PAYLOAD there. It
  // keeps the channel open until a write fails (the launcher closed its end) or, with fallback > 0,
  // closes it after FALLBACK ms: inside the old 1 s drain, so the pre-latch launcher accepted it.
  const [fd, payload, genuine, code, dir, fallback, reportSrc] = rest;
  const src = 'const fs=require("fs");const [fd,p,d,fb]=process.argv.slice(1).map((v,i)=>i===0||i===3?Number(v):v);'
    + 'fs.writeFileSync(d+"/late.pid",String(process.pid));fs.writeSync(4,"R");fs.closeSync(4);'
    + 'process.stdin.resume();process.stdin.on("end",()=>{let wrote=false;try{fs.writeSync(fd,p);wrote=true;}catch{}'
    + 'const end=(how)=>{clearInterval(t);clearTimeout(f);try{fs.closeSync(fd);}catch{}fs.writeFileSync(d+"/late.json",JSON.stringify({how,wrote}));setTimeout(()=>{},20000);};'
    + 'const t=setInterval(()=>{try{fs.writeSync(fd,"\\n");}catch(e){end("closed:"+e.code);}},5);'
    + 'const f=fb>0?setTimeout(()=>end("fallback"),fb):null;});';
  const f = spawn(process.execPath, ['-e', src, fd, payload, dir, fallback], { detached: true,
    stdio: ['pipe', fd === '1' ? 'inherit' : 'ignore', 'ignore', fd === '3' ? 3 : 'ignore', 'pipe'] });
  f.stdio[4].on('data', () => {
    f.stdio[4].destroy(); f.unref();
    if (reportSrc) fs.writeFileSync('/dev/fd/3', fs.readFileSync(reportSrc));
    exitWith(genuine, Number(code));
  });
} else if (mode === 'drain-writer') {
  // A detached survivor holding stdout that writes and closes WHILE the launcher reads stdout in its
  // exit callback (the launcher's testHooks pause it after its first read and publish pauseFile).
  const [pauseFile, resumeFile, dir, lead] = rest;
  const src = 'const fs=require("fs");const [pf,rf,d]=process.argv.slice(1);fs.writeFileSync(d+"/late.pid",String(process.pid));fs.writeSync(3,"R");fs.closeSync(3);'
    + 'const t=setInterval(()=>{if(!fs.existsSync(pf))return;clearInterval(t);fs.writeSync(1,"AFTER_FIRST_READ\\n");fs.closeSync(1);fs.writeFileSync(rf,"");setTimeout(()=>{},20000);},2);';
  const f = spawn(process.execPath, ['-e', src, pauseFile, resumeFile, dir], { detached: true, stdio: ['ignore', 'inherit', 'ignore', 'pipe'] });
  f.stdio[3].on('data', () => { f.stdio[3].destroy(); f.unref(); exitWith('x'.repeat(Number(lead || 0)) + 'BEFORE_DRAIN\n', 0); });
} else if (mode === 'tmp-plant') {
  // A regular file at the .out tmp name and a symlink (to a victim file) at the envelope tmp name.
  const [dir] = rest;
  const L = launcherArgv();
  fs.writeFileSync(L.out + '.tmp', 'PLANTED-OUT');
  fs.symlinkSync(dir + '/victim.txt', L.env + '.tmp');
  exitWith('not ok 1 - real\n', 1);
} else if (mode === 'child-then-exit') {
  // Legitimate: a non-detached child inherits stdout, writes, and exits before the runner does.
  const c = spawn(process.execPath, ['-e', 'process.stdout.write("child line\\n")'], { stdio: ['ignore', 'inherit', 'ignore'] });
  c.on('exit', () => exitWith('ok 1 - parent\n', 0));
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
    spawn('sh', ['-c', 'exec sleep 30'], { stdio: 'inherit' }),
  ];
  Promise.all(kids.map((k) => new Promise((r) => k.once('spawn', r)))).then(() => {
    const result = { launcherFd1: ids(process.ppid, [1]), runnerFd1: ids(process.pid, [1]), runner: ids(process.pid), kids: kids.map((k) => ids(k.pid)) };
    // Every descendant must be gone before the runner exits: one still holding stdout is a survivor.
    Promise.all(kids.map((k) => new Promise((r) => { k.once('exit', r); try { k.kill('SIGKILL'); } catch {} })))
      .then(() => exitWith(JSON.stringify(result) + '\n', 0));
  });
} else { process.stderr.write('unknown mode ' + mode); process.exit(98); }
`;

/** A fresh work dir with the driver and fixture; cleanup kills every recorded survivor (by its group on POSIX). */
function world(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-')));
  writeFileSync(join(dir, 'driver.mjs'), DRIVER);
  writeFileSync(join(dir, 'fixture.cjs'), FIXTURE);
  t.after(async () => {
    const killed = [];
    for (const f of ['forger.pid', 'poller.pid', 'pathforger.pid', 'holder.pid', 'late.pid', 'pipeholder.pid']) {
      if (!existsSync(join(dir, f))) continue;
      const pid = Number(readFileSync(join(dir, f), 'utf8').trim());
      if (!pid) continue;
      try { process.kill(POSIX ? -pid : pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      killed.push(pid);
    }
    // win32 (L10): a process that is still exiting keeps the directory busy (EBUSY); wait until each is gone.
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
    await waitFor(() => killed.every(gone), 5000);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { dir, attempts: join(dir, 'attempts'), fixture: join(dir, 'fixture.cjs') };
}

/**
 * Run one gateRunner attempt in a driver child; `{ hung: true }` when it has not printed a result
 * within `deadlineMs` (the driver and its launcher group are then SIGKILLed). The engine's own
 * runner timeout is the long failure bound: "no hang" is this deadline, not the engine's timer.
 */
function drive(w, { id = 'att-' + randomUUID(), args, report = false, deadlineMs = 30000 }) {
  const request = { attempt_id: id, command: { cmd: process.execPath, args: [w.fixture, ...args] }, timeoutMs: WORKER_FAILURE_BOUND_MS, ...(report ? { report: true } : {}) };
  const cfg = { repoRoot: w.dir, dir: w.attempts, request };
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

test('S1 reader-less FIFOs planted at .out and the envelope tmp: the launcher never blocks on a forensic file', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  const r = await drive(w, { args: ['fifo-block'] });
  assert.ok(lstatSync(join(w.attempts, r.id + '.envelope.json.tmp')).isFIFO(), 'the plant never happened (the row would prove nothing)');
  assert.notEqual(r.hung, true, J(r));
  assert.equal(r.settled, 'resolved', J(r));
  assert.equal(r.timedOut, false, J(r));
  assert.ok(r.ms < 20000, `done settled after ${r.ms} ms`);
  assert.deepEqual([r.exitCode, r.stdout], [1, GENUINE_FAIL]);
});

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

test('AC6 the result pipe (launcher fd 1) is open in no runner process or descendant', { skip: POSIX ? false : 'win32: no lsof or /proc to list a process\'s descriptors, so isolation there is reasoned (libuv opens every non-stdio handle non-inheritable), not probed', timeout: 60000 }, async (t) => {
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
function fakeLauncherRun(w, script, id, opts = {}) {
  const run = io.gateRunner({ repoRoot: w.dir, dir: w.attempts, platform: process.platform, env: process.env,
    toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: (g) => io.groupAlive(g), ...opts,
    spawnFn: (file, args, opts) => spawn(file, ['-e', script, args[2]], opts) });
  return run({ attempt_id: id, command: { cmd: process.execPath, args: ['-e', ''] }, timeoutMs: WORKER_FAILURE_BOUND_MS })
    .then(async (launch) => { launch.release(); return launch.done; });
}

/** Launcher stand-in: waits for the release byte, writes `frame(spec)` to fd 1, exits with `code`. */
const fakeLauncher = (frameExpr, code) => `const fs=require('fs');const spec=JSON.parse(process.argv[1]);process.stdin.once('data',()=>{
  const head=(o)=>Buffer.from(JSON.stringify(Object.assign({schema:'ship-ticket-sealed-result-v1',attempt_id:spec.attemptId,exit_code:0,signal:null,spawn_error:null,boundary:'exit',out_len:0,truncated:false,stdout_bytes:0,out_eof:true,report:false,report_len:0,report_truncated:false,report_bytes:0,report_eof:false},o))+'\\n');
  const all=${frameExpr};for(let o=0;o<all.length;){try{o+=fs.writeSync(1,all,o,all.length-o);}catch(e){if(e.code!=='EAGAIN')throw e;}}process.exit(${code});});`;

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

test('frame: a result pipe still open after the launcher exited (fd 1 handed to a detached process) is refused after frameCloseMs', { timeout: 60000 }, async (t) => {
  const w = world(t);
  // Stand-in launcher: hands its fd 1 to a detached holder, waits for the holder's ready byte, then frames a valid result and exits 0.
  const holder = 'require("fs").writeFileSync(process.argv[1],String(process.pid));require("fs").writeSync(3,"R");setTimeout(()=>{},15000);';
  const script = `const fs=require('fs'),cp=require('child_process');const spec=JSON.parse(process.argv[1]);process.stdin.once('data',()=>{
    const h=cp.spawn(process.execPath,['-e',${J(holder)},${J(join(w.dir, 'pipeholder.pid'))}],{detached:true,cwd:require('os').tmpdir(),stdio:['ignore','inherit','ignore','pipe']});
    h.stdio[3].once('data',()=>{h.stdio[3].destroy();h.unref();
      const head=Buffer.from(JSON.stringify({schema:'ship-ticket-sealed-result-v1',attempt_id:spec.attemptId,exit_code:0,signal:null,spawn_error:null,boundary:'exit',out_len:3,truncated:false,stdout_bytes:3,out_eof:true,report:false,report_len:0,report_truncated:false,report_bytes:0,report_eof:false})+'\\n');
      fs.writeSync(1,Buffer.concat([head,Buffer.from('ok\\n')]));process.exit(0);});});`;
  const t0 = Date.now();
  const res = await fakeLauncherRun(w, script, 'att-' + randomUUID(), { frameCloseMs: 300 }).then((r) => ({ resolved: r }), (e) => ({ code: e.code, message: e.message }));
  assert.ok(existsSync(join(w.dir, 'pipeholder.pid')), 'the pipe holder never started (the row would prove nothing)');
  assert.equal(res.code, 'runner_output_tampered', J(res));
  assert.match(res.message, /still open/);
  assert.ok(Date.now() - t0 < 10000, 'the bound did not apply');
});

/** A runner whose detached survivor writes PAYLOAD to fd `fd` once the runner exits (fixture `late-writer`). */
async function lateWriter(t, { fd, payload, genuine, code, fallback, report = false }) {
  const w = world(t);
  const args = ['late-writer', fd, payload, genuine, String(code), w.dir, String(fallback)];
  if (report) { writeFileSync(join(w.dir, 'report.json'), vitestReport(4096)); args.push(join(w.dir, 'report.json')); }
  const r = await drive(w, { args, report });
  assert.ok(existsSync(join(w.dir, 'late.pid')), 'the survivor never started (the row would prove nothing)');
  // The survivor fired after the runner exited (its stdin EOF is the barrier) and wrote its payload.
  assert.ok(await waitFor(() => existsSync(join(w.dir, 'late.json'))), 'the survivor never wrote (the row would prove nothing)');
  const late = JSON.parse(readFileSync(join(w.dir, 'late.json'), 'utf8'));
  t.diagnostic(`result: ${J(r).slice(0, 300)} survivor: ${J(late)}`);
  assert.equal(late.wrote, true, J(late));
  return { r, late };
}

/**
 * Each survivor below stays open through its channel's EOF check in the launcher's exit callback;
 * that is the only case the boundary refuses (see the boundary rows for what it accepts).
 * The survivor rows below are RED on the pre-latch launcher (a writer that closed inside its 1 s
 * drain was accepted: report `{"genuine":true}INJECTED` with report_eof true; stdout with the
 * injected TAP). The survivor only closes once a write fails (the launcher closed its end) or at
 * `fallback`: on the latched launcher `late.how` proves the channel was still held at the boundary,
 * so no exit race decides these rows.
 */
test('(a) report writer injects after the runner exits and stays open through the channel\'s EOF check (closes inside the old drain): runner_survivor', { skip: DARWIN ? false : 'report channel is darwin-only (see S2a)', timeout: 60000 }, async (t) => {
  const { r, late } = await lateWriter(t, { fd: '3', payload: '{"forged":true}', genuine: 'ok 1 - real\n', code: 0, fallback: 700, report: true });
  assert.equal(r.settled, 'rejected', J(r).slice(0, 300));
  assert.equal(r.code, 'runner_survivor', J(r));
  assert.match(r.message, /report channel/);
  assert.doesNotMatch(r.message, /stdout/, 'stdout was not held: only the report channel may be named');
  assert.doesNotMatch(J(r), /forged/);
  assert.match(late.how, /^closed:/, `the survivor closed by its fallback, not because the launcher had already latched: ${J(late)}`);
});

test('(b) stdout writer injects after the runner exits and stays open through stdout\'s EOF check (closes inside the old drain): runner_survivor', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const { r, late } = await lateWriter(t, { fd: '1', payload: 'INJECTED-AFTER-EXIT\n', genuine: 'ok 1 - real\n', code: 0, fallback: 700 });
  assert.equal(r.settled, 'rejected', J(r).slice(0, 300));
  assert.equal(r.code, 'runner_survivor', J(r));
  assert.match(r.message, /stdout/);
  assert.doesNotMatch(J(r), /INJECTED/);
  assert.match(late.how, /^closed:/, J(late));
});

test('(c) Codex: a silent failing runner whose survivor writes a TAP failure after it exits and stays open through stdout\'s EOF check: runner_survivor', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const tap = 'not ok 1 - target\n  ---\n  code: ERR_ASSERTION\n  ...\n';
  const { r, late } = await lateWriter(t, { fd: '1', payload: tap, genuine: '', code: 1, fallback: 700 });
  assert.equal(r.settled, 'rejected', J(r).slice(0, 300));
  assert.equal(r.code, 'runner_survivor', J(r));
  assert.doesNotMatch(J(r), /ERR_ASSERTION|not ok/);
  assert.match(late.how, /^closed:/, J(late));
});

test('(d) stdout held through its EOF check by a detached process that closes only when the launcher is gone: runner_survivor', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const { r, late } = await lateWriter(t, { fd: '1', payload: 'HELD\n', genuine: 'ok 1 - real\n', code: 0, fallback: 0 });
  assert.equal(r.settled, 'rejected', J(r).slice(0, 300));
  assert.equal(r.code, 'runner_survivor', J(r));
  assert.doesNotMatch(J(r), /HELD/);
  assert.match(late.how, /^closed:/, J(late));
});

test('positive: a non-detached child that writes to the inherited stdout and exits before the runner is not a survivor', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  const r = await drive(w, { args: ['child-then-exit'] });
  assert.equal(r.settled, 'resolved', J(r));
  assert.deepEqual([r.exitCode, r.stdout], [0, 'child line\nok 1 - parent\n']);
});

test('forensic writes: a regular file or a symlink planted at the tmp names is never written into or through', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  writeFileSync(join(w.dir, 'victim.txt'), 'VICTIM');
  const r = await drive(w, { args: ['tmp-plant', w.dir] });
  assert.ok(lstatSync(join(w.attempts, r.id + '.envelope.json.tmp')).isSymbolicLink(), 'the plant never happened (the row would prove nothing)');
  assert.equal(r.settled, 'resolved', J(r));
  assert.deepEqual([r.exitCode, r.stdout], [1, GENUINE_FAIL]);
  // O_EXCL: the existing tmp file is skipped, not opened and renamed over `.out`.
  assert.equal(readFileSync(join(w.attempts, r.id + '.out.tmp'), 'utf8'), 'PLANTED-OUT');
  assert.equal(existsSync(join(w.attempts, r.id + '.out')), false);
  // O_EXCL (O_NOFOLLOW alone would also refuse it): nothing is written through the symlink.
  assert.equal(readFileSync(join(w.dir, 'victim.txt'), 'utf8'), 'VICTIM');
});

test('frame: a malformed header (wrong schema, field types, an unknown or non-exit boundary) is refused (runner_output_tampered)', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const bad = {
    schema: `{schema:'ship-ticket-sealed-result-v0'}`,
    signal: `{signal:5}`,
    exit_code: `{exit_code:1.5}`,
    flag: `{out_eof:'yes'}`,
    length: `{stdout_bytes:-1}`,
    boundary_unknown: `{boundary:'later'}`,
    ...(POSIX ? { boundary_drain: `{boundary:'drain'}`, boundary_none: `{boundary:null}` } : {}),
  };
  for (const [name, o] of Object.entries(bad)) {
    const script = fakeLauncher(`Buffer.concat([head(Object.assign({out_len:3},${o})),Buffer.from('ok\\n')])`, 0);
    const res = await fakeLauncherRun(w, script, 'att-' + randomUUID()).then((r) => ({ resolved: r }), (e) => ({ code: e.code, message: e.message }));
    assert.equal(res.code, 'runner_output_tampered', `${name}: ${J(res)}`);
  }
});

test('frame: a frame larger than the cap is refused for its size (runner_output_tampered)', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const n = 65 * 1024 * 1024 + 1; // FRAME_CAP (2 x 32 MiB + 1 MiB) is exceeded by the payload alone
  const script = fakeLauncher(`Buffer.concat([head({out_len:${n},stdout_bytes:${n}}),Buffer.alloc(${n},120)])`, 0);
  const res = await fakeLauncherRun(w, script, 'att-' + randomUUID()).then((r) => ({ resolved: r.stdout.length }), (e) => ({ code: e.code, message: e.message }));
  assert.equal(res.code, 'runner_output_tampered', J(res));
  assert.match(res.message, /exceeds/);
});

test('report must be a boolean: 1, "true" or null is refused (bad_input) before anything starts', async (t) => {
  const w = world(t);
  const spawned = [];
  const run = io.gateRunner({ repoRoot: w.dir, dir: w.attempts, platform: process.platform, env: process.env,
    toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: () => false, spawnFn: (...a) => { spawned.push(a); throw new Error('spawned'); } });
  for (const report of [1, 'true', null]) {
    await assert.rejects(run({ attempt_id: 'att-x', command: { cmd: process.execPath, args: [] }, timeoutMs: WORKER_FAILURE_BOUND_MS, report }), (e) => e.code === 'bad_input');
  }
  assert.equal(spawned.length, 0);
  assert.equal(existsSync(w.attempts), false);
});

// ------------------------------------------------------------------ callers keep the typed code (no flattening, no retry)

/** A check/proof command that exits at once and leaves a (non-detached) child holding its stdout: a survivor. */
const SURVIVOR_CMD = { cmd: process.execPath, args: ['-e', "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore','inherit','ignore']}).unref()"] };
const ENGINE_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so engine attempts end in quiescence_unknown first';

test('gateRed through the real runner: a survivor-forged TAP failure is refused as runner_survivor (a judgment point), never runner_failed or RED', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  const deps = io.gateRedDeps({ commit: async () => {}, alive: (g) => io.groupAlive(g), platform: process.platform, repoRoot: w.dir,
    verifyBinding: async () => [], dir: w.attempts, env: process.env, toSpec: (c, a) => ({ file: c, args: a, shell: false }) });
  const state = { run_id: 'run-1', seq: 2, nodes: { 'red-gate': { deps: [], phase: 'BUILD', role: 'builder' } },
    events: [{ seq: 1, type: 'DISPATCH', node: 'red-gate' }, { seq: 2, type: 'COMPLETE', node: 'red-gate' }], attempts: [], locks: {}, gates: { red: {} } };
  const tap = 'not ok 1 - target\n  ---\n  code: ERR_ASSERTION\n  ...\n1..1\n';
  const r = await gateRed({ state, node: 'red-gate', command: { cmd: process.execPath, args: [w.fixture, 'late-writer', '1', tap, '', '1', w.dir, '700'] },
    format: 'tap', specs: [{ file: 'a.test.mjs', name: 'target' }], baselineCandidate: 'sha256:base', timeoutMs: WORKER_FAILURE_BOUND_MS, resources: [] }, deps);
  assert.ok(await waitFor(() => existsSync(join(w.dir, 'late.json'))), 'the survivor never wrote (the row would prove nothing)');
  assert.equal(r.ok, false, J(r).slice(0, 300));
  assert.equal(r.code, 'runner_survivor', J(r.reasons));
  assert.equal(r.judgment_point, true);
  assert.deepEqual(state.gates.red, {}, 'no RED evidence recorded');
});

test('unit check: a typed runner refusal is a recorded fail keeping its code, never retried (no UNIT_CHECK_RETRY)', { skip: ENGINE_SKIP, timeout: 120000 }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { surv: SURVIVOR_CMD } }, nodes: [{ id: 'a', writes: ['src/a.txt'], unit: 'api', checks: ['surv'] }] });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const s = fx.readState();
  const runs = s.attempts.filter(a => a.kind === 'unit-check' && a.node === 'api');
  assert.equal(runs.length, 1, 'a typed refusal is not retried');
  assert.equal(s.events.filter(e => e.type === 'UNIT_CHECK_RETRY').length, 0);
  assert.ok(runs.every(a => a.status === 'exited' && a.quiesced === true), J(runs));
  const ev = s.unit_checks.api.evidence;
  assert.equal(ev.state, 'failed');
  assert.deepEqual(ev.results.map(x => [x.name, x.result, x.error_code]), [['surv', 'fail', 'runner_survivor']]);
  assert.ok(r.out.judgments.some(j => j.code === 'unit_check_failed' && j.node === 'api' && /runner_survivor/.test(j.reason)), J(r.out.judgments));
});

test('proof: a typed runner refusal is recorded on the LOCAL_PROOF command with its code (a fail)', { skip: ENGINE_SKIP, timeout: 120000 }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { surv: SURVIVOR_CMD } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).status, 0);
  const r = fx.gate('ship-ready', {});
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const cmd = fx.readState().local_proof?.commands?.find(c => c.name === 'surv');
  assert.ok(cmd, J(fx.readState().local_proof));
  assert.deepEqual([cmd.result, cmd.exit_code, cmd.error_code], ['fail', null, 'runner_survivor']);
});

// ------------------------------------------------------------------ the boundary's limits (launcher testHooks)

/** Run the sealed launcher directly with `testHooks` (the engine never sets them) and decode its frame. */
function sealedWithHooks(w, args, testHooks) {
  const id = 'att-' + randomUUID();
  const spec = { file: process.execPath, args: [w.fixture, ...args], shell: false, sealed: true, testHooks, sample: false,
    outFile: join(w.dir, id + '.out'), envelopeFile: join(w.dir, id + '.envelope.json'), attemptId: id };
  const child = spawn(process.execPath, launcherArgs(spec), { cwd: w.dir, detached: POSIX, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const chunks = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stdin.end(io.RELEASE);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { process.kill(POSIX ? -child.pid : child.pid, 'SIGKILL'); } catch { /* gone */ } resolve({ hung: true }); }, 30000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, ...io.decodeSealedFrame(Buffer.concat(chunks), id) }); });
  });
}

test('boundary: output still unread when exit fires is collected by the exit callback\'s synchronous read, not refused', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  // stopReads: the launcher never reads stdout before its exit callback (exit-before-drain, deterministic).
  const f = await sealedWithHooks(w, ['plain', 'ok 1 - unread at exit\n', '0'], { stopReads: true });
  assert.notEqual(f.hung, true);
  assert.equal(f.reason, undefined, J(f));
  assert.deepEqual([f.head.boundary, f.head.out_eof, f.head.exit_code, f.stdout.toString()], ['exit', true, 0, 'ok 1 - unread at exit\n']);
});

test('boundary: more than 64 KiB unread at exit (Linux) is collected whole by the one exit read, not refused', { skip: process.platform === 'linux' ? false : 'only Linux socket buffers hold over 64 KiB for a dead runner (darwin: the runner would block)', timeout: 60000 }, async (t) => {
  const w = world(t);
  const text = 'y'.repeat(100000) + '\n';
  const f = await sealedWithHooks(w, ['plain', text, '0'], { stopReads: true });
  assert.notEqual(f.hung, true);
  assert.equal(f.reason, undefined, J(f));
  assert.deepEqual([f.head.out_eof, f.stdout.length], [true, text.length]);
});

test('boundary (Codex, PR #94): a survivor that writes and closes DURING the exit callback\'s reads is refused; its bytes are not kept', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  const pauseFile = join(w.dir, 'paused'), resumeFile = join(w.dir, 'resume');
  // The launcher pauses right after its first (short) read of stdout; the survivor then writes, closes and lets it resume.
  const f = await sealedWithHooks(w, ['drain-writer', pauseFile, resumeFile, w.dir], { stopReads: true, pauseFile, resumeFile });
  assert.ok(existsSync(join(w.dir, 'late.pid')) && existsSync(pauseFile) && existsSync(resumeFile), 'the survivor never wrote during the pause (the row would prove nothing)');
  assert.equal(f.reason, undefined, J(f));
  // The one exit read emptied the queue and latched stdout: a byte after it means a writer, so not at EOF.
  assert.deepEqual([f.head.boundary, f.head.out_eof, f.stdout.toString()], ['exit', false, 'BEFORE_DRAIN\n']);
  const doc = readFileSync(fileURLToPath(new URL('./engine-io.mjs', import.meta.url)), 'utf8');
  assert.match(doc, /ONE\s+\*?\s*read of up to STDOUT_CAP \+ 1 bytes/, 'gateRunner\'s JSDoc must state the latch point (one read larger than any queue)');
});

test('boundary (Opus, PR #94): with more than 64 KiB unread at exit, a survivor writing after the first read is still refused (one read empties the queue)', { skip: process.platform === 'linux' ? false : 'only Linux socket buffers hold over 64 KiB for a dead runner (darwin: the runner would block)', timeout: 60000 }, async (t) => {
  const w = world(t);
  const pauseFile = join(w.dir, 'paused'), resumeFile = join(w.dir, 'resume');
  const f = await sealedWithHooks(w, ['drain-writer', pauseFile, resumeFile, w.dir, '100000'], { stopReads: true, pauseFile, resumeFile });
  assert.ok(existsSync(pauseFile) && existsSync(resumeFile), 'the survivor never wrote during the pause (the row would prove nothing)');
  assert.equal(f.reason, undefined, J(f));
  assert.deepEqual([f.head.out_eof, f.stdout.length, /AFTER_FIRST_READ/.test(f.stdout.toString())], [false, 100000 + 'BEFORE_DRAIN\n'.length, false]);
});

test('boundary: a stdout with no descriptor left at the exit fails closed (not at EOF)', { skip: POSIX_SKIP, timeout: 60000 }, async (t) => {
  const w = world(t);
  const f = await sealedWithHooks(w, ['plain', '', '0'], { destroyStdout: true });
  assert.notEqual(f.hung, true);
  assert.equal(f.reason, undefined, J(f));
  assert.deepEqual([f.head.boundary, f.head.out_eof], ['exit', false]);
});
