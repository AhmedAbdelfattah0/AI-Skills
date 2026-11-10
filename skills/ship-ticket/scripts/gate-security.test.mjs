/**
 * AIS-HARNESS-4 Wave B, pure units of the policy-2 security binding (no engine CLI, no git).
 * Every assertion is on codes, statuses and shapes, never on message text (C12). Tests tagged [S#]
 * are the ones engine-security-mutation.test.mjs expects to fail when guard S# is patched out.
 *
 * ============================ CONTRACT (Wave B, pure) ============================
 * harness.mjs     CONTROL_ID /^VAPT-(API|WEB|CFG|ABUSE)-\d{2}$/; controlKind(b, c) = '<b>:<c>-spec'.
 * engine-dag.mjs  config securityPolicy (only 2), catalogDigest ('sha256:<64 hex>'), controlCoverage
 *   [{boundary, control, node, specs:[{file,name}]}] — never defaulted; validated at init (dag_invalid).
 *   SECURITY_POLICY_CUTOFF (one constant), legacyApproval(start) (approved_at ?? timestamp strictly
 *   before it; missing or unparseable -> false), securityOn(S), ENGINE_SECURITY_CODES.
 *   gateInput: 'reassess' { classifications }, red { addendum }; ship-ready never takes pair/proof fields.
 *   pinnedSpecs(node, specs, addendumSpecs): a trusted addendum's specs are the pin source when given.
 * gate.mjs        findSpec / specStatus(spec, parsed) -> pass|fail|skip|missing|unparsed;
 *   specResults(specs, runs) combines formatted runs: fail > skip > unparsed > pass > missing (only pass proves).
 *   gateRed input.slot {map: 'red'|'red_addendum', key}; red_addendum skips dispatched_before_red.
 *   gateShipReady: current.control_pairs [{boundary, control, proven}] -> 'control_unproven' appended
 *   after every legacy reason, only when the local proof holds; missing += controlKind of each unproven pair.
 * engine-authority.mjs securityEvents(S) -> { pairs, addenda, waivers, forged, conflicts, outside };
 *   waiverState(S, sec, candidate) -> { waived, unauthorized }.
 * run-state.mjs   AUTHORITY_EVENTS gains SECURITY_ADDENDUM and SECURITY_WAIVER (not SECURITY_REASSESSED).
 * ==================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as H from './harness.mjs';
import * as D from './engine-dag.mjs';
import * as G from './gate.mjs';
import * as A from './engine-authority.mjs';
import * as R from './run-state.mjs';
import * as EG from './engine-gates.mjs';
import * as PLAN from './security-plan.mjs';
const PLAN_CODES = PLAN.SECURITY_CODES;

const HERE = dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
const DIGEST = 'sha256:' + 'a'.repeat(64);
const SPEC = { file: 'src/api/sec.test.mjs', name: 'refuses anonymous' };
const SPEC2 = { file: 'src/api/sec2.test.mjs', name: 'refuses other tenant' };
const PAIR = { boundary: 'GET-orders', control: 'VAPT-API-01', node: 'api', specs: [SPEC] };
const TAP_CMD = { cmd: 'node', args: ['--test'], format: 'tap' };

const secDag = (coverage = [PAIR], config = {}, node = {}) => JSON.parse(J({ schema: 'ship-ticket-engine-dag-v1',
  config: { provider: 'claude', timeoutMs: 1000, testCommands: { unit: TAP_CMD }, securityPolicy: 2, catalogDigest: DIGEST,
    controlCoverage: coverage, ...config },
  nodes: [{ id: 'api', promptFile: '/p', writes: ['src/api'], redSpecs: [SPEC, SPEC2], ...node }] })); // as the bytes of a DAG file (no undefined keys)
const valid = (doc) => D.validateEngineDag(doc, { ticket: 'T-1' });
const invalid = (doc) => assert.throws(() => valid(doc), (e) => e.code === 'dag_invalid', J(doc.config));

// ------------------------------------------------------------------ harness

test('harness: CONTROL_ID accepts the four catalog families with two digits; controlKind is <b>:<c>-spec', () => {
  for (const id of ['VAPT-API-01', 'VAPT-WEB-05', 'VAPT-CFG-04', 'VAPT-ABUSE-08']) assert.ok(H.CONTROL_ID.test(id), id);
  for (const id of ['VAPT-XSS-01', 'VAPT-API-1', 'vapt-api-01', 'VAPT-API-01 ', 'API-01']) assert.equal(H.CONTROL_ID.test(id), false, id);
  assert.equal(H.controlKind('GET-orders', 'VAPT-API-01'), 'GET-orders:VAPT-API-01-spec');
  assert.throws(() => H.requiredEvidence([H.controlKind('b', 'VAPT-API-01')]), TypeError, 'pairs never go through requiredEvidence');
});

// ------------------------------------------------------------------ DAG

test('[S1] DAG: policy-2 keys are validated, each refusal row has an accepting twin differing in one field', () => {
  const plain = valid(secDag([], { securityPolicy: undefined, catalogDigest: undefined, controlCoverage: undefined }));
  for (const k of ['securityPolicy', 'catalogDigest', 'controlCoverage']) assert.equal(Object.hasOwn(plain.config, k), false, `${k} never defaulted`);
  assert.equal(valid(secDag()).config.securityPolicy, 2);
  const rows = [
    ['policy other than 2', secDag([], { securityPolicy: 3 }), secDag([], { securityPolicy: 2 })],
    ['policy 1 is not a value', secDag([], { securityPolicy: 1 }), secDag([])],
    ['coverage without policy 2', secDag([], { securityPolicy: undefined, catalogDigest: undefined }), secDag([], { securityPolicy: 2 })],
    ['catalog digest without policy 2', secDag(undefined, { securityPolicy: undefined, controlCoverage: undefined }),
      secDag(undefined, { securityPolicy: undefined, controlCoverage: undefined, catalogDigest: undefined })],
    ['policy 2 needs a catalog digest', secDag([], { catalogDigest: undefined }), secDag([])],
    ['catalog digest form', secDag([], { catalogDigest: 'sha256-' + 'a'.repeat(64) }), secDag([])],
    ['policy 2 needs coverage (an evidenced [] is valid)', secDag(undefined, { controlCoverage: undefined }), secDag([])],
    ['bad control id', secDag([{ ...PAIR, control: 'VAPT-XSS-01' }]), secDag([PAIR])],
    ['a route boundary with a colon is accepted; the same with a line break is not', secDag([{ ...PAIR, boundary: 'GET /a/:id\n' }]), secDag([{ ...PAIR, boundary: 'GET /a/:id' }])],
    ['boundary with a line break', secDag([{ ...PAIR, boundary: 'a\nb' }]), secDag([{ ...PAIR, boundary: 'a b' }])],
    ['boundary with a control character', secDag([{ ...PAIR, boundary: 'GET /a/:id\u0000' }]), secDag([{ ...PAIR, boundary: 'GET /a/:id' }])],
    ['boundary with edge whitespace', secDag([{ ...PAIR, boundary: ' GET /a/:id' }]), secDag([{ ...PAIR, boundary: 'GET /a/:id' }])],
    ['empty boundary', secDag([{ ...PAIR, boundary: '' }]), secDag([PAIR])],
    ['unknown pair field', secDag([{ ...PAIR, proven: true }]), secDag([PAIR])],
    ['duplicate pair', secDag([PAIR, { ...PAIR, specs: [SPEC2] }]), secDag([PAIR, { ...PAIR, control: 'VAPT-API-02', specs: [SPEC2] }])],
    ['a spec shared between pairs', secDag([PAIR, { ...PAIR, control: 'VAPT-API-02' }]), secDag([PAIR, { ...PAIR, control: 'VAPT-API-02', specs: [SPEC2] }])],
    ['unknown node', secDag([{ ...PAIR, node: 'web' }]), secDag([PAIR])],
    ['spec not in the node redSpecs', secDag([PAIR], {}, { redSpecs: [SPEC2] }), secDag([PAIR], {}, { redSpecs: [SPEC] })],
    ['a plain-path redSpecs entry is not a named spec', secDag([PAIR], {}, { redSpecs: [SPEC.file] }), secDag([PAIR], {}, { redSpecs: [SPEC] })],
    ['spec outside the node writes', secDag([PAIR], {}, { writes: ['src/web'] }), secDag([PAIR], {}, { writes: ['src/api'] })],
    ['a pair without specs', secDag([{ ...PAIR, specs: [] }]), secDag([PAIR])],
    ['coverage with no formatted runner', secDag([PAIR], { testCommands: { unit: { cmd: 'node', args: [] } } }), secDag([PAIR])],
  ];
  for (const [name, refuse, accept] of rows) {
    invalid(refuse);
    assert.doesNotThrow(() => valid(accept), name);
  }
  assert.doesNotThrow(() => valid(secDag([], { testCommands: { unit: { cmd: 'node', args: [] } } })), 'an empty assessment needs no runner');
});

test('[S1] boundary ids: a colon is allowed exactly when the pair id round-trips through security-plan.mjs parsePairId', () => {
  for (const b of ['GET /a/:id', 'src/x.ts#request-handler', 'x:VAPT-API-01', 'a:']) {
    assert.equal(D.pairRoundTrips(b, 'VAPT-API-02'), true, b);
    assert.deepEqual(PLAN.parsePairId(D.pairKey({ boundary: b, control: 'VAPT-API-02' })), { boundary_id: b, control_id: 'VAPT-API-02' }, b);
  }
  assert.equal(D.pairRoundTrips('a', 'API-02'), false);
  assert.equal(D.pairRoundTrips('', 'VAPT-API-02'), false);
});

test('[S2] grandfathering: legacyApproval compares approved_at (else timestamp) with the one cutoff constant; missing or unparseable is not legacy', () => {
  const cut = Date.parse(D.SECURITY_POLICY_CUTOFF);
  assert.ok(Number.isFinite(cut), 'SECURITY_POLICY_CUTOFF is one parseable ISO constant');
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(D.legacyApproval({ approved_at: iso(cut - 1) }), true);
  assert.equal(D.legacyApproval({ timestamp: iso(cut - 1000) }), true);
  assert.equal(D.legacyApproval({ timestamp: iso(cut) }), false, 'the cutoff itself is not legacy');
  assert.equal(D.legacyApproval({ approved_at: iso(cut + 1), timestamp: iso(cut - 1) }), false, 'approved_at wins');
  assert.equal(D.legacyApproval({ approved_at: 'yesterday', timestamp: iso(cut - 1) }), false, 'an unparseable approved_at fails closed');
  assert.equal(D.legacyApproval({}), false);
  assert.equal(D.legacyApproval(null), false);
  assert.equal(D.legacyApproval({ timestamp: 42 }), false);
  assert.equal(D.legacyApproval({ timestamp: '2026-11-05T00:00:00Z' }), true, 'the existing fixture START date stays grandfathered');
  assert.equal(D.securityOn({ config: { securityPolicy: 2 } }), true);
  for (const S of [{ config: {} }, { config: { securityPolicy: '2' } }, {}]) assert.equal(D.securityOn(S), false);
});

/** A START object literal built from the current clock (the line holds the event and a clock call), unless it carries securityPolicy 2. */
const CLOCK_START = (line) => /(event:\s*'START'|"event":\s*"START"|event:\s*"START")/.test(line) && /new Date\(|Date\.now\(/.test(line) && !/securityPolicy/.test(line);
test('[S2] no fixture or harness builds a START from the current clock without policy 2 (it would break once the cutoff passes)', () => {
  const clock = 'new ' + 'Date().toISOString()'; // split so this file's own source is not a hit
  assert.equal(CLOCK_START(`const start = { run_id: RUN, event: 'START', timestamp: ${clock} };`), true, 'the guard bites');
  assert.equal(CLOCK_START(`const start = { event: 'START', securityPolicy: 2, timestamp: ${clock} };`), false);
  assert.equal(CLOCK_START("const start = { run_id: RUN, event: 'START', timestamp: '2026-11-05T00:00:00Z' };"), false);
  const hits = readdirSync(HERE).filter(f => f.endsWith('.mjs')).flatMap(f => readFileSync(join(HERE, f), 'utf8').split('\n')
    .map((l, i) => [f, i + 1, l]).filter(([, , l]) => CLOCK_START(l))).map(([f, n]) => `${f}:${n}`);
  assert.deepEqual(hits, []);
});

test('ENGINE_SECURITY_CODES lists exactly the new engine refusal codes', () => {
  assert.deepEqual([...D.ENGINE_SECURITY_CODES].sort(), ['addendum_conflict', 'addendum_outside_contract', 'addendum_required', 'catalog_unavailable',
    'control_unproven', 'reassess_stale', 'reassess_unclassified', 'security_outcome_escape', 'security_pairs_mismatch', 'security_policy_required',
    'security_reapproval', 'security_review_stale', 'security_row_escape', 'waiver_unauthorized']);
  assert.ok(Object.isFrozen(D.ENGINE_SECURITY_CODES));
});

test('C1 net: every security-looking code literal in the engine modules is listed in ENGINE_SECURITY_CODES', () => {
  const files = ['harness.mjs', 'engine-dag.mjs', 'engine-gates.mjs', 'engine-authority.mjs', 'gate.mjs', 'run-state.mjs', 'run-engine.mjs'];
  const RE = /['"`]((?:security|catalog|control|waiver|addendum|reassess)_[a-z_]+)['"`]/g;
  // shape keys of records and events (not refusal codes)
  const KEYS = new Set(['control_pairs', 'security_coverage', 'catalog_digest', 'addendum_set', 'security_outcome', 'addendum_id', 'reassess_id']);
  const found = new Set();
  for (const f of files) for (const m of readFileSync(join(HERE, f), 'utf8').matchAll(RE)) if (!KEYS.has(m[1]) && !PLAN_CODES.includes(m[1])) found.add(m[1]); // security-plan.mjs codes the engine maps
  const stray = [...found].filter(c => !D.ENGINE_SECURITY_CODES.includes(c));
  assert.deepEqual(stray, [], 'an unlisted security code literal');
});

test('[S3] C4: ship-ready input never carries pair, spec or proof fields; red takes an addendum id; reassess takes classifications', () => {
  for (const extra of [{ control_pairs: [] }, { spec_results: [] }, { local_proof: {} }, { security_coverage: {} }, { waivers: [] }]) {
    assert.throws(() => D.gateInput('ship-ready', extra), (e) => e.code === 'bad_input', J(extra));
  }
  assert.throws(() => D.gateInput('ship-ready', { risk_evidence: [{ kind: 'k', path: 'p', proven: true }] }), (e) => e.code === 'bad_input');
  assert.doesNotThrow(() => D.gateInput('ship-ready', {}));
  assert.doesNotThrow(() => D.gateInput('red', { node: 'api', addendum: 'add-1' }));
  assert.throws(() => D.gateInput('red', { node: 'api', addendum: 7 }), (e) => e.code === 'bad_input');
  assert.throws(() => D.gateInput('red', { node: 'api', addendum: 'a/b' }), (e) => e.code === 'bad_input');
  // classifications are security-plan.mjs reassess classifications: { signal_id, facts?, evidence?, reason? }
  const cls = [{ signal_id: 'new-dependency@package.json', reason: 'patch bump' }];
  assert.doesNotThrow(() => D.gateInput('reassess', { classifications: cls }));
  assert.doesNotThrow(() => D.gateInput('reassess', { classifications: [{ signal_id: 'x', facts: { persistent_write: true }, evidence: { persistent_write: 'src/a.ts' } }] }));
  assert.doesNotThrow(() => D.gateInput('reassess', {}));
  for (const bad of [{ classifications: 'x' }, { classifications: [{ reason: 'r' }] }, { classifications: [{ signal_id: '', reason: 'r' }] },
    { classifications: [{ signal_id: 'x', outcome: 'UNCHANGED' }] }, { classifications: cls, outcome: 'UNCHANGED' }, { classifications: cls, inventory: [] }]) {
    assert.throws(() => D.gateInput('reassess', bad), (e) => e.code === 'bad_input', J(bad));
  }
});

test('[S22] C4: reassess surfaces are { boundary_id, kind, path, principals[] } with a boundary id that round-trips as a pair id', () => {
  const S = { boundary_id: 'GET /admin/:id', kind: 'server-input', path: 'src/routes/admin.ts', principals: ['staff'] };
  assert.doesNotThrow(() => D.gateInput('reassess', { surfaces: [S] }));
  assert.doesNotThrow(() => D.gateInput('reassess', { surfaces: [], classifications: [] }));
  for (const bad of [{ surfaces: S }, { surfaces: [{ ...S, extra: 1 }] }, { surfaces: [{ ...S, boundary_id: 'a\nb' }] }, { surfaces: [{ ...S, boundary_id: ' a' }] },
    { surfaces: [{ ...S, boundary_id: '' }] }, { surfaces: [{ ...S, kind: '' }] }, { surfaces: [{ ...S, path: '' }] }, { surfaces: [{ ...S, principals: [] }] },
    { surfaces: [{ ...S, principals: [7] }] }, { surfaces: [{ ...S, path: 7 }] }, { surfaces: [null] }]) {
    assert.throws(() => D.gateInput('reassess', bad), (e) => e.code === 'bad_input', J(bad));
  }
});

/** A `git diff -U0` text: a file whose added lines start with '++ ' (shown '+++ ') and '-- ' removals (shown '--- '), then a new file. */
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,3 @@', '--- removed line starting with "-- "',
  '+++ added line starting with "++ "', "+app.get('/x', h)", '@@ -9 +11 @@', '+++ b/not-a-header', '+tail',
  'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+fresh',
  'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-old'].join('\n');

test('[S23] changed-file parser: "+++ " is a file header only after "--- " and before the file\'s first hunk; an added line starting with "++ " stays added', () => {
  const m = EG.addedLinesByFile(DIFF);
  assert.deepEqual([...m.keys()].sort(), ['src/a.ts', 'src/new.ts']);
  assert.deepEqual(m.get('src/a.ts'), ['++ added line starting with "++ "', "app.get('/x', h)", '++ b/not-a-header', 'tail']);
  assert.deepEqual(m.get('src/new.ts'), ['fresh']);
});

test('pinnedSpecs: a trusted addendum\'s specs are a second pin source', () => {
  const node = { id: 'api', redSpecs: [SPEC] };
  assert.deepEqual(D.pinnedSpecs(node, undefined), { specs: [SPEC] });
  assert.deepEqual(D.pinnedSpecs(node, undefined, [SPEC2]), { specs: [SPEC2] });
  assert.equal(D.pinnedSpecs(node, [SPEC], [SPEC2]).code, 'spec_unpinned', 'the node pin never stands in for an addendum pin');
  assert.equal(D.pinnedSpecs(node, undefined, []).code, 'spec_unpinned', 'an addendum with no spec for the node pins nothing');
});

// ------------------------------------------------------------------ spec status (C7)

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-security-')));
test.after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'spec'), { recursive: true });
writeFileSync(join(root, 'spec', 'sec.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`
  + `test('passes', () => {});\ntest('skipped', { skip: 'not now' }, () => {});\ntest('later', { todo: true }, () => {});\n`
  + `test('fails', () => { assert.equal(1, 2); });\n`);
const { NODE_TEST_CONTEXT: _n, ...cleanEnv } = process.env;
const REAL_TAP = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'spec/sec.test.mjs'], { cwd: root, encoding: 'utf8', env: cleanEnv }).stdout;
const jestDoc = (statuses) => J({ testResults: [{ name: `${root}/spec/sec.test.js`, status: 'failed',
  assertionResults: Object.entries(statuses).map(([title, status]) => ({ ancestorTitles: ['sec'], title, status,
    failureMessages: status === 'failed' ? ['AssertionError: expected 1 to be 2'] : [] })) }] });
