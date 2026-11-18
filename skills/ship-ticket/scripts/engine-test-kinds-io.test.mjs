/**
 * S-01b2 P4r: runner evidence I/O (engine-test-kinds-io.mjs: the record; engine-test-kinds-reuse.mjs: reuse and the verdict).
 * Design rev 6 sections 1, 3, 4 and 5.2 (row P4r), owner decision OD-2.
 *
 * Claim level (L5/L12): these tests prove what the modules believe of a report they are GIVEN (vitest JSON from a runner whose
 * result the caller says is sealed): an L-ran record, i.e. the runner executed a test whose own title carries the marker and
 * recorded it as passed. They do NOT prove the test is meaningful, that the report is genuine (FX seals it; P5r wires it), or
 * anything about a real vitest: the reports follow vitest 4's JSON reporter shape (no vitest is a dependency).
 *
 * Fixtures: real git repositories in a temp dir, a real P2 verdict with the REAL `kindsForClasses`, the REAL P6 `testKindWaivers`.
 * Tests tagged [P4r-n] are the ones the mutation check (the last test) runs against each mutant (L1: killed only by an assertion).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRecord, readEntry, commandFor, evidenceIdentity, commandDigest, configDigest, toRepoRel, LIMITS, REFUSALS, FILE_VOIDS, CLAIM, RUNNER } from './engine-test-kinds-io.mjs';
import { tkVerdict, recordUsable } from './engine-test-kinds-reuse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const DAG = 'd'.repeat(64);

// ---- a real repository: the base commit and a worktree on top of it ----
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const tmp = (t, prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const TITLE = 'SECRET-TITLE-zq9 rejects a forged input';
/** The base commit holds the configs, one test with ONE marker and an uncovered (apps/web) test; the worktree adds the candidate's tests. */
function repo(t) {
  const dir = tmp(t, 'p4r-');
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'vitest.config.ts', 'export default {};\n');
  put(dir, 'package-lock.json', '{}\n');
  put(dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\n");
  put(dir, 'libs/money/unchanged.test.ts', "test('unchanged [kind:race]', () => {});\n");
  put(dir, 'apps/web/ng.test.ts', "it('x', () => {});\n");
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  put(dir, 'libs/money/new.test.ts', `test('${TITLE} [kind:negative]', () => {});\n`);
  return { dir, base };
}
/** The design's declared form (section 1, StoreCraft instance), and the args that RAN for it. */
const ENTRY = { name: 'unit', format: 'vitest-json', cmd: 'node_modules/.bin/vitest', args: ['run', '--pool=forks', '--reporter=json', '--outputFile={report}', '{files}'],
  covers: ['libs/**', 'apps/api/**'], config_paths: ['vitest.config.ts', 'package-lock.json'] };
const ARGS = ['run', '--pool=forks', '--reporter=json', '--outputFile=/dev/fd/3', 'libs/money/new.test.ts'];
/** A vitest 4 JSON report: `suites` = [{ file, cases:[{ title, status, ancestors }] }]; failing cases make the suite and run fail. */
function report(suites, top = {}) {
  const failed = suites.filter((s) => s.cases.some((c) => c.status === 'failed')).length;
  const testResults = suites.map((s) => ({ name: s.file, status: s.cases.some((c) => c.status === 'failed') ? 'failed' : 'passed', startTime: 1, endTime: 2, message: '',
    assertionResults: s.cases.map((c) => ({ ancestorTitles: c.ancestors ?? [], fullName: c.title, status: c.status ?? 'passed', title: c.title, duration: 1, failureMessages: c.status === 'failed' ? ['AssertionError: x'] : [], meta: {} })) }));
  return JSON.stringify({ numTotalTestSuites: suites.length, numFailedTestSuites: failed, numTotalTests: 1, numFailedTests: failed, success: failed === 0, startTime: 1, ...top, testResults });
}
const passing = (dir, title = `${TITLE} [kind:negative]`) => report([{ file: join(dir, 'libs/money/new.test.ts'), cases: [{ title }] }]);
const prov = (text, over = {}) => ({ text, runner_id: 'vitest', runner_version: '2.1.0', attempt_id: 'a1', exit_code: 0, report_sha256: sha(text), report_eof: true, sealed: true, quiesced: true, binding_verified: true, evidence_id_before: null, ...over });
/** build() with the identity bracket filled in (the caller's "before" is the identity now, unless overridden). */
function build(r, text, o = {}) {
  const before = o.before ?? evidenceIdentity({ repo: r.dir, baseSha: r.base, exclusions: o.exclusions }).evidence_id;
  return buildRecord({ repo: r.dir, baseSha: r.base, entry: o.entry ?? ENTRY, commandArgs: o.args ?? ARGS, tests: { globs: [] }, dagDigest: DAG, ...(o.exclusions ? { exclusions: o.exclusions } : {}), report: prov(text, { evidence_id_before: before, ...o.prov }) });
}
const code = (res) => { assert.equal(res.ok, false, `a refusal is expected: ${JSON.stringify(res).slice(0, 300)}`); return res.code; };
const credits = (res) => { assert.equal(res.ok, true, JSON.stringify(res).slice(0, 400)); return res.record.files.flatMap((f) => f.credited); };

// ---- the verdict side: a real P3 bound record, the real P6 waivers ----
const bound = (tags, kinds, prot = [], items = []) => ({ tags, items, kinds: Object.fromEntries(kinds.map(([k, ...s]) => [k, s])), protected: prot });
const NEG = bound(['input-path'], [['negative', 'tag:input-path']]);
const RACE = bound(['concurrency'], [['race', 'tag:concurrency']]);
const MONEY = bound(['money'], [['negative', 'tag:money'], ['race', 'tag:money']], ['negative', 'race']);
const S0 = { run_id: 'run-1', plan_digest: 'sha256:' + 'a'.repeat(64), attempts: [], authority: { through: 0, trusted: [], untrusted: [] } };
const view = (r, rec, o = {}) => ({ repo: r.dir, baseSha: r.base, dagDigest: DAG, exclusions: o.exclusions ?? [], entries: [o.entry ?? ENTRY], commands: { unit: { cmd: ENTRY.cmd, args: o.args ?? ARGS } },
  records: rec ? { unit: rec } : {}, tests: { globs: [] }, bound: o.bound ?? NEG, declaration: null, reassessed: o.reassessed ?? [], S: o.S ?? S0 });
const verdict = (r, rec, o = {}) => tkVerdict(view(r, rec, o), o.point ?? 'F1');
const good = (r, text = passing(r.dir)) => { const b = build(r, text); assert.equal(b.ok, true, JSON.stringify(b)); return b.record; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const cur = (r, o = {}) => ({ repo: r.dir, baseSha: r.base, dagDigest: DAG, entry: o.entry ?? ENTRY, command: { cmd: ENTRY.cmd, args: o.args ?? ARGS }, tests: { globs: [] } });

test('[P4r-1] AC1 control: a record built from a sealed passing run reaches a pass verdict, claim L-ran, with the identity it was built on', (t) => {
  const r = repo(t), rec = good(r);
  assert.equal(CLAIM, 'L-ran');
  assert.equal(rec.claim, 'L-ran');
  assert.deepEqual(rec.runner, { id: 'vitest', version: '2.1.0', format: 'vitest-json' });
  assert.deepEqual(rec.files, [{ file: 'libs/money/new.test.ts', outcome: 'counted', credited: ['kind:negative'], withheld: {}, skipped: {}, unknown: 0 }]);
  assert.equal(rec.command_digest, commandDigest(ENTRY.cmd, ARGS), 'the record binds the args that RAN');
  const v = verdict(r, rec);
  assert.equal(v.status, 'pass', JSON.stringify(v));
  assert.equal(v.claim, 'L-ran');
  assert.equal(v.evidence_id, rec.evidence_id);
  assert.deepEqual(v.records, { unit: 'current' });
  assert.equal(verdict(r, null).code, 'missing_test_kinds', 'no record: nothing is evidence');
  assert.deepEqual(verdict(r, null).records, { unit: 'absent' });
});

test('[P4r-2] AC1: each section 3 reuse condition invalidates a record ALONE (identity, integrity, applicability, freshness)', (t) => {
  const r = repo(t), rec = good(r), expect = (mut, reason, o = {}) => {
    const copy = clone(rec);
    mut?.(copy);
    const v = verdict(r, copy, o);
    assert.equal(v.code, 'missing_test_kinds', reason);
    assert.deepEqual(v.records, { unit: `stale:${reason}` });
  };
  // identity
  expect((c) => { c.base_sha = 'b'.repeat(40); }, 'identity');
  expect((c) => { c.evidence_id = `e1:${'0'.repeat(64)}`; }, 'identity');
  // integrity: each flag alone
  for (const k of ['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable']) expect((c) => { c.integrity[k] = false; }, 'integrity');
  expect((c) => { delete c.integrity.sealed; }, 'malformed'); // a missing flag is a malformed record, never a pass
  // applicability: a non-zero exit, another entry's record, another runner or format or claim, a covers that no longer includes the file
  expect((c) => { c.exit_code = 1; }, 'applicability');
  expect((c) => { c.entry = 'other'; }, 'applicability');
  expect((c) => { c.runner.id = 'jest'; }, 'applicability');
  expect((c) => { c.runner.format = 'jest-json'; }, 'applicability');
  expect((c) => { c.claim = 'L-proves'; }, 'applicability');
  expect(null, 'applicability', { entry: { ...ENTRY, covers: ['apps/api/**'] } });
  // freshness: the DAG digest, the command after substitution, the config bytes
  expect((c) => { c.dag_digest = 'e'.repeat(64); }, 'freshness');
  expect(null, 'freshness', { args: [...ARGS, 'libs/money/other.test.ts'] });
  expect((c) => { c.command_digest = commandDigest(ENTRY.cmd, ['run']); }, 'freshness');
  expect((c) => { c.config_digest = 'f'.repeat(64); }, 'freshness');
  // a changed candidate byte is the identity condition, again with the record untouched
  put(r.dir, 'libs/money/extra.txt', 'x');
  expect(null, 'identity');
  // malformed state is never a pass
  for (const bad of [null, 5, [], { files: 1 }, 'x']) assert.deepEqual(tkVerdict({ ...view(r, null), records: { unit: bad } }, 'F1').records, { unit: 'stale:malformed' });
});

test('[P4r-3] AC1: an exit-0 control stays current when nothing it depends on moved; recordUsable is the same rule', (t) => {
  const r = repo(t), rec = good(r);
  const a = verdict(r, rec), b = verdict(r, clone(rec));
  assert.equal(a.status, 'pass'); assert.equal(b.status, 'pass');
  assert.deepEqual(recordUsable(rec, cur(r)), { ok: true, evidence: { kinds: ['negative'], items: [], unknown_markers: 0, withheld: {} } });
  assert.deepEqual(recordUsable({ ...rec, dag_digest: 'e'.repeat(64) }, cur(r)), { ok: false, reason: 'freshness' });
  assert.deepEqual(recordUsable(rec, { ...cur(r), baseSha: 'HEAD' }), { ok: false, reason: 'unavailable', code: 'test_kinds_error' });
  // the input is validated by the same current context the verdict uses: entry, command, config digest
  const un = (o, want, why) => assert.deepEqual(recordUsable(rec, { ...cur(r), ...o }), { ok: false, reason: 'unavailable', code: want }, why);
  un({ entry: { ...ENTRY, cmd: 'node_modules/.bin/jest' } }, 'runner_unsupported', 'another runner');
  un({ command: { cmd: '/tmp/evil/vitest', args: ARGS } }, 'runner_unsupported', 'another cmd');
  un({ command: { cmd: ENTRY.cmd, args: [...ARGS, '--typecheck'] } }, 'runner_unsupported', 'an extra flag');
  un({ command: undefined }, 'test_kinds_error', 'recordUsable always needs the current command');
  un({ entry: { ...ENTRY, config_paths: ['libs'] } }, 'evidence_unavailable', 'a config path that is not a regular file (the digest fails)');
});

test('[P4r-4] AC2 rules 2 and 4: only a PASSED result with the marker in its OWN leaf title counts; skip, todo, fail and load never do', (t) => {
  const r = repo(t);
  const file = join(r.dir, 'libs/money/new.test.ts');
  const only = (c) => build(r, report([{ file, cases: [c] }]));
  assert.deepEqual(credits(only({ title: 'p [kind:negative]' })), ['kind:negative']);
  for (const status of ['skipped', 'pending', 'todo', 'disabled']) assert.deepEqual(credits(only({ title: 'p [kind:negative]', status })), [], status);
  // a marker only in a SUITE title credits nothing (rule 4)
  assert.deepEqual(credits(only({ title: 'plain', ancestors: ['suite [kind:negative]'] })), []);
  // a failing result, in an exit-0 report or an exit-1 report, refuses the whole record (a RED run never satisfies a kind)
  assert.equal(code(only({ title: 'p [kind:negative]', status: 'failed' })), 'evidence_run_failed');
  assert.equal(code(build(r, passing(r.dir), { prov: { exit_code: 1 } })), 'evidence_run_failed');
  const withFail = report([{ file, cases: [{ title: 'p [kind:negative]' }, { title: 'q', status: 'failed' }] }]);
  assert.equal(code(build(r, withFail, { prov: { exit_code: 1 } })), 'evidence_run_failed');
  // a load error (a failed suite with no assertion results) is a failed run
  const load = JSON.stringify({ success: false, numFailedTestSuites: 1, numFailedTests: 0, testResults: [{ name: file, status: 'failed', message: 'Failed to load', assertionResults: [] }] });
  assert.equal(code(build(r, load)), 'evidence_run_failed');
  // a forged, self-contradicting report is still a failed run: each whole-run signal alone refuses (Codex m5)
  const doc = (o = {}) => JSON.stringify({ success: true, numFailedTestSuites: 0, numFailedTests: 0, ...o.top, testResults: [{ name: file, status: o.suite ?? 'passed', message: '', assertionResults: [{ ancestorTitles: [], title: 'p [kind:negative]', status: o.case ?? 'passed', failureMessages: [] }] }] });
  assert.deepEqual(credits(build(r, doc())), ['kind:negative'], 'the control');
  for (const o of [{ top: { success: false } }, { top: { numFailedTestSuites: 1 } }, { top: { numFailedTests: 1 } }, { suite: 'failed' }, { case: 'failed' }]) assert.equal(code(build(r, doc(o))), 'evidence_run_failed', JSON.stringify(o));
  // a status outside vitest's six is not evidence; nor is a suite status other than passed/failed (vitest 4 writes only those)
  assert.equal(code(only({ title: 'p [kind:negative]', status: 'passed-ish' })), 'evidence_unavailable');
  for (const suite of ['skipped', 'pending', 'todo']) assert.equal(code(build(r, doc({ suite }))), 'evidence_unavailable', String(suite));
  assert.equal(verdict(r, null).code, 'missing_test_kinds');
  // markers: one `[plan:X]` (credited: its bytes are added), one unknown kind (counted, never credited), a malformed and an invalid item
  put(r.dir, 'libs/money/new.test.ts', "test('p [plan:Item1] [kind:not-a-kind] [kind:] [plan:9x]', () => {});\n");
  const res = only({ title: 'p [plan:Item1] [kind:not-a-kind] [kind:] [plan:9x]' });
  assert.deepEqual(credits(res), ['plan:Item1']);
  assert.equal(res.record.counts.unknown_markers, 2, 'kind:not-a-kind and plan:9x are unknown, never credited');
  // a title longer than the cap refuses the whole report (I-C: never silently unread; C1), at the cap it is read
  const long = `${'x'.repeat(LIMITS.maxTitleChars)} [kind:negative]`;
  put(r.dir, 'libs/money/new.test.ts', `test('${long}', () => {});\n`);
  assert.equal(code(only({ title: long })), 'evidence_budget_exceeded');
  assert.deepEqual(credits(only({ title: long.slice(-LIMITS.maxTitleChars) })), ['kind:negative']);
});

test('[P4r-5] AC2 rule 5 (R-3): a marker counts only when the file holds MORE of it than at base; the base file of a new file is empty', (t) => {
  const r = repo(t);
  const old = join(r.dir, 'libs/money/old.test.ts');
  const one = (file, title) => { const b = build(r, report([{ file, cases: [{ title }] }])); assert.equal(b.ok, true, JSON.stringify(b)); return b.record; };
  // unchanged file: not in P, so a void (it cannot be evidence of THIS candidate)
  assert.equal(one(old, 'old [kind:negative]').files[0].outcome, 'not_in_P');
  // the file is edited but holds the SAME number of markers as at base: nothing is credited, and the row says why
  put(r.dir, 'libs/money/old.test.ts', "test('renamed [kind:negative]', () => { expect(1).toBe(1); });\n");
  assert.deepEqual(one(old, 'renamed [kind:negative]').files[0], { file: 'libs/money/old.test.ts', outcome: 'counted', credited: [], withheld: { 'kind:negative': 'r3_unchanged' }, skipped: {}, unknown: 0 });
  // ... even when another reported file adds one, so the total over P allows it: the per-file count decides for each file
  const both = build(r, report([{ file: old, cases: [{ title: 'renamed [kind:negative]' }] }, { file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }]));
  assert.deepEqual(both.record.files.map((f) => [f.file, f.credited]), [['libs/money/new.test.ts', ['kind:negative']], ['libs/money/old.test.ts', []]]);
  // one more marker than at base: credited
  put(r.dir, 'libs/money/old.test.ts', "test('renamed [kind:negative]', () => {});\ntest('added [kind:negative]', () => {});\n");
  assert.deepEqual(one(old, 'added [kind:negative]').files[0].credited, ['kind:negative']);
  // a different marker in the same file than the base's: credited (count 1 > 0 for kind:race)
  put(r.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\ntest('n [kind:race]', () => {});\n");
  assert.deepEqual(one(old, 'n [kind:race]').files[0].credited, ['kind:race']);
  // a title marker that the file bytes do not spell (a template or .each): the count rule credits nothing
  put(r.dir, 'libs/money/new.test.ts', "test('no marker here', () => {});\n");
  assert.deepEqual(one(join(r.dir, 'libs/money/new.test.ts'), 'p [kind:negative]').files[0].credited, []);
  // `.each` expansion: ONE marker in the source, many expanded titles, still credited once
  put(r.dir, 'libs/money/new.test.ts', "test.each([1, 2, 3])('case %i [kind:negative]', () => {});\n");
  const each = build(r, report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [1, 2, 3].map((i) => ({ title: `case ${i} [kind:negative]` })) }]));
  assert.deepEqual(credits(each), ['kind:negative']);
  // CRLF bytes count the same as LF (L10)
  put(r.dir, 'libs/money/new.test.ts', "test('a [kind:negative]', () => {});\r\n");
  assert.deepEqual(one(join(r.dir, 'libs/money/new.test.ts'), 'a [kind:negative]').files[0].credited, ['kind:negative']);
  // a counted file over the size cap is a void
  put(r.dir, 'libs/money/new.test.ts', `test('a [kind:negative]', () => {});\n//${'x'.repeat(LIMITS.maxFileBytes)}\n`);
  assert.deepEqual(one(join(r.dir, 'libs/money/new.test.ts'), 'a [kind:negative]').files.map((f) => [f.outcome, f.credited]), [['file_too_large', []]]);
});

