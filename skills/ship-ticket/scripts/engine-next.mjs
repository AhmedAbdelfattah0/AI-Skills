/**
 * Stage dispositions and the ONE next action of a single-ticket run (P0 slice E2-min). Node built-ins only.
 *
 * `derive(S, facts)` is pure: it reads the engine state and facts gathered from disk (`gather`), and returns
 * one disposition per stage plus exactly one `next_action` { stage, action, reason, owner, disposition, ... }.
 * `run-engine.mjs status` (read-only, lock-free) and `run-engine.mjs next` (under the run lock: it first
 * collects already-finished background work with resume's own reconcile, never dispatching) both print it.
 * It adds no executor and no state machine: every input is an existing record.
 *
 * Stages, in order; the next action is the first stage that is not COMPLETED, and every later stage is
 * BLOCKED `prerequisite_open` (no extra disposition exists for "not reached yet"):
 *   APPROVAL      the approval binding (verifyBinding)                    ENFORCED by every mutating command
 *   ENROLL        enrollment and the build context (admission)            ENFORCED by drive, gate, carrier
 *   BUILD         DAG nodes, their attempts, RED, units                    engine state
 *   REVIEW        the original review (primary + second opinion)          gate review records
 *   REPAIR        the one finding-bound repair                            engine repairs and attempts
 *   CONFIRMATION  the one targeted confirmation                           gate review records
 *   SHIP_READY    engine SHIP_READY of the reviewed candidate              gate ship-ready
 *   PUBLISH       commit, then run-engine.mjs publish (authorize publish)  PUBLISHED records
 *   CI            CI_EVIDENCE of the published head (run-engine.mjs ci) and authorize complete; COMPLETED only when
 *                 authorize complete allows
 *
 * Dispositions: READY (an action can run now), RUNNING (an engine command holds the run lock), WAITING (a
 * dispatched item has no completion marker yet; carries identity, start time, marker path and deadline),
 * BLOCKED, NEEDS_APPROVAL (only a human can continue: the engine never invents approval), COMPLETED,
 * FAILED. The supported path stops only when `stops(next_action)`: NEEDS_APPROVAL, COMPLETED, FAILED, or a BLOCKED the human
 * owns (R0-S C7); an orchestrator- or engine-owned BLOCKED is owed work (advisory: no turn-end hook enforces it).
 *
 * Review dispatches (P0 E7): with config.reviewProvenance 'engine' (the default) they are the engine's own
 * REVIEW_DISPATCHED receipts (engine-review-dispatch.mjs): the latest receipt per role for the candidate under
 * review. None is READY `review_dispatch` (run-engine.mjs review-dispatch --role <r> --candidate <id>), a finished
 * reviewer is READY `review_collect`, a relay that is missing or failed is BLOCKED (`review_relay_unavailable`,
 * `review_dispatch_failed`: owner, never waived), every role collected is READY `gate_review` with the parsed result
 * files. With the approved opt-out 'unbound' they are, as before, DETECTED telemetry: the run-log.mjs review activity
 * rows (`primary_review`, `optional_review`, `review_confirmation`, with `--carrier-result` as the marker), and
 * `next` offers `dispatch_review` / `collect_review`. Either way acceptance stays with `gate review`. Review deadlines come from the REVIEW phase start ceilings (default 20 min);
 * attempt deadlines from config.timeoutMs plus ATTEMPT_GRACE_MS. Nothing kills an overdue item: it is BLOCKED
 * with a recovery action.
 *
 * CI (P0 E6-min) is derived from the latest CI_EVIDENCE of the published head: none is READY `ci_owed`
 * (collect_ci: run-engine.mjs ci), PENDING is WAITING with action collect_ci (poll again after poll_after_ms;
 * PENDING has no deadline), a provider failure is BLOCKED collect_ci, FAIL is FAILED, NO_CHECKS and STALE are
 * BLOCKED for the owner with the evidence's diagnostic. COMPLETED needs authorize complete to allow (ENFORCED
 * there); any other deny is BLOCKED with its code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import * as io from './engine-io.mjs';
import { LIVE } from './engine-quiesce.mjs';
import { clampTimeout, assuranceOf } from './engine-dag.mjs';
import { trustedEvents } from './engine-authority.mjs';
import { REVIEW_ROLE_OF } from './review-intervals.mjs';
import { admission, supersededBy } from './engine-enroll.mjs';
import { confirmationPolicy } from './engine-gates.mjs';
import { reviewFreshness, FRESHNESS_CODES } from './engine-freshness.mjs';
import { latestEvidence } from './engine-ci.mjs';
import { REVIEW_KIND, provenanceMode, sameReviewed, unconsumedFail } from './engine-review-dispatch.mjs';

export const NEXT_SCHEMA = 'ship-ticket-engine-next-v1';
export const DISPOSITIONS = Object.freeze(['READY', 'RUNNING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'COMPLETED', 'FAILED']);
/** The dispositions at which the supported path may stop. BLOCKED stops only when its owner is the human (R0-S C7): see `stops`. */
export const STOP = Object.freeze(['NEEDS_APPROVAL', 'BLOCKED', 'COMPLETED', 'FAILED']);
/**
 * Whether the orchestrator may end its turn on this next_action: NEEDS_APPROVAL, COMPLETED and FAILED always; BLOCKED only when
 * the human owns it. An orchestrator-owned (or engine-owned) BLOCKED action (recover_review, enroll, gate_review after a refusal,
 * gate_ship_ready refused, resolve of an engine judgment, collect_ci after a provider failure) is owed work: act, then ask `next`.
 * ADVISORY: nothing in R0-S enforces this at turn end (no Stop hook); the loop and the skill text follow it.
 */
