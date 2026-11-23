/**
 * S-14a (ASTF-8): the ONE derived next action of a single-ticket run, its stage dispositions, the FR-3 C1 facts
 * (unconsumed results, ready work, verified liveness) and the FR-1 failure class of an engine-check refusal.
 * Node built-ins only. ADVISORY: `run-engine.mjs status` is the only caller (lock-free, read-only); no gate,
 * carrier or command reads it as authority, it records nothing and adds no state, event, policy row or flag.
 * Ported from candidate P's engine-next.mjs (a890b0d) by deletion: only the rules that read main's records.
 *
 * `derive(S, f)` is pure over the state and the facts `gather` reads from disk. Stages, in order; the first that
 * is not COMPLETED is current, every later one is BLOCKED `prerequisite_open`:
 *   APPROVAL      the approval binding (verifyBinding)                 BUILD     nodes, attempts, RED, units
 *   FREEZE        COMPLETED `frozen`, or `freeze_at_review_gate` (on main the original `gate review` takes the freeze
 *                 together with its record: no separate step exists, so first-review actions stay under REVIEW)
 *   REVIEW        the original review (orchestrator-dispatched, run-log rows; a bound result is never re-dispatched)
 *   RECONCILE     PASS: not_needed; FAIL with a repair: reconciled; FAIL without one: the owner's RETRY
 *   REPAIR        the one finding-bound repair                         CONFIRMATION  the one targeted confirmation
 *   SHIP_READY    gate ship-ready of the authorizing review's candidate
 *   PUBLISH, CI, ELIGIBILITY, MERGE, POST_MERGE   human-owned (A4): after SHIP_READY the answer is WAIT_FOR_USER
 *                 `owner_publish`; no main record completes PUBLISH, so COMPLETE is unreachable here.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import * as io from './engine-io.mjs';
import { LIVE, processInfo } from './engine-quiesce.mjs';
import { trustedEvents } from './engine-authority.mjs';
import { clampTimeout } from './engine-dag.mjs';
import { runPolicy } from './engine-policy.mjs';

export const NEXT_SCHEMA = 'ship-ticket-engine-next-v1';
export const STAGES = Object.freeze(['APPROVAL', 'BUILD', 'FREEZE', 'REVIEW', 'RECONCILE', 'REPAIR', 'CONFIRMATION', 'SHIP_READY',
  'PUBLISH', 'CI', 'ELIGIBILITY', 'MERGE', 'POST_MERGE']);
export const DISPOSITIONS = Object.freeze(['READY', 'RUNNING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'COMPLETED', 'FAILED']);
export const TURN_ENDS = Object.freeze(['CONTINUE', 'WAIT_FOR_USER', 'FAIL', 'COMPLETE']);
/** The stable top-level keys of `next_action` (S-23 and the wave layer read these; variable details live under `detail`). */
export const NEXT_KEYS = Object.freeze(['schema', 'stage', 'disposition', 'turn_end', 'action', 'owner', 'executor', 'code', 'reasons', 'rule',
  'failure_class', 'fallback', 'detail']);
/** The closed action vocabulary; the owner is fixed by the action (14b adds enroll, context, review_dispatch, review_collect, recover_review). */
export const ACTIONS = Object.freeze({
  reapprove: 'human', new_run: 'human', owner_retry: 'human', recover_attempt: 'human', owner_publish: 'human', owner_decide: 'human',
  authorize_fallback: 'human',
  init: 'orchestrator', gate_red: 'orchestrator', unit_review: 'orchestrator', dispatch_review: 'orchestrator', collect_review: 'orchestrator',
  gate_review: 'orchestrator', gate_ship_ready: 'orchestrator', resolve: 'orchestrator', none: 'orchestrator',
  drive: 'engine', resume: 'engine', wait: 'engine',
});
const MOVING = ['READY', 'RUNNING', 'WAITING'];

/** H/AGENTS "progress never yields": only NEEDS_APPROVAL, a human-owned BLOCKED, FAILED and COMPLETED end the turn. */
export function turnEnd(disposition, owner) {
  if (disposition === 'FAILED') return 'FAIL';
  if (disposition === 'COMPLETED') return 'COMPLETE';
  if (disposition === 'NEEDS_APPROVAL' || (disposition === 'BLOCKED' && owner === 'human')) return 'WAIT_FOR_USER';
  return 'CONTINUE';
}

// ---- FR-1 failure classes ---------------------------------------------------------------------------

/**
 * The class of every engine-check refusal or judgment code (FR-1; OD-2). Hand-coded, never derived from a code's
 * spelling. The engine never emits FALSE_POSITIVE (an owner determination). Owner-module lists the engine loads
 * lazily (security-plan SECURITY_CODES, engine-test-kinds CODES, engine-test-kinds-base REFUSALS, the test-kinds
 * requirement errors) are copied here and pinned against their owners by engine-next.test.mjs.
 */