test('[P4r-6] AC2 rule 3: a result file outside the repo, outside P, not regular, not a test file, uncovered or relative is a typed void and credits nothing', (t) => {
  const r = repo(t);
  const out = tmp(t, 'p4r-out-');
  put(out, 'evil.test.ts', "test('e [kind:negative]', () => {});\n");
  put(r.dir, 'libs/money/helper.ts', "// [kind:negative]\n");
  put(r.dir, 'apps/web/new.test.ts', "it('w [kind:negative]', () => {});\n");
  symlinkSync(join(r.dir, 'libs/money/new.test.ts'), join(r.dir, 'libs/money/link.test.ts'));
  rmSync(join(r.dir, 'libs/money/old.test.ts')); // a deleted tracked test: in P, not a regular file
  // the same outcome on every platform (I7): a drive path is outside the repo on win32 and relative on POSIX
  const cases = [[join(out, 'evil.test.ts'), 'result_outside_repo'], [join(r.dir, 'libs/money/helper.ts'), 'not_test_file'], [join(r.dir, 'apps/web/new.test.ts'), 'runner_uncovered'],
    ['libs/money/new.test.ts', 'result_outside_repo'], ['C:\\repo\\libs\\new.test.ts', 'result_outside_repo'], [join(r.dir, 'libs/money/gone.test.ts'), 'not_in_P'],
    [join(r.dir, 'libs/money/old.test.ts'), 'not_regular'], [join(r.dir, 'libs/money/unchanged.test.ts'), 'not_in_P'], [join(out, 'missing', 'x.test.ts'), 'result_outside_repo'],
    [join(r.dir, 'ext', 'missing.test.ts'), 'result_outside_repo']]; // a MISSING file under a repo symlink to outside: its real ancestor decides
  symlinkSync(out, join(r.dir, 'ext'), 'dir');
  for (const [file, outcome] of cases) {
    const b = build(r, report([{ file, cases: [{ title: 'x [kind:negative]' }] }]));
    assert.equal(b.ok, true, file);
    assert.deepEqual(b.record.files.map((f) => f.outcome), [outcome], file);
    assert.deepEqual(b.record.files.flatMap((f) => f.credited), [], file);
    assert.ok(FILE_VOIDS.includes(outcome));
  }
  // a skipped carrier in a file outside P subtracts nothing and is not stored on its void row
  const outP = build(r, report([{ file: join(r.dir, 'libs/money/unchanged.test.ts'), cases: [{ title: 'u [kind:race]', status: 'skipped' }] }]));
  assert.deepEqual(outP.ok && outP.record.files, [{ file: 'libs/money/unchanged.test.ts', outcome: 'not_in_P', credited: [], withheld: {}, skipped: {}, unknown: 0 }]);
  // a relative name is never resolved against the cwd, even when the cwd IS the repo
  const cwd = process.cwd();
  try {
    process.chdir(r.dir);
    const rel = build(r, report([{ file: 'libs/money/new.test.ts', cases: [{ title: 'x [kind:negative]' }] }]));
    assert.deepEqual(rel.ok && rel.record.files.map((f) => [f.file, f.outcome]), [[null, 'result_outside_repo']]);
  } finally { process.chdir(cwd); }
  // a result naming a DIRECTORY (a tracked test file replaced by a directory) is not a regular file
  put(r.dir, 'libs/money/old.test.ts/inner.txt', 'x');
  const dirRes = build(r, report([{ file: join(r.dir, 'libs/money/old.test.ts'), cases: [{ title: 'x [kind:negative]' }] }]));
  assert.deepEqual(dirRes.ok && dirRes.record.files.map((f) => f.outcome), ['not_regular']);
  // a symlink named *.test.ts resolves to its target: the target is the file that counts, and a link + target merge into ONE row
  // (the target gets two added markers: old.test.ts was deleted above, so ONE added marker would be a move and credit nothing)
  put(r.dir, 'libs/money/new.test.ts', "test('x [kind:negative]', () => {});\ntest('y [kind:negative]', () => {});\n");
  const viaLink = build(r, report([{ file: join(r.dir, 'libs/money/link.test.ts'), cases: [{ title: 'x [kind:negative]' }] }, { file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: 'y [kind:negative]' }] }]));
  assert.equal(viaLink.ok, true, JSON.stringify(viaLink)); // two rows for one file would be a malformed record (a duplicate row)
  assert.deepEqual(viaLink.record.files.map((f) => [f.file, f.outcome, f.credited]), [['libs/money/new.test.ts', 'counted', ['kind:negative']]]);
});

test('[P4r-7] AC3: runner_config_changed (a config_paths file is in P, whatever is excluded), in both buildRecord and the verdict; runner_uncovered is counted', (t) => {
  const r = repo(t), rec = good(r);
  put(r.dir, 'vitest.config.ts', 'export default { globalSetup: "./evil.ts" };\n');
  assert.equal(code(build(r, passing(r.dir))), 'runner_config_changed');
  const v = verdict(r, rec);
  assert.equal(v.status, 'refused'); assert.equal(v.code, 'runner_config_changed'); assert.deepEqual(v.codes, ['runner_config_changed']);
  // I6: an exclusion covering the config path (or its directory) cannot hide the change
  for (const exclusions of [['vitest.config.ts'], ['libs'], ['vitest.config.ts', 'package-lock.json']]) {
    assert.equal(code(build(r, passing(r.dir), { exclusions })), 'runner_config_changed', JSON.stringify(exclusions));
    assert.equal(verdict(r, rec, { exclusions }).code, 'runner_config_changed', JSON.stringify(exclusions));
  }
  // an uncovered changed test file is counted in the verdict, never silently bypassed
  const r2 = repo(t); put(r2.dir, 'apps/web/new.test.ts', "it('w [kind:negative]', () => {});\n");
  const v2 = verdict(r2, good(r2));
  assert.equal(v2.voids.runner_uncovered, 1);
  assert.equal(v2.status, 'pass', 'the covered file still counts');
  assert.equal(verdict(r2, null).voids.runner_uncovered, 1);
  // a config path that is a symlink is refused, in the digest and in the verdict
  const r3 = repo(t), rec3 = good(r3);
  rmSync(join(r3.dir, 'package-lock.json')); symlinkSync(join(r3.dir, 'vitest.config.ts'), join(r3.dir, 'package-lock.json'));
  git(r3.dir, 'add', '-A'); git(r3.dir, 'commit', '-q', '-m', 'link'); // the link is committed AFTER the base, so it is in P too
  assert.deepEqual(configDigest(r3.dir, ['package-lock.json']), { ok: false, code: 'evidence_unavailable' });
  assert.equal(verdict(r3, rec3, { entry: { ...ENTRY, config_paths: ['package-lock.json'] } }).code, 'runner_config_changed');
  const r4 = repo(t); symlinkSync(join(r4.dir, 'vitest.config.ts'), join(r4.dir, 'cfg.ts'));
  git(r4.dir, 'add', '-A'); git(r4.dir, 'commit', '-q', '-m', 'link'); const b4 = git(r4.dir, 'rev-parse', 'HEAD');
  const rr = { dir: r4.dir, base: b4 }; put(r4.dir, 'libs/money/new.test.ts', "test('n [kind:negative]', () => {});\n");
  const e4 = { ...ENTRY, config_paths: ['cfg.ts'] };
  assert.equal(code(build(rr, passing(r4.dir), { entry: e4 })), 'evidence_unavailable', 'a symlinked config (not in P) is never hashed through');
  assert.equal(verdict(rr, rec, { entry: e4 }).code, 'evidence_unavailable');
  // a lockfile over the 4 MiB test-file cap is still digested (its own 64 MiB cap); over that it is refused (a sparse file)
  put(r.dir, 'big.json', 'x'.repeat(LIMITS.maxFileBytes + 1));
  assert.equal(configDigest(r.dir, ['big.json']).ok, true);
  writeFileSync(join(r.dir, 'huge.json'), ''); truncateSync(join(r.dir, 'huge.json'), LIMITS.maxConfigBytes + 1);
  assert.deepEqual(configDigest(r.dir, ['huge.json']), { ok: false, code: 'evidence_unavailable' });
  // the config digest binds the path names, not only the bytes
  assert.notEqual(configDigest(r.dir, ['package-lock.json']).digest, configDigest(r.dir, ['missing.json']).digest);
  put(r.dir, 'a.json', 'same'); put(r.dir, 'b.json', 'same');
  assert.notEqual(configDigest(r.dir, ['a.json']).digest, configDigest(r.dir, ['b.json']).digest);
});

test('[P4r-8] AC3 and OD-2 (I2): only the EXACT argv and the repo-local cmd qualify; everything else is runner_unsupported (never bypassed)', (t) => {
  const r = repo(t), text = passing(r.dir), A = ENTRY.args.slice(0, 4);
  const variants = [
    { format: 'jest-json' }, { format: 'tap' }, { format: 'junit' },
    { cmd: 'node_modules/.bin/jest' }, { cmd: 'node_modules/.bin/ng' }, { cmd: '/tmp/attacker/vitest' }, { cmd: 'vitest' }, { cmd: './node_modules/.bin/vitest' },
    { cmd: join(r.dir, 'node_modules/.bin/vitest') }, { cmd: 'node_modules/.bin/vitest.cmd' }, { cmd: 'C:\\evil\\vitest.cmd' },
    // order, terminator (options after `--` are inert, Codex M4), missing or duplicated required flags
    { args: ['run', '--', '--pool=forks', '--reporter=json', '--outputFile={report}'] }, { args: [A[0], A[2], A[1], A[3]] }, { args: A.slice(0, 3) },
    { args: [...A, '--pool=forks'] }, { args: [...A, '--reporter=json'] }, { args: ['--pool=forks', '--reporter=json', '--outputFile={report}'] },
    { args: [A[0], '--pool=threads', A[2], A[3]] }, { args: [A[0], A[1], '--reporter=verbose', A[3]] }, { args: [A[0], A[1], A[2], '--outputFile=/tmp/x'] },
    { args: [...A, '{files}', '{files}'] }, { args: [A[0], A[2], A[1], A[3], '{files}'] }, { args: [...A, '{report}'] }, { args: [...A, 'libs/money/new.test.ts'] },
  ];
  // every rejected flag class (Opus M-2 probe): each appended to the valid template
  for (const extra of [['--'], ['--typecheck'], ['--typecheck.only'], ['--browser'], ['--browser.enabled=true'], ['--no-pool'], ['--pool', 'threads'], ['--pool=vmThreads'],
    ['--dangerouslyIgnoreUnhandledErrors'], ['--globalSetup=x.ts'], ['--setupFiles=x.ts'], ['-c', 'x.ts'], ['--config=x.ts'], ['--workspace=w.ts'], ['--project=x'],
    ['--allowOnly'], ['--passWithNoTests'], ['--outputFile.json=/tmp/x'], ['--reporter=default'], ['--bail'], ['--root=/'], ['--dir=..']]) variants.push({ args: [...A, ...extra] });
  for (const v of variants) {
    assert.equal(code(build(r, text, { entry: { ...ENTRY, ...v } })), 'runner_unsupported', JSON.stringify(v));
    const out = verdict(r, null, { entry: { ...ENTRY, ...v } });
    assert.equal(out.status, 'refused'); assert.equal(out.code, 'runner_unsupported', JSON.stringify(v));
  }
  assert.equal(code(build(r, text, { prov: { runner_id: 'jest' } })), 'runner_unsupported');
  assert.equal(readEntry(ENTRY).name, 'unit');
  assert.deepEqual(readEntry({ ...ENTRY, args: A }).args, A, 'the template without {files} is valid');
  assert.deepEqual(RUNNER.args, A);
});

test('[P4r-9] AC3: provenance: every integrity field, the report digest, the exit status and the identity bracket each refuse with their own typed code', (t) => {
  const r = repo(t), text = passing(r.dir);
  const cases = [
    [{ sealed: false }, 'runner_output_tampered'], [{ binding_verified: false }, 'runner_output_tampered'], [{ report_sha256: sha('forged') }, 'runner_output_tampered'],
    [{ report_eof: false }, 'runner_survivor'], [{ quiesced: false }, 'quiescence_unknown'], [{ exit_code: 1 }, 'evidence_run_failed'], [{ exit_code: null }, 'evidence_run_failed'],
    [{ evidence_id_before: `e1:${'1'.repeat(64)}` }, 'candidate_moved'], [{ attempt_id: '' }, 'test_kinds_error'], [{ runner_version: 5 }, 'test_kinds_error'],
    [{ runner_version: '' }, 'test_kinds_error'], [{ runner_version: 'v 1' }, 'test_kinds_error'], [{ runner_version: '2.1.0;x' }, 'test_kinds_error'], [{ runner_version: 'x'.repeat(65) }, 'test_kinds_error'],
  ];
  for (const [over, want] of cases) assert.equal(code(build(r, text, { prov: over })), want, JSON.stringify(over));
  // a report that changed after it was sealed (forged text, original digest)
  assert.equal(code(build(r, text.replace('passed', 'passed ') /* not equal bytes */, { prov: { report_sha256: sha(text) } })), 'runner_output_tampered');
  assert.equal(build(r, text, { prov: { runner_version: '4.0.0-beta.3+sha' } }).ok, true, 'a pre-release version is a version');
  assert.deepEqual([...REFUSALS].sort(), ['candidate_moved', 'evidence_budget_exceeded', 'evidence_run_failed', 'evidence_unavailable', 'quiescence_unknown', 'runner_config_changed', 'runner_output_tampered', 'runner_survivor', 'runner_unsupported', 'test_kinds_error']);
});

test('[P4r-10] AC3 budgets (L3): bytes not characters, too many results or marker files, deep JSON and duplicate keys are refused promptly; the verdict refuses too many paths', (t) => {
  const r = repo(t);
  const file = join(r.dir, 'libs/money/new.test.ts');
  assert.equal(code(build(r, 'x'.repeat(LIMITS.maxReportBytes + 1))), 'evidence_budget_exceeded');
  // I8: 17 MiB of a two-byte character is under the cap in UTF-16 units and over it in bytes
  const pad = passing(r.dir).replace('{', `{"pad":"${'é'.repeat(17 * 1024 * 1024)}",`);
  assert.ok(pad.length < LIMITS.maxReportBytes && Buffer.byteLength(pad) > LIMITS.maxReportBytes);
  assert.equal(code(build(r, pad)), 'evidence_budget_exceeded');
  const small = passing(r.dir).replace('{', `{"pad":"${'é'.repeat(100)}",`);
  assert.equal(build(r, small).record.report_len, Buffer.byteLength(small), 'report_len is the byte length');
  const top = { success: true, numFailedTestSuites: 0, numFailedTests: 0 };
  const many = JSON.stringify({ ...top, testResults: [{ name: file, status: 'passed', assertionResults: Array.from({ length: LIMITS.maxResults + 1 }, () => ({ ancestorTitles: [], title: 't', status: 'passed', failureMessages: [] })) }] });
  assert.equal(code(build(r, many)), 'evidence_budget_exceeded');
  const files = JSON.stringify({ ...top, testResults: Array.from({ length: LIMITS.maxMarkerFiles + 1 }, (_, i) => ({ name: join(r.dir, `libs/f${i}.test.ts`), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'a [kind:negative]', status: 'passed', failureMessages: [] }] })) });
  assert.equal(code(build(r, files)), 'evidence_budget_exceeded');
  // deep and duplicate-key documents are not evidence (never a stack overflow, never "last key wins"), escaped keys included
  assert.equal(code(build(r, '['.repeat(100_000))), 'evidence_unavailable');
  assert.equal(code(build(r, `{"testResults":${'['.repeat(65)}${']'.repeat(65)}}`)), 'evidence_unavailable');
  assert.equal(code(build(r, passing(r.dir).replace('"success":true', '"success":true,"success":false'))), 'evidence_unavailable');
  assert.equal(code(build(r, passing(r.dir).replace('"success":true', '"success":true,"\\u0073uccess":false'))), 'evidence_unavailable');
  assert.equal(code(build(r, passing(r.dir).replace('"startTime":1', '"startTime":"\\x"'))), 'evidence_unavailable', 'an invalid escape in a value is malformed evidence, not an internal error');
  for (const bad of ['', '{', 'null', '[]', '{"testResults":5}', '{"testResults":[{"name":5}]}', '{"testResults":[null]}', 'not json', JSON.stringify({ ...top, testResults: [{ name: file, status: 'passed' }] }),
    JSON.stringify({ testResults: [] }), JSON.stringify({ ...top, success: 'yes', testResults: [] }), JSON.stringify({ ...top, numFailedTests: -1, testResults: [] })]) assert.equal(code(build(r, bad)), 'evidence_unavailable', bad);
  // per-row id caps: more distinct creditable or skipped markers in one file than LIMITS.maxIds
  const ids = Array.from({ length: LIMITS.maxIds + 1 }, (_, i) => `[plan:I${i}]`).join(' ');
  assert.equal(code(build(r, report([{ file, cases: [{ title: `a ${ids}`.slice(0, LIMITS.maxTitleChars) }, ...Array.from({ length: 4 }, (_, k) => ({ title: Array.from({ length: 140 }, (_, i) => `[plan:J${k}x${i}]`).join('') }))] }]))), 'evidence_budget_exceeded');
  assert.equal(code(build(r, report([{ file, cases: Array.from({ length: 4 }, (_, k) => ({ title: Array.from({ length: 140 }, (_, i) => `[plan:S${k}x${i}]`).join(''), status: 'skipped' })) }]))), 'evidence_budget_exceeded');
});

test('[P4r-23] AC3 budgets (L3): the identity refuses more changed paths or more bytes than its caps, in the verdict too', (t) => {
  const r2 = repo(t);
  for (let i = 0; i <= LIMITS.maxPaths; i++) writeFileSync(join(r2.dir, `p${i}.txt`), '');
  const v = verdict(r2, null);
  assert.equal(v.status, 'refused'); assert.equal(v.code, 'evidence_budget_exceeded');
  assert.equal(evidenceIdentity({ repo: r2.dir, baseSha: r2.base }).code, 'evidence_budget_exceeded');
  // a sparse file larger than the identity byte cap (no real disk use)
  const r3 = repo(t);
  writeFileSync(join(r3.dir, 'big.bin'), ''); truncateSync(join(r3.dir, 'big.bin'), LIMITS.maxIdentityBytes + 1);
  assert.equal(evidenceIdentity({ repo: r3.dir, baseSha: r3.base }).code, 'evidence_budget_exceeded');
});

// ---- round 2: the seven Codex confirmation findings at ba7abac, each reproduced RED before its fix ----
test('[P4r-24] C1 (I-C): a title over the cap is REFUSED, never dropped: an overlong non-passing carrier cannot restore a credit', (t) => {
  const r = repo(t);
  rmSync(join(r.dir, 'libs/money/new.test.ts')); // no other added marker in P
  const old = join(r.dir, 'libs/money/old.test.ts'), long = `${'x'.repeat(LIMITS.maxTitleChars)} [kind:negative]`;
  put(r.dir, 'libs/money/old.test.ts', `test('old [kind:negative]', () => {});\ntest.skip('${long}', () => {});\n`);
  // the control: the same added carrier with a short title subtracts, so nothing is credited
  assert.deepEqual(credits(build(r, report([{ file: old, cases: [{ title: 'old [kind:negative]' }, { title: 'short [kind:negative]', status: 'skipped' }] }]))), []);
  for (const status of ['skipped', 'todo', 'pending', 'disabled']) {
    const b = build(r, report([{ file: old, cases: [{ title: 'old [kind:negative]' }, { title: long, status }] }]));
    assert.equal(code(b), 'evidence_budget_exceeded', status);
  }
  // a passing overlong title is refused the same way (no title is ever silently unread)
  assert.equal(code(build(r, report([{ file: old, cases: [{ title: long }] }]))), 'evidence_budget_exceeded');
});