export const stops = (a) => ['NEEDS_APPROVAL', 'COMPLETED', 'FAILED'].includes(a?.disposition) || (a?.disposition === 'BLOCKED' && a?.owner === 'human');
export const STAGES = Object.freeze(['APPROVAL', 'ENROLL', 'BUILD', 'REVIEW', 'REPAIR', 'CONFIRMATION', 'SHIP_READY', 'PUBLISH', 'CI']);
/** The closed action vocabulary and each action's owner (orchestrator runs it, engine command, or human only). */
export const ACTIONS = Object.freeze({
  reapprove: 'human', new_run: 'human', owner_retry: 'human', recover_attempt: 'human', resolve: 'orchestrator',
  init: 'orchestrator', enroll: 'orchestrator', context: 'orchestrator', gate_red: 'orchestrator', unit_review: 'orchestrator',
  dispatch_review: 'orchestrator', collect_review: 'orchestrator', gate_review: 'orchestrator', recover_review: 'orchestrator',
  review_dispatch: 'orchestrator', review_collect: 'orchestrator',
  gate_ship_ready: 'orchestrator', commit: 'orchestrator', publish: 'orchestrator', none: 'orchestrator',
  drive: 'engine', resume: 'engine', wait: 'engine', collect_ci: 'engine',
});
export const DEFAULT_REVIEW_CEILING_MS = 20 * 60 * 1000;
export const ATTEMPT_GRACE_MS = 60 * 1000;
/** Judgment codes only a human resolves (approval, authority, budget, billing): NEEDS_APPROVAL; every other code is BLOCKED (fail closed). */
export const HUMAN_CODES = Object.freeze(['approval_mismatch', 'dag_mismatch', 'policy_drift', 'config_drift', 'policy_unapproved', 'security_reapproval', 'security_policy_required', 'repair_failed', 'round_limit',
  'budget_stop', 'billing_unverified', 'addendum_required', 'addendum_conflict', 'addendum_outside_contract', 'waiver_unauthorized', 'retry_unauthorized']);
const CEILING_OF = { primary: 'primary_ceiling_ms', second_opinion: 'optional_ceiling_ms', confirmation: 'confirmation_ceiling_ms' };
const RUNNER_STAGE = { repair: 'REPAIR', proof: 'SHIP_READY' };
/** The poll interval `next` suggests while CI is PENDING (a hint: nothing waits on it). */
export const CI_POLL_MS = 30 * 1000;

// ---- results ----------------------------------------------------------------------------------

const res = (disposition, code, action, extra = {}) => ({ disposition, code, action, owner: extra.owner ?? ACTIONS[action], reasons: [], ...extra });
const judged = (list) => {
  const j = list[0], human = HUMAN_CODES.includes(j.code);
  return res(human ? 'NEEDS_APPROVAL' : 'BLOCKED', j.code, j.code === 'repair_failed' ? 'owner_retry' : 'resolve',
    { owner: human ? 'human' : 'orchestrator', reasons: list.map(x => `${x.node ? `${x.node}: ` : ''}${x.reason}`), judgments: list.map(x => ({ code: x.code, ...(x.node ? { node: x.node } : {}) })) });
};
const done = (code = 'completed', extra = {}) => ({ disposition: 'COMPLETED', code, ...extra });

// ---- context derived once per call --------------------------------------------------------------

