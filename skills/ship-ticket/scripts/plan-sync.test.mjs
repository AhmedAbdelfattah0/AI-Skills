import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDigest } from './brief.mjs';
import { planNarrativeDigest } from './engine-dag.mjs';

const CLI = fileURLToPath(new URL('./plan-sync.mjs', import.meta.url));
const BRIEF = fileURLToPath(new URL('./brief.mjs', import.meta.url));
const B = '<!-- RUN-STATE:BEGIN -->', E = '<!-- RUN-STATE:END -->';
const plan = (narr = '# Plan\n\nStep one.\n', body = '{"event":"START"}\n') => `${narr}\n${B}\n${body}${E}\n`;

const dir = mkdtempSync(join(tmpdir(), 'plan-sync-'));
const spyDir = mkdtempSync(join(tmpdir(), 'plan-sync-spy-'));
test.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(spyDir, { recursive: true, force: true }); });
const put = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  let json = null;
  const lines = r.stdout.split('\n').filter(Boolean);
  if (lines.length) json = JSON.parse(lines[0]);
  return { status: r.status, json, lines, stdout: r.stdout, stderr: r.stderr };
};
const check = (n, a) => run(['--check', '--native', n, '--artifact', a]);

test('in_sync: identical plans, exit 0, one JSON line with both digests', () => {
  const a = put('a1.md', plan()), b = put('b1.md', plan());
  const r = check(a, b);
  assert.equal(r.status, 0);
  assert.equal(r.lines.length, 1);
  assert.equal(r.json.status, 'in_sync');
  assert.match(r.json.native_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.json.native_digest, r.json.artifact_digest);
  assert.equal(r.json.reason, undefined);
});

test('out_of_sync: a one-byte narrative edit, exit 1', () => {
  const r = check(put('a2.md', plan('# Plan\n\nStep one.\n')), put('b2.md', plan('# Plan\n\nStep onf.\n')));
  assert.equal(r.status, 1);
  assert.equal(r.json.status, 'out_of_sync');
  assert.notEqual(r.json.native_digest, r.json.artifact_digest);
});

test('RUN-STATE body differences do not change the digest', () => {
  const r = check(put('a3.md', plan(undefined, '{"event":"START","x":1}\nattestation line\n')), put('b3.md', plan(undefined, '')));
  assert.equal(r.status, 0);
  assert.equal(r.json.status, 'in_sync');
});

test('CRLF and LF twins differ (no normalisation), documented', () => {
  const lf = plan(), crlf = lf.replace(/\n/g, '\r\n');
  const r = check(put('a4.md', lf), put('b4.md', crlf));
  assert.equal(r.status, 1);
  assert.equal(r.json.status, 'out_of_sync');
  assert.equal(r.json.native_digest, planDigest(lf));
  assert.equal(r.json.artifact_digest, planDigest(crlf));
});

test('a BOM is not normalised either', () => {
  const r = check(put('a5.md', plan()), put('b5.md', `﻿${plan()}`));
  assert.equal(r.status, 1);
});

test('invalid plans are refused with exit 3 and reason plan_invalid, naming the file', () => {
  const ok = put('ok.md', plan());
  for (const [name, text] of [['missing.md', '# no block\n'], ['reversed.md', `${E}\n${B}\n`], ['empty.md', '']]) {
    const bad = put(name, text);
    const r1 = check(bad, ok), r2 = check(ok, bad);
    assert.equal(r1.status, 3, name);
    assert.deepEqual([r1.json.status, r1.json.reason, r1.json.which], ['refused', 'plan_invalid', 'native']);
    assert.equal(r2.status, 3, name);
    assert.deepEqual([r2.json.reason, r2.json.which], ['plan_invalid', 'artifact']);
    assert.equal(r1.json.native_digest, null);
  }
});

test('symlink, FIFO, directory, missing and oversize are refused (exit 3)', () => {
  const ok = put('ok2.md', plan());
  const link = join(dir, 'link.md'); symlinkSync(ok, link);
  assert.equal(check(link, ok).json.reason, 'symlink');
  assert.equal(check(ok, link).status, 3);
  const fifo = join(dir, 'fifo.md');
  execFileSync('mkfifo', [fifo]);
  const rf = check(fifo, ok); // must not hang on a FIFO
  assert.deepEqual([rf.status, rf.json.reason], [3, 'not_regular']);
  assert.equal(check(dir, ok).json.reason, 'not_regular');
  assert.equal(check(join(dir, 'nope.md'), ok).json.reason, 'unreadable');
  const big = put('big.md', plan(`${'x'.repeat(1024 * 1024)}\n`));
  assert.deepEqual([check(big, ok).status, check(big, ok).json.reason], [3, 'oversize']);
  const edge = put('edge.md', 'y'.repeat(1024 * 1024 - plan('').length) + plan(''));
  assert.equal(statSync(edge).size, 1024 * 1024);
  assert.equal(check(edge, edge).status, 0, 'exactly the cap is accepted');
});

test('usage errors exit 2 and print no JSON', () => {
  const f = put('u.md', plan());
  for (const args of [[], ['--check'], ['--native', f, '--artifact', f], ['--check', '--native', f], ['--check', '--artifact', f],
    ['--check', '--native', f, '--artifact', f, 'extra'], ['--check', '--native', f, '--native', f, '--artifact', f],
    ['--check', '--check', '--native', f, '--artifact', f], ['--check', '--native'], ['--check', '--approved', 'x', '--native', f, '--artifact', f]]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage:/);
  }
});