test('[P4r-25] C2 (I-E), superseded by S3: a hidden index flag inside a submodule, in P or outside it, or a nested one, is refused', (t) => {
  for (const atBase of [false, true]) for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const { r, inner } = withSubmodule(t, { atBase });
    git(inner, 'update-index', flag, 'a.txt'); put(r.dir, 'vendor/s/a.txt', 'two\n');
    assert.equal(git(inner, 'status', '--porcelain'), '', 'git status really reports the submodule clean');
    assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), SUBMODULE, `${flag} atBase=${atBase}`);
  }
  const { r } = withSubmodule(t, { nested: true });
  assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), SUBMODULE, 'nested');
});

test('[P4r-26] C3 (I-A): recordUsable refuses runner_config_changed exactly as the verdict does (a config path in the candidate, whatever is excluded)', (t) => {
  const r = repo(t), exclusions = ['vitest.config.ts'];
  const rec = build(r, passing(r.dir), { exclusions });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const original = readFileSync(join(r.dir, 'vitest.config.ts'));
  put(r.dir, 'vitest.config.ts', 'export default { globalSetup: "./evil.ts" };\n');
  git(r.dir, 'add', 'vitest.config.ts'); // staged differently ...
  writeFileSync(join(r.dir, 'vitest.config.ts'), original); // ... with the working bytes restored
  assert.equal(verdict(r, rec.record, { exclusions }).code, 'runner_config_changed', 'the verdict refuses');
  assert.deepEqual(recordUsable(rec.record, { ...cur(r), exclusions }), { ok: false, reason: 'unavailable', code: 'runner_config_changed' }, 'recordUsable refuses the same candidate');
});

test('[P4r-27] C4 (I-C): the id caps hold AFTER report names merge into one file (a link and its target)', (t) => {
  const r = repo(t);
  symlinkSync(join(r.dir, 'libs/money/new.test.ts'), join(r.dir, 'libs/money/link.test.ts'));
  const titles = (prefix, n, per = 150) => Array.from({ length: Math.ceil(n / per) }, (_, k) => Array.from({ length: Math.min(per, n - k * per) }, (_, i) => `[${prefix}${k * per + i}]`).join(''));
  const half = 300, link = join(r.dir, 'libs/money/link.test.ts'), target = join(r.dir, 'libs/money/new.test.ts');
  put(r.dir, 'libs/money/new.test.ts', [...titles('plan:A', half), ...titles('plan:B', half)].map((x) => `test('${x}', () => {});`).join('\n'));
  const two = (a, b, status) => build(r, report([{ file: link, cases: titles(a, half).map((title) => ({ title, status })) }, { file: target, cases: titles(b, half).map((title) => ({ title, status })) }]));
  // the control: each name alone is under the cap
  assert.equal(credits(build(r, report([{ file: target, cases: titles('plan:A', half).map((title) => ({ title })) }]))).length, half);
  assert.equal(code(two('plan:A', 'plan:B')), 'evidence_budget_exceeded', 'credited ids');
  assert.equal(code(two('plan:A', 'plan:B', 'skipped')), 'evidence_budget_exceeded', 'skipped ids');
  assert.equal(code(two('kind:ua', 'kind:ub')), 'evidence_budget_exceeded', 'unknown ids');
  // the merge itself is fine under the cap: 2 x 200 ids through the link and the target is ONE row of 400 credits
  const small = (a, b) => build(r, report([{ file: link, cases: titles(a, 200).map((title) => ({ title })) }, { file: target, cases: titles(b, 200).map((title) => ({ title })) }]));
  assert.equal(credits(small('plan:A', 'plan:B')).length, 400);
  // the skipped carriers of the link are the target's (Opus survivor): a skip reported through the link cancels the target's credit
  const r2 = repo(t);
  symlinkSync(join(r2.dir, 'libs/money/new.test.ts'), join(r2.dir, 'libs/money/link.test.ts'));
  const lt = (cases) => build(r2, report([{ file: join(r2.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }, ...cases]));
  assert.deepEqual(credits(lt([])), ['kind:negative'], 'the control: the target alone credits');
  const viaLink = lt([{ file: join(r2.dir, 'libs/money/link.test.ts'), cases: [{ title: 's [kind:negative]', status: 'skipped' }] }]);
  assert.deepEqual(credits(viaLink), []);
  assert.deepEqual(viaLink.record.files[0].skipped, { 'kind:negative': 1 });
});

test('[P4r-28] C5 (I-D), superseded by S1: a stored record is its rows; a total that disagrees with them, or a row that contradicts itself, is malformed', (t) => {
  const r = repo(t), rec = good(r);
  assert.equal(recordUsable(rec, cur(r)).ok, true, 'the control');
  for (const [mut, why] of [[(c) => { c.counts.passed = 0; }, 'a result count (round 2 schema) is no longer state'], [(c) => { c.counts.results = 1; c.counts.passed = 1; }, 'nor both'],
    [(c) => { c.report_len = 0; }, 'report_len:0']]) {
    const c = clone(rec); mut(c);
    assert.deepEqual(recordUsable(c, cur(r)), { ok: false, reason: 'malformed' }, why);
    assert.deepEqual(verdict(r, c).records, { unit: 'stale:malformed' }, why);
  }
  // each relation alone, against a control that differs only in the relation (the control is accepted)
  const voidRow = { file: null, outcome: 'result_outside_repo', credited: [], withheld: {}, skipped: {}, unknown: 0 };
  const pairs = [
    ['marker_files is the number of rows', (c) => { c.files.push(clone(voidRow)); }, (c) => { c.files.push(clone(voidRow)); c.counts.marker_files = 2; }],
    ['credited is the number of credits', (c) => { c.counts.credited = 2; }, () => {}],
    ['unknown_markers is the sum of the rows', (c) => { c.files[0].unknown = 1; }, (c) => { c.files[0].unknown = 1; c.counts.unknown_markers = 1; }],
    ['a skipped carrier only on a row inside P', (c) => { c.files.push({ ...clone(voidRow), file: 'libs/money/unchanged.test.ts', outcome: 'not_in_P', skipped: { 'kind:race': 1 } }); c.counts.marker_files = 2; },
      (c) => { c.files.push({ ...clone(voidRow), file: 'libs/money/unchanged.test.ts', outcome: 'runner_uncovered', skipped: { 'kind:race': 1 } }); c.counts.marker_files = 2; }],
    ['a withheld id is not also credited', (c) => { c.files[0].withheld = { 'kind:negative': 'r3_offset' }; }, (c) => { c.files[0].withheld = { 'kind:race': 'r3_unchanged' }; }],
    ['report_len is at least one byte', (c) => { c.report_len = 0; }, (c) => { c.report_len = 1; }],
  ];
  for (const [why, bad, ok] of pairs) {
    const b = clone(rec), o = clone(rec); bad(b); ok(o);
    assert.deepEqual(recordUsable(b, cur(r)), { ok: false, reason: 'malformed' }, why);
    assert.equal(recordUsable(o, cur(r)).ok, true, `control: ${why}`);
  }
});

test('[P4r-29] C6 (I-F): every declared entry\'s CURRENT command is validated before its record is looked up (an absent record too)', (t) => {
  const r = repo(t), rec = good(r), other = { ...ENTRY, name: 'other' };
  const two = (cmd) => tkVerdict({ ...view(r, rec), entries: [ENTRY, other], commands: { unit: { cmd: ENTRY.cmd, args: ARGS }, other: cmd } }, 'F1');
  assert.equal(two({ cmd: ENTRY.cmd, args: ARGS }).status, 'pass', 'the control: a valid command for the absent entry');
  for (const bad of [{ cmd: '/tmp/evil/vitest', args: ARGS }, { cmd: ENTRY.cmd, args: [...ARGS, '--typecheck'] }]) {
    const v = two(bad);
    assert.equal(v.status, 'refused', JSON.stringify(bad)); assert.equal(v.code, 'runner_unsupported', JSON.stringify(bad));
  }
  // a command may be MISSING only for an entry with no record ({files} may have nothing to run); a present one is always validated
  const E2 = (records, commands) => tkVerdict({ ...view(r, rec), entries: [ENTRY, other], commands, records }, 'F1');
  const ok = E2({ unit: rec }, { unit: { cmd: ENTRY.cmd, args: ARGS } });
  assert.equal(ok.status, 'pass'); assert.deepEqual(ok.records, { unit: 'current', other: 'absent' });
  assert.equal(E2({ unit: rec, other: rec }, { unit: { cmd: ENTRY.cmd, args: ARGS } }).code, 'test_kinds_error', 'a record with no current command');
  assert.equal(E2({ unit: rec }, {}).code, 'test_kinds_error', 'the same for the entry that has the record');
  assert.equal(tkVerdict({ ...view(r, rec), entries: [ENTRY, ENTRY] }, 'F1').code, 'test_kinds_error', 'entry names are unique');
});

test('[P4r-30] C7 (I-B): buildRecord refuses provenance that reuse would reject (an empty runner_version)', (t) => {
  const r = repo(t);
  assert.equal(code(build(r, passing(r.dir), { prov: { runner_version: '' } })), 'test_kinds_error');
});

// ---- I-B: the three interfaces agree, over a corpus that includes the seven Codex inputs ----
/** recordUsable and the verdict give the SAME answer for one record on one candidate (current / stale:reason / refused:code). */
const agree = (ru, v, why) => {
  if (ru.reason === 'unavailable') { assert.equal(v.status, 'refused', `${why}: the verdict refuses too`); assert.equal(v.code, ru.code, why); return `refused:${ru.code}`; }
  const state = ru.ok ? 'current' : `stale:${ru.reason}`;
  assert.deepEqual(v.records, { unit: state }, why);
  return state;
};
test('[P4r-31] I-B: every record buildRecord emits is current to recordUsable and the verdict; every refusal of one interface is a refusal of the others', (t) => {
  // (1) round trip: a corpus of build scenarios; each built record is current on the candidate it was built on, with the same credits
  const scenarios = [
    ['basic', (r) => passing(r.dir)],
    ['.each', (r) => { put(r.dir, 'libs/money/new.test.ts', "test.each([1,2])('c %i [kind:negative]', () => {});\n"); return report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [1, 2].map((i) => ({ title: `c ${i} [kind:negative]` })) }]); }],
    ['a plan item and unknown markers', (r) => { put(r.dir, 'libs/money/new.test.ts', "test('p [plan:Item1] [kind:zz]', () => {});\n"); return passing(r.dir, 'p [plan:Item1] [kind:zz] [plan:9x]'); }],
    ['a genuine addition beside a skipped one', (r) => { put(r.dir, 'libs/money/new.test.ts', "test('a [kind:negative]', () => {});\ntest('b [kind:negative]', () => {});\ntest.skip('s [kind:negative]', () => {});\n");
      return report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: 'a [kind:negative]' }, { title: 'b [kind:negative]' }, { title: 's [kind:negative]', status: 'skipped' }] }]); }],
    ['a skipped-only file and a void row', (r) => { put(r.dir, 'libs/money/s.test.ts', "test.skip('s [kind:race]', () => {});\n");
      return report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }, { file: join(r.dir, 'libs/money/s.test.ts'), cases: [{ title: 's [kind:race]', status: 'todo' }] }, { file: join(r.dir, 'apps/web/ng.test.ts'), cases: [{ title: 'w [kind:race]' }] }]); }],
    ['a link and its target (C4 under the cap)', (r) => { symlinkSync(join(r.dir, 'libs/money/new.test.ts'), join(r.dir, 'libs/money/link.test.ts'));
      return report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }, { file: join(r.dir, 'libs/money/link.test.ts'), cases: [{ title: 'l [kind:negative]' }] }]); }],
    ['a title AT the cap (C1 control)', (r) => { const at = `${'x'.repeat(LIMITS.maxTitleChars - 16)} [kind:negative]`; return passing(r.dir, at); }],
    ['a move (credits nothing, still current)', (r) => { rmSync(join(r.dir, 'libs/money/new.test.ts')); git(r.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/moved.test.ts');
      return report([{ file: join(r.dir, 'libs/money/moved.test.ts'), cases: [{ title: 'old [kind:negative]' }] }]); }],
  ];
  for (const [why, mk] of scenarios) {
    const r = repo(t), b = build(r, mk(r));
    assert.equal(b.ok, true, `${why}: ${JSON.stringify(b).slice(0, 300)}`);
    const ru = recordUsable(b.record, cur(r));
    assert.equal(agree(ru, verdict(r, b.record), why), 'current', why);
    assert.deepEqual([...ru.evidence.kinds.map((k) => `kind:${k}`), ...ru.evidence.items.map((i) => `plan:${i}`)].sort(), b.record.files.flatMap((f) => f.credited).sort(), why);
    assert.equal(ru.evidence.unknown_markers, b.record.counts.unknown_markers, why);
  }
  // (2) the seven Codex inputs. C1: the builder refuses; the record ba7abac emitted for it is CONSISTENT (the report is not stored),
  // so only the builder can refuse it (the reuse header says so). C4, C5, C7: the builder refuses, and the record ba7abac emitted
  // is malformed to both reuse interfaces. C2, C3 (in (3)), C6: every interface refuses the candidate with the same code.
  { const r = repo(t), rec = good(r), file = join(r.dir, 'libs/money/new.test.ts'), long = `${'x'.repeat(LIMITS.maxTitleChars)} [kind:negative]`;
    assert.equal(code(build(r, report([{ file, cases: [{ title: `${TITLE} [kind:negative]` }, { title: long, status: 'skipped' }] }]))), 'evidence_budget_exceeded', 'C1 builder');
    assert.equal(code(build(r, passing(r.dir), { prov: { runner_version: '' } })), 'test_kinds_error', 'C7 builder');
    const ids = Array.from({ length: 600 }, (_, i) => `plan:A${String(i).padStart(3, '0')}`).sort();
    const emitted = [['C7 as emitted', (c) => { c.runner.version = ''; }, 'stale:malformed'], ['C5 as stored (a round 2 result count)', (c) => { c.counts.passed = 0; }, 'stale:malformed'],
      ['C4 as emitted: 600 ids in one row', (c) => { c.files[0].credited = ids; c.counts.credited = 600; }, 'refused:evidence_budget_exceeded'],
      ['C4 as emitted: 600 skipped ids', (c) => { c.files[0].skipped = Object.fromEntries(ids.map((k) => [k, 1])); }, 'stale:malformed']];
    for (const [why, m, want] of emitted) { const c = clone(rec); m(c); assert.equal(agree(recordUsable(c, cur(r)), verdict(r, c), why), want, why); }
    const other = { ...ENTRY, name: 'other' };
    for (const bad of [{ cmd: '/tmp/evil/vitest', args: ARGS }, { cmd: ENTRY.cmd, args: [...ARGS, '--typecheck'] }]) {
      const v = tkVerdict({ ...view(r, rec), entries: [ENTRY, other], commands: { unit: { cmd: ENTRY.cmd, args: ARGS }, other: bad } }, 'F1');
      assert.equal(v.code, 'runner_unsupported', 'C6 verdict, absent record');
      assert.deepEqual(recordUsable(rec, { ...cur(r), command: bad }), { ok: false, reason: 'unavailable', code: 'runner_unsupported' }, 'C6 recordUsable');
      if (bad.cmd === ENTRY.cmd) assert.equal(code(build(r, passing(r.dir), { args: bad.args })), 'runner_unsupported', 'C6 builder');
    } }
  { const { r, inner } = withSubmodule(t), rec = good(repo(t));
    git(inner, 'update-index', '--skip-worktree', 'a.txt'); put(r.dir, 'vendor/s/a.txt', 'two\n');
    assert.equal(agree(recordUsable(rec, cur(r)), verdict(r, rec), 'C2'), 'refused:evidence_unavailable', 'C2 reuse');
    assert.equal(code(build(r, passing(r.dir))), 'evidence_unavailable', 'C2 builder'); }
  // (3) context perturbations of one good record: recordUsable and the verdict agree; a context refusal is the builder's too
  const contexts = [
    ['nothing moved', () => ({})],
    ['C3: a staged config, excluded, working bytes restored', (r) => { const o = readFileSync(join(r.dir, 'vitest.config.ts')); put(r.dir, 'vitest.config.ts', 'x\n'); git(r.dir, 'add', 'vitest.config.ts'); writeFileSync(join(r.dir, 'vitest.config.ts'), o); return { exclusions: ['vitest.config.ts'] }; }],
    ['a config edited in the worktree', (r) => { put(r.dir, 'vitest.config.ts', 'y\n'); return {}; }],
    ['C2: a hidden flag on a tracked file', (r) => { git(r.dir, 'update-index', '--assume-unchanged', 'package-lock.json'); return {}; }],
    ['a config that is not a regular file', () => ({ entry: { ...ENTRY, config_paths: ['libs'] } })],
    ['another runner', () => ({ entry: { ...ENTRY, cmd: 'node_modules/.bin/jest' } })],
    ['C6: another cmd now', () => ({ cmd: '/tmp/evil/vitest' })],
    ['C6: an extra flag now', () => ({ args: [...ARGS, '--typecheck'] })],
    ['another file set now', () => ({ args: [...ARGS, 'libs/money/other.test.ts'] })],
    ['covers no longer includes the file', () => ({ entry: { ...ENTRY, covers: ['apps/api/**'] } })],
    ['the candidate moved', (r) => { put(r.dir, 'docs/x.md', 'x'); return {}; }],
    ['an invalid base', () => ({ baseSha: 'HEAD' })],
  ];
  for (const [why, perturb] of contexts) {
    const r = repo(t), rec = good(r), o = perturb(r);
    const entry = o.entry ?? ENTRY, args = o.args ?? ARGS, ex = o.exclusions ?? [], base = o.baseSha ?? r.base, cmd = o.cmd ?? ENTRY.cmd;
    const ru = recordUsable(rec, { ...cur(r, { entry, args }), baseSha: base, exclusions: ex, command: { cmd, args } });
    const v = tkVerdict({ ...view(r, rec, { entry, args, exclusions: ex }), baseSha: base, commands: { unit: { cmd, args } } }, 'F1');
    const state = agree(ru, v, why);
    if (cmd !== ENTRY.cmd) continue; // the builder has no separate cmd input: it runs the entry's own
    const before = evidenceIdentity({ repo: r.dir, baseSha: base, exclusions: ex }).evidence_id;
    const b = buildRecord({ repo: r.dir, baseSha: base, entry, commandArgs: args, tests: { globs: [] }, dagDigest: DAG, exclusions: ex, report: prov(passing(r.dir), { evidence_id_before: before }) });
    if (state.startsWith('refused:')) assert.deepEqual(b, { ok: false, code: state.slice(8) }, `${why}: the builder refuses the same candidate`);
    else { assert.equal(b.ok, true, `${why}: ${JSON.stringify(b)}`); assert.equal(recordUsable(b.record, { ...cur(r, { entry, args }), exclusions: ex }).ok, true, `${why}: a fresh record is current`); }
  }
  // (4) record perturbations (C5 and the schema): recordUsable and the verdict agree on every one
  const r = repo(t), rec = good(r);
  const muts = [(c) => { c.counts.passed = 0; }, (c) => { c.report_len = 0; }, (c) => { c.runner.version = ''; }, (c) => { c.files[0].credited = ['kind:race']; }, (c) => { c.integrity.sealed = false; },
    (c) => { c.dag_digest = 'e'.repeat(64); }, (c) => { c.files[0].skipped = { 'kind:negative': 1 }; }, (c) => { c.evidence_id = `e1:${'0'.repeat(64)}`; }, () => {}];
  for (const m of muts) { const c = clone(rec); m(c); agree(recordUsable(c, cur(r)), verdict(r, c), m.toString()); }
});