export const FAILURE_CLASSES = Object.freeze({
  SECURITY_GATE_FAILURE: Object.freeze([
    // security policy, the §3a block and its obligation matrix
    'security_policy_required', 'security_reapproval', 'security_pairs_mismatch', 'security_block_invalid', 'security_na_disputed',
    'security_outcome_escape', 'security_review_stale', 'security_row_escape', 'catalog_unavailable', 'catalog_missing', 'catalog_invalid',
    'surface_inventory_incomplete', 'reassess_stale', 'reassess_unclassified', 'fact_out_of_vocabulary', 'surface_facts_mismatch',
    'fact_uncited', 'control_unpaired', 'classification_missing', 'plan_block_missing', 'plan_block_invalid', 'surface_fact_not_lowerable',
    'surface_fact_ungated', 'surface_fact_reinflates', 'disposition_missing', 'disposition_duplicate', 'disposition_unknown', 'citation_missing',
    // RED
    'red_invalidated', 'red_required', 'spec_unpinned',
    // test kinds (parser refusals stay in their gate class: OD-2)
    'plan_tags_missing', 'plan_line_invalid', 'unknown_tag', 'risk_floor_invalid', 'risk_floor_missing', 'risk_floor_base_mismatch',
    'risk_floor_unavailable', 'risk_class_unmapped', 'surface_kind_unmapped', 'run_state_invalid', 'waiver_invalid', 'declaration_invalid',
    'base_invalid', 'test_kinds_policy_required', 'test_kinds_needs_security_policy', 'test_kinds_runner_missing', 'test_kinds_state_missing',
    'multi_entry_unsupported_v0', 'test_kinds_error', 'test_kinds_held', 'test_kinds_repair_open', 'missing_test_kinds',
    'unmapped_lifecycle_item', 'runner_unsupported', 'runner_config_changed', 'runner_output_tampered', 'runner_survivor',
    'evidence_run_failed', 'evidence_unavailable', 'evidence_unquiet', 'evidence_budget_exceeded', 'candidate_moved', 'acceptance_uncovered',
    // candidate, freeze, quiescence and review-independence integrity
    'stale_candidate', 'candidate_mismatch', 'post_freeze_drift', 'quiescence_unknown', 'unquiesced_exit', 'checker_modified',
    'reviewer_is_builder', 'reviewers_not_distinct', 'reviewers_same_provider', 'run_state_malformed',
    'units_unverified', 'units_consumed_stale', 'unit_reviews_missing', 'unit_unverified', 'stale_evidence', 'stale_base', 'binding_mismatch',
    // pinned base (S-12) and repository identity (S-28a)
    'base_state_missing', 'base_moved_local', 'base_moved_remote', 'base_unverified', 'remote_ambiguous',
    'identity_changed', 'identity_unbound', 'identity_state_missing',
  ]),
  APPROVAL_OR_OWNERSHIP_FAILURE: Object.freeze([
    'approval_mismatch', 'dag_mismatch', 'dag_unbound', 'run_mismatch', 'retry_unauthorized', 'waiver_unauthorized', 'addendum_required',
    'addendum_conflict', 'addendum_outside_contract', 'repair_unauthorized', 'repair_failed', 'round_limit', 'review_terminal',
    'confirmation_spent', 'unit_review_terminal', 'unit_clear_unauthorized', 'unit_invalidation_storm', 'parent_ceiling', 'retry_cap',
    'budget_stop', 'billing_unverified',
    // carrier ownership refusals
    'ownership_violation', 'repair_outside_findings', 'repair_outside_unit', 'crash_with_writes',
  ]),
  ENGINE_FAILURE: Object.freeze({
    /** verification unavailable: recovery only (resolve, then the gate again); never skipped */
    verification: Object.freeze(['base_remote_unavailable', 'candidate_unavailable', 'git_unavailable', 'ownership_unavailable', 'not_a_repo',
      'shared_log_unavailable', 'ci_provider_unavailable', 'ci_billing_blocked']),
    /** install / lock: the only row whose fallback is offered (through WAIT_FOR_USER, never CONTINUE) */
    install: Object.freeze(['policy_version_unsupported', 'legacy_state', 'lock_malformed', 'lock_foreign_host', 'launcher_spawn_failed']),
  }),
  /** Engine-internal I/O and programming faults named explicitly; every unlisted code lands here too. */
  UNKNOWN_FAILURE: Object.freeze(['base_read_async', 'channel_unsupported', 'short_read', 'short_write', 'bad_append', 'lock_cancel_leaked',
    'unreadable', 'log_too_large', 'loss_unrecorded', 'unsafe_history', 'incomplete_tail']),
});

/**
 * Codes that are not engine-check failures (failure_class null): work outcomes, accepted or informational results,
 * input the orchestrator corrects (its own artifact or usage: corrected once, the human's when repeated) and busy signals.
 */
export const WORK_OUTCOMES = Object.freeze({
  work: Object.freeze(['node_failed', 'unit_check_failed', 'fast_check_failed', 'fast_check_incomplete', 'ci_failed', 'ci_mixed_execution']),
  accepted: Object.freeze(['ok', 'preflight_ok', 'red_accepted', 'review_accepted', 'unit_review_accepted', 'ship_ready', 'reassessed',
    'evidence_refreshed', 'catalog_loaded', 'citations_verified', 'matrix_complete', 'obligations', 'selected', 'no_failure_observed',
    'fast_check_skipped', 'not_declared']),
  input: Object.freeze(['bad_input', 'bad_context', 'dag_invalid', 'plan_invalid', 'plan_unreadable', 'state_exists', 'state_unreadable',
    'no_state', 'unknown_command', 'unknown_node', 'unknown_unit', 'mark_refused', 'archive_refused', 'unit_clear_refused',
    'rebind_refused', 'rebind_no_freeze', 'rebind_units', 'rebind_attempts_live', 'rebind_not_frozen_tree', 'rebind_nothing_drifted',
    'rebind_uncovered', 'repair_prompt_missing', 'incomplete_contract', 'missing_second_opinion', 'missing_reconciliation',
    'second_opinion_unusable', 'outcome_inconsistent', 'chain_broken', 'unit_review_open', 'unit_review_disabled', 'unit_review_current',
    'fast_check_invalid', 'start_digest_legacy', 'start_timestamp_legacy']),
  busy: Object.freeze(['lock_held', 'lock_timeout', 'attempts_live']),
});

const CLASS_OF = new Map();
for (const c of FAILURE_CLASSES.SECURITY_GATE_FAILURE) CLASS_OF.set(c, ['SECURITY_GATE_FAILURE']);
for (const c of FAILURE_CLASSES.APPROVAL_OR_OWNERSHIP_FAILURE) CLASS_OF.set(c, ['APPROVAL_OR_OWNERSHIP_FAILURE']);
for (const c of FAILURE_CLASSES.ENGINE_FAILURE.verification) CLASS_OF.set(c, ['ENGINE_FAILURE', 'verification']);
for (const c of FAILURE_CLASSES.ENGINE_FAILURE.install) CLASS_OF.set(c, ['ENGINE_FAILURE', 'install']);
for (const c of FAILURE_CLASSES.UNKNOWN_FAILURE) CLASS_OF.set(c, ['UNKNOWN_FAILURE']);
const OUTCOME = new Set(Object.values(WORK_OUTCOMES).flat());

