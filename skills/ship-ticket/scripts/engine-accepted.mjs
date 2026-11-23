#!/usr/bin/env node
/**
 * S-23-min lite: accepted-view and the happy-path `next` step for a ship-ticket engine run. READ-ONLY:
 * it never takes the engine lock, never calls resume, drive, gate, mark or init, and writes no file.
 *
 * CLI: engine-accepted.mjs view|next --repo <dir> --ticket <key> --run-id <id> [--last <drive output JSON file>]
 *   view: { schema, ticket, run_id, candidate, last, blockers, phases[], gates, facts }   exit 0
 *   next: { schema, phase, action: run|dispatch|stop, command, role, reason, evidence, code?, stop_class?, facts? }
 *         exit 0 for run/dispatch, 2 for stop; 1 on a usage error (stderr `engine-accepted: <message>`).
 *
 * What it reads, in this order: the engine's own read-only `status` (its load() guards and its composed
 * judgments), the raw state JSON (status omits the review chain, freeze, ship_ready, local_proof, security and
 * events), the engine log (the GATE events' candidate_id, joined by event_id `gate-<run>-<seq>`, or the
 * undelivered outbox), and the current candidate from the engine's own `baseCandidate`.
 *
 * Acceptance per phase, for the current candidate X:
 *   INIT, BUILD, RED, PROVE  are never durable: `status` runs no binding check and does not see pre-freeze
 *     drift, RED binds its baseline and is re-validated only inside drive. They are `unknown` unless the
 *     session passes the JSON its last `run-engine.mjs drive` printed (--last). That output is used in this
 *     invocation only, is never persisted, must match the state (ticket, run, node and repair states), and
 *     can only ADVANCE: the next effectful gate re-verifies everything anyway. INIT needs no binding
 *     judgment in it; BUILD/RED/PROVE need `outcome: done` and no judgment.
 *   REASSESS (policy 2)  `not_accepted` when S.security.reassessed is absent or names another candidate or
 *     plan digest; otherwise `unknown` (its catalog digest and addendum set are read only inside the gate).
 *   REVIEW  the LAST review-chain record is an original or confirmation with outcome PASS on X and the
 *     freeze is X. An ok:true review_terminal or an accepted FAIL original is never acceptance.
 *   SHIP_READY  the LATEST ship-ready GATE note (by seq) is ok:true AND S.ship_ready, S.local_proof and the
 *     accepted review all name X. The SHIP_READY note is never the key (it precedes its GATE note, and a
 *     repeated success writes none).
 *
 * Repeat-no-progress, for the gate `next` would name: key = (candidate_id, gate, code, subject). Two
 * consecutive refusals of that gate with the same key and no progress record between them STOP, and the
 * stop is sticky until the gate itself records an acceptance. The subject is the run for ship-ready and
 * reassess, the audit record's review_execution / unit for review / unit-review, else unavailable ('*',
 * matches any). A refusal whose candidate cannot be joined, or is null, STOPs at once.
 *
 * No state, event, policy row, refusal-class table, proposal record or resolver is added.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntrypoint } from './harness.mjs';
import { status } from './run-engine.mjs';
import { gitPath } from './engine-io.mjs';
import { baseCandidate } from './engine-base-read.mjs';
import { securityOn } from './engine-dag.mjs';
import { LIVE } from './engine-quiesce.mjs';

export const VIEW_SCHEMA = 'ship-ticket-accepted-view-v1';
export const NEXT_SCHEMA = 'ship-ticket-next-v1';
export const PHASES = ['INIT', 'BUILD', 'RED', 'PROVE', 'REASSESS', 'REVIEW', 'SHIP_READY'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Judgments only the binding check emits (run-engine.mjs verifyBinding): approval or security owner-class. */
const BINDING = new Set(['run_mismatch', 'approval_mismatch', 'dag_mismatch', 'run_state_malformed', 'security_policy_required', 'security_reapproval']);
/** Gate codes that record the gate's own acceptance (review_terminal is ok:true but never one). */
const ACCEPT_CODES = new Set(['red_accepted', 'review_accepted', 'ship_ready', 'reassessed', 'unit_review_accepted']);
/** Event types that are progress between two refusals; every other type (RESUME, LOCAL_PROOF, ok:false GATE, ...) is not. */
const PROGRESS = new Set(['DISPATCH', 'REPAIR_RECORDED', 'RED_ACCEPTED', 'RED_RESTORED', 'UNIT_CHECKED', 'UNIT_REVIEWED',
  'UNIT_REPAIR_RECORDED', 'SECURITY_REASSESSED', 'MARK', 'REBIND', 'ADOPTED', 'SHIP_READY']);
