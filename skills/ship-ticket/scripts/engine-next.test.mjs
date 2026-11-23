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
  LOOSE_JUDGMENT_RULE, LOCK_RULE, classOf, refusal, turnEnd, failedNext, underivedNext, missingGuarantees, verify, humanGuard, readyWork } from './engine-next.mjs';
import { processInfo } from './engine-quiesce.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-23T12:00:00Z');
const C1 = 'c'.repeat(64), C2 = 'd'.repeat(64);

const S0 = (over = {}) => ({ run_id: 'run-1', ticket: 'T-1', policy_version: 1, config: {}, nodes: { a: { id: 'a', state: 'done', deps: [], redSpecs: [] } },
  review_chain: [], repairs: [], attempts: [], judgments: [], authority: { trusted: [], untrusted: [] }, freeze: null, ...over });
const F0 = (over = {}) => ({ now: NOW, lock: { state: 'free' }, attempts: [], dispatches: [], unbound: [], blockers: [], redPending: [], unitReviewsPending: [],
  work: false, budgetStop: false, candidate: { id: C1 }, lastGate: {}, ...over });

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
  ['loose judgment stops a READY stage', S0(), F0({ blockers: [{ code: 'billing_unverified', node: null, reason: 'x' }] }), { stage: 'REVIEW', action: 'owner_decide', disposition: 'NEEDS_APPROVAL', code: 'billing_unverified', rule: LOOSE_JUDGMENT_RULE }],
  ['lock held', S0(), F0({ lock: { state: 'held' } }), { stage: 'REVIEW', action: 'wait', disposition: 'RUNNING', code: 'engine_running', rule: LOCK_RULE }],
  ['lock malformed', S0(), F0({ lock: { state: 'malformed', reason: 'unreadable' } }), { stage: 'REVIEW', action: 'authorize_fallback', disposition: 'NEEDS_APPROVAL', code: 'lock_malformed', rule: LOCK_RULE }],
  ['review owed', S0(), F0(), { stage: 'REVIEW', action: 'dispatch_review', disposition: 'READY', code: 'review_owed', rule: 'review.owed' }],
  ['review second opinion owed', S0(), F0({ dispatches: [disp('primary')] }), { stage: 'REVIEW', action: 'dispatch_review', disposition: 'READY', code: 'review_owed', rule: 'review.owed' }],
  ['review in flight', S0(), F0({ dispatches: [disp('primary'), disp('second_opinion')] }), { stage: 'REVIEW', action: 'wait', disposition: 'WAITING', code: 'review_in_flight', rule: 'review.waiting' }],
  ['review overdue', S0(), F0({ dispatches: [disp('primary', { deadline_ms: NOW - 1 }), disp('second_opinion')] }), { stage: 'REVIEW', action: 'resolve', disposition: 'BLOCKED', code: 'review_overdue', rule: 'review.overdue' }],
  ['review results ready', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion', { marker_exists: false, ended: true })] }), { stage: 'REVIEW', action: 'gate_review', disposition: 'READY', code: 'results_ready', rule: 'review.gate' }],
  ['review results ready on a moved tree (results outrank the candidate)', S0(), F0({ candidate: { id: C2 }, dispatches: [ready('primary'), ready('second_opinion')] }), { stage: 'REVIEW', action: 'gate_review', disposition: 'READY', code: 'results_ready', rule: 'review.gate' }],
  ['review gate refused once (orchestrator corrects)', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], lastGate: { review: { ok: false, code: 'missing_reconciliation', candidate_id: C1, at_ms: NOW, repeat: 1 } } }), { stage: 'REVIEW', action: 'gate_review', disposition: 'BLOCKED', code: 'missing_reconciliation', rule: 'review.gate_refused' }],
  ['review gate refused twice (the human decides)', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], lastGate: { review: { ok: false, code: 'missing_reconciliation', candidate_id: C1, at_ms: NOW, repeat: 2 } } }), { stage: 'REVIEW', action: 'owner_decide', disposition: 'BLOCKED', code: 'missing_reconciliation', rule: 'review.gate_refused' }],
  ['review gate refused (integrity: human at once)', S0(), F0({ dispatches: [ready('primary'), ready('second_opinion')], lastGate: { review: { ok: false, code: 'stale_candidate', candidate_id: C1, at_ms: NOW, repeat: 1 } } }), { stage: 'REVIEW', action: 'owner_decide', disposition: 'BLOCKED', code: 'stale_candidate', rule: 'review.gate_refused' }],
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
  ['confirmation gate refused', confirming(), F0({ candidate: { id: C2 }, dispatches: [ready('confirmation', { candidate_id: C2 })], lastGate: { review: { ok: false, code: 'missing_second_opinion', candidate_id: C2, at_ms: NOW, repeat: 1 } } }), { stage: 'CONFIRMATION', action: 'gate_review', disposition: 'BLOCKED', code: 'missing_second_opinion', rule: 'confirmation.gate_refused' }],
  ['confirmation FAIL', confirming({ review_chain: [FAIL, REPAIR_REC, { review_execution: 'review-1', kind: 'confirmation', outcome: 'FAIL', candidate_id: C2 }] }), F0({ candidate: { id: C2 } }), { stage: 'CONFIRMATION', action: 'owner_retry', disposition: 'FAILED', code: 'confirmation_failed', rule: 'confirmation.failed' }],
  ['ship-ready owed after a confirmation', confirming({ review_chain: [FAIL, REPAIR_REC, { review_execution: 'review-1', kind: 'confirmation', outcome: 'PASS', candidate_id: C2 }] }), F0({ candidate: { id: C2 } }), { stage: 'SHIP_READY', action: 'gate_ship_ready', disposition: 'READY', code: 'ship_ready_owed', rule: 'ship_ready.owed' }],
  ['ship-ready owed', reviewed(), F0(), { stage: 'SHIP_READY', action: 'gate_ship_ready', disposition: 'READY', code: 'ship_ready_owed', rule: 'ship_ready.owed' }],
  ['ship-ready refused', reviewed(), F0({ lastGate: { review: { ok: true, at_ms: NOW - 5 }, 'ship-ready': { ok: false, code: 'evidence_run_failed', candidate_id: C1, at_ms: NOW, repeat: 1 } } }), { stage: 'SHIP_READY', action: 'owner_decide', disposition: 'BLOCKED', code: 'evidence_run_failed', rule: 'ship_ready.refused' }],
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
  const ids = [...RULES.map(r => r.id), LOOSE_JUDGMENT_RULE, LOCK_RULE].filter(id => !UNREACHABLE.includes(id));
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
