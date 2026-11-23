/**
 * S-14a (ASTF-8): the pure derivation of engine-next.mjs, on synthetic states and facts (no engine process). Tags [Nx] name the
 * mutants of engine-next-mutation.test.mjs each test must kill. The integration half (status on a real run) is run-engine-next.test.mjs.
 *   R1 pinned derivations and the rule-omission harness (N1)   R2 turn_end over every disposition x owner (N2)
 *   R3 human-owned codes never READY or CONTINUE (N3)           R4 corrupt state FAILED, no_state init (N9)
 *   R5 A4: PUBLISH..POST_MERGE human-owned (N10)                R10 verified liveness (N6)
 *   R11 class table and fallback (N4, N5)                       R12 code registration    R14 advisory import graph   R16 lock held
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { derive, RULES, STAGES, DISPOSITIONS, TURN_ENDS, ACTIONS, NEXT_KEYS, NEXT_SCHEMA, FAILURE_CLASSES, WORK_OUTCOMES, HUMAN_CODES,
  LOCK_RULE, classOf, refusal, turnEnd, failedNext, underivedNext, missingGuarantees, verify, humanGuard, readyWork } from './engine-next.mjs';
import { processInfo } from './engine-quiesce.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-23T12:00:00Z');
const C1 = 'c'.repeat(64), C2 = 'd'.repeat(64);

const S0 = (over = {}) => ({ run_id: 'run-1', ticket: 'T-1', policy_version: 1, config: {}, nodes: { a: { id: 'a', state: 'done', deps: [], redSpecs: [] } },
  review_chain: [], repairs: [], attempts: [], judgments: [], authority: { trusted: [], untrusted: [] }, freeze: null, ...over });
const F0 = (over = {}) => ({ now: NOW, lock: { state: 'free' }, attempts: [], dispatches: [], unbound: [], blockers: [], redPending: [], unitReviewsPending: [],
  work: false, budgetStop: false, candidate: { id: C1 }, gates: [], ...over });
/** Gate history rows (append-only); `n` repeats of the same refusal. */
const row = (gate, ok, code, candidate_id, at_ms, n = 1) => Array.from({ length: n }, (_, i) => ({ gate, ok, code, candidate_id, at_ms: at_ms - (n - 1 - i) }));

const att = (over = {}) => ({ attempt_id: 'att-1', kind: 'node', node: 'a', status: 'launched', pid: 4242, envelope: false, deadline: '2026-11-23T13:00:00.000Z',
  deadline_ms: NOW + 3600e3, liveness: { state: 'alive', reason: 'start_time_equal' }, ...over });
const disp = (role, over = {}) => ({ event_id: `ev-${role}`, role, review_execution: 'review-1', candidate_id: C1, started_at: '2026-11-23T11:50:00.000Z',
  marker: `/tmp/r-${role}.json`, marker_exists: false, ended: false, result_ms: null, deadline: '2026-11-23T12:10:00.000Z', deadline_ms: NOW + 600e3, ...over });
const ready = (role, over = {}) => disp(role, { marker_exists: true, result_ms: NOW - 1000, ...over });
const PASS = { review_execution: 'review-1', kind: 'original', outcome: 'PASS', candidate_id: C1 };
const FAIL = { review_execution: 'review-1', kind: 'original', outcome: 'FAIL', candidate_id: C1 };
const REPAIR_REC = { review_execution: 'review-1', kind: 'repair', old_candidate: C1, new_candidate: C2, write_set: ['src/a.txt'] };
const repairItem = (state) => ({ id: 'repair-review-1', kind: 'review', review_execution: 'review-1', state });
const reviewed = (over = {}) => S0({ freeze: { candidate: C1, seq: 3 }, review_chain: [PASS], ...over });
const repairing = (state, over = {}) => S0({ freeze: { candidate: C1, seq: 3 }, review_chain: [FAIL], repairs: [repairItem(state)], ...over });
const confirming = (over = {}) => S0({ freeze: { candidate: C2, seq: 5 }, review_chain: [FAIL, REPAIR_REC], repairs: [repairItem('done')], ...over });
const retrying = () => S0({ freeze: { candidate: C1, seq: 3 }, review_chain: [FAIL], repairs: [repairItem('cancelled')],
  authority: { trusted: [JSON.stringify({ run_id: 'run-1', event: 'RETRY', review_execution: 'review-2', predecessor: 'review-1', authorized_by: 'owner' })], untrusted: [] } });