/** [class, row] of an engine-check code: null for a work outcome, UNKNOWN_FAILURE for anything unlisted (fail closed). */
export function classOf(code) {
  if (OUTCOME.has(code)) return null;
  return CLASS_OF.get(code) ?? ['UNKNOWN_FAILURE'];
}

/** Codes whose stop belongs to the human: every class except ENGINE verification and work outcomes. Never READY or CONTINUE. */
export const HUMAN_CODES = Object.freeze([...FAILURE_CLASSES.SECURITY_GATE_FAILURE, ...FAILURE_CLASSES.APPROVAL_OR_OWNERSHIP_FAILURE,
  ...FAILURE_CLASSES.ENGINE_FAILURE.install, ...FAILURE_CLASSES.UNKNOWN_FAILURE]);

/** The human action a code names (else owner_decide). */
const HUMAN_ACTION_OF = Object.freeze({
  approval_mismatch: 'reapprove', dag_mismatch: 'reapprove', dag_unbound: 'reapprove', security_reapproval: 'reapprove',
  security_policy_required: 'reapprove', addendum_required: 'reapprove', addendum_conflict: 'reapprove', addendum_outside_contract: 'reapprove',
  repair_failed: 'owner_retry', round_limit: 'owner_retry', review_terminal: 'owner_retry', retry_unauthorized: 'owner_retry',
  confirmation_spent: 'owner_retry', run_mismatch: 'new_run',
});

/**
 * The guarantees a fallback run would lose, derived (never recorded) from the run's semantics: the engine's own,
 * plus one per opt-in flag the run carries.
 */
export function missingGuarantees(S) {
  let sem = {};
  try { sem = runPolicy(S ?? {}).semantics; } catch { /* an unsupported version: the engine's own guarantees only */ }
  return ['ledger_bound_red', 'review_freeze_binding', 'engine_review_chain', 'quiescence_proof', 'ship_ready_conjunction',
    ...(sem.pinnedBase === true ? ['pinned_base_verification'] : []), ...(sem.testKinds === true ? ['test_kind_freeze'] : []),
    ...(sem.securityObligations === true ? ['security_obligation_matrix'] : []), ...(sem.repoIdentity === true ? ['repository_identity'] : [])];
}

// ---- results ---------------------------------------------------------------------------------------

const res = (disposition, code, action, extra = {}) => ({ disposition, code, action, reasons: [], ...extra });
const done = (code, detail) => ({ disposition: 'COMPLETED', code, action: 'none', reasons: [], ...(detail ? { detail } : {}) });

/**
 * The disposition of an engine-check refusal or judgment `code` by its class (FR-1). `fallback` is the work-outcome
 * action (e.g. `gate_review` to submit again, `resolve`); `repeat` > 1 hands an orchestrator-owned stop to the human.
 */
export function refusal(code, reasons, { action = 'resolve', repeat = 1, detail } = {}) {
  const cls = classOf(code);
  const base = { code, reasons, failure_class: cls?.[0] ?? null, cause: 'refusal', ...(detail ? { detail } : {}) };
  const human = (a = HUMAN_ACTION_OF[code] ?? 'owner_decide') => ({ ...base, disposition: a === 'owner_decide' ? 'BLOCKED' : 'NEEDS_APPROVAL', action: a });
  if (!cls) return repeat > 1 ? human('owner_decide') : { ...base, disposition: 'BLOCKED', action };
  if (cls[0] === 'ENGINE_FAILURE' && cls[1] === 'verification') return repeat > 1 ? human('owner_decide') : { ...base, disposition: 'BLOCKED', action: 'resolve' };
  if (cls[0] === 'ENGINE_FAILURE') return { ...base, disposition: 'NEEDS_APPROVAL', action: 'authorize_fallback', fallback_offered: true };
  if (cls[0] === 'APPROVAL_OR_OWNERSHIP_FAILURE') return { ...base, disposition: 'NEEDS_APPROVAL', action: HUMAN_ACTION_OF[code] ?? 'owner_decide' };
  return human();
}

/** Class precedence among simultaneous judgments: a human-owned stop is never hidden behind an orchestrator- or engine-owned one. */
const SEVERITY = ['SECURITY_GATE_FAILURE', 'APPROVAL_OR_OWNERSHIP_FAILURE', 'ENGINE_FAILURE', 'UNKNOWN_FAILURE'];
const rank = (r) => (ACTIONS[r.action] === 'human' ? 0 : 1) * 10 + (SEVERITY.indexOf(r.failure_class) + 1 || SEVERITY.length + 1);
/** Every judgment is evaluated; the most severe decides (list order breaks ties), and every reason is kept. */
const judged = (list) => {
  const reasons = list.map(j => `${j.node ? `${j.node}: ` : ''}${j.reason}`);
  const detail = { judgments: list.map(j => ({ code: j.code, ...(j.node ? { node: j.node } : {}) })) };
  const all = list.map(j => refusal(j.code, reasons, { detail }));
  return all.reduce((best, r) => (rank(r) < rank(best) ? r : best));
};

// ---- context derived once per call ----------------------------------------------------------------

const ROLE_KIND = { primary: 'original', second_opinion: 'original', confirmation: 'confirmation' };
/**
 * The review a dispatch belongs to, by phase AND candidate: a second opinion of the repaired review execution on the repaired
 * candidate is the confirmation's (review.md targeted confirmation), never the original's.
 */
export function dispatchKind(S, d) {
  if (d.role !== 'second_opinion') return ROLE_KIND[d.role];
  const rec = (S.review_chain ?? []).find(r => r.kind === 'repair' && r.review_execution === d.review_execution);
  return rec && d.candidate_id === rec.new_candidate ? 'confirmation' : 'original';
}
/** Whether a chain record of the dispatch's review (execution, kind and candidate) consumed it. */
const consumedBy = (chain, d, kind) => chain.some(r => r.review_execution === d.review_execution && r.kind === kind
  && (r.candidate_id === undefined || d.candidate_id === null || r.candidate_id === d.candidate_id));