const JEST = jestDoc({ passes: 'passed', skipped: 'pending', later: 'todo', fails: 'failed' });
const VITEST = jestDoc({ passes: 'passed', skipped: 'skipped', later: 'todo', fails: 'failed' });
const spec = (format, name) => ({ file: format === 'tap' ? 'spec/sec.test.mjs' : 'spec/sec.test.js', name: format === 'tap' ? name : `sec > ${name}` });
/** The args of the command each output came from (REAL_TAP ran exactly spec/sec.test.mjs; the JSON runners locate every result). */
const ARGS = { tap: ['--test', '--test-reporter=tap', 'spec/sec.test.mjs'], 'jest-json': ['--json'], 'vitest-json': ['--reporter=json'] };

// The location shapes CI's node versions write. node 20 and later write the location as a JS string literal, so on
// Windows every backslash arrives doubled; node 18 writes an ES module's location as a file:/// URL instead.
// Canned here so every row runs on every platform; the real-TAP rows below exercise the local shape on each runner.
const winTap = (location) => ['TAP version 13', '# Subtest: fails', 'not ok 1 - fails', '  ---', '  duration_ms: 1', "  type: 'test'",
  `  location: '${location}'`, "  failureType: 'testCodeFailure'", "  error: '1 !== 2'", "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'",
  '  ...', '1..1', '# tests 1', '# pass 0', '# fail 1'].join('\n');

