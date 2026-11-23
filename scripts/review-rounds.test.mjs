// Tests for scripts/review-rounds.mjs (FR-4d). Run: node --test scripts/review-rounds.test.mjs
// Every case spawns the real CLI against a temp root (--root) and asserts the exact exit code and
// the typed violation code on stderr. REVIEW_ROUNDS_SCRIPT overrides the script under test (used
// by the mutation runs: each mutant is a modified copy that must fail at least one named case).
// Snapshot cases pass --no-base; the append-only cases build a real git repository (git is
// isolated from the user's and the system's configuration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.REVIEW_ROUNDS_SCRIPT || join(HERE, 'review-rounds.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const AT = '2026-11-23T10:00:00Z';

const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const lines = (rows) => rows.map((r) => `${canon(r)}\n`).join('');

const prim = (q = 0) => ({ role: 'primary', reviewer: 'opus', verdict: q ? 'fail' : 'pass', blockers: 0, majors: q });
const second = (q = 0) => ({ role: 'second_opinion', reviewer: 'codex', verdict: q ? 'fail' : 'pass', blockers: 0, majors: q });
const cycle = (o = {}) => ({
  kind: 'cycle', unit: 'U1', attempt: 1, cycle: 1, pr: 7, head: A, reviewers: [prim(), second()],
  summary: 'ok', repair_commit: null, at: AT, ...o,
});
const assessmentRow = (path, content, o = {}) => ({ kind: 'assessment', unit: 'U1', attempt: 1, path, sha256: sha(content), at: AT, ...o });
const attemptRow = (digest, o = {}) => ({
  kind: 'attempt', unit: 'U1', attempt: 2, authorized_by: 'owner', assessment_sha256: digest, reason: 'owner retry', at: AT, ...o,
});

// The five headings of the FR-4a assessment template (review.md "Assessment template").
const ASSESS = [
  '# Assessment', '', '## 1. Evidence', 'C1-M1, C2-M1', '', '## 2. Classification', 'implementation defect', '',
  '## 3. Why the consolidated repair did not hold', 'x', '', '## 4. Smallest defensible corrective approach', 'y', '',
  '## 5. What changes in the next attempt', 'z', '',
].join('\n');
const ASSESS_PATH = '.specs/reviews/U1/assessment-1.md';
const goodAttempt2 = () => [
  cycle(), cycle({ cycle: 2, head: B }),
  assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS)),
  cycle({ attempt: 2, head: C }),
];