function context(S, f) {
  const chain = S.review_chain ?? [];
  const O = chain.filter(r => r.kind === 'original').at(-1) ?? null;
  const rx = O?.review_execution ?? null;
  const mine = (k) => (rx ? chain.find(r => r.review_execution === rx && r.kind === k) ?? null : null);
  const last = chain.at(-1);
  const inChain = new Set(chain.map(r => r.review_execution));
  const retry = rx ? trustedEvents(S, 'RETRY').find(e => e.run_id === S.run_id && e.predecessor === rx && typeof e.authorized_by === 'string'
    && e.authorized_by.length > 0 && !inChain.has(e.review_execution)) ?? null : null;
  const stageOfJudgment = (j) => (j.node && S.nodes?.[j.node] ? 'BUILD' : j.node && (S.repairs ?? []).some(r => r.id === j.node) ? 'REPAIR'
    : j.node && S.unit_checks?.[j.node] ? 'BUILD' : null);
  const judgments = { BUILD: [], REPAIR: [], loose: [] };
  for (const j of f.blockers ?? []) judgments[stageOfJudgment(j) ?? 'loose'].push(j);
  const attempts = { BUILD: [], REPAIR: [], SHIP_READY: [] };
  for (const a of f.attempts ?? []) attempts[RUNNER_STAGE[a.kind] ?? 'BUILD'].push(a);
  return { chain, O, rx, original: O, repairRecord: mine('repair'), confirmation: mine('confirmation'), inChain, retry,
    repair: rx ? (S.repairs ?? []).find(r => r.kind === 'review' && r.review_execution === rx) ?? null : null,
    authorizing: last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' ? last : null, judgments, attempts };
}

// ---- rule builders shared by stages ---------------------------------------------------------------

/** The four attempt rules of `stage` (its live engine attempts): running elsewhere, finished but uncollected, overdue, in flight. */
function attemptRules(stage) {
  const first = (x) => x.attempts[stage][0];
  const item = (a, f) => ({ attempt_id: a.attempt_id, kind: a.kind, node: a.node, identity: `${a.provider ?? 'engine'}:${a.model ?? a.kind}`,
    started_at: a.started_at ?? null, marker: a.envelope_file ?? null, deadline: a.deadline ?? null, ...(f.now > (a.deadline_ms ?? Infinity) ? { overdue: true } : {}) });
  const p = stage.toLowerCase();
  return [
    { id: `${p}.attempt.running`, stage, when: (S, f, x) => first(x) && f.lock === 'held'
      && res('RUNNING', 'engine_running', 'wait', { reasons: ['an engine command holds the run lock and owns this attempt'], item: item(first(x), f) }) },
    { id: `${p}.attempt.uncollected`, stage, when: (S, f, x) => { const a = x.attempts[stage].find(y => y.status !== 'unknown' && (y.envelope || y.status === 'intent'));
      return a && res('READY', 'attempt_uncollected', 'resume', { reasons: [`attempt ${a.attempt_id} finished (or never launched) with no engine command to record it`], item: item(a, f) }); } },
    { id: `${p}.attempt.overdue`, stage, when: (S, f, x) => { const a = x.attempts[stage].find(y => !y.envelope && f.now > (y.deadline_ms ?? Infinity));
      return a && res('BLOCKED', 'attempt_overdue', 'recover_attempt', { reasons: [`attempt ${a.attempt_id} has no envelope past ${a.deadline}: confirm process group ${a.pgid ?? a.pid ?? '?'} is gone (stop it if not), then run resume`], item: item(a, f) }); } },
    { id: `${p}.attempt.waiting`, stage, when: (S, f, x) => first(x)
      && res('WAITING', 'attempt_in_flight', 'wait', { reasons: [`attempt ${first(x).attempt_id} has no envelope yet`], item: item(first(x), f) }) },
  ];
}

/** Stage judgments (a node, unit or repair named by an engine judgment). */
const judgmentRule = (stage) => ({ id: `${stage.toLowerCase()}.judgment`, stage, when: (S, f, x) => x.judgments[stage].length > 0 && judged(x.judgments[stage]) });

/**
 * The review rules of REVIEW (kind original) or CONFIRMATION (kind confirmation): the dispatch rows of the
 * candidate under review (`want(x, f)` -> { candidate, rx, roles }), collected, owed, overdue, in flight, gated.
 */
function reviewRules(stage, kind, want) {
  const p = stage.toLowerCase();
  const rows = (S, f, x) => {
    const w = want(S, f, x);
    if (f.reviewMode === 'engine') { // E7: the latest unconsumed receipt per role of this review kind and candidate (abandoned: owed again)
      const mine = w.roles.map(r => (f.receipts ?? []).filter(d => d.kind === kind && !d.consumed && sameReviewed(d, w.candidate, f.candidate?.merge_base ?? null) && d.role === r).at(-1))
        .filter(d => d && d.status !== 'abandoned');
      return { ...w, engine: true, mine };
    }
    const mine = (f.dispatches ?? []).filter(d => d.candidate_id === w.candidate && w.roles.includes(d.role)
      && (w.rx ? d.review_execution === w.rx : !x.inChain.has(d.review_execution)));
    const rx = w.rx ?? mine.at(-1)?.review_execution ?? null;
    return { ...w, rx, mine: mine.filter(d => !rx || d.review_execution === rx) };
  };
  const cli = (role) => (role === 'second_opinion' ? 'second' : role);
  const item = (d) => ({ role: d.role, event_id: d.event_id, review_execution: d.review_execution, candidate_id: d.candidate_id,
    started_at: d.started_at, marker: d.marker, deadline: d.deadline });
  return [
    { id: `${p}.collect`, stage, when: (S, f, x) => { const w = rows(S, f, x), d = w.mine.find(y => !y.ended && y.marker_exists);
      return d && res('READY', 'result_uncollected', w.engine ? 'review_collect' : 'collect_review', { reasons: [w.engine
        ? `${d.role} reviewer ${d.event_id} finished (${d.marker}): run review-collect, no re-dispatch`
        : `${d.role} result ${d.marker} exists: collect it (run-log end --carrier-result), no re-dispatch`], item: item(d) }); } },
    { id: `${p}.relay_blocked`, stage, when: (S, f, x) => { const d = rows(S, f, x).mine.find(y => ['unavailable', 'failed'].includes(y.status));
      return d && res('BLOCKED', d.status === 'unavailable' ? 'review_relay_unavailable' : 'review_dispatch_failed', 'review_dispatch', { owner: 'human', kind,
        roles: [cli(d.role)], candidate_id: d.candidate_id, reasons: [`the ${d.role} reviewer ${d.event_id} ${d.status === 'unavailable' ? 'relay is unavailable' : `failed (${d.detail ?? 'no usable review'})`}: `
          + 'the review stage never proceeds without it (never waived; CodeRabbit never substitutes). Fix the relay or the CLI login, then run review-dispatch again'], item: item(d) }); } },
    // R0-S N2: a FAIL (or failed reviewer) of an earlier candidate binds this review: the owner decides (restore and gate it, or RETRY).
    { id: `${p}.fail_unconsumed`, stage, when: (S, f, x) => { const w = rows(S, f, x); if (!w.engine) return false;
      const d = unconsumedFail(S, kind, w.rx ?? null, w.candidate);
      return d && res('BLOCKED', 'review_fail_unconsumed', 'owner_retry', { owner: 'human', reasons: [`${d.role} ${d.attempt_id} ${d.status === 'failed' ? 'failed' : 'returned FAIL'} for candidate ${d.candidate_id}; the work tree is ${w.candidate}: `
        + `restore that candidate and submit the FAIL to gate review, or the owner appends a RETRY with predecessor ${d.attempt_id} (no review shopping)`] }); } },
    { id: `${p}.owed`, stage, when: (S, f, x) => { const w = rows(S, f, x), missing = w.roles.filter(r => !w.mine.some(d => d.role === r));
      return missing.length > 0 && res('READY', kind === 'original' ? 'review_owed' : 'confirmation_owed', w.engine ? 'review_dispatch' : 'dispatch_review',
        { reasons: [w.engine ? `run review-dispatch --role ${missing.map(cli).join(' and --role ')} --candidate ${w.candidate}` : `dispatch ${missing.join(' and ')} for candidate ${w.candidate}`],
          kind, roles: w.engine ? missing.map(cli) : missing, candidate_id: w.candidate, review_execution: w.rx }); } },
    { id: `${p}.overdue`, stage, when: (S, f, x) => { const d = rows(S, f, x).mine.find(y => !y.ended && f.now > y.deadline_ms);
      return d && res('BLOCKED', 'review_overdue', 'recover_review', { reasons: [`${d.role} (${d.event_id}) has no result past ${d.deadline}: check the carrier, cancel it, and use REVIEW's bounded recovery (review.md)`], item: item(d) }); } },
    { id: `${p}.waiting`, stage, when: (S, f, x) => { const d = rows(S, f, x).mine.find(y => !y.ended);
      return d && res('WAITING', 'review_in_flight', 'wait', { owner: 'orchestrator', reasons: [`${d.role} (${d.event_id}) has no result marker yet`], item: item(d) }); } },
    { id: `${p}.gate_refused`, stage, when: (S, f, x) => { const w = rows(S, f, x), g = f.lastGate?.review;
      return g && !g.ok && g.candidate_id === f.candidate?.id && w.mine.length > 0 && w.mine.every(d => d.ended && d.ended_ms <= g.at_ms)
        && res('BLOCKED', g.code, 'gate_review', { reasons: [`gate review refused (${g.code}) after these results were collected: correct the input or recover, then run gate review`], kind, review_execution: w.rx }); } },
    { id: `${p}.gate`, stage, when: (S, f, x) => { const w = rows(S, f, x);
      return w.mine.length > 0 && w.mine.every(d => d.ended)
        && res('READY', 'results_collected', 'gate_review', { reasons: [`every ${kind} result for ${w.candidate} is collected: reconcile and run gate review`], kind, review_execution: w.rx, candidate_id: w.candidate,
          ...(w.engine ? { results: w.mine.map(d => ({ role: cli(d.role), attempt_id: d.event_id, parsed_file: d.parsed_file })) } : {}) }); } },
  ];
}

// ---- the rule table ---------------------------------------------------------------------------

const BINDING_HUMAN = ['approval_mismatch', 'dag_mismatch', 'policy_drift', 'config_drift', 'policy_unapproved', 'security_reapproval', 'security_policy_required'];
const CONTEXT_CODES = ['context_missing', 'context_stale'];

/** Ordered rules: per stage, the first that matches decides; a stage no rule decides is BLOCKED `underived` (fail closed). */
export const RULES = Object.freeze([
  // APPROVAL
  { id: 'approval.human', stage: 'APPROVAL', when: (S, f) => { const j = (f.unbound ?? []).find(u => BINDING_HUMAN.includes(u.code));
    return j && res('NEEDS_APPROVAL', j.code, 'reapprove', { reasons: f.unbound.map(u => u.reason) }); } },
  { id: 'approval.other', stage: 'APPROVAL', when: (S, f) => (f.unbound ?? []).length > 0
    && res('BLOCKED', f.unbound[0].code, 'resolve', { owner: 'human', reasons: f.unbound.map(u => u.reason) }) },
  { id: 'approval.bound', stage: 'APPROVAL', when: () => done('bound') },
  // ENROLL
  { id: 'enroll.missing', stage: 'ENROLL', when: (S, f) => f.admission?.build?.code === 'not_enrolled'
    && res('BLOCKED', 'not_enrolled', 'enroll', { diagnostic: 'NEEDS_ENROLLMENT', reasons: ['the run is not enrolled: nothing advances until run-engine.mjs enroll, then context --phase build'] }) },
  { id: 'enroll.context', stage: 'ENROLL', when: (S, f) => CONTEXT_CODES.includes(f.admission?.build?.code)
    && res('READY', f.admission.build.code, 'context', { phase: 'build', reasons: f.admission.build.reasons }) },
  { id: 'enroll.drift', stage: 'ENROLL', when: (S, f) => f.admission?.build && !f.admission.build.ok
    && res('NEEDS_APPROVAL', f.admission.build.code, 'new_run', { reasons: f.admission.build.reasons }) },
  { id: 'enroll.admitted', stage: 'ENROLL', when: (S, f) => f.admission?.build?.ok && done('admitted') },
  // BUILD
  ...attemptRules('BUILD'),
  judgmentRule('BUILD'),
  { id: 'build.red', stage: 'BUILD', when: (S, f) => (f.redPending ?? []).length > 0
    && res('READY', 'red_pending', 'gate_red', { node: f.redPending[0], reasons: [`node ${f.redPending[0]} is done and its RED is not accepted`] }) },
  { id: 'build.unit_review', stage: 'BUILD', when: (S, f) => (f.unitReviewsPending ?? []).length > 0 && !f.work
    && res('READY', 'unit_review_owed', 'unit_review', { units: [...f.unitReviewsPending], reasons: [`unit review owed: ${f.unitReviewsPending.join(', ')}`] }) },
  { id: 'build.work', stage: 'BUILD', when: (S, f) => f.work === true && res('READY', 'build_pending', 'drive', { reasons: ['pending or stale nodes, or unit checks, are ready'] }) },
  { id: 'build.done', stage: 'BUILD', when: (S) => Object.values(S.nodes ?? {}).every(n => ['done', 'cancelled'].includes(n.state)) && done('built') },
  // REVIEW
  { id: 'review.retry', stage: 'REVIEW', when: (S, f, x) => x.retry && x.authorizing?.review_execution !== x.retry.review_execution
    && reviewOf(S, f, x, x.retry.review_execution) },
  { id: 'review.stale', stage: 'REVIEW', when: (S, f, x) => x.authorizing && x.authorizing === x.O && f.freshness?.fresh === false && staleResult(f) },
  { id: 'review.terminal', stage: 'REVIEW', when: (S, f, x) => x.O && x.O.outcome === 'FAIL' && !x.repair
    && res('NEEDS_APPROVAL', 'review_terminal', 'owner_retry', { reasons: [`review ${x.rx} FAILED with no repair (overflow or nothing to fix): only an owner RETRY linked to it continues`] }) },
  { id: 'review.recorded', stage: 'REVIEW', when: (S, f, x) => x.O && done(x.O.outcome === 'PASS' ? 'review_passed' : 'review_failed_repair_owed', { review_execution: x.rx, candidate_id: x.O.candidate_id }) },
  { id: 'review.context', stage: 'REVIEW', when: (S, f) => f.admission?.review && !f.admission.review.ok
    && (CONTEXT_CODES.includes(f.admission.review.code) ? res('READY', f.admission.review.code, 'context', { phase: 'review', reasons: f.admission.review.reasons })
      : res('BLOCKED', f.admission.review.code, 'resolve', { owner: 'human', reasons: f.admission.review.reasons })) },
  { id: 'review.candidate', stage: 'REVIEW', when: (S, f) => !f.candidate?.id && res('BLOCKED', 'candidate_unavailable', 'resolve', { owner: 'human', reasons: [f.candidate?.reason ?? 'candidate not computable'] }) },
  ...reviewRules('REVIEW', 'original', (S, f) => ({ candidate: f.candidate?.id, rx: null, roles: ['primary', 'second_opinion'] })),
  // REPAIR
  { id: 'repair.not_needed', stage: 'REPAIR', when: (S, f, x) => (!x.O || x.O.outcome === 'PASS' || !x.repair) && done('not_needed') },
  ...attemptRules('REPAIR'),
  judgmentRule('REPAIR'),
  { id: 'repair.failed', stage: 'REPAIR', when: (S, f, x) => x.repair?.state === 'failed'
    && res('NEEDS_APPROVAL', 'repair_failed', 'owner_retry', { reasons: [`${x.repair.id} failed (${x.repair.reason ?? 'terminal'}): only an owner RETRY of ${x.rx} continues`] }) },
  { id: 'repair.pending', stage: 'REPAIR', when: (S, f, x) => ['pending', 'running'].includes(x.repair?.state)
    && res('READY', 'repair_owed', 'drive', { reasons: [`${x.repair.id} is authorized: drive dispatches it`] }) },
  { id: 'repair.done', stage: 'REPAIR', when: (S, f, x) => ['done', 'cancelled'].includes(x.repair?.state) && done(x.repair.state === 'done' ? 'repaired' : 'superseded') },
  // CONFIRMATION
  { id: 'confirmation.not_needed', stage: 'CONFIRMATION', when: (S, f, x) => !x.repairRecord && done('not_needed') },
  { id: 'confirmation.failed', stage: 'CONFIRMATION', when: (S, f, x) => x.confirmation?.outcome === 'FAIL'
    && res('FAILED', 'confirmation_failed', 'none', { owner: 'human', reasons: [`the targeted confirmation of ${x.rx} FAILED: that is the result (never a new review cycle); only an owner RETRY continues`] }) },
  { id: 'confirmation.stale', stage: 'CONFIRMATION', when: (S, f, x) => x.authorizing && x.authorizing === x.confirmation && f.freshness?.fresh === false && staleResult(f) },
  { id: 'confirmation.recorded', stage: 'CONFIRMATION', when: (S, f, x) => x.confirmation && done('confirmed', { review_execution: x.rx, candidate_id: x.confirmation.candidate_id }) },
  { id: 'confirmation.context', stage: 'CONFIRMATION', when: (S, f) => f.admission?.review && !f.admission.review.ok
    && res(CONTEXT_CODES.includes(f.admission.review.code) ? 'READY' : 'BLOCKED', f.admission.review.code, CONTEXT_CODES.includes(f.admission.review.code) ? 'context' : 'resolve',
      { phase: 'review', reasons: f.admission.review.reasons, ...(CONTEXT_CODES.includes(f.admission.review.code) ? {} : { owner: 'human' }) }) },
  { id: 'confirmation.drift', stage: 'CONFIRMATION', when: (S, f, x) => x.repairRecord && f.candidate?.id !== x.repairRecord.new_candidate
    && res('BLOCKED', 'post_freeze_drift', 'resolve', { owner: 'human', reasons: [`the work tree is ${f.candidate?.id ?? f.candidate?.reason}, the repaired candidate is ${x.repairRecord.new_candidate}: revert the drift, or the owner appends a RETRY`] }) },
  ...reviewRules('CONFIRMATION', 'confirmation', (S, f, x) => ({ candidate: x.repairRecord?.new_candidate, rx: x.rx,
    roles: ['confirmation', ...(f.confirmationPolicy === 'required' ? ['second_opinion'] : [])] })),
  // SHIP_READY
  { id: 'ship_ready.unreviewed', stage: 'SHIP_READY', when: (S, f, x) => !x.authorizing
    && res('BLOCKED', 'review_not_accepted', 'resolve', { owner: 'human', reasons: ['the last review record is not an accepted PASS'] }) },
  ...attemptRules('SHIP_READY'),
  { id: 'ship_ready.recorded', stage: 'SHIP_READY', when: (S, f, x) => x.authorizing && S.ship_ready?.candidate_id === x.authorizing.candidate_id && supersededBy(S).length === 0
    && done('ship_ready', { candidate_id: S.ship_ready.candidate_id }) },
  { id: 'ship_ready.context', stage: 'SHIP_READY', when: (S, f) => f.admission?.ship && !f.admission.ship.ok
    && res(CONTEXT_CODES.includes(f.admission.ship.code) ? 'READY' : 'BLOCKED', f.admission.ship.code, CONTEXT_CODES.includes(f.admission.ship.code) ? 'context' : 'resolve',
      { phase: 'ship', reasons: f.admission.ship.reasons, ...(CONTEXT_CODES.includes(f.admission.ship.code) ? {} : { owner: 'human' }) }) },
  { id: 'ship_ready.refused', stage: 'SHIP_READY', when: (S, f) => { const g = f.lastGate?.['ship-ready'], r = f.lastGate?.review;
    return g && !g.ok && g.candidate_id === f.candidate?.id && (!r || g.at_ms >= r.at_ms)
      && res('BLOCKED', g.code, 'gate_ship_ready', { reasons: [`gate ship-ready refused (${g.code}) for this candidate: resolve it, then run gate ship-ready`] }); } },
  { id: 'ship_ready.owed', stage: 'SHIP_READY', when: (S, f, x) => x.authorizing && res('READY', 'ship_ready_owed', 'gate_ship_ready', { candidate_id: x.authorizing.candidate_id,
    reasons: [`the accepted review of ${x.authorizing.candidate_id} has no current SHIP_READY`] }) },
  // PUBLISH
  { id: 'publish.recorded', stage: 'PUBLISH', when: (S, f) => f.head && (S.published ?? []).some(p => p.head === f.head) && done('published', { head: f.head }) },
  { id: 'publish.commit', stage: 'PUBLISH', when: (S, f) => f.tree?.dirty === true
    && res('READY', 'commit_owed', 'commit', { paths: f.tree.paths, reasons: ['commit the reviewed candidate (exactly these paths) before publish'] }) },
  { id: 'publish.unfinished', stage: 'PUBLISH', when: (S, f) => S.publish_intent?.head === f.head
    && res('BLOCKED', 'publish_unfinished', 'publish', { reasons: [`publish of ${f.head} started (PUBLISH_INTENT) but recorded no PUBLISHED: check the remote branch and the PR, then run publish again`] }) },
  { id: 'publish.denied', stage: 'PUBLISH', when: (S, f) => f.publishAuth && !f.publishAuth.allow
    && res('BLOCKED', f.publishAuth.code, 'resolve', { owner: 'human', reasons: f.publishAuth.reasons ?? [] }) },
  { id: 'publish.owed', stage: 'PUBLISH', when: (S, f) => f.publishAuth?.allow && res('READY', 'publish_owed', 'publish', { binding: f.publishAuth.binding,
    reasons: ['authorize publish allows: run run-engine.mjs publish (the only supported push and PR path)'] }) },
  // CI (P0 E6-min): from the CI_EVIDENCE of the published head; COMPLETED only when authorize complete allows.
  { id: 'ci.passed', stage: 'CI', when: (S, f) => f.completeAuth?.allow === true && done('ci_passed', { head: f.head }) },
  { id: 'ci.owed', stage: 'CI', when: (S, f) => !f.ci && res('READY', 'ci_owed', 'collect_ci',
    { head: f.head, reasons: [`no CI evidence for the published head ${f.head}: run run-engine.mjs ci`] }) },
  { id: 'ci.pending', stage: 'CI', when: (S, f) => f.ci?.state === 'PENDING' && res('WAITING', f.ci.code, 'collect_ci',
    { head: f.head, poll_after_ms: CI_POLL_MS, timing: f.ci.timing, reasons: f.ci.reasons }) },
  { id: 'ci.unavailable', stage: 'CI', when: (S, f) => f.ci?.state === 'UNAVAILABLE' && res('BLOCKED', f.ci.code, 'collect_ci',
    { head: f.head, reasons: [...f.ci.reasons, 'the provider failed (never zero checks): fix gh access, then run run-engine.mjs ci again'] }) },
  { id: 'ci.failed', stage: 'CI', when: (S, f) => f.ci?.state === 'FAIL' && res('FAILED', f.ci.code, 'none',
    { owner: 'human', head: f.head, reasons: f.ci.reasons }) },
  { id: 'ci.blocked', stage: 'CI', when: (S, f) => ['NO_CHECKS', 'STALE'].includes(f.ci?.state) && res('BLOCKED', f.ci.code, 'resolve',
    { owner: 'human', head: f.head, reasons: f.ci.reasons, ...(f.ci.diagnostic ? { diagnostic: f.ci.diagnostic } : {}) }) },
  { id: 'ci.denied', stage: 'CI', when: (S, f) => res('BLOCKED', f.completeAuth?.code ?? 'underived', 'resolve',
    { owner: 'human', head: f.head, reasons: f.completeAuth?.reasons ?? [] }) },
]);

/**
 * E3: the authorizing review no longer covers the candidate bytes. Under the gate's rules a new original needs a trusted
 * owner RETRY (a confirmation exists only for a repair), so this is the owner's stop; a RETRY makes review.retry READY.
 */
const staleResult = (f) => res(FRESHNESS_CODES.includes(f.freshness.code) ? 'NEEDS_APPROVAL' : 'BLOCKED', f.freshness.code,
  FRESHNESS_CODES.includes(f.freshness.code) ? 'owner_retry' : 'resolve', { owner: 'human', reasons: f.freshness.reasons });

/** A trusted, unconsumed owner RETRY of the last review: the new original review of the current candidate is owed. */
function reviewOf(S, f, x, rx) {
  const rules = reviewRules('REVIEW', 'original', () => ({ candidate: f.candidate?.id, rx, roles: ['primary', 'second_opinion'] }));
  for (const r of rules) { const out = r.when(S, f, x); if (out) return { ...out, retry: { review_execution: rx, predecessor: x.rx } }; }
  return null;
}

/** Applied to a stage's READY/WAITING result: an engine judgment no stage owns stops it. */
export const LOOSE_JUDGMENT_RULE = 'judgment.loose';
/** Applied to a stage's READY result while another engine command holds the run lock: RUNNING, wait (never a second command). */
export const LOCK_HELD_RULE = 'lock.held';

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
    r ??= { rule: `${st.toLowerCase()}.underived`, ...res('BLOCKED', 'underived', 'resolve', { owner: 'human', reasons: [`no derivation rule decided ${st} (fail closed)`] }) };
    if (!omit.includes(LOOSE_JUDGMENT_RULE) && ['READY', 'WAITING'].includes(r.disposition) && x.judgments.loose.length) r = { rule: LOOSE_JUDGMENT_RULE, ...judged(x.judgments.loose) };
    if (!omit.includes(LOCK_HELD_RULE) && r.disposition === 'READY' && f.lock === 'held')
      r = { rule: LOCK_HELD_RULE, ...res('RUNNING', 'engine_running', 'wait', { reasons: [`an engine command holds the run lock; ${r.action} follows once it returns`], then: r.action }) };
    stages[st] = r;
    if (r.disposition !== 'COMPLETED') current = st;
  }
  const s = current ? stages[current] : null;
  const { rule: _r, disposition, code, action, owner, reasons, ...details } = s ?? {};
  // R0-S A4: a relaxed run (an approved opt-out, or a native receipt-less review) is labelled on every answer, never silent.
  const assurance = assuranceOf(S);
  const label = assurance.level === 'RELAXED' ? { assurance: 'RELAXED' } : {};
  const next_action = current ? { stage: current, action, reason: code, owner, disposition, reasons, ...details, ...label }
    : { stage: null, action: 'none', reason: 'completed', owner: 'orchestrator', disposition: 'COMPLETED', reasons: [], ...label };
  return { disposition: next_action.disposition, next_action, stop: stops(next_action), stages, review_freshness: f.freshness ?? null, assurance };
}