test('TAP adapter: a Windows failure location (backslashes doubled by node) matches its own spec file and no other', () => {
  const s = { file: 'spec/sec.test.mjs', name: 'fails' };
  const run = { format: 'tap', args: ARGS.tap };
  const at = (location) => {
    const parsed = G.parseRunnerOutput('tap', winTap(location));
    return { file: parsed.results[0].file, status: G.specStatus(s, parsed, run), red: G.findSpec(s, parsed.results).hit?.status };
  };
  // As node emits it on Windows: two backslash characters per separator.
  assert.deepEqual(at(String.raw`D:\\a\\repo\\spec\\sec.test.mjs:5:1`), { file: String.raw`D:\a\repo\spec\sec.test.mjs`, status: 'fail', red: 'fail' });
  // Twin differing in the file only: a located failure of another file is not this spec's.
  assert.deepEqual(at(String.raw`D:\\a\\repo\\spec\\other.test.mjs:5:1`), { file: String.raw`D:\a\repo\spec\other.test.mjs`, status: 'missing', red: undefined });
  assert.deepEqual(at(String.raw`D:\\a\\repo\\other\\sec.test.mjs:5:1`), { file: String.raw`D:\a\repo\other\sec.test.mjs`, status: 'missing', red: undefined });
  // Unchanged shapes: single backslashes (a runner that does not escape) and POSIX paths.
  assert.deepEqual(at(String.raw`D:\a\repo\spec\sec.test.mjs:5:1`), { file: String.raw`D:\a\repo\spec\sec.test.mjs`, status: 'fail', red: 'fail' });
  assert.deepEqual(at('/r/spec/sec.test.mjs:5:1'), { file: '/r/spec/sec.test.mjs', status: 'fail', red: 'fail' });
  assert.deepEqual(at('/r/spec/other.test.mjs:5:1'), { file: '/r/spec/other.test.mjs', status: 'missing', red: undefined });
  // UNC, as node 20+ emits it (every backslash doubled): matches its own file only.
  assert.deepEqual(at(String.raw`\\\\server\\share\\repo\\spec\\sec.test.mjs:5:1`), { file: String.raw`\\server\share\repo\spec\sec.test.mjs`, status: 'fail', red: 'fail' });
  assert.deepEqual(at(String.raw`\\\\server\\share\\repo\\spec\\other.test.mjs:5:1`), { file: String.raw`\\server\share\repo\spec\other.test.mjs`, status: 'missing', red: undefined });
  assert.deepEqual(at(String.raw`\\\\server\\share\\repo\\other\\sec.test.mjs:5:1`), { file: String.raw`\\server\share\repo\other\sec.test.mjs`, status: 'missing', red: undefined });
  // UNC with single backslashes (a runner that does not escape): fileOf's un-doubling collapses the leading '\\' to '\',
  // so the path is neither drive-rooted nor UNC and is never converted: it fails closed (missing), as does its twin.
  assert.deepEqual(at(String.raw`\\server\share\repo\spec\sec.test.mjs:5:1`), { file: String.raw`\server\share\repo\spec\sec.test.mjs`, status: 'missing', red: undefined });
  assert.deepEqual(at(String.raw`\\server\share\repo\spec\other.test.mjs:5:1`), { file: String.raw`\server\share\repo\spec\other.test.mjs`, status: 'missing', red: undefined });
  // Four backslashes per separator (escaped twice): one un-doubling leaves pairs, so it never matches (fail closed), nor does its twin.
  assert.deepEqual(at(String.raw`D:\\\\a\\\\repo\\\\spec\\\\sec.test.mjs:5:1`), { file: String.raw`D:\\a\\repo\\spec\\sec.test.mjs`, status: 'missing', red: undefined });
  assert.deepEqual(at(String.raw`D:\\\\a\\\\repo\\\\spec\\\\other.test.mjs:5:1`), { file: String.raw`D:\\a\\repo\\spec\\other.test.mjs`, status: 'missing', red: undefined });
  // node 18: an ES module's location is a file:/// URL (POSIX and Windows drive forms).
  assert.deepEqual(at('file:///r/spec/sec.test.mjs:5:1'), { file: 'file:///r/spec/sec.test.mjs', status: 'fail', red: 'fail' });
  assert.deepEqual(at('file:///r/spec/other.test.mjs:5:1'), { file: 'file:///r/spec/other.test.mjs', status: 'missing', red: undefined });
  assert.deepEqual(at('file:///r/other/sec.test.mjs:5:1'), { file: 'file:///r/other/sec.test.mjs', status: 'missing', red: undefined });
  assert.deepEqual(at('file:///D:/a/repo/spec/sec.test.mjs:5:1'), { file: 'file:///D:/a/repo/spec/sec.test.mjs', status: 'fail', red: 'fail' });
  assert.deepEqual(at('file:///D:/a/repo/spec/other.test.mjs:5:1'), { file: 'file:///D:/a/repo/spec/other.test.mjs', status: 'missing', red: undefined });
});

