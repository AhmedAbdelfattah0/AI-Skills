import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const check = (n, a, extra = []) => run(['check', '--native', n, '--plan', a, ...extra]);
const sha = (t) => `sha256:${createHash('sha256').update(t).digest('hex')}`;

test('marked native: identical plans are in sync, exit 0, one JSON line', () => {
  const t = plan(), a = put('a1.md', t), b = put('b1.md', t);
  const r = check(a, b);
  assert.equal(r.status, 0);
  assert.equal(r.lines.length, 1);
  assert.equal(r.json.in_sync, true);
  assert.equal(r.json.native_sha256, sha(t));
  assert.equal(r.json.narrative_digest, planDigest(t));
  assert.equal(r.json.code, undefined);
  assert.equal(r.json.approved_match, undefined, 'approved_match only with --approved');
});

test('marked native: a one-byte narrative edit is stale (exit 1, plan_sync_stale) and names the first differing line', () => {
  const r = check(put('a2.md', plan('# Plan\n\nStep one.\n')), put('b2.md', plan('# Plan\n\nStep onf.\n')));
  assert.equal(r.status, 1);
  assert.equal(r.json.in_sync, false);
  assert.equal(r.json.code, 'plan_sync_stale');
  assert.deepEqual(r.json.first_difference, { line: 3, native: 'Step one.', artifact: 'Step onf.' });
});

test('marked native: RUN-STATE body differences do not change the digest', () => {
  const r = check(put('a3.md', plan(undefined, '{"event":"START","x":1}\nattestation line\n')), put('b3.md', plan(undefined, '')));
  assert.equal(r.status, 0);
  assert.equal(r.json.in_sync, true);
});

test('marked native: CRLF twin and BOM twin are stale (no normalisation)', () => {
  const lf = plan(), crlf = lf.replace(/\n/g, '\r\n');
  const r = check(put('a4.md', lf), put('b4.md', crlf));
  assert.equal(r.status, 1);
  assert.equal(r.json.narrative_digest, planDigest(crlf));
  assert.equal(check(put('a5.md', lf), put('b5.md', `﻿${lf}`)).status, 1);
});

test('marker-less native: equals artifact before BEGIN (minus one trailing LF) plus after END', () => {
  const narr = '# Plan\n\nStep one.\n';
  const art = `${narr}\n${B}\n{"event":"START"}\n${E}\n`;
  // before BEGIN = narr + "\n"; minus exactly one trailing LF = narr; after END = "\n"
  const native = `${narr}\n`;
  const r = check(put('n1.md', native), put('p1.md', art));
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.native_sha256, sha(native));
  assert.equal(r.json.narrative_digest, planDigest(art));
  // empty after END
  const art2 = `${narr}\n${B}\nx\n${E}`;
  assert.equal(check(put('n2.md', narr), put('p2.md', art2)).status, 0);
  // exactly ONE trailing LF is removed: a native with the extra LF is stale
  const r3 = check(put('n3.md', `${narr}\n\n`), put('p3.md', art));
  assert.equal(r3.status, 1);
  assert.equal(r3.json.code, 'plan_sync_stale');
  // a native missing the after-END LF is stale too
  assert.equal(check(put('n4.md', narr), put('p4.md', art)).status, 1);
});

test('marker-less native: CRLF and BOM natives are stale, not normalised', () => {
  const narr = '# Plan\n\nStep one.\n';
  const art = `${narr}\n${B}\nx\n${E}\n`;
  const ok = `${narr}\n`;
  assert.equal(check(put('c0.md', ok), put('cp.md', art)).status, 0);
  const crlf = check(put('c1.md', ok.replace(/\n/g, '\r\n')), put('cp.md', art));
  assert.equal(crlf.status, 1);
  assert.equal(crlf.json.first_difference.line, 1);
  assert.equal(check(put('c2.md', `﻿${ok}`), put('cp.md', art)).status, 1);
});

test('SCRUM-209 shape: an extra header line in the artifact outside the RUN-STATE block is stale and names the line', () => {
  const narr = '# SCRUM-209\n\nScope text.\n';
  const native = `${narr}\n`;
  const art = `---\napproval_status: approved\n---\n${narr}\n${B}\n{"event":"START"}\n${E}\n`;
  const r = check(put('s209n.md', native), put('s209a.md', art));
  assert.equal(r.status, 1);
  assert.equal(r.json.code, 'plan_sync_stale');
  assert.deepEqual(r.json.first_difference, { line: 1, native: '# SCRUM-209', artifact: '---' });
  // same shape with a marked native
  const rm = check(put('s209m.md', plan(narr)), put('s209a2.md', `approval_status: approved\n${plan(narr)}`));
  assert.equal(rm.status, 1);
  assert.deepEqual(rm.json.first_difference, { line: 1, native: '# SCRUM-209', artifact: 'approval_status: approved' });
});

