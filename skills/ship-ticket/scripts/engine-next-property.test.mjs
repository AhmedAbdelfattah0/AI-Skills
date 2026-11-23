/**
 * S-14a property tests of `derive` against an INDEPENDENT oracle (PR #125, attempt 2 round 1 repair). Pure: no engine process.
 * The oracle never calls the implementation's classification (`refusal`, `classOf`, `FAILURE_CLASSES`): it carries its own copy
 * of the approved package's FR-1 table (PLAN-S28b-S14-approval-package.md §3.3) plus the orchestrator-correctable input refusals
 * the package describes ("the orchestrator corrects once"). The seeded fuzz generator is adapted from the round-1 reviewer's
 * oracle fuzz (scratchpad opus125/fuzz.mjs, Opus, 2026-11-23); this file is self-contained.
 *   enumeration (>= 5,000 structured record sets) and fuzz (>= 20,000 seeded random record sets), each asserting:
 *   I1 a human-owned fact never yields CONTINUE           I2 owner_publish only for a clean, current, unrefused SHIP_READY
 *   I3 the owner is the action's, executor is null        I4 adding a judgment or an attempt is never less restrictive
 *   I5 no gate review over a pending lane, no re-dispatch of a dispatched role
 *   I6 liveness: a recorded RETRY is never asked for again, and a bounded walk applying each named action's effect reaches a
 *      stop (WAIT_FOR_USER, FAIL or owner_publish) with no repeated state
 * Tags [N22] [N23] [N24] [N28]-[N31] name the engine-next-mutation.test.mjs mutants these tests must kill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { derive, ACTIONS } from './engine-next.mjs';

// ---- the independent oracle table (package FR-1 table; never the implementation's) ------------------------------
const O_SECURITY = ['security_policy_required', 'security_reapproval', 'plan_tags_missing', 'stale_candidate', 'post_freeze_drift', 'quiescence_unknown',
  'base_state_missing', 'base_moved_local', 'base_moved_remote', 'base_unverified', 'remote_ambiguous', 'identity_changed', 'identity_unbound',
  'identity_state_missing', 'review_stale', 'review_base_moved', 'review_binding_missing', 'review_provenance_unbound', 'reviewer_is_builder'];
const O_APPROVAL = ['approval_mismatch', 'dag_mismatch', 'retry_unauthorized', 'waiver_unauthorized', 'addendum_required', 'repair_failed', 'round_limit',
  'budget_stop', 'billing_unverified', 'confirmation_spent'];
const O_INSTALL = ['policy_version_unsupported', 'legacy_state', 'lock_malformed', 'lock_foreign_host'];
const O_VERIFY = ['base_remote_unavailable', 'candidate_unavailable', 'git_unavailable'];
const O_WORK = ['node_failed'];
const O_INPUT = ['missing_second_opinion', 'missing_reconciliation', 'outcome_inconsistent'];
const O_HUMAN = new Set([...O_SECURITY, ...O_APPROVAL, ...O_INSTALL]);
const O_NONHUMAN = new Set([...O_VERIFY, ...O_WORK, ...O_INPUT]);
/** Human-owned per the package: its SECURITY, APPROVAL and ENGINE install rows, and UNKNOWN (anything unlisted). */
const humanCode = (c) => O_HUMAN.has(c) || !O_NONHUMAN.has(c);

const NOW = 1e12, C1 = 'c'.repeat(64), C2 = 'd'.repeat(64);
const LIVE = ['intent', 'launched', 'running', 'unknown'];
const RETRY_LINE = JSON.stringify({ run_id: 'run-1', event: 'RETRY', review_execution: 'review-2', predecessor: 'review-1', authorized_by: 'owner' });
const orig = (outcome, c = C1) => ({ review_execution: 'review-1', kind: 'original', outcome, candidate_id: c });
const REP = { review_execution: 'review-1', kind: 'repair', old_candidate: C1, new_candidate: C2, write_set: ['src/a.txt'] };
const repairItem = (state) => ({ id: 'repair-review-1', kind: 'review', review_execution: 'review-1', state });
const lane = (role, o = {}) => ({ event_id: `ev-${role}-${o.review_execution ?? 'review-1'}-${o.name ?? ''}`, role, name: o.name ?? role, review_execution: 'review-1', candidate_id: C1,
  started_at: 'x', marker: `/r/${role}`, marker_exists: false, ended: false, result_ms: null, deadline: 'x', deadline_ms: NOW + 6e5, ...o });