const RUNNER_STAGE = { repair: 'REPAIR', proof: 'SHIP_READY' };

function context(S, f) {
  const chain = S.review_chain ?? [];
  const O = chain.filter(r => r.kind === 'original').at(-1) ?? null;
  const rx = O?.review_execution ?? null;
  const mine = (k) => (rx ? chain.find(r => r.review_execution === rx && r.kind === k) ?? null : null);
  const last = chain.at(-1);
  const retry = rx ? trustedEvents(S, 'RETRY').find(e => e.run_id === S.run_id && e.predecessor === rx && typeof e.authorized_by === 'string'
    && e.authorized_by.length > 0 && !chain.some(r => r.review_execution === e.review_execution)) ?? null : null;
  const stageOf = (j) => (j.node && (S.nodes?.[j.node] || S.unit_checks?.[j.node]) ? 'BUILD' : j.node && (S.repairs ?? []).some(r => r.id === j.node) ? 'REPAIR' : 'loose');
  const judgments = { BUILD: [], REPAIR: [], loose: [] };
  for (const j of f.blockers ?? []) judgments[stageOf(j)].push(j);
  const attempts = { BUILD: [], REPAIR: [], SHIP_READY: [] };
  for (const a of f.attempts ?? []) attempts[RUNNER_STAGE[a.kind] ?? 'BUILD'].push(a);
  return { S, chain, O, rx, retry, repairRecord: mine('repair'), confirmation: mine('confirmation'),
    repair: rx ? (S.repairs ?? []).find(r => r.kind === 'review' && r.review_execution === rx) ?? null : null,
    authorizing: last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' ? last : null, judgments, attempts };
}

// ---- rule builders --------------------------------------------------------------------------------

function attemptRules(stage) {
  const p = stage.toLowerCase();
  const item = (a) => ({ attempt_id: a.attempt_id, kind: a.kind, node: a.node, started_at: a.started_at ?? null, marker: a.envelope_file ?? null,
    deadline: a.deadline ?? null, liveness: a.liveness?.state ?? 'unknown' });
  return [
    { id: `${p}.attempt.uncollected`, stage, when: (S, f, x) => { const a = x.attempts[stage].find(y => y.envelope || y.status === 'intent');
      return a && res('READY', 'attempt_uncollected', 'resume', { reasons: [`attempt ${a.attempt_id} finished (or never launched) with no engine command to record it: run resume`], detail: { item: item(a) } }); } },
    { id: `${p}.attempt.dead`, stage, when: (S, f, x) => { const a = x.attempts[stage].find(y => !y.envelope && y.liveness?.state === 'dead');
      return a && res('BLOCKED', 'attempt_dead_unreconciled', 'resume', { reasons: [`attempt ${a.attempt_id} is LIVE in state but its process is gone (${a.liveness.reason}) with no envelope: run resume to settle it`], detail: { item: item(a) } }); } },
    { id: `${p}.attempt.overdue`, stage, when: (S, f, x) => { const a = x.attempts[stage].find(y => !y.envelope && f.now > y.deadline_ms);
      return a && res('BLOCKED', 'attempt_overdue', 'recover_attempt', { reasons: [`attempt ${a.attempt_id} has no envelope past ${a.deadline}: confirm process group ${a.pgid ?? a.pid ?? '?'} is gone (stop it if not), then run resume`], detail: { item: item(a) } }); } },
    { id: `${p}.attempt.waiting`, stage, when: (S, f, x) => { const a = x.attempts[stage][0];
      return a && res('WAITING', 'attempt_in_flight', 'wait', { reasons: [`attempt ${a.attempt_id} has no envelope yet`], detail: { item: item(a) } }); } },
  ];
}

const judgmentRule = (stage) => ({ id: `${stage.toLowerCase()}.judgment`, stage, when: (S, f, x) => x.judgments[stage].length > 0 && judged(x.judgments[stage]) });

/**
 * Orchestrator-dispatched review rules (run-log activity starts, S5 binding) of `kind` for REVIEW or CONFIRMATION.
 * `want(S, f, x)` -> { candidate, rx, roles }. Results outrank the work-tree candidate: a dispatch of the chosen
 * review execution whose result is on disk (or whose interval was closed) is owed to `gate review`, which judges staleness.
 */
const ready = (d) => d.ended || d.marker_exists;
/** Every role has a dispatch and EVERY dispatched lane (partition reviewers included) has its result. */
const complete = (roles, list) => roles.every(r => list.some(d => d.role === r)) && list.length > 0 && list.every(ready);

function reviewRules(stage, kind, want) {
  const p = stage.toLowerCase();
  const rows = (S, f, x) => {
    const w = want(S, f, x);
    const mine = (f.dispatches ?? []).filter(d => dispatchKind(S, d) === kind && !consumedBy(x.chain, d, kind)
      && (w.rx ? d.review_execution === w.rx : true));
    const of = (rx) => mine.filter(d => d.review_execution === rx);
    const rolesOf = (list) => [...w.roles, ...(w.optional ?? []).filter(r => list.some(d => d.role === r))];
    // AC3: an execution whose every lane has its result outranks the work-tree candidate (gate review judges staleness);
    // otherwise only dispatches of the current candidate count, so an instruction never mixes two candidates.
    const done = [...new Set(mine.map(d => d.review_execution))].filter(rx => complete(rolesOf(of(rx)), of(rx)));
    const rx = w.rx ?? done.at(-1) ?? mine.filter(d => d.candidate_id === w.candidate).at(-1)?.review_execution ?? null;
    const list = w.rx || done.includes(rx) ? of(rx) : of(rx).filter(d => d.candidate_id === w.candidate);
    const roles = rolesOf(list);
    return { ...w, rx, roles, mine: list.filter(d => roles.includes(d.role)) };
  };
  const item = (d) => ({ role: d.role, event_id: d.event_id, review_execution: d.review_execution, candidate_id: d.candidate_id,
    started_at: d.started_at, marker: d.marker, deadline: d.deadline });
  const all = (w) => complete(w.roles, w.mine);
  return {
    results: [
      { id: `${p}.gate_refused`, stage, when: (S, f, x) => { const w = rows(S, f, x), g = f.lastGate?.review;
        return all(w) && g && !g.ok && w.mine.every(d => ready(d) && (d.result_ms ?? Infinity) <= g.at_ms)
          && refusal(g.code, [`gate review refused (${g.code}) after these ${kind} results were submitted${g.repeat > 1 ? ` (${g.repeat} times in a row)` : ''}`],
            { action: 'gate_review', repeat: g.repeat, detail: { kind, review_execution: w.rx } }); } },
      { id: `${p}.gate`, stage, when: (S, f, x) => { const w = rows(S, f, x);
        return all(w) && res('READY', 'results_ready', 'gate_review', { reasons: [`every ${kind} result of ${w.rx} is in: reconcile and run gate review with them (close each run-log interval with end --carrier-result; never re-dispatch)`],
          detail: { kind, review_execution: w.rx, results: w.mine.filter(ready).map(d => ({ role: d.role, event_id: d.event_id, result_path: d.marker })) } }); } },
    ],
    waiting: [
      { id: `${p}.owed`, stage, when: (S, f, x) => { const w = rows(S, f, x), missing = w.roles.filter(r => !w.mine.some(d => d.role === r));
        return missing.length > 0 && res('READY', kind === 'original' ? 'review_owed' : 'confirmation_owed', 'dispatch_review',
          { reasons: [`dispatch ${missing.join(' and ')} for candidate ${w.candidate}`], detail: { kind, roles: missing, candidate_id: w.candidate, review_execution: w.rx } }); } },
      { id: `${p}.overdue`, stage, when: (S, f, x) => { const d = rows(S, f, x).mine.find(y => !ready(y) && f.now > y.deadline_ms);
        return d && res('BLOCKED', 'review_overdue', 'resolve', { reasons: [`${d.role} (${d.event_id}) has no result past ${d.deadline}: check the carrier, cancel it, and use REVIEW's bounded recovery (review.md)`], detail: { item: item(d) } }); } },
      { id: `${p}.waiting`, stage, when: (S, f, x) => { const d = rows(S, f, x).mine.find(y => !ready(y));
        return d && res('WAITING', 'review_in_flight', 'wait', { reasons: [`${d.role} (${d.event_id}) has no result yet (reviewer liveness unknown: no pid recorded)`], detail: { item: item(d) } }); } },
    ],
  };
}

const originalReview = reviewRules('REVIEW', 'original', (S, f) => ({ candidate: f.candidate?.id, rx: null, roles: ['primary', 'second_opinion'] }));
const confirmationReview = reviewRules('CONFIRMATION', 'confirmation', (S, f, x) => ({ candidate: x.repairRecord?.new_candidate, rx: x.rx,
  roles: ['confirmation'], optional: ['second_opinion'] }));

const humanStop = (stage) => ({ id: `${stage.toLowerCase()}.owner`, stage, when: () => res('BLOCKED', `${stage.toLowerCase()}_owner_owned`, 'owner_publish',
  { reasons: [`${stage} is the owner's (A4): the engine never pushes, opens a PR, reads CI, decides eligibility or merges`] }) });

/** Ordered rules: per stage, the first that matches decides; a stage no rule decides is BLOCKED `underived` (fail closed). */
export const RULES = Object.freeze([
  // APPROVAL
  { id: 'approval.unbound', stage: 'APPROVAL', when: (S, f) => (f.unbound ?? []).length > 0 && judged(f.unbound) },
  { id: 'approval.bound', stage: 'APPROVAL', when: () => done('bound') },
  // BUILD
  ...attemptRules('BUILD'),
  judgmentRule('BUILD'),
  { id: 'build.red', stage: 'BUILD', when: (S, f) => (f.redPending ?? []).length > 0
    && res('READY', 'red_pending', 'gate_red', { reasons: [`node ${f.redPending[0]} is done and its RED is not accepted`], detail: { node: f.redPending[0] } }) },
  { id: 'build.budget', stage: 'BUILD', when: (S, f) => f.work === true && f.budgetStop === true
    && refusal('budget_stop', ['the budget admits no further dispatch']) },
  { id: 'build.unit_review', stage: 'BUILD', when: (S, f) => (f.unitReviewsPending ?? []).length > 0 && !f.work
    && res('READY', 'unit_review_owed', 'unit_review', { reasons: [`unit review owed: ${f.unitReviewsPending.join(', ')}`], detail: { units: [...f.unitReviewsPending] } }) },
  { id: 'build.work', stage: 'BUILD', when: (S, f) => f.work === true && res('READY', 'build_pending', 'drive', { reasons: ['pending or stale nodes, unit checks or PROVE repairs are owed'] }) },
  { id: 'build.done', stage: 'BUILD', when: (S) => Object.values(S.nodes ?? {}).every(n => ['done', 'cancelled'].includes(n.state)) && done('built') },
  // FREEZE (on main the original gate review takes it)
  { id: 'freeze.frozen', stage: 'FREEZE', when: (S) => S.freeze && done('frozen', { candidate_id: S.freeze.candidate }) },
  { id: 'freeze.at_review_gate', stage: 'FREEZE', when: () => done('freeze_at_review_gate') },
  // REVIEW
  { id: 'review.retry', stage: 'REVIEW', when: (S, f, x) => x.retry && retryReview(S, f, x) },
  { id: 'review.recorded', stage: 'REVIEW', when: (S, f, x) => x.O && done(x.O.outcome === 'PASS' ? 'review_passed' : 'review_failed', { review_execution: x.rx, candidate_id: x.O.candidate_id }) },
  ...originalReview.results,
  { id: 'review.candidate', stage: 'REVIEW', when: (S, f) => !f.candidate?.id && refusal('candidate_unavailable', [f.candidate?.reason ?? 'candidate not computable']) },
  ...originalReview.waiting,
  // RECONCILE
  { id: 'reconcile.not_needed', stage: 'RECONCILE', when: (S, f, x) => x.O?.outcome === 'PASS' && done('not_needed') },
  { id: 'reconcile.reconciled', stage: 'RECONCILE', when: (S, f, x) => x.repair && done('reconciled') },
  { id: 'reconcile.terminal', stage: 'RECONCILE', when: (S, f, x) => res('NEEDS_APPROVAL', 'review_terminal', 'owner_retry',
    { reasons: [`review ${x.rx} FAILED with no repair (overflow or nothing to fix): only an owner RETRY linked to it continues`] }) },
  // REPAIR
  { id: 'repair.not_needed', stage: 'REPAIR', when: (S, f, x) => (x.O?.outcome === 'PASS' || !x.repair) && done('not_needed') },
  ...attemptRules('REPAIR'),
  judgmentRule('REPAIR'),
  { id: 'repair.pending', stage: 'REPAIR', when: (S, f, x) => ['pending', 'running'].includes(x.repair?.state)
    && res('READY', 'repair_owed', 'drive', { reasons: [`${x.repair.id} is authorized: drive dispatches it`] }) },
  { id: 'repair.done', stage: 'REPAIR', when: (S, f, x) => ['done', 'cancelled'].includes(x.repair?.state) && done(x.repair.state === 'done' ? 'repaired' : 'superseded') },
  // CONFIRMATION
  { id: 'confirmation.not_needed', stage: 'CONFIRMATION', when: (S, f, x) => !x.repairRecord && done('not_needed') },
  { id: 'confirmation.failed', stage: 'CONFIRMATION', when: (S, f, x) => x.confirmation?.outcome === 'FAIL'
    && res('FAILED', 'confirmation_failed', 'owner_retry', { reasons: [`the targeted confirmation of ${x.rx} FAILED: that is the result (never a new review cycle); only an owner RETRY continues`] }) },
  { id: 'confirmation.recorded', stage: 'CONFIRMATION', when: (S, f, x) => x.confirmation && done('confirmed', { review_execution: x.rx, candidate_id: x.confirmation.candidate_id }) },
  ...confirmationReview.results,
  { id: 'confirmation.drift', stage: 'CONFIRMATION', when: (S, f, x) => x.repairRecord && f.candidate?.id !== x.repairRecord.new_candidate
    && refusal('post_freeze_drift', [`the work tree is ${f.candidate?.id ?? f.candidate?.reason}, the repaired candidate is ${x.repairRecord.new_candidate}: revert the drift, or the owner appends a RETRY`]) },
  ...confirmationReview.waiting,
  // SHIP_READY
  ...attemptRules('SHIP_READY'),
  { id: 'ship_ready.drift', stage: 'SHIP_READY', when: (S, f, x) => x.authorizing && f.candidate?.id !== x.authorizing.candidate_id
    && (f.candidate?.id ? refusal('post_freeze_drift', [`the work tree is ${f.candidate.id}, the accepted review covers ${x.authorizing.candidate_id}: revert the drift, or the owner appends a RETRY`])
      : refusal('candidate_unavailable', [f.candidate?.reason ?? 'candidate not computable'])) },
  { id: 'ship_ready.refused', stage: 'SHIP_READY', when: (S, f) => { const g = f.lastGate?.['ship-ready'], r = f.lastGate?.review;
    return g && !g.ok && g.candidate_id === f.candidate?.id && (!r || g.at_ms >= r.at_ms)
      && refusal(g.code, [`gate ship-ready refused (${g.code}) for this candidate${g.repeat > 1 ? ` (${g.repeat} times in a row)` : ''}`], { action: 'gate_ship_ready', repeat: g.repeat }); } },
  { id: 'ship_ready.recorded', stage: 'SHIP_READY', when: (S, f, x) => x.authorizing && S.ship_ready?.candidate_id === x.authorizing.candidate_id
    && done('ship_ready', { candidate_id: S.ship_ready.candidate_id }) },
  { id: 'ship_ready.owed', stage: 'SHIP_READY', when: (S, f, x) => x.authorizing && res('READY', 'ship_ready_owed', 'gate_ship_ready',
    { reasons: [`the accepted review of ${x.authorizing.candidate_id} has no SHIP_READY`], detail: { candidate_id: x.authorizing.candidate_id } }) },
  // PUBLISH .. POST_MERGE: human-owned (A4)
  ...['PUBLISH', 'CI', 'ELIGIBILITY', 'MERGE', 'POST_MERGE'].map(humanStop),
]);

/** A trusted, unconsumed owner RETRY of the last original review: the new original review is owed under its id. */
function retryReview(S, f, x) {
  const rules = reviewRules('REVIEW', 'original', () => ({ candidate: f.candidate?.id, rx: x.retry.review_execution, roles: ['primary', 'second_opinion'] }));
  for (const r of [...rules.results, ...rules.waiting]) {
    const out = r.when(S, f, x);
    if (out) return { ...out, detail: { ...out.detail, retry: { review_execution: x.retry.review_execution, predecessor: x.rx } } };
  }
  return null;
}

export const LOOSE_JUDGMENT_RULE = 'judgment.loose';
export const LOCK_RULE = 'lock';

/** T2 (fail closed for any future rule): a human-owned action never moves on its own; the engine never invents approval. */
export const humanGuard = (r) => (ACTIONS[r.action] === 'human' && MOVING.includes(r.disposition) ? { ...r, rule: 'human.guard', disposition: 'BLOCKED' } : r);

/** Shape one stage result into the public next_action. */
function shape(stage, r, S) {
  const owner = ACTIONS[r.action];
  const fallback = r.fallback_offered ? { allowed: true, missing_guarantees: missingGuarantees(S) } : { allowed: false };
  return { schema: NEXT_SCHEMA, stage, disposition: r.disposition, turn_end: turnEnd(r.disposition, owner), action: r.action, owner, executor: null,
    code: r.code, reasons: r.reasons ?? [], rule: r.rule, failure_class: r.failure_class ?? null, fallback, detail: r.detail ?? {} };
}

/**
 * Derive one disposition per stage and the next action. `omit` (rule ids) exists for the mutation test only:
 * deleting any rule must change a pinned derivation.
 */
export function derive(S, f, { omit = [] } = {}) {
  const rules = RULES.filter(r => !omit.includes(r.id));
  const x = context(S, f);
  const stages = {};
  let current = null;
  for (const st of STAGES) {
    if (current) { stages[st] = { disposition: 'BLOCKED', code: 'prerequisite_open', blocked_by: current }; continue; }
    let r = null;
    for (const rule of rules) {
      if (rule.stage !== st) continue;
      const out = rule.when(S, f, x);
      if (out) { r = { rule: rule.id, ...out }; break; }
    }
    r ??= { rule: `${st.toLowerCase()}.underived`, ...res('BLOCKED', 'underived', 'owner_decide', { reasons: [`no derivation rule decided ${st} (fail closed)`] }) };
    if (!omit.includes(LOOSE_JUDGMENT_RULE) && ['READY', 'WAITING'].includes(r.disposition) && x.judgments.loose.length) r = { rule: LOOSE_JUDGMENT_RULE, ...judged(x.judgments.loose) };
    if (!omit.includes(LOCK_RULE) && r.disposition === 'READY' && f.lock?.state === 'held')
      r = { rule: LOCK_RULE, ...res('RUNNING', 'engine_running', 'wait', { reasons: [`an engine command holds the run lock; ${r.action} follows once it returns`], detail: { then: r.action } }) };
    else if (!omit.includes(LOCK_RULE) && r.disposition === 'READY' && ['malformed', 'foreign'].includes(f.lock?.state))
      r = { rule: LOCK_RULE, ...refusal(f.lock.state === 'malformed' ? 'lock_malformed' : 'lock_foreign_host', [f.lock.reason, 'recover the lock by hand (execution-harness.md), or authorize a fallback']) };
    r = humanGuard(r);
    stages[st] = { disposition: r.disposition, code: r.code, rule: r.rule, owner: ACTIONS[r.action] };
    if (r.disposition !== 'COMPLETED') { current = st; stages[st].result = r; }
  }
  const next_action = current ? shape(current, stages[current].result, S)
    : shape(null, { disposition: 'COMPLETED', code: 'completed', action: 'none', rule: 'completed' }, S);
  if (current) delete stages[current].result;
  return { next_action, stages };
}

/** The FAILED answer when the state cannot be loaded (never COMPLETE); `no_state` is READY `init`. */
export function failedNext(e, raw = null) {
  if (e?.code === 'no_state') return shape(null, { disposition: 'READY', code: 'no_state', action: 'init', rule: 'state.missing', reasons: [e.message] }, raw);
  const code = typeof e?.code === 'string' ? e.code : 'uncoded_error';
  const cls = classOf(code) ?? ['UNKNOWN_FAILURE'];
  const install = cls[0] === 'ENGINE_FAILURE' && cls[1] === 'install';
  return shape(null, { disposition: 'FAILED', code, action: install ? 'authorize_fallback' : 'owner_decide', rule: 'state.unloadable',
    reasons: [String(e?.message ?? e)], failure_class: cls[0], fallback_offered: install }, raw);
}

/** The derivation itself failed (a throw while reading facts): a human stop, and status keeps every existing key. */
export const underivedNext = (e) => shape(null, { disposition: 'BLOCKED', code: 'next_underived', action: 'owner_decide', rule: 'derivation.failed',
  reasons: [`the next action could not be derived: ${String(e?.message ?? e).split('\n')[0]}`], failure_class: 'UNKNOWN_FAILURE' }, null);

// ---- facts from disk (read-only) -----------------------------------------------------------------------

export const DEFAULT_REVIEW_CEILING_MS = 20 * 60 * 1000;
export const ATTEMPT_GRACE_MS = 60 * 1000;
const CEILING_OF = { primary: 'primary_ceiling_ms', second_opinion: 'optional_ceiling_ms', confirmation: 'confirmation_ceiling_ms' };
const ms = (t) => { const v = Date.parse(t ?? ''); return Number.isFinite(v) ? v : null; };
const iso = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : null);

