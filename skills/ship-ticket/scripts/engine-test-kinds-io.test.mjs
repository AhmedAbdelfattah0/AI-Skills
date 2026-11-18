/**
 * S-01b2 P4r: runner evidence I/O (engine-test-kinds-io.mjs). Design rev 6 sections 1, 3, 4 and 5.2 (row P4r), owner decision OD-2.
 *
 * Claim level (L5/L12): these tests prove what the module believes of a report it is GIVEN (vitest JSON from a runner whose
 * result the caller says is sealed): an L-ran record, i.e. the runner executed a test whose own title carries the marker and
 * recorded it as passed. They do NOT prove the test is meaningful, that the report is genuine (FX seals it; P5r wires it), or
 * anything about a real vitest: the reports are schema-derived like gate.test.mjs (no vitest is a dependency).
 *
 * Fixtures: real git repositories in a temp dir, a real P2 verdict with the REAL `kindsForClasses`, the REAL P6 `testKindWaivers`.
 * Tests tagged [P4r-n] are the ones the mutation check (the last test) runs against each mutant (L1: killed only by an assertion).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRecord, tkVerdict, recordUsable, readEntry, evidenceIdentity, commandDigest, configDigest, toRepoRel, LIMITS, REFUSALS, FILE_VOIDS, CLAIM } from './engine-test-kinds-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const DAG = 'd'.repeat(64);

// ---- a real repository: the base commit and a worktree on top of it ----
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const TITLE = 'SECRET-TITLE-zq9 rejects a forged input';
/** The base commit holds the configs, one test with ONE marker and an uncovered (apps/web) test; the worktree adds the candidate's tests. */
function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'p4r-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
const ENTRY = { name: 'unit', format: 'vitest-json', cmd: 'node_modules/.bin/vitest', args: ['run', '--pool=forks', '--reporter=json', '--outputFile=/dev/fd/3', 'libs/money/new.test.ts'],
  covers: ['libs/**', 'apps/api/**'], config_paths: ['vitest.config.ts', 'package-lock.json'] };
/** A vitest-json report (schema-derived, as in gate.test.mjs): `suites` = [{ file, cases:[{ title, status, ancestors }] }]. */
function report(suites) {
  const testResults = suites.map((s) => ({ name: s.file, status: s.cases.some((c) => c.status === 'failed') ? 'failed' : 'passed', startTime: 1, endTime: 2, message: '',
    assertionResults: s.cases.map((c) => ({ ancestorTitles: c.ancestors ?? [], fullName: c.title, status: c.status ?? 'passed', title: c.title, duration: 1, failureMessages: c.status === 'failed' ? ['AssertionError: x'] : [], meta: {} })) }));
  return JSON.stringify({ numTotalTests: 1, numFailedTests: 0, success: true, startTime: 1, testResults });
}
const passing = (dir, title = `${TITLE} [kind:negative]`) => report([{ file: join(dir, 'libs/money/new.test.ts'), cases: [{ title }] }]);
const prov = (text, over = {}) => ({ text, runner_id: 'vitest', runner_version: '2.1.0', attempt_id: 'a1', exit_code: 0, report_sha256: sha(text), report_eof: true, sealed: true, quiesced: true, binding_verified: true, evidence_id_before: null, ...over });
/** build() with the identity bracket filled in (the caller's "before" is the identity now, unless overridden). */
function build(r, text, o = {}) {
  const before = o.before ?? evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id;
  return buildRecord({ repo: r.dir, baseSha: r.base, entry: o.entry ?? ENTRY, tests: { globs: [] }, dagDigest: DAG, report: prov(text, { evidence_id_before: before, ...o.prov }) });
}
const code = (res) => { assert.equal(res.ok, false, 'a refusal is expected'); return res.code; };

