// Tests for scripts/review-rounds.mjs (FR-4d). Run: node --test scripts/review-rounds.test.mjs
// Every case spawns the real CLI against a temp root (--root) and asserts the exact exit code and
// the typed violation code on stderr. REVIEW_ROUNDS_SCRIPT overrides the script under test (used
// by the mutation runs: each mutant is a modified copy that must fail at least one named case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.REVIEW_ROUNDS_SCRIPT || join(HERE, 'review-rounds.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const AT = '2026-11-23T10:00:00Z';

const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const sha = (s) => createHash('sha256').update(s).digest('hex');

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

function world(rows, { unit = 'U1', raw, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const dir = join(root, '.specs', 'reviews', unit);
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  writeFileSync(join(dir, 'review-rounds.jsonl'), raw ?? rows.map((r) => `${canon(r)}\n`).join(''));
  return root;
}
function cli(root, cmd = 'check', extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, cmd, '--root', root, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  rmSync(root, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function refused(root, code) {
  const r = cli(root);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`: ${code}: `), r.err);
  assert.equal(r.out, '');
}

const ASSESS = '# assessment\nroot cause: x\n';
const ASSESS_PATH = '.specs/reviews/U1/assessment-1.md';
const goodAttempt2 = () => [
  cycle(), cycle({ cycle: 2, head: B }),
  assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha(ASSESS)),
  cycle({ attempt: 2, head: C }),
];

test('zero ledgers passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const r = cli(root);
  assert.deepEqual([r.code, r.out, r.err], [0, 'review-rounds: 0 ledger(s) ok\n', '']);
});

test('valid fixture: attempt 1 with cycles 1 and 2 passes; check and report agree', () => {
  const rows = [cycle({ repair_commit: B, reviewers: [prim(1), second(1)] }), cycle({ cycle: 2, head: B })];
  const r = cli(world(rows));
  assert.deepEqual([r.code, r.out, r.err], [0, 'review-rounds: 1 ledger(s) ok\n', '']);
  const rep = cli(world(rows), 'report');
  assert.equal(rep.code, 0);
  assert.equal(rep.out, `unit U1\n  attempt 1: 2 cycle(s)\n    cycle 1 head ${A.slice(0, 12)} opus:fail codex:fail\n    cycle 2 head ${B.slice(0, 12)} opus:pass codex:pass\nreview-rounds: 1 ledger(s) ok\n`);
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
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS)], { files: { [ASSESS_PATH]: ASSESS + 'tampered' } }), 'E_ASSESSMENT_DIGEST');
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS), attemptRow(sha('other'))], { files: { [ASSESS_PATH]: ASSESS } }), 'E_ASSESSMENT_DIGEST');
});

test('assessment file missing, traversal path or symlink is refused with E_ASSESSMENT_FILE', () => {
  refused(world([cycle(), assessmentRow(ASSESS_PATH, ASSESS)]), 'E_ASSESSMENT_FILE');
  refused(world([cycle(), assessmentRow('../outside.md', ASSESS)]), 'E_ASSESSMENT_FILE');
  const root = world([cycle(), assessmentRow(ASSESS_PATH, ASSESS)], { files: { 'real.md': ASSESS } });
  symlinkSync(join(root, 'real.md'), join(root, ASSESS_PATH));
  refused(root, 'E_ASSESSMENT_FILE');
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

test('row.unit must equal the directory name', () => {
  refused(world([cycle({ unit: 'OTHER' })]), 'E_UNIT_MISMATCH');
});

test('usage and I/O exit codes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const bad = spawnSync(process.execPath, [SCRIPT, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const rep = spawnSync(process.execPath, [SCRIPT, 'check', '--root', root, '--root', root], { encoding: 'utf8' });
  assert.equal(rep.status, 2);
  const missing = spawnSync(process.execPath, [SCRIPT, 'check', '--file', join(root, 'nope', 'review-rounds.jsonl')], { encoding: 'utf8' });
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /E_IO/);
  rmSync(root, { recursive: true, force: true });
});

test('the repository tracked ledgers pass (CI step contract)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^review-rounds: \d+ ledger\(s\) ok\n$/);
});
