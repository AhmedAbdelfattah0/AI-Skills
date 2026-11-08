/**
 * Per-unit independent review of the durable run engine (AIS-HARNESS-3 Wave 2b-ii), opt-in through
 * the bound DAG's `config.unitReview: true` (it needs units). Without it `S.unit_reviews` never
 * exists and nothing here runs. The engine never dispatches a reviewer: the orchestrator relays the
 * unit review (Opus primary, plus the opposite-model second opinion when the unit is risky) and
 * `run-engine.mjs gate unit-review` validates and records it under the engine lock.
 *
 * A unit review artifact is gate.mjs's review contract with `candidate_id` = the unit's evidence id
 * (`status.units.<u>.evidence.id`), so it binds the exact checked unit. The record also binds the
 * approved plan and DAG digests, the unit id, the evidence's base commit and whole-tree candidate
 * digest, the reviewer identities, findings and outcome. Its validity is recomputed from the work
 * tree at every read (unitStates): any invalidation of the unit's evidence (inputs, contract,
 * dependency, base) makes it `stale`. An accepted FAIL opens one finding-bound repair (kind
 * 'unit-review', through engine-attempts.mjs's review-repair authorization) limited to the unit's
 * declared writes; then one targeted confirmation. Every re-review, repair and confirmation spends
 * the run-wide unit ceiling (engine-units.mjs spendCeiling). `E` is run-engine.mjs's command context.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { gateReview } from './gate.mjs';
import * as io from './engine-io.mjs';
import { LIVE } from './engine-quiesce.mjs';
import { note, judgment, normDigest, under } from './engine-dag.mjs';
import { retryEvent } from './engine-authority.mjs';
import { unitStates, spendCeiling, ceiling, dict } from './engine-units.mjs';

const no = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: false, reasons, ...extra });
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
/** Repair, its post-repair re-check and its confirmation: what opening a unit repair reserves. */
const REPAIR_RESERVE = 3;

/** Whether the run records unit reviews (the bound DAG set config.unitReview: true). */
export const unitReviewOn = (S) => S.unit_reviews !== undefined;

const members = (S, u) => Object.values(S.nodes).filter(n => n.unit === u);
/** The union of the declared writes of unit `u`'s nodes (a unit repair may write nothing else). */
const unitWrites = (S, u) => [...new Set(members(S, u).flatMap(n => n.writes))].sort();

/**
 * A unit is risky (its review and its confirmation need the second opinion) when any of its nodes
 * carries a risk label (every node label is a high-risk routing label: harness.mjs routeModel) or
 * the ticket carries any `config.riskLabels` (ticket-level labels apply to every unit).
 */
export function riskOf(S, u) {
  const labels = [...new Set([...members(S, u).flatMap(n => n.risk ?? []), ...(S.config.riskLabels ?? [])])].sort();
  return { risky: labels.length > 0, labels };
}

/** Unit check states from the last stored state (eval without a work tree). */
const storedStates = (S) => dict(Object.entries(S.unit_checks ?? {}).map(([u, r]) => [u,
  { state: !r.evidence ? 'pending' : r.stale ? 'stale' : r.evidence.state }]));

/**
 * Review state of every unit, computed (never stored): `unreviewed`; `pass` (the latest accepted
 * PASS binds the unit's current verified evidence); `stale` (it, or an open FAIL cycle, binds
 * evidence that no longer holds: a fresh original review is due); `fail` with `awaiting`
 * repair|recheck|confirmation, or `terminal` (overflow, nothing to repair, a failed repair, a failed
 * confirmation, a FAIL after the freeze or after the unit's repair): only an owner RETRY continues.
 */
