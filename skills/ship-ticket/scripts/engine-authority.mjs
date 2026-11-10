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
import { pairProblem, pairKey } from './engine-dag.mjs';

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

// ---- security policy 2: SECURITY_ADDENDUM and SECURITY_WAIVER (AIS-HARNESS-4 Wave B) -----------------

const SAFE_ADDENDUM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const specKey = (s) => `${s.file}\u0000${s.name}`;

/**
 * The effective security pairs of a policy-2 run, re-derived on every call from the bound DAG
 * coverage and the TRUSTED addenda (never stored, so add-only across resume and interruption).
 * A trusted SECURITY_ADDENDUM { run_id, addendum_id, pairs: [{ boundary, control, node, specs }],
 * authorized_by, reason } adds its pairs only when every pair is well formed, new (not already effective),
 * uses specs no effective pair uses, and its node exists with every spec under that node's writes;
 * otherwise it adds nothing and lands in `conflicts` (addendum_conflict: malformed, a pair already
 * effective, a shared spec, or the same addendum_id with other bytes) or `outside`
 * (addendum_outside_contract). Untrusted addenda and waivers of this run are `forged`.
 * -> { pairs: [{ boundary, control, node, specs, addendum? }], addenda: [{ addendum_id, pairs }], waivers, forged: { addenda, waivers }, conflicts, outside }
 */
export function securityEvents(S) {
  const nodes = S.nodes ?? {};
  const pairs = (S.config?.controlCoverage ?? []).map(p => structuredClone(p));
  const effective = new Set(pairs.map(pairKey)), specs = new Set(pairs.flatMap(p => p.specs.map(specKey)));
  const addenda = [], conflicts = [], outside = [], seen = new Map();
  const mine = (e) => e.run_id === S.run_id;
  for (const line of S.authority?.trusted ?? []) {
    const e = JSON.parse(line);
    if (e.event !== 'SECURITY_ADDENDUM' || !mine(e)) continue;
    const id = e.addendum_id;
    if (!(typeof id === 'string' && SAFE_ADDENDUM.test(id)) || !nonEmpty(e.authorized_by) || !nonEmpty(e.reason) || !Array.isArray(e.pairs) || !e.pairs.length) {
      conflicts.push({ addendum_id: id ?? null, reason: 'an addendum needs a safe addendum_id, authorized_by, a reason and non-empty pairs' });
      continue;
    }
    if (seen.has(id)) {
      if (seen.get(id) !== line) conflicts.push({ addendum_id: id, reason: `addendum ${id} was appended again with other bytes` });
      continue;
    }
    seen.set(id, line);
    let problem = null;
    const mineKeys = new Set(), mineSpecs = new Set();
    for (const p of e.pairs) {
      const why = pairProblem(p, nodes, { needPinned: false });
      if (why.shape) { problem = { conflict: why.shape }; break; }
      if (why.contract) { problem = { outside: why.contract }; break; }
      if (effective.has(pairKey(p)) || mineKeys.has(pairKey(p))) { problem = { conflict: `${pairKey(p)} is already effective (addenda only add)` }; break; }
      const shared = p.specs.find(s => specs.has(specKey(s)) || mineSpecs.has(specKey(s)));
      if (shared) { problem = { conflict: `${pairKey(p)}: spec ${shared.file} "${shared.name}" is already another pair's` }; break; }
      mineKeys.add(pairKey(p));
      p.specs.forEach(s => mineSpecs.add(specKey(s)));
    }
    if (problem?.conflict) { conflicts.push({ addendum_id: id, reason: problem.conflict }); continue; }
    if (problem?.outside) { outside.push({ addendum_id: id, reason: problem.outside }); continue; }
    const added = e.pairs.map(p => ({ boundary: p.boundary, control: p.control, node: p.node, specs: p.specs.map(s => ({ file: s.file, name: s.name })), addendum: id }));
    for (const p of added) { pairs.push(p); effective.add(pairKey(p)); p.specs.forEach(s => specs.add(specKey(s))); }
    addenda.push({ addendum_id: id, pairs: added });
  }
  return { pairs, addenda, waivers: trustedEvents(S, 'SECURITY_WAIVER').filter(mine),
    forged: { addenda: untrustedEvents(S, 'SECURITY_ADDENDUM').filter(mine), waivers: untrustedEvents(S, 'SECURITY_WAIVER').filter(mine) },
    conflicts, outside };
}

/**
 * Waivers of `candidate`: a SECURITY_WAIVER { run_id, boundary, control, candidate, policy_version: 2,
 * authorized_by, reason } waives an effective pair only when trusted and for exactly this candidate.
 * A matching untrusted one (appended while dispatched code could run) is `unauthorized`.
 */
export function waiverState(S, sec, candidate) {
  const keys = new Set(sec.pairs.map(pairKey));
  const match = (e) => e.candidate === candidate && e.policy_version === 2 && nonEmpty(e.authorized_by) && nonEmpty(e.reason)
    && keys.has(`${e.boundary}:${e.control}`);
  const waived = [...new Set(sec.waivers.filter(match).map(e => `${e.boundary}:${e.control}`))].sort();
  const unauthorized = [...new Set(sec.forged.waivers.filter(match).map(e => `${e.boundary}:${e.control}`))].filter(k => !waived.includes(k)).sort();
  return { waived, unauthorized };
}