// ---- round 3: the Codex and Opus confirmation findings at dc41c69, each written RED before its fix ----
/** A seeded PRNG (mulberry32): the property corpus is the same on every run and every platform. */
const prng = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
const IDS = ['kind:negative', 'kind:race', 'plan:Item1', 'kind:zz', null];
/**
 * An INDEPENDENT oracle (it shares no code with the module): from the base and candidate test lists and the report it computes
 * the rows the record must hold. d(f, m) = cand - base - skipped; the total over P is the plain sum of d (owner amendment 2).
 * A passed creditable id: credited when d > 0 and the total > 0; withheld `r3_unchanged` when d <= 0, else `r3_offset`.
 */
function oracle(files) {
  const occ = (tests, m, pred = () => true) => tests.filter((x) => x.id === m && pred(x)).length;
  const creditableIds = IDS.slice(0, 3), d = (f, m) => occ(f.cand ?? [], m) - occ(f.base ?? [], m) - occ(f.cand ?? [], m, (x) => x.status !== 'passed');
  const total = Object.fromEntries(creditableIds.map((m) => [m, files.reduce((s, f) => s + d(f, m), 0)]));
  const rows = [];
  for (const f of files) {
    if (!f.cand || !f.cand.some((x) => x.id)) continue;
    const passed = new Set(f.cand.filter((x) => x.status === 'passed' && x.id).map((x) => x.id));
    const row = { file: f.rel, outcome: 'counted', credited: [], withheld: {}, skipped: {}, unknown: passed.has('kind:zz') ? 1 : 0 };
    for (const m of creditableIds) {
      const s = occ(f.cand, m, (x) => x.status !== 'passed');
      if (s) row.skipped[m] = s;
      if (!passed.has(m)) continue;
      if (d(f, m) <= 0) row.withheld[m] = 'r3_unchanged'; else if (total[m] > 0) row.credited.push(m); else row.withheld[m] = 'r3_offset';
    }
    row.credited.sort();
    rows.push(row);
  }
  rows.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { rows, counts: { marker_files: rows.length, credited: rows.reduce((s, r) => s + r.credited.length, 0), unknown_markers: rows.reduce((s, r) => s + r.unknown, 0) } };
}
const line = (x) => `test('${x.title}', () => {});`;
/** A repo whose base holds `files[i].base` and whose candidate holds `files[i].cand` (absent: deleted); the report runs the candidate. */
function scenario(t, files) {
  const dir = tmp(t, 'p4r-prop-');
  git(dir, 'init', '-q', '-b', 'main'); put(dir, 'vitest.config.ts', 'export default {};\n'); put(dir, 'package-lock.json', '{}\n');
  for (const f of files) if (f.base) put(dir, f.rel, f.base.map(line).join('\n') + '\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const f of files) if (f.cand) put(dir, f.rel, f.cand.map(line).join('\n') + '\n'); else if (f.base) rmSync(join(dir, f.rel));
  const text = report(files.filter((f) => f.cand).map((f) => ({ file: join(dir, f.rel), cases: f.cand.map((x) => ({ title: x.title, status: x.status })) })));
  return { r: { dir, base }, text };
}
const rowsOf = (rec) => rec.files.map((f) => ({ file: f.file, outcome: f.outcome, credited: f.credited, withheld: f.withheld, skipped: f.skipped, unknown: f.unknown }));

test('[P4r-32] S1 (round 3, A): aggregates are DERIVED from the rows; an independent oracle agrees with every interface', (t) => {
  // (1) the Codex inputs: a stored total that disagrees with its rows is malformed; there is no stored result count left to forge
  const { r, text } = scenario(t, [{ rel: 'libs/money/a.test.ts', cand: [{ title: 'a [kind:negative]', status: 'passed', id: 'kind:negative' }] },
    { rel: 'libs/money/b.test.ts', cand: [{ title: 'b [kind:race]', status: 'passed', id: 'kind:race' }, { title: 's [kind:race]', status: 'skipped', id: 'kind:race' }] }]);
  const b = build(r, text);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(Object.keys(b.record.counts).sort(), ['credited', 'marker_files', 'unknown_markers'], 'only totals a row set determines');
  assert.equal(recordUsable(b.record, cur(r)).ok, true, 'the control');
  for (const [why, m] of [['counts.credited off by one', (c) => { c.counts.credited -= 1; }], ['counts.marker_files off by one', (c) => { c.counts.marker_files += 1; }],
    ['counts.unknown_markers disagrees with the rows', (c) => { c.counts.unknown_markers = 1; }], ['an old stored result count', (c) => { c.counts.passed = 1; }],
    ['an old stored result count (results)', (c) => { c.counts.results = 1; }], ['a row unknown count disagrees with the total', (c) => { c.files[0].unknown = 1; }]]) {
    const c = clone(b.record); m(c);
    assert.equal(agree(recordUsable(c, cur(r)), verdict(r, c), why), 'stale:malformed', why);
  }
  // (2) the property: a seeded corpus of base/candidate/report triples; the oracle's rows are the record's, and the record is current
  const rnd = prng(0x5eed), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const tests = (n, tag) => Array.from({ length: n }, (_, i) => { const id = pick(IDS); return { title: `${tag}${i}${id ? ` [${id}]` : ''}`, status: pick(['passed', 'passed', 'skipped', 'todo']), id }; });
  for (let k = 0; k < 24; k++) {
    const files = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => {
      const kind = pick(['new', 'edited', 'deleted', 'unchanged-reported']), base = kind === 'new' ? null : tests(Math.floor(rnd() * 3), `b${i}x`).map((x) => ({ ...x, status: 'passed' }));
      return { rel: `libs/money/g${i}.test.ts`, base, cand: kind === 'deleted' ? null : kind === 'unchanged-reported' ? base : tests(1 + Math.floor(rnd() * 3), `c${i}x`) };
    }).filter((f) => f.base || f.cand);
    const { r: rr, text: tx } = scenario(t, files), want = oracle(files.filter((f) => !(f.cand && f.base && f.cand === f.base)));
    const got = build(rr, tx), why = `case ${k}: ${JSON.stringify(files)}`;
    assert.equal(got.ok, true, `${why}: ${JSON.stringify(got)}`);
    // an unchanged file is not in P: its row is a not_in_P void that neither credits nor subtracts
    const unchanged = files.filter((f) => f.cand && f.cand === f.base && f.cand.some((x) => x.id)).map((f) => ({ file: f.rel, outcome: 'not_in_P', credited: [], withheld: {}, skipped: {}, unknown: 0 }));
    assert.deepEqual(rowsOf(got.record), [...want.rows, ...unchanged].sort((a, b2) => (a.file < b2.file ? -1 : 1)), why);
    assert.deepEqual(got.record.counts, { ...want.counts, marker_files: want.counts.marker_files + unchanged.length }, why);
    const ru = recordUsable(got.record, cur(rr));
    assert.equal(agree(ru, verdict(rr, got.record), why), 'current', why);
    assert.deepEqual([...new Set([...ru.evidence.kinds.map((x) => `kind:${x}`), ...ru.evidence.items.map((x) => `plan:${x}`)])].sort(), [...new Set(want.rows.flatMap((x) => x.credited))].sort(), why);
    assert.equal(ru.evidence.unknown_markers, want.counts.unknown_markers, why);
  }
});

test('[P4r-33] S2 (round 3, B): ONE path identity: a case or normalisation alias of a git path is refused by every interface, on every platform', (t) => {
  // the Codex input: the changed config declared under another spelling
  for (const alias of ['VITEST.CONFIG.TS', 'Vitest.config.ts']) {
    const r = repo(t), entry = { ...ENTRY, config_paths: [alias] }, rec = good(r);
    put(r.dir, 'vitest.config.ts', 'export default { globalSetup: "./evil.ts" };\n');
    assert.equal(code(build(r, passing(r.dir), { entry })), 'runner_config_changed', alias);
    assert.equal(recordUsable(rec, cur(r, { entry })).code, 'runner_config_changed', alias);
    assert.equal(verdict(r, null, { entry }).code, 'runner_config_changed', alias);
  }
  // a NFD spelling of an NFC git path, and a config deleted in the candidate declared under an alias (realpath cannot see it)
  { const r = repo(t), nfc = 'libs/caf\u00e9.config.ts';
    put(r.dir, nfc, 'a\n'); git(r.dir, 'add', '-A'); git(r.dir, 'commit', '-q', '-m', 'cfg'); const base = git(r.dir, 'rev-parse', 'HEAD');
    put(r.dir, nfc, 'b\n');
    const entry = { ...ENTRY, config_paths: [nfc.normalize('NFD')] };
    assert.equal(verdict({ ...r, base }, null, { entry }).code, 'runner_config_changed', 'NFD alias'); }
  { const r = repo(t), entry = { ...ENTRY, config_paths: ['PACKAGE-LOCK.JSON'] };
    rmSync(join(r.dir, 'package-lock.json'));
    assert.equal(verdict(r, null, { entry }).code, 'runner_config_changed', 'a deleted config under an alias'); }
  // a config path reached through a symlinked directory tracked at base: the bytes it hashes are not the path's own
  { const r = repo(t);
    put(r.dir, 'real/vitest.config.ts', 'a\n'); symlinkSync('real', join(r.dir, 'cfg')); git(r.dir, 'add', '-A'); git(r.dir, 'commit', '-q', '-m', 'l');
    const base = git(r.dir, 'rev-parse', 'HEAD'), entry = { ...ENTRY, config_paths: ['cfg/vitest.config.ts'] };
    const v = verdict({ ...r, base }, null, { entry });
    assert.equal(v.status, 'refused', JSON.stringify(v)); assert.equal(v.code, 'evidence_unavailable', 'a symlinked directory on the way'); }
  // an exclusion spelled as an alias of a changed path, and two candidate paths that are one key (a case-only rename)
  { const r = repo(t);
    assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base, exclusions: ['LIBS/money'] }).code, 'evidence_unavailable', 'an aliased exclusion');
    assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base, exclusions: ['libs/money'] }).ok, true, 'the control: the exact spelling excludes');
    git(r.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/tmp.test.ts'); git(r.dir, 'mv', 'libs/money/tmp.test.ts', 'libs/money/OLD.test.ts');
    assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base }).code, 'evidence_unavailable', 'two spellings of one key in the candidate'); }
  // a stored row spelled as an alias of a P path is refused by both reuse interfaces with the same code
  { const r = repo(t), rec = good(r), c = clone(rec); c.files[0].file = 'libs/money/NEW.test.ts';
    assert.equal(agree(recordUsable(c, cur(r)), verdict(r, c), 'row alias'), 'refused:evidence_unavailable'); }
  // a skipped carrier reported under another case: it may not drop its subtraction (refused, or it subtracts; never a credit)
  { const r = repo(t), file = join(r.dir, 'libs/money/old.test.ts');
    rmSync(join(r.dir, 'libs/money/new.test.ts')); // the old file's added skip is the only change: with its subtraction, d = 2 - 1 - 1 = 0
    put(r.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\ntest.skip('s [kind:negative]', () => {});\n");
    const mk = (name) => build(r, report([{ file, cases: [{ title: 'old [kind:negative]' }] }, { file: join(r.dir, name), cases: [{ title: 's [kind:negative]', status: 'skipped' }] }]));
    assert.deepEqual(credits(mk('libs/money/old.test.ts')), [], 'the control: the carrier under git\'s spelling subtracts');
    const b = mk('libs/money/OLD.test.ts');
    if (b.ok) assert.deepEqual(credits(b), [], 'the aliased carrier still subtracts'); else assert.equal(b.code, 'evidence_unavailable'); }
});

const SUBMODULE = { ok: false, code: 'evidence_unavailable', detail: 'submodule_unsupported_v0' };
/** A repo with a submodule at vendor/s, committed at base or not; `then(r, inner)` breaks it one way. */
function withSubmodule(t, { atBase = false, nested = false } = {}) {
  const r = repo(t), sub = tmp(t, 'p4r-sub-');
  git(sub, 'init', '-q', '-b', 'main'); put(sub, 'a.txt', '1\n'); git(sub, 'add', '-A'); git(sub, 'commit', '-q', '-m', 's');
  if (nested) { const s2 = tmp(t, 'p4r-s2-'); git(s2, 'init', '-q', '-b', 'main'); put(s2, 'n.txt', 'n\n'); git(s2, 'add', '-A'); git(s2, 'commit', '-q', '-m', 'n'); git(sub, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', s2, 'nested'); git(sub, 'commit', '-q', '-m', 'n'); }
  git(r.dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/s');
  if (atBase) { git(r.dir, 'commit', '-q', '-m', 'sub'); r.base = git(r.dir, 'rev-parse', 'HEAD'); put(r.dir, 'libs/money/new.test.ts', `test('${TITLE} [kind:negative]', () => {});\n`); }
  return { r, inner: join(r.dir, 'vendor/s') };
}
test('[P4r-34] S3 (round 3, C): V0 has no submodule support: ANY gitlink, in P or outside it, however it is disguised, is a typed refusal', (t) => {
  const cases = [
    ['a clean submodule in P', {}, () => {}],
    ['a clean submodule outside P (committed at base)', { atBase: true }, () => {}],
    ['core.worktree redirected to a clean copy', {}, ({ r, inner }) => { const clean = tmp(t, 'p4r-clean-'); put(clean, 'a.txt', '1\n'); git(r.dir, 'config', '-f', join(r.dir, '.git/modules/vendor/s/config'), 'core.worktree', clean); put(r.dir, 'vendor/s/a.txt', 'EDIT\n'); void inner; }],
    ['the submodule .git removed (a plain directory now)', {}, ({ r, inner }) => { rmSync(join(inner, '.git')); put(r.dir, 'vendor/s/a.txt', 'EDIT\n'); }],
    ['the same outside P', { atBase: true }, ({ r, inner }) => { rmSync(join(inner, '.git')); put(r.dir, 'vendor/s/a.txt', 'EDIT\n'); }],
    ['a nested submodule', { nested: true }, () => {}],
    ['a hidden index flag inside the submodule', {}, ({ r, inner }) => { git(inner, 'update-index', '--skip-worktree', 'a.txt'); put(r.dir, 'vendor/s/a.txt', 'EDIT\n'); }],
    ['.gitmodules ignore=all', { atBase: true }, ({ r }) => { git(r.dir, 'config', '-f', '.gitmodules', 'submodule.vendor/s.ignore', 'all'); put(r.dir, 'vendor/s/a.txt', 'EDIT\n'); }],
    ['a gitlink removed from the index, its checkout still on disk', { atBase: true }, ({ r }) => { git(r.dir, 'rm', '-q', '--cached', 'vendor/s'); }],
    ['a submodule at base deleted outright in the candidate (only the base tree still has the gitlink)', { atBase: true }, ({ r }) => { git(r.dir, 'rm', '-q', '-f', 'vendor/s'); assert.ok(!existsSync(join(r.dir, 'vendor/s'))); }],
    ['a gitlink committed after base only, then removed from the index', {}, ({ r }) => { git(r.dir, 'commit', '-q', '-m', 'sub'); git(r.dir, 'rm', '-q', '--cached', 'vendor/s'); put(r.dir, 'vendor/s/a.txt', 'EDIT\n'); }],
  ];
  for (const [why, opts, breakIt] of cases) {
    const s = withSubmodule(t, opts); breakIt(s);
    const { r } = s, rec = clone(good(repo(t)));
    assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), SUBMODULE, why);
    assert.deepEqual(build(r, passing(r.dir), { before: 'e1:' + '0'.repeat(64) }), SUBMODULE, `${why}: the builder`);
    assert.deepEqual(recordUsable(rec, cur(r)), { ok: false, reason: 'unavailable', code: 'evidence_unavailable', detail: 'submodule_unsupported_v0' }, `${why}: recordUsable`);
    const v = verdict(r, rec);
    assert.equal(v.code, 'evidence_unavailable', why); assert.equal(v.detail, 'submodule_unsupported_v0', why);
  }
  // an untracked nested repository (a directory in P that git cannot list file by file) is refused too
  const r = repo(t), nest = join(r.dir, 'vendor/n');
  mkdirSync(nest, { recursive: true }); git(nest, 'init', '-q', '-b', 'main'); put(nest, 'x.txt', 'x\n'); git(nest, 'add', '-A'); git(nest, 'commit', '-q', '-m', 'x');
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base }).code, 'evidence_unavailable', 'an untracked nested repo');
});

test('[P4r-35] S4 (round 3, D): drive paths, parser-rejected reports and unexpected realpath errors are refused, never guessed', (t) => {
  const r = repo(t), e = readEntry(ENTRY);
  for (const p of ['C:/outside/a.test.ts', 'C:a.test.ts', 'c:libs/a.test.ts']) {
    assert.throws(() => commandFor(e, ENTRY.cmd, [...ARGS.slice(0, 4), p]), { code: 'runner_unsupported' }, p);
    assert.throws(() => readEntry({ ...ENTRY, config_paths: [p] }), { code: 'test_kinds_error' }, `config ${p}`);
    assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base, exclusions: [p] }).code, 'test_kinds_error', `exclusion ${p}`);
  }
  assert.doesNotThrow(() => commandFor(e, ENTRY.cmd, [...ARGS.slice(0, 4), 'libs/C:a.test.ts']), 'a colon later in a name is a POSIX name');
  // documents preflight accepts and the runner parser rejects: the guard after the parser is REACHABLE (no longer "equivalent")
  for (const extra of [{ ancestorTitles: {} }, { failureMessages: {} }]) {
    const doc = JSON.parse(passing(r.dir)); Object.assign(doc.testResults[0].assertionResults[0], extra);
    assert.equal(code(build(r, JSON.stringify(doc))), 'evidence_unavailable', JSON.stringify(extra));
  }
  // an unexpected realpath error (EACCES) on a report name is a refusal, not "outside the repo" (a dropped skipped carrier)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = join(r.dir, 'libs/locked');
    put(r.dir, 'libs/locked/s.test.ts', "test.skip('s [kind:negative]', () => {});\n");
    let b;
    chmodSync(locked, 0o000);
    try {
      const before = evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id; // the identity as the locked candidate stands
      assert.throws(() => realpathSync.native(join(locked, 's.test.ts')), { code: 'EACCES' }, 'the fixture really denies the lookup');
      b = build(r, report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }, { file: join(locked, 's.test.ts'), cases: [{ title: 's [kind:negative]', status: 'skipped' }] }]), { before });
    } finally { chmodSync(locked, 0o755); }
    assert.equal(code(b), 'evidence_unavailable');
  }
});