function world(rows, { unit = 'U1', raw, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const dir = join(root, '.specs', 'reviews', unit);
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  writeFileSync(join(dir, 'review-rounds.jsonl'), raw ?? lines(rows));
  return root;
}
function addLedger(root, unit, rows) {
  mkdirSync(join(root, '.specs', 'reviews', unit), { recursive: true });
  writeFileSync(join(root, '.specs', 'reviews', unit, 'review-rounds.jsonl'), lines(rows));
  return root;
}
function cli(root, cmd = 'check', extra = ['--no-base']) {
  const r = spawnSync(process.execPath, [SCRIPT, cmd, '--root', root, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  rmSync(root, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function refused(root, code, detail, extra) {
  const r = cli(root, 'check', extra);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`: ${code}: `), r.err);
  if (detail) assert.match(r.err, detail, r.err);
  assert.equal(r.out, '');
}
function ioRefused(root, code, detail) {
  const r = cli(root);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, new RegExp(`review-rounds: ${code}: `), r.err);
  if (detail) assert.match(r.err, detail, r.err);
  assert.equal(r.out, '');
}

// --- git fixtures (append-only) -------------------------------------------------------------
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };
function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
// A repository whose commit on `main` holds the given ledgers (unit -> rows) and files; returns root.
function repo(ledgers, files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rr-git-')));
  git(root, 'init', '-q', '-b', 'main');
  for (const [u, rows] of Object.entries(ledgers)) addLedger(root, u, rows);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  writeFileSync(join(root, 'README'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const ledgerPath = (root, unit = 'U1') => join(root, '.specs', 'reviews', unit, 'review-rounds.jsonl');
const twoCycles = () => [cycle({ repair_commit: B, reviewers: [prim(1), second(1)] }), cycle({ cycle: 2, head: B, reviewers: [prim(1), second()] })];

test('zero ledgers passes and says append-only was not verified under --no-base', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const r = cli(root);
  assert.deepEqual([r.code, r.out, r.err], [0, 'review-rounds: 0 ledger(s) ok; append-only NOT verified (--no-base)\n', '']);
});

test('valid fixture: attempt 1 with cycles 1 and 2 passes; check and report agree', () => {
  const rows = [cycle({ repair_commit: B, reviewers: [prim(1), second(1)] }), cycle({ cycle: 2, head: B })];
  const r = cli(world(rows));
  assert.deepEqual([r.code, r.out, r.err], [0, 'review-rounds: 1 ledger(s) ok; append-only NOT verified (--no-base)\n', '']);
  const rep = cli(world(rows), 'report');
  assert.equal(rep.code, 0);
  assert.equal(rep.out, [
    'unit U1',
    '  attempt 1: 2 cycle(s)',
    `    cycle 1 head ${A.slice(0, 12)} pr 7 opus:fail codex:fail`,
    `    cycle 2 head ${B.slice(0, 12)} pr 7 opus:pass codex:pass`,
    '    repeated finding classes: unknown (not recorded)',
    '    state: complete - cycle 2 passed',
    'review-rounds: 1 ledger(s) ok; append-only NOT verified (--no-base)',
    '',
  ].join('\n'));
});

test('valid fixture: authorized second attempt with digest-bound assessment passes', () => {
  const r = cli(world(goodAttempt2(), { files: { [ASSESS_PATH]: ASSESS } }));
  assert.deepEqual([r.code, r.err], [0, '']);
});

test('provider_refused second opinion is accepted with a message, refused without', () => {
  const ref = { role: 'second_opinion', reviewer: 'codex', verdict: 'provider_refused', blockers: 0, majors: 0, message: 'content policy' };
  assert.equal(cli(world([cycle({ reviewers: [prim(), ref] })])).code, 0);
  const { message, ...bad } = ref;
  refused(world([cycle({ reviewers: [prim(), bad] })]), 'E_SCHEMA');
});

test('report marks a failed cycle 2 as BLOCKED', () => {
  const rows = [cycle({ reviewers: [prim(1), second()] }), cycle({ cycle: 2, head: B, reviewers: [prim(1), second(1)] })];
  const r = cli(world(rows), 'report');
  assert.equal(r.code, 0);
  assert.match(r.out, /state: BLOCKED - cycle 2 failed/);
});

test('RED: cycle 3 on an attempt is refused with E_CYCLE_LIMIT', () => {
  refused(world([cycle(), cycle({ cycle: 2, head: B }), cycle({ cycle: 3, head: C })]), 'E_CYCLE_LIMIT');
});

test('RED: cycle 3 is refused even straight after cycle 1 (no skipping)', () => {
  refused(world([cycle(), cycle({ cycle: 3, head: C })]), 'E_CYCLE_LIMIT');
});

test('RED: new attempt without authorized_by is refused with E_ATTEMPT_NO_AUTH', () => {
  const a = attemptRow(sha(ASSESS));
  delete a.authorized_by;
  const rows = [cycle(), assessmentRow(ASSESS_PATH, ASSESS), a];
  refused(world(rows, { files: { [ASSESS_PATH]: ASSESS } }), 'E_ATTEMPT_NO_AUTH');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS), { authorized_by: '' })], { files: { [ASSESS_PATH]: ASSESS } }), 'E_ATTEMPT_NO_AUTH');
});

test('RED: new attempt without an assessment digest is refused', () => {
  const a = attemptRow('x');
  delete a.assessment_sha256;
  refused(world([cycle(), a]), 'E_ATTEMPT_NO_ASSESSMENT');
  // digest present but no assessment row at all
  refused(world([cycle(), attemptRow(sha(ASSESS))]), 'E_ATTEMPT_NO_ASSESSMENT');
});

test('RED: assessment digest that does not match the file or the attempt row is refused', () => {
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS)], { files: { [ASSESS_PATH]: `${ASSESS}tampered` } }), 'E_ASSESSMENT_DIGEST');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha('other'))], { files: { [ASSESS_PATH]: ASSESS } }), 'E_ASSESSMENT_DIGEST');
});

test('assessment file missing, traversal path or symlink is refused with E_ASSESSMENT_FILE', () => {
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS)]), 'E_ASSESSMENT_FILE');
  refused(world([cycle(), assessmentRow('.specs/reviews/U1/../U1/a.md', ASSESS)]), 'E_ASSESSMENT_FILE', /unsafe assessment path/);
  const root = world([cycle(), assessmentRow(ASSESS_PATH, ASSESS)], { files: { 'real.md': ASSESS } });
  symlinkSync(join(root, 'real.md'), join(root, ASSESS_PATH));
  refused(root, 'E_ASSESSMENT_FILE', /not a regular file/);
});