const SENTINEL = '__s23min_line_sentinel__';

// ---------------------------------------------------------------------------- evidence

/** Locator for records of the state file: its line, when the file is exactly the engine's serialization. */
function stateLocator(file, raw, S) {
  const formatted = typeof raw === 'string' && raw === JSON.stringify(S, null, 1) + '\n';
  return (path, value, extra = {}) => {
    let line = null;
    if (formatted) {
      const clone = structuredClone(S);
      let o = clone;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)] = SENTINEL;
      line = JSON.stringify(clone, null, 1).split('\n').findIndex(l => l.includes(SENTINEL)) + 1 || null;
    }
    return { source: 'state', file, line, at: line ? `${file}:${line}` : file, pointer: '/' + path.join('/'), value, ...extra };
  };
}

/** GATE events by event_id: engine.jsonl rows (with their line) and undelivered outbox rows. */
function gateIndex(logText, S, logFile) {
  const ix = new Map();
  (logText ?? '').split('\n').forEach((l, i) => {
    let e; try { e = JSON.parse(l); } catch { return; }
    if (e?.event === 'GATE' && typeof e.event_id === 'string') ix.set(e.event_id, { candidate_id: e.candidate_id ?? null, at: `${logFile}:${i + 1}` });
  });
  (S.outbox ?? []).forEach((e, i) => {
    if (e?.event === 'GATE' && typeof e.event_id === 'string' && !ix.has(e.event_id)) ix.set(e.event_id, { candidate_id: e.candidate_id ?? null, at: `outbox/${i}` });
  });
  return ix;
}

// ---------------------------------------------------------------------------- --last (a drive output)

/** Whether `last` is a drive output of this run that still matches the state; never trusted beyond this call. */
function lastDrive(last, S) {
  if (!last) return { usable: false, reason: 'no --last given' };
  if (last.error) return { usable: false, file: last.file, reason: last.error };
  const d = last.value;
  const no = (reason) => ({ usable: false, file: last.file, reason });
  if (!d || typeof d !== 'object' || d.schema !== 'ship-ticket-engine-status-v1' || !['done', 'waiting', 'judgment'].includes(d.outcome))
    return no('not a run-engine.mjs drive output (a drive output carries `outcome`; status and resume outputs do not)');
  if (d.ticket !== S.ticket || d.run_id !== S.run_id) return no(`drive output of ${d.ticket}/${d.run_id}, not ${S.ticket}/${S.run_id}`);
  const ids = Object.keys(S.nodes ?? {});
  if (JSON.stringify(Object.keys(d.nodes ?? {}).sort()) !== JSON.stringify([...ids].sort())) return no('its node set differs from the state');
  const moved = ids.filter(id => d.nodes[id]?.state !== S.nodes[id].state);
  if (moved.length) return no(`node state changed since that drive: ${moved.join(', ')}`);
  const rep = (rs) => JSON.stringify((rs ?? []).map(r => [r.id, r.state]));
  if (rep(d.repairs) !== rep(S.repairs)) return no('repair states changed since that drive');
  const judgments = Array.isArray(d.judgments) ? d.judgments : [];
  return { usable: true, file: last.file, outcome: d.outcome, judgments: judgments.map(j => ({ code: j.code, node: j.node ?? null })) };
}

// ---------------------------------------------------------------------------- phases

const done = (n) => ['done', 'cancelled'].includes(n.state);
const P = (phase, state, reason, evidence = [], extra = {}) => ({ phase, state, reason, evidence, ...extra });