/**
 * Verified liveness of one recorded process: `alive` only when it answers and its start time is known on both sides
 * and equal; gone or a different start (`pid_reused`) is `dead`; anything unprovable is `unknown`.
 */
export function verify(pid, recordedStart, info = processInfo) {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'no_pid_recorded' };
  const now = info(pid) ?? { alive: false, startTime: null };
  if (!now.alive) return { state: 'dead', reason: 'no_process' };
  if (!recordedStart || !now.startTime) return { state: 'unknown', reason: 'start_time_unknown' };
  return now.startTime === recordedStart ? { state: 'alive', reason: 'start_time_equal' } : { state: 'dead', reason: 'pid_reused' };
}

/**
 * Verified liveness of a recorded attempt: the leader (pid + start time), then, when the leader is gone, its process group
 * (`kill(-pgid, 0)`, as the engine's own quiescence does): live members are `unknown`, never `dead` and never `alive`.
 */
export function verifyAttempt(a, info = processInfo, group = (g) => io.groupAlive(g)) {
  if (a.status === 'intent') return { state: 'unknown', reason: 'no_pid_recorded' };
  const v = verify(a.pgid ?? a.pid, a.leader_start ?? null, info);
  if (v.state !== 'dead' || v.reason !== 'no_process' || !a.pgid) return v;
  const g = group(a.pgid);
  return g === true ? { state: 'unknown', reason: 'leader_gone_group_alive' } : g === false ? v : { state: 'unknown', reason: 'group_unknown' };
}