export function reviewStates(S, states) {
  const out = dict();
  for (const u of Object.keys(S.unit_reviews ?? {})) {
    const chain = S.unit_reviews[u].chain;
    const now = states[u]?.state === 'verified' ? S.unit_checks[u].evidence.id : null;
    const last = chain.findLast(r => r.kind === 'original' || r.kind === 'confirmation');
    if (!last) { out[u] = { state: 'unreviewed', evidence_id: now }; continue; }
    const base = { review_execution: last.review_execution, kind: last.kind, outcome: last.outcome, reviewed_evidence: last.candidate_id, evidence_id: now };
    const stale = { ...base, state: 'stale' };
    if (last.outcome === 'PASS') { out[u] = last.candidate_id === now ? { ...base, state: 'pass' } : stale; continue; }
    const terminal = { ...base, state: 'fail', terminal: true };
    if (last.kind === 'confirmation' || !last.repair_opened) { out[u] = terminal; continue; }
    const rec = chain.find(r => r.kind === 'repair' && r.review_execution === last.review_execution);
    const queued = S.repairs.find(r => r.id === `repair-${last.review_execution}`);
    if (!rec) {
      if (queued?.state === 'cancelled') out[u] = stale;
      else if (queued?.state === 'failed' || queued?.state === 'done') out[u] = terminal; // done without a record: no repaired candidate
      else out[u] = last.candidate_id === now ? { ...base, state: 'fail', awaiting: 'repair' } : stale;
    } else if (rec.new_candidate === null) out[u] = { ...base, state: 'fail', awaiting: 'recheck' };
    else out[u] = rec.new_candidate === now ? { ...base, state: 'fail', awaiting: 'confirmation', repaired_evidence: rec.new_candidate } : stale;
  }
  return out;
}

/** Computed `unit_review_terminal` judgments (they stand until an owner RETRY records a new original). */
export const unitReviewJudgments = (S, states) => Object.entries(reviewStates(S, states)).filter(([, r]) => r.terminal)
  .map(([u, r]) => judgment('unit_review_terminal', u, `unit ${u} review ${r.review_execution} ended ${r.kind === 'confirmation' ? 'with a failed confirmation' : 'FAIL with no repair to run'}; `
    + `a new unit review needs a RUN-STATE RETRY { review_execution: <new id>, predecessor: ${r.review_execution}, authorized_by } (never automatic)`));

/** Units without a current PASS review: `gate review` and `gate ship-ready` refuse `unit_reviews_missing` while any exist. */
export function reviewsMissing(S, root) {
  if (!unitReviewOn(S)) return [];
  return Object.entries(reviewStates(S, unitStates(S, root, {}))).filter(([, r]) => r.state !== 'pass')
    .map(([u, r]) => `${u}: ${r.state}${r.awaiting ? ` (awaiting ${r.awaiting})` : ''}${r.terminal ? ' (terminal)' : ''}`);
}

/** The unit projection with each unit's `review` (only when unit reviews are on). `states` from unitStates, or null for stored. */
export function withReviews(S, projection, states) {
  if (!unitReviewOn(S)) return projection;
  const rs = reviewStates(S, states ?? storedStates(S));
  for (const [u, p] of Object.entries(projection)) {
    const { risky, labels } = riskOf(S, u);
    p.review = { ...rs[u], risky, ...(labels.length ? { risk_labels: labels } : {}), records: S.unit_reviews[u].chain.length };
  }
  return projection;
}

/** Units whose review is not a current PASS, for `status.unit_reviews_pending` (the orchestrator's next relays). */
export const pendingReviews = (S, states) => Object.entries(reviewStates(S, states)).filter(([, r]) => r.state !== 'pass').map(([u]) => u);

/** Whether review execution `rx` is already used by the final chain or another unit's chain. */
const usedElsewhere = (S, rx, u) => (S.review_chain ?? []).some(r => r.review_execution === rx)
  || Object.entries(S.unit_reviews).some(([v, R]) => v !== u && R.chain.some(r => r.review_execution === rx));

/** Whether review execution `rx` names a unit review (a final review may not reuse it). */
export const unitExecution = (S, rx) => unitReviewOn(S) && Object.values(S.unit_reviews).some(R => R.chain.some(r => r.review_execution === rx));

/**
 * `gate unit-review`: validate and record one unit review step (an original review or the targeted
 * confirmation of its repair). Refusals record nothing (a spent ceiling records its judgment).
 */