test('[P4r-36] R-3 amendment (owner 2026-11-18): the total over P is the plain sum, and every withheld credit names its reason', (t) => {
  const NEW = { title: 'n [kind:negative]', status: 'passed', id: 'kind:negative' }, OLD = { title: 'o [kind:negative]', status: 'passed', id: 'kind:negative' };
  const run = (files) => { const { r, text } = scenario(t, files); const b = build(r, text); assert.equal(b.ok, true, JSON.stringify(b)); return { r, b }; };
  const reasons = (b) => Object.assign({}, ...b.record.files.map((f) => f.withheld));
  // a NEW covered test with a marker: credited
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', cand: [NEW] }]);
    assert.deepEqual(credits(b), ['kind:negative']); assert.deepEqual(reasons(b), {});
    const v = verdict(r, b.record); assert.equal(v.status, 'pass'); assert.deepEqual(v.withheld, {}); }
  // REPLACEMENT: the test file rewritten in place, the same marker count: nothing added in that file
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', base: [OLD], cand: [NEW] }]);
    assert.deepEqual(credits(b), []); assert.deepEqual(reasons(b), { 'kind:negative': 'r3_unchanged' });
    const v = verdict(r, b.record); assert.equal(v.code, 'missing_test_kinds'); assert.deepEqual(v.withheld, { 'kind:negative': 'r3_unchanged' }); }
  // RELOCATION (git mv of a marked test): added in the new file, removed from the old: the total is 0
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', base: [OLD] }, { rel: 'libs/money/b.test.ts', cand: [OLD] }]);
    assert.deepEqual(credits(b), []); assert.deepEqual(reasons(b), { 'kind:negative': 'r3_offset' });
    const v = verdict(r, b.record); assert.equal(v.code, 'missing_test_kinds'); assert.deepEqual(v.withheld, { 'kind:negative': 'r3_offset' }); }
  // DELETE ONE, ADD ONE of the same kind: the same offset
  { const { b } = run([{ rel: 'libs/money/a.test.ts', base: [OLD] }, { rel: 'libs/money/b.test.ts', cand: [NEW] }]);
    assert.deepEqual(credits(b), []); assert.deepEqual(reasons(b), { 'kind:negative': 'r3_offset' }); }
  // DELETION alone: no passed result carries the marker, so nothing is credited or withheld; the verdict misses the kind
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', base: [OLD] }, { rel: 'libs/money/c.test.ts', cand: [{ title: 'plain', status: 'passed', id: null }] }]);
    assert.deepEqual(credits(b), []); assert.deepEqual(reasons(b), {});
    const v = verdict(r, b.record); assert.equal(v.code, 'missing_test_kinds'); assert.deepEqual(v.missing_kinds, ['negative']); assert.deepEqual(v.withheld, {}); }
  // the verdict lists an id once: credited anywhere, it is not withheld; withheld twice, `r3_offset` (the informative cause) wins
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', cand: [NEW] }, { rel: 'libs/money/b.test.ts', base: [OLD], cand: [{ ...NEW, title: 'b [kind:negative]' }] }]);
    assert.deepEqual(credits(b), ['kind:negative']); assert.deepEqual(reasons(b), { 'kind:negative': 'r3_unchanged' }, 'the row still says why b did not credit');
    const v = verdict(r, b.record); assert.equal(v.status, 'pass'); assert.deepEqual(v.withheld, {}, 'credited elsewhere'); }
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', cand: [OLD] }, { rel: 'libs/money/b.test.ts', base: [OLD], cand: [{ ...OLD, title: 'b [kind:negative]' }] }, { rel: 'libs/money/c.test.ts', base: [OLD] }]);
    assert.deepEqual(b.record.files.map((f) => f.withheld), [{ 'kind:negative': 'r3_offset' }, { 'kind:negative': 'r3_unchanged' }]);
    assert.deepEqual(verdict(r, b.record).withheld, { 'kind:negative': 'r3_offset' }); }
  // a withheld reason is RE-DERIVED on reuse: a stored reason the candidate does not support is stale
  { const { r, b } = run([{ rel: 'libs/money/a.test.ts', base: [OLD], cand: [NEW] }]);
    const c = clone(b.record); c.files[0].withheld = { 'kind:negative': 'r3_offset' };
    assert.equal(agree(recordUsable(c, cur(r)), verdict(r, c), 'wrong reason'), 'stale:applicability'); }
});

test('[P4r-11] AC3 (L6): hostile inputs are refused, never thrown, and no getter or proxy trap runs', (t) => {
  const r = repo(t);
  let ran = 0;
  const getter = { ...ENTRY }; Object.defineProperty(getter, 'covers', { get() { ran++; return ['libs/**']; }, enumerable: true });
  assert.equal(code(build(r, passing(r.dir), { entry: getter })), 'test_kinds_error');
  const trap = () => new Proxy({}, { get() { ran++; throw new Error('trap'); }, getOwnPropertyDescriptor() { ran++; throw new Error('trap'); }, ownKeys() { ran++; throw new Error('trap'); } });
  const proxy = new Proxy({ ...ENTRY }, { get() { ran++; throw new Error('trap'); }, getOwnPropertyDescriptor() { ran++; throw new Error('trap'); } });
  assert.equal(code(build(r, passing(r.dir), { entry: proxy })), 'test_kinds_error');
  assert.equal(code(build(r, passing(r.dir), { entry: { ...ENTRY, args: new Array(5) } })), 'test_kinds_error');
  assert.equal(code(build(r, passing(r.dir), { args: new Proxy([...ARGS], { get() { ran++; throw new Error('trap'); } }) })), 'test_kinds_error');
  const E = view(r, null);
  for (const E2 of [{ ...E, records: trap() }, { ...E, entries: 'x' }, null, 5, { ...E, bound: null }, { ...E, commands: trap() }]) assert.equal(tkVerdict(E2, 'F1').status, 'refused');
  // Codex m7: a proxy anywhere in a stored record is malformed, and its trap never runs (void rows included)
  const rec = good(r);
  for (const mut of [(c) => { c.files[0].credited = new Proxy(['kind:negative'], { get(o, k) { ran++; return Reflect.get(o, k); } }); },
    (c) => { c.files = [{ file: null, outcome: 'result_outside_repo', skipped: {}, credited: new Proxy(['kind:negative'], { get(o, k) { ran++; return Reflect.get(o, k); } }) }]; c.counts.marker_files = 1; },
    (c) => { c.files[0].skipped = trap(); }, (c) => { c.integrity = trap(); }, (c) => { c.files[0] = trap(); }]) {
    const c = clone(rec); mut(c);
    assert.deepEqual(verdict(r, c).records, { unit: 'stale:malformed' });
  }
  assert.deepEqual(verdict(r, trap()).records, { unit: 'stale:malformed' });
  assert.equal(ran, 0, 'no getter and no trap was invoked');
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: 'HEAD' }).code, 'test_kinds_error', 'the base must be a full commit id');
  const g2 = { repo: r.dir }; Object.defineProperty(g2, 'baseSha', { get() { ran++; return r.base; }, enumerable: true });
  for (const bad of [null, undefined, 5, g2, trap()]) assert.deepEqual(evidenceIdentity(bad), { ok: false, code: 'test_kinds_error' });
  assert.equal(evidenceIdentity({ repo: join(r.dir, 'nope'), baseSha: r.base }).ok, false);
});

test('[P4r-12] AC3 (L6): a fifo in the candidate is refused, not read (a read would block)', { skip: process.platform === 'win32' }, (t) => {
  const r = repo(t);
  rmSync(join(r.dir, 'libs/money/old.test.ts')); // a tracked file replaced by a fifo is in P (git sees the type change)
  execFileSync('mkfifo', [join(r.dir, 'libs/money/old.test.ts')]);
  const id = evidenceIdentity({ repo: r.dir, baseSha: r.base });
  assert.equal(id.ok, false);
  assert.equal(id.code, 'evidence_unavailable');
});

test('[P4r-13] AC4: P2 input and P6 waivers give a verdict through the REAL kindsForClasses: added classes, protection, trusted and untrusted waivers', (t) => {
  const r = repo(t), rec = good(r), id = rec.evidence_id;
  const waiver = (requirement, over = {}) => JSON.stringify({ event: 'TEST_KIND_WAIVER', run_id: S0.run_id, requirement, candidate: id, plan_digest: S0.plan_digest, authorized_by: 'owner', reason: 'r', ...over });
  const withAuth = (trusted = [], untrusted = []) => ({ ...S0, authority: { through: 0, trusted, untrusted: untrusted.map((line) => ({ line, seq: 1 })) } });
  // required kind `race` is not in the evidence (only negative): refused, and the reassessed class `async-state` ADDS kinds through P3's real mapping
  const refused = verdict(r, rec, { bound: RACE });
  assert.equal(refused.code, 'missing_test_kinds'); assert.deepEqual(refused.missing_kinds, ['race']);
  const added = verdict(r, rec, { bound: NEG, reassessed: ['async-state'] });
  assert.deepEqual(added.missing_kinds, ['error-twin', 'stale-N2']);
  assert.equal(added.counts.added_kinds, 2);
  assert.equal(verdict(r, rec, { bound: NEG, reassessed: ['no-such-class'] }).code, 'risk_class_unmapped');
  // a trusted waiver for the exact identity removes the non-protected kind and nothing else
  const waived = verdict(r, rec, { bound: RACE, S: withAuth([waiver('kind:race')]) });
  assert.equal(waived.status, 'pass', JSON.stringify(waived)); assert.deepEqual(waived.waived, ['kind:race']);
  // wrong identity, wrong run: ignored
  assert.equal(verdict(r, rec, { bound: RACE, S: withAuth([waiver('kind:race', { candidate: 'e1:other' })]) }).code, 'missing_test_kinds');
  assert.equal(verdict(r, rec, { bound: RACE, S: withAuth([waiver('kind:race', { run_id: 'run-9' })]) }).code, 'missing_test_kinds');
  // a protected kind is never waived, by a trusted line
  const money = verdict(r, rec, { bound: MONEY, S: withAuth([waiver('kind:race')]) });
  assert.equal(money.code, 'missing_test_kinds'); assert.deepEqual(money.missing_kinds, ['race']); assert.equal(money.counts.waiver_protected, 0, 'protected subjects are dropped by P6 before P2');
  // an untrusted (worker-written) waiver refuses
  assert.equal(verdict(r, rec, { bound: RACE, S: withAuth([], [waiver('kind:race')]) }).code, 'waiver_unauthorized');
  // a malformed state is P6's typed refusal, never a pass; a P2 input error is P2's own code and P6 is not consulted
  const broken = verdict(r, rec, { bound: RACE, S: { run_id: 'run-1' } });
  assert.equal(broken.status, 'refused'); assert.equal(broken.code, 'test_kinds_waiver_state_invalid');
  assert.equal(verdict(r, rec, { bound: { tags: 5 }, S: { run_id: 'run-1' } }).code, 'test_kinds_error');
  assert.equal(verdict(r, rec, { point: 'nowhere' }).code, 'test_kinds_error', 'the decision point is passed through, never fixed');
  // items: a credited `[plan:X]` satisfies a bound lifecycle item (and is not a kind)
  const r2 = repo(t); put(r2.dir, 'libs/money/new.test.ts', "test('i [plan:Item1]', () => {});\n");
  const rec2 = good(r2, passing(r2.dir, 'i [plan:Item1]'));
  assert.equal(verdict(r2, rec2, { bound: bound([], [], [], ['Item1']) }).status, 'pass');
  assert.deepEqual(verdict(r2, rec2, { bound: bound(['input-path'], [['negative', 'tag:input-path']], [], ['Item1']) }).missing_kinds, ['negative']);
});

test('[P4r-14] AC5: a config.base=HEAD commit changes evidence_id while the legacy candidate id does not move', (t) => {
  const r = repo(t); // the base IS the head here
  rmSync(join(r.dir, 'libs/money/new.test.ts'));
  const legacy = () => JSON.parse(execFileSync(process.execPath, [join(HERE, 'candidate-id.mjs'), '--repo', r.dir, '--base', 'HEAD'], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })).candidate_id;
  const l0 = legacy(), e0 = evidenceIdentity({ repo: r.dir, baseSha: r.base });
  put(r.dir, 'libs/money/new.test.ts', "test('n [kind:negative]', () => {});\n");
  git(r.dir, 'add', '-A'); git(r.dir, 'commit', '-q', '-m', 'edit');
  const l1 = legacy(), e1 = evidenceIdentity({ repo: r.dir, baseSha: r.base });
  assert.equal(l1, l0, 'the legacy id aliases: base=HEAD re-resolves to the new HEAD');
  assert.notEqual(e1.evidence_id, e0.evidence_id, 'the evidence id binds the pinned base_sha, so the committed edit moves it');
  assert.deepEqual(e1.paths, ['libs/money/new.test.ts']);
  // identity is deterministic, depends on the pinned base, and excludes only what it is told to
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, e1.evidence_id);
  put(r.dir, '.ship-ticket/state.json', '{}');
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, e1.evidence_id, '.ship-ticket/ is outside P');
  put(r.dir, 'docs/note.md', 'n');
  const e2 = evidenceIdentity({ repo: r.dir, baseSha: r.base });
  assert.notEqual(e2.evidence_id, e1.evidence_id);
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base, exclusions: ['docs'] }).evidence_id, e1.evidence_id);
  assert.match(e1.evidence_id, /^e1:[0-9a-f]{64}$/);
  // the same bytes under a different pinned base (an empty commit: identical trees, identical P) is another identity
  const baseA = git(r.dir, 'rev-parse', 'HEAD');
  git(r.dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
  const baseB = git(r.dir, 'rev-parse', 'HEAD');
  const same = evidenceIdentity({ repo: r.dir, baseSha: baseA }), other = evidenceIdentity({ repo: r.dir, baseSha: baseB });
  assert.notEqual(baseA, baseB);
  assert.deepEqual(other.paths, same.paths, 'identical trees give an identical P');
  assert.notEqual(other.evidence_id, same.evidence_id, 'base_sha is part of the identity');
  // the same bytes under another path name is another identity (the name is hashed, not only the content)
  const named = (rel) => { put(r.dir, rel, 'same\n'); const id = evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id; rmSync(join(r.dir, rel)); return id; };
  assert.notEqual(named('docs/a1.md'), named('docs/a2.md'));
  // same path set, same length, other bytes; and the exec bit alone
  const idBefore = evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id;
  put(r.dir, 'libs/money/new.test.ts', "test('m [kind:negative]', () => {});\n");
  const idBytes = evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id;
  assert.notEqual(idBytes, idBefore, 'file bytes are part of the identity');
  if (process.platform !== 'win32') {
    execFileSync('chmod', ['+x', join(r.dir, 'libs/money/new.test.ts')]);
    assert.notEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, idBytes, 'the exec bit is part of the identity');
  }
});

test('[P4r-15] AC6: no fixture test title appears in a record, a verdict, a void or a refusal', (t) => {
  const r = repo(t);
  const titles = ['SECRET-TITLE-zq9-pass', 'SECRET-TITLE-zq9-skip [kind:zzzz-skipped] [plan:9zzzz]', 'SECRET-TITLE-zq9-unknown [kind:zzzz-unknown]', 'SECRET-TITLE-zq9-suite'];
  put(r.dir, 'libs/money/new.test.ts', "test('SECRET-TITLE-zq9-pass [kind:negative]', () => {});\ntest('SECRET-TITLE-zq9-unknown [kind:zzzz-unknown]', () => {});\n");
  const file = join(r.dir, 'libs/money/new.test.ts');
  const text = report([{ file, cases: [{ title: `${titles[0]} [kind:negative]` }, { title: titles[1], status: 'skipped' }, { title: titles[2] }, { title: 'x', ancestors: [titles[3]] }] }]);
  const b = build(r, text);
  assert.deepEqual(credits(b), ['kind:negative']);
  assert.equal(b.record.counts.unknown_markers, 1, 'the unknown marker is a count');
  const v = verdict(r, b.record);
  assert.equal(v.counts.unknown_markers, 1, 'the verdict sums the record\'s unknown markers');
  const dump = JSON.stringify([b, v, verdict(r, null), build(r, text, { prov: { exit_code: 1 } }), build(r, report([{ file: join(r.dir, 'apps/web/ng.test.ts'), cases: [{ title: titles[0] }] }]))]);
  assert.ok(dump.includes('kind:negative'), 'the dump is not empty');
  assert.ok(dump.includes('libs/money/new.test.ts'), 'file names are state');
  assert.doesNotMatch(dump, /SECRET-TITLE|zq9|zzzz|forged input/, 'no title, and no non-creditable marker of a skipped title');
});

test('[P4r-16] AC1/AC6: a record round-trips through JSON (state), has exactly the schema keys, and is still read by the same rule', (t) => {
  const r = repo(t), rec = clone(good(r));
  assert.equal(verdict(r, rec).status, 'pass');
  assert.deepEqual(Object.keys(rec).sort(), ['attempt_id', 'base_sha', 'claim', 'command_digest', 'config_digest', 'counts', 'dag_digest', 'entry', 'evidence_id', 'exit_code', 'files', 'integrity', 'report_len', 'report_sha256', 'runner'].sort());
});