test('[S33] C7 path matching: a backslash converts to a separator only in a drive-rooted or UNC result path; on POSIX it is part of a file name', () => {
  const s = { file: 'spec/sec.test.mjs', name: 'fails' };
  const located = (file) => ({ supported: true, results: [{ name: 'fails', file, status: 'fail', failure_kind: 'assertion', detail: null }] });
  const rows = [
    // [result path, spec status]
    [String.raw`/r/spec\sec.test.mjs`, 'missing'], // a POSIX file literally named 'spec\sec.test.mjs' in /r
    [String.raw`spec\sec.test.mjs`, 'missing'],
    [String.raw`/r\spec\sec.test.mjs`, 'missing'],
    ['/r/spec/sec.test.mjs', 'fail'],
    [String.raw`D:\r\spec\sec.test.mjs`, 'fail'],
    [String.raw`d:\r\spec\sec.test.mjs`, 'fail'],
    [String.raw`\\srv\share\spec\sec.test.mjs`, 'fail'],
    [String.raw`D:\r\spec\other.test.mjs`, 'missing'],
    [String.raw`\\srv\share\other\sec.test.mjs`, 'missing'],
  ];
  for (const [file, want] of rows) {
    assert.equal(G.specStatus(s, located(file)), want, file);
    assert.equal(G.findSpec(s, located(file).results).hit?.status, want === 'fail' ? 'fail' : undefined, `RED: ${file}`);
  }
});