// ---- the verdict side: a real P3 bound record, the real P6 waivers ----
const bound = (tags, kinds, prot = []) => ({ tags, items: [], kinds: Object.fromEntries(kinds.map(([k, ...s]) => [k, s])), protected: prot });
const NEG = bound(['input-path'], [['negative', 'tag:input-path']]);
const RACE = bound(['concurrency'], [['race', 'tag:concurrency']]);
const MONEY = bound(['money'], [['negative', 'tag:money'], ['race', 'tag:money']], ['negative', 'race']);
const S0 = { run_id: 'run-1', plan_digest: 'sha256:' + 'a'.repeat(64), attempts: [], authority: { through: 0, trusted: [], untrusted: [] } };
function view(r, rec, o = {}) {
  const cur = commandDigest(ENTRY.cmd, ENTRY.args);
  return { repo: r.dir, baseSha: r.base, dagDigest: DAG, entries: [o.entry ?? ENTRY], commands: { unit: { cmd: ENTRY.cmd, args: o.args ?? ENTRY.args } }, records: rec ? { unit: rec } : {}, tests: { globs: [] },
    bound: o.bound ?? NEG, declaration: null, reassessed: o.reassessed ?? [], S: o.S ?? S0, _cur: cur };
}
const verdict = (r, rec, o = {}) => { const { _cur, ...E } = view(r, rec, o); return tkVerdict(E, o.point ?? 'F1'); };
const good = (r) => { const b = build(r, passing(r.dir)); assert.equal(b.ok, true, JSON.stringify(b)); return b.record; };

test('[P4r-1] AC1 control: a record built from a sealed passing run reaches a pass verdict, claim L-ran, with the identity it was built on', (t) => {
  const r = repo(t), rec = good(r);
  assert.equal(CLAIM, 'L-ran');
  assert.equal(rec.claim, 'L-ran');
  assert.deepEqual(rec.files.map((f) => [f.file, f.outcome, f.credited]), [['libs/money/new.test.ts', 'counted', ['kind:negative']]]);
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
    const copy = JSON.parse(JSON.stringify(rec));
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
  // applicability: a non-zero exit, another entry's record, a covers that no longer includes the counted file
  expect((c) => { c.exit_code = 1; }, 'applicability');
  expect((c) => { c.entry = 'other'; }, 'applicability');
  expect(null, 'applicability', { entry: { ...ENTRY, covers: ['apps/api/**'] } });
  // freshness: the DAG digest, the command after substitution, the config bytes
  expect((c) => { c.dag_digest = 'e'.repeat(64); }, 'freshness');
  expect(null, 'freshness', { args: [...ENTRY.args, '--bail'] });
  expect((c) => { c.config_digest = 'f'.repeat(64); }, 'freshness');
  // a changed candidate byte is the identity condition, again with the record untouched
  put(r.dir, 'libs/money/extra.txt', 'x');
  expect(null, 'identity');
  // malformed state is never a pass
  for (const bad of [null, 5, [], { files: 1 }]) assert.equal(verdict(r, bad).status, 'refused');
});

test('[P4r-3] AC1: an exit-0 control stays current when nothing it depends on moved (the invalidations above are not blanket refusals)', (t) => {
  const r = repo(t), rec = good(r);
  const a = verdict(r, rec), b = verdict(r, JSON.parse(JSON.stringify(rec)));
  assert.equal(a.status, 'pass'); assert.equal(b.status, 'pass');
  assert.equal(recordUsable(rec, { evidence_id: rec.evidence_id, base_sha: r.base, entry: readEntry(ENTRY), dag_digest: DAG, command_digest: commandDigest(ENTRY.cmd, ENTRY.args), config_digest: configDigest(r.dir, ENTRY.config_paths).digest }).ok, true);
});