// ---- facts from disk ---------------------------------------------------------------------------

const gitOut = (repo, args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000 }); return r.status === 0 ? r.stdout.trim() : null; };
const ms = (t) => { const v = Date.parse(t ?? ''); return Number.isFinite(v) ? v : null; };
const iso = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : null);

/** Whether another live process holds the run lock (lock-free read): 'held' | 'free'. */
export function lockState(repoRoot, ticket) {
  const held = io.readJson(io.gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.lock`));
  if (!held || typeof held.pid !== 'number') return 'free';
  if (held.host !== hostname()) return 'held';
  try { process.kill(held.pid, 0); return 'held'; } catch (e) { return e.code === 'EPERM' ? 'held' : 'free'; }
}

/** A telemetry file's text, or '' when it is missing or unreadable (a damaged sink never fails a derivation). */
const readSink = (file) => { try { return io.readIfExists(file) ?? ''; } catch { return ''; } };

/** Review dispatches of run `runId` in the run-log (DETECTED telemetry): one per started review activity. */
export function reviewDispatches(repoRoot, ticket, runId, now) {
  const text = readSink(io.gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.jsonl`));
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r?.schema === 'ship-ticket-run-log-v1' && r.run_id === runId) rows.push(r); } catch { /* damaged line: telemetry only */ }
  }
  const ceilings = {};
  for (const r of rows) if (r.event === 'start' && r.kind === 'phase' && r.name === 'REVIEW' && typeof r.metrics?.review_execution === 'string') ceilings[r.metrics.review_execution] = r.metrics;
  const out = [];
  for (const r of rows) {
    const role = r.kind === 'activity' && r.event === 'start' ? REVIEW_ROLE_OF[r.name] : null;
    if (!['primary', 'second_opinion', 'confirmation'].includes(role) || typeof r.metrics?.review_execution !== 'string') continue;
    const end = rows.find(e => e.event === 'end' && e.event_id === r.event_id);
    const marker = r.carrier_binding?.result_path ?? null;
    const started = ms(r.timestamp), ceiling = ceilings[r.metrics.review_execution]?.[CEILING_OF[role]];
    const deadline = started === null ? null : started + (Number.isInteger(ceiling) && ceiling > 0 ? ceiling : DEFAULT_REVIEW_CEILING_MS);
    out.push({ role, name: r.name, event_id: r.event_id, review_execution: r.metrics.review_execution, candidate_id: r.metrics.candidate_id ?? null,
      started_at: r.timestamp, ended: Boolean(end), ended_ms: end ? ms(end.timestamp) : null, marker, marker_exists: Boolean(marker && existsSync(marker)),
      deadline: iso(deadline), deadline_ms: deadline ?? Infinity, overdue: deadline !== null && now > deadline });
  }
  return out;
}