test('[S34] DAG: a pair spec file must be repository-relative and normalized (no backslash, ".", ".." or empty segment), like othersOwned', () => {
  const at = (file) => ({ file, name: SPEC.name });
  const dag = (file) => secDag([{ ...PAIR, specs: [at(file)] }], {}, { redSpecs: [at(file), SPEC2] });
  for (const file of [String.raw`src/api/x\sec.test.mjs`, 'src/api/./sec.test.mjs', 'src/api/x/../sec.test.mjs', 'src/api//sec.test.mjs']) {
    invalid(dag(file));
  }
  assert.doesNotThrow(() => valid(dag('src/api/x/sec.test.mjs')), 'the twin with a slash');
  // A trusted addendum goes through the same pair check: its backslash spec adds nothing.
  const sec = A.securityEvents(authS({ trusted: [ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'api', specs: [at(String.raw`src/api/x\y.test.mjs`)] }] })] }));
  assert.deepEqual(ids(sec), ['GET-orders:VAPT-API-01']);
  assert.equal(sec.conflicts.length, 1);
  assert.deepEqual(ids(A.securityEvents(authS({ trusted: [ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'api', specs: [at('src/api/x/y.test.mjs')] }] })] }))),
    ['GET-orders:VAPT-API-01', 'POST-orders:VAPT-API-02'], 'the twin with a slash');
});

// A nested test whose parent's name carries an escaped character ('#', '\'): node escapes it in '# Subtest:' too.
writeFileSync(join(root, 'spec', 'esc.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`
  + `test('a#b', async (t) => { await t.test('inner', () => { assert.equal(1, 2); }); await t.test('ok', () => {}); });\n`
  + `test('c\\\\d', async (t) => { await t.test('inner', () => { assert.equal(1, 2); }); await t.test('ok', () => {}); });\n`);
const ESC_TAP = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'spec/esc.test.mjs'], { cwd: root, encoding: 'utf8', env: cleanEnv }).stdout;

test('[S35] TAP adapter: a "# Subtest:" name is unescaped like a result name, so a nested spec under "a#b" or "c\\d" is found and inherits its file', () => {
  assert.match(ESC_TAP, /^# Subtest: a\\#b$/m, 'node escapes the parent name');
  const parsed = G.parseRunnerOutput('tap', ESC_TAP);
  const file = 'spec/esc.test.mjs';
  for (const parent of ['a#b', 'c\\d']) {
    assert.equal(G.specStatus({ file, name: `${parent} > inner` }, parsed), 'fail', `${parent} > inner`);
    assert.equal(G.findSpec({ file, name: `${parent} > inner` }, parsed.results).hit?.failure_kind, 'assertion', `RED ${parent} > inner`);
    assert.equal(G.specStatus({ file, name: `${parent} > ok` }, parsed), 'pass', `${parent} > ok inherits its parent's located file`);
    assert.equal(G.specStatus({ file: 'spec/other.test.mjs', name: `${parent} > ok` }, parsed), 'missing', `${parent} > ok is not another file's`);
  }
  assert.equal(G.specStatus({ file, name: String.raw`a\#b > ok` }, parsed), 'missing', 'the escaped spelling is not the name');
});

test('[S32] C7 attribution: an unlocated pass is the spec file\'s only when every option of the command is on the allowlist', () => {
  const s = { file: 'spec/a.test.mjs', name: 'x' };
  const unlocated = { supported: true, results: [{ name: 'x', file: null, status: 'pass', failure_kind: null, detail: null }] };
  const status = (opts) => G.specStatus(s, unlocated, { args: [...opts, 'spec/a.test.mjs'] });
  const refused = [
    ['--test', '--import=./other.mjs'], ['--test', '--require=./x.cjs'], ['--test', '-r=./x.cjs'], ['--test', '--loader=./l.mjs'],
    ['--test', '--experimental-loader=./l.mjs'], ['--test', '--test-reporter=./r.mjs'], ['--test', '--test-reporter=spec'],
    ['--test', '--test-reporter-destination=out.txt'], ['--test', '--test-reporter'], ['--test', '--test-shard=1/2'],
    ['--test', '--test-only'], ['--test', '--env-file=.env'], ['--test', '--experimental-test-module-mocks'], ['--test', '--unknown-flag'],
    ['--test', '--'], ['--test', '-'], ['--test', '--test-name-pattern='], ['--test', '--test-timeout='], ['--test', '--TEST'],
    ['--json'], ['--reporter=json'],
  ];
  for (const opts of refused) assert.equal(status(opts), 'missing', opts.join(' '));
  const accepted = [[], ['--test'], ['--test', '--test-reporter=tap'],
    ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-name-pattern=x', '--test-concurrency=1', '--test-timeout=5000', '--no-warnings']];
  for (const opts of accepted) assert.equal(status(opts), 'pass', opts.join(' ') || '(no options)');
});

test('[S37] C7 attribution: a command whose file argument has a backslash runs another file on POSIX, so it attributes nothing', () => {
  const s = { file: 'spec/a.test.mjs', name: 'x' };
  const unlocated = { supported: true, results: [{ name: 'x', file: null, status: 'pass', failure_kind: null, detail: null }] };
  const status = (file) => G.specStatus(s, unlocated, { args: ['--test', '--test-reporter=tap', file] });
  assert.equal(status(String.raw`spec\a.test.mjs`), 'missing');
  assert.equal(status(String.raw`.\spec\a.test.mjs`), 'missing');
  assert.equal(status('spec/a.test.mjs'), 'pass', 'the forward-slash twin');
  assert.equal(status('./spec/a.test.mjs'), 'pass', 'the forward-slash twin with ./');
});

test('[S4] C7 spec-status matrix: pass/fail/skip/todo/missing/truncated/unformatted across tap, jest and vitest; only pass proves', () => {
  assert.match(REAL_TAP, /^TAP version/m, 'real node --test TAP');
  const outputs = { tap: REAL_TAP, 'jest-json': JEST, 'vitest-json': VITEST };
  const want = { passes: 'pass', fails: 'fail', skipped: 'skip', later: 'skip', absent: 'missing' };
  for (const [format, stdout] of Object.entries(outputs)) {
    const parsed = G.parseRunnerOutput(format, stdout);
    assert.equal(parsed.supported, true, format);
    const run = { format, stdout, args: ARGS[format] };
    for (const [name, status] of Object.entries(want)) {
      const s = spec(format, name);
      assert.equal(G.specStatus(s, parsed, run), status, `${format} ${name}`);
      const [r] = G.specResults([s], [run]);
      assert.deepEqual(r, { ...s, status }, `${format} ${name} via specResults`);
    }
    const s = spec(format, 'passes');
    assert.equal(G.specResults([s], [{ ...run, truncated: true }])[0].status, 'unparsed', `${format} truncated`);
    assert.equal(G.specResults([s], [{ ...run, stdout: 'Tests: 1 passed\nok' }])[0].status, 'unparsed', `${format} unformatted`);
    assert.equal(G.specStatus(s, G.parseRunnerOutput(format, 'not runner output'), run), 'unparsed');
  }
  assert.equal(G.specStatus(spec('tap', 'passes'), null), 'unparsed');
});

// A realistic decoy (the review's reproduction): the spec file imports code that exits 0 at load, so its test never
// runs, and another file passes a test of the same name. node's TAP locates failures, never passes.
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'spec', 'x.test.mjs'), `import test from 'node:test';\nimport fs from 'node:fs';\n`
  + `if (fs.existsSync(new URL('../src/hook.mjs', import.meta.url))) await import('../src/hook.mjs');\ntest('X-1', () => {});\n`);