test('RED (Round 1, M8): an assessment reached through a symlinked directory inside the unit dir is refused', () => {
  const root = world([cycle(), assessmentRow('.specs/reviews/U1/sub/a.md', ASSESS)], { files: { 'outside/a.md': ASSESS } });
  symlinkSync(join(root, 'outside'), join(root, '.specs', 'reviews', 'U1', 'sub'));
  refused(root, 'E_ASSESSMENT_FILE', /resolves outside \.specs\/reviews\/U1/);
});

test('RED (Round 1): the assessment must live in .specs/reviews/<UNIT>/ of its own ledger (E_ASSESSMENT_SCOPE)', () => {
  refused(world([cycle(), assessmentRow('assessment-1.md', ASSESS)], { files: { 'assessment-1.md': ASSESS } }), 'E_ASSESSMENT_SCOPE');
  refused(world([cycle(), assessmentRow('.specs/reviews/U2/a.md', ASSESS)], { files: { '.specs/reviews/U2/a.md': ASSESS } }), 'E_ASSESSMENT_SCOPE');
  refused(world([cycle(), assessmentRow('.specs/reviews/U1', ASSESS)]), 'E_ASSESSMENT_SCOPE');
});

test('RED (Round 1): an empty assessment is refused with E_ASSESSMENT_EMPTY', () => {
  refused(world([cycle(), assessmentRow(ASSESS_PATH, '')], { files: { [ASSESS_PATH]: '' } }), 'E_ASSESSMENT_EMPTY');
});

test('RED (Round 1): an assessment without the five template headings or a named class is refused (E_ASSESSMENT_TEMPLATE)', () => {
  const noHead = '# Assessment\nroot cause: x\n';
  refused(world([cycle(), assessmentRow(ASSESS_PATH, noHead)], { files: { [ASSESS_PATH]: noHead } }), 'E_ASSESSMENT_TEMPLATE', /"evidence"/i);
  const missing5 = ASSESS.replace('## 5. What changes in the next attempt', 'What changes in the next attempt');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, missing5)], { files: { [ASSESS_PATH]: missing5 } }), 'E_ASSESSMENT_TEMPLATE', /no heading "next attempt"/i);
  const outOfOrder = ASSESS.replace('## 1. Evidence', '## 1. Notes').replace('## 5. What', '## 5. Evidence. What');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, outOfOrder)], { files: { [ASSESS_PATH]: outOfOrder } }), 'E_ASSESSMENT_TEMPLATE');
  const noClass = ASSESS.replace('implementation defect', 'unsure');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, noClass)], { files: { [ASSESS_PATH]: noClass } }), 'E_ASSESSMENT_TEMPLATE', /classification names none/i);
});

test('the required headings and classes are the ones review.md\'s assessment template names (drift pin)', () => {
  const md = readFileSync(join(HERE, '..', 'skills', 'ship-ticket', 'references', 'review.md'), 'utf8');
  const tpl = md.slice(md.indexOf('**Assessment template**'), md.indexOf('**Manual versus engine today.**'));
  assert.ok(tpl.length > 100, 'assessment template section not found in review.md');
  const flat = tpl.replace(/\s+/g, ' ').toLowerCase();
  for (const p of ['evidence', 'classification', 'why the consolidated repair did not hold', 'corrective approach', 'next attempt',
    'architecture defect', 'implementation defect', 'unclear acceptance contract', 'trust-boundary failure', 'incomplete test strategy']) {
    assert.ok(flat.includes(p), `review.md template lacks ${p}`);
  }
  const src = readFileSync(SCRIPT, 'utf8');
  for (const p of ['why the consolidated repair did not hold', 'corrective approach', 'next attempt', 'trust-boundary failure']) {
    assert.ok(src.includes(`'${p}'`), `script does not require ${p}`);
  }
});

test('RED (Round 1, N4): an assessment over the 4 MiB cap is refused even with headings and a matching digest', () => {
  const big = ASSESS + 'x'.repeat((4 << 20) + 1 - ASSESS.length);
  refused(world([cycle(), assessmentRow(ASSESS_PATH, big)], { files: { [ASSESS_PATH]: big } }), 'E_ASSESSMENT_FILE', /too large/);
});

test('RED: attempt rows for an attempt that was never opened are refused', () => {
  refused(world([cycle({ attempt: 2 })]), 'E_ATTEMPT_UNRECORDED');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS), { attempt: 3 })], { files: { [ASSESS_PATH]: ASSESS } }), 'E_ATTEMPT_ORDER');
});

test('RED: rows for a closed attempt are refused', () => {
  const rows = [cycle(), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS)), cycle({ cycle: 2, head: B })];
  refused(world(rows, { files: { [ASSESS_PATH]: ASSESS } }), 'E_ATTEMPT_ORDER');
});

