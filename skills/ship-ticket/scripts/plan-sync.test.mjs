import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fsx from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDigest } from './brief.mjs';
import { isWaveFile, readPlanBytes, showLine } from './plan-sync.mjs';
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

test('CRLF and BOM files are refused as input (exit 2), in the native or the artifact, marked or marker-less', () => {
  const lf = plan(), crlf = lf.replace(/\n/g, '\r\n'), bom = `﻿${lf}`;
  const ok = put('a4.md', lf);
  for (const [t, code] of [[crlf, 'plan_crlf'], [bom, 'plan_bom']]) {
    const f = put(`bad-${code}.md`, t);
    const asArtifact = check(ok, f), asNative = check(f, ok);
    assert.deepEqual([asArtifact.status, asArtifact.json.code, asArtifact.json.which], [2, code, 'artifact']);
    assert.deepEqual([asNative.status, asNative.json.code, asNative.json.which], [2, code, 'native']);
    assert.equal(asNative.json.in_sync, false);
  }
  // marker-less native with CRLF or BOM
  const art = put('mlart.md', `# P\n\n${B}\nx\n${E}\n`);
  assert.equal(check(put('ml-crlf.md', '# P\r\n\r\n'), art).json.code, 'plan_crlf');
  assert.equal(check(put('ml-bom.md', '﻿# P\n\n'), art).json.code, 'plan_bom');
  // the engine still hashes the CRLF twin differently; plan-sync simply refuses it
  assert.notEqual(planDigest(crlf), planDigest(lf));
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

test('first differing line is bounded to 200 characters per side', () => {
  const long = 'x'.repeat(5000);
  const r = check(put('l1.md', plan(`  ${long}  \n`)), put('l2.md', plan(`${long}y\n`)));
  assert.equal(r.status, 1);
  assert.ok(r.json.first_difference.native.length <= 200);
  assert.ok(r.json.first_difference.artifact.length <= 200);
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
  assert.equal(s.json.approved_match, false, 'approved_match is never true when the artifact is stale');
  // marked native + stale artifact with an extra approval_status line: still false even if --approved is the artifact digest
  const stale = `approval_status: approved\n${t}`;
  const s2 = check(a, put('ap6.md', stale), ['--approved', planDigest(stale)]);
  assert.deepEqual([s2.status, s2.json.in_sync, s2.json.approved_match], [1, false, false]);
  assert.equal(check(a, put('ap7.md', stale), ['--approved', d]).json.approved_match, false);
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

const WAVE = '# Plan\n\n## Ticket 3 - closing hardening\n\nPlan A.\n\n## Ticket 4 - closing record\n\nPlan B.\n';
test('a wave file (two or more Ticket N sections) exits 3 plan_sync_unsupported; distinct from 1 and 2', () => {
  const ok = put('ok3.md', plan());
  const wn = check(put('w1.md', WAVE), ok), wa = check(ok, put('w2.md', plan(WAVE)));
  for (const r of [wn, wa]) {
    assert.equal(r.status, 3);
    assert.equal(r.json.code, 'plan_sync_unsupported');
    assert.equal(r.json.in_sync, false);
  }
  assert.equal(wn.json.which, 'native');
  assert.equal(wa.json.which, 'artifact');
  assert.equal(check(put('w3.md', '   # Ticket 1\n\n### TICKET 2: x\n'), ok).status, 3, 'indented up to 3 spaces, any case');
  assert.deepEqual([check(ok, put('s1.md', plan('# other\n'))).status, check(ok, put('bad.md', 'x')).status, wn.status], [1, 2, 3]);
});

test('wave rule: not a wave when the plan only mentions waves, has one ticket section, or shows Ticket headings in fenced code', () => {
  const single = [
    '# Wave 1\n', '# Waves\n\n## Wave-based rollout\n', '### Wave 0\n\n### Wave 1\n', '# Wavelength plan\n', '# Ticket 1 - only one\n',
    '# Ticket 1\n\n## Ticket 1 again\n', '    # Ticket 1\n\n    # Ticket 2\n', 'Ticket 1\nTicket 2\n',
    '```md\n# Ticket 1\n\n# Ticket 2\n```\n', '~~~\n## Ticket 1\n## Ticket 2\n~~~\n# Ticket 3\n',
  ];
  for (const [i, narr] of single.entries()) {
    const t = plan(narr), f = put(`sw${i}.md`, t);
    assert.equal(isWaveFile(t), false, narr);
    assert.equal(check(f, f).status, 0, narr);
  }
  assert.equal(isWaveFile('# Ticket 1\n\n```\n# x\n```\n# Ticket 2\n'), true, 'a closed fence ends the skip');
});

test('wave rule on the real .specs/plans corpus: only the multi-ticket closure plan is a wave file', () => {
  const plansDir = fileURLToPath(new URL('../../../.specs/plans/', import.meta.url));
  const files = readdirSync(plansDir).filter((n) => n.endsWith('.md'));
  assert.ok(files.length >= 10);
  const waves = files.filter((n) => isWaveFile(readFileSync(join(plansDir, n), 'utf8'))).sort();
  assert.deepEqual(waves, ['AIS-HARNESS-4-closure.md']);
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
    assert.equal(cli, planDigest(text));
    assert.equal(cli, `sha256:${planNarrativeDigest(text).replace(/^sha256:/, '')}`);
    if (text.includes('\r')) { assert.equal(check(p, p).status, 2, 'CRLF input is refused, though it hashes'); continue; }
    const r = check(p, p);
    assert.equal(r.json.narrative_digest, cli);
    assert.equal(check(p, p, ['--approved', cli]).json.approved_match, true);
  }
});

test('invalid UTF-8 is refused (plan_encoding), never replaced by U+FFFD; native_sha256 hashes the exact bytes', () => {
  const art = Buffer.from(`# P\n\n${B}\nx\n${E}\n`);
  const enc = (bytes) => { const p = join(dir, `enc-${bytes.join('-')}.md`); writeFileSync(p, Buffer.from(bytes)); return p; };
  const artf = join(dir, 'enc-art.md'); writeFileSync(artf, art);
  const r = check(enc([0x41, 0xff, 0x0a]), artf);
  assert.deepEqual([r.status, r.json.code, r.json.which], [2, 'plan_encoding', 'native']);
  assert.equal(check(enc([0x80]), enc([0x81])).status, 2);
  // marked native whose narrative differs only by an invalid byte: refused, not in sync
  const m1 = join(dir, 'enc-m1.md'), m2 = join(dir, 'enc-m2.md');
  writeFileSync(m1, Buffer.concat([Buffer.from('A'), Buffer.from([0xff]), Buffer.from(`\n${B}\n${E}\n`)]));
  writeFileSync(m2, Buffer.concat([Buffer.from('A'), Buffer.from([0xfe]), Buffer.from(`\n${B}\n${E}\n`)]));
  const m = check(m1, m2);
  assert.deepEqual([m.status, m.json.code], [2, 'plan_encoding']);
  // valid multibyte: the hash is over the file bytes
  const u = put('enc-ok.md', '# Ünï コード\n\n');
  const ok = check(u, put('enc-ok-art.md', `# Ünï コード\n\n${B}\nx\n${E}\n`));
  assert.equal(ok.status, 0);
  assert.equal(ok.json.native_sha256, sha(readFileSync(u)));
});

test('a file that changes during the read is refused as file_changed (growth, same-size rewrite)', () => {
  const f = join(dir, 'grow.md'); writeFileSync(f, plan());
  const real = { lstatSync: fsx.lstatSync, openSync: fsx.openSync, fstatSync: fsx.fstatSync, readSync: fsx.readSync, closeSync: fsx.closeSync };
  assert.equal(readPlanBytes(f, 'native', real).length, statSync(f).size, 'control: an unchanged file reads');
  // growth after the first read: the EOF loop sees more bytes than the size at fstat
  let n = 0;
  const grow = { ...real, readSync: (...a) => { const r = real.readSync(...a); if (n++ === 0) fsx.appendFileSync(f, 'STALE NARRATIVE\n'); return r; } };
  assert.throws(() => readPlanBytes(f, 'native', grow), (e) => e.reason === 'file_changed' && e.which === 'native');
  // same-size rewrite and new mtime after the read: the second fstat differs
  writeFileSync(f, plan());
  const past = new Date('2021-01-01T00:00:00Z'); utimesSync(f, past, past);
  const rewrite = { ...real, readSync: (...a) => { const r = real.readSync(...a); fsx.utimesSync(f, new Date(), new Date()); return r; } };
  assert.throws(() => readPlanBytes(f, 'artifact', rewrite), (e) => e.reason === 'file_changed' && e.which === 'artifact');
  // shrink
  writeFileSync(f, plan());
  const shrink = { ...real, readSync: (...a) => { fsx.truncateSync(f, 3); return real.readSync(...a); } };
  assert.throws(() => readPlanBytes(f, 'native', shrink), (e) => e.reason === 'file_changed');
});

test('marker-less native: text after END must be empty or exactly one LF, else the artifact is refused', () => {
  for (const tail of ['', '\n']) assert.equal(check(put('t1.md', `# P\n${tail}`), put('t2.md', `# P\n\n${B}\nx\n${E}${tail}`)).status, 0, JSON.stringify(tail));
  for (const tail of ['\n\n', '\nextra\n', ' \n', 'x']) {
    const r = check(put('t3.md', '# P\n'), put('t4.md', `# P\n\n${B}\nx\n${E}${tail}`));
    assert.deepEqual([r.status, r.json.code, r.json.which], [2, 'plan_invalid', 'artifact'], JSON.stringify(tail));
  }
});

test('first_difference snippets are escaped, never trimmed away, and at most 200 characters including the ellipsis', () => {
  assert.equal(showLine('a b '), 'a b ');
  assert.equal(showLine('a b'), 'a\\u2028b');
  assert.equal(showLine('a\rb'), 'a\\u000db');
  assert.equal(showLine('a\\b'), 'a\\u005cb');
  assert.equal(showLine('x'.repeat(200)).length, 200);
  assert.equal(showLine('x'.repeat(201)).length, 200);
  assert.ok(showLine('x'.repeat(201)).endsWith('...'));
  assert.equal(showLine('\u0001'.repeat(300)).length, 200);
  assert.equal(showLine(undefined), null);
  // whitespace-only and U+2028 and lone-CR differences are visible and detected end to end
  const diff = (n, a) => check(put(`fd-${n}n.md`, plan(n)), put(`fd-${n.length}a.md`, plan(a)));
  const ws = check(put('fd1n.md', plan('A \n')), put('fd1a.md', plan('A\n')));
  assert.deepEqual([ws.status, ws.json.first_difference], [1, { line: 1, native: 'A ', artifact: 'A' }]);
  const ls = check(put('fd2n.md', plan('A B\n')), put('fd2a.md', plan('A B\n')));
  assert.equal(ls.json.first_difference.native, 'A\\u2028B');
  const cr = check(put('fd3n.md', plan('A\rB\n')), put('fd3a.md', plan('AB\n')));
  assert.deepEqual([cr.status, cr.json.first_difference.native], [1, 'A\\u000dB']);
  const long = check(put('fd4n.md', plan(`${'x'.repeat(5000)}\n`)), put('fd4a.md', plan(`${'y'.repeat(5000)}\n`)));
  assert.equal(long.json.first_difference.native.length, 200);
  void diff;
});

test('docs: references/plan.md carries the read-only check and the WAIT_FOR_USER rule', () => {
  const doc = readFileSync(fileURLToPath(new URL('../references/plan.md', import.meta.url)), 'utf8');
  assert.match(doc, /plan-sync\.mjs check --native/);
  assert.match(doc, /denied, that is `WAIT_FOR_USER`, never a START or REVISION over a stale artifact/);
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