writeFileSync(join(root, 'spec', 'decoy.test.mjs'), `import test from 'node:test';\ntest('X-1', () => {});\n`);
const tapOf = (args, hook) => {
  if (hook) writeFileSync(join(root, 'src', 'hook.mjs'), 'process.exit(0);\n'); else rmSync(join(root, 'src', 'hook.mjs'), { force: true });
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: cleanEnv });
  assert.equal(r.status, 0, `${args.join(' ')}: the runner exits 0 (${r.stderr})`);
  return r.stdout;
};
const XSPEC = { file: 'spec/x.test.mjs', name: 'X-1' };
const BOTH = ['--test', '--test-reporter=tap', 'spec/x.test.mjs', 'spec/decoy.test.mjs'];
const ALONE = ['--test', '--test-reporter=tap', 'spec/x.test.mjs'];
const DECOY_TAP = tapOf(BOTH, true);
const OWN_TAP = tapOf(ALONE, false);

test('[S19] C7 attribution: an unlocated same-named pass from another file is missing; a pass of the spec\'s own file proves (tap)', () => {
  const decoy = G.parseRunnerOutput('tap', DECOY_TAP);
  assert.deepEqual(decoy.results.filter(r => r.name === 'X-1').map(r => [r.status, r.file]), [['pass', null]], 'one unlocated same-named pass: the decoy\'s');
  assert.equal(G.findSpec(XSPEC, decoy.results).hit?.status, 'pass', 'the legacy RED matcher (unlocated fallback) is unchanged');
  assert.equal(G.specStatus(XSPEC, decoy, { format: 'tap', stdout: DECOY_TAP, args: BOTH }), 'missing', 'a command over two files attributes no unlocated pass');
  assert.equal(G.specResults([XSPEC], [{ format: 'tap', stdout: DECOY_TAP, args: BOTH }])[0].status, 'missing');
  assert.equal(G.specStatus(XSPEC, decoy), 'missing', 'no command context is no attribution');
  assert.equal(G.specResults([XSPEC], [{ format: 'tap', stdout: DECOY_TAP }])[0].status, 'missing');
  const decoyOnly = tapOf(['--test', '--test-reporter=tap', 'spec/decoy.test.mjs'], false);
  assert.equal(G.specResults([XSPEC], [{ format: 'tap', stdout: decoyOnly, args: ['--test', '--test-reporter=tap', 'spec/decoy.test.mjs'] }])[0].status, 'missing',
    'a run of exactly another file');
  // Positive twin: the spec file alone, its test runs and passes.
  const own = { format: 'tap', stdout: OWN_TAP };
  for (const args of [ALONE, ['--test', '--test-reporter=tap', './spec/x.test.mjs']]) {
    assert.equal(G.specResults([XSPEC], [{ ...own, args }])[0].status, 'pass', args.join(' '));
  }
  for (const args of [['--test', '--test-reporter', 'tap', 'spec/x.test.mjs'], ['--test', 'spec/*.test.mjs'], ['--test', 'spec'], ['--test'], ['--test', '/abs/spec/x.test.mjs']]) {
    assert.equal(G.specResults([XSPEC], [{ ...own, args }])[0].status, 'missing', `not exactly the spec file: ${args.join(' ')}`);
  }
  // A located pass needs no command context; fail and skip are never upgraded by attribution.
  assert.equal(G.specStatus({ file: 'spec/sec.test.mjs', name: 'fails' }, G.parseRunnerOutput('tap', REAL_TAP)), 'fail');
  assert.equal(G.specStatus({ file: 'spec/sec.test.mjs', name: 'skipped' }, G.parseRunnerOutput('tap', REAL_TAP)), 'skip');
});

test('[S19] C7 attribution: the same rows in the jest and vitest shapes (located other file, unlocated, own file)', () => {
  const S = { file: 'spec/x.test.js', name: 'X-1' };
  const doc = (suite) => J({ testResults: [{ name: suite, status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'X-1', status: 'passed', failureMessages: [] }] }] });
  for (const format of ['jest-json', 'vitest-json']) {
    const status = (stdout, args) => G.specResults([S], [{ format, stdout, ...(args ? { args } : {}) }])[0].status;
    assert.equal(status(doc(`${root}/spec/decoy.test.js`)), 'missing', `${format}: a located pass of another file`);
    assert.equal(status(doc('')), 'missing', `${format}: an unlocated pass, no command context`);
    assert.equal(status(doc(''), ['--json', 'spec/decoy.test.js']), 'missing', `${format}: an unlocated pass of a run of another file`);
    assert.equal(status(doc(''), ['--json', 'spec/x.test.js', 'spec/decoy.test.js']), 'missing', `${format}: an unlocated pass of a run of two files`);
    assert.equal(status(doc(`${root}/spec/x.test.js`)), 'pass', `${format}: the spec's own located file`);
    // '--json' is not on the attribution allowlist (node --test options only), so even a run of exactly the spec file
    // attributes no unlocated pass; the jest and vitest shapes locate every result through the suite name.
    assert.equal(status(doc(''), ['--json', 'spec/x.test.js']), 'missing', `${format}: an unlocated pass of a run with an option off the allowlist`);
    assert.equal(status(doc(''), ['spec/x.test.js']), 'pass', `${format}: an unlocated pass of a run of exactly the spec file, no option`);
  }
});

test('[S4] C7 combination across formatted commands: fail > skip > unparsed > pass > missing', () => {
  const s = spec('tap', 'passes');
  const PASS = { format: 'tap', stdout: REAL_TAP, args: ARGS.tap };
  const OTHER = { format: 'jest-json', stdout: JEST }; // a different runner: the TAP spec is missing there
  const as = (status) => ({ format: 'jest-json', stdout: J({ testResults: [{ name: `${root}/spec/sec.test.mjs`, assertionResults:
    [{ ancestorTitles: [], title: 'passes', status, failureMessages: status === 'failed' ? ['AssertionError: x'] : [] }] }] }) });
  const status = (runs) => G.specResults([s], runs)[0].status;
  assert.equal(status([PASS, OTHER]), 'pass', 'missing elsewhere does not unprove a pass');
  assert.equal(status([PASS, as('failed')]), 'fail');
  assert.equal(status([PASS, as('pending')]), 'skip');
  assert.equal(status([PASS, { format: 'jest-json', stdout: 'oops' }]), 'unparsed');
  assert.equal(status([OTHER]), 'missing');
  assert.equal(status([]), 'missing', 'no formatted command proves nothing');
  assert.equal(G.specResults([], [PASS]).length, 0);
});

