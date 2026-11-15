// Single definition of the review-round timing vocabulary (A0.1), imported by run-log.mjs and eval.mjs.
// Pure: no I/O, so importing it never runs a CLI. Review rounds are identified only by REVIEW phase rows and
// these activities; BUILD-phase unit_review* activities are never part of a round.

/** Activity name -> round role. The partition reviewers are the primary review, split across workers. */
export const REVIEW_ROLE_OF = Object.freeze({
  primary_review: 'primary', frontend_review: 'primary', backend_review: 'primary', contract_review: 'primary',
  optional_review: 'second_opinion', review_reconcile: 'reconcile', review_repair: 'repair', review_confirmation: 'confirmation',
});
/** Activities whose START must carry candidate_id and review_execution (identity binding); the partition reviewers keep their legacy optional metrics. */
export const IDENTITY_ACTIVITIES = Object.freeze(['primary_review', 'optional_review', 'review_repair', 'review_confirmation', 'review_reconcile']);
export const GAP_REASONS = Object.freeze(['no_start_stamp', 'wait', 'unknown']);
export const CEILING_METRICS = Object.freeze(['primary_ceiling_ms', 'recovery_ceiling_ms', 'optional_ceiling_ms', 'confirmation_ceiling_ms']);
/** Metrics kept as strings (never numeric-coerced). */
export const STRING_METRICS = Object.freeze(['candidate_id', 'skill_revision']);
export const SKILL_REVISION = /^[A-Za-z0-9._:-]{1,80}$/;

/** Review-round ids (`review_execution`) recorded by REVIEW phase rows or round activities, open or closed. */
export function reviewRoundIds(run) {
  const all = [...run.intervals, ...(run.open_intervals ?? [])];
  const inRound = (i) => (i.kind === 'phase' && i.name === 'REVIEW') || (i.kind === 'activity' && REVIEW_ROLE_OF[i.name]);
  return [...new Set(all.filter(inRound).map((i) => i.metrics?.review_execution).filter((id) => typeof id === 'string'))];
}

/**
 * Per round: the roles it expects with how many closed and open intervals each has. Primary, second opinion and
 * reconcile are always expected once; repair/confirmation as many times as the REVIEW phase declares
 * (`repair_batches`, `confirmation_count`). `unknown` without any recorded round id.
 */
export function expectedReviewRoles(run) {
  const ids = reviewRoundIds(run);
  if (!ids.length) return 'unknown';
  const pending = run.open_intervals ?? [];
  return ids.map((id) => {
    const phase = run.intervals.find((i) => i.kind === 'phase' && i.name === 'REVIEW' && i.metrics.review_execution === id);
    const expected = { primary: 1, second_opinion: 1, reconcile: 1 };
    for (const [metric, role] of [['repair_batches', 'repair'], ['confirmation_count', 'confirmation']]) {
      if (Number.isInteger(phase?.metrics[metric]) && phase.metrics[metric] > 0) expected[role] = phase.metrics[metric];
    }
    const tally = (list, role) => list.filter((i) => i.kind === 'activity' && REVIEW_ROLE_OF[i.name] === role && i.metrics?.review_execution === id).length;
    return { review_execution: id, phase,
      roles: Object.entries(expected).map(([role, n]) => ({ role, expected: n, closed: tally(run.intervals, role), open: tally(pending, role) })) };
  });
}