function phases(R) {
  const { S, X, at, L } = R;
  const lastEv = L.usable ? [{ source: 'last', file: L.file, pointer: '/outcome', value: L.outcome }] : [];
  const binding = L.usable ? L.judgments.filter(j => BINDING.has(j.code)) : [];
  const settled = L.usable && L.outcome === 'done' && L.judgments.length === 0;
  const UNSETTLED = 'pass the JSON of the latest `run-engine.mjs drive` with --last; its result is not persisted';
  const out = [];

  out.push(binding.length ? P('INIT', 'not_accepted', `the drive output reports a binding judgment: ${binding.map(j => j.code).join(', ')}`, lastEv, { code: binding[0].code })
    : L.usable ? P('INIT', 'accepted', 'the drive output re-verified the approval binding (no binding judgment)', [at(['run_id'], S.run_id), ...lastEv])
    : P('INIT', 'unknown', `the binding (plan narrative, DAG digest, trusted START) is verified only inside drive/resume/gate; status does not run it (${L.reason}); ${UNSETTLED}`, [at(['run_id'], S.run_id)]));

  const group = (phase, ids, what) => {
    if (!ids.length) return P(phase, 'not_applicable', `no ${what} in the bound DAG`);
    const open = ids.filter(id => !done(S.nodes[id]));
    if (open.length) return P(phase, 'not_accepted', `${what} not finished: ${open.join(', ')}`, open.map(id => at(['nodes', id, 'state'], S.nodes[id].state)), { code: 'nodes_unfinished' });
    const ev = ids.map(id => at(['nodes', id, 'state'], S.nodes[id].state));
    return settled ? P(phase, 'accepted', `every ${what.replace(/s$/, '')} is done and the drive output ended done with no judgment`, [...ev, ...lastEv])
      : P(phase, 'unknown', `state says done, but drift before the freeze is detected only by drive (status never marks it); ${L.usable ? `the drive output ended ${L.outcome}` : L.reason}; ${UNSETTLED}`, ev);
  };
  const ids = Object.keys(S.nodes);
  out.push(group('BUILD', ids.filter(id => (S.nodes[id].phase ?? 'BUILD') === 'BUILD'), 'BUILD nodes'));

  const redNodes = ids.filter(id => (S.nodes[id].redSpecs ?? []).length);
  const pending = R.statusOut.red_pending ?? [];
  if (!redNodes.length) out.push(P('RED', 'not_applicable', 'no node declares redSpecs'));
  else if (pending.length) out.push(P('RED', 'not_accepted', `done RED-bearing node(s) without accepted RED: ${pending.join(', ')}`, pending.map(id => at(['nodes', id, 'state'], S.nodes[id].state)), { code: 'red_pending', nodes: pending }));
  else if (redNodes.some(id => !S.gates?.red?.[id])) out.push(P('RED', 'not_accepted', 'a RED-bearing node is not built yet', [], { code: 'red_unbuilt' }));
  else if (Object.keys(S.gates?.red_addendum ?? {}).length) out.push(P('RED', 'unknown', 'security-addendum RED slots are not read by this view', []));
  else {
    const ev = redNodes.map(id => at(['gates', 'red', id, 'baseline_candidate'], S.gates.red[id].baseline_candidate, { seq: S.gates.red[id].seq }));
    out.push(settled ? P('RED', 'accepted', 'every RED slot is recorded and the drive output (which re-validates RED) ended done', [...ev, ...lastEv])
      : P('RED', 'unknown', `RED binds its baseline candidate, not X, and is re-validated only inside drive (refreshRed); ${UNSETTLED}`, ev));
  }
  out.push(group('PROVE', ids.filter(id => ['PROVE', 'SHIP'].includes(S.nodes[id].phase)), 'PROVE/SHIP-phase nodes'));

  if (!securityOn(S)) out.push(P('REASSESS', 'not_applicable', 'policy 1 run: no security reassessment'));
  else {
    const r = S.security?.reassessed;
    if (!r || r.candidate_id !== X || r.plan_digest !== S.plan_digest) out.push(P('REASSESS', 'not_accepted', r ? 'the recorded reassessment names another candidate or plan digest' : 'no reassessment recorded',
      r ? [at(['security', 'reassessed', 'candidate_id'], r.candidate_id)] : [], { code: 'reassess_owed' }));
    else out.push(P('REASSESS', 'unknown', 'candidate and plan digest match, but the catalog digest and the effective addendum set are read only inside the gate',
      [at(['security', 'reassessed', 'candidate_id'], r.candidate_id)]));
  }

  out.push(review(R));
  out.push(shipReady(R, out.at(-1)));
  return out;
}