/** When a review result became available: its file's write time, else (no bound file) the run-log interval's end. */
export const resultTime = (d) => (d.marker_exists && Number.isFinite(d.mtime) ? d.mtime : d.ended ? d.ended_ms : null);

/** A parsed lock record as status sees it: held (a live or unprovable holder), free (proven gone) or foreign. */
export function lockState(held, host, info = processInfo) {
  const base = { subject: 'lock', id: held.nonce ?? null, pid: held.pid, method: 'kill0+start_time' };
  if (held.host !== host) return { state: 'foreign', reason: `held by host ${held.host}`, live: { ...base, state: 'unknown', reason: 'foreign_host' } };
  const v = verify(held.pid, held.process_start_time ?? null, info);
  return { state: v.state === 'dead' ? 'free' : 'held', reason: v.reason, live: { ...base, ...v } };
}

/** The run lock as status sees it, lock-free: free, held (a live or unprovable holder), malformed or foreign. */
function lockFacts(ctx, info) {
  const file = io.gitPath(ctx.repoRoot, `ai-skills/ship-ticket/${ctx.ticket}.lock`);
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) { return { state: e.code === 'ENOENT' ? 'free' : 'malformed', reason: e.code, live: null }; }
  let held;
  try { held = JSON.parse(raw); } catch { held = null; }
  if (!held || !Number.isInteger(held.pid) || held.pid <= 0 || typeof held.host !== 'string') return { state: 'malformed', reason: `${file} is unreadable`, live: null };
  return lockState(held, ctx.host ?? hostname(), info);
}