test('findSpec matches a LOCATED result by its file (a path ending in the spec path), and an UNLOCATED one only as the RED fallback; spec status attributes an unlocated pass only to a run of exactly the spec file', () => {
  const located = [{ name: 'x', file: 'other/a.test.mjs', status: 'pass', failure_kind: null }];
  assert.equal(G.findSpec({ file: 'spec/a.test.mjs', name: 'x' }, located).hit, undefined, 'a located result of another file never matches');
  assert.equal(G.specStatus({ file: 'spec/a.test.mjs', name: 'x' }, { supported: true, results: located }), 'missing');
  assert.equal(G.findSpec({ file: 'a.test.mjs', name: 'x' }, located).hit?.status, 'pass', 'a located path ending in the spec path matches');
  // The realistic unlocated shape (node TAP never locates a pass): RED's fallback still finds it (unchanged), spec status does not.
  const unlocated = [{ name: 'x', file: null, status: 'pass', failure_kind: null }];
  assert.equal(G.findSpec({ file: 'spec/a.test.mjs', name: 'x' }, unlocated).hit?.status, 'pass', 'legacy RED fallback');
  assert.equal(G.specStatus({ file: 'spec/a.test.mjs', name: 'x' }, { supported: true, results: unlocated }), 'missing', 'no attribution');
  assert.equal(G.specStatus({ file: 'spec/a.test.mjs', name: 'x' }, { supported: true, results: unlocated }, { args: ['--test', 'spec/b.test.mjs'] }), 'missing');
  assert.equal(G.specStatus({ file: 'spec/a.test.mjs', name: 'x' }, { supported: true, results: unlocated }, { args: ['--test', 'spec/a.test.mjs'] }), 'pass');
});

// ------------------------------------------------------------------ gateRed slot

const RED_TAP = `TAP version 13
# Subtest: addendum spec
not ok 1 - addendum spec
  ---
  duration_ms: 0.1
  type: 'test'
  location: '/repo/src/api/add.test.mjs:3:1'
  failureType: 'testCodeFailure'
  error: 'x'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  ...
1..1
`;
function fakeDeps(stdout = RED_TAP) {
  let n = 0;
  return { platform: 'linux', newAttemptId: () => `att-${++n}`, commit: () => {}, digestFile: (p) => `sha256:digest-of-${p}`, isGroupAlive: () => false,
    spawnRunner: () => { let release; const released = new Promise((r) => { release = r; });
      return { pid: 4101, pgid: 4100, release: () => release(), done: released.then(() => ({ exitCode: 1, stdout, stderr: '', timedOut: false, quiescent: true })) }; } };
}
const redState = () => ({ run_id: 'run-1', seq: 3, nodes: { api: { deps: [], phase: 'BUILD' }, web: { deps: ['api'], phase: 'BUILD' } },
  events: [{ seq: 1, type: 'DISPATCH', node: 'api' }, { seq: 2, type: 'COMPLETE', node: 'api' }, { seq: 3, type: 'DISPATCH', node: 'web' }],
  attempts: [], locks: {}, gates: { red: { api: { node: 'api', specs: [SPEC] } } } });
const ADD_SPEC = { file: 'src/api/add.test.mjs', name: 'addendum spec' };
const redIn = (over = {}) => ({ state: redState(), node: 'api', command: { cmd: 'node', args: [] }, format: 'tap', specs: [ADD_SPEC],
  baselineCandidate: 'sha256:base', timeoutMs: 1000, resources: [], ...over });

test('[S5] gateRed: the red_addendum slot records apart from node RED and skips dispatched_before_red; the default slot is unchanged', async () => {
  const legacy = await G.gateRed(redIn(), fakeDeps());
  assert.equal(legacy.code, 'dispatched_before_red', 'default slot: a dependent dispatched before RED');
  const v = await G.gateRed(redIn({ slot: { map: 'red_addendum', key: 'add-1/api' } }), fakeDeps());
  assert.equal(v.code, 'red_accepted', J(v.reasons));
  assert.deepEqual(v.state.gates.red_addendum['add-1/api'].specs, [ADD_SPEC]);
  assert.deepEqual(v.state.gates.red.api, { node: 'api', specs: [SPEC] }, 'node RED untouched');
  await assert.rejects(G.gateRed(redIn({ slot: { map: 'red_other', key: 'x' } }), fakeDeps()), TypeError, 'an unknown slot is a programmer error');
});

// ------------------------------------------------------------------ gateShipReady control_unproven

const PINNED = ['.specs/plans/AIS-1.md', 'session-log.md'];
const shipState = (over = {}) => ({ ticket: 'AIS-1', pinned_exclusions: [...PINNED],
  review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: 'c1' }],
  local_proof: { candidate_id: 'c1', commands: [{ cmd: 'node', result: 'pass' }] }, ...over });
const current = (over = {}) => ({ candidate_id: 'c1', exclusions: [...PINNED], artifact_digests: {}, ...over });
const pair = (boundary, control, proven) => ({ boundary, control, proven });

test('[S6] gateShipReady: no control_pairs is the legacy verdict byte for byte', () => {
  assert.equal(J(G.gateShipReady({ state: shipState(), current: current() })),
    J({ ok: true, code: 'ship_ready', reasons: [], missing: [], event: { type: 'SHIP_READY', candidate_id: 'c1' } }));
  assert.equal(J(G.gateShipReady({ state: shipState(), current: current({ control_pairs: [] }) })),
    J({ ok: true, code: 'ship_ready', reasons: [], missing: [], event: { type: 'SHIP_READY', candidate_id: 'c1' } }), 'an empty assessment');
});

test('[S6] C10 gateShipReady: two pairs, one proven -> control_unproven names only the other', () => {
  const r = G.gateShipReady({ state: shipState(), current: current({ control_pairs: [pair('a', 'VAPT-API-01', true), pair('b', 'VAPT-WEB-01', false)] }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'control_unproven');
  assert.deepEqual(r.missing, ['b:VAPT-WEB-01-spec']);
  const all = G.gateShipReady({ state: shipState(), current: current({ control_pairs: [pair('a', 'VAPT-API-01', true), pair('b', 'VAPT-WEB-01', true)] }) });
  assert.equal(all.ok, true);
  assert.equal(G.gateShipReady({ state: shipState(), current: current({ control_pairs: [pair('a', 'VAPT-API-01', 'yes')] }) }).code, 'control_unproven', 'only true proves');
  assert.equal(G.gateShipReady({ state: shipState(), current: current({ control_pairs: 'x' }) }).code, 'control_unproven', 'malformed pairs fail closed');
});

test('[S7] C8 gateShipReady: control_unproven is evaluated only once the proof holds, and after every legacy reason', () => {
  const unproven = { control_pairs: [pair('a', 'VAPT-API-01', false)] };
  const noProof = G.gateShipReady({ state: shipState({ local_proof: undefined }), current: current(unproven) });
  assert.deepEqual(noProof.reasons, ['missing_local_proof'], 'the first call only lacks the proof, so the engine runs it');
  const both = G.gateShipReady({ state: shipState({ review_chain: [] }), current: current(unproven) });
  assert.deepEqual(both.reasons, ['review_not_accepted', 'control_unproven']);
  assert.equal(both.code, 'review_not_accepted', 'legacy reasons[0] unchanged');
});

// ------------------------------------------------------------------ authority

const line = (e) => J(e);
const authS = ({ trusted = [], untrusted = [], coverage = [PAIR], nodes } = {}) => ({ run_id: 'run-1',
  config: { securityPolicy: 2, controlCoverage: coverage },
  nodes: nodes ?? { api: { id: 'api', writes: ['src/api'], redSpecs: [SPEC, SPEC2] }, web: { id: 'web', writes: ['src/web'], redSpecs: [] } },
  authority: { through: 0, trusted: trusted.map(line), untrusted: untrusted.map(e => ({ line: line(e), seq: 1 })) } });
const ADD = (over = {}) => ({ run_id: 'run-1', event: 'SECURITY_ADDENDUM', addendum_id: 'add-1', authorized_by: 'owner', reason: 'reassess ADD_CONTROLS',
  pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'api', specs: [SPEC2] }], ...over });
