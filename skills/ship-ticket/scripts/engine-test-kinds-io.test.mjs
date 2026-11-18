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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(rec.files, [{ file: 'libs/money/new.test.ts', outcome: 'counted', credited: ['kind:negative'], skipped: {} }]);
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
  assert.deepEqual(recordUsable(rec, cur(r)), { ok: true, evidence: { kinds: ['negative'], items: [], unknown_markers: 0 } });
  assert.deepEqual(recordUsable({ ...rec, dag_digest: 'e'.repeat(64) }, cur(r)), { ok: false, reason: 'freshness' });
  assert.deepEqual(recordUsable(rec, { ...cur(r), baseSha: 'HEAD' }), { ok: false, reason: 'unavailable', code: 'test_kinds_error' });
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
  // a status outside vitest's six is not evidence
  assert.equal(code(only({ title: 'p [kind:negative]', status: 'passed-ish' })), 'evidence_unavailable');
  assert.equal(verdict(r, null).code, 'missing_test_kinds');
  // markers: one `[plan:X]` (credited: its bytes are added), one unknown kind (counted, never credited), a malformed and an invalid item
  put(r.dir, 'libs/money/new.test.ts', "test('p [plan:Item1] [kind:not-a-kind] [kind:] [plan:9x]', () => {});\n");
  const res = only({ title: 'p [plan:Item1] [kind:not-a-kind] [kind:] [plan:9x]' });
  assert.deepEqual(credits(res), ['plan:Item1']);
  assert.equal(res.record.counts.unknown_markers, 2, 'kind:not-a-kind and plan:9x are unknown, never credited');
  // a title longer than the cap is not read at all
  const long = `${'x'.repeat(LIMITS.maxTitleChars)} [kind:negative]`;
  put(r.dir, 'libs/money/new.test.ts', `test('${long}', () => {});\n`);
  assert.deepEqual(credits(only({ title: long })), []);
});