/** REVIEW from the review chain only (never by joining GATE notes to chain records). */
function review({ S, X, at }) {
  const chain = S.review_chain ?? [], i = chain.length - 1, last = chain[i];
  if (!last) return P('REVIEW', 'not_accepted', 'no review recorded', [], { code: 'review_owed' });
  const ev = [at(['review_chain', i, 'kind'], last.kind), ...(last.outcome !== undefined ? [at(['review_chain', i, 'outcome'], last.outcome)] : []),
    ...(last.candidate_id !== undefined ? [at(['review_chain', i, 'candidate_id'], last.candidate_id)] : [])];
  if (['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS') {
    if (last.candidate_id === X && S.freeze?.candidate === X) return P('REVIEW', 'accepted', `${last.kind} PASS on the current candidate`, [...ev, at(['freeze', 'candidate'], S.freeze.candidate)]);
    return P('REVIEW', 'not_accepted', `the accepted review is of ${last.candidate_id}, the current candidate is ${X}: a new review needs an owner RETRY`, ev, { code: 'candidate_moved' });
  }
  if (last.kind === 'original' && last.outcome === 'FAIL') {
    if (last.overflow) return P('REVIEW', 'not_accepted', 'the original FAIL is terminal (overflow): only an owner RETRY continues', ev, { code: 'review_terminal' });
    return P('REVIEW', 'not_accepted', 'an accepted FAIL original: its finding-bound repair is owed', ev, { code: 'repair_owed' });
  }
  if (last.kind === 'repair') return P('REVIEW', 'not_accepted', 'the repair is recorded: a targeted confirmation is owed', ev, { code: 'confirmation_owed' });
  if (last.kind === 'confirmation') return P('REVIEW', 'not_accepted', 'the confirmation FAILed: only an owner RETRY continues', ev, { code: 'confirmation_fail' });
  return P('REVIEW', 'not_accepted', `unrecognized last chain record ${last.kind}`, ev, { code: 'chain_unrecognized' });
}

/** SHIP_READY from the LATEST ship-ready GATE note plus the records that must name X. */
function shipReady({ S, X, at }, rev) {
  const k = (S.events ?? []).map((e, idx) => [e, idx]).filter(([e]) => e.type === 'GATE' && e.gate === 'ship-ready').at(-1);
  if (!k) return P('SHIP_READY', 'not_accepted', 'ship-ready has not run', [], { code: 'ship_ready_owed' });
  const [note, idx] = k;
  const ev = [at(['events', idx, 'ok'], note.ok, { seq: note.seq })];
  if (note.ok !== true) return P('SHIP_READY', 'not_accepted', `the latest ship-ready decision refused: ${note.code}`, ev, { code: note.code });
  const ok = S.ship_ready?.candidate_id === X && S.local_proof?.candidate_id === X && rev.state === 'accepted';
  if (!ok) return P('SHIP_READY', 'not_accepted', 'the latest ship-ready accepted another candidate, or the review or local proof no longer names the current one', ev, { code: 'ship_ready_stale' });
  return P('SHIP_READY', 'accepted', 'the latest ship-ready decision accepted the current candidate', [...ev,
    at(['ship_ready', 'candidate_id'], S.ship_ready.candidate_id), at(['local_proof', 'candidate_id'], S.local_proof.candidate_id), ...rev.evidence]);
}

// ---------------------------------------------------------------------------- repeat-no-progress

/** The sticky repeat verdict for `gate`: null, { key, seqs } (no progress), or { unavailable } (identity). */
function repeatOf(S, gate, ix) {
  const events = S.events ?? [];
  const notes = events.filter(e => e.type === 'GATE' && e.gate === gate);
  const from = notes.findLastIndex(e => e.ok === true && ACCEPT_CODES.has(e.code)) + 1;
  const keyOf = (e) => {
    const row = ix.get(`gate-${S.run_id}-${e.seq}`);
    const subject = gate === 'ship-ready' || gate === 'reassess' ? 'run'
      : typeof e.review_execution === 'string' && gate === 'review' ? e.review_execution
      : typeof e.unit === 'string' && gate === 'unit-review' ? e.unit : '*';
    return { candidate_id: row?.candidate_id ?? null, gate, code: e.code, subject, seq: e.seq, at: row?.at ?? null };
  };
  const window = notes.slice(from);
  for (const e of window) if (e.ok === false && !keyOf(e).candidate_id) return { unavailable: keyOf(e) };
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1], b = window[i];
    if (a.ok !== false || b.ok !== false) continue;
    const ka = keyOf(a), kb = keyOf(b);
    const same = ka.candidate_id === kb.candidate_id && ka.code === kb.code && (ka.subject === '*' || kb.subject === '*' || ka.subject === kb.subject);
    const progress = events.some(e => e.seq > a.seq && e.seq < b.seq && (PROGRESS.has(e.type) || (e.type === 'GATE' && e.ok === true)));
    if (same && !progress) {
      const { seq: _s, at: _a, ...key } = kb;
      return { key: { ...key, subject: ka.subject === '*' || kb.subject === '*' ? '*' : kb.subject }, seqs: [a.seq, b.seq], at: [ka.at, kb.at] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------- view

/**
 * Pure accepted-view. input: { ticket, runId, S|null, raw, statusOut, statusError?, candidate: { candidate_id, reason? },
 * logText, last: { file, value } | { file, error } | null, files: { state, log } }.
 */
export function acceptedView(input) {
  const { S, statusOut, files } = input;
  const base = { schema: VIEW_SCHEMA, ticket: input.ticket, run_id: input.runId, state_file: files.state };
  if (input.statusError?.code === 'no_state' || (!S && !input.statusError)) {
    return { ...base, exists: false, candidate: null, last: { usable: false, reason: 'no state' }, blockers: [],
      phases: PHASES.map(p => (p === 'INIT' ? P('INIT', 'not_accepted', 'no engine state: init has not run', [], { code: 'no_state' }) : P(p, 'not_accepted', 'no engine state'))), gates: {}, facts: {} };
  }
  if (input.statusError) return { ...base, exists: true, error: { code: input.statusError.code ?? 'state_unreadable', reason: input.statusError.message }, phases: [], blockers: [], gates: {}, facts: {} };
  const at = stateLocator(files.state, input.raw, S);
  const X = input.candidate?.candidate_id ?? null;
  const L = lastDrive(input.last, S);
  const blockers = [];
  const block = (code, cls, reason, evidence = [], facts = {}) => blockers.push({ code, class: cls, reason, evidence, facts });
  if (S.run_id !== input.runId) block('run_mismatch', 'owner', `the engine state belongs to run ${S.run_id}, not ${input.runId}`, [at(['run_id'], S.run_id)]);
  if ((statusOut.judgments ?? []).length) block(statusOut.judgments[0].code, 'judgment', 'the engine reports open judgment(s)', [], { judgments: statusOut.judgments.map(j => ({ code: j.code, node: j.node ?? null, reason: j.reason })) });
  if ((statusOut.authority_untrusted ?? []).length) block('authority_untrusted', 'owner', 'RUN-STATE authority line(s) appeared while work was live: the owner re-appends them', [], { lines: statusOut.authority_untrusted });
  const b = statusOut.budget;
  if (b && (b.ticket?.state === 'stop_dispatch' || b.phase?.state === 'stop_dispatch')) block('budget_spent', 'owner', 'the token budget is spent', [], { budget: b });
  else if (b && ((b.flags ?? []).length || b.ticket?.state === 'unknown' || b.phase?.state === 'unknown')) block('budget_unknown', 'unknown', 'the budget cannot be evaluated', [], { budget: b });
  const live = (S.attempts ?? []).map((a, i) => [a, i]).filter(([a]) => LIVE.includes(a.status));
  if (live.length) block('attempts_live', 'unknown', 'attempts are live or their quiescence is unproven', live.map(([a, i]) => at(['attempts', i, 'status'], a.status)));
  if (L.usable && L.outcome === 'judgment' && !L.judgments.some(j => BINDING.has(j.code))) block('drive_judgment', 'judgment', 'the drive output ended in a judgment', [{ source: 'last', file: L.file, pointer: '/outcome', value: 'judgment' }], { judgments: L.judgments });
  if ((statusOut.unit_reviews_pending ?? []).length) block('unit_review_owed', 'off_happy_path', 'unit review(s) are owed', [], { units: statusOut.unit_reviews_pending });
  if (!X) block('candidate_unavailable', 'unknown', `the current candidate cannot be computed: ${input.candidate?.reason ?? 'unknown'}`);
  const ix = gateIndex(input.logText, S, files.log);
  const runners = Object.entries(S.config?.testCommands ?? {}).filter(([, e]) => e?.format && !e.evidence).map(([k]) => k);
  return { ...base, exists: true, candidate: { id: X, ...(X ? {} : { reason: input.candidate?.reason ?? null }) }, last: L, blockers,
    phases: phases({ S, X, at, L, statusOut }),
    gates: Object.fromEntries(['red', 'reassess', 'review', 'ship-ready'].map(g => [g, repeatOf(S, g, ix)])),
    facts: { excluded_reviewers: [...new Set((S.builders ?? []).map(x => x.identity))], red_runners: runners, freeze: S.freeze?.candidate ?? null } };
}

// ---------------------------------------------------------------------------- next

const STOP_REASON = { owner: 'an owner-reserved decision', judgment: 'an open engine judgment', unknown: 'a state this tool cannot read without inference',
  off_happy_path: 'off the happy path: the orchestrator decides inside the approved plan', no_progress: 'the same refusal repeated with no progress' };

/** Pure: one step (or one STOP) from an accepted-view. */
export function nextStep(v) {
  const cmd = (name, input) => ({ script: 'run-engine.mjs', cmd: name, flags: { repo: null, ticket: v.ticket, 'run-id': v.run_id }, ...(input !== undefined ? { input } : {}) });
  const stop = (phase, code, cls, reason, evidence = [], facts = {}) => ({ schema: NEXT_SCHEMA, phase, action: 'stop', command: null, role: null,
    reason: `${STOP_REASON[cls]}: ${reason}`, evidence, code, stop_class: cls, facts });
  const go = (phase, action, command, role, reason, evidence = [], facts = {}) => ({ schema: NEXT_SCHEMA, phase, action, command, role, reason, evidence, facts });
  if (v.error) return stop(null, v.error.code, 'unknown', `the engine refused to load the state: ${v.error.reason}`);
  if (!v.exists) return go('INIT', 'run', { ...cmd('init'), flags: { ...cmd('init').flags, dag: null } }, null,
    'no engine state: init the approved plan and DAG (init itself refuses without the owner\'s START)');
  const order = ['owner', 'judgment', 'unknown', 'off_happy_path'];
  const blocker = [...v.blockers].sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class))[0];
  if (blocker) return stop(null, blocker.code, blocker.class, blocker.reason, blocker.evidence, blocker.facts);
  const gated = (phase, gate, step) => {
    const r = v.gates[gate];
    if (r?.unavailable) return stop(phase, 'identity_unavailable', 'unknown', `a ${gate} refusal (seq ${r.unavailable.seq}) has no joinable candidate_id`, [], { refusal: r.unavailable });
    if (r?.key) return stop(phase, 'no_progress', 'no_progress', `${gate} refused ${r.key.code} twice (seq ${r.seqs.join(', ')}) with no progress record between; only the gate's own acceptance clears this`, [], { key: r.key, at: r.at });
    return step;
  };
  const red = v.phases.find(x => x.phase === 'RED');
  // A drive cannot finish while RED is owed (the barrier holds the dependents), so an owed RED is what settles BUILD/PROVE then.
  const redOwed = red?.code === 'red_pending' && v.facts.red_runners.length === 1 ? cmd('gate red', { node: red.nodes[0], command: v.facts.red_runners[0] }) : null;
  for (const p of v.phases) {
    if (['accepted', 'not_applicable'].includes(p.state)) continue;
    if (p.state === 'unknown') return stop(p.phase, 'acceptance_unknown', 'unknown', `${p.phase}: ${p.reason}`, p.evidence,
      { settle_with: ['BUILD', 'PROVE'].includes(p.phase) && redOwed ? redOwed : ['INIT', 'BUILD', 'RED', 'PROVE'].includes(p.phase) ? cmd('drive') : null });
    switch (p.phase) {
      case 'INIT': return stop('INIT', p.code ?? 'init_not_accepted', 'owner', p.reason, p.evidence);
      case 'BUILD': case 'PROVE': case 'RED': {
        if (red.code === 'red_pending') {
          if (!redOwed) return stop('RED', 'red_runner_ambiguous', 'unknown', `RED is owed for ${red.nodes[0]} but the DAG has ${v.facts.red_runners.length} RED runners`, red.evidence);
          return gated('RED', 'red', go('RED', 'run', redOwed, null, `accepted RED is owed for ${red.nodes[0]} before its dependents run`, red.evidence));
        }
        return go(p.phase, 'run', cmd('drive'), 'builder', `${p.reason}: drive dispatches them through the carrier`, p.evidence);
      }
      case 'REASSESS': return gated('REASSESS', 'reassess', go('REASSESS', 'run', cmd('gate reassess', { classifications: [], surfaces: [] }), null,
        `${p.reason}: run gate reassess on the current candidate (classifications and surfaces from the change)`, p.evidence));
      case 'REVIEW':
        if (p.code === 'review_owed') return gated('REVIEW', 'review', go('REVIEW', 'dispatch', cmd('gate review'), 'reviewer',
          'dispatch the primary reviewer and the second opinion on the frozen candidate, then record their artifacts with gate review (kind original)', p.evidence,
          { candidate_id: v.candidate.id, excluded_reviewers: v.facts.excluded_reviewers }));
        return stop('REVIEW', p.code, ['repair_owed', 'confirmation_owed'].includes(p.code) ? 'off_happy_path' : p.code === 'chain_unrecognized' ? 'unknown' : 'owner', p.reason, p.evidence);
      case 'SHIP_READY': return gated('SHIP_READY', 'ship-ready', go('SHIP_READY', 'run', cmd('gate ship-ready', {}), null, p.reason, p.evidence));
      default: return stop(p.phase, 'unlisted_phase', 'unknown', p.reason, p.evidence);
    }
  }
  return stop('owner_publish', 'owner_publish', 'owner', 'SHIP_READY is accepted for the current candidate: push, PR, CI and merge are the owner\'s (or the opted-in auto-merge)',
    v.phases.find(x => x.phase === 'SHIP_READY').evidence);
}

// ---------------------------------------------------------------------------- I/O

/** Read the run (status first, then the raw state, the engine log and the candidate) and return the accepted-view. */
export async function readRun({ repoRoot, ticket, runId, lastFile }) {
  if (!SAFE_ID.test(ticket ?? '') || !SAFE_ID.test(runId ?? '') || typeof repoRoot !== 'string') throw new Error('repo, a safe ticket and run id are required');
  const files = { state: gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.state.json`), log: gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.engine.jsonl`) };
  const input = { ticket, runId, files, S: null, raw: null, statusOut: null, logText: '', candidate: null, last: null };
  try { input.statusOut = await status({ repoRoot, ticket, runId }); } catch (e) { input.statusError = { code: e.code ?? 'status_failed', message: e.message }; }
  if (input.statusError) return acceptedView(input);
  input.raw = readFileSync(files.state, 'utf8');
  input.S = JSON.parse(input.raw);
  input.logText = existsSync(files.log) ? readFileSync(files.log, 'utf8') : '';
  input.candidate = baseCandidate(repoRoot, input.S, input.S.pinned_exclusions ?? []);
  if (lastFile !== undefined) {
    try { input.last = { file: resolve(lastFile), value: JSON.parse(readFileSync(lastFile, 'utf8')) }; }
    catch (e) { input.last = { file: resolve(lastFile), error: `unreadable --last: ${e.message}` }; }
  }
  return acceptedView(input);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!k || rest[i + 1] === undefined || Object.hasOwn(flags, k) || !['repo', 'ticket', 'run-id', 'last'].includes(k)) throw new Error(`bad, unknown or repeated flag: ${rest[i]}`);
    flags[k] = rest[i + 1];
  }
  if (!['view', 'next'].includes(cmd) || !flags.repo || !flags.ticket || !flags['run-id'])
    throw new Error('usage: engine-accepted.mjs view|next --repo <dir> --ticket <key> --run-id <id> [--last <drive output JSON file>]');
  const repoRoot = resolve(flags.repo);
  const v = await readRun({ repoRoot, ticket: flags.ticket, runId: flags['run-id'], lastFile: flags.last });
  if (cmd === 'view') return { out: v, code: 0 };
  const n = nextStep(v);
  if (n.command) n.command.flags.repo = repoRoot;
  return { out: n, code: n.action === 'stop' ? 2 : 0 };
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(({ out, code }) => { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exitCode = code; })
    .catch(e => { process.stderr.write(`engine-accepted: ${e.message}\n`); process.exitCode = 1; });
}