const done = (role, o = {}) => lane(role, { marker_exists: true, result_ms: NOW - 1000, ...o });
const attempt = (kind, o = {}) => ({ attempt_id: `at-${kind}`, kind: 'node', node: 'a', status: 'running', pid: 7, envelope: false, deadline: 'x', deadline_ms: NOW + 3.6e6,
  liveness: { state: 'alive', reason: 'start_time_equal' }, ...o });
const S0 = (o = {}) => ({ run_id: 'run-1', ticket: 'T-1', policy_version: 1, config: {}, nodes: { a: { id: 'a', state: 'done', deps: [], redSpecs: [] } },
  review_chain: [], repairs: [], attempts: [], judgments: [], authority: { trusted: [], untrusted: [] }, freeze: null, ...o });
const F0 = (o = {}) => ({ now: NOW, lock: { state: 'free' }, attempts: [], dispatches: [], unbound: [], blockers: [], redPending: [], unitReviewsPending: [],
  work: false, budgetStop: false, candidate: { id: C1 }, gates: [], ...o });
const grow = (gate, ok, code, c, at, rx = null) => ({ gate, ok, code, candidate_id: c, review_execution: rx, at_ms: at });

// ---- the oracle -----------------------------------------------------------------------------------------------
/** A recorded owner RETRY of review-1 that is still owed (review-1 has an original record, review-2 none). */
const retryOf = (S) => (S.authority?.trusted ?? []).some(l => JSON.parse(l).event === 'RETRY')
  && S.review_chain.some(r => r.kind === 'original' && r.review_execution === 'review-1') && !S.review_chain.some(r => r.review_execution === 'review-2');
const lastRow = (f, gate, c) => f.gates.filter(g => g.gate === gate && (g.candidate_id == null || g.candidate_id === c)).at(-1);
const spent = (S, j) => j.code === 'quiescence_unknown' && S.attempts.some(a => a.node === j.node) && S.attempts.filter(a => a.node === j.node).every(a => !LIVE.includes(a.status) && a.quiesced === true);
/** The human-owned facts of a record set, read from the records alone. */
function humanFacts(S, f) {
  const cur = f.candidate.id, out = [];
  for (const j of f.unbound) out.push(`unbound:${j.code}`);
  for (const j of f.blockers) if (humanCode(j.code) && !spent(S, j) && !(retryOf(S) && j.code === 'repair_failed')) out.push(`judgment:${j.code}`);
  for (const a of f.attempts) if (!a.envelope && a.status !== 'intent' && a.liveness.state !== 'dead' && NOW > a.deadline_ms) out.push('overdue');
  if (['malformed', 'foreign'].includes(f.lock.state)) out.push(`lock:${f.lock.state}`);
  if (f.budgetStop && f.work) out.push('budget');
  if (!retryOf(S) && cur) {
    const r = lastRow(f, 'review', cur);
    if (r && !r.ok && humanCode(r.code)) out.push(`review:${r.code}`);
    const g = lastRow(f, 'ship-ready', cur);
    if (g && !g.ok && humanCode(g.code) && g.at_ms >= (r?.at_ms ?? -Infinity)) out.push(`ship:${g.code}`);
  }
  return out;
}
/** Which review a lane belongs to, read from the records (second opinions of a repaired execution: the confirmation's when on the repaired candidate or candidate-less). */
function laneKind(S, d) {
  if (d.role === 'confirmation') return 'confirmation';
  if (d.role !== 'second_opinion') return 'original';
  const rep = S.review_chain.find(r => r.kind === 'repair' && r.review_execution === d.review_execution);
  if (!rep) return 'original';
  if (d.candidate_id == null) return S.review_chain.some(r => r.kind === 'confirmation' && r.review_execution === d.review_execution) ? 'original' : 'confirmation';
  return d.candidate_id === rep.new_candidate ? 'confirmation' : 'original';
}
const consumed = (S, d) => S.review_chain.some(r => r.review_execution === d.review_execution && r.kind === laneKind(S, d)
  && (r.candidate_id === undefined || d.candidate_id == null || r.candidate_id === d.candidate_id));