/** Pinned scenarios: [name, S, f, expected { stage, action, disposition, code, rule }]. */
const SCENARIOS = [
  ['unbound approval', S0(), F0({ unbound: [{ code: 'approval_mismatch', node: null, reason: 'drifted' }] }), { stage: 'APPROVAL', action: 'reapprove', disposition: 'NEEDS_APPROVAL', code: 'approval_mismatch', rule: 'approval.unbound' }],
  ['build work', S0({ nodes: { a: { id: 'a', state: 'pending', deps: [], redSpecs: [] } } }), F0({ work: true }), { stage: 'BUILD', action: 'drive', disposition: 'READY', code: 'build_pending', rule: 'build.work' }],
  ['build budget stop', S0({ nodes: { a: { id: 'a', state: 'pending', deps: [], redSpecs: [] } } }), F0({ work: true, budgetStop: true }), { stage: 'BUILD', action: 'owner_decide', disposition: 'NEEDS_APPROVAL', code: 'budget_stop', rule: 'build.budget' }],
  ['build red pending', S0(), F0({ redPending: ['a'] }), { stage: 'BUILD', action: 'gate_red', disposition: 'READY', code: 'red_pending', rule: 'build.red' }],
  ['build unit review', S0(), F0({ unitReviewsPending: ['u1'] }), { stage: 'BUILD', action: 'unit_review', disposition: 'READY', code: 'unit_review_owed', rule: 'build.unit_review' }],
  ['build node judgment', S0({ nodes: { a: { id: 'a', state: 'failed', deps: [], redSpecs: [] } } }), F0({ blockers: [{ code: 'node_failed', node: 'a', reason: 'x' }] }), { stage: 'BUILD', action: 'resolve', disposition: 'BLOCKED', code: 'node_failed', rule: 'build.judgment' }],
  ['build not done, nothing owed', S0({ nodes: { a: { id: 'a', state: 'pending', deps: ['b'], redSpecs: [] }, b: { id: 'b', state: 'failed', deps: [], redSpecs: [] } } }), F0(), { stage: 'BUILD', action: 'owner_decide', disposition: 'BLOCKED', code: 'underived', rule: 'build.underived' }],
  ['loose judgment stops a READY stage', S0(), F0({ blockers: [{ code: 'billing_unverified', node: null, reason: 'x' }] }), { stage: 'REVIEW', action: 'owner_decide', disposition: 'NEEDS_APPROVAL', code: 'billing_unverified', rule: 'signal.judgment' }],
  ['lock held', S0(), F0({ lock: { state: 'held' } }), { stage: 'REVIEW', action: 'wait', disposition: 'RUNNING', code: 'engine_running', rule: LOCK_RULE }],
  ['lock malformed', S0(), F0({ lock: { state: 'malformed', reason: 'unreadable' } }), { stage: 'REVIEW', action: 'authorize_fallback', disposition: 'NEEDS_APPROVAL', code: 'lock_malformed', rule: LOCK_RULE }],
  ['review owed', S0(), F0(), { stage: 'REVIEW', action: 'dispatch_review', disposition: 'READY', code: 'review_owed', rule: 'review.owed' }],
  ['review second opinion owed', S0(), F0({ dispatches: [disp('primary')] }), { stage: 'REVIEW', action: 'dispatch_review', disposition: 'READY', code: 'review_owed', rule: 'review.owed' }],
  ['review in flight', S0(), F0({ dispatches: [disp('primary'), disp('second_opinion')] }), { stage: 'REVIEW', action: 'wait', disposition: 'WAITING', code: 'review_in_flight', rule: 'review.waiting' }],
  ['review overdue', S0(), F0({ dispatches: [disp('primary', { deadline_ms: NOW - 1 }), disp('second_opinion')] }), { stage: 'REVIEW', action: 'resolve', disposition: 'BLOCKED', code: 'review_overdue', rule: 'review.overdue' }],
  ['review results ready', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion', { marker_exists: false, ended: true })] }), { stage: 'REVIEW', action: 'gate_review', disposition: 'READY', code: 'results_ready', rule: 'review.gate' }],
  ['review results ready on a moved tree (results outrank the candidate)', S0(), F0({ candidate: { id: C2 }, dispatches: [ready('primary'), ready('second_opinion')] }), { stage: 'REVIEW', action: 'gate_review', disposition: 'READY', code: 'results_ready', rule: 'review.gate' }],
  ['review gate refused once (orchestrator corrects)', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], gates: row('review', false, 'missing_reconciliation', C1, NOW, 1) }), { stage: 'REVIEW', action: 'gate_review', disposition: 'BLOCKED', code: 'missing_reconciliation', rule: 'signal.gate.review' }],
  ['review gate refused twice (the human decides)', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], gates: row('review', false, 'missing_reconciliation', C1, NOW, 2) }), { stage: 'REVIEW', action: 'owner_decide', disposition: 'BLOCKED', code: 'missing_reconciliation', rule: 'signal.gate.review' }],
  ['review gate refused (integrity: human at once)', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], gates: row('review', false, 'stale_candidate', C1, NOW, 1) }), { stage: 'REVIEW', action: 'owner_decide', disposition: 'BLOCKED', code: 'stale_candidate', rule: 'signal.gate.review' }],
  ['a later execution without results never outranks an owed result', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion'), disp('primary', { event_id: 'ev-late', review_execution: 'review-2' })] }), { stage: 'REVIEW', action: 'gate_review', disposition: 'READY', code: 'results_ready', rule: 'review.gate' }],
  ['candidate unavailable', S0(), F0({ candidate: { id: null, reason: 'git failed' } }), { stage: 'REVIEW', action: 'resolve', disposition: 'BLOCKED', code: 'candidate_unavailable', rule: 'review.candidate' }],
  ['retry owed', retrying(), F0(), { stage: 'REVIEW', action: 'dispatch_review', disposition: 'READY', code: 'review_owed', rule: 'review.retry' }],
  ['review FAIL without repair', S0({ freeze: { candidate: C1, seq: 3 }, review_chain: [FAIL] }), F0(), { stage: 'RECONCILE', action: 'owner_retry', disposition: 'NEEDS_APPROVAL', code: 'review_terminal', rule: 'reconcile.terminal' }],
  ['repair owed', repairing('pending'), F0(), { stage: 'REPAIR', action: 'drive', disposition: 'READY', code: 'repair_owed', rule: 'repair.pending' }],
  ['repair failed', repairing('failed'), F0({ blockers: [{ code: 'repair_failed', node: 'repair-review-1', reason: 'x' }] }), { stage: 'REPAIR', action: 'owner_retry', disposition: 'NEEDS_APPROVAL', code: 'repair_failed', rule: 'repair.judgment' }],
  ['confirmation owed', confirming(), F0({ candidate: { id: C2 } }), { stage: 'CONFIRMATION', action: 'dispatch_review', disposition: 'READY', code: 'confirmation_owed', rule: 'confirmation.owed' }],
  ['confirmation drift', confirming(), F0({ candidate: { id: C1 } }), { stage: 'CONFIRMATION', action: 'owner_decide', disposition: 'BLOCKED', code: 'post_freeze_drift', rule: 'confirmation.drift' }],
  ['confirmation in flight', confirming(), F0({ candidate: { id: C2 }, dispatches: [disp('confirmation', { candidate_id: C2 })] }), { stage: 'CONFIRMATION', action: 'wait', disposition: 'WAITING', code: 'review_in_flight', rule: 'confirmation.waiting' }],
  ['confirmation overdue', confirming(), F0({ candidate: { id: C2 }, dispatches: [disp('confirmation', { candidate_id: C2, deadline_ms: NOW - 1 })] }), { stage: 'CONFIRMATION', action: 'resolve', disposition: 'BLOCKED', code: 'review_overdue', rule: 'confirmation.overdue' }],
  ['confirmation result ready (and a dispatched second opinion owed with it)', confirming(), F0({ candidate: { id: C2 }, dispatches: [ready('confirmation', { candidate_id: C2 }), ready('second_opinion', { candidate_id: C2 })] }), { stage: 'CONFIRMATION', action: 'gate_review', disposition: 'READY', code: 'results_ready', rule: 'confirmation.gate' }],
  ['confirmation gate refused', confirming(), F0({ candidate: { id: C2 }, dispatches: [ready('confirmation', { candidate_id: C2 })], gates: row('review', false, 'missing_second_opinion', C2, NOW, 1) }), { stage: 'CONFIRMATION', action: 'gate_review', disposition: 'BLOCKED', code: 'missing_second_opinion', rule: 'signal.gate.review' }],
  ['confirmation FAIL', confirming({ review_chain: [FAIL, REPAIR_REC, { review_execution: 'review-1', kind: 'confirmation', outcome: 'FAIL', candidate_id: C2 }] }), F0({ candidate: { id: C2 } }), { stage: 'CONFIRMATION', action: 'owner_retry', disposition: 'FAILED', code: 'confirmation_failed', rule: 'confirmation.failed' }],
  ['ship-ready owed after a confirmation', confirming({ review_chain: [FAIL, REPAIR_REC, { review_execution: 'review-1', kind: 'confirmation', outcome: 'PASS', candidate_id: C2 }] }), F0({ candidate: { id: C2 } }), { stage: 'SHIP_READY', action: 'gate_ship_ready', disposition: 'READY', code: 'ship_ready_owed', rule: 'ship_ready.owed' }],
  ['ship-ready owed', reviewed(), F0(), { stage: 'SHIP_READY', action: 'gate_ship_ready', disposition: 'READY', code: 'ship_ready_owed', rule: 'ship_ready.owed' }],
  ['ship-ready on a moved tree', reviewed({ ship_ready: { candidate_id: C1, seq: 9 } }), F0({ candidate: { id: C2 } }), { stage: 'SHIP_READY', action: 'owner_decide', disposition: 'BLOCKED', code: 'post_freeze_drift', rule: 'signal.drift' }],
  ['ship-ready refused', reviewed(), F0({ gates: [...row('review', true, 'review_accepted', C1, NOW - 5), ...row('ship-ready', false, 'evidence_run_failed', C1, NOW)] }), { stage: 'SHIP_READY', action: 'owner_decide', disposition: 'BLOCKED', code: 'evidence_run_failed', rule: 'signal.gate.ship_ready' }],
  ['after SHIP_READY: the owner publishes', reviewed({ ship_ready: { candidate_id: C1, seq: 9 } }), F0(), { stage: 'PUBLISH', action: 'owner_publish', disposition: 'BLOCKED', code: 'publish_owner_owned', rule: 'publish.owner' }],
];
// The four attempt rules of each attempt-bearing stage.
for (const [stage, S, kind, f = {}] of [['BUILD', S0({ nodes: { a: { id: 'a', state: 'running', deps: [], redSpecs: [] } } }), 'node'],
  ['REPAIR', repairing('running'), 'repair'], ['SHIP_READY', reviewed(), 'proof']]) {
  const p = stage.toLowerCase();
  SCENARIOS.push(
    [`${p} attempt uncollected`, S, F0({ ...f, attempts: [att({ kind, envelope: true })] }), { stage, action: 'resume', disposition: 'READY', code: 'attempt_uncollected', rule: `${p}.attempt.uncollected` }],
    [`${p} attempt dead`, S, F0({ ...f, attempts: [att({ kind, liveness: { state: 'dead', reason: 'no_process' } })] }), { stage, action: 'resume', disposition: 'BLOCKED', code: 'attempt_dead_unreconciled', rule: `${p}.attempt.dead` }],
    [`${p} attempt overdue`, S, F0({ ...f, attempts: [att({ kind, deadline_ms: NOW - 1 })] }), { stage, action: 'recover_attempt', disposition: 'BLOCKED', code: 'attempt_overdue', rule: `${p}.attempt.overdue` }],
    [`${p} attempt in flight`, S, F0({ ...f, attempts: [att({ kind })] }), { stage, action: 'wait', disposition: 'WAITING', code: 'attempt_in_flight', rule: `${p}.attempt.waiting` }]);
}
/** Rules no main record can reach, each tested directly instead (R5): no main record completes PUBLISH. */
const UNREACHABLE = ['ci.owner', 'eligibility.owner', 'merge.owner', 'post_merge.owner'];