test('[P4r-5] AC2 rule 5 (R-3): a marker counts only when the file holds MORE of it than at base; the base file of a new file is empty', (t) => {
  const r = repo(t);
  const old = join(r.dir, 'libs/money/old.test.ts');
  const one = (file, title) => { const b = build(r, report([{ file, cases: [{ title }] }])); assert.equal(b.ok, true, JSON.stringify(b)); return b.record; };
  // unchanged file: not in P, so a void (it cannot be evidence of THIS candidate)
  assert.equal(one(old, 'old [kind:negative]').files[0].outcome, 'not_in_P');
  // the file is edited but holds the SAME number of markers as at base: nothing is credited
  put(r.dir, 'libs/money/old.test.ts', "test('renamed [kind:negative]', () => { expect(1).toBe(1); });\n");
  assert.deepEqual(one(old, 'renamed [kind:negative]').files[0], { file: 'libs/money/old.test.ts', outcome: 'counted', credited: [], skipped: {} });
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
  const viaLink = build(r, report([{ file: join(r.dir, 'libs/money/link.test.ts'), cases: [{ title: 'x [kind:negative]' }] }, { file: join(r.dir, 'libs/money/new.test.ts'), cases: [{ title: 'y [kind:negative]' }] }]));
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
    { args: [...A, '{files}', '{files}'] }, { args: [...A, '{report}'] }, { args: [...A, 'libs/money/new.test.ts'] },
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
  ];
  for (const [over, want] of cases) assert.equal(code(build(r, text, { prov: over })), want, JSON.stringify(over));
  // a report that changed after it was sealed (forged text, original digest)
  assert.equal(code(build(r, text.replace('passed', 'passed ') /* not equal bytes */, { prov: { report_sha256: sha(text) } })), 'runner_output_tampered');
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
  const titles = ['SECRET-TITLE-zq9-pass', 'SECRET-TITLE-zq9-skip', 'SECRET-TITLE-zq9-unknown [kind:zzzz-unknown]', 'SECRET-TITLE-zq9-suite'];
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
  assert.doesNotMatch(dump, /SECRET-TITLE|zq9|zzzz-unknown|forged input/);
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
  const row = (o) => (c) => { c.files = [{ file: null, outcome: 'result_outside_repo', credited: [], skipped: {}, ...o }]; c.counts.marker_files = 1; c.counts.credited = (o.credited ?? []).length; };
  // Codex M1: every void outcome, and an invented one, with a credit: malformed, never a pass
  for (const outcome of [...FILE_VOIDS, 'invented', 'COUNTED']) {
    const file = outcome === 'result_outside_repo' ? null : 'libs/money/new.test.ts';
    assert.equal(state(row({ file, outcome, credited: ['kind:negative'] })), 'stale:malformed', outcome);
  }
  assert.equal(state(row({ file: 'libs/money/new.test.ts', outcome: 'invented' })), 'stale:malformed', 'an invented outcome, even with no credit');
  // schema: provenance fields, extra keys, ids, ordering, counts
  assert.equal(state((c) => { for (const k of ['attempt_id', 'report_sha256', 'report_len', 'runner', 'claim']) delete c[k]; }), 'stale:malformed');
  for (const k of ['attempt_id', 'report_sha256', 'report_len', 'runner', 'claim', 'counts', 'files', 'exit_code', 'command_digest']) assert.equal(state((c) => { delete c[k]; }), 'stale:malformed', k);
  for (const mut of [(c) => { c.extra = 1; }, (c) => { c.runner.extra = 1; }, (c) => { c.integrity.extra = true; }, (c) => { c.counts.extra = 0; }, (c) => { c.files[0].extra = 1; },
    (c) => { delete c.runner.format; }, (c) => { c.integrity.sealed = 'true'; }, (c) => { c.report_len = -1; }, (c) => { c.exit_code = '0'; }, (c) => { c.attempt_id = ''; },
    (c) => { c.files[0].credited = ['kind:not-a-kind']; }, (c) => { c.files[0].credited = ['plan:9x']; }, (c) => { c.files[0].credited = ['kind:negative', 'kind:negative']; c.counts.credited = 2; },
    (c) => { c.files[0].credited = 'kind:negative'; }, (c) => { c.counts.credited = 0; }, (c) => { c.counts.marker_files = 2; }, (c) => { c.counts.unknown_markers = -1; },
    (c) => { c.counts.unknown_markers = 1.5; }, (c) => { c.counts.passed = c.counts.results + 1; }, (c) => { c.files[0].skipped = { 'kind:negative': 0 }; },
    (c) => { c.files[0].skipped = { 'not a marker': 1 }; }, (c) => { c.files[0].skipped = []; }, (c) => { c.files.push(clone(c.files[0])); c.counts.marker_files = 2; c.counts.credited = 2; },
    (c) => { c.files[0].file = '../escape.test.ts'; }, (c) => { c.report_sha256 = 5; }, (c) => { c.report_sha256 = 'x'; }, (c) => { c.runner.version = 5; },
    (c) => { c.runner.version = ''; }, (c) => { c.dag_digest = 'D'.repeat(64); }, (c) => { c.config_digest = null; }, (c) => { c.base_sha = 'HEAD'; }, (c) => { c.entry = '-x'; },
    (c) => { c.claim = 5; }, (c) => { c.counts.results = 1e9; }, (c) => { c.report_len = LIMITS.maxReportBytes + 1; }, (c) => { c.files[0].credited = ['kind:race', 'kind:negative']; c.counts.credited = 2; }, (c) => { c.files[0].file = null; }, (c) => { c.evidence_id = c.evidence_id.slice(3); }])
    assert.equal(state(mut), 'stale:malformed', mut.toString());
  // re-derived applicability (the record is otherwise well-formed): a file outside P, missing, not a test file, a symlink, a credit R-3 refuses
  const counted = (file, credited) => (c) => { c.files = [{ file, outcome: 'counted', credited, skipped: {} }]; c.counts.marker_files = 1; c.counts.credited = credited.length; };
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
  const forged = clone(recR2); forged.files = [{ file: 'libs/money/old.test.ts', outcome: 'counted', credited: ['kind:negative'], skipped: {} }];
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
    assert.equal(verdict(r4, b.record).code, 'missing_test_kinds', 'the stored record re-derives the same refusal');
  }
  // the same, with an extra marker elsewhere in P (a helper comment): the total over P allows it, the per-file rule refuses
  put(r4.dir, 'libs/money/helper.ts', '// [kind:negative]\n');
  assert.deepEqual(credits(build(r4, report([{ file: join(r4.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'new [kind:negative]', status: 'skipped' }] }]))), []);
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
  // NOT ENFORCED (pinned, the accepted L-ran limit): a comment-only marker beside an old passing test credits it
  const r7 = repo(t);
  put(r7.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\n// TODO [kind:negative]\n");
  assert.deepEqual(credits(build(r7, report([{ file: join(r7.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }] }]))), ['kind:negative'], 'a visible added marker in a comment is NOT distinguished');
  // a skipped `.each` over-subtracts (fails closed): one source marker, three skipped titles, one passing new test
  const r8 = repo(t);
  put(r8.dir, 'libs/money/old.test.ts', "test('old [kind:negative]', () => {});\ntest('n [kind:negative]', () => {});\ntest.skip.each([1,2,3])('e %i [kind:negative]', () => {});\n");
  assert.deepEqual(credits(build(r8, report([{ file: join(r8.dir, 'libs/money/old.test.ts'), cases: [{ title: 'old [kind:negative]' }, { title: 'n [kind:negative]' }, ...[1, 2, 3].map((i) => ({ title: `e ${i} [kind:negative]`, status: 'skipped' }))] }]))), []);
});