const isReady = (d) => d.ended || d.marker_exists;
const metric = (a) => (a.turn_end === 'FAIL' ? 0 : a.turn_end === 'COMPLETE' || a.action === 'owner_publish' ? 4 : a.turn_end === 'WAIT_FOR_USER' ? 1 : a.disposition === 'BLOCKED' ? 2 : 3);

/** I1-I5 on one record set: the list of violations. */
function check(S, f, a) {
  const v = [], cur = f.candidate.id;
  const hf = humanFacts(S, f);
  if (hf.length && a.turn_end === 'CONTINUE') v.push(`I1 ${hf.join(',')} -> ${a.action}/${a.code}`);
  if (a.action === 'owner_publish' || a.turn_end === 'COMPLETE') {
    const last = S.review_chain.at(-1);
    const sr = f.gates.filter(g => g.gate === 'ship-ready' && (g.candidate_id == null || g.candidate_id === cur));
    const okAt = sr.map(g => g.ok).lastIndexOf(true);
    const bad = [!cur && 'no candidate', hf.length && 'human facts', f.attempts.length && 'attempts', f.blockers.length && 'judgments',
      !(last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' && last.candidate_id === cur) && 'not the accepted candidate',
      S.ship_ready?.candidate_id !== cur && 'no SHIP_READY for it', sr.slice(okAt + 1).some(g => !g.ok) && 'refused after',
      Object.values(S.nodes).some(n => !['done', 'cancelled'].includes(n.state)) && 'nodes'].filter(Boolean);
    if (bad.length) v.push(`I2 ${bad.join(',')}`);
  }
  if (a.owner !== ACTIONS[a.action] || a.executor !== null || (a.owner === 'human' && a.turn_end === 'CONTINUE')) v.push(`I3 ${a.action}`);
  if (a.action === 'gate_review') {
    const rx = a.detail.review_execution, kind = a.detail.kind;
    const pend = f.dispatches.filter(d => rx && d.review_execution === rx && laneKind(S, d) === kind && !consumed(S, d) && !isReady(d) && (d.candidate_id == null || d.candidate_id === cur));
    if (pend.length) v.push(`I5 gate_review ${a.disposition} over pending ${pend.map(d => d.name).join(',')}`);
  }
  if (a.action === 'dispatch_review' && a.detail.review_execution) {
    const dup = f.dispatches.filter(d => d.review_execution === a.detail.review_execution && a.detail.roles.includes(d.role) && !consumed(S, d) && (d.candidate_id == null || d.candidate_id === cur));
    if (dup.length) v.push(`I5 re-dispatch ${dup.map(d => d.role).join(',')}`);
  }
  // I6 (liveness, recorded decision): a trusted RETRY with nothing else for the owner is never asked for again
  if (retryOf(S) && cur && !hf.length && !f.blockers.length && a.turn_end !== 'CONTINUE' && !refusedRetryResults(f))
    v.push(`I6 RETRY recorded, still asks ${a.action}/${a.code}`);
  return v;
}
/** Whether the retry execution's own results were refused (a new decision, not the recorded one). */
const refusedRetryResults = (f) => f.gates.some(g => g.gate === 'review' && !g.ok && f.dispatches.some(d => d.review_execution === 'review-2' && (d.result_ms ?? Infinity) <= g.at_ms));

// ---- I6 bounded walk: the expected effect of each named action ---------------------------------------------------
function step(S, f, a, n) {
  const t = NOW + n * 10;
  const cur = f.candidate.id;
  switch (a.action) {
    case 'resume': f.attempts = f.attempts.filter(x => !x.envelope && x.status !== 'intent' && x.liveness.state !== 'dead'); f.blockers = f.blockers.filter(j => !spent(S, j)); return;
    case 'wait':
      if (f.lock.state === 'held') { f.lock = { state: 'free' }; return; }
      if (f.attempts.length) { f.attempts = f.attempts.map(x => ({ ...x, envelope: true })); return; }
      f.dispatches = f.dispatches.map(d => (isReady(d) ? d : { ...d, marker_exists: true, result_ms: t })); return;
    case 'drive':
      if (a.stage === 'REPAIR') {
        S.repairs = S.repairs.map(r => ({ ...r, state: 'done' })); S.review_chain.push({ ...REP }); S.freeze = { candidate: C2 }; f.candidate = { id: C2 }; return;
      }
      for (const nd of Object.values(S.nodes)) nd.state = 'done'; f.work = false; return;
    case 'gate_red': f.redPending = []; return;
    case 'unit_review': f.unitReviewsPending = []; return;
    case 'dispatch_review': {
      const rx = a.detail.review_execution ?? `review-w${n}`;
      for (const role of a.detail.roles) f.dispatches.push(lane(role, { review_execution: rx, candidate_id: cur, event_id: `w${n}-${role}`, name: `w${n}-${role}` })); return;
    }
    case 'gate_review': {
      const rx = a.detail.review_execution;
      if (a.disposition === 'BLOCKED') { f.dispatches = f.dispatches.map(d => (d.review_execution === rx ? { ...d, marker_exists: true, result_ms: t } : d)); return; }
      f.gates.push(grow('review', true, 'review_accepted', cur, t, rx));
      if (a.detail.kind === 'confirmation') S.review_chain.push({ review_execution: rx, kind: 'confirmation', outcome: 'PASS', candidate_id: cur });
      else { S.review_chain.push({ review_execution: rx, kind: 'original', outcome: 'PASS', candidate_id: cur }); S.freeze = { candidate: cur }; S.authority = { trusted: [], untrusted: [] }; }
      return;
    }
    case 'gate_ship_ready':
      if (a.disposition === 'BLOCKED') { f.gates.push(grow('ship-ready', true, 'ship_ready', cur, t)); S.ship_ready = { candidate_id: cur }; return; }
      f.gates.push(grow('ship-ready', true, 'ship_ready', cur, t)); S.ship_ready = { candidate_id: cur }; return;
    case 'resolve':
      if (a.code === 'candidate_unavailable') { f.candidate = { id: S.review_chain.at(-1)?.candidate_id ?? C1 }; return; }
      if (a.code === 'review_overdue') { f.dispatches = f.dispatches.map(d => ({ ...d, marker_exists: true, result_ms: t })); return; }
      f.blockers = f.blockers.filter(j => j.code !== a.code);
      for (const nd of Object.values(S.nodes)) if (nd.state === 'failed') nd.state = 'pending';
      f.work = Object.values(S.nodes).some(nd => nd.state === 'pending'); return;
    default: throw new Error(`walk: no effect modelled for ${a.action}`);
  }
}
/** Walk from a record set: every CONTINUE answer must change the records, and a stop must come within `max` steps. */
function walk(S0_, f0, max = 30) {
  const S = structuredClone(S0_), f = structuredClone(f0), seen = new Set();
  for (let n = 0; n < max; n++) {
    const a = derive(S, f).next_action;
    if (a.turn_end !== 'CONTINUE') return null;
    const key = JSON.stringify([a.action, a.code, S.review_chain, S.ship_ready, f]);
    if (seen.has(key)) return `I6 no progress at ${a.stage}/${a.action}/${a.code}`;
    seen.add(key);
    step(S, f, a, n);
  }
  return `I6 no stop within ${max} steps`;
}

// ---- the structured enumeration ---------------------------------------------------------------------------------
const BASES = {
  build: () => [S0({ nodes: { a: { id: 'a', state: 'pending', deps: [], redSpecs: [] } } }), { work: true }],
  review_none: () => [S0(), {}],
  review_partial: () => [S0(), { dispatches: [done('primary')] }],
  review_ready: () => [S0(), { dispatches: [done('primary'), done('second_opinion')] }],
  passed: () => [S0({ freeze: { candidate: C1 }, review_chain: [orig('PASS')] }), {}],
  fail_terminal: () => [S0({ freeze: { candidate: C1 }, review_chain: [orig('FAIL')] }), {}],
  repairing: () => [S0({ freeze: { candidate: C1 }, review_chain: [orig('FAIL')], repairs: [repairItem('pending')] }), {}],
  confirming: () => [S0({ freeze: { candidate: C2 }, review_chain: [orig('FAIL'), REP], repairs: [repairItem('done')] }), { candidate: { id: C2 }, dispatches: [done('confirmation', { candidate_id: C2 })] }],
  confirm_fail: () => [S0({ freeze: { candidate: C2 }, review_chain: [orig('FAIL'), REP, { review_execution: 'review-1', kind: 'confirmation', outcome: 'FAIL', candidate_id: C2 }], repairs: [repairItem('done')] }), { candidate: { id: C2 } }],
  shipped: () => [S0({ freeze: { candidate: C1 }, review_chain: [orig('PASS')], ship_ready: { candidate_id: C1 } }), { gates: [grow('review', true, 'review_accepted', C1, NOW - 90), grow('ship-ready', true, 'ship_ready', C1, NOW - 80)] }],
};
const PARTS = { none: () => [], legacy_primary: () => [lane('primary', { name: 'backend_review', candidate_id: null })], legacy_second: () => [lane('second_opinion', { name: 'legacy_so', candidate_id: null })],
  extra_done: () => [done('primary', { name: 'contract_review' })] };
const RETRIES = { none: false, retry: true };
const LOCKS = { free: { state: 'free' }, held: { state: 'held' }, malformed: { state: 'malformed', reason: 'x' } };
const ATTEMPTS = { none: [], in_flight: [attempt('i')], dead: [attempt('d', { liveness: { state: 'dead', reason: 'no_process' } })], envelope: [attempt('e', { envelope: true })], overdue: [attempt('o', { deadline_ms: NOW - 1 })] };
const JUDG = { none: [], unbound: 'unbound', security: [{ code: 'stale_candidate', node: 'a', reason: 'x' }], work: [{ code: 'node_failed', node: 'a', reason: 'x' }] };
const HIST = { none: () => [], input_once: (c) => [grow('review', false, 'missing_reconciliation', c, NOW - 50)],
  input_twice: (c) => [grow('review', false, 'missing_reconciliation', c, NOW - 60), grow('review', false, 'missing_reconciliation', c, NOW - 50)],
  security: (c) => [grow('review', false, 'reviewer_is_builder', c, NOW - 50)],
  revert: () => [grow('review', true, 'review_accepted', C1, NOW - 95), grow('ship-ready', true, 'ship_ready', C1, NOW - 90), grow('ship-ready', false, 'base_unverified', C1, NOW - 80), grow('ship-ready', false, 'catalog_unavailable', C2, NOW - 70)] };

function* enumerate() {
  for (const [b, base] of Object.entries(BASES)) for (const [p, part] of Object.entries(PARTS)) for (const [r, retry] of Object.entries(RETRIES))
    for (const [l, lock] of Object.entries(LOCKS)) for (const [t, atts] of Object.entries(ATTEMPTS)) for (const [j, judg] of Object.entries(JUDG)) for (const [h, hist] of Object.entries(HIST)) {
      if (l !== 'free' && (t !== 'none' || j !== 'none')) continue; // the lock varies on its own
      const [S, over] = base();
      if (retry) S.authority = { trusted: [RETRY_LINE], untrusted: [] };
      const cur = (over.candidate ?? { id: C1 }).id;
      const f = F0({ ...over, dispatches: [...(over.dispatches ?? []), ...(['review_none', 'review_partial', 'review_ready', 'confirming'].includes(b) ? part() : [])],
        lock, attempts: atts, blockers: judg === 'unbound' ? [] : judg, unbound: judg === 'unbound' ? [{ code: 'approval_mismatch', node: null, reason: 'x' }] : [],
        gates: [...(over.gates ?? []), ...hist(cur)] });
      yield { name: `${b}/${p}/${r}/${l}/${t}/${j}/${h}`, S, f, j, t };
    }
}

test('property [N22] [N23] [N24] [N28] [N29] [N30] [N31] enumeration (>= 5,000 record sets): I1-I6 against the independent oracle', () => {
  let n = 0, walks = 0;
  const fails = [];
  for (const { name, S, f, j, t } of enumerate()) {
    n++;
    const a = derive(S, f).next_action;
    for (const v of check(S, f, a)) fails.push(`${name}: ${v}`);
    if (j === 'none' && t === 'none') {
      for (const [jj, list] of Object.entries(JUDG)) for (const [tt, atts] of Object.entries(ATTEMPTS)) {
        if (list === 'unbound') continue;
        const more = derive(S, { ...f, blockers: list, attempts: atts }).next_action;
        if (metric(more) > metric(a)) fails.push(`${name}: I4 + ${jj}/${tt}: ${metric(a)} -> ${metric(more)}`);
      }
      if (f.lock.state !== 'malformed') { walks++; const w = walk(S, f); if (w) fails.push(`${name}: ${w}`); }
    }
  }
  assert.ok(n >= 5000 && walks >= 500, `enumerated ${n} record sets, walked ${walks}`);
  assert.deepEqual(fails.slice(0, 40), [], `${fails.length} violations`);
});

// ---- seeded random fuzz (>= 20,000 record sets) -------------------------------------------------------------------
const CODES = [...O_HUMAN, ...O_NONHUMAN, 'brand_new_code'];
function generator(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)], chance = (p) => rnd() < p;
  return () => {
    const nodeState = pick(['done', 'done', 'done', 'pending', 'failed']);
    const S = S0({ nodes: { a: { id: 'a', state: nodeState, deps: [], redSpecs: [] } } });
    const k = pick(['none', 'pass1', 'pass2', 'fail_terminal', 'repairing', 'repaired', 'confirm_pass', 'confirm_fail']);
    if (k === 'pass1') S.review_chain = [orig('PASS', C1)];
    if (k === 'pass2') S.review_chain = [orig('PASS', C2)];
    if (k === 'fail_terminal') S.review_chain = [orig('FAIL')];
    if (k === 'repairing') { S.review_chain = [orig('FAIL')]; S.repairs = [repairItem(pick(['pending', 'running', 'failed']))]; }
    if (['repaired', 'confirm_pass', 'confirm_fail'].includes(k)) { S.review_chain = [orig('FAIL'), REP]; S.repairs = [repairItem('done')]; }
    if (k === 'confirm_pass') S.review_chain.push({ review_execution: 'review-1', kind: 'confirmation', outcome: 'PASS', candidate_id: C2 });
    if (k === 'confirm_fail') S.review_chain.push({ review_execution: 'review-1', kind: 'confirmation', outcome: 'FAIL', candidate_id: C2 });
    if (chance(0.3)) S.ship_ready = { candidate_id: pick([C1, C2]) };
    if (chance(0.15)) S.authority = { trusted: [RETRY_LINE], untrusted: [] };
    const blockers = nodeState === 'failed' ? [{ code: 'node_failed', node: 'a', reason: 'failed' }] : []; // status always reports a failed node
    for (let i = 0, m = pick([0, 0, 0, 1, 1, 2]); i < m; i++) blockers.push({ code: pick(CODES), node: pick(['a', 'repair-review-1', null]), reason: 'r' });
    if (blockers.some(b => b.code === 'quiescence_unknown') && chance(0.5)) S.attempts = [{ attempt_id: 'q', node: 'a', status: pick(['abandoned', 'unknown']), quiesced: chance(0.7) }];
    const unbound = chance(0.05) ? [{ code: pick(['approval_mismatch', 'dag_mismatch', 'security_reapproval']), node: null, reason: 'u' }] : [];
    const attempts = [];
    for (let i = 0, m = pick([0, 0, 0, 1, 2]); i < m; i++) attempts.push(attempt(`f${i}`, { kind: pick(['node', 'repair', 'proof']), status: pick(['running', 'unknown', 'intent']),
      envelope: chance(0.2), deadline_ms: chance(0.3) ? NOW - 1 : NOW + 1e6, liveness: { state: pick(['alive', 'dead', 'unknown']), reason: 'r' } }));
    const dispatches = [];
    for (let i = 0, m = pick([0, 0, 1, 2, 3, 4]); i < m; i++) {
      const fin = chance(0.6);
      dispatches.push(lane(pick(['primary', 'primary', 'second_opinion', 'confirmation']), { event_id: `e${i}`, name: `n${i}`, review_execution: pick(['review-1', 'review-1', 'review-2']),
        candidate_id: pick([C1, C2, null]), marker_exists: fin && chance(0.8), ended: fin && chance(0.5), result_ms: fin ? NOW - Math.floor(rnd() * 100) : null,
        deadline_ms: chance(0.15) ? NOW - 1 : NOW + 1e6 }));
      if (fin && !dispatches.at(-1).marker_exists) dispatches.at(-1).ended = true;
    }
    const gates = [];
    for (let i = 0, m = pick([0, 0, 1, 2, 3]); i < m; i++) {
      const ok = chance(0.5), g = pick(['review', 'ship-ready']);
      gates.push(grow(g, ok, ok ? (g === 'review' ? 'review_accepted' : 'ship_ready') : pick(['stale_candidate', 'reviewer_is_builder', 'missing_second_opinion', 'missing_reconciliation',
        'candidate_unavailable', 'base_unverified', 'confirmation_spent']), pick([C1, C2, null]), NOW - 90 + i * 10, chance(0.3) ? pick(['review-1', 'review-2']) : null));
    }
    const cand = pick([C1, C1, C2, C2, null]);
    const f = F0({ lock: { state: pick(['free', 'free', 'free', 'held', 'malformed', 'foreign']), reason: 'l' }, attempts, dispatches, unbound, blockers,
      redPending: chance(0.1) ? ['a'] : [], work: nodeState === 'pending', budgetStop: chance(0.05), candidate: { id: cand, reason: cand ? undefined : 'git failed' }, gates });
    return { S, f };
  };
}

test('property fuzz [N22] [N23] [N24] [N28] [N29] [N30] [N31]: 20,000 seeded random record sets hold I1-I6 against the independent oracle', () => {
  const gen = generator(12345);
  const fails = [], actions = new Set();
  for (let i = 0; i < 20000; i++) {
    const { S, f } = gen();
    const a = derive(S, f).next_action;
    actions.add(a.action);
    for (const v of check(S, f, a)) fails.push(`#${i}: ${v}`);
  }
  assert.ok(actions.size >= 10, `the fuzz reaches many answers (${[...actions].join(', ')})`);
  assert.deepEqual(fails.slice(0, 40), [], `${fails.length} violations`);
});