const pick = (a) => ({ stage: a.stage, action: a.action, disposition: a.disposition, code: a.code, rule: a.rule });

test('R1 [N1] every pinned scenario derives exactly one next_action, one disposition per stage, later stages prerequisite_open', () => {
  for (const [name, S, f, want] of SCENARIOS) {
    const { next_action: a, stages } = derive(S, f);
    assert.deepEqual(pick(a), want, name);
    assert.deepEqual(Object.keys(stages), [...STAGES], `${name}: one entry per stage`);
    const i = STAGES.indexOf(a.stage);
    for (const st of STAGES.slice(0, i)) assert.equal(stages[st].disposition, 'COMPLETED', `${name}: ${st} before the current stage`);
    assert.equal(stages[a.stage].disposition, a.disposition, name);
    for (const st of STAGES.slice(i + 1)) assert.deepEqual(stages[st], { disposition: 'BLOCKED', code: 'prerequisite_open', blocked_by: a.stage }, `${name}: ${st}`);
  }
});

test('R1 [N1] rule omission: every rule is load-bearing (omitting it changes a pinned derivation)', () => {
  const ids = [...RULES.map(r => r.id), LOCK_RULE].filter(id => !UNREACHABLE.includes(id));
  const dead = ids.filter(id => !SCENARIOS.some(([, S, f]) => JSON.stringify(derive(S, f)) !== JSON.stringify(derive(S, f, { omit: [id] }))));
  assert.deepEqual(dead, [], 'each rule decides at least one pinned scenario');
  assert.deepEqual(UNREACHABLE.filter(id => !RULES.some(r => r.id === id)), [], 'the unreachable list names real rules');
});

test('the FREEZE stage: frozen, or taken by the original review gate (first-review actions stay under REVIEW for S-23 class-from-stage)', () => {
  assert.deepEqual(derive(S0(), F0()).stages.FREEZE, { disposition: 'COMPLETED', code: 'freeze_at_review_gate', rule: 'freeze.at_review_gate', owner: 'orchestrator' });
  assert.equal(derive(reviewed(), F0()).stages.FREEZE.code, 'frozen');
  for (const [name, S, f, want] of SCENARIOS) if (['dispatch_review', 'gate_review'].includes(want.action)) assert.ok(['REVIEW', 'CONFIRMATION'].includes(want.stage), name);
});

test('next_action carries exactly the stable keys S-23 and the wave layer read; owner is the action\'s; executor reserved null', () => {
  for (const [name, S, f] of SCENARIOS) {
    const a = derive(S, f).next_action;
    assert.deepEqual(Object.keys(a), [...NEXT_KEYS], name);
    assert.equal(a.schema, NEXT_SCHEMA);
    assert.equal(a.owner, ACTIONS[a.action], `${name}: owner fixed by the action`);
    assert.equal(a.executor, null, name);
    assert.ok(STAGES.includes(a.stage) && DISPOSITIONS.includes(a.disposition) && TURN_ENDS.includes(a.turn_end), name);
    assert.ok(Array.isArray(a.reasons) && a.reasons.length > 0 && a.reasons.every(r => typeof r === 'string'), name);
  }
  assert.deepEqual(Object.keys(failedNext(Object.assign(new Error('x'), { code: 'legacy_state' }))), [...NEXT_KEYS]);
  assert.deepEqual(Object.keys(underivedNext(new Error('x'))), [...NEXT_KEYS]);
});

test('R2 [N2] turn_end over every disposition x owner', () => {
  const want = { READY: 'CONTINUE', RUNNING: 'CONTINUE', WAITING: 'CONTINUE', FAILED: 'FAIL', COMPLETED: 'COMPLETE', NEEDS_APPROVAL: 'WAIT_FOR_USER' };
  for (const d of DISPOSITIONS) for (const o of ['human', 'orchestrator', 'engine']) {
    assert.equal(turnEnd(d, o), d === 'BLOCKED' ? (o === 'human' ? 'WAIT_FOR_USER' : 'CONTINUE') : want[d], `${d} x ${o}`);
  }
  const a = derive(reviewed({ ship_ready: { candidate_id: C1 } }), F0()).next_action;
  assert.deepEqual([a.disposition, a.owner, a.turn_end], ['BLOCKED', 'human', 'WAIT_FOR_USER']);
});