/** The last GATE row per gate kind of this run in the engine log ({ ok, code, candidate_id, at_ms, repeat }). */
function lastGates(file, runId) {
  let text = '';
  try { text = io.readIfExists(file) ?? ''; } catch { /* a damaged sink never fails a derivation */ }
  const out = {};
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.event !== 'GATE' || e.run_id !== runId) continue;
    const p = out[e.gate];
    const repeat = !e.ok && p && !p.ok && p.code === e.code && p.candidate_id === e.candidate_id ? p.repeat + 1 : 1;
    out[e.gate] = { ok: e.ok, code: e.code, candidate_id: e.candidate_id, at_ms: ms(e.timestamp) ?? 0, repeat };
  }
  return out;
}

/**
 * Everything `derive` reads besides the state, plus the C1 lists. `ext` from run-engine.mjs status:
 * { unbound, blockers, redPending, unitReviewsPending, work, budgetStop, ready (readyNodes), candidate }.
 * Reads only: the lock file, attempt envelopes (existence), the engine log and the run log (size-capped).
 */
export async function gather(E, ext) {
  const { S, ctx } = E;
  const info = ctx.processInfo ?? processInfo;
  const now = typeof ctx.now === 'function' ? ms(ctx.now()) ?? Date.now() : Date.now();
  const timeout = clampTimeout(S.config?.timeoutMs ?? 0);
  const liveness = [];
  const attempts = (S.attempts ?? []).filter(a => LIVE.includes(a.status)).map(a => {
    const deadline = (ms(a.started_at) ?? now) + timeout + ATTEMPT_GRACE_MS;
    const v = verifyAttempt(a, info, ctx.groupAlive ?? ((g) => io.groupAlive(g, ctx.platform ?? process.platform)));
    liveness.push({ subject: 'attempt', id: a.attempt_id, pid: a.pgid ?? a.pid ?? null, method: 'kill0+start_time', ...v });
    return { ...a, envelope: Boolean(a.envelope_file && existsSync(a.envelope_file)), deadline: iso(deadline), deadline_ms: deadline, liveness: v };
  });
  const lock = lockFacts(ctx, info);
  if (lock.live) liveness.push(lock.live);
  const { reviewStarts } = await import('./run-log.mjs');
  const log = reviewStarts(ctx.repoRoot, S.ticket, S.run_id);
  const dispatches = log.starts.map(d => {
    const started = ms(d.started_at), ceiling = log.ceilings[d.review_execution]?.[CEILING_OF[d.role]];
    const deadline = started === null ? null : started + (Number.isInteger(ceiling) && ceiling > 0 ? ceiling : DEFAULT_REVIEW_CEILING_MS);
    let mtime = null;
    const marker_exists = Boolean(d.result_path && existsSync(d.result_path));
    if (marker_exists) try { mtime = statSync(d.result_path).mtimeMs; } catch { /* raced away */ }
    const row = { ...d, marker: d.result_path, marker_exists, mtime, ended_ms: ms(d.ended_at), deadline: iso(deadline), deadline_ms: deadline ?? Infinity };
    return { ...row, result_ms: resultTime(row) };
  });
  for (const d of dispatches) if (!d.ended && !d.marker_exists) liveness.push({ subject: 'review', id: d.event_id, pid: null, method: 'claimed', state: 'unknown', reason: 'no_pid_recorded' });
  const f = { now, lock, attempts, dispatches, unbound: ext.unbound, blockers: ext.blockers, redPending: ext.redPending,
    unitReviewsPending: ext.unitReviewsPending ?? [], work: ext.work, budgetStop: ext.budgetStop, candidate: ext.candidate,
    lastGate: lastGates(E.P.log, S.run_id) };
  const unconsumed = [
    ...attempts.filter(a => a.envelope).map(a => ({ kind: 'attempt_envelope', id: a.attempt_id, node: a.node, marker: a.envelope_file, action: 'resume' })),
    ...dispatches.filter(d => d.marker_exists && !consumedBy(S.review_chain ?? [], d, dispatchKind(S, d)))
      .map(d => ({ kind: 'review_result', review_execution: d.review_execution, role: d.role, event_id: d.event_id, marker: d.marker, action: 'gate_review' })),
  ];
  return { f, unconsumed_results: unconsumed, unconsumed_complete: log.complete, liveness };
}

/** FR-3 C1 per-run ready work: ready nodes (fits:false when a resource is held by a LIVE attempt), repairs, RED, unit reviews. */
export function readyWork(S, ext) {
  if (ext.budgetStop) return { ready_work: [], ready_work_capacity: 'budget_stop' };
  const held = (n) => (n.resources ?? []).some(r => S.locks?.[r] !== undefined);
  return { ready_work_capacity: 'open', ready_work: [
    ...ext.ready.map(n => ({ kind: 'node', id: n.id, action: 'drive', fits: !held(n), admission: 'at_dispatch' })),
    ...(S.repairs ?? []).filter(r => r.state === 'pending').map(r => ({ kind: 'repair', id: r.id, action: 'drive', admission: 'at_dispatch' })),
    ...ext.redPending.map(id => ({ kind: 'red', id, action: 'gate_red' })),
    ...(ext.unitReviewsPending ?? []).map(id => ({ kind: 'unit_review', id, action: 'unit_review' })),
  ] };
}