test('[P4r-18] I1: a stored record never vouches for itself: the complete schema, void rows never credit, applicability is re-derived', (t) => {
  const r = repo(t), rec = good(r);
  put(r.dir, 'libs/money/helper.ts', '// [kind:race]\n');
  symlinkSync(join(r.dir, 'libs/money/new.test.ts'), join(r.dir, 'libs/money/link.test.ts'));
  put(r.dir, 'apps/web/x.test.ts', "it('x', () => {});\n");
  const rec2 = good(r); // the same evidence on the candidate with the helper and the link
  const state = (mut, base = rec2) => { const c = clone(base); mut(c); return verdict(r, c).records.unit; };
  const row = (o) => (c) => { c.files = [{ file: null, outcome: 'result_outside_repo', credited: [], withheld: {}, skipped: {}, unknown: 0, ...o }]; c.counts.marker_files = 1; c.counts.credited = (o.credited ?? []).length; c.counts.unknown_markers = o.unknown ?? 0; };
  // Codex M1: every void outcome, and an invented one, with a credit: malformed, never a pass
  for (const outcome of [...FILE_VOIDS, 'invented', 'COUNTED']) {
    const file = outcome === 'result_outside_repo' ? null : 'libs/money/new.test.ts';
    assert.equal(state(row({ file, outcome, credited: ['kind:negative'] })), 'stale:malformed', outcome);
  }
  assert.equal(state(row({ file: 'libs/money/new.test.ts', outcome: 'invented' })), 'stale:malformed', 'an invented outcome, even with no credit');
  // a void row withholds nothing and counts no unknown marker either (each alone; the totals agree with the rows)
  assert.equal(state(row({ file: 'libs/money/helper.ts', outcome: 'not_test_file' })), 'current', 'the control: a bare void row');
  assert.equal(state(row({ file: 'libs/money/helper.ts', outcome: 'not_test_file', withheld: { 'kind:race': 'r3_offset' } })), 'stale:malformed', 'a void row withholds');
  assert.equal(state(row({ file: 'libs/money/helper.ts', outcome: 'not_test_file', unknown: 1 })), 'stale:malformed', 'a void row counts unknown markers');
  // schema: provenance fields, extra keys, ids, ordering, counts
  assert.equal(state((c) => { for (const k of ['attempt_id', 'report_sha256', 'report_len', 'runner', 'claim']) delete c[k]; }), 'stale:malformed');
  for (const k of ['attempt_id', 'report_sha256', 'report_len', 'runner', 'claim', 'counts', 'files', 'exit_code', 'command_digest']) assert.equal(state((c) => { delete c[k]; }), 'stale:malformed', k);
  for (const mut of [(c) => { c.extra = 1; }, (c) => { c.runner.extra = 1; }, (c) => { c.integrity.extra = true; }, (c) => { c.counts.extra = 0; }, (c) => { c.files[0].extra = 1; },
    (c) => { delete c.runner.format; }, (c) => { c.integrity.sealed = 'true'; }, (c) => { c.report_len = -1; }, (c) => { c.exit_code = '0'; }, (c) => { c.attempt_id = ''; },
    (c) => { c.files[0].credited = ['kind:not-a-kind']; }, (c) => { c.files[0].credited = ['plan:9x']; }, (c) => { c.files[0].credited = ['kind:negative', 'kind:negative']; c.counts.credited = 2; },
    (c) => { c.files[0].credited = 'kind:negative'; }, (c) => { c.counts.credited = 0; }, (c) => { c.counts.marker_files = 2; }, (c) => { c.counts.unknown_markers = -1; },
    (c) => { c.counts.unknown_markers = 1.5; }, (c) => { c.counts.passed = 1; }, (c) => { c.files[0].skipped = { 'kind:negative': 0 }; },
    (c) => { c.files[0].skipped = { 'not a marker': 1 }; }, (c) => { c.files[0].skipped = { 'kind:zzzz': 1 }; }, (c) => { c.files[0].skipped = []; },
    (c) => { c.files.push(clone(c.files[0])); c.counts.marker_files = 2; c.counts.credited = 2; },
    (c) => { delete c.files[0].withheld; }, (c) => { delete c.files[0].unknown; }, (c) => { c.files[0].withheld = { 'kind:race': 'nope' }; }, (c) => { c.files[0].withheld = { 'kind:zzzz': 'r3_offset' }; },
    (c) => { c.files[0].withheld = { 'kind:negative': 'r3_offset' }; }, (c) => { c.files[0].withheld = []; }, (c) => { c.files[0].unknown = -1; c.counts.unknown_markers = -1; },
    (c) => { c.files[0].unknown = LIMITS.maxIds + 1; c.counts.unknown_markers = LIMITS.maxIds + 1; }, (c) => { c.files[0].unknown = 0.5; c.counts.unknown_markers = 0.5; },
    (c) => { c.files[0].file = '../escape.test.ts'; }, (c) => { c.report_sha256 = 5; }, (c) => { c.report_sha256 = 'x'; }, (c) => { c.runner.version = 5; },
    (c) => { c.runner.version = ''; }, (c) => { c.runner.id = 5; }, (c) => { c.runner.format = ''; }, (c) => { c.dag_digest = 'D'.repeat(64); }, (c) => { c.config_digest = null; }, (c) => { c.base_sha = 'HEAD'; }, (c) => { c.entry = '-x'; },
    (c) => { c.claim = 5; }, (c) => { c.counts.unknown_markers = 1e9; }, (c) => { c.report_len = LIMITS.maxReportBytes + 1; }, (c) => { c.files[0].credited = ['kind:race', 'kind:negative']; c.counts.credited = 2; }, (c) => { c.files[0].file = null; }, (c) => { c.evidence_id = c.evidence_id.slice(3); }])
    assert.equal(state(mut), 'stale:malformed', mut.toString());
  // re-derived applicability (the record is otherwise well-formed): a file outside P, missing, not a test file, a symlink, a credit R-3 refuses
  const counted = (file, credited) => (c) => { c.files = [{ file, outcome: 'counted', credited, withheld: {}, skipped: {}, unknown: 0 }]; c.counts.marker_files = 1; c.counts.credited = credited.length; };
  for (const [file, credited, why] of [['libs/money/unchanged.test.ts', [], 'not in P, even with no credit'], ['libs/money/does-not-exist.test.ts', ['kind:negative'], 'missing'],
    ['libs/money/helper.ts', ['kind:race'], 'not a test file'], ['libs/money/link.test.ts', ['kind:negative'], 'a symlink'], ['libs/money/new.test.ts', ['kind:race'], 'R-3: no added race marker'],
    ['apps/web/x.test.ts', [], 'uncovered, even with no credit']])
    assert.equal(state(counted(file, credited)), 'stale:applicability', why);
  // the void rows of a well-formed record carry no credit, and a verdict over them is missing, never pass
  const voidOnly = verdict(r, (() => { const c = clone(rec2); row({ file: 'libs/money/helper.ts', outcome: 'not_test_file' })(c); return c; })());
  assert.equal(voidOnly.code, 'missing_test_kinds'); assert.deepEqual(voidOnly.records, { unit: 'current' });
  assert.equal(state(() => {}, rec2), 'current');
  // a regular file reached through a symlinked DIRECTORY of P is not the file the record names (a forged row; build resolves realpath)
  const r2 = repo(t);
  renameSync(join(r2.dir, 'libs/money'), join(r2.dir, 'libs/real')); symlinkSync('real', join(r2.dir, 'libs/money'), 'dir');
  put(r2.dir, 'libs/real/old.test.ts', "test('old [kind:negative]', () => {});\ntest('two [kind:negative]', () => {});\n");
  const recR2 = good(r2, report([{ file: join(r2.dir, 'libs/real/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }]));
  assert.equal(verdict(r2, recR2).status, 'pass', 'the control on this candidate');
  const forged = clone(recR2); forged.files = [{ file: 'libs/money/old.test.ts', outcome: 'counted', credited: ['kind:negative'], withheld: {}, skipped: {}, unknown: 0 }];
  assert.deepEqual(verdict(r2, forged).records, { unit: 'stale:applicability' });
  assert.equal(state(() => {}, rec), 'stale:identity', 'the candidate moved since the first record');
});

test('[P4r-19] I3 (R-3 over P): a rename or move, a skip/todo-only addition and a suite title credit nothing; a genuine addition still does', (t) => {
  const r = repo(t), dropNew = (x) => rmSync(join(x.dir, 'libs/money/new.test.ts')); // no other added marker in P
  dropNew(r);
  const one = (rel, cases) => build(r, report([{ file: join(r.dir, rel), cases }]));
  // a pure rename of a marked test (git mv, and a plain move with no staging)
  git(r.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/moved.test.ts');
  assert.deepEqual(credits(one('libs/money/moved.test.ts', [{ title: 'old [kind:negative]' }])), [], 'git mv');
  const r2 = repo(t); dropNew(r2);
  writeFileSync(join(r2.dir, 'libs/money/elsewhere.test.ts'), readFileSync(join(r2.dir, 'libs/money/old.test.ts'))); rmSync(join(r2.dir, 'libs/money/old.test.ts'));
  assert.deepEqual(credits(build(r2, report([{ file: join(r2.dir, 'libs/money/elsewhere.test.ts'), cases: [{ title: 'old [kind:negative]' }] }]))), [], 'plain move');
  // a skipped or todo test added beside an old passing one: the added marker is on a test that did not pass
  const r4 = repo(t);
  for (const status of ['skipped', 'todo', 'pending']) {
    put(r4.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\ntest.skip('new [kind:negative]', () => {});\n");
    const b = build(r4, report([{ file: join(r4.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'new [kind:negative]', status }] }]));
    assert.deepEqual(credits(b), [], status);
    assert.deepEqual(b.record.files[0].skipped, { 'kind:negative': 1 });
    // reuse subtracts the STORED skipped count: a record claiming the credit beside its own skipped carrier is refused
    const forged = clone(b.record); forged.files[0].credited = ['kind:negative']; forged.files[0].withheld = {}; forged.counts.credited = 1;
    assert.deepEqual(verdict(r4, forged).records, { unit: 'stale:applicability' }, status);
    assert.deepEqual(recordUsable(forged, cur(r4)), { ok: false, reason: 'applicability' }, status);
  }
  // NOT re-derivable (pinned; the reuse header says so): the same forgery with its skipped count deleted is consistent, and accepted
  { const b = build(r4, report([{ file: join(r4.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'new [kind:negative]', status: 'skipped' }] }]));
    const forged = clone(b.record); forged.files[0].credited = ['kind:negative']; forged.files[0].withheld = {}; forged.files[0].skipped = {}; forged.counts.credited = 1;
    assert.deepEqual(verdict(r4, forged).records, { unit: 'current' }, 'a consistent forgery of engine state is outside what reuse can see'); }
  // the same, with a genuine addition in ANOTHER reported file: the total over P allows it, the per-file rule refuses old.test.ts
  const b4 = build(r4, report([{ file: join(r4.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'new [kind:negative]', status: 'skipped' }] },
    { file: join(r4.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }]));
  assert.deepEqual(b4.record.files.map((f) => [f.file, f.credited]), [['libs/money/new.test.ts', ['kind:negative']], ['libs/money/old.test.ts', []]]);
  // a move plus a NEW skipped test in another reported file: the skipped carrier is subtracted over P, so the move credits nothing
  { const rs = repo(t); dropNew(rs);
    git(rs.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/moved.test.ts');
    put(rs.dir, 'libs/money/s.test.ts', "test.skip('s [kind:negative]', () => {});\n");
    assert.deepEqual(credits(build(rs, report([{ file: join(rs.dir, 'libs/money/moved.test.ts'), cases: [{ title: 'old [kind:negative]' }] }, { file: join(rs.dir, 'libs/money/s.test.ts'), cases: [{ title: 's [kind:negative]', status: 'skipped' }] }]))), []); }
  // a genuine new passing test next to a skipped one still credits (2 added, 1 skipped)
  const r5 = repo(t);
  put(r5.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\ntest('new [kind:negative]', () => {});\ntest.skip('s [kind:negative]', () => {});\n");
  assert.deepEqual(credits(build(r5, report([{ file: join(r5.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'new [kind:negative]' }, { title: 's [kind:negative]', status: 'skipped' }] }]))), ['kind:negative']);
  // a rename PLUS a skipped carrier in an uncovered changed file of P: the per-file rule passes, the total over P refuses
  const r6 = repo(t); dropNew(r6);
  git(r6.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/moved.test.ts');
  put(r6.dir, 'libs/money/moved.test.ts', "test('old [kind:negative]', () => {});\n");
  put(r6.dir, 'apps/web/skip.test.ts', "it.skip('k [kind:negative]', () => {});\n");
  const b6 = build(r6, report([{ file: join(r6.dir, 'libs/money/moved.test.ts'), cases: [{ title: 'old [kind:negative]' }] }, { file: join(r6.dir, 'apps/web/skip.test.ts'), cases: [{ title: 'k [kind:negative]', status: 'skipped' }] }]));
  assert.deepEqual(credits(b6), []);
  // NOT ENFORCED (owner amendment 2026-11-18: min(d, 0) REMOVED; the design's total over P): a move plus a marker planted
  // ANYWHERE in P credits the moved test, whether the marker is in a README, a helper, an uncovered test or an unreported test
  // file. It is the accepted visible-marker limit (header); round 2 had closed it with min(d, 0), which the owner withdrew.
  for (const [rel, text] of [['README.md', '<!-- [kind:negative] -->\n'], ['libs/money/helper.ts', '// [kind:negative]\n'], ['apps/web/w.test.ts', "it('w [kind:negative]', () => {});\n"],
    ['libs/money/unrun.test.ts', "test('u [kind:negative]', () => {});\n"]]) {
    const rm = repo(t); dropNew(rm);
    git(rm.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/moved.test.ts');
    const one = (x) => build(rm, report([{ file: join(rm.dir, 'libs/money/moved.test.ts'), cases: [{ title: 'old [kind:negative]' }] }]));
    assert.deepEqual(one().record.files[0].withheld, { 'kind:negative': 'r3_offset' }, `${rel}: the control, before the planted marker`);
    put(rm.dir, rel, text);
    assert.deepEqual(credits(one()), ['kind:negative'], rel);
  }
  // NOT ENFORCED (pinned, the accepted L-ran limit): a marker added in a comment of a file the runner reported (in K) credits a
  // moved test, as it does a test beside it (next case)
  { const rk = repo(t); dropNew(rk);
    git(rk.dir, 'mv', 'libs/money/old.test.ts', 'libs/money/moved.test.ts');
    put(rk.dir, 'libs/money/other.test.ts', "test('o [kind:race]', () => {});\n// [kind:negative]\n");
    const b = build(rk, report([{ file: join(rk.dir, 'libs/money/moved.test.ts'), cases: [{ title: 'old [kind:negative]' }] }, { file: join(rk.dir, 'libs/money/other.test.ts'), cases: [{ title: 'o [kind:race]' }] }]));
    assert.deepEqual(credits(b), ['kind:negative', 'kind:race'], 'a visible added marker in a reported file is NOT distinguished'); }
  // NOT ENFORCED (pinned, the accepted L-ran limit): a comment-only marker beside an old passing test credits it
  const r7 = repo(t);
  put(r7.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\n// TODO [kind:negative]\n");
  assert.deepEqual(credits(build(r7, report([{ file: join(r7.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }] }]))), ['kind:negative'], 'a visible added marker in a comment is NOT distinguished');
  // a skipped `.each` over-subtracts (fails closed): one source marker, three skipped titles, one passing new test
  const r8 = repo(t);
  put(r8.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\ntest('n [kind:negative]', () => {});\ntest.skip.each([1,2,3])('e %i [kind:negative]', () => {});\n");
  assert.deepEqual(credits(build(r8, report([{ file: join(r8.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'n [kind:negative]' }, ...[1, 2, 3].map((i) => ({ title: `e ${i} [kind:negative]`, status: 'skipped' }))] }]))), []);
});

test('[P4r-20] I4: a symlink target is part of the identity; a submodule, dirty or clean, is refused (V0, P4r-34)', (t) => {
  const { r } = withSubmodule(t);
  assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), SUBMODULE, 'clean');
  put(r.dir, 'vendor/s/a.txt', 'two\n');
  assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), SUBMODULE, 'dirty');
  // a symlink's target is hashed (retargeting it alone moves the identity)
  const r2 = repo(t);
  symlinkSync('a.ts', join(r2.dir, 'libs/money/l.ts'));
  const a = evidenceIdentity({ repo: r2.dir, baseSha: r2.base }).evidence_id;
  rmSync(join(r2.dir, 'libs/money/l.ts')); symlinkSync('b.ts', join(r2.dir, 'libs/money/l.ts'));
  assert.notEqual(evidenceIdentity({ repo: r2.dir, baseSha: r2.base }).evidence_id, a);
});

test('[P4r-21] I5: buildRecord and the verdict hash the SAME substituted command; a fresh record is current, not stale forever', (t) => {
  const r = repo(t);
  put(r.dir, 'libs/money/second.test.ts', "test('s [kind:race]', () => {});\n");
  const args = [...ARGS, 'libs/money/second.test.ts'];
  const b = build(r, report([{ file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: `${TITLE} [kind:negative]` }] }, { file: join(r.dir, 'libs/money/second.test.ts'), cases: [{ title: 's [kind:race]' }] }]), { args });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.record.command_digest, commandDigest(ENTRY.cmd, args));
  assert.deepEqual(verdict(r, b.record, { args, bound: MONEY }).records, { unit: 'current' });
  assert.equal(verdict(r, b.record, { args, bound: MONEY }).status, 'pass');
  assert.deepEqual(verdict(r, b.record, { args: ARGS }).records, { unit: 'stale:freshness' }, 'other files: another command');
  // the template without {files}: exactly the substituted fixed args
  const fixed = ARGS.slice(0, 4), noFiles = { ...ENTRY, args: ENTRY.args.slice(0, 4) };
  const b2 = build(r, passing(r.dir), { entry: noFiles, args: fixed });
  assert.deepEqual(verdict(r, b2.record, { entry: noFiles, args: fixed }).records, { unit: 'current' });
  // what may run is an exact instantiation: {report} is /dev/fd/3, {files} is 1..N safe repo paths none of which is a flag
  const e = readEntry(ENTRY);
  for (const bad of [ARGS.slice(0, 4), [...ARGS.slice(0, 3), '--outputFile={report}', 'libs/x.test.ts'], [...ARGS.slice(0, 3), '--outputFile=/tmp/r', 'libs/x.test.ts'],
    [...ARGS.slice(0, 4), '--typecheck'], [...ARGS.slice(0, 4), '-t'], [...ARGS.slice(0, 4), '../x.test.ts'], [...ARGS.slice(0, 4), '/abs/x.test.ts'], [...ARGS.slice(0, 4), 'a\\b.test.ts'], ['run', ...ARGS]])
    assert.throws(() => commandFor(e, ENTRY.cmd, bad), { code: 'runner_unsupported' }, JSON.stringify(bad));
  assert.throws(() => commandFor(readEntry(noFiles), ENTRY.cmd, ARGS), { code: 'runner_unsupported' }, 'files without {files}');
  assert.throws(() => commandFor(e, 'vitest', ARGS), { code: 'runner_unsupported' });
  assert.equal(code(build(r, passing(r.dir), { args: [...ARGS.slice(0, 4), '--bail'] })), 'runner_unsupported');
  assert.equal(verdict(r, b.record, { args: [...ARGS.slice(0, 4), '--bail'] }).code, 'runner_unsupported');
});

test('[P4r-22] I7 (L10): the path classification is the same under POSIX and win32 path rules', () => {
  const W = path.win32, X = path.posix;
  const matrix = [
    [W, 'C:\\repo', 'C:\\repo\\libs\\a.test.ts', 'libs/a.test.ts'], [W, 'C:\\repo', 'c:\\repo\\libs\\a.test.ts', 'libs/a.test.ts'], [W, 'C:\\repo', 'D:\\repo\\libs\\a.test.ts', null],
    [W, 'C:\\repo', 'C:\\repo\\..\\x\\a.test.ts', null], [W, 'C:\\repo', 'C:\\repo', null], [W, 'C:\\repo', 'libs\\a.test.ts', null], [W, 'C:\\repo', '\\\\server\\share\\a.test.ts', null],
    [W, 'C:\\repo', 'C:\\repository\\a.test.ts', null], [X, '/repo', '/repo/libs/a.test.ts', 'libs/a.test.ts'], [X, '/repo', '/repo', null], [X, '/repo', '/repo/../x/a.test.ts', null],
    [X, '/repo', 'libs/a.test.ts', null], [X, '/repo', 'C:\\repo\\libs\\new.test.ts', null], [X, '/repo', '/repository/a.test.ts', null], [X, '/repo', '/repo/..x/a.test.ts', '..x/a.test.ts'],
  ];
  for (const [P, root, file, want] of matrix) assert.equal(toRepoRel(root, file, P), want, `${P === W ? 'win32' : 'posix'} ${file}`);
});

// ---- module copies: CRLF (L10) and mutation (L1) ----
function closure(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import\()\s*'\.\/([^']+)'/g)) todo.push(m[1]);
  }
  return [...seen].sort();
}
function copyLayout(transform = (s) => s) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p4r-copy-')));
  const dir = join(root, 'skills', 'ship-ticket', 'scripts');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  for (const f of closure('engine-test-kinds-io.test.mjs')) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), transform(readFileSync(join(HERE, f), 'utf8'), f)); }
  if (existsSync(join(SKILLS, 'vapt'))) cpSync(join(SKILLS, 'vapt'), join(root, 'skills', 'vapt'), { recursive: true });
  cpSync(join(HERE, 'candidate-id.mjs'), join(dir, 'candidate-id.mjs'));
  return { root, dir };
}
const lf = (s) => s.replace(/\r\n/g, '\n');