test('R3 [N3] a human-owned code never yields READY, RUNNING, WAITING or CONTINUE (judgment, gate refusal, repeat)', () => {
  for (const code of HUMAN_CODES) for (const repeat of [1, 2]) {
    const r = refusal(code, ['x'], { action: 'gate_review', repeat });
    assert.ok(['BLOCKED', 'NEEDS_APPROVAL'].includes(r.disposition), `${code}: ${r.disposition}`);
    assert.equal(ACTIONS[r.action], 'human', `${code}: owner ${ACTIONS[r.action]}`);
    assert.equal(turnEnd(r.disposition, ACTIONS[r.action]), 'WAIT_FOR_USER', code);
  }
  for (const code of ['stale_candidate', 'base_moved_local', 'approval_mismatch', 'reviewer_is_builder']) {
    const a = derive(S0(), F0({ blockers: [{ code, node: 'a', reason: 'x' }] })).next_action;
    assert.equal(a.turn_end, 'WAIT_FOR_USER', `${code} as a node judgment`);
    assert.equal(a.owner, 'human', code);
  }
  for (const d of ['READY', 'RUNNING', 'WAITING']) assert.equal(humanGuard({ disposition: d, action: 'owner_decide', code: 'x' }).disposition, 'BLOCKED', `guard ${d}`);
  assert.equal(humanGuard({ disposition: 'READY', action: 'drive', code: 'x' }).disposition, 'READY');
});

test('R4 [N9] an unloadable state is FAILED (turn_end FAIL, never COMPLETE); no_state is READY init', () => {
  for (const code of ['policy_version_unsupported', 'legacy_state', 'base_state_missing', 'test_kinds_state_missing', 'identity_state_missing', 'state_unreadable']) {
    const a = failedNext(Object.assign(new Error(`${code}: x`), { code }));
    assert.deepEqual([a.disposition, a.turn_end, a.code], ['FAILED', 'FAIL', code], code);
    assert.ok(a.failure_class !== null, code);
  }
  for (const e of [new SyntaxError('Unexpected token'), 'thrown string', null]) {
    const a = failedNext(e);
    assert.deepEqual([a.disposition, a.turn_end, a.failure_class], ['FAILED', 'FAIL', 'UNKNOWN_FAILURE']);
  }
  const install = failedNext(Object.assign(new Error('x'), { code: 'policy_version_unsupported' }));
  assert.deepEqual([install.action, install.owner, install.fallback.allowed], ['authorize_fallback', 'human', true]);
  const fresh = failedNext(Object.assign(new Error('no engine state'), { code: 'no_state' }));
  assert.deepEqual([fresh.disposition, fresh.action, fresh.turn_end, fresh.failure_class], ['READY', 'init', 'CONTINUE', null]);
  const u = underivedNext(new Error('boom'));
  assert.deepEqual([u.disposition, u.owner, u.turn_end, u.failure_class], ['BLOCKED', 'human', 'WAIT_FOR_USER', 'UNKNOWN_FAILURE']);
});

test('R5 [N10] A4: after SHIP_READY the answer is WAIT_FOR_USER owner_publish; PUBLISH..POST_MERGE are human-owned', () => {
  const { next_action: a, stages } = derive(reviewed({ ship_ready: { candidate_id: C1, seq: 9 } }), F0());
  assert.deepEqual([a.stage, a.action, a.owner, a.turn_end], ['PUBLISH', 'owner_publish', 'human', 'WAIT_FOR_USER']);
  for (const st of ['CI', 'ELIGIBILITY', 'MERGE', 'POST_MERGE']) assert.equal(stages[st].code, 'prerequisite_open', st);
  for (const st of ['PUBLISH', 'CI', 'ELIGIBILITY', 'MERGE', 'POST_MERGE']) {
    const rules = RULES.filter(r => r.stage === st);
    assert.equal(rules.length, 1, `${st}: one rule`);
    const r = rules[0].when(S0(), F0(), {});
    assert.equal(ACTIONS[r.action], 'human', `${st} is never orchestrator- or engine-owned`);
    assert.equal(turnEnd(r.disposition, ACTIONS[r.action]), 'WAIT_FOR_USER', st);
  }
  for (const [name, S, f] of SCENARIOS) assert.notEqual(derive(S, f).next_action.turn_end, 'COMPLETE', `${name}: COMPLETE is unreachable in 14a`);
});

test('R10 [N6] verified liveness: alive only with an equal start time; gone, reused or unknown never alive', { skip: process.platform === 'win32' ? 'POSIX start times' : false }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const start = processInfo(child.pid).startTime;
    assert.ok(start, 'ps reports the child start time');
    assert.deepEqual(verify(child.pid, start), { state: 'alive', reason: 'start_time_equal' });
    assert.deepEqual(verify(child.pid, 'Mon Jan  1 00:00:00 2001'), { state: 'dead', reason: 'pid_reused' });
    assert.deepEqual(verify(child.pid, null), { state: 'unknown', reason: 'start_time_unknown' });
    assert.deepEqual(verify(child.pid, start, () => ({ alive: true, startTime: null })), { state: 'unknown', reason: 'start_time_unknown' });
  } finally { child.kill('SIGKILL'); await new Promise(r => child.on('exit', r)); }
  assert.deepEqual(verify(child.pid, 'whatever', () => ({ alive: false, startTime: null })), { state: 'dead', reason: 'no_process' });
  assert.deepEqual(verify(undefined, 'x'), { state: 'unknown', reason: 'no_pid_recorded' });
});

test('R11 [N4] [N5] every table row maps to its class; unknown is UNKNOWN_FAILURE; only ENGINE install offers a fallback, via WAIT_FOR_USER', () => {
  const rows = [['SECURITY_GATE_FAILURE', FAILURE_CLASSES.SECURITY_GATE_FAILURE], ['APPROVAL_OR_OWNERSHIP_FAILURE', FAILURE_CLASSES.APPROVAL_OR_OWNERSHIP_FAILURE],
    ['ENGINE_FAILURE', FAILURE_CLASSES.ENGINE_FAILURE.verification], ['ENGINE_FAILURE', FAILURE_CLASSES.ENGINE_FAILURE.install], ['UNKNOWN_FAILURE', FAILURE_CLASSES.UNKNOWN_FAILURE]];
  const S = S0({ config: { pinnedBase: { remote: 'origin' } }, policy_version: 5 });
  for (const [cls, codes] of rows) for (const code of codes) {
    assert.equal(classOf(code)[0], cls, code);
    const a = derive(S, F0({ unbound: [{ code, node: null, reason: 'x' }] })).next_action;
    assert.equal(a.failure_class, cls, code);
    assert.equal(a.fallback.allowed, codes === FAILURE_CLASSES.ENGINE_FAILURE.install, `${code}: fallback`);
    if (a.fallback.allowed) {
      assert.deepEqual([a.action, a.turn_end], ['authorize_fallback', 'WAIT_FOR_USER'], code);
      assert.deepEqual(a.fallback.missing_guarantees, ['ledger_bound_red', 'review_freeze_binding', 'engine_review_chain', 'quiescence_proof', 'ship_ready_conjunction', 'pinned_base_verification']);
    }
  }
  for (const code of ['never_heard_of_it', 'false_positive']) assert.deepEqual(classOf(code), ['UNKNOWN_FAILURE'], code);
  assert.equal(classOf('node_failed'), null);
  const all = rows.flatMap(([, c]) => c), outcomes = Object.values(WORK_OUTCOMES).flat();
  assert.equal(new Set(all).size, all.length, 'no code in two classes');
  assert.deepEqual(all.filter(c => outcomes.includes(c)), [], 'no code is both a class row and a work outcome');
  assert.deepEqual(missingGuarantees(S0()), ['ledger_bound_red', 'review_freeze_binding', 'engine_review_chain', 'quiescence_proof', 'ship_ready_conjunction']);
  assert.deepEqual(missingGuarantees(S0({ policy_version: 8 })).slice(5), ['pinned_base_verification', 'test_kind_freeze', 'security_obligation_matrix']);
  assert.deepEqual(missingGuarantees({ policy_version: 999 }).length, 5, 'an unsupported version: the engine\'s own only');
});