export function unitReviewGate(E, input, candidate) {
  const { S } = E;
  if (!unitReviewOn(S)) return no('unit_review_disabled', ['the bound DAG does not set config.unitReview: true']);
  const u = input.unit;
  if (!Object.hasOwn(S.unit_reviews, u)) return no('unknown_unit', [`no unit ${u} in the bound DAG`]);
  if (normDigest(input.approved_plan_digest) !== S.plan_digest || normDigest(input.dag_digest) !== S.dag_digest) {
    return no('binding_mismatch', [`the review names plan ${input.approved_plan_digest} and DAG ${input.dag_digest}; bound are ${S.plan_digest} and ${S.dag_digest}`]);
  }
  const live = S.attempts.filter(a => LIVE.includes(a.status)).map(a => a.attempt_id);
  if (live.length) return no('attempts_live', [`a unit review is recorded only at a quiescent point; live: ${live.join(', ')}`]);
  const states = unitStates(S, E.ctx.repoRoot, {});
  if (states[u].state !== 'verified') return no('unit_unverified', [`unit ${u} is ${states[u].state}: its checks must pass on the current binding first (drive runs them)`]);
  const ev = S.unit_checks[u].evidence;
  if (input.base_commit !== ev.binding.base_commit) return no('stale_base', [`the review names base ${input.base_commit}; the unit evidence binds ${ev.binding.base_commit}`]);
  const named = [input.primary?.candidate_id, input.second_opinion?.candidate_id].filter(c => c !== undefined && c !== ev.id);
  if (named.length) return no('stale_evidence', [`the review names evidence ${named.join(', ')}; the unit's current evidence is ${ev.id} (status.units.${u}.evidence.id)`]);
  const rx = input.review_execution;
  if (nonEmpty(rx) && usedElsewhere(S, rx, u)) return no('chain_broken', [`review_execution ${rx} already belongs to another review chain`]);
  const risk = riskOf(S, u);
  const policy = risk.risky ? { secondOpinion: 'required', confirmationSecondOpinion: 'required' } : { secondOpinion: 'optional', confirmationSecondOpinion: 'optional' };
  const R = S.unit_reviews[u], rv = reviewStates(S, states)[u];
  const { approved_plan_digest: _a, dag_digest: _d, base_commit: _b, unit: _u, ...review } = input;
  const v = gateReview({ ...review, state: { builders: S.builders, frozen_candidate: ev.id, review_chain: R.chain } }, policy);
  const bind = { unit: u, evidence_id: ev.id, tree_candidate: ev.candidate_id, base_commit: ev.binding.base_commit,
    approved_plan_digest: S.plan_digest, dag_digest: S.dag_digest, risky: risk.risky, risk_labels: risk.labels };
  return input.kind === 'confirmation' ? confirmation(E, input, u, rv, v, bind) : original(E, input, u, rv, v, bind, candidate);
}

