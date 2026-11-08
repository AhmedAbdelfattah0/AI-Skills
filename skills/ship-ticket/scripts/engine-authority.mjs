/**
 * Owner authority in the plan's RUN-STATE (START, DAG_BOUND, RETRY, UNIT_CLEAR) for the durable run engine.
 * The plan file is writable by any dispatched code (a worker, a RED spec, a proof command), so a
 * line's content is never authority on its own: the engine honours only lines in
 * `state.authority.trusted`, and `observeAuthority` is the one place that fills it.
 *
 * A line is trusted only when the engine first observes it with no attempt started since its last
 * quiescent observation (`through` = the attempt count then). Every dispatch path records a durable
 * attempt before it releases any code (the launch protocol), so a line that appears while
 * dispatched code could have run lands in `untrusted` whichever path ran it. The block is read only
 * through run-state.mjs. A malformed block (a hidden line break, a brace line that is not JSON, a
 * marker count other than one BEGIN then one END) or
 * one whose already-observed bytes were rewritten also taints the lines first seen with it: a
 * rewrite can reveal a line that dispatched code planted where no reader saw it. Pure: callers pass
 * the plan text and the group-liveness probe.
 */
import { AUTHORITY_EVENTS, parseRunState, blockExtends, malformedReason } from './run-state.mjs';
import { LIVE } from './engine-quiesce.mjs';

/** Events a state from before the authority record may trust (re-checked against bound digests). */
const BOUND_ON_INIT = ['START', 'DAG_BOUND'];

/** Whether attempt `a` may still be running code ('unknown' is re-probed on its group). */
const mayRun = (a, isAlive) => (a.status === 'unknown' ? isAlive(a.pgid) !== false : LIVE.includes(a.status));

/**
 * Classify every authority line of `planText` not seen before (trusted or untrusted), then advance
 * `through` when no attempt may still run. A state from before this record trusts only its
 * START/DAG_BOUND lines (both are re-checked against bound digests anyway); a RETRY or UNIT_CLEAR is re-appended.
 */
export function observeAuthority(S, planText, isAlive) {
  const fresh = !S.authority;
  const A = (S.authority ??= { through: 0, trusted: [], untrusted: [] });
  const R = parseRunState(planText ?? '');
  const rewritten = Boolean(R && A.block && !blockExtends(A.block, R));
  const tainted = (S.attempts ?? []).length > A.through || rewritten || malformedReason(R) !== null;
  for (const e of R?.events ?? []) {
    if (!AUTHORITY_EVENTS.includes(e.event)) continue;
    const line = JSON.stringify(e);
    if (A.trusted.includes(line) || A.untrusted.some(u => u.line === line)) continue;
    if (tainted && !(fresh && BOUND_ON_INIT.includes(e.event))) A.untrusted.push({ line, seq: S.seq ?? 0 });
    else A.trusted.push(line);
  }
  if (rewritten) A.rewrites = (A.rewrites ?? 0) + 1;
  if (R) A.block = { length: R.length, digest: R.digest };
  if (!(S.attempts ?? []).some(a => mayRun(a, isAlive))) A.through = (S.attempts ?? []).length;
}

/** Judgments for a malformed RUN-STATE block in `planText` (empty when well formed or absent). */
export function malformedRunState(planText) {
  const reason = malformedReason(parseRunState(planText ?? ''));
  return reason ? [{ code: 'run_state_malformed', reason }] : [];
}

/** Trusted authority events of `kind` (parsed), in observation order. */
export const trustedEvents = (S, kind) => (S.authority?.trusted ?? []).map(l => JSON.parse(l)).filter(e => e.event === kind);

/** Untrusted authority events of `kind` (parsed). */
export const untrustedEvents = (S, kind) => (S.authority?.untrusted ?? []).map(u => JSON.parse(u.line)).filter(e => e.event === kind);

/**
 * The trusted RETRY of this run authorizing original review `rx` after `predecessor` (a final or a
 * unit review execution), or null; `forged` counts untrusted matches.
 */
export function retryEvent(S, rx, predecessor) {
  const match = (e) => e.run_id === S.run_id && e.review_execution === rx && e.predecessor === predecessor
    && typeof e.authorized_by === 'string' && e.authorized_by.length > 0;
  return { retry: trustedEvents(S, 'RETRY').find(match) ?? null, forged: untrustedEvents(S, 'RETRY').filter(match).length };
}