test('[P4r-4] AC2 rules 2 and 4: only a PASSED result with the marker in its OWN leaf title counts; skip, todo, fail and load never do', (t) => {
  const r = repo(t);
  const file = join(r.dir, 'libs/money/new.test.ts');
  const only = (c) => build(r, report([{ file, cases: [c] }]));
  const credited = (res) => { assert.equal(res.ok, true, JSON.stringify(res)); return res.record.files.flatMap((f) => f.credited); };
  assert.deepEqual(credited(only({ title: 'p [kind:negative]' })), ['kind:negative']);
  for (const status of ['skipped', 'pending', 'todo', 'disabled']) assert.deepEqual(credited(only({ title: 'p [kind:negative]', status })), [], status);
  // a marker only in a SUITE title credits nothing (rule 4)
  assert.deepEqual(credited(only({ title: 'plain', ancestors: ['suite [kind:negative]'] })), []);
  // a failing result, in an exit-0 report or an exit-1 report, refuses the whole record (a RED run never satisfies a kind)
  assert.equal(code(only({ title: 'p [kind:negative]', status: 'failed' })), 'evidence_run_failed');
  assert.equal(code(build(r, passing(r.dir), { prov: { exit_code: 1 } })), 'evidence_run_failed');
  const withFail = report([{ file, cases: [{ title: 'p [kind:negative]' }, { title: 'q', status: 'failed' }] }]);
  assert.equal(code(build(r, withFail, { prov: { exit_code: 1 } })), 'evidence_run_failed');
  // a load error (a suite with no assertion results that failed) is a failed run
  const load = JSON.stringify({ testResults: [{ name: file, status: 'failed', message: 'Failed to load', assertionResults: [] }] });
  assert.equal(code(build(r, load)), 'evidence_run_failed');
  // the RED path of a stored-record view: no record at all is missing, never "pass"
  assert.equal(verdict(r, null).code, 'missing_test_kinds');
  // one `[plan:X]`, one unknown kind and a malformed marker
  const res = only({ title: 'p [plan:Item1] [kind:not-a-kind] [kind:] [plan:9x]' });
  assert.deepEqual(res.ok && res.record.files.flatMap((f) => f.credited), [], 'the markers are not in the file bytes, so R-3 credits none');
});

test('[P4r-5] AC2 rule 5 (R-3): a marker counts only when the file holds MORE of it than at base; the base file of a new file is empty', (t) => {
  const r = repo(t);
  const old = join(r.dir, 'libs/money/old.test.ts');
  const one = (file, title) => { const b = build(r, report([{ file, cases: [{ title }] }])); assert.equal(b.ok, true, JSON.stringify(b)); return b.record; };
  // unchanged file: not in P, so a void (it cannot be evidence of THIS candidate)
  assert.equal(one(old, 'old [kind:negative]').files[0].outcome, 'not_in_P');
  // the file is edited but holds the SAME number of markers as at base: nothing is credited
  put(r.dir, 'libs/money/old.test.ts', "test('renamed [kind:negative]', () => { expect(1).toBe(1); });\n");
  assert.deepEqual(one(old, 'renamed [kind:negative]').files[0], { file: 'libs/money/old.test.ts', outcome: 'counted', credited: [] });
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
  assert.deepEqual(each.record.files[0].credited, ['kind:negative']);
  // CRLF bytes count the same as LF (L10)
  put(r.dir, 'libs/money/new.test.ts', "test('a [kind:negative]', () => {});\r\n");
  assert.deepEqual(one(join(r.dir, 'libs/money/new.test.ts'), 'a [kind:negative]').files[0].credited, ['kind:negative']);
});