test('hostile paths: a file named -x, spaces, unicode', () => {
  const sub = join(dir, 'h'); execFileSync('mkdir', [sub]);
  const names = ['-x', 'with space.md', 'ünï-コード.md', '--check'];
  for (const n of names) writeFileSync(join(sub, n), plan());
  for (const n of names) {
    const r = spawnSync(process.execPath, [CLI, '--check', '--native', n, '--artifact', n], { cwd: sub, encoding: 'utf8' });
    assert.equal(r.status, 0, n);
    assert.equal(JSON.parse(r.stdout).status, 'in_sync');
  }
});

test('parity with brief.mjs plan-digest and the engine planNarrativeDigest on the same inputs', () => {
  for (const [i, text] of [plan(), plan().replace(/\n/g, '\r\n'), plan('# Ünï\n\n| a | b |\n'), plan(undefined, '')].entries()) {
    const p = put(`par${i}.md`, text);
    const cli = execFileSync(process.execPath, [BRIEF, 'plan-digest', '--plan', p], { encoding: 'utf8' }).trim();
    const r = check(p, p);
    assert.equal(r.json.native_digest, cli);
    assert.equal(r.json.native_digest, `sha256:${planNarrativeDigest(text).replace(/^sha256:/, '')}`);
  }
});

// The spy preload patches every write-class fs and child_process function in the CHILD before the script loads and reports to fd 2.
const SPY = `
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const fs = req('node:fs'), cp = req('node:child_process'), net = req('node:net');
const log = (n) => fs.writeSync(2, 'SPY:' + n + '\\n');
const W = ['writeFileSync','writeFile','appendFileSync','appendFile','mkdirSync','mkdir','rmSync','rm','unlinkSync','unlink','renameSync','rename','copyFileSync','copyFile','truncateSync','truncate','ftruncateSync','utimesSync','futimesSync','chmodSync','chownSync','symlinkSync','linkSync','mkdtempSync','createWriteStream','rmdirSync','cpSync','writev','writevSync'];
for (const n of W) { const o = fs[n]; if (typeof o === 'function') fs[n] = function (...a) { log(n); return o.apply(this, a); }; }
for (const n of ['writeFile','appendFile','mkdir','rm','unlink','rename','copyFile','truncate','writeFile','cp']) { const o = fs.promises[n]; if (o) fs.promises[n] = function (...a) { log('promises.' + n); return o.apply(this, a); }; }
const ws = fs.writeSync; fs.writeSync = function (fd, ...a) { if (fd > 2) log('writeSync'); return ws.call(this, fd, ...a); };
const os = fs.openSync;
fs.openSync = function (p, flags, ...a) { if (typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))) log('openSync-write'); if (typeof flags === 'string' && /[wa+]/.test(flags)) log('openSync-write'); return os.call(this, p, flags, ...a); };
for (const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) { const o = cp[n]; cp[n] = function (...a) { log('child_process.' + n); return o.apply(this, a); }; }
const nc = net.connect; net.connect = function (...a) { log('net.connect'); return nc.apply(this, a); };
`;
const spyRun = (args) => {
  const hook = join(spyDir, 'spy.mjs'); writeFileSync(hook, SPY);
  const r = spawnSync(process.execPath, ['--import', hook, ...args], { encoding: 'utf8' });
  return { status: r.status, calls: r.stderr.split('\n').filter((l) => l.startsWith('SPY:')) };
};
const snapshot = () => readdirSync(dir).sort().map((n) => { try { const s = statSync(join(dir, n)); return [n, s.size, s.mtimeMs]; } catch { return [n]; } });

test('fs-spy control: the spy detects a write-class call (otherwise a zero would prove nothing)', () => {
  const probe = put('probe.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'probe.out'))}, 'x');`);
  const r = spyRun([probe]);
  assert.ok(r.calls.includes('SPY:writeFileSync'), r.calls.join());
  const w = spyRun(['-e', `require('node:fs').openSync(${JSON.stringify(join(dir, 'probe.out2'))}, 'w')`]);
  assert.ok(w.calls.includes('SPY:openSync-write'));
});

test('fs-spy: zero write-class, process or network calls on in_sync, out_of_sync and refused; files untouched', () => {
  const a = put('s1.md', plan()), b = put('s2.md', plan('# Other\n')), bad = put('s3.md', 'nothing');
  const past = new Date('2020-01-01T00:00:00Z'); for (const f of [a, b, bad]) utimesSync(f, past, past);
  const before = snapshot(), bytes = [a, b, bad].map((f) => readFileSync(f, 'utf8'));
  for (const [n, art, code] of [[a, a, 0], [a, b, 1], [bad, a, 3], [join(dir, 'gone.md'), a, 3]]) {
    const r = spyRun([CLI, '--check', '--native', n, '--artifact', art]);
    assert.equal(r.status, code);
    assert.deepEqual(r.calls, []);
  }
  const u = spyRun([CLI, '--check']);
  assert.equal(u.status, 2);
  assert.deepEqual(u.calls, []);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([a, b, bad].map((f) => readFileSync(f, 'utf8')), bytes);
});

test('static: plan-sync.mjs imports only fs, brief.mjs and harness.mjs; no authority module, no child_process, no network', () => {
  const src = readFileSync(CLI, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  const specs = [...code.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specs, ['./brief.mjs', './harness.mjs', 'node:fs']);
  assert.doesNotMatch(code, /\b(?:require|import)\s*\(/);
  for (const bad of ['child_process', 'execFile', 'spawn', 'node:net', 'node:http', 'fetch(', 'writeFile', 'appendFile', 'mkdir', 'unlink', 'rename', 'createWriteStream',
    'run-state', 'engine-authority', 'carrier', 'AUTHORITY_EVENTS', 'START', 'REVISION', 'approved_plan_digest']) assert.ok(!code.includes(bad), `forbidden token ${bad}`);
  assert.match(code, /O_NOFOLLOW/);
  assert.match(code, /O_NONBLOCK/);
});