test('RED: forged extra keys (top level, reviewer entry) are refused with E_SCHEMA', () => {
  refused(world([{ ...cycle(), approved: true }]), 'E_SCHEMA');
  const sneaky = { ...prim(), waived: true };
  refused(world([cycle({ reviewers: [sneaky, second()] })]), 'E_SCHEMA');
});

test('RED: malformed JSON is refused with E_JSON', () => {
  refused(world([], { raw: `${canon(cycle())}\n{"kind":"cycle",\n` }), 'E_JSON');
  refused(world([], { raw: '[1,2]\n' }), 'E_JSON');
});

test('RED: unsorted cycles (2 before 1) and a skipped cycle are refused with E_CYCLE_ORDER', () => {
  refused(world([cycle({ cycle: 2, head: B }), cycle()]), 'E_CYCLE_ORDER');
  refused(world([cycle({ cycle: 2, head: B })]), 'E_CYCLE_ORDER');
});

test('RED: duplicate rows are refused with E_DUPLICATE (identical and same cycle key)', () => {
  refused(world([cycle(), cycle()]), 'E_DUPLICATE');
  refused(world([cycle(), cycle({ head: B })]), 'E_DUPLICATE');
});

test('RED: CRLF is refused with E_CRLF', () => {
  refused(world([], { raw: `${canon(cycle())}\r\n` }), 'E_CRLF');
});

test('format: no final newline, blank line, BOM, empty file, non-canonical spacing', () => {
  refused(world([], { raw: canon(cycle()) }), 'E_FORMAT');
  refused(world([], { raw: `${canon(cycle())}\n\n` }), 'E_FORMAT');
  refused(world([], { raw: `﻿${canon(cycle())}\n` }), 'E_FORMAT');
  refused(world([], { raw: '' }), 'E_FORMAT');
  refused(world([], { raw: `${JSON.stringify(cycle(), null, 1).replace(/\n\s*/g, ' ')}\n` }), 'E_CANONICAL');
  // unsorted keys, otherwise valid
  const c = cycle();
  refused(world([], { raw: `${JSON.stringify({ unit: c.unit, ...c })}\n` }), 'E_CANONICAL');
});

test('RED (Round 1, N1): the 2000-row cap is enforced exactly (2001 refused as too many rows, 2000 reaches row checks)', () => {
  const row = `${canon(cycle())}\n`;
  refused(world([], { raw: row.repeat(2001) }), 'E_FORMAT', /more than 2000 rows/);
  refused(world([], { raw: row.repeat(2000) }), 'E_DUPLICATE');
});

test('RED (Round 1, N2): a ledger over the 1 MiB cap is refused before parsing', () => {
  refused(world([], { raw: `${'x'.repeat(1 << 20)}\n` }), 'E_FORMAT', /larger than 1048576 bytes/);
});

test('duplicate JSON keys cannot smuggle a value (E_CANONICAL)', () => {
  const line = canon(cycle()).replace('"attempt":1', '"attempt":1,"attempt":1');
  refused(world([], { raw: `${line}\n` }), 'E_CANONICAL');
});

test('shape: head must be 40 lowercase hex, reviewers need a second opinion, verdict/count consistency', () => {
  refused(world([cycle({ head: 'A'.repeat(40) })]), 'E_SCHEMA');
  refused(world([cycle({ head: 'abc123' })]), 'E_SCHEMA');
  refused(world([cycle({ reviewers: [prim()] })]), 'E_SCHEMA');
  refused(world([cycle({ reviewers: [prim(), second(), second()] })]), 'E_SCHEMA');
  refused(world([cycle({ reviewers: [second(), prim()] })]), 'E_SCHEMA');
  refused(world([cycle({ reviewers: [prim(), { ...second(), verdict: 'fail' }] })]), 'E_SCHEMA');
  refused(world([cycle({ at: '2026-13-40T99:00:00Z' })]), 'E_SCHEMA');
  refused(world([cycle({ cycle: 2, repair_commit: B, head: C })]), 'E_SCHEMA');
});

test('same head in two cycles is refused with E_HEAD_REUSE; repair link enforced', () => {
  refused(world([cycle(), cycle({ cycle: 2 })]), 'E_HEAD_REUSE');
  refused(world([cycle({ repair_commit: B }), cycle({ cycle: 2, head: C })]), 'E_REPAIR_LINK');
});