test('owner-module code lists (loaded lazily by the engine) are classified as SECURITY_GATE_FAILURE (OD-2)', async () => {
  const lists = [(await import('./security-plan.mjs')).SECURITY_CODES.filter(c => c !== 'bad_input'), (await import('./engine-test-kinds.mjs')).CODES.filter(c => c !== 'waiver_unauthorized'),
    (await import('./engine-test-kinds-base.mjs')).REFUSALS];
  const src = readFileSync(join(HERE, 'test-kinds.mjs'), 'utf8');
  const required = [...src.matchAll(/errors\.push\('([a-z_]+)'\)/g)].map(m => m[1]).filter(c => c !== 'plan_invalid');
  for (const code of [...lists.flat(), ...required]) assert.equal(classOf(code)?.[0], 'SECURITY_GATE_FAILURE', code);
  assert.deepEqual(classOf('waiver_unauthorized'), ['APPROVAL_OR_OWNERSHIP_FAILURE'], 'an owner authority refusal');
});

/** The constructors scanned (R12): their first code literal, plus every `code: '...'` property literal. */
export const CODE_CONSTRUCTORS = ['coded', 'judgment', 'gateNo', 'pushJudgment', 'transientOnce', 'no'];
function scanCodes(dir) {
  const files = [...readdirSync(dir).filter(f => f.endsWith('.mjs')), ...readdirSync(join(dir, 'lib')).filter(f => f.endsWith('.mjs')).map(f => `lib/${f}`)]
    .filter(f => !/\.test\.mjs$|\.test-helper\.mjs$|test-fixture\.mjs$/.test(f) && f !== 'engine-next.mjs'); // its own codes are derivation codes
  const out = new Map();
  for (const f of files) {
    const t = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    for (const re of [/\b(?:coded|judgment|gateNo|no)\(\s*'([a-z][a-z0-9_]*)'/g, /\b(?:pushJudgment|transientOnce)\([^,()]+,\s*'([a-z][a-z0-9_]*)'/g,
      /\bpushJudgment\([^,()]+,[^,()]*\?\s*'([a-z][a-z0-9_]*)'\s*:\s*'([a-z][a-z0-9_]*)'/g, /\bcode:\s*'([a-z][a-z0-9_]*)'/g]) {
      for (const m of t.matchAll(re)) for (const c of m.slice(1).filter(Boolean)) out.set(c, [...(out.get(c) ?? []), f]);
    }
  }
  return out;
}

test('R12 registration: every code literal of the engine\'s code constructors and every `code:` literal is classified or a listed work outcome', () => {
  const found = scanCodes(HERE);
  assert.ok(found.size > 100, `the scan found the codes (${found.size})`);
  for (const sentinel of ['post_freeze_drift', 'base_moved_local', 'missing_reconciliation', 'lock_malformed', 'node_failed', 'ownership_violation', 'repair_outside_findings'])
    assert.ok(found.has(sentinel), `the scan sees ${sentinel}`);
  const known = new Set([...FAILURE_CLASSES.SECURITY_GATE_FAILURE, ...FAILURE_CLASSES.APPROVAL_OR_OWNERSHIP_FAILURE, ...FAILURE_CLASSES.ENGINE_FAILURE.verification,
    ...FAILURE_CLASSES.ENGINE_FAILURE.install, ...FAILURE_CLASSES.UNKNOWN_FAILURE, ...Object.values(WORK_OUTCOMES).flat()]);
  const missing = [...found].filter(([c]) => !known.has(c)).map(([c, fs]) => `${c} (${[...new Set(fs)].join(', ')})`);
  assert.deepEqual(missing, [], 'classify each new code in engine-next.mjs FAILURE_CLASSES or WORK_OUTCOMES (S-28a, S-15, S-28b builders included)');
});

test('R14 advisory only: no module but run-engine.mjs (status) imports engine-next, and none reads next_action', () => {
  const users = readdirSync(HERE).filter(f => f.endsWith('.mjs') && !/\.test\.mjs$|\.test-helper\.mjs$/.test(f) && f !== 'engine-next.mjs')
    .filter(f => /(?:from |import\()'\.\/engine-next\.mjs'/.test(readFileSync(join(HERE, f), 'utf8')));
  assert.deepEqual(users, ['run-engine.mjs']);
  const src = readFileSync(join(HERE, 'run-engine.mjs'), 'utf8');
  assert.equal([...src.matchAll(/import\('\.\/engine-next\.mjs'\)/g)].length, 2, 'loaded only by status (nextFacts) and its failure answer');
  for (const f of readdirSync(HERE).filter(x => x.endsWith('.mjs') && !/\.test\.mjs$|\.test-helper\.mjs$/.test(x) && x !== 'engine-next.mjs')) {
    assert.ok(!/\.next_action\b/.test(readFileSync(join(HERE, f), 'utf8')), `${f} never reads next_action`);
  }
});

test('R16 lock held: a READY stage is RUNNING wait; a non-READY stage keeps its own answer', () => {
  const held = F0({ lock: { state: 'held' } });
  assert.deepEqual(pick(derive(S0(), held).next_action), { stage: 'REVIEW', action: 'wait', disposition: 'RUNNING', code: 'engine_running', rule: LOCK_RULE });
  assert.equal(derive(S0(), held).next_action.detail.then, 'dispatch_review');
  assert.equal(derive(S0(), F0({ lock: { state: 'held' }, dispatches: [disp('primary'), disp('second_opinion')] })).next_action.disposition, 'WAITING');
});

test('R15 units: unit_reviews_pending yields unit_review; ready_work lists nodes, repairs, RED and unit reviews; budget stop empties it', () => {
  assert.equal(derive(S0(), F0({ unitReviewsPending: ['u1'] })).next_action.action, 'unit_review');
  const S = S0({ repairs: [{ id: 'r1', state: 'pending' }], locks: { db: 'att-9' } });
  const ext = { ready: [{ id: 'a', resources: [] }, { id: 'b', resources: ['db'] }], redPending: ['c'], unitReviewsPending: ['u1'], budgetStop: false };
  assert.deepEqual(readyWork(S, ext), { ready_work_capacity: 'open', ready_work: [
    { kind: 'node', id: 'a', action: 'drive', fits: true, admission: 'at_dispatch' }, { kind: 'node', id: 'b', action: 'drive', fits: false, admission: 'at_dispatch' },
    { kind: 'repair', id: 'r1', action: 'drive', admission: 'at_dispatch' }, { kind: 'red', id: 'c', action: 'gate_red' }, { kind: 'unit_review', id: 'u1', action: 'unit_review' }] });
  assert.deepEqual(readyWork(S, { ...ext, budgetStop: true }), { ready_work: [], ready_work_capacity: 'budget_stop' });
});

// ---- Round 1 repair (PR #125): each test is RED on b831918 and names its mutant -------------------------------
import * as NX from './engine-next.mjs';

test('R1r1 [N12] every judgment is evaluated: a human-owned one outranks an earlier orchestrator-owned one', () => {
  const S = S0({ nodes: { a: { id: 'a', state: 'failed', deps: [], redSpecs: [] } } });
  const a = derive(S, F0({ blockers: [{ code: 'ownership_unavailable', node: 'a', reason: 'git' }, { code: 'ownership_violation', node: 'a', reason: 'wrote x' }] })).next_action;
  assert.deepEqual([a.code, a.owner, a.turn_end, a.failure_class], ['ownership_violation', 'human', 'WAIT_FOR_USER', 'APPROVAL_OR_OWNERSHIP_FAILURE']);
  assert.equal(a.reasons.length, 2, 'every judgment stays in the reasons');
  const loose = derive(S0(), F0({ blockers: [{ code: 'node_failed', node: null, reason: 'x' }, { code: 'stale_candidate', node: null, reason: 'y' }] })).next_action;
  assert.deepEqual([loose.code, loose.owner], ['stale_candidate', 'human']);
});

test('R1r1 [N13] a recorded SHIP_READY completes only for the CURRENT candidate and with no later ship-ready refusal', () => {
  const S = reviewed({ ship_ready: { candidate_id: C1, seq: 9 } });
  const moved = derive(S, F0({ candidate: { id: C2 } })).next_action;
  assert.deepEqual([moved.stage, moved.code, moved.owner], ['SHIP_READY', 'post_freeze_drift', 'human'], 'a moved tree is never shipped as C1');
  const gone = derive(S, F0({ candidate: { id: null, reason: 'git failed' } })).next_action;
  assert.deepEqual([gone.stage, gone.code], ['SHIP_READY', 'candidate_unavailable']);
  const later = derive(S, F0({ gates: [...row('review', true, 'review_accepted', C1, NOW - 9), ...row('ship-ready', false, 'evidence_run_failed', C1, NOW)] })).next_action;
  assert.deepEqual([later.stage, later.code], ['SHIP_READY', 'evidence_run_failed'], 'a later refusal outranks the cached SHIP_READY');
});

test('R1r1 [N18] a ship-ready refusal of ANOTHER candidate never blocks the current one', () => {
  const a = derive(reviewed(), F0({ gates: [...row('review', true, 'review_accepted', C1, NOW - 9), ...row('ship-ready', false, 'evidence_run_failed', C2, NOW)] })).next_action;
  assert.deepEqual([a.stage, a.action, a.code], ['SHIP_READY', 'gate_ship_ready', 'ship_ready_owed']);
});

test('R1r1 [N14] every dispatched lane must have its result: a pending partition keeps the review waiting, and a refusal waits for it too', () => {
  const lanes = [ready('primary', { event_id: 'fe', name: 'frontend_review' }), ready('second_opinion'), disp('primary', { event_id: 'be', name: 'backend_review' })];
  const a = derive(S0(), F0({ dispatches: lanes })).next_action;
  assert.deepEqual([a.action, a.disposition], ['wait', 'WAITING'], JSON.stringify(a));
  const g = derive(S0(), F0({ dispatches: lanes, gates: row('review', false, 'stale_candidate', C1, NOW, 1) })).next_action;
  assert.notEqual(g.action, 'gate_review', 'a pending lane never yields gate_review');
});

test('R1r1 [N15] a confirmation second opinion belongs to the confirmation (phase and candidate), never consumed by the original record', () => {
  const S = confirming();
  const pending = derive(S, F0({ candidate: { id: C2 }, dispatches: [ready('confirmation', { candidate_id: C2 }), disp('second_opinion', { event_id: 'so2', candidate_id: C2 })] })).next_action;
  assert.deepEqual([pending.stage, pending.action, pending.disposition], ['CONFIRMATION', 'wait', 'WAITING'], JSON.stringify(pending));
  const both = derive(S, F0({ candidate: { id: C2 }, dispatches: [ready('confirmation', { candidate_id: C2 }), ready('second_opinion', { event_id: 'so2', candidate_id: C2 })] })).next_action;
  assert.deepEqual(both.detail.results.map(r => r.role).sort(), ['confirmation', 'second_opinion']);
  assert.equal(typeof NX.dispatchKind, 'function', 'dispatchKind is exported (gather uses it for unconsumed results)');
  assert.equal(NX.dispatchKind(S, { role: 'second_opinion', review_execution: 'review-1', candidate_id: C2 }), 'confirmation');
  assert.equal(NX.dispatchKind(S, { role: 'second_opinion', review_execution: 'review-1', candidate_id: C1 }), 'original');
});

test('R1r1 [N19] with no review execution chosen, an incomplete execution of another candidate never mixes into this one', () => {
  const a = derive(S0(), F0({ candidate: { id: C2 }, dispatches: [ready('primary', { candidate_id: C1 })] })).next_action;
  assert.deepEqual([a.action, a.detail.roles, a.detail.candidate_id, a.detail.review_execution], ['dispatch_review', ['primary', 'second_opinion'], C2, null]);
});

test('R1r1 [N16] a repeated ENGINE verification refusal escalates to the human (WAIT_FOR_USER)', () => {
  assert.equal(ACTIONS[refusal('candidate_unavailable', ['x']).action], 'orchestrator');
  const r = refusal('candidate_unavailable', ['x'], { repeat: 2 });
  assert.deepEqual([ACTIONS[r.action], turnEnd(r.disposition, ACTIONS[r.action])], ['human', 'WAIT_FOR_USER']);
  const a = derive(S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], gates: row('review', false, 'base_remote_unavailable', C1, NOW, 2) })).next_action;
  assert.deepEqual([a.owner, a.turn_end], ['human', 'WAIT_FOR_USER']);
});

test('R1r1 [N17] a lock holder whose liveness is unknown is reported held (never free)', () => {
  assert.equal(typeof NX.lockState, 'function', 'lockState is exported');
  const held = { pid: 4242, host: 'h', process_start_time: 'T0' };
  assert.equal(NX.lockState(held, 'h', () => ({ alive: true, startTime: null })).state, 'held');
  assert.equal(NX.lockState(held, 'h', () => ({ alive: true, startTime: 'T0' })).state, 'held');
  assert.equal(NX.lockState(held, 'h', () => ({ alive: false, startTime: null })).state, 'free');
  assert.equal(NX.lockState(held, 'other', () => ({ alive: true, startTime: 'T0' })).state, 'foreign');
});

test('R1r1 [N20] attempt liveness probes the process group: a gone leader with live members is unknown, never dead or alive', () => {
  assert.equal(typeof NX.verifyAttempt, 'function', 'verifyAttempt is exported');
  const a = { status: 'launched', pid: 4242, pgid: 4242, leader_start: 'T0' };
  const gone = () => ({ alive: false, startTime: null });
  assert.deepEqual(NX.verifyAttempt(a, gone, () => true), { state: 'unknown', reason: 'leader_gone_group_alive' });
  assert.deepEqual(NX.verifyAttempt(a, gone, () => null), { state: 'unknown', reason: 'group_unknown' });
  assert.deepEqual(NX.verifyAttempt(a, gone, () => false), { state: 'dead', reason: 'no_process' });
  assert.deepEqual(NX.verifyAttempt(a, () => ({ alive: true, startTime: 'T0' }), () => true), { state: 'alive', reason: 'start_time_equal' });
});

test('R1r1 [N21] a result is available when its file was written, not when its interval was closed (a refused gate stays the stop)', () => {
  assert.equal(typeof NX.resultTime, 'function', 'resultTime is exported');
  assert.equal(NX.resultTime({ marker_exists: true, mtime: 1000, ended: true, ended_ms: 5000 }), 1000);
  assert.equal(NX.resultTime({ marker_exists: false, mtime: null, ended: true, ended_ms: 5000 }), 5000);
  const closedLater = ready('primary', { ended: true, result_ms: NX.resultTime({ marker_exists: true, mtime: NOW - 10, ended: true, ended_ms: NOW + 10 }) });
  const a = derive(S0(), F0({ dispatches: [closedLater, ready('second_opinion')], gates: row('review', false, 'missing_reconciliation', C1, NOW, 1) })).next_action;
  assert.equal(a.rule, 'signal.gate.review');
});

// ---- Attempt 2 (PR #125 round 2): one total fold over every signal; each test RED on cac50af ----------------------

const AUTH = (code) => ({ code, node: null, reason: code });
test('A2 Codex counterexample 1 [N22]: a loose human judgment beside a node-bound orchestrator judgment is the human\'s stop', () => {
  const S = S0({ nodes: { a: { id: 'a', state: 'failed', deps: [], redSpecs: [] } } });
  const a = derive(S, F0({ blockers: [{ code: 'ownership_unavailable', node: 'a', reason: 'git' }, AUTH('addendum_conflict')] })).next_action;
  assert.deepEqual([a.code, a.owner, a.turn_end], ['addendum_conflict', 'human', 'WAIT_FOR_USER']);
});

test('A2 Codex counterexample 2 [N22]: a loose human judgment after a cached SHIP_READY outranks owner_publish', () => {
  const a = derive(reviewed({ ship_ready: { candidate_id: C1, seq: 9 } }), F0({ blockers: [AUTH('addendum_conflict')] })).next_action;
  assert.deepEqual([a.action, a.code], ['reapprove', 'addendum_conflict']);
});

test('A2 Codex counterexample 3 [N23]: a pending legacy partition (candidate_id null) keeps the review waiting', () => {
  const lanes = [ready('primary', { event_id: 'fe', name: 'frontend_review' }), ready('second_opinion'), disp('primary', { event_id: 'be', name: 'backend_review', candidate_id: null })];
  const a = derive(S0(), F0({ dispatches: lanes })).next_action;
  assert.deepEqual([a.action, a.disposition], ['wait', 'WAITING'], JSON.stringify(a));
});

test('A2 Codex counterexample 4 [N24]: gate history is kept per gate AND candidate: C1 SHIP_READY, C1 refusal, C2 refusal, revert to C1 is never owner_publish', () => {
  const gates = [...row('review', true, 'review_accepted', C1, NOW - 50), ...row('ship-ready', true, 'ship_ready', C1, NOW - 40),
    ...row('ship-ready', false, 'catalog_unavailable', C1, NOW - 30), ...row('ship-ready', false, 'evidence_run_failed', C2, NOW - 20)];
  const a = derive(reviewed({ ship_ready: { candidate_id: C1, seq: 9 } }), F0({ gates })).next_action;
  assert.notEqual(a.action, 'owner_publish');
  assert.deepEqual([a.code, a.owner], ['catalog_unavailable', 'human']);
});

test('A2 [N25] consumption binds the candidate: a result of another candidate is not consumed by the record', () => {
  assert.equal(typeof NX.consumedBy, 'function', 'consumedBy is exported');
  const chain = [PASS];
  assert.equal(NX.consumedBy(chain, { review_execution: 'review-1', candidate_id: C1 }, 'original'), true);
  assert.equal(NX.consumedBy(chain, { review_execution: 'review-1', candidate_id: C2 }, 'original'), false);
  assert.equal(NX.consumedBy(chain, { review_execution: 'review-1', candidate_id: null }, 'original'), true, 'a candidate-less dispatch is bound by its execution');
});

test('A2 [N26] an unavailable candidate escalates to the human once repeated (ship-ready drift and review alike)', () => {
  const unav = F0({ candidate: { id: null, reason: 'git failed' } });
  const once = derive(reviewed({ ship_ready: { candidate_id: C1 } }), unav).next_action;
  assert.deepEqual([once.code, once.owner], ['candidate_unavailable', 'orchestrator']);
  const twice = derive(reviewed({ ship_ready: { candidate_id: C1 } }), { ...unav, gates: row('ship-ready', false, 'candidate_unavailable', null, NOW) }).next_action;
  assert.deepEqual([twice.code, twice.owner, twice.turn_end], ['candidate_unavailable', 'human', 'WAIT_FOR_USER']);
  const review = derive(S0(), { ...unav, gates: row('review', false, 'candidate_unavailable', null, NOW) }).next_action;
  assert.deepEqual([review.code, review.owner], ['candidate_unavailable', 'human']);
});

test('A2 [N27] a spent quiescence_unknown is the engine\'s resume; a live one stays the owner\'s stop', () => {
  const retired = S0({ attempts: [{ attempt_id: 'r1', node: 'a', status: 'abandoned', quiesced: true }] });
  const spent = derive(retired, F0({ blockers: [{ code: 'quiescence_unknown', node: 'a', reason: 'x' }] })).next_action;
  assert.deepEqual([spent.action, spent.owner, spent.turn_end], ['resume', 'engine', 'CONTINUE']);
  const live = derive(S0({ attempts: [{ attempt_id: 'r1', node: 'a', status: 'unknown' }] }), F0({ blockers: [{ code: 'quiescence_unknown', node: 'a', reason: 'x' }] })).next_action;
  assert.deepEqual([live.code, live.owner], ['quiescence_unknown', 'human']);
});

test('A2 an in-progress execution of the current candidate is never hidden by an old candidate\'s complete one', () => {
  const a = derive(S0(), F0({ candidate: { id: C2 }, dispatches: [ready('primary'), ready('second_opinion'),
    disp('primary', { event_id: 'p2', review_execution: 'review-2', candidate_id: C2 }), disp('second_opinion', { event_id: 's2', review_execution: 'review-2', candidate_id: C2 })] })).next_action;
  assert.deepEqual([a.action, a.disposition], ['wait', 'WAITING'], JSON.stringify(a));
  assert.equal(a.detail.item.review_execution, 'review-2');
});

// ---- invariant property test: a deterministic enumeration (>= 5,000 combinations) ------------------------------
const BASES = {
  build_pending: () => [S0({ nodes: { a: { id: 'a', state: 'pending', deps: [], redSpecs: [] } } }), { work: true }],
  review_none: () => [S0(), {}],
  review_partial: () => [S0(), { dispatches: [ready('primary')] }],
  review_ready: () => [S0(), { dispatches: [ready('primary'), ready('second_opinion')] }],
  reviewed_pass: () => [reviewed(), {}],
  shipready_recorded: () => [reviewed({ ship_ready: { candidate_id: C1, seq: 9 } }), {}],
  repairing: () => [repairing('pending'), {}],
  confirming: () => [confirming(), {}],
  confirmed_pass: () => [confirming({ review_chain: [FAIL, REPAIR_REC, { review_execution: 'review-1', kind: 'confirmation', outcome: 'PASS', candidate_id: C2 }] }), {}],
};
const JUDGMENTS = { none: [], node_failed: [{ code: 'node_failed', node: 'a', reason: 'x' }],
  ownership_pair: [{ code: 'ownership_unavailable', node: 'a', reason: 'x' }, { code: 'ownership_violation', node: 'a', reason: 'y' }],
  loose_approval: [AUTH('addendum_conflict')], loose_security: [AUTH('stale_candidate')], quiescence_spent: [{ code: 'quiescence_unknown', node: 'a', reason: 'x' }] };
const CANDS = { C1, C2, none: null };
const PARTITIONS = { none: [], legacy_pending: [disp('primary', { event_id: 'be', name: 'backend_review', candidate_id: null })], extra_done: [ready('primary', { event_id: 'cr', name: 'contract_review' })] };
const HISTORY = { none: [], review_input: row('review', false, 'missing_reconciliation', C1, NOW - 5), review_security: row('review', false, 'stale_candidate', C1, NOW - 5),
  ship_ok: [...row('review', true, 'review_accepted', C1, NOW - 60), ...row('ship-ready', true, 'ship_ready', C1, NOW - 50)],
  ship_revert: [...row('review', true, 'review_accepted', C1, NOW - 60), ...row('ship-ready', true, 'ship_ready', C1, NOW - 50),
    ...row('ship-ready', false, 'catalog_unavailable', C1, NOW - 40), ...row('ship-ready', false, 'evidence_run_failed', C2, NOW - 30)],
  ship_refused_c2: row('ship-ready', false, 'evidence_run_failed', C2, NOW - 5) };
const ATTEMPTS = { none: [], in_flight: [att()], overdue: [att({ deadline_ms: NOW - 1 })] };

function* combinations() {
  for (const [b, base] of Object.entries(BASES)) for (const [j, judgments] of Object.entries(JUDGMENTS)) for (const [c, cand] of Object.entries(CANDS))
    for (const [p, parts] of Object.entries(PARTITIONS)) for (const [h, gates] of Object.entries(HISTORY)) for (const [t, attempts] of Object.entries(ATTEMPTS)) {
      const [S, over] = base();
      if (j === 'quiescence_spent') S.attempts = [{ attempt_id: 'r1', node: 'a', status: 'abandoned', quiesced: true }];
      const dispatches = over.dispatches ? [...over.dispatches, ...parts] : [];
      yield { name: `${b}/${j}/${c}/${p}/${h}/${t}`, S, f: F0({ ...over, dispatches, blockers: judgments, candidate: { id: cand, reason: cand ? undefined : 'git failed' }, gates, attempts }), j, t };
    }
}
/** An output's restrictiveness, read from the answer alone (lower is more restrictive); READY, RUNNING and WAITING are one progress tier; owner_publish is the end tier. */
const metric = (a) => (a.turn_end === 'FAIL' ? 0 : a.turn_end === 'COMPLETE' || a.action === 'owner_publish' ? 4 : a.turn_end === 'WAIT_FOR_USER' ? 1 : a.disposition === 'BLOCKED' ? 2 : 3);
const authorizingOf = (S) => { const l = (S.review_chain ?? []).at(-1); return l && ['original', 'confirmation'].includes(l.kind) && l.outcome === 'PASS' ? l : null; };

test('A2 invariants [N22] [N23] [N24] over >= 5,000 enumerated combinations: I1 human never CONTINUE, I2 publish only a valid current SHIP_READY, I3 no executor, I4 monotone, I5 no gate over a pending lane', () => {
  let n = 0;
  const fails = [];
  for (const { name, S, f, j, t } of combinations()) {
    n++;
    const a = derive(S, f).next_action;
    const cur = f.candidate.id;
    // I1: a human-owned signal present (a judgment the owner resolves, or an overdue attempt) never continues silently
    const human = f.blockers.some(x => j !== 'quiescence_spent' && ACTIONS[refusal(x.code, ['x']).action] === 'human') || t === 'overdue';
    if (human && a.owner !== 'human' && a.turn_end === 'CONTINUE') fails.push(`I1 ${name}: ${a.action}/${a.turn_end}`);
    // I2: owner_publish (or COMPLETE) only for the CURRENT candidate's SHIP_READY of the accepted review, with no later refusal of it
    if (a.action === 'owner_publish' || a.turn_end === 'COMPLETE') {
      const rows = f.gates.filter(g => g.gate === 'ship-ready' && (g.candidate_id == null || g.candidate_id === cur));
      const lastOk = rows.map(g => g.ok).lastIndexOf(true);
      const ok = cur && S.ship_ready?.candidate_id === cur && authorizingOf(S)?.candidate_id === cur && !rows.slice(lastOk + 1).some(g => !g.ok);
      if (!ok) fails.push(`I2 ${name}`);
    }
    // I3: no model-owned action carries an executor; the owner is the action's
    if (a.executor !== null || a.owner !== ACTIONS[a.action]) fails.push(`I3 ${name}`);
    // I5: gate review is never offered while a dispatched lane of that execution (a legacy candidate-less one included) is pending
    if (a.action === 'gate_review' && a.disposition === 'READY') {
      const pending = f.dispatches.filter(d => d.review_execution === a.detail.review_execution && (d.candidate_id == null || a.detail.results.length) && !(d.ended || d.marker_exists));
      if (pending.length) fails.push(`I5 ${name}`);
    }
    // I4: adding a signal (a judgment, an attempt) never makes the answer less restrictive
    if (j === 'none' && t === 'none') {
      for (const [jj, list] of Object.entries(JUDGMENTS)) for (const [tt, attempts] of Object.entries(ATTEMPTS)) {
        if (jj === 'quiescence_spent') continue;
        const more = derive(S, { ...f, blockers: list, attempts }).next_action;
        if (metric(more) > metric(a)) fails.push(`I4 ${name} + ${jj}/${tt}: ${metric(a)} -> ${metric(more)}`);
      }
    }
  }
  assert.ok(n >= 5000, `enumerated ${n} combinations`);
  assert.deepEqual(fails.slice(0, 15), [], `${fails.length} invariant violations`);
});