test('[P4r-20] I4: a dirty submodule is refused; a submodule HEAD and a symlink target are part of the identity', (t) => {
  const r = repo(t), sub = tmp(t, 'p4r-sub-');
  git(sub, 'init', '-q', '-b', 'main'); put(sub, 'f.txt', 'one\n'); git(sub, 'add', '-A'); git(sub, 'commit', '-q', '-m', 's');
  git(r.dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  const clean = evidenceIdentity({ repo: r.dir, baseSha: r.base });
  assert.equal(clean.ok, true, JSON.stringify(clean)); assert.ok(clean.paths.includes('vendor/sub'));
  // the tracked worktree content changes, HEAD does not (Codex M3)
  put(r.dir, 'vendor/sub/f.txt', 'two\n');
  assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), { ok: false, code: 'evidence_unavailable' });
  git(join(r.dir, 'vendor/sub'), 'checkout', '-q', '--', 'f.txt');
  put(r.dir, 'vendor/sub/untracked.txt', 'u\n');
  assert.deepEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }), { ok: false, code: 'evidence_unavailable' }, 'an untracked file is dirty too');
  rmSync(join(r.dir, 'vendor/sub/untracked.txt'));
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, clean.evidence_id, 'clean again: the same identity');
  // a new submodule commit (clean) is a new identity
  put(r.dir, 'vendor/sub/f.txt', 'three\n'); git(join(r.dir, 'vendor/sub'), 'commit', '-q', '-am', 'c2');
  assert.notEqual(evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, clean.evidence_id);
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
// `file`: the patched module (io = the record side, reuse = the verdict side). `tag`: the test expected to kill it; it is the ONLY
// test run against that mutant, so a kill is attributed. `posix`: the killing test needs a POSIX facility (it is skipped on win32).
// Documented EQUIVALENT (not listed): `retry_authorised` forced to true. P4r passes `held: 0, open_repairs: 0` (inert in V0), and P2 reads
// retry_authorised only when held > 0, so no input can observe it (engine-test-kinds.mjs: `held > 0 && HELD_POINTS...`).
const IO = 'engine-test-kinds-io.mjs', RE = 'engine-test-kinds-reuse.mjs';
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
  { file: RE, tag: 'P4r-2', name: 'applicability: covers is not re-derived', from: 'const inP = new Set(c.paths), covers = matcher(entry.covers),', to: 'const inP = new Set(c.paths), covers = matcher([\'**\']),' },
  { file: RE, tag: 'P4r-18', name: 'applicability: P membership is not re-derived', from: 'if (!inP.has(f.file) || applicable(', to: 'if (applicable(' },
  { file: RE, tag: 'P4r-18', name: 'applicability: the file checks are not re-derived', from: "|| applicable(c.top, f.file, testGlobs, covers, ctx) !== null) return", to: ') return' },
  { file: RE, tag: 'P4r-18', name: 'applicability: R-3 is not re-derived', from: "if (!r3(cs, f.file, m, skipped)) return { ok: false, reason: 'applicability' };", to: '' },
  { file: RE, tag: 'P4r-2', name: 'freshness: the dag digest is not compared', from: 'copy.dag_digest !== cur.dag_digest || ', to: '' },
  { file: RE, tag: 'P4r-2', name: 'freshness: the command digest is not compared', from: ' || copy.command_digest !== cur.command_digest', to: '' },
  { file: RE, tag: 'P4r-2', name: 'freshness: the config digest is not compared', from: " || copy.config_digest !== cur.config_digest) return { ok: false, reason: 'freshness' };", to: ") return { ok: false, reason: 'freshness' };" },
  // reuse: the schema (I1)
  { file: RE, tag: 'P4r-18', name: 'schema: a void row may credit', from: "if ((outcome !== 'counted' && ids.length) || !sortedUnique(ids)) return null;", to: 'if (!sortedUnique(ids)) return null;' },
  { file: RE, tag: 'P4r-18', name: 'schema: credited ids are not validated', from: "arr(own(f, 'credited'), LIMITS.maxIds, creditable, ctx)", to: "arr(own(f, 'credited'), LIMITS.maxIds, (m) => typeof m === 'string', ctx)" },
  { file: RE, tag: 'P4r-18', name: 'schema: credited ids may repeat', from: '|| !sortedUnique(ids)) return null;', to: ') return null;' },
  { file: RE, tag: 'P4r-18', name: 'schema: an invented outcome is accepted', from: "if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;", to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: extra or missing top-level keys are accepted', from: 'if (!exactKeys(R, TOP)) return null;', to: 'if (!plain(R)) return null;' },
  { file: RE, tag: 'P4r-18', name: 'schema: the runner keys are not exact', from: '!exactKeys(runner, RUNNER_KEYS) || ', to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: the row keys are not exact', from: 'if (!exactKeys(f, ROW)) return null;', to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: the counts are not reconciled with the rows', from: 'if (copy.counts.marker_files !== copy.files.length || copy.counts.credited !== credited) return null;', to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: unknown_markers is not validated', from: 'COUNTS.every((k) => uint(copy.counts[k]))', to: "COUNTS.every((k) => k === 'unknown_markers' || uint(copy.counts[k]))" },
  { file: RE, tag: 'P4r-18', name: 'schema: duplicate file rows are accepted', from: 'if (file !== null && seen.has(file)) return null;', to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: skipped counts are not validated', from: 'if (!uint(n) || n === 0) return null;', to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: a row file escaping the repo is accepted', from: "if (!(file === null ? outcome === 'result_outside_repo' : safeRel(file) && outcome !== 'result_outside_repo')) return null;", to: '' },
  { file: IO, tag: 'P4r-11', name: 'schema: a proxy record is read', from: "if (!plain(o)) return null;\n  const ks", to: "if (o === null || typeof o !== 'object') return null;\n  const ks" },
  // reuse: the verdict
  { file: RE, tag: 'P4r-2', name: 'verdict: a stale record is used as evidence', from: 'if (!u.ok) continue;', to: '' },
  { file: RE, tag: 'P4r-13', name: 'verdict: kind and plan routing swapped', from: "(m.startsWith('kind:') ? kinds : items)", to: "(m.startsWith('plan:') ? kinds : items)" },
  { file: RE, tag: 'P4r-15', name: 'verdict: unknown markers are not summed', from: 'unknown += u.evidence.unknown_markers;', to: '' },
  { file: RE, tag: 'P4r-13', name: 'verdict: waivers are matched to a fixed candidate instead of the evidence identity', from: 'testKindWaivers(S, c.evidence_id,', to: "testKindWaivers(S, 'fixed'," },
  { file: RE, tag: 'P4r-13', name: 'verdict: protected kinds are not handed to P6', from: 'protected: v0.protected_kinds.map((k) => `kind:${k}`)', to: 'protected: []' },
  { file: RE, tag: 'P4r-13', name: 'verdict: untrusted waivers are dropped', from: 'run({ trusted: w.waived, untrusted: w.unauthorized })', to: 'run({ trusted: w.waived, untrusted: [] })' },
  { file: RE, tag: 'P4r-13', name: 'verdict: reassessed classes are not passed on', from: "reassessed: own(E, 'reassessed')", to: 'reassessed: []' },
  { file: RE, tag: 'P4r-13', name: 'verdict: a P6 failure is ignored', from: 'if (!w.ok) return done(', to: 'if (false) return done(' },
  { file: RE, tag: 'P4r-13', name: 'verdict: a P2 input error falls through to P6', from: "if (['test_kinds_error', 'evidence_budget_exceeded'].includes(v0.code)) return done(v0);", to: '' },
  { file: RE, tag: 'P4r-13', name: 'verdict: the decision point is fixed to F1', from: 'state: { point,', to: "state: { point: 'F1'," },
  { file: RE, tag: 'P4r-7', name: 'verdict: uncovered counts covered files too', from: '&& !coverSets.some((cv) => matches(cv, p, ctx))) uncovered++;', to: ') uncovered++;' },
  { file: RE, tag: 'P4r-7', name: 'verdict: a config path in P does not refuse', from: "if (entries.some((en) => en.config_paths.some((p) => all.has(p)))) refuse('runner_config_changed');", to: '' },
  { file: RE, tag: 'P4r-7', name: 'verdict: config_paths are checked after the exclusions', from: 'const all = new Set(c.all);\n  if (entries', to: 'const all = new Set(c.paths);\n  if (entries' },
  { file: RE, tag: 'P4r-7', name: 'verdict: a config digest failure is ignored', from: 'cd = configDigest(c.top, en.config_paths);\n    if (!cd.ok) refuse(cd.code);', to: 'cd = configDigest(c.top, en.config_paths);' },
  { file: RE, tag: 'P4r-8', name: 'verdict: entries are not validated by readEntry', from: '.map(readEntry); // runner_unsupported', to: '.map((x) => ({ ...x })); // runner_unsupported' },
  { file: RE, tag: 'P4r-21', name: 'verdict: the current command is not validated', from: 'command = commandFor(en, own(cmd, \'cmd\'), own(cmd, \'args\'))', to: "command = { cmd: own(cmd, 'cmd'), args: own(cmd, 'args') }" },
  // record: counting
  { file: IO, tag: 'P4r-4', name: 'counting: a skipped result counts', from: "if (r.status !== 'pass') { countMarkers(r.title, slot.skipped);", to: "if (false) { countMarkers(r.title, slot.skipped);" },
  { file: IO, tag: 'P4r-4', name: 'report: a failed result is accepted', from: "if (field(c, 'status') === 'failed') failed();", to: '' },
  { file: IO, tag: 'P4r-4', name: 'counting: the marker is read from the suite title too', from: 'const m = markers([r.title]);', to: 'const m = markers([r.title, ...(Array.isArray(r.suite_path) ? r.suite_path : [])]);' },
  { file: IO, tag: 'P4r-4', name: 'counting: an invalid item id is credited', from: '(ITEM_ID.test(i) ? slot.ids : slot.unknown)', to: 'slot.ids' },
  { file: IO, tag: 'P4r-4', name: 'counting: an unknown kind is credited', from: 'for (const u of m.unknown) slot.unknown.add(u);', to: 'for (const u of m.unknown) slot.ids.add(u);' },
  { file: IO, tag: 'P4r-4', name: 'counting: the title length cap is dropped', from: 'r.title.length > LIMITS.maxTitleChars || ', to: '' },
  { file: IO, tag: 'P4r-15', name: 'counting: unknown markers are not counted', from: 'unknownMarkers += slot.unknown.size; credited += ids.length;', to: 'credited += ids.length;' },
  { file: IO, tag: 'P4r-5', name: 'R-3: the per-file base count is dropped', from: "n(cs.cand.get(rel), m) - n(cs.base.get(rel), m) - n(skipped.get(rel), m) > 0", to: "n(cs.cand.get(rel), m) - n(skipped.get(rel), m) > 0" },
  { file: IO, tag: 'P4r-5', name: 'R-3: equal counts credit', from: "n(cs.cand.get(rel), m) - n(cs.base.get(rel), m) - n(skipped.get(rel), m) > 0", to: "n(cs.cand.get(rel), m) - n(cs.base.get(rel), m) - n(skipped.get(rel), m) >= 0" },
  { file: IO, tag: 'P4r-19', name: 'R-3: the total over P is dropped (a rename credits)', from: ' && n(cs.total.cand, m) - n(cs.total.base, m) - skipTotal > 0', to: '' },
  { file: IO, tag: 'P4r-19', name: 'R-3: the per-file skip subtraction is dropped', from: ' - n(skipped.get(rel), m) > 0', to: ' > 0' },
  { file: IO, tag: 'P4r-19', name: 'R-3: the skip subtraction over P is dropped', from: ' - skipTotal > 0', to: ' > 0' },
  { file: IO, tag: 'P4r-19', name: 'R-3: base totals miss deleted paths', from: 'if (m && want.has(m[3])) oids.push([m[3], m[2]]);', to: 'if (m && want.has(m[3]) && existsSync(join(c.top, m[3]))) oids.push([m[3], m[2]]);', also: [["import { lstatSync, readFileSync,", "import { existsSync, lstatSync, readFileSync,"]] },
  // record: files (rule 3)
  { file: IO, tag: 'P4r-5', name: 'file: a file outside P is counted', from: "if (!inP.has(rel)) return { outcome: 'not_in_P', rel };", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: the test globs are not applied', from: "if (!matches(testGlobs, rel, ctx)) return 'not_test_file';", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: covers is not applied', from: "if (!matches(covers, rel, ctx)) return 'runner_uncovered';", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: a relative result name is resolved against the cwd', from: "if (!isAbsolute(file)) return { outcome: 'result_outside_repo', rel: null };", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: a non-regular file is counted', from: "if (!st.isFile()) return 'not_regular';", to: '' },
  { file: IO, tag: 'P4r-18', name: 'file: a symlinked path is counted on reuse', from: "try { if (realpathSync.native(join(top, rel)) !== join(top, rel)) return 'not_regular'; } catch { return 'not_regular'; }", to: '' },
  { file: IO, tag: 'P4r-5', name: 'file: the size cap is dropped', from: "if (st.size > LIMITS.maxFileBytes) return 'file_too_large';", to: '' },
  { file: IO, tag: 'P4r-6', name: 'file: realpath is not used', from: 'const real = realOrAncestor(file, ctx),', to: 'const real = file,' },
  { file: IO, tag: 'P4r-6', name: 'file: a missing file is classified without its real ancestor', from: "try { return join(realpathSync.native(dirname(at)), ...tail); }", to: 'try { return file; }' },
  { file: IO, tag: 'P4r-6', name: 'file: a link and its target are two rows', from: 'prev = v.rel === null ? null : byRel.get(v.rel);', to: 'prev = null;' },
  // record: config, runner, provenance, budgets, scan
  { file: IO, tag: 'P4r-7', name: 'config: a config path in P does not refuse the record', from: "if (entry.config_paths.some((p) => all.has(p))) refuse('runner_config_changed');", to: '' },
  { file: IO, tag: 'P4r-7', name: 'config: config_paths are checked after the exclusions', from: 'const all = new Set(c.all), inP', to: 'const all = new Set(c.paths), inP' },
  { file: IO, tag: 'P4r-7', name: 'config: the path is not hashed', from: 'h.update(`${p}\\0`); h.update(st ?', to: 'h.update(st ?' },
  { file: IO, tag: 'P4r-7', name: 'config: a symlinked config is hashed through', from: "if (st && (!st.isFile() || st.size > LIMITS.maxFileBytes)) refuse('evidence_unavailable');", to: '' },
  { file: IO, tag: 'P4r-8', name: 'runner: another format is accepted', from: 'if (format !== RUNNER.format || cmd !== RUNNER.cmd)', to: 'if (cmd !== RUNNER.cmd)' },
  { file: IO, tag: 'P4r-8', name: 'runner: another cmd is accepted', from: 'if (format !== RUNNER.format || cmd !== RUNNER.cmd)', to: 'if (format !== RUNNER.format)' },
  { file: IO, tag: 'P4r-8', name: 'runner: the fixed args are not compared', from: 'if (!RUNNER.args.every((a, i) => args[i] === a) || ', to: 'if (' },
  { file: IO, tag: 'P4r-8', name: 'runner: extra args are accepted', from: '!(args.length === RUNNER.args.length || (hasFiles(args) && args[RUNNER.args.length] === RUNNER.files))', to: 'false' },
  { file: IO, tag: 'P4r-8', name: 'runner: the runner id is not checked', from: "if (prov.runner_id !== RUNNER.id) refuse('runner_unsupported');", to: '' },
  { file: IO, tag: 'P4r-21', name: 'command: buildRecord hashes the declared args', from: 'command_digest: commandDigest(command.cmd, command.args),', to: 'command_digest: commandDigest(entry.cmd, entry.args),' },
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
  { file: IO, tag: 'P4r-4', name: 'report: success:false is accepted', from: 'if (!success) failed();', to: '' },
  { file: IO, tag: 'P4r-4', name: 'report: a failed suite is accepted', from: "if (field(s, 'status') === 'failed') failed();", to: '' },
  { file: IO, tag: 'P4r-4', name: 'report: an unknown result status is accepted', from: '!STATUSES.has(field(c, \'status\')) || ', to: '' },
  { file: IO, tag: 'P4r-4', name: 'report: the failed counters are not read', from: 'if (v > 0) failed(); }', to: '}' },
  { file: IO, tag: 'P4r-10', name: 'budget: the report is measured in UTF-16 units', from: 'if (bytes > LIMITS.maxReportBytes) refuse', to: 'if (text.length > LIMITS.maxReportBytes) refuse' },
  { file: IO, tag: 'P4r-10', name: 'budget: report_len is the character count', from: 'report_len: bytes,', to: 'report_len: text.length,' },
  { file: IO, tag: 'P4r-10', name: 'budget: the result count is not capped before parsing', from: "if (results > LIMITS.maxResults) refuse('evidence_budget_exceeded');", to: '' },
  { file: IO, tag: 'P4r-10', name: 'budget: the marker-file count is not capped', from: "if (!byFile.has(r.file) && byFile.size >= LIMITS.maxMarkerFiles) refuse('evidence_budget_exceeded');", to: '' },
  { file: IO, tag: 'P4r-23', name: 'budget: the path count is not capped', from: "if (all.length > LIMITS.maxPaths) refuse('evidence_budget_exceeded');", to: '' },
  { file: IO, tag: 'P4r-23', name: 'budget: the identity bytes are not capped', from: "bytes += st.size; if (bytes > LIMITS.maxIdentityBytes) refuse('evidence_budget_exceeded');", to: 'bytes += st.size;' },
  { file: IO, tag: 'P4r-10', name: 'budget: the per-row creditable id cap is dropped', from: 'if (slot.ids.size > LIMITS.maxIds || slot.unknown.size > LIMITS.maxIds) refuse', to: 'if (slot.unknown.size > LIMITS.maxIds) refuse' },
  { file: IO, tag: 'P4r-10', name: 'budget: the per-row skipped id cap is dropped', from: "countMarkers(r.title, slot.skipped); if (slot.skipped.size > LIMITS.maxIds) refuse('evidence_budget_exceeded'); continue; }", to: 'countMarkers(r.title, slot.skipped); continue; }' },
  { file: IO, tag: 'P4r-11', name: 'identity: the input is destructured (a getter runs)', from: "try { const c = candidate(own(input, 'repo'), own(input, 'baseSha'), ownOr(input, 'exclusions', []));", to: "const { repo, baseSha, exclusions = [] } = input ?? {}; try { const c = candidate(repo, baseSha, exclusions);" },
  { file: RE, tag: 'P4r-18', name: 'schema: digests are not typed', from: "['dag_digest', 'command_digest', 'config_digest', 'report_sha256'].every((k) => typeof copy[k] === 'string' && HEX64.test(copy[k]))", to: "['dag_digest', 'command_digest', 'config_digest'].every((k) => typeof copy[k] === 'string' && HEX64.test(copy[k]))" },
  { file: RE, tag: 'P4r-18', name: 'schema: the runner fields are not typed', from: 'RUNNER_KEYS.every((k) => str(copy.runner[k], 64))', to: "['id', 'format'].every((k) => str(copy.runner[k], 64))" },
  { file: RE, tag: 'P4r-18', name: 'schema: report_len is not bounded', from: 'uint(copy.report_len, LIMITS.maxReportBytes)', to: 'uint(copy.report_len)' },
  { file: RE, tag: 'P4r-18', name: 'schema: the result count is not bounded', from: ' && copy.counts.results <= LIMITS.maxResults', to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: the entry name is not typed', from: "typeof copy.entry === 'string' && ENTRY_NAME.test(copy.entry) && ", to: '' },
  { file: RE, tag: 'P4r-18', name: 'schema: the claim is not typed', from: ' && str(copy.claim, 16)', to: '' },
  { file: IO, tag: 'P4r-10', name: 'scan: duplicate keys are accepted', from: 'if (keys.has(key)) bad();', to: '' },
  { file: IO, tag: 'P4r-10', name: 'scan: escaped duplicate keys are not normalised', from: "if (key.includes('\\\\')) { try { key = JSON.parse(raw); } catch { bad(); } }", to: '' },
  { file: IO, tag: 'P4r-10', name: 'scan: depth is not capped', from: 'if (d > LIMITS.maxDepth) bad();', to: '' },
  // record: identity
  { file: IO, tag: 'P4r-14', name: 'identity: the pinned base is not hashed', from: 'h.update(`ship-ticket-tk-evidence-v1\\0${baseSha}\\0`);', to: 'h.update(`ship-ticket-tk-evidence-v1\\0`);' },
  { file: IO, tag: 'P4r-14', name: 'identity: file bytes are not hashed', from: "h.update(content); h.update('\\0');", to: "h.update('\\0');" },
  { file: IO, tag: 'P4r-20', name: 'identity: a symlink target is not hashed', from: "content = readlinkSync(abs(p), { encoding: 'buffer' });", to: "content = Buffer.from('');" },
  { file: IO, tag: 'P4r-20', name: 'identity: a submodule HEAD is not hashed', from: "if (head) { kind = 'submodule'; mode = '160000'; content = head; }", to: "if (head) { kind = 'submodule'; mode = '160000'; content = Buffer.from(''); }" },
  { file: IO, tag: 'P4r-20', name: 'identity: a dirty submodule is accepted', from: "if (status.length) refuse('evidence_unavailable');", to: '' },
  { file: IO, tag: 'P4r-12', posix: true, name: 'identity: a fifo is read', from: "else refuse('evidence_unavailable'); // a fifo or device is never read (it could block)", to: "else { kind = 'other'; }" },
];
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
const run = (args, cwd) => new Promise((resolve) => {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
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
  const r = await run(['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, 'engine-test-kinds-io.test.mjs'], dir);
  const blocks = r.out.split(/^(?=\s*(?:not )?ok \d+ - )/m).filter((b) => /^\s*not ok \d+ - /.test(b));
  const killers = blocks.filter((b) => /^\s*not ok \d+ - \[P4r-\d+\]/.test(b) && /code: '?ERR_ASSERTION'?/.test(b)).map((b) => /\[(P4r-\d+)\]/.exec(b)[1]);
  const passed = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  return { invalid: false, ...r, killers, passed, tail: r.out.slice(-1500) };
}
const uniq = (xs) => [...new Set(xs)].sort();

test('mutation: the control passes every tagged test; every mutant loads and is killed by an assertion in the test it names', { timeout: 40 * 60 * 1000 }, async (t) => {
  assert.equal(new Set(MUTANTS.map((m) => m.name)).size, MUTANTS.length, 'mutant names are distinct');
  for (const m of MUTANTS) { assert.notEqual(m.from, m.to, m.name); assert.match(m.tag, /^P4r-\d+$/, m.name); }
  const live = MUTANTS.filter((m) => !(m.posix && process.platform === 'win32'));
  const jobs = [null, ...live], results = [];
  for (let i = 0; i < jobs.length; i += 3) results.push(...await Promise.all(jobs.slice(i, i + 3).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test:\n${control.tail}`);
  assert.ok(control.passed >= 23, `the control ran the tagged tests (${control.passed})`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: uniq(r.killers ?? []) }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.includes(r.m.tag)).map((r) => `${r.m.name} (exit ${r.code}, killers ${uniq(r.killers ?? [])})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure in the test it names');
  t.diagnostic(`mutants ${mutants.length} of ${MUTANTS.length} run (${MUTANTS.length - live.length} POSIX-only skipped on ${process.platform}), all killed by assertions`);
});