test('head reuse is per attempt only: an authorized new attempt may review a head seen in the previous attempt', () => {
  const rows = [cycle(), cycle({ cycle: 2, head: B }), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS)), cycle({ attempt: 2, head: A })];
  assert.equal(cli(world(rows, { files: { [ASSESS_PATH]: ASSESS } })).code, 0);
});

test('row.unit must equal the directory name', () => {
  refused(world([cycle({ unit: 'OTHER' })]), 'E_UNIT_MISMATCH');
});

test('RED (Round 1, N5): a unit directory name outside the UNIT grammar is refused even when row.unit matches it', () => {
  refused(world([cycle({ unit: '-bad' })], { unit: '-bad' }), 'E_SCHEMA', /unit must match/);
});

test('optional finding_classes: sorted unique slugs accepted; unsorted, duplicate, empty or bad slugs refused', () => {
  assert.equal(cli(world([cycle({ finding_classes: ['append-only', 'cross-unit'], reviewers: [prim(1), second()] })])).code, 0);
  refused(world([cycle({ finding_classes: ['b', 'a'] })]), 'E_SCHEMA', /finding_classes/);
  refused(world([cycle({ finding_classes: ['a', 'a'] })]), 'E_SCHEMA', /finding_classes/);
  refused(world([cycle({ finding_classes: [] })]), 'E_SCHEMA', /finding_classes/);
  refused(world([cycle({ finding_classes: ['Has Space'] })]), 'E_SCHEMA', /finding_classes/);
});

test('RED (Round 1, B5): report shows repeated finding classes and the assessment outcome', () => {
  const rows = [
    cycle({ repair_commit: B, reviewers: [prim(1), second(1)], finding_classes: ['append-only', 'cross-unit'] }),
    cycle({ cycle: 2, head: B, reviewers: [prim(1), second()], finding_classes: ['append-only'] }),
    assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS)),
    cycle({ attempt: 2, head: C, reviewers: [prim(1), second()], finding_classes: ['append-only'] }),
  ];
  const r = cli(world(rows, { files: { [ASSESS_PATH]: ASSESS } }), 'report');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /attempt 1: 2 cycle\(s\)\n[\s\S]*cycle 1 head a{12} pr 7 opus:fail codex:fail classes append-only,cross-unit\n/);
  assert.match(r.out, /    repeated finding classes: append-only\n/);
  assert.match(r.out, new RegExp(`    assessment ${ASSESS_PATH.replace(/\./g, '\\.')} sha256 ${sha(ASSESS)} classification: implementation defect; next attempt authorized by owner\n`));
  assert.match(r.out, /attempt 2: 1 cycle\(s\) \(authorized_by owner\)/);
  assert.match(r.out, /  repeated finding classes across attempts: append-only\n/);
  assert.match(r.out, /    state: ready - cycle 2 of attempt 2 \(any new head\)\n/);
});

test('RED (Round 1, MAJOR 2): one PR split across two unit ledgers is refused with E_CROSS_UNIT', () => {
  // Codex's case: cycles 1-2 of PR 122 under U1, cycle 1 under U2.
  const root = world([cycle({ pr: 122, reviewers: [prim(1), second()] }), cycle({ cycle: 2, pr: 122, head: B, reviewers: [prim(1), second()] })]);
  addLedger(root, 'U2', [cycle({ unit: 'U2', pr: 122, head: C })]);
  refused(root, 'E_CROSS_UNIT', /pr 122 .*U1/);
});

test('RED (Round 1, MAJOR 2): one head sha recorded under two units is refused with E_CROSS_UNIT (pr null too)', () => {
  const root = world([cycle({ pr: null })]);
  addLedger(root, 'U2', [cycle({ unit: 'U2', pr: null, head: A })]);
  refused(root, 'E_CROSS_UNIT', /head a{40} .*U1/);
});

test('distinct PRs and heads in two units pass', () => {
  const root = world([cycle()]);
  addLedger(root, 'U2', [cycle({ unit: 'U2', pr: 8, head: D })]);
  const r = cli(root);
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /2 ledger\(s\) ok/);
  // pr:null in two units is not a shared PR (bound by head only)
  const root2 = world([cycle({ pr: null })]);
  addLedger(root2, 'U2', [cycle({ unit: 'U2', pr: null, head: D })]);
  assert.deepEqual(Object.values((({ code, err }) => ({ code, err }))(cli(root2))), [0, '']);
});