function original(E, input, u, rv, v, bind, candidate) {
  const { S } = E, R = S.unit_reviews[u], rx = input.review_execution;
  if (rv.state === 'pass') return no('unit_review_current', [`unit ${u} already has a current PASS (${rv.review_execution}) on evidence ${rv.evidence_id}`]);
  if (rv.state === 'fail' && !rv.terminal) return no('unit_review_open', [`unit ${u} review ${rv.review_execution} is awaiting its ${rv.awaiting}`
    + (rv.awaiting === 'confirmation' ? ': record its targeted confirmation (kind confirmation)' : ': drive runs it')]);
  let retry = null;
  if (rv.terminal) {
    const found = retryEvent(S, rx, rv.review_execution);
    retry = found.retry;
    if (!retry && found.forged) return no('retry_unauthorized', [`a RETRY for ${rx} appeared while dispatched work could run, so it is not owner authority; `
      + 'once status shows nothing live, the owner re-appends a distinct RETRY (e.g. with a timestamp)'], { judgment_point: true });
    if (!retry) return no('retry_unauthorized', [`unit ${u} review ${rv.review_execution} is terminal; a new unit review needs a RUN-STATE RETRY `
      + `{ review_execution: ${rx}, predecessor: ${rv.review_execution}, authorized_by }`]);
  }
  if (!v.ok) return { judgment_point: false, ...v };
  const write_set = v.record.write_set;
  const writes = unitWrites(S, u), outside = write_set.filter(p => !under(p, writes));
  if (outside.length) return no('repair_outside_unit', [`the repair write set leaves unit ${u}'s declared writes (${writes.join(', ')}): ${outside.join(', ')}`]);
  // One repair per unit review execution; after the REVIEW freeze only the final review's repair may change the candidate.
  const opens = Boolean(v.repair) && !S.freeze;
  const brief = input.repair_prompt_file;
  if (opens && !(nonEmpty(brief) && isAbsolute(brief) && existsSync(brief) && statSync(brief).isFile())) return no('repair_prompt_missing', ['an accepted unit FAIL opens a repair: repair_prompt_file must be the absolute path of its brief']);
  const rereview = R.chain.some(r => r.kind === 'original');
  const { limit, used } = ceiling(S), need = (rereview ? 1 : 0) + (opens ? REPAIR_RESERVE : 0);
  if (need && used + need > limit) {
    spendCeiling(S, u, opens ? 'unit_repair' : 'unit_rereview', null, need); // raises parent_ceiling, spends nothing
    return no('parent_ceiling', [`unit ${u} needs ${need} of the run's unit allowance (${opens ? 'a repair reserves its re-check and confirmation' : 're-review'}); `
      + `${used} of ${limit} are spent (config.unitRecheckCeiling): the owner decides`], { judgment_point: true });
  }
  if (retry) {
    R.chain.push({ review_execution: rx, kind: 'retry', predecessor: retry.predecessor, authorized_by: retry.authorized_by });
    note(S, 'UNIT_REVIEW_RETRY', { unit: u, review_execution: rx, predecessor: retry.predecessor, authorized_by: retry.authorized_by });
  }
  for (const r of S.repairs) if (r.unit === u && r.state === 'pending') { r.state = 'cancelled'; r.reason = `superseded by unit review ${rx}`; }
  if (rereview) spendCeiling(S, u, 'unit_rereview', retry ? { cause: 'retry', predecessor: retry.predecessor, authorized_by: retry.authorized_by }
    : { cause: 'stale', predecessor: rv.review_execution, from_evidence: rv.reviewed_evidence, to_evidence: bind.evidence_id,
      invalidations: (S.unit_checks[u].causes ?? []).filter(c => c.evidence === rv.reviewed_evidence).map(c => c.cause) });
  const record = { ...v.record, ...bind, second_opinion_identity: input.second_opinion?.reviewer_identity ?? null,
    repair_opened: opens, seq: S.seq };
  R.chain.push(record);
  note(S, 'UNIT_REVIEWED', { unit: u, review_execution: rx, kind: 'original', outcome: record.outcome, evidence: bind.evidence_id });
  if (opens) {
    spendCeiling(S, u, 'unit_repair', { cause: 'fail', review_execution: rx, findings: [...v.record.fix_findings] });
    S.repairs.push({ id: `repair-${rx}`, kind: 'unit-review', unit: u, review_execution: rx, writes: [...write_set], promptFile: brief,
      state: 'pending', old_candidate: candidate, evidence_id: bind.evidence_id });
    note(S, 'UNIT_REPAIR_ENQUEUED', { unit: u, review_execution: rx });
  }
  if (record.outcome === 'FAIL' && !opens) {
    return { ok: true, code: 'unit_review_terminal', judgment_point: true, record, reasons: [v.record.overflow ? 'overflow FAIL: no repair opens'
      : S.freeze ? 'a unit FAIL after the REVIEW freeze opens no repair' : 'FAIL with no finding to fix: no repair opens',
      'continuing needs an owner RETRY linked to this execution'] };
  }
  return { ok: true, code: 'unit_review_accepted', judgment_point: false, reasons: [], record, ...(opens ? { repair: { id: `repair-${rx}`, write_set: [...write_set] } } : {}) };
}