test('first differing line is bounded to 200 characters per side and trimmed', () => {
  const long = 'x'.repeat(5000);
  const r = check(put('l1.md', plan(`  ${long}  \n`)), put('l2.md', plan(`${long}y\n`)));
  assert.equal(r.status, 1);
  assert.ok(r.json.first_difference.native.length <= 203);
  assert.ok(r.json.first_difference.artifact.length <= 203);
  assert.ok(r.stdout.length < 1500);
  // a side with no such line is null
  const r2 = check(put('l3.md', plan('A\n')), put('l4.md', plan('A\nB\n')));
  assert.equal(r2.json.first_difference.native, '');
  assert.equal(r2.json.first_difference.artifact, 'B');
});

test('--approved: match, mismatch and malformed', () => {
  const t = plan(), a = put('ap1.md', t), b = put('ap2.md', t);
  const d = planDigest(t);
  const m = check(a, b, ['--approved', d]);
  assert.equal(m.status, 0);
  assert.equal(m.json.approved_match, true);
  const other = check(a, b, ['--approved', `sha256:${'0'.repeat(64)}`]);
  assert.equal(other.status, 0, 'in sync with the artifact; the approval simply does not match');
  assert.equal(other.json.approved_match, false);
  for (const bad of ['abc', d.toUpperCase(), d.slice(0, -1), `sha256:${'g'.repeat(64)}`, d.replace('sha256:', '')]) {
    const r = check(a, b, ['--approved', bad]);
    assert.equal(r.status, 2, bad);
    assert.equal(r.json.code, 'approved_malformed');
  }
  // stale + approved
  const s = check(put('ap3.md', plan('# X\n')), b, ['--approved', planDigest(plan('# X\n'))]);
  assert.equal(s.status, 1);
  assert.equal(s.json.approved_match, true, 'the approval names the native plan, which the artifact no longer matches');
  // marker-less native: approved matches only when in sync
  const art = `# P\n\n${B}\nx\n${E}\n`;
  const ml = check(put('ap4.md', '# P\n\n'), put('ap5.md', art), ['--approved', planDigest(art)]);
  assert.equal(ml.status, 0);
  assert.equal(ml.json.approved_match, true);
});

test('invalid plans exit 2 with code plan_invalid, naming the file', () => {
  const ok = put('ok.md', plan());
  const two = put('two.md', plan() + plan());
  for (const [name, text] of [['missing.md', '# no block\n'], ['reversed.md', `${E}\n${B}\n`], ['empty.md', ''], ['noend.md', `x\n${B}\n`]]) {
    const bad = put(name, text);
    const art = check(ok, bad);
    assert.equal(art.status, 2, name);
    assert.deepEqual([art.json.code, art.json.which], ['plan_invalid', 'artifact']);
  }
  assert.equal(check(ok, two).status, 2, 'two blocks in the artifact');
  assert.equal(check(two, ok).status, 2, 'two blocks in a marked native');
  assert.equal(check(put('rev2.md', `${E}\n${B}\n`), ok).json.which, 'native');
});

test('a wave file exits 3 plan_sync_unsupported, never parsed; distinct from 1 and 2', () => {
  const wave = '# Wave 1\n\n## Ticket A\n\nPlan A.\n\n## Ticket B\n\nPlan B.\n';
  const ok = put('ok3.md', plan());
  const wn = check(put('w1.md', wave), ok), wa = check(ok, put('w2.md', plan(wave)));
  for (const r of [wn, wa]) {
    assert.equal(r.status, 3);
    assert.equal(r.json.code, 'plan_sync_unsupported');
    assert.equal(r.json.in_sync, false);
  }
  assert.equal(wn.json.which, 'native');
  assert.equal(wa.json.which, 'artifact');
  assert.equal(check(put('w3.md', '## wave: tickets\n'), ok).status, 3);
  assert.equal(check(put('nw.md', plan('A wave of the hand.\n# Waveform notes\n')), put('nw2.md', plan('A wave of the hand.\n# Waveform notes\n'))).status, 0, 'only a Wave heading counts');
  assert.deepEqual([check(ok, put('s1.md', plan('# other\n'))).status, check(ok, put('bad.md', 'x')).status, wn.status], [1, 2, 3]);
});