test('[P4r-6] AC2 rule 3: a result file outside the repo, outside P, not regular, not a test file, uncovered or relative is a typed void and credits nothing', (t) => {
  const r = repo(t);
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'p4r-out-'))); t.after(() => rmSync(out, { recursive: true, force: true }));
  put(out, 'evil.test.ts', "test('e [kind:negative]', () => {});\n");
  put(r.dir, 'libs/money/helper.ts', "// [kind:negative]\n");
  put(r.dir, 'apps/web/new.test.ts', "it('w [kind:negative]', () => {});\n");
  symlinkSync(join(r.dir, 'libs/money/new.test.ts'), join(r.dir, 'libs/money/link.test.ts'));
  const cases = [[join(out, 'evil.test.ts'), 'result_outside_repo'], [join(r.dir, 'libs/money/helper.ts'), 'not_test_file'], [join(r.dir, 'apps/web/new.test.ts'), 'runner_uncovered'],
    ['libs/money/new.test.ts', 'result_outside_repo'], ['C:\\repo\\libs\\new.test.ts', 'result_outside_repo'], [join(r.dir, 'libs/money/gone.test.ts'), 'not_regular'], [join(r.dir, 'libs/money/old.test.ts'), 'not_in_P']];
  for (const [file, outcome] of cases) {
    const b = build(r, report([{ file, cases: [{ title: 'x [kind:negative]' }] }]));
    assert.equal(b.ok, true, file);
    assert.deepEqual(b.record.files.map((f) => f.outcome), [outcome], file);
    assert.deepEqual(b.record.files.flatMap((f) => f.credited), [], file);
    assert.ok(FILE_VOIDS.includes(outcome));
  }
  // a result naming a DIRECTORY (a tracked test file replaced by a directory) is not a regular file
  rmSync(join(r.dir, 'libs/money/old.test.ts')); put(r.dir, 'libs/money/old.test.ts/inner.txt', 'x');
  const dirRes = build(r, report([{ file: join(r.dir, 'libs/money/old.test.ts'), cases: [{ title: 'x [kind:negative]' }] }]));
  assert.deepEqual(dirRes.ok && dirRes.record.files.map((f) => f.outcome), ['not_regular']);
  // a symlink named *.test.ts resolves to its target through realpath: the target is the file that counts, and it is regular
  const viaLink = build(r, report([{ file: join(r.dir, 'libs/money/link.test.ts'), cases: [{ title: 'x [kind:negative]' }] }]));
  assert.deepEqual(viaLink.record.files.map((f) => [f.file, f.outcome]), [['libs/money/new.test.ts', 'counted']]);
  // the Windows spelling is a pure path computation (L10): drive paths and backslashes map to a POSIX repo path
  assert.equal(toRepoRel('C:\\repo', 'C:\\repo\\libs\\a.test.ts', path.win32), 'libs/a.test.ts');
  assert.equal(toRepoRel('C:\\repo', 'D:\\repo\\libs\\a.test.ts', path.win32), null);
  assert.equal(toRepoRel('C:\\repo', 'C:\\repo\\..\\x\\a.test.ts', path.win32), null);
  assert.equal(toRepoRel('/repo', '/repo', path.posix), null);
});

test('[P4r-7] AC3: runner_config_changed (a config_paths file is in P), in both buildRecord and the verdict; runner_uncovered is counted', (t) => {
  const r = repo(t), rec = good(r);
  put(r.dir, 'vitest.config.ts', 'export default { globalSetup: "./evil.ts" };\n');
  assert.equal(code(build(r, passing(r.dir))), 'runner_config_changed');
  const v = verdict(r, rec);
  assert.equal(v.status, 'refused'); assert.equal(v.code, 'runner_config_changed'); assert.deepEqual(v.codes, ['runner_config_changed']);
  // an uncovered changed test file is counted in the verdict, never silently bypassed
  const r2 = repo(t); put(r2.dir, 'apps/web/new.test.ts', "it('w [kind:negative]', () => {});\n");
  const v2 = verdict(r2, good(r2));
  assert.equal(v2.voids.runner_uncovered, 1);
  assert.equal(v2.status, 'pass', 'the covered file still counts');
  assert.equal(verdict(r2, null).voids.runner_uncovered, 1);
});

test('[P4r-8] AC3 and OD-2: ANY runner, format or pool other than vitest-json with --pool=forks is runner_unsupported (never bypassed)', (t) => {
  const r = repo(t), text = passing(r.dir);
  const variants = [
    { format: 'jest-json' }, { format: 'tap' }, { format: 'junit' }, { cmd: 'node_modules/.bin/jest' }, { cmd: 'node_modules/.bin/ng' },
    { args: ENTRY.args.filter((a) => a !== '--pool=forks') }, { args: [...ENTRY.args.filter((a) => a !== '--pool=forks'), '--pool=threads'] },
    { args: [...ENTRY.args, '--pool=vmThreads'] }, { args: [...ENTRY.args, '--pool=forks'] }, { args: [...ENTRY.args.filter((a) => a !== '--reporter=json'), '--reporter=verbose'] },
    { args: [...ENTRY.args, '--reporter=default'] },
  ];
  for (const v of variants) {
    assert.equal(code(build(r, text, { entry: { ...ENTRY, ...v } })), 'runner_unsupported', JSON.stringify(v));
    const { _cur, ...E } = view(r, null, { entry: { ...ENTRY, ...v } });
    const out = tkVerdict(E, 'F1');
    assert.equal(out.status, 'refused'); assert.equal(out.code, 'runner_unsupported', JSON.stringify(v));
  }
  assert.equal(code(build(r, text, { prov: { runner_id: 'jest' } })), 'runner_unsupported');
  assert.equal(readEntry(ENTRY).name, 'unit');
});