test('RED (Round 1): a symlinked unit directory or a symlinked .specs/reviews is refused (E_UNSAFE_PATH), not skipped', () => {
  const root = world([cycle()]);
  mkdirSync(join(root, 'elsewhere'));
  writeFileSync(join(root, 'elsewhere', 'review-rounds.jsonl'), lines([cycle({ unit: 'U2', pr: 8, head: D })]));
  symlinkSync(join(root, 'elsewhere'), join(root, '.specs', 'reviews', 'U2'));
  ioRefused(root, 'E_UNSAFE_PATH', /U2/);
  const r2 = mkdtempSync(join(tmpdir(), 'rr-'));
  const real = world([cycle()]);
  mkdirSync(join(r2, '.specs'));
  symlinkSync(join(real, '.specs', 'reviews'), join(r2, '.specs', 'reviews'));
  ioRefused(r2, 'E_UNSAFE_PATH', /reviews/);
  rmSync(real, { recursive: true, force: true });
});

test('RED (Round 1, N3): a ledger that is a symlink to a valid ledger is refused (E_UNSAFE_PATH)', () => {
  const root = world([], { raw: '' });
  writeFileSync(join(root, 'valid.jsonl'), lines([cycle()]));
  rmSync(ledgerPath(root));
  symlinkSync(join(root, 'valid.jsonl'), ledgerPath(root));
  ioRefused(root, 'E_UNSAFE_PATH', /not a regular file/);
});

test('usage and I/O exit codes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
  assert.equal(run('frobnicate').status, 2);
  assert.equal(run('check', '--root', root, '--root', root, '--no-base').status, 2);
  assert.equal(run('check', '--root', root).status, 2, 'neither --base nor --no-base');
  assert.equal(run('check', '--root', root, '--no-base', '--base', 'main').status, 2, 'both --base and --no-base');
  assert.equal(run('check', '--root', root, '--base', '-x').status, 2, 'option-looking base');
  assert.equal(run('check', '--root', root, '--file', 'x', '--no-base').status, 2, '--file was removed');
  assert.equal(run('next', '--root', root, '--no-base').status, 2, 'next needs --unit');
  assert.equal(run('next', '--root', root, '--unit', '../x', '--no-base').status, 2, 'unit grammar');
  rmSync(root, { recursive: true, force: true });
});

// --- MAJOR 1: append-only against the merge-base --------------------------------------------
test('append-only: appending a row to a base ledger passes and names the verified base', () => {
  const root = repo({ U1: [cycle({ repair_commit: B, reviewers: [prim(1), second(1)] })] });
  const base = git(root, 'rev-parse', 'HEAD');
  appendFileSync(ledgerPath(root), lines([cycle({ cycle: 2, head: B })]));
  const r = cli(root, 'check', ['--base', 'main']);
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(r.out, `review-rounds: 1 ledger(s) ok; append-only verified against base ${base}\n`);
});

test('RED (Round 1, MAJOR 1): rewriting the cycle-2 row is refused with E_APPEND_ONLY', () => {
  const root = repo({ U1: twoCycles() });
  const rows = twoCycles();
  rows[1] = cycle({ cycle: 2, head: B, reviewers: [prim(), second()] });
  writeFileSync(ledgerPath(root), lines(rows));
  refused(root, 'E_APPEND_ONLY', /not an append/, ['--base', 'main']);
});

test('RED (Round 1, MAJOR 1): deleting a base ledger (or its unit directory) is refused with E_LEDGER_DELETED', () => {
  const root = repo({ U1: twoCycles() });
  rmSync(ledgerPath(root));
  refused(root, 'E_LEDGER_DELETED', /U1\/review-rounds\.jsonl/, ['--base', 'main']);
  const root2 = repo({ U1: twoCycles() });
  rmSync(join(root2, '.specs', 'reviews', 'U1'), { recursive: true });
  refused(root2, 'E_LEDGER_DELETED', /U1\/review-rounds\.jsonl/, ['--base', 'main']);
});

test('RED (Round 1, MAJOR 1): replacing two cycles with a fresh cycle 1 is refused with E_APPEND_ONLY', () => {
  const root = repo({ U1: twoCycles() });
  writeFileSync(ledgerPath(root), lines([cycle({ head: C })]));
  refused(root, 'E_APPEND_ONLY', undefined, ['--base', 'main']);
});

test('append-only is measured from the merge-base, so a branch that adds a new ledger passes', () => {
  const root = repo({});
  git(root, 'checkout', '-q', '-b', 'feat');
  addLedger(root, 'U1', [cycle()]);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'add');
  const r = cli(root, 'check', ['--base', 'main']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^review-rounds: 1 ledger\(s\) ok; append-only verified against base [0-9a-f]{40}\n$/);
});

