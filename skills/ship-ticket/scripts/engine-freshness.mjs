/**
 * Candidate-bound review freshness (P0 slice E3). Node built-ins only.
 *
 * Every accepted review record (original, confirmation) and every repair record is bound, in
 * `state.review_bindings`, to the candidate it covers and the merge base that candidate was computed
 * against ({ review_execution, kind, candidate_id, merge_base, second_opinion_candidate_id? }). A
 * confirmation is bound to the merge base its repaired candidate was frozen at. The review_chain record
 * itself is unchanged (gate.mjs and eval read it as before).
 *
 * The authorizing review (the last chain record, an original or confirmation PASS) is FRESH while the
 * candidate recomputed against its bound merge base is still its candidate. So a git event that leaves the
 * candidate bytes alone (a commit, push, fetch, branch rename, an excluded-path edit or commit, a rebase
 * that keeps base and tree) never invalidates it, and any change to the candidate bytes does:
 *   review_stale       the bytes changed on the same base (an edit, an amend that changes content)
 *   review_base_moved  a config.base branch moved under the branch (a merge of it, a rebase onto it)
 * With config.base HEAD the candidate is computed against the merge base recorded with the review freeze
 * (engine-io.mjs candidateBase, R0-S C6), so a commit of the reviewed or repaired bytes before ship-ready or
 * before the confirmation changes nothing; only review_stale is reported (there is no base branch to move).
 *
 * ENFORCED: gate ship-ready refuses to record SHIP_READY, gate review refuses a confirmation whose
 * branch base moved since the repair, and authorize publish refuses (so publish and the pre-push guard do),
 * until an accepted review of the CURRENT candidate (the targeted confirmation of a repair, or an
 * owner-RETRY original) exists. DETECTED: `next`/`status` report it (`review_freshness`) and make the owner
 * RETRY the next action. A review file that only names the current candidate id is not enough: slice E7
 * (engine-review-dispatch.mjs) binds the reviewer's output to an engine dispatch for that candidate.
 */
import { spawnSync } from 'node:child_process';
import * as io from './engine-io.mjs';
import { provenanceMode, nativeAccepted } from './engine-review-dispatch.mjs';

/** Freshness refusals only a new review (an owner RETRY) clears. review_binding_missing: no binding, or one without a merge base
 * (a review accepted before E3), never fresh: it is re-gated, not grandfathered (R0-S A3). */
export const FRESHNESS_CODES = Object.freeze(['review_stale', 'review_base_moved', 'review_binding_missing', 'review_provenance_unbound']);

/** Record the candidate binding of an accepted review or repair record. */
export function bindReview(S, binding) {
  S.review_bindings = [...(S.review_bindings ?? []), binding];
}

/** The binding of chain record `rec` (the last one recorded for its execution and kind), or null. */
export const bindingOf = (S, rec) => (S.review_bindings ?? []).findLast(b => b.review_execution === rec.review_execution && b.kind === rec.kind) ?? null;

/** Whether config.base names a branch (not HEAD): only then is a moved merge base a distinct cause. */
const branchBase = (S) => Boolean(S.config?.base) && S.config.base !== 'HEAD';

const mergeBase = (repo, a, b) => {
  const r = spawnSync('git', ['--no-replace-objects', 'merge-base', a, b], { cwd: repo, encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  return r.status === 0 ? r.stdout.trim() : null;
};

/**
 * Freshness of the authorizing review: null when there is none (the gates decide), else
 * { fresh, code, review_execution, kind, reviewed, current, merge_base, reasons }. A record with no
 * binding or no bound merge base (accepted before this slice) is fresh: false, review_binding_missing.
 */
export function reviewFreshness(S, repoRoot) {
  const last = (S.review_chain ?? []).at(-1);
  if (!last || !['original', 'confirmation'].includes(last.kind) || last.outcome !== 'PASS') return null;
  const b = bindingOf(S, last);
  const base = { review_execution: last.review_execution, kind: last.kind, reviewed: last.candidate_id };
  if (!b?.merge_base) return { fresh: false, code: 'review_binding_missing', ...base, current: null, merge_base: null,
    reasons: [`${last.kind} ${last.review_execution} has no candidate binding with a merge base (accepted before review freshness, or the binding was lost): `
      + 'nothing proves which bytes it covered; the owner appends a RETRY for a new original review of the current candidate'] };
  const unbound = provenanceGap(S, last);
  if (unbound) return { fresh: false, code: 'review_provenance_unbound', ...base, current: null, merge_base: b.merge_base,
    reasons: [unbound, 'the enforced release policy needs reviews the engine dispatched and collected: the owner appends a RETRY for a new original review'] };
  const c = io.candidateId(repoRoot, b.merge_base, S.pinned_exclusions ?? []);
  if (!c.candidate_id) return { fresh: false, code: 'candidate_unavailable', ...base, current: null, merge_base: b.merge_base, reasons: [c.reason ?? 'candidate not computable'] };
  if (c.candidate_id === last.candidate_id) return { fresh: true, code: 'review_fresh', ...base, current: c.candidate_id, merge_base: b.merge_base, reasons: [] };
  const now = branchBase(S) ? mergeBase(repoRoot, 'HEAD', S.config.base) : null;
  const moved = branchBase(S) && now !== b.merge_base;
  return { fresh: false, code: moved ? 'review_base_moved' : 'review_stale', ...base, current: c.candidate_id, merge_base: b.merge_base,
    reasons: [moved ? `${S.config.base} moved under the branch since ${last.kind} ${last.review_execution} (merge base ${b.merge_base} -> ${now}): the shipped tree is not the reviewed one`
      : `the candidate bytes changed since ${last.kind} ${last.review_execution} reviewed ${last.candidate_id} (now ${c.candidate_id})`,
    'only an accepted review of the current candidate authorizes ship: revert to the reviewed bytes, or the owner appends a RETRY for a new original review'] };
}

/**
 * R0-S A4: the authorizing review (and the original of its execution) must have the provenance the run's policy demands:
 * under the strict default every slot is `engine_relay`; with the owner-approved acceptNativeReview the primary may be
 * `native_unbound` (labelled RELAXED); only the approved reviewProvenance 'unbound' accepts the pre-E7 label. A binding
 * with no provenance (accepted before E7) or any other label is refused. -> reason string | null
 */
export function provenanceGap(S, last) {
  if (provenanceMode(S) !== 'engine') return null;
  for (const r of (S.review_chain ?? []).filter(x => x.review_execution === last.review_execution && ['original', 'confirmation'].includes(x.kind))) {
    const b = bindingOf(S, r), p = b?.provenance;
    if (!p || typeof p !== 'object') return `${r.kind} ${r.review_execution} has no engine provenance (${p ?? 'none'}): a review accepted outside the strict policy`;
    for (const [slot, v] of Object.entries(p)) {
      if (v?.provenance === 'engine_relay') continue;
      if (v?.provenance === 'native_unbound' && slot === 'primary' && nativeAccepted(S)) continue;
      return `${r.kind} ${r.review_execution}: the ${slot} is ${v?.provenance ?? 'unlabelled'}, not an engine-dispatched review`;
    }
  }
  return null;
}