const WAIVE = (over = {}) => ({ run_id: 'run-1', event: 'SECURITY_WAIVER', boundary: 'GET-orders', control: 'VAPT-API-01', candidate: 'c1',
  policy_version: 2, authorized_by: 'owner', reason: 'accepted risk', ...over });
const ids = (sec) => sec.pairs.map(p => `${p.boundary}:${p.control}`);

test('run-state: SECURITY_ADDENDUM and SECURITY_WAIVER are owner authority (a worker append is refused); SECURITY_REASSESSED is not', () => {
  assert.ok(R.AUTHORITY_EVENTS.includes('SECURITY_ADDENDUM') && R.AUTHORITY_EVENTS.includes('SECURITY_WAIVER'));
  assert.equal(R.AUTHORITY_EVENTS.includes('SECURITY_REASSESSED'), false);
  const before = `# P\n${R.BEGIN}\n{"event":"START"}\n${R.END}\n`;
  const add = (e) => before.replace(R.END, J(e) + '\n' + R.END);
  assert.equal(R.workerRunStateAppend(before, add(WAIVE())), false);
  assert.equal(R.workerRunStateAppend(before, add(ADD())), false);
  assert.equal(R.workerRunStateAppend(before, add({ event: 'SECURITY_REASSESSED', candidate_id: 'c1' })), true);
});

test('[S8] securityEvents: trusted addenda union into the effective pairs; untrusted ones are forged, never effective', () => {
  assert.deepEqual(ids(A.securityEvents(authS())), ['GET-orders:VAPT-API-01']);
  const sec = A.securityEvents(authS({ trusted: [ADD()] }));
  assert.deepEqual(ids(sec), ['GET-orders:VAPT-API-01', 'POST-orders:VAPT-API-02']);
  assert.equal(sec.pairs[1].addendum, 'add-1');
  assert.deepEqual(sec.addenda.map(a => a.addendum_id), ['add-1']);
  const forged = A.securityEvents(authS({ untrusted: [ADD()] }));
  assert.deepEqual(ids(forged), ['GET-orders:VAPT-API-01']);
  assert.equal(forged.forged.addenda.length, 1);
  assert.equal(A.securityEvents(authS({ trusted: [ADD({ run_id: 'run-0' })] })).pairs.length, 1, 'another run is ignored');
  assert.equal(A.securityEvents(authS({ trusted: [ADD(), ADD()] })).conflicts.length, 0, 'the same bytes twice are one addendum');
});

test('[S9] securityEvents: addendum_conflict (same id other bytes, pair already effective, spec shared) and addendum_outside_contract', () => {
  const conflict = (trusted) => A.securityEvents(authS({ trusted })).conflicts.length;
  const outside = (trusted) => A.securityEvents(authS({ trusted })).outside.length;
  assert.equal(conflict([ADD()]), 0);
  assert.equal(conflict([ADD(), ADD({ reason: 'other bytes' })]), 1, 'same addendum_id, different bytes');
  assert.equal(conflict([ADD({ pairs: [{ ...PAIR, specs: [SPEC2] }] })]), 1, 'a pair already effective');
  assert.equal(conflict([ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'api', specs: [SPEC] }] })]), 1, 'a spec shared with an effective pair');
  assert.equal(conflict([ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-XSS-02', node: 'api', specs: [SPEC2] }] })]), 1, 'a malformed pair');
  assert.equal(outside([ADD()]), 0);
  assert.equal(outside([ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'nope', specs: [SPEC2] }] })]), 1, 'unknown node');
  assert.equal(outside([ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'web', specs: [SPEC2] }] })]), 1, 'spec outside the node writes');
  const bad = A.securityEvents(authS({ trusted: [ADD({ pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'web', specs: [SPEC2] }] })] }));
  assert.deepEqual(ids(bad), ['GET-orders:VAPT-API-01'], 'a refused addendum adds nothing');
});

test('[S24] securityEvents: an addendum needs authorized_by and a reason (like a waiver); without either it adds nothing (addendum_conflict)', () => {
  for (const over of [{ reason: undefined }, { reason: '' }, { authorized_by: undefined }, { authorized_by: '' }]) {
    const sec = A.securityEvents(authS({ trusted: [ADD(over)] }));
    assert.deepEqual(ids(sec), ['GET-orders:VAPT-API-01'], J(over));
    assert.equal(sec.conflicts.length, 1, J(over));
  }
  assert.deepEqual(ids(A.securityEvents(authS({ trusted: [ADD()] }))), ['GET-orders:VAPT-API-01', 'POST-orders:VAPT-API-02'], 'the twin with both');
});

test('[S10] waiverState: effective only when trusted, for the current candidate, for an effective pair; a matching untrusted one is unauthorized', () => {
  const state = (o) => { const S = authS(o); return A.waiverState(S, A.securityEvents(S), 'c1'); };
  assert.deepEqual(state({ trusted: [WAIVE()] }), { waived: ['GET-orders:VAPT-API-01'], unauthorized: [] });
  assert.deepEqual(state({ trusted: [WAIVE({ candidate: 'c0' })] }), { waived: [], unauthorized: [] }, 'another candidate');
  assert.deepEqual(state({ trusted: [WAIVE({ control: 'VAPT-API-09' })] }), { waived: [], unauthorized: [] }, 'not an effective pair');
  assert.deepEqual(state({ trusted: [WAIVE({ policy_version: 1 })] }), { waived: [], unauthorized: [] }, 'another policy');
  assert.deepEqual(state({ trusted: [WAIVE({ authorized_by: '' })] }), { waived: [], unauthorized: [] }, 'no authorizer');
  assert.deepEqual(state({ untrusted: [WAIVE()] }), { waived: [], unauthorized: ['GET-orders:VAPT-API-01'] });
  assert.deepEqual(state({ untrusted: [WAIVE({ candidate: 'c0' })] }), { waived: [], unauthorized: [] }, 'a stale forged waiver is irrelevant');
});