function confirmation(E, input, u, rv, v, bind) {
  const { S } = E, R = S.unit_reviews[u], rx = input.review_execution;
  if (rv.state !== 'fail' || rv.terminal || rv.awaiting !== 'confirmation' || rv.review_execution !== rx) {
    return no('unit_review_open', [`unit ${u} has no repaired review ${rx} awaiting confirmation (review state ${rv.state}`
      + `${rv.awaiting ? `, awaiting ${rv.awaiting}` : ''}${rv.terminal ? ', terminal' : ''})`]);
  }
  if (!v.ok) return { judgment_point: false, ...v };
  const { limit, used } = ceiling(S);
  if (!spendCeiling(S, u, 'unit_confirmation', { cause: 'repair', review_execution: rx })) {
    return no('parent_ceiling', [`unit ${u}'s confirmation needs one of the run's unit allowance; ${used} of ${limit} are spent: the owner decides`], { judgment_point: true });
  }
  const record = { ...v.record, ...bind, seq: S.seq };
  R.chain.push(record);
  note(S, 'UNIT_REVIEWED', { unit: u, review_execution: rx, kind: 'confirmation', outcome: record.outcome, evidence: bind.evidence_id });
  if (record.outcome === 'FAIL') {
    return { ok: true, code: 'unit_review_terminal', judgment_point: true, record, reasons: ['a failed targeted confirmation is terminal for this unit: only an owner RETRY continues'] };
  }
  return { ok: true, code: 'unit_review_accepted', judgment_point: false, reasons: [], record };
}

/** The unit review chain a 'unit-review' repair is authorized from (engine-attempts.mjs authorize). */
export const unitChain = (S, r) => S.unit_reviews?.[r.unit]?.chain ?? [];

/**
 * Before a unit repair dispatches: the unit's evidence must still be the one its FAIL reviewed;
 * otherwise the repair is cancelled (never dispatched against changed code) and the review is
 * stale, so a fresh original review is due. Returns whether it may dispatch.
 */
export function unitRepairCurrent(E, r) {
  const st = unitStates(E.S, E.ctx.repoRoot, {})[r.unit];
  if (st?.state === 'verified' && E.S.unit_checks[r.unit].evidence.id === r.evidence_id) return true;
  r.state = 'cancelled'; r.reason = `unit ${r.unit} evidence changed since review ${r.review_execution} (${st?.state ?? 'unknown'}); a fresh unit review is due`;
  note(E.S, 'UNIT_REPAIR_CANCELLED', { unit: r.unit, review_execution: r.review_execution, reason: r.reason });
  return false;
}

/** After a unit repair: its record in the unit chain; the repaired evidence is bound once the unit is verified again (bindRepairs). */
export function recordUnitRepair(E, repair, a) {
  const { S } = E;
  const c = io.candidateId(E.ctx.repoRoot, S.config.base ?? 'HEAD', S.pinned_exclusions);
  S.unit_reviews[repair.unit].chain.push({ review_execution: repair.review_execution, kind: 'repair', unit: repair.unit, old_candidate: repair.old_candidate ?? null,
    tree_candidate: c.candidate_id ?? null, new_candidate: null, write_set: [...repair.writes], attempt_id: a.attempt_id, seq: S.seq });
  note(S, 'UNIT_REPAIR_RECORDED', { unit: repair.unit, review_execution: repair.review_execution });
}

/**
 * At the end of a drive (after the post-repair re-check): a repaired unit that is verified again
 * binds that evidence as the candidate its targeted confirmation must review (`new_candidate`).
 */
export function bindRepairs(E) {
  const { S } = E;
  if (!unitReviewOn(S)) return;
  const states = unitStates(S, E.ctx.repoRoot, {});
  for (const [u, R] of Object.entries(S.unit_reviews)) {
    for (const rec of R.chain) if (rec.kind === 'repair' && rec.new_candidate === null && states[u].state === 'verified') {
      rec.new_candidate = S.unit_checks[u].evidence.id;
      note(S, 'UNIT_REPAIR_BOUND', { unit: u, review_execution: rec.review_execution, evidence: rec.new_candidate });
    }
  }
}