test('RED (Round 1, MAJOR 1): an unresolvable base fails closed with E_BASE_UNRESOLVED (exit 3), even with zero ledgers', () => {
  const noRepo = mkdtempSync(join(tmpdir(), 'rr-'));
  let r = cli(noRepo, 'check', ['--base', 'main']);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /review-rounds: E_BASE_UNRESOLVED: /);
  assert.equal(r.out, '');
  r = cli(repo({}), 'check', ['--base', 'no-such-ref']);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /E_BASE_UNRESOLVED: .*no-such-ref/);
  // a root that is a subdirectory of the repository is not a repository root
  const top = repo({ U1: [cycle()] });
  const sub = join(top, '.specs');
  r = spawnSync(process.execPath, [SCRIPT, 'check', '--root', sub, '--base', 'main'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  rmSync(top, { recursive: true, force: true });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /E_BASE_UNRESOLVED: .*top level/);
});

test('RED (Round 1, MAJOR 1): a shallow clone fails closed with E_BASE_UNRESOLVED', () => {
  const src = repo({ U1: [cycle()] });
  const dst = join(realpathSync(mkdtempSync(join(tmpdir(), 'rr-sh-'))), 'c');
  const cl = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${src}`, dst], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(cl.status, 0, cl.stderr);
  const r = cli(dst, 'check', ['--base', 'origin/main']);
  rmSync(src, { recursive: true, force: true });
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /E_BASE_UNRESOLVED: .*shallow/);
});

// --- commit-by-commit chain (rows added on the PR branch itself) ------------------------------
function commitAll(root, msg) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(root, 'rev-parse', 'HEAD');
}
test('RED (Round 1b): a later PR commit that rewrites rows an earlier PR commit added is refused (E_APPEND_ONLY)', () => {
  const root = repo({});
  git(root, 'checkout', '-q', '-b', 'pr');
  addLedger(root, 'U1', twoCycles());
  commitAll(root, 'two cycles');
  writeFileSync(ledgerPath(root), lines([cycle({ head: C })]));
  const bad = commitAll(root, 'rewrite to a fresh cycle 1');
  refused(root, 'E_APPEND_ONLY', new RegExp(`${bad} is not an append`), ['--base', 'main']);
});

test('RED (Round 1b): the rewrite is also refused under a PR merge ref (first parent = base branch, as CI checks out)', () => {
  const root = repo({});
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'pr');
  addLedger(root, 'U1', twoCycles());
  commitAll(root, 'two cycles');
  writeFileSync(ledgerPath(root), lines([cycle({ head: C })]));
  const bad = commitAll(root, 'rewrite');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'pr');
  refused(root, 'E_APPEND_ONLY', new RegExp(`${bad} is not an append`), ['--base', base]);
});

test('RED (Round 1b): a merge commit that drops the ledger of its second parent is refused (every parent is compared)', () => {
  const root = repo({});
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'pr');
  addLedger(root, 'U1', twoCycles());
  const pr = commitAll(root, 'two cycles');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '-s', 'ours', '--no-edit', 'pr');
  refused(root, 'E_LEDGER_DELETED', new RegExp(`exists at ${pr} but not at [0-9a-f]{40}`), ['--base', base]);
});

test('RED (Round 1b): an uncommitted rewrite of a row committed on the branch is refused (working tree vs HEAD)', () => {
  const root = repo({});
  git(root, 'checkout', '-q', '-b', 'pr');
  addLedger(root, 'U1', twoCycles());
  commitAll(root, 'two cycles');
  writeFileSync(ledgerPath(root), lines([cycle({ head: C })]));
  refused(root, 'E_APPEND_ONLY', /the working tree is not an append/, ['--base', 'main']);
});

test('RED (Round 1b): deleting a ledger at an intermediate commit is refused even if a later commit restores it', () => {
  const root = repo({});
  git(root, 'checkout', '-q', '-b', 'pr');
  addLedger(root, 'U1', twoCycles());
  commitAll(root, 'add');
  rmSync(ledgerPath(root));
  const gone = commitAll(root, 'delete');
  addLedger(root, 'U1', twoCycles());
  commitAll(root, 'restore');
  refused(root, 'E_LEDGER_DELETED', new RegExp(`not at ${gone}`), ['--base', 'main']);
});

test('chain: a ledger first added at an intermediate commit and appended later passes; a merge of main is compared with both parents', () => {
  const root = repo({});
  git(root, 'checkout', '-q', '-b', 'pr');
  commitAll(root, 'unrelated');
  addLedger(root, 'U1', [cycle({ repair_commit: B, reviewers: [prim(1), second(1)] })]);
  commitAll(root, 'cycle 1');
  git(root, 'checkout', '-q', 'main');
  addLedger(root, 'U2', [cycle({ unit: 'U2', pr: 8, head: D })]);
  commitAll(root, 'main adds U2');
  git(root, 'checkout', '-q', 'pr');
  git(root, 'merge', '-q', '--no-edit', 'main');
  appendFileSync(ledgerPath(root), lines([cycle({ cycle: 2, head: B })]));
  commitAll(root, 'cycle 2');
  const r = cli(root, 'check', ['--base', 'main']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^review-rounds: 2 ledger\(s\) ok; append-only verified against base [0-9a-f]{40}\n$/);
});

test('RED (Round 1b): more than 1000 commits since the base fails closed with E_HISTORY_CAP', () => {
  const root = repo({});
  const head = git(root, 'rev-parse', 'HEAD');
  let stream = '';
  for (let i = 0; i < 1001; i += 1) {
    stream += `commit refs/heads/main\ncommitter t <t@example.invalid> ${1700000000 + i} +0000\ndata 1\nx\n${i === 0 ? `from ${head}\n` : ''}\n`;
  }
  const fi = spawnSync('git', ['-C', root, 'fast-import', '--quiet'], { input: stream, encoding: 'utf8', env: GIT_ENV });
  assert.equal(fi.status, 0, fi.stderr);
  git(root, 'reset', '-q', '--hard', 'main');
  const r = cli(root, 'check', ['--base', head]);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /review-rounds: E_HISTORY_CAP: 1001 commits since the base/);
  assert.equal(r.out, '');
});

// --- next: the pre-dispatch query ----------------------------------------------------------
function next(rows, extra = ['--no-base'], files = {}) {
  const root = rows ? world(rows, { files }) : mkdtempSync(join(tmpdir(), 'rr-'));
  return cli(root, 'next', ['--unit', 'U1', ...extra]);
}
test('RED (Round 1): next allows cycle 1 on a fresh unit and cycle 2 after a failed cycle 1 (exit 0)', () => {
  let r = next(null);
  assert.deepEqual([r.code, r.out], [0, 'review-rounds: next U1: allowed: cycle 1 of attempt 1\n']);
  r = next([cycle({ repair_commit: B, reviewers: [prim(1), second()] })]);
  assert.deepEqual([r.code, r.out], [0, `review-rounds: next U1: allowed: cycle 2 of attempt 1 (head ${B})\n`]);
});

test('RED (Round 1): next refuses with exit 4 when cycle 2 failed (BLOCKED) and when the budget is spent', () => {
  let r = next(twoCycles());
  assert.equal(r.code, 4, r.err);
  assert.equal(r.out, 'review-rounds: next U1: refused: BLOCKED - cycle 2 failed; write an assessment and obtain an authorized new attempt\n');
  r = next([...twoCycles(), assessmentRow(ASSESS_PATH, ASSESS)], ['--no-base'], { [ASSESS_PATH]: ASSESS });
  assert.equal(r.code, 4);
  assert.match(r.out, /refused: cycle 2 failed; assessment recorded; owner authorization needed/);
  r = next([cycle(), cycle({ cycle: 2, head: B })]);
  assert.equal(r.code, 4);
  assert.match(r.out, /refused: complete - cycle 2 passed/);
  r = next([cycle()]);
  assert.equal(r.code, 4);
  assert.match(r.out, /refused: complete - cycle 1 passed/);
});

test('next after an authorized new attempt allows cycle 1 of that attempt', () => {
  const rows = [...twoCycles(), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS))];
  const r = next(rows, ['--no-base'], { [ASSESS_PATH]: ASSESS });
  assert.deepEqual([r.code, r.out], [0, 'review-rounds: next U1: allowed: cycle 1 of attempt 2\n']);
});

test('next refuses while the second opinion of the last cycle was provider_refused', () => {
  const ref = { role: 'second_opinion', reviewer: 'codex', verdict: 'provider_refused', blockers: 0, majors: 0, message: 'policy' };
  const r = next([cycle({ reviewers: [prim(), ref] })]);
  assert.equal(r.code, 4);
  assert.match(r.out, /refused: waiting owner - second opinion provider_refused on cycle 1/);
});

test('next on an invalid ledger returns the violation exit code, never "allowed"', () => {
  const r = next([cycle(), cycle({ cycle: 3, head: C })]);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /E_CYCLE_LIMIT/);
});

test('the repository tracked ledgers pass with append-only verified (CI step contract)', () => {
  const base = process.env.REVIEW_ROUNDS_BASE || 'HEAD';
  const r = spawnSync(process.execPath, [SCRIPT, 'check', '--base', base], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^review-rounds: \d+ ledger\(s\) ok; append-only verified against base [0-9a-f]{40}\n$/);
});