test('[P4r-9] AC3: provenance: every integrity field, the report digest, the exit status and the identity bracket each refuse with their own typed code', (t) => {
  const r = repo(t), text = passing(r.dir);
  const cases = [
    [{ sealed: false }, 'runner_output_tampered'], [{ binding_verified: false }, 'runner_output_tampered'], [{ report_sha256: sha('forged') }, 'runner_output_tampered'],
    [{ report_eof: false }, 'runner_survivor'], [{ quiesced: false }, 'quiescence_unknown'], [{ exit_code: 1 }, 'evidence_run_failed'], [{ exit_code: null }, 'evidence_run_failed'],
    [{ evidence_id_before: `e1:${'1'.repeat(64)}` }, 'candidate_moved'],
  ];
  for (const [over, want] of cases) assert.equal(code(build(r, text, { prov: over })), want, JSON.stringify(over));
  // a report that changed after it was sealed (forged text, original digest)
  assert.equal(code(build(r, text.replace('passed', 'passed ') /* not equal bytes */, { prov: { report_sha256: sha(text) } })), 'runner_output_tampered');
  for (const c of REFUSALS) assert.equal(typeof c, 'string');
});

test('[P4r-10] AC3 budgets (L3): a huge report, too many results, too many marker files, deep JSON and duplicate keys are refused promptly', (t) => {
  const r = repo(t);
  const file = join(r.dir, 'libs/money/new.test.ts');
  const big = 'x'.repeat(LIMITS.maxReportBytes + 1);
  assert.equal(code(build(r, big)), 'evidence_budget_exceeded');
  const many = JSON.stringify({ testResults: [{ name: file, status: 'passed', assertionResults: Array.from({ length: LIMITS.maxResults + 1 }, () => ({ ancestorTitles: [], title: 't', status: 'passed', failureMessages: [] })) }] });
  assert.equal(code(build(r, many)), 'evidence_budget_exceeded');
  const files = JSON.stringify({ testResults: Array.from({ length: LIMITS.maxMarkerFiles + 1 }, (_, i) => ({ name: join(r.dir, `libs/f${i}.test.ts`), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'a [kind:negative]', status: 'passed', failureMessages: [] }] })) });
  assert.equal(code(build(r, files)), 'evidence_budget_exceeded');
  // deep and duplicate-key documents are not evidence (never a stack overflow, never "last key wins")
  assert.equal(code(build(r, '['.repeat(100_000))), 'evidence_unavailable');
  assert.equal(code(build(r, `{"testResults":${'['.repeat(65)}${']'.repeat(65)}}`)), 'evidence_unavailable');
  assert.equal(code(build(r, passing(r.dir).replace('"success":true', '"success":true,"success":false'))), 'evidence_unavailable');
  assert.equal(code(build(r, `{"testResults":[],"testResults":[{"name":${JSON.stringify(file)},"status":"passed","assertionResults":[]}]}`)), 'evidence_unavailable');
  for (const bad of ['', '{', 'null', '[]', '{"testResults":5}', '{"testResults":[{"name":5}]}', '{"testResults":[null]}', 'not json']) assert.equal(code(build(r, bad)), 'evidence_unavailable', bad);
  // budget refusals are typed on the verdict too: too many changed paths
  assert.ok(LIMITS.maxPaths > 0 && LIMITS.maxIdentityBytes > 0);
});