test('symlink, FIFO, directory, missing and oversize are refused (exit 2)', () => {
  const ok = put('ok2.md', plan());
  const link = join(dir, 'link.md'); symlinkSync(ok, link);
  assert.equal(check(link, ok).json.code, 'symlink');
  assert.equal(check(ok, link).status, 2);
  const fifo = join(dir, 'fifo.md');
  execFileSync('mkfifo', [fifo]);
  const rf = check(fifo, ok); // must not hang on a FIFO
  assert.deepEqual([rf.status, rf.json.code], [2, 'not_regular']);
  assert.equal(check(dir, ok).json.code, 'not_regular');
  assert.equal(check(join(dir, 'nope.md'), ok).json.code, 'unreadable');
  const big = put('big.md', plan(`${'x'.repeat(1024 * 1024)}\n`));
  assert.deepEqual([check(big, ok).status, check(big, ok).json.code], [2, 'oversize']);
  const edge = put('edge.md', 'y'.repeat(1024 * 1024 - plan('').length) + plan(''));
  assert.equal(statSync(edge).size, 1024 * 1024);
  assert.equal(check(edge, edge).status, 0, 'exactly the cap is accepted');
});

test('usage errors exit 2 and print no JSON', () => {
  const f = put('u.md', plan());
  for (const args of [[], ['check'], ['--check', '--native', f, '--artifact', f], ['check', '--native', f], ['check', '--plan', f],
    ['check', '--native', f, '--plan', f, 'extra'], ['check', '--native', f, '--native', f, '--plan', f], ['check', '--native', f, '--artifact', f],
    ['check', '--native', f, '--plan', f, '--approved'], ['check', '--native', f, '--plan', f, '--approved', 'a', '--approved', 'b'],
    ['--native', f, '--plan', f, 'check'], ['verify', '--native', f, '--plan', f]]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage:/);
  }
});

test('hostile paths: a file named -x, spaces, unicode, --plan', () => {
  const sub = join(dir, 'h'); execFileSync('mkdir', [sub]);
  const names = ['-x', 'with space.md', 'ünï-コード.md', '--plan'];
  for (const n of names) writeFileSync(join(sub, n), plan());
  for (const n of names) {
    const r = spawnSync(process.execPath, [CLI, 'check', '--native', n, '--plan', n], { cwd: sub, encoding: 'utf8' });
    assert.equal(r.status, 0, n);
    assert.equal(JSON.parse(r.stdout).in_sync, true);
  }
});

test('parity with brief.mjs plan-digest and the engine planNarrativeDigest on the same inputs', () => {
  for (const [i, text] of [plan(), plan().replace(/\n/g, '\r\n'), plan('# Ünï\n\n| a | b |\n'), plan(undefined, '')].entries()) {
    const p = put(`par${i}.md`, text);
    const cli = execFileSync(process.execPath, [BRIEF, 'plan-digest', '--plan', p], { encoding: 'utf8' }).trim();
    const r = check(p, p);
    assert.equal(r.json.narrative_digest, cli);
    assert.equal(r.json.narrative_digest, `sha256:${planNarrativeDigest(text).replace(/^sha256:/, '')}`);
    assert.equal(check(p, p, ['--approved', cli]).json.approved_match, true);
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
  for (const [n, art, code] of [[a, a, 0], [a, b, 1], [a, bad, 2], [join(dir, 'gone.md'), a, 2]]) {
    const r = spyRun([CLI, 'check', '--native', n, '--plan', art]);
    assert.equal(r.status, code);
    assert.deepEqual(r.calls, []);
  }
  const u = spyRun([CLI, 'check']);
  assert.equal(u.status, 2);
  assert.deepEqual(u.calls, []);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([a, b, bad].map((f) => readFileSync(f, 'utf8')), bytes);
});

test('static: plan-sync.mjs imports only fs, crypto, brief.mjs and harness.mjs; no authority module, no child_process, no network', () => {
  const src = readFileSync(CLI, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  const specs = [...code.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specs, ['./brief.mjs', './harness.mjs', 'node:crypto', 'node:fs']);
  assert.doesNotMatch(code, /\b(?:require|import)\s*\(/);
  for (const bad of ['child_process', 'execFile', 'spawn', 'node:net', 'node:http', 'fetch(', 'writeFile', 'appendFile', 'mkdir', 'unlink', 'rename', 'createWriteStream',
    'run-state', 'engine-authority', 'carrier', 'AUTHORITY_EVENTS', 'START', 'REVISION', 'approved_plan_digest']) assert.ok(!code.includes(bad), `forbidden token ${bad}`);
  assert.match(code, /O_NOFOLLOW/);
  assert.match(code, /O_NONBLOCK/);
});