test('[P4r-17] CRLF copy of every module in the closure gives the same verdict, record and identity (L10)', async (t) => {
  assert.ok(closure('engine-test-kinds-io.test.mjs').includes('engine-test-kinds-reuse.mjs'));
  const { root, dir } = copyLayout((s) => lf(s).replace(/\n/g, '\r\n'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(readFileSync(join(dir, 'engine-test-kinds-io.mjs'), 'utf8').includes('\r\n'), 'the copy really is CRLF');
  const crlf = await import(pathToFileURL(join(dir, 'engine-test-kinds-io.mjs')).href), crlfReuse = await import(pathToFileURL(join(dir, 'engine-test-kinds-reuse.mjs')).href);
  const r = repo(t), text = passing(r.dir), before = evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id;
  const mk = (m) => m.buildRecord({ repo: r.dir, baseSha: r.base, entry: ENTRY, commandArgs: ARGS, tests: { globs: [] }, dagDigest: DAG, report: prov(text, { evidence_id_before: before }) });
  const rec = mk(crlf);
  assert.equal(JSON.stringify(rec), JSON.stringify(mk({ buildRecord })));
  assert.equal(crlf.evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, before);
  assert.equal(JSON.stringify(crlfReuse.tkVerdict(view(r, rec.record), 'F1')), JSON.stringify(tkVerdict(view(r, rec.record), 'F1')));
});

// ---- mutation check (L1): a mutant counts as killed ONLY by an ERR_ASSERTION failure in the [P4r-n] test it names ----
// `file`: the patched module (base = limits, readers, report scan; io = the shared rules and the record; reuse = reuse and the verdict).
// `tag`: the test expected to kill it; it is the ONLY test run against that mutant, so a kill is attributed. `posix`: the killing test
// needs a POSIX facility (it is skipped on win32). Since round 2 a rule shared by the three interfaces (I-A) is ONE mutant, not one per copy.
// Documented EQUIVALENT (not listed, no input can observe them):
//   - `retry_authorised` forced to true: P4r passes `held: 0, open_repairs: 0` (inert in V0), and P2 reads it only when held > 0.
//   - `typeof r.title/r.file` in build: preflight has already refused every result without a string title or suite name
//     (defence in depth only). Round 3 withdrew the same claim for `if (!parsed.supported)`: a document preflight accepts can
//     still make the parser reject it (`ancestorTitles: {}`, `failureMessages: {}`), so that guard is a mutant killed by P4r-35.
//   - the early marker-file cap in build: it stops work early; without it `validRecord` refuses the same record with the same
//     code (`evidence_budget_exceeded`, from `arr` over `files`), so P4r-10 cannot tell them apart (I-B makes it redundant by design).
// Removed in round 3 with the code they mutated: the relations over the round 2 result counts (S1: the counts are gone, the
// remaining totals are compared with their rows), the submodule HEAD/dirty/hidden-flag mutants (S3: every gitlink is refused),
// and `min(d, 0)` -> `d` (owner amendment 2026-11-18: the total over P is the plain sum, so the mutant has no target).
const IO = 'engine-test-kinds-io.mjs', RE = 'engine-test-kinds-reuse.mjs', BA = 'engine-test-kinds-base.mjs';
const MUTANTS = [
  // reuse: the four conditions
  { file: RE, tag: 'P4r-2', name: 'identity: the evidence_id comparison is dropped', from: 'if (copy.evidence_id !== c.evidence_id || copy.base_sha !== c.base_sha)', to: 'if (copy.base_sha !== c.base_sha)' },
  { file: RE, tag: 'P4r-2', name: 'identity: the base_sha comparison is dropped', from: 'if (copy.evidence_id !== c.evidence_id || copy.base_sha !== c.base_sha)', to: 'if (copy.evidence_id !== c.evidence_id)' },
  { file: RE, tag: 'P4r-2', name: 'integrity: the flags are not checked', from: "if (!INTEGRITY.every((k) => copy.integrity[k] === true)) return { ok: false, reason: 'integrity' };", to: '' },
  { file: IO, tag: 'P4r-2', name: 'integrity: one flag is skipped', from: "export const INTEGRITY = Object.freeze(['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable']);", to: "export const INTEGRITY = Object.freeze(['sealed', 'report_eof', 'quiesced', 'binding_verified']);" },
  { file: RE, tag: 'P4r-2', name: 'integrity: a present flag counts as true', from: 'INTEGRITY.every((k) => copy.integrity[k] === true)', to: 'INTEGRITY.every((k) => copy.integrity[k] !== undefined)' },
  { file: RE, tag: 'P4r-2', name: 'applicability: a non-zero exit is accepted', from: "|| copy.exit_code !== 0 ||", to: '||' },
  { file: RE, tag: 'P4r-2', name: 'applicability: the entry name is not compared', from: 'if (copy.entry !== entry.name ||', to: 'if (' },
  { file: RE, tag: 'P4r-2', name: 'applicability: the runner id is not compared', from: 'copy.runner.id === RUNNER.id && ', to: '' },
  { file: RE, tag: 'P4r-2', name: 'applicability: the runner format is not compared', from: 'copy.runner.format === RUNNER.format && ', to: '' },
  { file: RE, tag: 'P4r-2', name: 'applicability: the claim is not compared', from: ' && copy.claim === CLAIM;', to: ';' },
  { file: IO, tag: 'P4r-2', name: 'applicability: covers is not re-derived', from: 'covers: matcher(entry.covers), command,', to: "covers: matcher(['**']), command," },
  { file: RE, tag: 'P4r-18', name: 'applicability: P membership is not re-derived', from: 'if (c.inP(f.file) === null || applicable(', to: 'if (applicable(' },
  { file: RE, tag: 'P4r-18', name: 'applicability: the file checks are not re-derived', from: "|| applicable(c.top, f.file, testGlobs, covers, ctx) !== null) return", to: ') return' },
  { file: RE, tag: 'P4r-18', name: 'applicability: R-3 is not re-derived', from: '      for (const m of f.credited) if (rule(f.file, m) !== \'credit\') return { ok: false, reason: \'applicability\' };\n', to: '' },
  { file: RE, tag: 'P4r-19', name: 'applicability: the STORED skipped counts are ignored on reuse (Opus survivor)', from: 'r3Rule(census(c), r3Inputs(copy.files, c.inP), ctx)', to: 'r3Rule(census(c), r3Inputs(copy.files.map((f) => ({ ...f, skipped: new Map() })), c.inP), ctx)' },
  { file: RE, tag: 'P4r-2', name: 'freshness: the dag digest is not compared', from: 'copy.dag_digest !== cur.dag_digest || ', to: '' },
  { file: RE, tag: 'P4r-2', name: 'freshness: the command digest is not compared', from: ' || copy.command_digest !== cur.command_digest', to: '' },
  { file: RE, tag: 'P4r-2', name: 'freshness: the config digest is not compared', from: " || copy.config_digest !== cur.config_digest) return { ok: false, reason: 'freshness' };", to: ") return { ok: false, reason: 'freshness' };" },
  // the record schema (I1), shared by build and reuse
  { file: IO, tag: 'P4r-18', name: 'schema: a void row may credit', from: 'if (outcome !== \'counted\' && (ids.length || withheld.size || unknown)) return null;', to: 'if (outcome !== \'counted\' && (withheld.size || unknown)) return null;' },
  { file: IO, tag: 'P4r-18', name: 'schema: credited ids are not validated', from: "arr(own(f, 'credited'), LIMITS.maxIds, creditable, ctx)", to: "arr(own(f, 'credited'), LIMITS.maxIds, (m) => typeof m === 'string', ctx)" },
  { file: IO, tag: 'P4r-18', name: 'schema: credited ids may repeat', from: '|| !sortedUnique(ids) ||', to: '||' },
  { file: IO, tag: 'P4r-18', name: 'schema: an invented outcome is accepted', from: "if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;", to: '' },
  { file: IO, tag: 'P4r-18', name: 'schema: extra or missing top-level keys are accepted', from: 'if (!exactKeys(R, TOP)) return null;', to: 'if (!plain(R)) return null;' },
  { file: IO, tag: 'P4r-18', name: 'schema: the runner keys are not exact', from: '!exactKeys(runner, RUNNER_KEYS) || ', to: '' },
  { file: IO, tag: 'P4r-18', name: 'schema: the row keys are not exact', from: 'if (!exactKeys(f, ROW)) return null;', to: '' },
  { file: IO, tag: 'P4r-28', name: 'S1: the stored totals are not compared with the rows', from: 'return COUNTS.every((k) => copy.counts[k] === sum[k]) ? copy : null;', to: 'return copy;' },
  { file: IO, tag: 'P4r-18', name: 'schema: a row unknown count is not validated', from: '!uint(unknown, LIMITS.maxIds)', to: '!Number.isFinite(unknown)' },
  { file: IO, tag: 'P4r-18', name: 'schema: duplicate file rows are accepted', from: 'if (file !== null && seen.has(file)) return null;', to: '' },
  { file: IO, tag: 'P4r-18', name: 'schema: skipped counts are not validated', from: '(v) => uint(v) && v > 0)', to: '(v) => typeof v === \'number\')' },
  { file: IO, tag: 'P4r-18', name: 'schema: skipped and withheld keys are not creditable ids', from: 'if (!creditable(k) || !ok(own(o, k))) return null;', to: 'if (!ok(own(o, k))) return null;' },
  { file: IO, tag: 'P4r-18', name: 'schema: a row file escaping the repo is accepted', from: "if (!(file === null ? outcome === 'result_outside_repo' : safeRel(file) && outcome !== 'result_outside_repo')) return null;", to: '' },
  { file: BA, tag: 'P4r-11', name: 'schema: a proxy record is read', from: "if (!plain(o)) return null;\n  const ks", to: "if (o === null || typeof o !== 'object') return null;\n  const ks" },
  { file: IO, tag: 'P4r-18', name: 'schema: digests are not typed', from: "['dag_digest', 'command_digest', 'config_digest', 'report_sha256'].every((k) => typeof copy[k] === 'string' && HEX64.test(copy[k]))", to: "['dag_digest', 'command_digest', 'config_digest'].every((k) => typeof copy[k] === 'string' && HEX64.test(copy[k]))" },
  { file: IO, tag: 'P4r-18', name: 'schema: the runner id and format are not typed', from: 'str(copy.runner.id, 64) && str(copy.runner.format, 64) && ', to: '' },
  { file: IO, tag: 'P4r-9', name: 'schema: the runner version is free text (Opus minor)', from: "typeof copy.runner.version === 'string' && RUNNER_VERSION.test(copy.runner.version)", to: 'str(copy.runner.version, 64)' },
  { file: IO, tag: 'P4r-18', name: 'schema: report_len is not bounded', from: 'uint(copy.report_len, LIMITS.maxReportBytes)', to: 'uint(copy.report_len)' },
  { file: IO, tag: 'P4r-18', name: 'schema: the entry name is not typed', from: "typeof copy.entry === 'string' && ENTRY_NAME.test(copy.entry) && ", to: '' },
  { file: IO, tag: 'P4r-18', name: 'schema: the claim is not typed', from: ' && str(copy.claim, 16)', to: '' },
  // the provenance relations (I-D, C5)
  { file: IO, tag: 'P4r-28', name: 'relations: report_len 0 is accepted', from: ' && copy.report_len >= 1 && ', to: ' && ' },
  { file: IO, tag: 'P4r-28', name: 'relations: a skipped carrier may sit on a row outside P', from: '    if (skipped.size && [\'not_in_P\', \'result_outside_repo\'].includes(outcome)) return null;\n', to: '' },
  { file: IO, tag: 'P4r-30', name: 'I-B: buildRecord does not pass its own output through the schema (C7)', from: "  if (!validRecord(record, ctx)) refuse('test_kinds_error'); // I-B: never emit a record reuse would reject (C7)", to: '' },
  // the current context (I-A, I-F), shared by the three interfaces
  { file: IO, tag: 'P4r-8', name: 'context: entries are not validated by readEntry', from: 'arr(own(input, \'entries\'), LIMITS.maxList, plain, ctx).map(readEntry);', to: "arr(own(input, 'entries'), LIMITS.maxList, plain, ctx).map((x) => ({ ...x }));" },
  { file: IO, tag: 'P4r-29', name: 'context: entry names may repeat', from: "if (new Set(entries.map((e) => e.name)).size !== entries.length) refuse('test_kinds_error');", to: '' },
  { file: IO, tag: 'P4r-21', name: 'context: the current command is not validated', from: "return { entry, command: commandFor(entry, own(raw, 'cmd'), own(raw, 'args')) };", to: "return { entry, command: { cmd: own(raw, 'cmd'), args: own(raw, 'args') } };" },
  { file: IO, tag: 'P4r-29', name: 'context: a missing command is accepted for an entry with a record', from: "if (raw === undefined) { if (needCommand(entry) !== false) refuse('test_kinds_error'); return { entry, command: null }; }", to: 'if (raw === undefined) return { entry, command: null };' },
  { file: RE, tag: 'P4r-29', name: 'verdict: an absent record skips its command validation (C6)', from: 'commandOf: (en) => (has(commands, en.name) ? own(commands, en.name) : undefined)', to: 'commandOf: (en) => (has(commands, en.name) && has(records, en.name) ? own(commands, en.name) : undefined)' },
  { file: RE, tag: 'P4r-29', name: 'verdict: no entry needs a command', from: 'needCommand: (en) => has(records, en.name)', to: 'needCommand: () => false' },
  { file: IO, tag: 'P4r-26', name: 'context: a config path in P does not refuse (C3)', from: '  if (entries.some((en) => en.config_paths.some((p) => c.inAll(p, \'runner_config_changed\') !== null))) refuse(\'runner_config_changed\');\n', to: '' },
  { file: IO, tag: 'P4r-7', name: 'context: config_paths are checked after the exclusions', from: 'c.inAll(p, \'runner_config_changed\')', to: 'c.inP(p, \'runner_config_changed\')' },
  { file: IO, tag: 'P4r-3', name: 'context: a config digest failure is ignored', from: '    if (!cd.ok) refuse(cd.code, cd.detail);\n    per.set', to: '    per.set' },
  { file: IO, tag: 'P4r-21', name: 'context: the declared args are hashed instead of the substituted ones', from: 'command_digest: command && commandDigest(command.cmd, command.args)', to: 'command_digest: command && commandDigest(entry.cmd, entry.args)' },
  // reuse: the verdict
  { file: RE, tag: 'P4r-2', name: 'verdict: a stale record is used as evidence', from: 'if (!u.ok) continue;', to: '' },
  { file: RE, tag: 'P4r-13', name: 'verdict: kind and plan routing swapped', from: 'for (const m of f.credited) (m.startsWith(\'kind:\') ? kinds : items)', to: 'for (const m of f.credited) (m.startsWith(\'plan:\') ? kinds : items)' },
  { file: RE, tag: 'P4r-15', name: 'verdict: unknown markers are not summed', from: 'unknown += u.evidence.unknown_markers;', to: '' },
  { file: RE, tag: 'P4r-13', name: 'verdict: waivers are matched to a fixed candidate instead of the evidence identity', from: 'testKindWaivers(S, c.evidence_id,', to: "testKindWaivers(S, 'fixed'," },
  { file: RE, tag: 'P4r-13', name: 'verdict: protected kinds are not handed to P6', from: 'protected: v0.protected_kinds.map((k) => `kind:${k}`)', to: 'protected: []' },
  { file: RE, tag: 'P4r-13', name: 'verdict: untrusted waivers are dropped', from: 'run({ trusted: w.waived, untrusted: w.unauthorized })', to: 'run({ trusted: w.waived, untrusted: [] })' },
  { file: RE, tag: 'P4r-13', name: 'verdict: reassessed classes are not passed on', from: "reassessed: own(E, 'reassessed')", to: 'reassessed: []' },
  { file: RE, tag: 'P4r-13', name: 'verdict: a P6 failure is ignored', from: 'if (!w.ok) return done(', to: 'if (false) return done(' },
  { file: RE, tag: 'P4r-13', name: 'verdict: a P2 input error falls through to P6', from: "if (['test_kinds_error', 'evidence_budget_exceeded'].includes(v0.code)) return done(v0);", to: '' },
  { file: RE, tag: 'P4r-13', name: 'verdict: the decision point is fixed to F1', from: 'state: { point,', to: "state: { point: 'F1'," },
  { file: RE, tag: 'P4r-7', name: 'verdict: uncovered counts covered files too', from: '&& !coverSets.some((cv) => matches(cv, p, ctx))) uncovered++;', to: ') uncovered++;' },
  // record: counting
  { file: IO, tag: 'P4r-4', name: 'counting: a skipped result counts', from: "if (r.status !== 'pass') { for (const [k, n] of countMarkers(r.title))", to: 'if (false) { for (const [k, n] of countMarkers(r.title))' },
  { file: IO, tag: 'P4r-15', name: 'counting: a non-creditable marker of a skipped title is stored', from: 'if (creditable(k)) slot.skipped.set(k,', to: 'slot.skipped.set(k,' },
  { file: BA, tag: 'P4r-4', name: 'report: a failed result is accepted', from: "      if (field(c, 'status') === 'failed') failed();", to: '' },
  { file: IO, tag: 'P4r-4', name: 'counting: the marker is read from the suite title too', from: 'const m = markers([r.title]);', to: 'const m = markers([r.title, ...(Array.isArray(r.suite_path) ? r.suite_path : [])]);' },
  { file: IO, tag: 'P4r-4', name: 'counting: an invalid item id is credited', from: '(ITEM_ID.test(i) ? slot.ids : slot.unknown)', to: 'slot.ids' },
  { file: IO, tag: 'P4r-4', name: 'counting: an unknown kind is credited', from: 'for (const u of m.unknown) slot.unknown.add(u);', to: 'for (const u of m.unknown) slot.ids.add(u);' },
  { file: BA, tag: 'P4r-24', name: 'C1: the title cap is dropped', from: "      if (field(c, 'title').length > LIMITS.maxTitleChars) refuse('evidence_budget_exceeded'); // I-C: refused, whatever the status (C1)", to: '' },
  { file: BA, tag: 'P4r-24', name: 'C1: the title cap applies to passed results only', from: "      if (field(c, 'title').length > LIMITS.maxTitleChars) refuse(", to: "      if (field(c, 'status') === 'passed' && field(c, 'title').length > LIMITS.maxTitleChars) refuse(" },
  { file: IO, tag: 'P4r-15', name: 'counting: unknown markers are not counted', from: 'unknown: row.unknown.size });', to: 'unknown: 0 });' },
  { file: IO, tag: 'P4r-5', name: 'R-3: the base count is dropped', from: 'n(cs.cand.get(p), m) - n(cs.base.get(p), m) - n(skipped.get(p), m);', to: 'n(cs.cand.get(p), m) - n(skipped.get(p), m);' },
  { file: IO, tag: 'P4r-5', name: 'R-3: equal counts credit', from: 'd(rel, m) <= 0 ? \'r3_unchanged\'', to: 'd(rel, m) < 0 ? \'r3_unchanged\'' },
  { file: IO, tag: 'P4r-19', name: 'R-3: the total over P is dropped (a rename credits)', from: 'n(total, m) > 0 ? \'credit\' : \'r3_offset\'', to: 'true ? \'credit\' : \'r3_offset\'' },
  { file: IO, tag: 'P4r-19', name: 'R-3: the skip subtraction is dropped', from: ' - n(skipped.get(p), m);', to: ';' },
  { file: IO, tag: 'P4r-19', name: 'R-3: base totals miss deleted paths', from: 'if (m && exact.has(p)) blobs.push([p, m[2]]);', to: 'if (m && exact.has(p) && existsSync(join(top, p))) blobs.push([p, m[2]]);', also: [["import { lstatSync, readFileSync,", "import { existsSync, lstatSync, readFileSync,"]] },
  // record: files (rule 3), names merging
  { file: IO, tag: 'P4r-5', name: 'file: a file outside P is counted', from: '  if (c.inP(rel) === null) return { outcome: \'not_in_P\', rel }; // an alias of a path in P is refused (S2)\n', to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: the test globs are not applied', from: "if (!matches(testGlobs, rel, ctx)) return 'not_test_file';", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: covers is not applied', from: "if (!matches(covers, rel, ctx)) return 'runner_uncovered';", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: a relative result name is resolved against the cwd', from: "if (!isAbsolute(file)) return { outcome: 'result_outside_repo', rel: null };", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: a non-regular file is counted', from: "if (!st.isFile()) return 'not_regular';", to: '' },
  { file: IO, tag: 'P4r-18', name: 'file: a symlinked path is counted on reuse', from: "try { if (realpathSync.native(join(top, rel)) !== join(top, rel)) return 'not_regular'; } catch { return 'not_regular'; }", to: '' },
  { file: IO, tag: 'P4r-5', name: 'file: the size cap is dropped', from: "if (st.size > LIMITS.maxFileBytes) return 'file_too_large';", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: realpath is not used', from: 'const real = realOrAncestor(file, ctx),', to: 'const real = file,' },
  { file: IO, tag: 'P4r-6', name: 'file: a missing file is classified without its real ancestor', from: "try { return join(realpathSync.native(dirname(at)), ...tail); }", to: 'try { return file; }' },
  { file: IO, tag: 'P4r-6', name: 'file: a link and its target are two rows', from: 'prev = v.rel === null ? null : byRel.get(v.rel);', to: 'prev = null;' },
  { file: IO, tag: 'P4r-27', name: 'C4: merged rows are not re-capped', from: '      capSlot(prev);\n      continue;', to: '      continue;' },
  { file: IO, tag: 'P4r-27', name: 'merge: the link\'s skipped carriers are dropped (Opus survivor)', from: '      for (const [k, n] of slot.skipped) prev.skipped.set(k, (prev.skipped.get(k) ?? 0) + n);\n', to: '' },
  { file: IO, tag: 'P4r-6', name: 'merge: a carrier outside P is kept on its row', from: '  for (const row of rows) if (row.file === null || c.inP(row.file) === null) row.skipped = new Map(); // a carrier outside P subtracts nothing\n', to: '' },
  // record: config, runner, provenance, budgets, scan
  { file: IO, tag: 'P4r-7', name: 'config: the path is not hashed', from: 'h.update(`${p}\\0`); h.update(st ?', to: 'h.update(st ?' },
  { file: IO, tag: 'P4r-7', name: 'config: a symlinked config is hashed through', from: "if (st && (!st.isFile() || st.size > LIMITS.maxConfigBytes)) refuse('evidence_unavailable');", to: '' },
  { file: IO, tag: 'P4r-7', name: 'config: a lockfile is held to the 4 MiB test-file cap (Opus minor)', from: 'st.size > LIMITS.maxConfigBytes', to: 'st.size > LIMITS.maxFileBytes' },
  { file: IO, tag: 'P4r-7', name: 'config: the config size is not capped', from: '(!st.isFile() || st.size > LIMITS.maxConfigBytes)', to: '(!st.isFile())' },
  { file: IO, tag: 'P4r-8', name: 'runner: another format is accepted', from: 'if (format !== RUNNER.format || cmd !== RUNNER.cmd)', to: 'if (cmd !== RUNNER.cmd)' },
  { file: IO, tag: 'P4r-8', name: 'runner: another cmd is accepted', from: 'if (format !== RUNNER.format || cmd !== RUNNER.cmd)', to: 'if (format !== RUNNER.format)' },
  { file: IO, tag: 'P4r-8', name: 'runner: the fixed args are not compared', from: 'if (!RUNNER.args.every((a, i) => args[i] === a) || ', to: 'if (' },
  { file: IO, tag: 'P4r-8', name: 'runner: extra args are accepted', from: '!(args.length === RUNNER.args.length || (hasFiles(args) && args[RUNNER.args.length] === RUNNER.files))', to: 'false' },
  { file: IO, tag: 'P4r-8', name: 'runner: the runner id is not checked', from: "if (prov.runner_id !== RUNNER.id) refuse('runner_unsupported');", to: '' },
  { file: IO, tag: 'P4r-21', name: 'command: a file argument may be a flag', from: "if (!files.every((f) => safeRel(f) && !f.startsWith('-'))) refuse('runner_unsupported');", to: '' },
  { file: IO, tag: 'P4r-21', name: 'command: {report} is not pinned', from: "if (!fixed.every((a, i) => list[i] === a)) refuse('runner_unsupported');", to: '' },
  { file: IO, tag: 'P4r-21', name: 'command: the {files} arity is not checked', from: "if (hasFiles(entry.args) ? !files.length : files.length) refuse('runner_unsupported');", to: '' },
  { file: IO, tag: 'P4r-9', name: 'provenance: the report digest is not compared', from: " || prov.report_sha256 !== digest) refuse('runner_output_tampered')", to: ") refuse('runner_output_tampered')" },
  { file: IO, tag: 'P4r-9', name: 'provenance: sealed is not checked', from: 'if (prov.sealed !== true || ', to: 'if (' },
  { file: IO, tag: 'P4r-9', name: 'provenance: the binding is not checked', from: 'prov.binding_verified !== true || ', to: '' },
  { file: IO, tag: 'P4r-9', name: 'provenance: the identity bracket is not compared', from: "if (prov.evidence_id_before !== c.evidence_id) refuse('candidate_moved');", to: '' },
  { file: IO, tag: 'P4r-9', name: 'provenance: a survivor is accepted', from: "if (prov.report_eof !== true) refuse('runner_survivor');", to: '' },
  { file: IO, tag: 'P4r-9', name: 'provenance: a non-quiescent group is accepted', from: "if (prov.quiesced !== true) refuse('quiescence_unknown');", to: '' },
  { file: IO, tag: 'P4r-9', name: 'provenance: the exit status is not checked', from: "if (prov.exit_code !== 0) refuse('evidence_run_failed');", to: '' },
  { file: IO, tag: 'P4r-9', name: 'provenance: a null exit (timeout) is accepted', from: "if (prov.exit_code !== 0) refuse('evidence_run_failed');", to: "if (prov.exit_code !== 0 && prov.exit_code !== null) refuse('evidence_run_failed');" },
  { file: BA, tag: 'P4r-4', name: 'report: success:false is accepted', from: 'if (!success) failed();', to: '' },
  { file: BA, tag: 'P4r-4', name: 'report: a failed suite is accepted', from: "if (field(s, 'status') === 'failed') failed();", to: '' },
  { file: BA, tag: 'P4r-4', name: 'report: a suite status other than passed is accepted (Opus untested branch)', from: "if (field(s, 'status') !== 'passed') unavailable();", to: '' },
  { file: BA, tag: 'P4r-4', name: 'report: an unknown result status is accepted', from: '!STATUSES.has(field(c, \'status\')) || ', to: '' },
  { file: BA, tag: 'P4r-4', name: 'report: the failed counters are not read', from: 'if (v > 0) failed(); }', to: '}' },
  { file: BA, tag: 'P4r-10', name: 'report: an invalid escape is an internal error (Opus minor)', from: "try { return JSON.parse(text); } catch { return refuse('evidence_unavailable'); }", to: 'return JSON.parse(text);' },
  { file: IO, tag: 'P4r-10', name: 'budget: the report is measured in UTF-16 units', from: 'if (bytes > LIMITS.maxReportBytes) refuse', to: 'if (text.length > LIMITS.maxReportBytes) refuse' },
  { file: IO, tag: 'P4r-10', name: 'budget: report_len is the character count', from: 'report_len: bytes,', to: 'report_len: text.length,' },
  { file: BA, tag: 'P4r-10', name: 'budget: the result count is not capped before parsing', from: "if (results > LIMITS.maxResults) refuse('evidence_budget_exceeded');", to: '' },
  { file: IO, tag: 'P4r-23', name: 'budget: the path count is not capped', from: "if (all.length > LIMITS.maxPaths) refuse('evidence_budget_exceeded');", to: '' },
  { file: IO, tag: 'P4r-23', name: 'budget: the identity bytes are not capped', from: "bytes += st.size; if (bytes > LIMITS.maxIdentityBytes) refuse('evidence_budget_exceeded');", to: 'bytes += st.size;' },
  { file: IO, tag: 'P4r-10', name: 'budget: the per-row creditable id cap is dropped', from: 'if (s.ids.size > LIMITS.maxIds || ', to: 'if (' },
  { file: IO, tag: 'P4r-27', name: 'budget: the per-row unknown id cap is dropped', from: ' || s.unknown.size > LIMITS.maxIds || ', to: ' || ' },
  { file: IO, tag: 'P4r-10', name: 'budget: the per-row skipped id cap is dropped', from: ' || s.skipped.size > LIMITS.maxIds) refuse', to: ') refuse' },
  { file: IO, tag: 'P4r-11', name: 'identity: the input is destructured (a getter runs)', from: "try { const c = candidate(own(input, 'repo'), own(input, 'baseSha'), ownOr(input, 'exclusions', []));", to: "const { repo, baseSha, exclusions = [] } = input ?? {}; try { const c = candidate(repo, baseSha, exclusions);" },
  { file: BA, tag: 'P4r-10', name: 'scan: duplicate keys are accepted', from: 'if (keys.has(key)) bad();', to: '' },
  { file: BA, tag: 'P4r-10', name: 'scan: escaped duplicate keys are not normalised', from: "if (key.includes('\\\\')) { try { key = JSON.parse(raw); } catch { bad(); } }", to: '' },
  { file: BA, tag: 'P4r-10', name: 'scan: depth is not capped', from: 'if (d > LIMITS.maxDepth) bad();', to: '' },
  // record: identity
  { file: IO, tag: 'P4r-14', name: 'identity: the pinned base is not hashed', from: 'h.update(`ship-ticket-tk-evidence-v1\\0${baseSha}\\0`);', to: 'h.update(`ship-ticket-tk-evidence-v1\\0`);' },
  { file: IO, tag: 'P4r-14', name: 'identity: the path names are not hashed (Opus survivor)', from: "h.update(Buffer.from(p, 'utf8')); ", to: '' },
  { file: IO, tag: 'P4r-14', name: 'identity: file bytes are not hashed', from: "h.update(content); h.update('\\0');", to: "h.update('\\0');" },
  { file: IO, tag: 'P4r-20', name: 'identity: a symlink target is not hashed', from: "content = readlinkSync(abs(p), { encoding: 'buffer' });", to: "content = Buffer.from('');" },
  { file: IO, tag: 'P4r-12', posix: true, name: 'identity: a fifo is read', from: "else refuse('evidence_unavailable'); // a fifo or device is never read (it could block)", to: "else { kind = 'other'; }" },
  // round 3 (S1-S4) and the owner R-3 amendment
  { file: IO, tag: 'P4r-18', name: 'schema: a void row may withhold', from: '(ids.length || withheld.size || unknown)', to: '(ids.length || unknown)' },
  { file: IO, tag: 'P4r-18', name: 'schema: a void row may count unknown markers', from: '(ids.length || withheld.size || unknown)', to: '(ids.length || withheld.size)' },
  { file: IO, tag: 'P4r-18', name: 'schema: a withheld reason is free text', from: '(v) => WITHHELD.includes(v)', to: '(v) => typeof v === \'string\'' },
  { file: IO, tag: 'P4r-28', name: 'schema: an id may be both credited and withheld', from: ' || ids.some((m) => withheld.has(m))', to: '' },
  { file: IO, tag: 'P4r-28', name: 'S1: marker_files is not compared with the rows', from: 'COUNTS.every((k) => copy.counts[k] === sum[k])', to: 'COUNTS.every((k) => k === \'marker_files\' || copy.counts[k] === sum[k])' },
  { file: IO, tag: 'P4r-28', name: 'S1: credited is not compared with the rows', from: 'COUNTS.every((k) => copy.counts[k] === sum[k])', to: 'COUNTS.every((k) => k === \'credited\' || copy.counts[k] === sum[k])' },
  { file: IO, tag: 'P4r-28', name: 'S1: unknown_markers is not compared with the rows', from: 'COUNTS.every((k) => copy.counts[k] === sum[k])', to: 'COUNTS.every((k) => k === \'unknown_markers\' || copy.counts[k] === sum[k])' },
  { file: IO, tag: 'P4r-36', name: 'R-3: the two withheld reasons are swapped', from: '? \'r3_unchanged\' : n(total', to: '? \'r3_offset\' : n(total' },
  { file: RE, tag: 'P4r-36', name: 'reuse: a withheld reason is not re-derived', from: '      for (const [m, why] of f.withheld) if (rule(f.file, m) !== why) return { ok: false, reason: \'applicability\' };\n', to: '' },
  { file: RE, tag: 'P4r-36', name: 'reuse: R-3 is re-derived only when a row credits', from: 'counted.some((f) => f.credited.length || f.withheld.size)', to: 'counted.some((f) => f.credited.length)' },
  { file: RE, tag: 'P4r-36', name: 'verdict: withheld reasons are not surfaced', from: '    for (const [m, why] of Object.entries(u.evidence.withheld)) if (withheld[m] !== \'r3_offset\') withheld[m] = why;\n', to: '' },
  { file: RE, tag: 'P4r-36', name: 'verdict: an id credited elsewhere is still listed as withheld', from: '  for (const m of Object.keys(withheld)) if ((m.startsWith(\'kind:\') ? kinds : items).has(m.slice(5))) delete withheld[m]; // credited elsewhere\n', to: '' },
  { file: RE, tag: 'P4r-36', name: 'reuse: r3_offset does not take precedence over r3_unchanged', from: 'for (const [m, why] of f.withheld) if (withheld[m] !== \'r3_offset\') withheld[m] = why;', to: 'for (const [m, why] of f.withheld) withheld[m] = why;' },
  { file: BA, tag: 'P4r-33', name: 'S2: an alias is treated as a different path', from: 'return q === undefined ? null : q === p ? p : refuse(code, \'path_alias\');', to: 'return q === p ? p : null;' },
  { file: BA, tag: 'P4r-33', name: 'S2: the key ignores Unicode normalisation', from: 'export const pathKey = (p) => p.normalize(\'NFC\').toLowerCase();', to: 'export const pathKey = (p) => p.toLowerCase();' },
  { file: BA, tag: 'P4r-33', name: 'S2: the key ignores case', from: 'export const pathKey = (p) => p.normalize(\'NFC\').toLowerCase();', to: 'export const pathKey = (p) => p.normalize(\'NFC\');' },
  { file: BA, tag: 'P4r-33', name: 'S2: two git paths with one key are accepted', from: 'if (byKey.has(k)) refuse(\'evidence_unavailable\', \'path_alias\'); ', to: '' },
  { file: BA, tag: 'P4r-33', name: 'S2: an aliased exclusion prefix is accepted', from: 'return k === d || k.startsWith(`${d}/`) ? refuse(\'evidence_unavailable\', \'path_alias\') : false;', to: 'return false;' },
  { file: IO, tag: 'P4r-33', name: 'S2: a config path may cross a symlinked directory', from: '      if (realOrAncestor(join(top, p), { work: 0, max: 1e6 }) !== join(top, p)) refuse(\'evidence_unavailable\'); // its own file: no symlinked directory, no alias\n', to: '' },
  { file: IO, tag: 'P4r-34', name: 'S3: a gitlink in the index is accepted', from: 'records(index).some(isGitlink) || ', to: '' },
  { file: IO, tag: 'P4r-34', name: 'S3: a gitlink at base is accepted', from: ' || treeRecs.some(isGitlink)', to: '' },
  { file: IO, tag: 'P4r-34', name: 'S3: a repository directory in P is hashed as a plain directory', from: '        try { lstatSync(join(abs(p), \'.git\')); refuse(\'evidence_unavailable\', SUBMODULE); } catch (e) { if (e?.code !== \'ENOENT\') throw e; }\n', to: '' },
  { file: IO, tag: 'P4r-34', name: 'S3: the refusal does not name its cause', from: 'refuse(\'evidence_unavailable\', SUBMODULE); // S3, before anything else reads it', to: 'refuse(\'evidence_unavailable\'); // S3, before anything else reads it' },
  { file: BA, tag: 'P4r-34', name: 'S3: a refusal detail is not returned', from: '...(e instanceof Refusal && e.detail ? { detail: e.detail } : {})', to: '...{}' },
  { file: BA, tag: 'P4r-35', name: 'S4: a drive-prefixed path is repo-relative', from: '|^[A-Za-z]:/.test(p)', to: '/.test(p)' },
  { file: IO, tag: 'P4r-35', name: 'S4: the parser guard is removed (it is reachable)', from: '  if (!parsed.supported) refuse(\'evidence_unavailable\'); // REACHABLE: preflight does not check every field the parser reads (P4r-35)\n', to: '' },
  { file: IO, tag: 'P4r-35', name: 'S4: an unexpected realpath error is "outside the repo"', from: 'const missing = (e) => (e?.code === \'ENOENT\' || e?.code === \'ENOTDIR\' ? null : refuse(\'evidence_unavailable\'));', to: 'const missing = () => null;', posix: true },
];
// one mutant runs ONE tagged test (3 min); the control runs all of them (about 4 min alone on a Windows runner, so 15 min)
const RUN_TIMEOUT_MS = 3 * 60 * 1000, CONTROL_TIMEOUT_MS = 15 * 60 * 1000;
const run = (args, cwd, timeoutMs = RUN_TIMEOUT_MS) => new Promise((resolve) => {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, out, timedOut }); });
});
/** Apply one mutant's edits to its module's LF text; every target must occur exactly once. */
function patch(mutant, text) {
  let s = text;
  for (const [from, to] of [[mutant.from, mutant.to], ...(mutant.also ?? [])]) {
    assert.equal(s.split(from).length, 2, `mutant "${mutant.name}": its target text occurs exactly once`);
    s = s.replace(from, () => to);
  }
  return s;
}
async function runMutant(t, mutant) {
  const { root, dir } = copyLayout((s, f) => (mutant && f === mutant.file ? patch(mutant, lf(s)) : s));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (mutant) {
    const load = await run(['--input-type=module', '-e', "await import('./engine-test-kinds-reuse.mjs')"], dir);
    if (load.code !== 0) return { invalid: true, tail: load.out.slice(-800) };
  }
  const pattern = mutant ? `\\[${mutant.tag}\\]` : '\\[P4r-\\d+\\]';
  const r = await run(['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, 'engine-test-kinds-io.test.mjs'], dir, mutant ? RUN_TIMEOUT_MS : CONTROL_TIMEOUT_MS);
  const blocks = r.out.split(/^(?=\s*(?:not )?ok \d+ - )/m).filter((b) => /^\s*not ok \d+ - /.test(b));
  const killers = blocks.filter((b) => /^\s*not ok \d+ - \[P4r-\d+\]/.test(b) && /code: '?ERR_ASSERTION'?/.test(b)).map((b) => /\[(P4r-\d+)\]/.exec(b)[1]);
  const passed = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  return { invalid: false, ...r, killers, passed, tail: r.out.slice(-1500) };
}
const uniq = (xs) => [...new Set(xs)].sort();

test('mutants: every target text occurs exactly once in the module it names, and each names a tagged test that exists (fast)', () => {
  const tags = new Set([...readFileSync(join(HERE, 'engine-test-kinds-io.test.mjs'), 'utf8').matchAll(/^test\('\[(P4r-\d+)\]/gm)].map((m) => m[1]));
  for (const m of MUTANTS) {
    assert.ok([IO, RE, BA].includes(m.file), m.name);
    patch(m, lf(readFileSync(join(HERE, m.file), 'utf8')));
    assert.ok(tags.has(m.tag), `${m.name}: [${m.tag}] exists`);
  }
});

test('mutation: the control passes every tagged test; every mutant loads and is killed by an assertion in the test it names', { timeout: 55 * 60 * 1000 }, async (t) => {
  assert.equal(new Set(MUTANTS.map((m) => m.name)).size, MUTANTS.length, 'mutant names are distinct');
  for (const m of MUTANTS) { assert.notEqual(m.from, m.to, m.name); assert.match(m.tag, /^P4r-\d+$/, m.name); }
  const live = MUTANTS.filter((m) => !(m.posix && process.platform === 'win32'));
  const control = await runMutant(t, null), mutants = []; // the control alone first: it is the long run
  for (let i = 0; i < live.length; i += 3) mutants.push(...await Promise.all(live.slice(i, i + 3).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  assert.equal(control.code, 0, `the control passes every tagged test (timed out: ${control.timedOut}):\n${control.tail}`);
  assert.ok(control.passed >= (process.platform === 'win32' ? 35 : 36), `the control ran the tagged tests (${control.passed}; P4r-12 is skipped on win32)`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: uniq(r.killers ?? []) }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.includes(r.m.tag)).map((r) => `${r.m.name} (exit ${r.code}, killers ${uniq(r.killers ?? [])})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure in the test it names');
  t.diagnostic(`mutants ${mutants.length} of ${MUTANTS.length} run (${MUTANTS.length - live.length} POSIX-only skipped on ${process.platform}), all killed by assertions`);
});
