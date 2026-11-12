/**
 * RED specs for the gate verifier (AIS-HARNESS-2 plan P0-2, P1-5, acceptance 6
 * and the round-3 runner-crash requirement r3-1).
 *
 * API CONTRACT the `gate` node implements (scripts/gate.mjs). Gate decisions
 * never throw for a refusal: they RETURN `{ ok, code, ... }`. Only programmer
 * errors (an unknown risk label) throw.
 *
 * parseRunnerOutput(format, text)
 *   format: 'tap' (node --test TAP, nested subtests) | 'vitest-json' | 'jest-json'.
 *   -> { supported: true, results: [{ name, file, status, failure_kind, detail }] }
 *      name    full title path joined with ' > ' ('outer > inner fails'); for a
 *              file that failed to load, the file name as the runner printed it.
 *      file    test file path (TAP: from `location`, path part only; jest/vitest:
 *              testResults[].name).
 *      status  'pass' | 'fail' | 'skip'.
 *      failure_kind (null when status !== 'fail'):
 *              'assertion' node ERR_ASSERTION / AssertionError, jest/vitest expect
 *                          or matcher failures;
 *              'runtime'   any other error thrown in a test body (TypeError, ...);
 *              'load'      the file never ran its tests: ERR_MODULE_NOT_FOUND,
 *                          SyntaxError/compile/transform, "Test suite failed to run";
 *              'subtests'  a TAP parent that failed only because subtests failed.
 *      detail  for 'load': the runner's diagnostic text (for TAP, the `#` comment
 *              lines printed before the file-level `not ok`), e.g. contains
 *              'ERR_MODULE_NOT_FOUND' or 'SyntaxError'.
 *   -> { supported: false, reason } for an unknown format or output that is not
 *      valid for the format. Never throws.
 *
 * gateRed(input, deps) -> Promise<result>        (the engine's RED gate run)
 *   input: { state, node, command:{cmd,args}, format, specs:[{file,name}],
 *            baselineCandidate, timeoutMs, resources:[string] }
 *   state: { run_id, seq, nodes:{[id]:{deps,phase,role}}, events:[{seq,type,node}],
 *            attempts:[attempt], locks:{[resource]:attempt_id}, gates:{red:{}} }
 *   attempt: { attempt_id, kind:'gate-red', node, status:'intent'|'running'|'exited',
 *              pid?, pgid?, resources, envelope?:{exitCode,timedOut} }
 *   deps: { newAttemptId(), commit(state) (one durable state commit; receives a
 *           snapshot), digestFile(path), isGroupAlive(pgid) -> true|false|null
 *           (null = unknown), platform, spawnRunner({attempt_id,command,timeoutMs,
 *           resources}) -> { pid, pgid, release(), done: Promise<{exitCode,stdout,
 *           stderr,timedOut,quiescent}> } (launcher blocks until release();
 *           quiescent is true only when the runner's whole group is proven gone),
 *           verifyBinding?() -> [judgment] (re-checked after the run and before any
 *           evidence is committed; non-empty -> RED_DROPPED, that judgment's code) }
 *   An attempt becomes 'exited' (and releases locks) only through engine-quiesce.mjs
 *   retire(): its group proven gone, or it never recorded a pid.
 *   Durable attempt protocol, in order: commit(intent, locks taken) -> spawnRunner
 *   -> commit(pid+pgid, status running) -> release() -> await done ->
 *   commit(envelope, locks released, verdict). A run whose `quiescent` is not true
 *   is refused 'quiescence_unknown' (judgment point): status 'unknown', locks kept,
 *   no verdict and no evidence.
 *   Before spawning, every earlier attempt with no envelope is reconciled on its
 *   process GROUP (isGroupAlive(pgid)): alive -> 'runner_alive' (no spawn, lock
 *   kept); null on win32 -> 'quiescence_unknown' judgment point; gone -> its lock
 *   is reclaimed and the run proceeds. A resource held by another live attempt ->
 *   'resource_locked'.
 *   result: { ok, code, judgment_point, degraded, reasons:[string], evidence?, state }
 *   codes: 'red_accepted' | 'spec_not_failing' | 'non_assertion_failure' |
 *          'spec_missing' | 'unsupported_output' | 'dispatched_before_red' |
 *          'runner_alive' | 'quiescence_unknown' | 'resource_locked' |
 *          'runner_timeout' | 'no_baseline'
 *   Acceptance needs EVERY named spec to fail with failure_kind 'assertion'.
 *   evidence: { node, attempt_id, seq (> every prior event seq), format,
 *               baseline_candidate, spec_digests:{[file]:digest}, specs }
 *   A timeout is never re-run automatically.
 *
 * gateReview(input, policy?) -> { ok, code, reasons, record?, repair? }
 *   policy (engine-set, never from an input; default the final review's): { secondOpinion:
 *     'required' | 'optional', confirmationSecondOpinion: 'none' | 'optional' | 'required' }.
 *     'optional' validates a second opinion only when present (record.second_opinion_route null
 *     without one); a confirmation second opinion has the confirmation shape plus `route`, and the
 *     record's outcome is PASS only when both are (engine-unit-review.mjs unit reviews).
 *     `recordVerdicts: true` (W3-record, engine-set from config.auditRecord) only appends keys to an
 *     accepted record: an original gets primary_outcome, second_opinion_outcome,
 *     second_opinion_identity and reconciliation (reconciliation.summary, a string cut to 2000
 *     characters, else null); a confirmation gets primary_outcome. Decisions never change.
 *   input (kind 'original'): { state, review_execution, kind, primary (the full
 *     review.md output contract), second_opinion:{route,reviewer_identity,
 *     candidate_id,findings,overflow,outcome}, reconciliation:{dispositions:
 *     [{finding_id,source,disposition}]}, graded_artifacts:{parity?:digest},
 *     repair_ownership:[path] }
 *   input (kind 'confirmation'): { state, review_execution, kind, primary:
 *     { reviewer_identity, candidate_id, checked_findings:[id], outcome, evidence } }
 *   state: { frozen_candidate, builders:[{node,identity}], review_chain:[record] }
 *   record: { review_execution, kind:'original'|'repair'|'confirmation', outcome,
 *     candidate_id, reviewer_identity, second_opinion_route?, graded_artifacts?,
 *     fix_findings?:[id], findings?:[{id, source, severity, paths:[path], disposition}],
 *     write_set?:[path], overflow? }  (repair records: { review_execution, kind:'repair',
 *     old_candidate, new_candidate, write_set })
 *   An accepted original always records findings[] (primary + second opinion,
 *   severity 'unknown' only for a second-opinion finding without one) and
 *   write_set (the repair write set; [] when no repair opens). Primary findings
 *   need a severity. A finding names `path` or `paths[]`.
 *   codes: 'review_accepted' | 'incomplete_contract' | 'reviewer_is_builder' |
 *     'stale_candidate' | 'missing_second_opinion' | 'second_opinion_unusable' |
 *     'missing_reconciliation' | 'outcome_inconsistent' | 'chain_broken' |
 *     'confirmation_spent' | 'review_terminal'
 *   An accepted FAIL with 'fix' dispositions returns repair:{review_execution,
 *   write_set} = sorted union of the fixed findings' paths and repair_ownership.
 *   Overflow on either reviewer: PASS is 'outcome_inconsistent'; a FAIL is recorded
 *   (overflow: true, write_set []) as 'review_terminal' { ok, judgment_point: true,
 *   terminal: true } and opens no repair (only an authorized retry continues).
 *   A builder identity '<provider>:provider-default' (unresolved model) matches every
 *   '<provider>:...' reviewer ('reviewer_is_builder').
 *
 * gateShipReady({ state, current }) -> { ok, code, reasons:[code], missing:[kind], event? }
 *   state: { ticket, pinned_exclusions, review_chain, local_proof:{candidate_id,
 *     commands:[{cmd,result}]}, risk_labels, risk_evidence:[{kind,path,red_accepted?,exists?}]
 *     (exists: false, bound by the engine, refuses a non-spec kind),
 *     config?:{riskLabels}, nodes?:{[id]:{risk}} }  (labels = union of all three)
 *   current: { candidate_id, exclusions, artifact_digests:{parity?} }
 *   reasons: 'candidate_mismatch' | 'exclusions_altered' | 'artifact_changed' |
 *     'missing_risk_evidence' | 'missing_local_proof' | 'review_not_accepted'
 *   ok -> code 'ship_ready', event { type:'SHIP_READY', candidate_id }; else no event.
 *   Exclusions must be exactly ['.specs/plans/<ticket>.md', 'session-log.md']
 *   (order-insensitive, byte-exact strings) in both the pin and the current check.
 *   Risk evidence: every kind from requiredEvidence(risk_labels) needs an entry
 *   with a path; kinds ending in '-spec' also need red_accepted: true.
 *
 * requiredEvidence(labels) -> sorted unique evidence kinds; additive; throws
 *   TypeError /unknown risk label/ for a label outside the table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerOutput, gateRed, gateReview, gateShipReady, requiredEvidence } from './gate.mjs';

// ---------------------------------------------------------------------------
// Fixtures: node --test TAP captured from Node 22 (temp paths replaced by /repo)

const TAP = `TAP version 13
# Subtest: outer
    # Subtest: inner fails
    not ok 1 - inner fails
      ---
      duration_ms: 0.538792
      type: 'test'
      location: '/repo/a.test.mjs:2:38'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 2
      actual: 1
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///repo/a.test.mjs:2:71)
        Test.runInAsyncScope (node:async_hooks:214:14)
      ...
    # Subtest: inner passes
    ok 2 - inner passes
      ---
      duration_ms: 0.245625
      type: 'test'
      ...
    # Subtest: inner throws
    not ok 3 - inner throws
      ---
      duration_ms: 0.095
      type: 'test'
      location: '/repo/a.test.mjs:2:133'
      failureType: 'testCodeFailure'
      error: 'boom'
      code: 'ERR_TEST_FAILURE'
      name: 'TypeError'
      stack: |-
        TestContext.<anonymous> (file:///repo/a.test.mjs:2:168)
      ...
    1..3
not ok 1 - outer
  ---
  duration_ms: 1.669625
  type: 'test'
  location: '/repo/a.test.mjs:2:1'
  failureType: 'subtestsFailed'
  error: '2 subtests failed'
  code: 'ERR_TEST_FAILURE'
  ...
# node:internal/modules/esm/resolve:275
#     throw new ERR_MODULE_NOT_FOUND(
#           ^
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/missing.mjs' imported from /repo/b.test.mjs
#     at finalizeResolution (node:internal/modules/esm/resolve:275:11)
#   code: 'ERR_MODULE_NOT_FOUND',
#   url: 'file:///repo/missing.mjs'
# }
# Node.js v22.23.1
# Subtest: b.test.mjs
not ok 2 - b.test.mjs
  ---
  duration_ms: 25.138208
  type: 'test'
  location: '/repo/b.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
# file:///repo/c.test.mjs:1
# const = ;
#       ^
# SyntaxError: Unexpected token '='
#     at compileSourceTextModule (node:internal/modules/esm/utils:346:16)
# Node.js v22.23.1
# Subtest: c.test.mjs
not ok 3 - c.test.mjs
  ---
  duration_ms: 23.755083
  type: 'test'
  location: '/repo/c.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..3
# tests 6
# suites 0
# pass 1
# fail 5
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40.60525
`;

// vitest --reporter=json and jest --json: schema-derived (jest-shaped
// testResults[].assertionResults[]); neither runner is a dependency here.
const VITEST = JSON.stringify({
  numTotalTestSuites: 3, numPassedTestSuites: 0, numFailedTestSuites: 3, numPendingTestSuites: 0,
  numTotalTests: 3, numPassedTests: 1, numFailedTests: 2, numPendingTests: 0, numTodoTests: 0,
  startTime: 1762333200000, success: false,
  testResults: [
    {
      assertionResults: [
        { ancestorTitles: ['gate'], fullName: 'gate refuses stale candidate', status: 'failed', title: 'refuses stale candidate',
          duration: 3, failureMessages: ['AssertionError: expected true to be false // Object.is equality\n    at /repo/src/gate.test.ts:9:22'],
          location: { line: 9, column: 5 }, meta: {} },
        { ancestorTitles: ['gate'], fullName: 'gate passes', status: 'passed', title: 'passes', duration: 1, failureMessages: [], meta: {} },
        { ancestorTitles: ['gate'], fullName: 'gate throws', status: 'failed', title: 'throws', duration: 1,
          failureMessages: ["TypeError: Cannot read properties of undefined (reading 'id')\n    at /repo/src/gate.test.ts:20:9"], meta: {} },
      ],
      startTime: 1762333200100, endTime: 1762333200200, status: 'failed', message: '', name: '/repo/src/gate.test.ts',
    },
    { assertionResults: [], startTime: 1762333200100, endTime: 1762333200150, status: 'failed',
      message: 'Failed to load url ./missing (resolved id: ./missing) in /repo/src/load.test.ts. Does the file exist?',
      name: '/repo/src/load.test.ts' },
    { assertionResults: [], startTime: 1762333200100, endTime: 1762333200150, status: 'failed',
      message: 'Transform failed with 1 error:\n/repo/src/syntax.test.ts:1:6: ERROR: Expected identifier but found "="',
      name: '/repo/src/syntax.test.ts' },
  ],
});

const JEST = JSON.stringify({
  numFailedTestSuites: 3, numFailedTests: 2, numPassedTestSuites: 0, numPassedTests: 1, numPendingTestSuites: 0,
  numPendingTests: 0, numRuntimeErrorTestSuites: 2, numTotalTestSuites: 3, numTotalTests: 3, startTime: 1762333200000, success: false,
  testResults: [
    {
      assertionResults: [
        { ancestorTitles: ['gate'], fullName: 'gate refuses stale candidate', status: 'failed', title: 'refuses stale candidate', duration: 4,
          failureDetails: [{ matcherResult: { actual: true, expected: false, message: 'expect(received).toBe(expected)', name: 'toBe', pass: false } }],
          failureMessages: ['Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: false\nReceived: true\n    at Object.toBe (/repo/gate.test.js:9:22)'],
          location: null },
        { ancestorTitles: ['gate'], fullName: 'gate passes', status: 'passed', title: 'passes', duration: 1, failureDetails: [], failureMessages: [], location: null },
        { ancestorTitles: ['gate'], fullName: 'gate throws', status: 'failed', title: 'throws', duration: 1, failureDetails: [{}],
          failureMessages: ["TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (/repo/gate.test.js:20:9)"],
          location: null },
      ],
      endTime: 1762333200200, message: '', name: '/repo/gate.test.js', startTime: 1762333200100, status: 'failed', summary: '',
    },
    { assertionResults: [], endTime: 1762333200150, name: '/repo/load.test.js', startTime: 1762333200100, status: 'failed', summary: '',
      message: "  ● Test suite failed to run\n\n    Cannot find module './missing' from 'load.test.js'\n\n      at Resolver._throwModNotFoundError (node_modules/jest-resolve/build/resolver.js:427:11)" },
    { assertionResults: [], endTime: 1762333200150, name: '/repo/syntax.test.js', startTime: 1762333200100, status: 'failed', summary: '',
      message: '  ● Test suite failed to run\n\n    Jest encountered an unexpected token\n\n    SyntaxError: /repo/syntax.test.js: Unexpected token (1:6)' },
  ],
});

const byName = (parsed, name) => {
  const hit = parsed.results.find((r) => r.name === name);
  assert.ok(hit, `no result named ${JSON.stringify(name)} in ${JSON.stringify(parsed.results.map((r) => r.name))}`);
  return hit;
};

// ---------------------------------------------------------------------------
// parseRunnerOutput

test('TAP adapter: nested subtests are addressed by joined path and classified', () => {
  const p = parseRunnerOutput('tap', TAP);
  assert.equal(p.supported, true);
  assert.deepEqual(
    { ...byName(p, 'outer > inner fails'), detail: undefined },
    { name: 'outer > inner fails', file: '/repo/a.test.mjs', status: 'fail', failure_kind: 'assertion', detail: undefined },
  );
  assert.equal(byName(p, 'outer > inner passes').status, 'pass');
  assert.equal(byName(p, 'outer > inner passes').failure_kind, null);
  assert.equal(byName(p, 'outer > inner throws').failure_kind, 'runtime', 'a TypeError in a test body is not an assertion failure');
  assert.equal(byName(p, 'outer').failure_kind, 'subtests');
});

test('TAP adapter: file-level ERR_MODULE_NOT_FOUND and SyntaxError are load failures, not assertions', () => {
  const p = parseRunnerOutput('tap', TAP);
  const missing = byName(p, 'b.test.mjs');
  assert.equal(missing.status, 'fail');
  assert.equal(missing.failure_kind, 'load');
  assert.match(missing.detail, /ERR_MODULE_NOT_FOUND/);
  const syntax = byName(p, 'c.test.mjs');
  assert.equal(syntax.failure_kind, 'load');
  assert.match(syntax.detail, /SyntaxError/);
});

for (const [format, fixture, file, loadFile, syntaxFile] of [
  ['vitest-json', VITEST, '/repo/src/gate.test.ts', '/repo/src/load.test.ts', '/repo/src/syntax.test.ts'],
  ['jest-json', JEST, '/repo/gate.test.js', '/repo/load.test.js', '/repo/syntax.test.js'],
]) {
  test(`${format} adapter: assertion vs runtime vs suite-failed-to-run`, () => {
    const p = parseRunnerOutput(format, fixture);
    assert.equal(p.supported, true);
    const hit = byName(p, 'gate > refuses stale candidate');
    assert.equal(hit.file, file);
    assert.equal(hit.status, 'fail');
    assert.equal(hit.failure_kind, 'assertion');
    assert.equal(byName(p, 'gate > passes').status, 'pass');
    assert.equal(byName(p, 'gate > throws').failure_kind, 'runtime');
    const load = p.results.find((r) => r.file === loadFile);
    assert.equal(load?.failure_kind, 'load', 'a missing module is a load failure');
    const syntax = p.results.find((r) => r.file === syntaxFile);
    assert.equal(syntax?.failure_kind, 'load', 'a compile/transform error is a load failure');
  });
}

test('unsupported formats and malformed output are reported, never guessed', () => {
  assert.equal(parseRunnerOutput('mocha-spec', '  1 passing').supported, false);
  assert.equal(parseRunnerOutput('jest-json', 'not json {').supported, false);
  assert.equal(parseRunnerOutput('vitest-json', JSON.stringify({ hello: 'world' })).supported, false);
  assert.equal(parseRunnerOutput('tap', 'random console noise\nwith no plan or results\n').supported, false);
});

// ---------------------------------------------------------------------------
// gateRed: runner-produced evidence + durable attempt protocol

const redState = () => ({
  run_id: 'run-1',
  seq: 2,
  nodes: {
    'red-gate': { deps: [], phase: 'BUILD', role: 'builder' },
    gate: { deps: ['red-gate'], phase: 'BUILD', role: 'builder' },
  },
  events: [{ seq: 1, type: 'DISPATCH', node: 'red-gate' }, { seq: 2, type: 'COMPLETE', node: 'red-gate' }],
  attempts: [],
  locks: {},
  gates: { red: {} },
});

const redInput = (over = {}) => ({
  state: redState(),
  node: 'red-gate',
  command: { cmd: 'node', args: ['--test', '--test-reporter=tap', 'a.test.mjs'] },
  format: 'tap',
  specs: [{ file: 'a.test.mjs', name: 'outer > inner fails' }],
  baselineCandidate: 'sha256:base',
  timeoutMs: 60_000,
  resources: ['db:test'],
  ...over,
});

function fakeDeps({ stdout = TAP, exitCode = 1, timedOut = false, quiescent = true, pid = 4101, pgid = 4100, alive = () => false, platform = 'linux' } = {}) {
  const log = [];
  let n = 0;
  const deps = {
    platform,
    newAttemptId: () => `att-${++n}`,
    commit: (state) => { log.push({ op: 'commit', state: structuredClone(state) }); },
    digestFile: (p) => `sha256:digest-of-${p}`,
    isGroupAlive: (g) => { log.push({ op: 'alive?', pgid: g }); return alive(g); },
    spawnRunner: (req) => {
      log.push({ op: 'spawn', req });
      let release;
      const released = new Promise((r) => { release = r; });
      return {
        pid, pgid,
        release: () => { log.push({ op: 'release' }); release(); },
        done: released.then(() => { log.push({ op: 'done' }); return { exitCode, stdout, stderr: '', timedOut, quiescent }; }),
      };
    },
  };
  return { deps, log };
}

const attemptIn = (entry, id) => entry.op === 'commit' && entry.state.attempts?.find((a) => a.attempt_id === id);
const spawns = (log) => log.filter((e) => e.op === 'spawn');

test('RED accepted only on assertion failures; evidence is bound to spec digests, baseline and sequence', async () => {
  const { deps } = fakeDeps();
  const r = await gateRed(redInput(), deps);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'red_accepted');
  assert.equal(r.evidence.node, 'red-gate');
  assert.equal(r.evidence.baseline_candidate, 'sha256:base');
  assert.deepEqual(r.evidence.spec_digests, { 'a.test.mjs': 'sha256:digest-of-a.test.mjs' });
  assert.equal(r.evidence.attempt_id, 'att-1');
  assert.ok(r.evidence.seq > 2, 'evidence is ordered after every prior event by sequence');
  assert.deepEqual(r.state.gates.red['red-gate'], r.evidence);
});

test('RED gate run follows the durable attempt protocol: intent -> spawn -> pid/pgid -> release -> envelope', async () => {
  const { deps, log } = fakeDeps();
  await gateRed(redInput(), deps);
  const idx = (pred) => log.findIndex(pred);
  const intent = idx((e) => { const a = attemptIn(e, 'att-1'); return a && a.status === 'intent' && a.pgid === undefined; });
  const spawn = idx((e) => e.op === 'spawn');
  const pidCommit = idx((e) => { const a = attemptIn(e, 'att-1'); return a && a.status === 'running' && a.pid === 4101 && a.pgid === 4100; });
  const release = idx((e) => e.op === 'release');
  const envelope = idx((e) => { const a = attemptIn(e, 'att-1'); return a && a.status === 'exited' && a.envelope?.exitCode === 1; });
  assert.ok(intent >= 0 && spawn > intent, 'launch intent is committed before the runner is spawned');
  assert.ok(pidCommit > spawn && release > pidCommit, 'pid and pgid are committed before the launcher is released');
  assert.ok(envelope > release, 'the completion envelope is committed after the run');
  const intentState = log[intent].state;
  assert.equal(intentState.locks['db:test'], 'att-1', 'resource locks are taken with the intent');
  assert.equal(log[envelope].state.locks['db:test'], undefined, 'locks are released with the envelope');
  assert.equal(spawns(log)[0].req.attempt_id, 'att-1');
});

test('a surviving runner from a crashed gate run holds its lock and blocks a re-run (checked by process group)', async () => {
  const input = redInput();
  input.state.attempts.push({ attempt_id: 'att-0', kind: 'gate-red', node: 'red-gate', status: 'running', pid: 4001, pgid: 4000, resources: ['db:test'] });
  input.state.locks['db:test'] = 'att-0';
  const { deps, log } = fakeDeps({ alive: (g) => g === 4000 });
  const r = await gateRed(input, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runner_alive');
  assert.equal(spawns(log).length, 0, 'no duplicate runner is spawned');
  assert.ok(log.some((e) => e.op === 'alive?' && e.pgid === 4000), 'quiescence is checked on the group, not the pid');
  assert.equal(r.state.locks['db:test'], 'att-0', 'the live runner keeps its lock');
});

test('a crashed gate run whose group is gone is reconciled and its lock reclaimed', async () => {
  const input = redInput();
  input.state.attempts.push({ attempt_id: 'att-0', kind: 'gate-red', node: 'red-gate', status: 'running', pid: 4001, pgid: 4000, resources: ['db:test'] });
  input.state.locks['db:test'] = 'att-0';
  const { deps, log } = fakeDeps({ alive: () => false });
  const r = await gateRed(input, deps);
  assert.equal(r.ok, true);
  assert.equal(spawns(log).length, 1);
  assert.notEqual(spawns(log)[0].req.attempt_id, 'att-0', 'the re-run is a new attempt');
});

test('unknown quiescence on Windows is a judgment point, not a re-run', async () => {
  const input = redInput();
  input.state.attempts.push({ attempt_id: 'att-0', kind: 'gate-red', node: 'red-gate', status: 'running', pid: 4001, pgid: 4000, resources: ['db:test'] });
  input.state.locks['db:test'] = 'att-0';
  const { deps, log } = fakeDeps({ alive: () => null, platform: 'win32' });
  const r = await gateRed(input, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quiescence_unknown');
  assert.equal(r.judgment_point, true);
  assert.equal(spawns(log).length, 0);
});

test('a resource held by another live attempt blocks the gate run', async () => {
  const input = redInput();
  input.state.attempts.push({ attempt_id: 'att-9', kind: 'worker', node: 'gate', status: 'running', pid: 5001, pgid: 5000, resources: ['db:test'] });
  input.state.locks['db:test'] = 'att-9';
  const { deps, log } = fakeDeps({ alive: (g) => g === 5000 });
  const r = await gateRed(input, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'resource_locked');
  assert.equal(spawns(log).length, 0);
});

test('a runner timeout refuses RED and is never re-run automatically', async () => {
  const { deps, log } = fakeDeps({ timedOut: true, exitCode: null });
  const r = await gateRed(redInput(), deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runner_timeout');
  assert.equal(spawns(log).length, 1);
});

test('RED refuses a named spec that passes, throws a runtime error, fails to load, or is absent', async () => {
  const cases = [
    [{ file: 'a.test.mjs', name: 'outer > inner passes' }, 'spec_not_failing'],
    [{ file: 'a.test.mjs', name: 'outer > inner throws' }, 'non_assertion_failure'],
    [{ file: 'b.test.mjs', name: 'loads its module' }, 'non_assertion_failure'],
    [{ file: 'c.test.mjs', name: 'compiles' }, 'non_assertion_failure'],
    [{ file: 'a.test.mjs', name: 'outer > never written' }, 'spec_missing'],
  ];
  for (const [spec, code] of cases) {
    const { deps } = fakeDeps();
    const r = await gateRed(redInput({ specs: [{ file: 'a.test.mjs', name: 'outer > inner fails' }, spec] }), deps);
    assert.equal(r.ok, false, `${spec.name} must not establish RED`);
    assert.equal(r.code, code, spec.name);
    assert.equal(r.state.gates.red['red-gate'], undefined, 'no evidence is recorded on refusal');
  }
});

test('RED via vitest and jest adapters: assertion accepted, suite-failed-to-run refused', async () => {
  for (const [format, stdout, okSpec, loadSpec] of [
    ['vitest-json', VITEST, { file: 'src/gate.test.ts', name: 'gate > refuses stale candidate' }, { file: 'src/load.test.ts', name: 'loads' }],
    ['jest-json', JEST, { file: 'gate.test.js', name: 'gate > refuses stale candidate' }, { file: 'load.test.js', name: 'loads' }],
  ]) {
    const accepted = await gateRed(redInput({ format, specs: [okSpec] }), fakeDeps({ stdout }).deps);
    assert.equal(accepted.code, 'red_accepted', format);
    const refused = await gateRed(redInput({ format, specs: [loadSpec] }), fakeDeps({ stdout }).deps);
    assert.equal(refused.code, 'non_assertion_failure', format);
  }
});

test('unsupported runner output cannot establish RED: degraded judgment point', async () => {
  for (const [format, stdout] of [['mocha-spec', '  1 failing'], ['tap', 'segfault before any TAP output']]) {
    const r = await gateRed(redInput({ format }), fakeDeps({ stdout }).deps);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unsupported_output');
    assert.equal(r.judgment_point, true);
    assert.equal(r.degraded, true);
  }
});

test('RED evidence recorded after a dependent production dispatch is refused (ordering by sequence)', async () => {
  const input = redInput();
  input.state.events.push({ seq: 3, type: 'DISPATCH', node: 'gate' });
  input.state.seq = 3;
  const r = await gateRed(input, fakeDeps().deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'dispatched_before_red');
  assert.equal(r.judgment_point, true, 'production ran without RED: back to the human (docs list it as a judgment point)');
});

test('X dispatches before a RED invalidation reset do not block re-establishing RED', async () => {
  const input = redInput();
  input.state.events.push({ seq: 3, type: 'DISPATCH', node: 'gate' }, { seq: 4, type: 'RED_INVALIDATED', node: 'red-gate' });
  input.state.seq = 4;
  const r = await gateRed(input, fakeDeps().deps);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
});

test('RED without a baseline candidate is refused', async () => {
  const r = await gateRed(redInput({ baselineCandidate: undefined }), fakeDeps().deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_baseline');
});

// ---------------------------------------------------------------------------
// gateReview: full binding and review_execution chain

const CONTRACT_FIELDS = ['reviewer_identity', 'candidate_id', 'reviewed_paths', 'reasoned_exclusions', 'coverage_partitions',
  'acceptance_criteria', 'rule_rows', 'parity_outcome', 'attack_review_outcome', 'security_outcome', 'findings', 'overflow', 'outcome'];

const primary = (over = {}) => ({
  reviewer_identity: 'claude-opus:review-1',
  candidate_id: 'sha256:c1',
  reviewed_paths: ['skills/ship-ticket/scripts/gate.mjs'],
  reasoned_exclusions: [],
  coverage_partitions: [{ identity: 'claude-opus:review-1', owned: ['skills/ship-ticket/scripts/'], outcome: 'PASS' }],
  acceptance_criteria: [{ criterion: '6', outcome: 'PASS', evidence: 'gate.test.mjs' }],
  rule_rows: [{ subject_id: 'BE-SEC-1', outcome: 'PASS', evidence: 'gate.mjs:10' }],
  parity_outcome: 'NOT_TRIGGERED',
  attack_review_outcome: 'NOT_TRIGGERED',
  security_outcome: 'PASS',
  findings: [],
  overflow: false,
  outcome: 'PASS',
  ...over,
});
const second = (over = {}) => ({ route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: 'sha256:c1', findings: [], overflow: false, outcome: 'PASS', ...over });
const reviewState = () => ({
  frozen_candidate: 'sha256:c1',
  builders: [{ node: 'gate', identity: 'claude-sonnet:gate' }, { node: 'red-gate', identity: 'claude-opus:red-gate' }],
  review_chain: [],
});
const reviewInput = (over = {}) => ({
  state: reviewState(), review_execution: 'rx-1', kind: 'original', primary: primary(), second_opinion: second(),
  reconciliation: { dispositions: [] }, graded_artifacts: { parity: 'sha256:p1' }, repair_ownership: [], ...over,
});

const FINDING = { id: 'F1', severity: 'major', path: 'skills/ship-ticket/scripts/gate.mjs', evidence: '"x"', consequence: 'c', fix: 'f' };
const failedRecord = { review_execution: 'rx-1', kind: 'original', outcome: 'FAIL', candidate_id: 'sha256:c1', reviewer_identity: 'claude-opus:review-1', second_opinion_route: 'codex', fix_findings: ['F1'] };
const repairRecord = { review_execution: 'rx-1', kind: 'repair', old_candidate: 'sha256:c1', new_candidate: 'sha256:c2', write_set: ['skills/ship-ticket/scripts/gate.mjs'] };
const confirmInput = (over = {}) => ({
  state: { ...reviewState(), frozen_candidate: 'sha256:c2', review_chain: [failedRecord, repairRecord] },
  review_execution: 'rx-1', kind: 'confirmation',
  primary: { reviewer_identity: 'claude-opus:review-1', candidate_id: 'sha256:c2', checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed at gate.mjs:12' },
  ...over,
});

test('a complete, bound review is accepted and recorded with its route and graded artifact digests', () => {
  const r = gateReview(reviewInput());
  assert.equal(r.ok, true);
  assert.equal(r.code, 'review_accepted');
  assert.deepEqual(
    { ...r.record },
    { ...r.record, review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: 'sha256:c1', reviewer_identity: 'claude-opus:review-1', second_opinion_route: 'codex', graded_artifacts: { parity: 'sha256:p1' } },
  );
  assert.equal(r.repair, undefined);
});

test('every missing field of the primary output contract is its own refusal', () => {
  for (const field of CONTRACT_FIELDS) {
    const p = primary();
    delete p[field];
    const r = gateReview(reviewInput({ primary: p }));
    assert.equal(r.ok, false, field);
    assert.equal(r.code, 'incomplete_contract', field);
    assert.ok(r.reasons.some((x) => x.includes(field)), `reasons name ${field}`);
  }
});

test('R8 nested contract rows and outcome enums are validated; empty coverage, criteria or rules are refused', () => {
  const bad = [
    { coverage_partitions: [] }, { acceptance_criteria: [] }, { rule_rows: [] }, { reviewed_paths: [] },
    { security_outcome: 'BANANA' }, { parity_outcome: 'pass' }, { attack_review_outcome: undefined },
    { coverage_partitions: [{ identity: 'x', owned: [], outcome: 'PASS' }] },
    { coverage_partitions: [{ identity: 'x', owned: ['a/'], outcome: 'OK' }] },
    { acceptance_criteria: [{ criterion: '6', outcome: 'PASS' }] },
    { acceptance_criteria: [{ criterion: '', outcome: 'PASS', evidence: 'e' }] },
    { rule_rows: [{ subject_id: 'BE-SEC-1', outcome: 'MAYBE', evidence: 'e' }] },
    { rule_rows: ['BE-SEC-1'] },
    { reasoned_exclusions: [{ path: 'a' }] },
  ];
  for (const over of bad) {
    const r = gateReview(reviewInput({ primary: primary(over) }));
    assert.equal(r.code, 'incomplete_contract', JSON.stringify(over));
  }
  assert.equal(gateReview(reviewInput({ primary: primary({ rule_rows: [{ subject_id: 'X', outcome: 'NOT_APPLICABLE', evidence: 'no X here' }],
    reasoned_exclusions: ['vendor/', { path: 'dist/', reason: 'generated' }] }) })).ok, true);
});

test('R7 the primary and the second opinion must be different reviewers', () => {
  const r = gateReview(reviewInput({ second_opinion: second({ reviewer_identity: 'claude-opus:review-1' }) }));
  assert.equal(r.code, 'reviewers_not_distinct');
  assert.equal(gateReview(reviewInput({ primary: primary({ reviewer_identity: 'claude-sonnet:gate:review' }) })).code, 'reviewer_is_builder',
    'an identity that extends a builder identity is that builder');
});

test('counts or a route name alone are never accepted as a review', () => {
  const r = gateReview({ state: reviewState(), review_execution: 'rx-1', kind: 'original', route: 'opus', rounds: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'incomplete_contract');
});

test('a reviewer that is any builder identity is refused', () => {
  const r = gateReview(reviewInput({ primary: primary({ reviewer_identity: 'claude-opus:red-gate' }) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'reviewer_is_builder');
});

test('a review of a stale candidate is refused (primary or second opinion)', () => {
  assert.equal(gateReview(reviewInput({ primary: primary({ candidate_id: 'sha256:old' }) })).code, 'stale_candidate');
  assert.equal(gateReview(reviewInput({ second_opinion: second({ candidate_id: 'sha256:old' }) })).code, 'stale_candidate');
});

test('the second opinion must be a usable artifact, not a name', () => {
  assert.equal(gateReview(reviewInput({ second_opinion: undefined })).code, 'missing_second_opinion');
  for (const bad of ['codex', { route: 'codex' }, second({ outcome: 'FAIL', findings: [] })]) {
    const r = gateReview(reviewInput({ second_opinion: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'second_opinion_unusable', JSON.stringify(bad));
  }
});

test('reconciliation is required and must dispose of every finding from both reviewers', () => {
  assert.equal(gateReview(reviewInput({ reconciliation: undefined })).code, 'missing_reconciliation');
  const r = gateReview(reviewInput({
    primary: primary({ outcome: 'FAIL', findings: [FINDING] }),
    second_opinion: second({ outcome: 'FAIL', findings: [{ ...FINDING, id: 'S1' }] }),
    reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_reconciliation');
});

test('PASS with a failed triggered sub-outcome or overflow is inconsistent', () => {
  assert.equal(gateReview(reviewInput({ primary: primary({ security_outcome: 'FAIL' }) })).code, 'outcome_inconsistent');
  assert.equal(gateReview(reviewInput({ primary: primary({ parity_outcome: 'FAIL' }) })).code, 'outcome_inconsistent');
  assert.equal(gateReview(reviewInput({ primary: primary({ overflow: true }) })).code, 'outcome_inconsistent');
});

test('[R6] gate refuses a primary PASS with a second-opinion finding disposed fix (PASS with findings to fix), with or without recordVerdicts', () => {
  const input = () => reviewInput({
    second_opinion: second({ findings: [{ ...FINDING, id: 'S1' }], outcome: 'FAIL' }),
    reconciliation: { dispositions: [{ finding_id: 'S1', source: 'codex', disposition: 'fix' }], summary: 'S1 must be fixed' },
  });
  for (const policy of [undefined, {}, { recordVerdicts: false }, { recordVerdicts: true }]) {
    const r = gateReview(input(), policy);
    assert.deepEqual(r, { ok: false, code: 'outcome_inconsistent', reasons: ['PASS with findings to fix'] }, `policy ${JSON.stringify(policy)}: refused, nothing recorded`);
  }
  // The same finding disposed fix under a primary FAIL is accepted (the refusal is about the PASS, not the finding).
  const fail = input();
  fail.primary = primary({ outcome: 'FAIL' });
  assert.equal(gateReview(fail, { recordVerdicts: true }).code, 'review_accepted');
});

test('an accepted FAIL opens exactly one finding-bound repair', () => {
  const r = gateReview(reviewInput({
    primary: primary({ outcome: 'FAIL', findings: [FINDING, { ...FINDING, id: 'F2', path: 'docs/x.md' }] }),
    reconciliation: { dispositions: [
      { finding_id: 'F1', source: 'primary', disposition: 'fix' },
      { finding_id: 'F2', source: 'primary', disposition: 'reject — factually wrong' },
    ] },
    repair_ownership: ['skills/ship-ticket/scripts/harness.mjs'],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.record.outcome, 'FAIL');
  assert.deepEqual(r.record.fix_findings, ['F1']);
  assert.deepEqual(r.repair, { review_execution: 'rx-1', write_set: ['skills/ship-ticket/scripts/gate.mjs', 'skills/ship-ticket/scripts/harness.mjs'] });
});

test('chain: a confirmation for the same review_execution after its repair is accepted', () => {
  const r = gateReview(confirmInput());
  assert.equal(r.ok, true);
  assert.equal(r.record.kind, 'confirmation');
  assert.equal(r.record.outcome, 'PASS');
  assert.equal(r.record.candidate_id, 'sha256:c2');
});

test('chain: confirmation without an original FAIL and repair, or under another execution id, is refused', () => {
  const noChain = confirmInput();
  noChain.state.review_chain = [];
  assert.equal(gateReview(noChain).code, 'chain_broken');
  const noRepair = confirmInput();
  noRepair.state.review_chain = [failedRecord];
  assert.equal(gateReview(noRepair).code, 'chain_broken');
  assert.equal(gateReview(confirmInput({ review_execution: 'rx-2' })).code, 'chain_broken');
});

test('chain: confirmation must check every fixed finding on the repaired candidate, by a non-builder', () => {
  assert.equal(gateReview(confirmInput({ primary: { ...confirmInput().primary, checked_findings: [] } })).code, 'incomplete_contract');
  assert.equal(gateReview(confirmInput({ primary: { ...confirmInput().primary, candidate_id: 'sha256:c1' } })).code, 'stale_candidate');
  const repairBuilder = confirmInput({ primary: { ...confirmInput().primary, reviewer_identity: 'claude-sonnet:repair-1' } });
  repairBuilder.state.builders.push({ node: 'repair-1', identity: 'claude-sonnet:repair-1' });
  assert.equal(gateReview(repairBuilder).code, 'reviewer_is_builder');
});

test('chain: a second confirmation in one review_execution is refused', () => {
  const input = confirmInput();
  input.state.review_chain.push({ review_execution: 'rx-1', kind: 'confirmation', outcome: 'FAIL', candidate_id: 'sha256:c2', reviewer_identity: 'claude-opus:review-1' });
  assert.equal(gateReview(input).code, 'confirmation_spent');
});

// ---------------------------------------------------------------------------
// requiredEvidence (P1-5)

const EVIDENCE_TABLE = {
  concurrency: ['interleaving-spec'],
  auth: ['authorization-spec', 'negative-spec'],
  security: ['authorization-spec', 'negative-spec'],
  tenancy: ['cross-tenant-spec'],
  payments: ['failure-path-spec', 'idempotency-spec'],
  migration: ['replay-check', 'rollback-compat-check'],
  schema: ['replay-check', 'rollback-compat-check'],
  ui: ['parity-measurements'],
};
const LABELS = Object.keys(EVIDENCE_TABLE);

test('requiredEvidence maps each risk label to the plan table', () => {
  for (const label of LABELS) assert.deepEqual(requiredEvidence([label]), EVIDENCE_TABLE[label], label);
  assert.deepEqual(requiredEvidence([]), []);
});

test('requiredEvidence is additive: adding a label never removes a required kind', () => {
  for (const a of LABELS) {
    for (const b of LABELS) {
      const both = new Set(requiredEvidence([a, b]));
      for (const kind of [...requiredEvidence([a]), ...requiredEvidence([b])]) assert.ok(both.has(kind), `${a}+${b} keeps ${kind}`);
    }
  }
  assert.deepEqual(requiredEvidence(['ui', 'auth', 'ui']), ['authorization-spec', 'negative-spec', 'parity-measurements']);
});

test('requiredEvidence rejects labels outside the table instead of ignoring them', () => {
  assert.throws(() => requiredEvidence(['none']), /unknown risk label/);
  assert.throws(() => requiredEvidence(['ui', 'low-risk']), /unknown risk label/);
});

// ---------------------------------------------------------------------------
// gateShipReady

const PINNED = ['.specs/plans/AIS-1.md', 'session-log.md'];
const shipState = (over = {}) => ({
  ticket: 'AIS-1',
  pinned_exclusions: [...PINNED],
  review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: 'sha256:c1', reviewer_identity: 'claude-opus:review-1', second_opinion_route: 'codex', graded_artifacts: { parity: 'sha256:p1' } }],
  local_proof: { candidate_id: 'sha256:c1', commands: [{ cmd: 'node --test', result: 'pass' }, { cmd: 'node scripts/cli.mjs validate', result: 'pass' }] },
  risk_labels: ['ui'],
  risk_evidence: [{ kind: 'parity-measurements', path: '.specs/design-parity/AIS-1.json' }],
  ...over,
});
const current = (over = {}) => ({ candidate_id: 'sha256:c1', exclusions: [...PINNED], artifact_digests: { parity: 'sha256:p1' }, ...over });
const refusedFor = (r, reason) => {
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(reason), `expected ${reason} in ${JSON.stringify(r.reasons)}`);
  assert.equal(r.event, undefined, 'no SHIP_READY is synthesized on refusal');
};

test('SHIP_READY is emitted only when every binding holds', () => {
  const r = gateShipReady({ state: shipState(), current: current() });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'ship_ready');
  assert.deepEqual(r.event, { type: 'SHIP_READY', candidate_id: 'sha256:c1' });
});

test('ship-ready refuses a candidate that differs from the reviewed one', () => {
  refusedFor(gateShipReady({ state: shipState(), current: current({ candidate_id: 'sha256:c9' }) }), 'candidate_mismatch');
});

test('ship-ready refuses an altered exclusion list (extra, directory, or merely equivalent spelling)', () => {
  for (const exclusions of [[...PINNED, 'README.md'], ['.specs', 'session-log.md'], ['.specs/plans/AIS-1.md', './session-log.md'], ['.specs/plans/AIS-1.md']]) {
    refusedFor(gateShipReady({ state: shipState(), current: current({ exclusions }) }), 'exclusions_altered');
  }
  const badPin = shipState({ pinned_exclusions: ['.specs/', 'session-log.md'] });
  refusedFor(gateShipReady({ state: badPin, current: current({ exclusions: ['.specs/', 'session-log.md'] }) }), 'exclusions_altered');
  assert.equal(gateShipReady({ state: shipState(), current: current({ exclusions: [...PINNED].reverse() }) }).ok, true, 'order does not matter');
});

test('ship-ready refuses a parity artifact whose digest differs from the one the reviewer graded', () => {
  refusedFor(gateShipReady({ state: shipState(), current: current({ artifact_digests: { parity: 'sha256:p2' } }) }), 'artifact_changed');
  refusedFor(gateShipReady({ state: shipState(), current: current({ artifact_digests: {} }) }), 'artifact_changed');
});

test('ship-ready refuses missing risk evidence for each label', () => {
  for (const label of LABELS) {
    const state = shipState({ risk_labels: [label], risk_evidence: [] });
    const r = gateShipReady({ state, current: current() });
    refusedFor(r, 'missing_risk_evidence');
    assert.deepEqual([...r.missing].sort(), EVIDENCE_TABLE[label], label);
  }
});

test('risk evidence needs a spec path, and spec kinds need accepted RED', () => {
  const noPath = shipState({ risk_labels: ['tenancy'], risk_evidence: [{ kind: 'cross-tenant-spec', red_accepted: true }] });
  refusedFor(gateShipReady({ state: noPath, current: current() }), 'missing_risk_evidence');
  const noRed = shipState({ risk_labels: ['concurrency'], risk_evidence: [{ kind: 'interleaving-spec', path: 'test/order.test.mjs' }] });
  refusedFor(gateShipReady({ state: noRed, current: current() }), 'missing_risk_evidence');
  const full = shipState({
    risk_labels: ['concurrency', 'migration'],
    risk_evidence: [
      { kind: 'interleaving-spec', path: 'test/order.test.mjs', red_accepted: true },
      { kind: 'replay-check', path: 'test/replay.test.mjs' },
      { kind: 'rollback-compat-check', path: 'test/rollback.test.mjs' },
    ],
  });
  assert.equal(gateShipReady({ state: full, current: current() }).ok, true);
});

test('ship-ready refuses missing, failing or differently bound local proof, with or without risk labels', () => {
  for (const local_proof of [
    undefined,
    { candidate_id: 'sha256:c1', commands: [] },
    { candidate_id: 'sha256:c0', commands: [{ cmd: 'node --test', result: 'pass' }] },
    { candidate_id: 'sha256:c1', commands: [{ cmd: 'node --test', result: 'fail' }] },
  ]) {
    refusedFor(gateShipReady({ state: shipState({ local_proof }), current: current() }), 'missing_local_proof');
    refusedFor(gateShipReady({ state: shipState({ local_proof, risk_labels: [], risk_evidence: [] }), current: current() }), 'missing_local_proof');
  }
});

test('ship-ready needs an accepted review chain ending in PASS on the current candidate', () => {
  const failed = shipState({ review_chain: [{ ...shipState().review_chain[0], outcome: 'FAIL', fix_findings: ['F1'] }] });
  refusedFor(gateShipReady({ state: failed, current: current() }), 'review_not_accepted');
  refusedFor(gateShipReady({ state: shipState({ review_chain: [] }), current: current() }), 'review_not_accepted');
  const confirmed = shipState({
    review_chain: [
      { ...shipState().review_chain[0], outcome: 'FAIL', fix_findings: ['F1'] },
      { review_execution: 'rx-1', kind: 'repair', old_candidate: 'sha256:c1', new_candidate: 'sha256:c2', write_set: ['a.mjs'] },
      { review_execution: 'rx-1', kind: 'confirmation', outcome: 'PASS', candidate_id: 'sha256:c2', reviewer_identity: 'claude-opus:review-1' },
    ],
    local_proof: { candidate_id: 'sha256:c2', commands: [{ cmd: 'node --test', result: 'pass' }] },
  });
  assert.equal(gateShipReady({ state: confirmed, current: current({ candidate_id: 'sha256:c2' }) }).ok, true);
});

test('R10 ship-ready refuses unfinished nodes, live attempts, open repairs and unresolved judgments', () => {
  const cases = [
    [{ nodes: { a: { state: 'done' }, b: { state: 'failed' } } }, 'nodes_unfinished'],
    [{ nodes: { a: { state: 'pending' } } }, 'nodes_unfinished'],
    [{ attempts: [{ attempt_id: 'x', kind: 'node', status: 'launched' }] }, 'attempts_live'],
    [{ attempts: [{ attempt_id: 'y', kind: 'gate-red', status: 'running' }] }, 'attempts_live'],
    [{ repairs: [{ id: 'repair-rx-1', state: 'pending' }] }, 'repairs_open'],
    [{ judgments: [{ code: 'crash_with_writes', node: 'a', reason: 'r' }] }, 'judgments_unresolved'],
  ];
  for (const [over, reason] of cases) refusedFor(gateShipReady({ state: shipState(over), current: current() }), reason);
  assert.equal(gateShipReady({ state: shipState({ nodes: { a: { state: 'done' }, b: { state: 'cancelled' } },
    attempts: [{ attempt_id: 'z', kind: 'node', status: 'exited' }], repairs: [{ id: 'r', state: 'done' }], judgments: [] }), current: current() }).ok, true);
});

// ---------------------------------------------------------------------------
// Integration seams (PROVE repair batch 1): canonical review-chain records and ticket-level risk labels

test('seam: an accepted review record carries findings [{id, severity, paths}] and the repair write_set', () => {
  const r = gateReview(reviewInput({
    primary: primary({ outcome: 'FAIL', findings: [FINDING, { ...FINDING, id: 'F2', severity: 'minor', path: 'docs/x.md' }] }),
    second_opinion: second({ outcome: 'FAIL', findings: [{ id: 'S1', severity: 'high', path: 'skills/ship-ticket/scripts/harness.mjs' }] }),
    reconciliation: { dispositions: [
      { finding_id: 'F1', source: 'primary', disposition: 'fix' },
      { finding_id: 'F2', source: 'primary', disposition: 'reject — factually wrong' },
      { finding_id: 'S1', source: 'codex', disposition: 'duplicate of F1' },
    ] },
    repair_ownership: ['skills/ship-ticket/scripts/harness.mjs'],
  }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.record.findings.map(({ id, severity, paths }) => ({ id, severity, paths })), [
    { id: 'F1', severity: 'major', paths: ['skills/ship-ticket/scripts/gate.mjs'] },
    { id: 'F2', severity: 'minor', paths: ['docs/x.md'] },
    { id: 'S1', severity: 'high', paths: ['skills/ship-ticket/scripts/harness.mjs'] },
  ]);
  assert.deepEqual(r.record.write_set, r.repair.write_set, 'the record persists the accepted repair write_set');
  assert.deepEqual(r.record.write_set, ['skills/ship-ticket/scripts/gate.mjs', 'skills/ship-ticket/scripts/harness.mjs']);

  const pass = gateReview(reviewInput());
  assert.deepEqual(pass.record.findings, []);
  assert.deepEqual(pass.record.write_set, [], 'a PASS opens no repair: empty write_set, never absent');
});

test('seam: a finding with paths[] is accepted; a primary finding without severity is an incomplete contract', () => {
  const multi = gateReview(reviewInput({
    primary: primary({ outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', paths: ['a.mjs', 'b.mjs'] }] }),
    reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] },
  }));
  assert.equal(multi.ok, true, JSON.stringify(multi.reasons));
  assert.deepEqual(multi.record.findings[0].paths, ['a.mjs', 'b.mjs']);
  assert.deepEqual(multi.record.write_set, ['a.mjs', 'b.mjs']);
  const { severity, ...noSeverity } = FINDING;
  const r = gateReview(reviewInput({ primary: primary({ outcome: 'FAIL', findings: [noSeverity] }),
    reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'incomplete_contract');
});

test('seam: ship-ready unions ticket-level config.riskLabels with node risk; ui needs the parity-probe evidence', () => {
  const ui = gateShipReady({ state: shipState({ risk_labels: [], config: { riskLabels: ['ui'] }, risk_evidence: [] }), current: current() });
  refusedFor(ui, 'missing_risk_evidence');
  assert.deepEqual(ui.missing, ['parity-measurements']);
  const both = gateShipReady({ state: shipState({ risk_labels: [], config: { riskLabels: ['ui'] }, nodes: { a: { risk: ['tenancy'] } },
    risk_evidence: [{ kind: 'parity-measurements', path: '.specs/design-parity/AIS-1.json' }] }), current: current() });
  refusedFor(both, 'missing_risk_evidence');
  assert.deepEqual(both.missing, ['cross-tenant-spec'], 'node risk still counts beside the ticket labels');
});