test('[P4r-11] AC3 (L6): hostile inputs are refused, never thrown, and no getter or proxy trap runs', (t) => {
  const r = repo(t);
  let ran = 0;
  const getter = { ...ENTRY }; Object.defineProperty(getter, 'covers', { get() { ran++; return ['libs/**']; }, enumerable: true });
  assert.equal(code(build(r, passing(r.dir), { entry: getter })), 'test_kinds_error');
  const proxy = new Proxy({ ...ENTRY }, { get() { ran++; throw new Error('trap'); }, getOwnPropertyDescriptor() { ran++; throw new Error('trap'); } });
  assert.equal(code(build(r, passing(r.dir), { entry: proxy })), 'test_kinds_error');
  const sparse = { ...ENTRY, args: new Array(5) };
  assert.equal(code(build(r, passing(r.dir), { entry: sparse })), 'test_kinds_error');
  const { _cur, ...E } = view(r, null);
  for (const E2 of [{ ...E, records: new Proxy({}, { get() { ran++; throw new Error('trap'); }, getOwnPropertyDescriptor() { ran++; throw new Error('trap'); } }) }, { ...E, entries: 'x' }, null, 5, { ...E, bound: null }]) {
    const out = tkVerdict(E2, 'F1');
    assert.equal(out.status, 'refused');
  }
  assert.equal(ran, 0, 'no getter and no trap was invoked');
  assert.equal(evidenceIdentity({ repo: r.dir, baseSha: 'HEAD' }).code, 'test_kinds_error', 'the base must be a full commit id');
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
  const forged = verdict(r, rec, { bound: RACE, S: withAuth([], [waiver('kind:race')]) });
  assert.equal(forged.code, 'waiver_unauthorized');
  // a malformed state is a typed refusal, never a pass
  const broken = verdict(r, rec, { bound: RACE, S: { run_id: 'run-1' } });
  assert.equal(broken.status, 'refused');
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
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.record.files[0].credited, ['kind:negative']);
  assert.equal(b.record.counts.unknown_markers, 1, 'the unknown marker is a count');
  const v = verdict(r, b.record);
  const dump = JSON.stringify([b, v, verdict(r, null), build(r, text, { prov: { exit_code: 1 } }), build(r, report([{ file: join(r.dir, 'apps/web/ng.test.ts'), cases: [{ title: titles[0] }] }]))]);
  assert.ok(dump.includes('kind:negative'), 'the dump is not empty');
  assert.ok(dump.includes('libs/money/new.test.ts'), 'file names are state');
  assert.doesNotMatch(dump, /SECRET-TITLE|zq9|zzzz-unknown|forged input/);
  assert.doesNotMatch(JSON.stringify(b.record), /forged/);
});