/**
 * The engine's review receipts as dispatch rows (P0 E7): one per REVIEW_DISPATCHED / REVIEW_UNAVAILABLE record, with
 * its attempt's envelope as the marker (a finished reviewer that is not collected yet).
 */
export function reviewReceipts(S, now) {
  return (S.review_dispatches ?? []).map(d => {
    const a = (S.attempts ?? []).find(x => x.attempt_id === d.attempt_id);
    const deadline = ms(d.deadline);
    return { role: d.role === 'second' ? 'second_opinion' : d.role, kind: d.kind, event_id: d.attempt_id, review_execution: null, candidate_id: d.candidate_id, merge_base: d.merge_base ?? null,
      started_at: d.started_at, status: d.status, consumed: Boolean(d.consumed_by), ended: d.status === 'collected', ended_ms: ms(d.collected?.collected_at),
      marker: a?.envelope_file ?? null, marker_exists: d.status === 'dispatched' && Boolean(a?.envelope_file && existsSync(a.envelope_file)),
      deadline: d.deadline ?? null, deadline_ms: deadline ?? Infinity, overdue: deadline !== null && now > deadline, parsed_file: d.collected?.parsed_file ?? null,
      detail: d.collected?.parse_error ?? d.code ?? null };
  });
}

/** The last GATE line per gate kind of this run in the engine log ({ ok, code, candidate_id, at_ms }). */
function lastGates(repoRoot, ticket, runId) {
  const text = readSink(io.gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.engine.jsonl`));
  const out = {};
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (e?.event === 'GATE' && e.run_id === runId) out[e.gate] = { ok: e.ok, code: e.code, candidate_id: e.candidate_id, at_ms: ms(e.timestamp) ?? 0 }; } catch { /* skip */ }
  }
  return out;
}

/**
 * Everything `derive` reads besides the state. `ext` from run-engine.mjs: { unbound, blockers, lock,
 * redPending, work, unitReviewsPending, authorize(stage) }.
 */
export async function gather(E, ext) {
  const { S, ctx } = E;
  const now = typeof ctx.now === 'function' ? ms(ctx.now()) ?? Date.now() : Date.now();
  const timeout = clampTimeout(S.config?.timeoutMs ?? 0);
  const attempts = (S.attempts ?? []).filter(a => LIVE.includes(a.status) && a.kind !== REVIEW_KIND).map(a => {
    const deadline = (ms(a.started_at) ?? now) + timeout + ATTEMPT_GRACE_MS;
    return { ...a, envelope: Boolean(a.envelope_file && existsSync(a.envelope_file)), deadline: iso(deadline), deadline_ms: deadline };
  });
  const candidate = io.candidateId(ctx.repoRoot, io.candidateBase(S), S.pinned_exclusions ?? []);
  const dirty = io.snapshot(ctx.repoRoot, S.pinned_exclusions ?? []);
  const head = gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const rx = (S.review_chain ?? []).filter(r => r.kind === 'original').at(-1)?.review_execution;
  const f = { now, lock: ext.lock, unbound: ext.unbound, blockers: ext.blockers, attempts, redPending: ext.redPending, work: ext.work,
    unitReviewsPending: ext.unitReviewsPending ?? [],
    admission: { build: admission(S, 'build'), review: admission(S, 'review'), ship: admission(S, 'ship-ready') },
    candidate: { id: candidate.candidate_id ?? null, reason: candidate.reason ?? null, merge_base: candidate.merge_base ?? null },
    tree: dirty === null ? { dirty: null, paths: [] } : { dirty: Object.keys(dirty).length > 0, paths: Object.keys(dirty).sort() },
    head, dispatches: reviewDispatches(ctx.repoRoot, S.ticket, S.run_id, now), lastGate: lastGates(ctx.repoRoot, S.ticket, S.run_id),
    reviewMode: provenanceMode(S), receipts: reviewReceipts(S, now),
    freshness: reviewFreshness(S, ctx.repoRoot),
    confirmationPolicy: rx && (S.review_chain ?? []).some(r => r.review_execution === rx && r.kind === 'repair') ? confirmationPolicy(S, rx) : null };
  if (S.ship_ready?.candidate_id && f.tree.dirty === false && !(S.published ?? []).some(p => p.head === head)) f.publishAuth = await ext.authorize('publish');
  if ((S.published ?? []).some(p => p.head === head)) {
    f.completeAuth = await ext.authorize('complete');
    const ev = latestEvidence(S, head);
    f.ci = ev && { state: ev.state, code: ev.code, reasons: ev.reasons ?? [], timing: ev.timing ?? null, ...(ev.diagnostic ? { diagnostic: ev.diagnostic } : {}) };
  }
  return f;
}
