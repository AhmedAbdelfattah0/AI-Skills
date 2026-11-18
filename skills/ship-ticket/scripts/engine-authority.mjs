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
import { pairProblem, pairKey, normDigest } from './engine-dag.mjs';
import { isProxy } from 'node:util/types';

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

// ---- S-01b2 test-kind waivers: TEST_KIND_WAIVER (design rev 3 §4) -----------------------------------

/** Run caps for {@link testKindWaivers} (L3): authority lines read, their total UTF-16 length, subjects per set. */
export const TEST_KIND_WAIVER_BUDGET = Object.freeze({ lines: 10000, bytes: 8 * 1024 * 1024, subjects: 1024 });
/** A waivable subject: the strict marker grammar of the test-title scanner (`kind:` or `plan:` and an ASCII id). */
const TK_SUBJECT = /^(?:kind|plan):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TK_FIELDS = ['run_id', 'candidate', 'plan_digest', 'authorized_by', 'reason'];
const BAD = Symbol('bad');

/** Own data property `key` of a plain (non-Proxy) object, undefined when absent, BAD otherwise: never a trap or getter (L6). */
function own(obj, key) {
  if (obj === null || typeof obj !== 'object' || isProxy(obj)) return BAD;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined) return undefined;
  return 'value' in d ? d.value : BAD;
}

/** Elements of a real (non-Proxy) array read through own data descriptors, or BAD (holes, accessors, over `max`). */
function ownArray(arr, max) {
  if (!Array.isArray(arr) || isProxy(arr)) return BAD;
  const n = own(arr, 'length');
  if (!Number.isSafeInteger(n) || n > max) return n > max ? 'over' : BAD;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(arr, i);
    if (!d || !('value' in d)) return BAD;
    out.push(d.value);
  }
  return out;
}

/**
 * The test-kind waivers effective for `candidate` (S-01b2 §4, §6 row 32). A TEST_KIND_WAIVER { run_id,
 * requirement: 'kind:<id>'|'plan:<id>', candidate, plan_digest, authorized_by, reason } removes
 * `requirement` only when it is trusted (observeAuthority), of this run, for this plan digest
 * (normDigest on both sides) and exactly this candidate, and the requirement is in `required` and
 * not in `protected` (the caller's recomputed protection). Its own match, independent of
 * waiverState's security fields. A matching untrusted waiver (required, protected or not) is
 * `unauthorized` unless a trusted one waives the same subject. Trusted waivers with no effect are
 * counted by reason. Ids, enums and counts only; never throws: a hostile, malformed or over-budget
 * input gives ok: false with a code and nothing waived (fail closed).
 * -> { ok, code?, waived: [subject], unauthorized: [subject], ignored: { malformed, foreign, not_required, protected } }
 */
export function testKindWaivers(S, candidate, sets) {
  const ignored = { malformed: 0, foreign: 0, not_required: 0, protected: 0 };
  const refuse = (code) => ({ ok: false, code, waived: [], unauthorized: [], ignored: { malformed: 0, foreign: 0, not_required: 0, protected: 0 } });
  try {
    const B = TEST_KIND_WAIVER_BUDGET;
    if (!nonEmpty(candidate)) return refuse('test_kinds_waiver_input_invalid');
    const required = ownArray(own(sets, 'required'), B.subjects), prot = ownArray(own(sets, 'protected'), B.subjects);
    if (required === 'over' || prot === 'over') return refuse('test_kinds_waiver_budget_exceeded');
    if (required === BAD || prot === BAD || ![...required, ...prot].every(s => typeof s === 'string' && TK_SUBJECT.test(s))) return refuse('test_kinds_waiver_input_invalid');
    const runId = own(S, 'run_id'), digest = own(S, 'plan_digest');
    if (!nonEmpty(runId) || !nonEmpty(digest)) return refuse('test_kinds_waiver_state_invalid');
    const authority = own(S, 'authority');
    if (authority === BAD) return refuse('test_kinds_waiver_state_invalid');
    const listOf = (key) => (authority === undefined ? [] : ownArray(own(authority, key) ?? [], B.lines));
    const trusted = listOf('trusted'), untrusted = listOf('untrusted');
    if (trusted === BAD || untrusted === BAD) return refuse('test_kinds_waiver_state_invalid');
    if (trusted === 'over' || untrusted === 'over' || trusted.length + untrusted.length > B.lines) return refuse('test_kinds_waiver_budget_exceeded');
    const lines = [];
    for (const line of trusted) lines.push({ line, trusted: true });
    for (const u of untrusted) lines.push({ line: own(u, 'line'), trusted: false });
    let bytes = 0;
    for (const l of lines) {
      if (typeof l.line !== 'string') return refuse('test_kinds_waiver_state_invalid');
      bytes += l.line.length;
      if (bytes > B.bytes) return refuse('test_kinds_waiver_budget_exceeded');
    }
    const req = new Set(required), protectedSet = new Set(prot), wantDigest = normDigest(digest);
    const waived = new Set(), forged = new Set();
    for (const l of lines) {
      const e = JSON.parse(l.line);
      if (own(e, 'event') !== 'TEST_KIND_WAIVER') continue;
      const subject = own(e, 'requirement');
      const fields = TK_FIELDS.map(k => own(e, k));
      if (!(typeof subject === 'string' && TK_SUBJECT.test(subject)) || !fields.every(nonEmpty)) { if (l.trusted) ignored.malformed++; continue; }
      const [run, cand, dig] = fields;
      if (run !== runId || cand !== candidate || normDigest(dig) !== wantDigest) { if (l.trusted) ignored.foreign++; continue; }
      if (!req.has(subject)) { if (l.trusted) ignored.not_required++; continue; }
      if (!l.trusted) { forged.add(subject); continue; }
      if (protectedSet.has(subject)) { ignored.protected++; continue; }
      waived.add(subject);
    }
    return { ok: true, waived: [...waived].sort(), unauthorized: [...forged].filter(s => !waived.has(s)).sort(), ignored };
  } catch {
    return refuse('test_kinds_waiver_state_invalid');
  }
}