test('[P4r-16] AC1/AC6: a record round-trips through JSON (state) and is still read by the same rule', (t) => {
  const r = repo(t), rec = JSON.parse(JSON.stringify(good(r)));
  assert.equal(verdict(r, rec).status, 'pass');
  assert.ok(Object.keys(rec).every((k) => ['evidence_id', 'base_sha', 'entry', 'dag_digest', 'command_digest', 'config_digest', 'attempt_id', 'exit_code', 'report_sha256', 'report_len', 'runner', 'claim', 'integrity', 'files', 'counts'].includes(k)));
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
  assert.ok(closure('engine-test-kinds-io.test.mjs').includes('engine-test-kinds-io.mjs'));
  const { root, dir } = copyLayout((s) => lf(s).replace(/\n/g, '\r\n'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(readFileSync(join(dir, 'engine-test-kinds-io.mjs'), 'utf8').includes('\r\n'), 'the copy really is CRLF');
  const crlf = await import(pathToFileURL(join(dir, 'engine-test-kinds-io.mjs')).href);
  const r = repo(t), text = passing(r.dir), before = evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id;
  const mk = (m) => m.buildRecord({ repo: r.dir, baseSha: r.base, entry: ENTRY, tests: { globs: [] }, dagDigest: DAG, report: prov(text, { evidence_id_before: before }) });
  assert.equal(JSON.stringify(mk(crlf)), JSON.stringify(mk({ buildRecord })));
  assert.equal(crlf.evidenceIdentity({ repo: r.dir, baseSha: r.base }).evidence_id, before);
});

// ---- mutation check (L1): a mutant counts as killed ONLY by an ERR_ASSERTION failure in a [P4r-n] test ----
const MUTANTS = [
  { name: 'identity: the evidence_id comparison is dropped', from: "if (g('evidence_id') !== c('evidence_id') || g('base_sha') !== c('base_sha'))", to: "if (g('base_sha') !== c('base_sha'))" },
  { name: 'identity: the base_sha comparison is dropped', from: "if (g('evidence_id') !== c('evidence_id') || g('base_sha') !== c('base_sha'))", to: "if (g('evidence_id') !== c('evidence_id'))" },
  { name: 'integrity: the flags are not checked', from: 'if (!INTEGRITY.every((k) => own(integ, k) === true))', to: 'if (false)' },
  { name: 'integrity: one flag is skipped', from: "const INTEGRITY = ['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable'];", to: "const INTEGRITY = ['sealed', 'report_eof', 'quiesced', 'binding_verified'];" },
  { name: 'applicability: a non-zero exit is accepted', from: "|| g('exit_code') !== 0 ||", to: '||' },
  { name: 'applicability: the entry name is not compared', from: "g('entry') !== own(entry, 'name') ||", to: '' },
  { name: 'applicability: covers is not re-checked', from: '|| !covered)', to: ')' },
  { name: 'freshness: the dag digest is not compared', from: "g('dag_digest') !== c('dag_digest') ||", to: '' },
  { name: 'freshness: the command digest is not compared', from: "|| g('command_digest') !== c('command_digest')", to: '' },
  { name: 'freshness: the config digest is not compared', from: "|| g('config_digest') !== c('config_digest')) return", to: ') return' },
  { name: 'counting: a skipped result counts', from: "if (r.status !== 'pass') continue;", to: '' },
  { name: 'counting: a failed result does not fail the record', from: "if (results.some((r) => r.status === 'fail')) refuse('evidence_run_failed');", to: '' },
  { name: 'counting: the exit status is not checked', from: "if (exit !== 0) refuse('evidence_run_failed');", to: '' },
  { name: 'counting: the marker is read from the suite title too', from: "const m = markers([r.title]);", to: "const m = markers([r.title, ...(Array.isArray(r.suite_path) ? r.suite_path : [])]);" },
  { name: 'counting: R-3 is dropped (a marker present at base counts)', from: '(cand.get(m) ?? 0) > (base.get(m) ?? 0)', to: '(cand.get(m) ?? 0) > 0' },
  { name: 'counting: R-3 compares only to the file existing at base, equal counts credit', from: '(cand.get(m) ?? 0) > (base.get(m) ?? 0)', to: '(cand.get(m) ?? 0) >= (base.get(m) ?? 0)' },
  { name: 'file: a file outside P is counted', from: "if (!inP.has(rel)) return { void: 'not_in_P', rel };", to: '' },
  { name: 'file: the test globs are not applied', from: "if (!matches(testGlobs, rel, ctx)) return { void: 'not_test_file', rel };", to: '' },
  { name: 'file: covers is not applied', from: "if (!matches(covers, rel, ctx)) return { void: 'runner_uncovered', rel };", to: '' },
  { name: 'file: a relative result name is resolved against the cwd', from: "if (!isAbsolute(file)) return { void: 'result_outside_repo' };", to: '' },
  { name: 'file: a non-regular file is counted', from: "if (!st.isFile()) return { void: 'not_regular', rel };", to: '' },
  { name: 'config: a config path in P does not refuse the record', from: "if (entry.config_paths.some((p) => inP.has(p))) refuse('runner_config_changed');", to: '' },
  { name: 'config: a config path in P does not refuse the verdict', from: "if (entries.some((en) => en.config_paths.some((p) => inP.has(p)))) refuse('runner_config_changed');", to: '' },
  { name: 'runner: the pool is not pinned', from: "if (args.filter((a) => a === '--pool=forks').length !== 1 ||", to: "if (false ||" },
  { name: 'runner: another format is accepted', from: "if (format !== 'vitest-json') refuse('runner_unsupported');", to: '' },
  { name: 'runner: another reporter is accepted', from: "args.some((a) => /^--reporter/.test(a) && a !== '--reporter=json')", to: 'false' },
  { name: 'provenance: the report digest is not compared', from: " || prov.report_sha256 !== digest) refuse('runner_output_tampered')", to: ') refuse(\'runner_output_tampered\')' },
  { name: 'provenance: the identity bracket is not compared', from: "if (prov.evidence_id_before !== id.evidence_id) refuse('candidate_moved');", to: '' },
  { name: 'provenance: a survivor is accepted', from: "if (prov.report_eof !== true) refuse('runner_survivor');", to: '' },
  { name: 'provenance: a non-quiescent group is accepted', from: "if (prov.quiesced !== true) refuse('quiescence_unknown');", to: '' },
  { name: 'budget: the report size is not capped', from: "if (text.length > LIMITS.maxReportBytes) refuse('evidence_budget_exceeded');", to: '' },
  { name: 'budget: the result count is not capped', from: "if (results.length > LIMITS.maxResults) refuse('evidence_budget_exceeded');", to: '' },
  { name: 'budget: the marker-file count is not capped', from: "if (byFile.size > LIMITS.maxMarkerFiles) refuse('evidence_budget_exceeded');", to: '' },
  { name: 'scan: duplicate keys are accepted', from: 'if (keys.has(key)) bad();', to: '' },
  { name: 'scan: depth is not capped', from: 'if (d > LIMITS.maxDepth) bad();', to: '' },
  { name: 'verdict: waivers are matched to a fixed candidate instead of the evidence identity', from: 'testKindWaivers(S, id.evidence_id,', to: "testKindWaivers(S, 'fixed'," },
  { name: 'verdict: protected kinds are not handed to P6', from: "protected: v0.protected_kinds.map((k) => `kind:${k}`)", to: 'protected: []' },
  { name: 'verdict: untrusted waivers are dropped', from: 'run({ trusted: w.waived, untrusted: w.unauthorized })', to: 'run({ trusted: w.waived, untrusted: [] })' },
  { name: 'verdict: reassessed classes are not passed on', from: "reassessed: own(E, 'reassessed')", to: 'reassessed: []' },
  { name: 'verdict: a stale record is used as evidence', from: "if (!u.ok) continue;", to: '' },
  { name: 'identity: the pinned base is not hashed', from: 'h.update(`ship-ticket-tk-evidence-v1\\0${baseSha}\\0`);', to: 'h.update(`ship-ticket-tk-evidence-v1\\0`);' },
  { name: 'identity: file bytes are not hashed', from: 'h.update(content); h.update(\'\\0\');', to: "h.update('\\0');" },
  { name: 'identity: a fifo is read', from: "else refuse('evidence_unavailable'); // a fifo or device is never read (it could block)", to: "else { kind = 'other'; }" },
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
async function runMutant(t, mutant) {
  const { root, dir } = copyLayout((s, f) => {
    if (!mutant || f !== 'engine-test-kinds-io.mjs') return s;
    const text = lf(s);
    assert.equal(text.split(mutant.from).length, 2, `mutant "${mutant.name}": its target text occurs exactly once`);
    return text.replace(mutant.from, () => mutant.to);
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (mutant) {
    const load = await run(['--input-type=module', '-e', "await import('./engine-test-kinds-io.mjs')"], dir);
    if (load.code !== 0) return { invalid: true, tail: load.out.slice(-800) };
  }
  const r = await run(['--test', '--test-reporter=tap', '--test-name-pattern=\\[P4r-\\d+\\]', 'engine-test-kinds-io.test.mjs'], dir);
  const blocks = r.out.split(/^(?=\s*(?:not )?ok \d+ - )/m).filter((b) => /^\s*not ok \d+ - /.test(b));
  const killers = blocks.filter((b) => /^\s*not ok \d+ - \[P4r-\d+\]/.test(b) && /code: '?ERR_ASSERTION'?/.test(b)).map((b) => /\[P4r-\d+\]/.exec(b)[0]);
  const passed = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  return { invalid: false, ...r, killers, passed, tail: r.out.slice(-1500) };
}
const uniq = (xs) => [...new Set(xs)].sort();

test('mutation: the control passes every tagged test; every mutant loads and is killed by an assertion', { timeout: 30 * 60 * 1000 }, async (t) => {
  assert.equal(new Set(MUTANTS.map((m) => m.name)).size, MUTANTS.length, 'mutant names are distinct');
  for (const m of MUTANTS) assert.notEqual(m.from, m.to, m.name);
  const jobs = [null, ...MUTANTS], results = [];
  for (let i = 0; i < jobs.length; i += 3) results.push(...await Promise.all(jobs.slice(i, i + 3).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test:\n${control.tail}`);
  assert.ok(control.passed >= 16, `the control ran the tagged tests (${control.passed})`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: uniq(r.killers ?? []) }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.length).map((r) => `${r.m.name} (exit ${r.code})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure');
  t.diagnostic(`mutants ${mutants.length}, all killed by assertions`);
});
