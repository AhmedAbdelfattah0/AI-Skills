#!/usr/bin/env node
/**
 * S-23-min lite: accepted-view and the happy-path `next` step for a ship-ticket engine run. READ-ONLY:
 * it never takes the engine lock, never calls resume, drive, gate, mark or init, and writes no file.
 *
 * CLI: engine-accepted.mjs view|next --repo <dir> --ticket <key> --run-id <id> [--last <drive output JSON file>]
 *   view: { schema, ticket, run_id, candidate, last, freshness, blockers, phases[], gates, facts }   exit 0
 *   next: { schema, phase, action: run|dispatch|stop, command, role, reason, evidence, code?, stop_class?, facts? }
 *         exit 0 for run/dispatch, 2 for stop; 1 on a usage error (stderr `engine-accepted: <message>`).
 *   A stop with code `acceptance_unknown` carries `facts.settle_with`: the existing engine command whose output
 *   settles that phase (`drive`, or `gate red` while RED is owed), to be run and passed back with --last. It is
 *   null when no command can settle it (security-addendum RED slots): then it is a real stop. A moved binding
 *   (plan narrative or DAG bytes) is never `acceptance_unknown`: it is the owner stop approval_mismatch /
 *   dag_mismatch at INIT, read directly or from a drive output's binding judgment. Every other stop is a real
 *   stop for the orchestrator or the owner (`stop_class`).
 *
 * What it reads: the raw state, the engine's own read-only `status` (its load() guards and composed judgments),
 * the raw state again (a state that moved during the read is refused as `state_moved`), the engine log (each
 * GATE event's candidate_id, joined by event_id `gate-<run>-<seq>`, or the undelivered outbox), the current
 * candidate (the engine's `baseCandidate`), and the freshness of the approval binding: the plan narrative digest
 * vs S.plan_digest, the DAG bytes vs S.dag_digest, and every done node's fingerprints vs its recorded ones (the
 * engine's own drift predicate). On a policy-2 run also the installed catalog digest and the trusted addenda.
 *
 * Acceptance per phase, for the current candidate X:
 *   INIT, BUILD, RED, PROVE  are never durable. They are `unknown` unless --last is the JSON of a
 *     `run-engine.mjs drive` of this run that still matches the state (node and repair states) AND the binding
 *     and node files are still fresh (above). Used in this invocation only, never persisted. INIT needs no
 *     binding judgment in it; BUILD/RED/PROVE need `outcome: done` and no judgment.
 *   REASSESS (policy 2)  accepted only when S.security.reassessed equals the whole current tuple (X, the plan
 *     digest, the installed catalog digest, the trusted addendum ids). The view reads S.authority as last
 *     observed by an engine command; a RUN-STATE line appended since is not seen, and the gate then refuses
 *     reassess_stale at effect (fails safe).
 *   REVIEW  the LAST review-chain record is an original or confirmation with outcome PASS on X and the
 *     freeze is X. An ok:true review_terminal or an accepted FAIL original is never acceptance.
 *   SHIP_READY  the LATEST ship-ready GATE note (by seq) is ok:true AND S.ship_ready, S.local_proof and the
 *     accepted review all name X. The SHIP_READY note is never the key.
 *
 * Refusals: `next` never re-names a gate that refused since its own last acceptance. It STOPs with the refusal's
 * key (candidate_id, gate, code, subject: the run for ship-ready and reassess, else '*': a caller-chosen
 * review_execution is never trusted as identity). The code is `no_progress` when two consecutive refusals share
 * the key with no progress record between them, `identity_unavailable` when a refusal's candidate cannot be
 * joined or is null, else `gate_refused`. Only that gate's own acceptance clears it.
 *
 * No state, event, policy row, refusal-class table, proposal record or resolver is added.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntrypoint } from './harness.mjs';
import { status } from './run-engine.mjs';
import { gitPath, fingerprints } from './engine-io.mjs';
import { enginePaths } from './lib/run-placement.mjs';
import { baseCandidate } from './engine-base-read.mjs';
import { securityOn, sha, planNarrativeDigest } from './engine-dag.mjs';
import { securityPlan } from './engine-gates.mjs';
import { securityEvents } from './engine-authority.mjs';
import { LIVE } from './engine-quiesce.mjs';

export const VIEW_SCHEMA = 'ship-ticket-accepted-view-v1';
export const NEXT_SCHEMA = 'ship-ticket-next-v1';
export const PHASES = ['INIT', 'BUILD', 'RED', 'PROVE', 'REASSESS', 'REVIEW', 'SHIP_READY'];
export const MAX_LAST_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Judgments only the binding check emits (run-engine.mjs verifyBinding): approval or security owner-class. */
const BINDING = new Set(['run_mismatch', 'approval_mismatch', 'dag_mismatch', 'run_state_malformed', 'security_policy_required', 'security_reapproval']);
/** Gate codes that record the gate's own acceptance (review_terminal is ok:true but never one). */
const ACCEPT_CODES = new Set(['red_accepted', 'review_accepted', 'ship_ready', 'reassessed', 'unit_review_accepted']);
/** Event types that are progress between two refusals; every other type (RESUME, LOCAL_PROOF, ok:false GATE, ...) is not. */
const PROGRESS = new Set(['DISPATCH', 'REPAIR_RECORDED', 'RED_ACCEPTED', 'RED_RESTORED', 'UNIT_CHECKED', 'UNIT_REVIEWED',
  'UNIT_REPAIR_RECORDED', 'SECURITY_REASSESSED', 'MARK', 'REBIND', 'ADOPTED', 'SHIP_READY']);
const SENTINEL = '__s23min_line_sentinel__';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

/** Whether `last` is a well-formed drive output of this run that still matches the state and a fresh binding; never trusted beyond this call. */
function lastDrive(last, S, freshness) {
  if (!last) return { usable: false, reason: 'no --last given' };
  if (last.error) return { usable: false, file: last.file, reason: last.error };
  const d = last.value;
  const no = (reason) => ({ usable: false, file: last.file, reason });
  if (!isObj(d) || d.schema !== 'ship-ticket-engine-status-v1' || !['done', 'waiting', 'judgment'].includes(d.outcome))
    return no('not a run-engine.mjs drive output (a drive output carries `outcome` done|waiting|judgment)');
  if (Object.hasOwn(d, 'test_kinds') || Object.hasOwn(d, 'base')) return no('carries status-only keys (test_kinds/base): a status output, not a drive output');
  if (d.ticket !== S.ticket || d.run_id !== S.run_id) return no(`drive output of ${d.ticket}/${d.run_id}, not ${S.ticket}/${S.run_id}`);
  if (!isObj(d.nodes) || !Object.values(d.nodes).every(n => isObj(n) && typeof n.state === 'string')) return no('nodes is not a map of { state }');
  if (!Array.isArray(d.repairs) || !d.repairs.every(r => isObj(r) && typeof r.id === 'string' && typeof r.state === 'string')) return no('repairs is not a list of { id, state }');
  if (!Array.isArray(d.judgments) || !d.judgments.every(j => isObj(j) && typeof j.code === 'string')) return no('judgments is not a list of { code }');
  const ids = Object.keys(S.nodes ?? {});
  if (JSON.stringify(Object.keys(d.nodes).sort()) !== JSON.stringify([...ids].sort())) return no('its node set differs from the state');
  const moved = ids.filter(id => d.nodes[id].state !== S.nodes[id].state);
  if (moved.length) return no(`node state changed since that drive: ${moved.join(', ')}`);
  const rep = (rs) => JSON.stringify((rs ?? []).map(r => [r.id, r.state]));
  if (rep(d.repairs) !== rep(S.repairs)) return no('repair states changed since that drive');
  // the outcome must be the one drive computes from its own fields (run-engine.mjs drive)
  const finished = Object.values(d.nodes).every(n => ['done', 'cancelled'].includes(n.state)) && d.repairs.every(r => !['pending', 'running'].includes(r.state));
  if ((d.outcome === 'judgment') !== (d.judgments.length > 0) || (d.outcome === 'done' && !finished)) return no(`outcome ${d.outcome} is inconsistent with its judgments, nodes and repairs`);
  // A refusal that carries a binding judgment is taken as is, never as stale: drive returns it before doing any work
  // (run-engine.mjs drive -> verifyBinding), and it can only make next STOP (INIT not_accepted, owner), never accept anything.
  if (d.judgments.some(j => BINDING.has(j.code))) return { usable: true, file: last.file, outcome: d.outcome, judgments: d.judgments.map(j => ({ code: j.code, node: typeof j.node === 'string' ? j.node : null })) };
  const stale = freshnessProblems(freshness);
  if (stale.length) return no(`changed since: ${stale.join('; ')}`);
  return { usable: true, file: last.file, outcome: d.outcome, judgments: d.judgments.map(j => ({ code: j.code, node: typeof j.node === 'string' ? j.node : null })) };
}

/** What moved since the binding and the node fingerprints were recorded (empty when fresh; unread counts as moved). */
function freshnessProblems(f) {
  if (!isObj(f)) return ['binding freshness not read'];
  return [...(f.error ? [f.error] : []), ...(f.plan === true ? [] : ['the plan narrative no longer matches the bound plan digest']),
    ...(f.dag === true ? [] : ['the DAG bytes no longer match the bound DAG digest']),
    ...((f.drifted ?? []).length ? [`node input/output fingerprints drifted: ${f.drifted.join(', ')}`] : [])];
}

// ---------------------------------------------------------------------------- phases

const done = (n) => ['done', 'cancelled'].includes(n.state);
const P = (phase, state, reason, evidence = [], extra = {}) => ({ phase, state, reason, evidence, ...extra });

function phases(R) {
  const { S, X, at, L } = R;
  const lastEv = L.usable ? [{ source: 'last', file: L.file, pointer: '/outcome', value: L.outcome }] : [];
  const binding = L.usable ? L.judgments.filter(j => BINDING.has(j.code)) : [];
  const settled = L.usable && L.outcome === 'done' && L.judgments.length === 0;
  const UNSETTLED = 'pass the JSON of a fresh `run-engine.mjs drive` with --last; its result is not persisted';
  const out = [];

  const f = isObj(R.freshness) ? R.freshness : {};
  const moved = [...(f.plan === false ? ['approval_mismatch'] : []), ...(f.dag === false ? ['dag_mismatch'] : [])];
  out.push(binding.length ? P('INIT', 'not_accepted', `the drive output reports a binding judgment: ${binding.map(j => j.code).join(', ')}`, lastEv, { code: binding[0].code })
    : moved.length ? P('INIT', 'not_accepted', `the approval binding moved: ${moved.join(', ')} (plan narrative or DAG bytes differ from the digests bound at init)`, [at(['plan_digest'], S.plan_digest), at(['dag_digest'], S.dag_digest)], { code: moved[0] })
    : L.usable ? P('INIT', 'accepted', 'a fresh drive output re-verified the approval binding (no binding judgment)', [at(['run_id'], S.run_id), ...lastEv])
    : P('INIT', 'unknown', `the binding (plan narrative, DAG digest, trusted START) is verified only inside drive/resume/gate (${L.reason}); ${UNSETTLED}`, [at(['run_id'], S.run_id)], { settle: 'drive' }));

  const group = (phase, ids, what) => {
    if (!ids.length) return P(phase, 'not_applicable', `no ${what} in the bound DAG`);
    const open = ids.filter(id => !done(S.nodes[id]));
    if (open.length) return P(phase, 'not_accepted', `${what} not finished: ${open.join(', ')}`, open.map(id => at(['nodes', id, 'state'], S.nodes[id].state)), { code: 'nodes_unfinished' });
    const ev = ids.map(id => at(['nodes', id, 'state'], S.nodes[id].state));
    return settled ? P(phase, 'accepted', `every ${what.replace(/s$/, '')} is done and a fresh drive output ended done with no judgment`, [...ev, ...lastEv])
      : P(phase, 'unknown', `state says done, but drift before the freeze is detected only by drive; ${L.usable ? `the drive output ended ${L.outcome}` : L.reason}; ${UNSETTLED}`, ev, { settle: 'drive' });
  };
  const ids = Object.keys(S.nodes);
  out.push(group('BUILD', ids.filter(id => (S.nodes[id].phase ?? 'BUILD') === 'BUILD'), 'BUILD nodes'));

  // a cancelled node owes no RED (engine-attempts.mjs redPending counts done nodes only)
  const redNodes = ids.filter(id => (S.nodes[id].redSpecs ?? []).length && S.nodes[id].state !== 'cancelled');
  const pending = R.statusOut.red_pending ?? [];
  if (!redNodes.length) out.push(P('RED', 'not_applicable', 'no live node declares redSpecs'));
  else if (pending.length) out.push(P('RED', 'not_accepted', `done RED-bearing node(s) without accepted RED: ${pending.join(', ')}`, pending.map(id => at(['nodes', id, 'state'], S.nodes[id].state)), { code: 'red_pending', nodes: pending }));
  else if (redNodes.some(id => !S.gates?.red?.[id])) out.push(P('RED', 'not_accepted', 'a RED-bearing node is not built yet', [], { code: 'red_unbuilt' }));
  else if (Object.keys(S.gates?.red_addendum ?? {}).length) out.push(P('RED', 'unknown', 'security-addendum RED slots are not read by this view; no drive output settles them', [], { settle: null }));
  else {
    const ev = redNodes.map(id => at(['gates', 'red', id, 'baseline_candidate'], S.gates.red[id].baseline_candidate, { seq: S.gates.red[id].seq }));
    out.push(settled ? P('RED', 'accepted', 'every RED slot is recorded and a fresh drive output (which re-validates RED) ended done', [...ev, ...lastEv])
      : P('RED', 'unknown', `RED binds its baseline candidate, not X, and is re-validated only inside drive (refreshRed); ${UNSETTLED}`, ev, { settle: 'drive' }));
  }
  out.push(group('PROVE', ids.filter(id => ['PROVE', 'SHIP'].includes(S.nodes[id].phase)), 'PROVE/SHIP-phase nodes'));
  out.push(reassess(R));
  out.push(review(R));
  out.push(shipReady(R, out.at(-1)));
  return out;
}

/** REASSESS: the recorded tuple must equal the whole current one (engine-gates.mjs sameTuple). */
function reassess({ S, X, at, sec }) {
  if (!securityOn(S)) return P('REASSESS', 'not_applicable', 'policy 1 run: no security reassessment');
  if (!sec || sec.error) return P('REASSESS', 'not_accepted', `the current security tuple cannot be read: ${sec?.error ?? 'not read'}`, [], { code: 'catalog_unavailable' });
  const r = S.security?.reassessed;
  const want = { candidate_id: X, plan_digest: S.plan_digest, catalog_digest: sec.catalog_digest, addendum_set: sec.addendum_set };
  if (!r) return P('REASSESS', 'not_accepted', 'no reassessment recorded', [], { code: 'reassess_owed', want });
  const moved = Object.keys(want).filter(k => JSON.stringify(r[k]) !== JSON.stringify(want[k]));
  const ev = [at(['security', 'reassessed', 'candidate_id'], r.candidate_id), at(['security', 'reassessed', 'catalog_digest'], r.catalog_digest)];
  if (moved.length) return P('REASSESS', 'not_accepted', `changed since the reassessment: ${moved.join(', ')}`, ev, { code: 'reassess_owed', want });
  return P('REASSESS', 'accepted', 'the recorded reassessment is of the current candidate, plan, catalog and addendum set', ev);
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
    if (!(last.fix_findings ?? []).length) return P('REVIEW', 'not_accepted', 'the original FAILed with no finding to fix, so no repair opened: only an owner RETRY continues', ev, { code: 'review_fail_no_repair' });
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

// ---------------------------------------------------------------------------- refusals since the gate's last acceptance

/** null when `gate` has no refusal since its own last acceptance; else { kind: identity_unavailable | no_progress | refused, key, at }. */
function refusalOf(S, gate, ix) {
  const events = S.events ?? [];
  const notes = events.filter(e => e.type === 'GATE' && e.gate === gate);
  // S2: a host_held gate result is pending work (a capacity wait), not a refusal: it never counts toward refused/no_progress.
  const window = notes.slice(notes.findLastIndex(e => e.ok === true && ACCEPT_CODES.has(e.code)) + 1).filter(e => e.code !== 'host_held');
  const refusals = window.filter(e => e.ok === false);
  if (!refusals.length) return null;
  const subject = gate === 'ship-ready' || gate === 'reassess' ? 'run' : '*';
  const keyOf = (e) => {
    const row = ix.get(`gate-${S.run_id}-${e.seq}`);
    return { key: { candidate_id: row?.candidate_id ?? null, gate, code: e.code, subject }, seq: e.seq, at: row?.at ?? null };
  };
  const unjoined = refusals.map(keyOf).find(k => !k.key.candidate_id);
  if (unjoined) return { kind: 'identity_unavailable', ...unjoined };
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1], b = window[i];
    if (a.ok !== false || b.ok !== false) continue;
    const ka = keyOf(a), kb = keyOf(b);
    const same = JSON.stringify(ka.key) === JSON.stringify(kb.key);
    const progress = events.some(e => e.seq > a.seq && e.seq < b.seq && (PROGRESS.has(e.type) || (e.type === 'GATE' && e.ok === true)));
    if (same && !progress) return { kind: 'no_progress', key: kb.key, seqs: [a.seq, b.seq], at: [ka.at, kb.at] };
  }
  const last = keyOf(refusals.at(-1));
  return { kind: 'refused', key: last.key, seqs: [last.seq], at: [last.at] };
}

// ---------------------------------------------------------------------------- view

/**
 * Pure accepted-view. input: { ticket, runId, S|null, raw, statusOut, statusError?, candidate: { candidate_id, reason? },
 * logText, last: { file, value } | { file, error } | null, freshness: { plan, dag, drifted, error? }, sec: { catalog_digest,
 * addendum_set } | { error } | null, files: { state, log } }.
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
  const L = lastDrive(input.last, S, input.freshness);
  const blockers = [];
  const block = (code, cls, reason, evidence = [], facts = {}) => blockers.push({ code, class: cls, reason, evidence, facts });
  if (S.run_id !== input.runId) block('run_mismatch', 'owner', `the engine state belongs to run ${S.run_id}, not ${input.runId}`, [at(['run_id'], S.run_id)]);
  if ((statusOut.judgments ?? []).length) block(statusOut.judgments[0].code, 'judgment', 'the engine reports open judgment(s)', [], { judgments: statusOut.judgments.map(j => ({ code: j.code, node: j.node ?? null, reason: j.reason })) });
  if ((statusOut.authority_untrusted ?? []).length) block('authority_untrusted', 'owner', 'RUN-STATE authority line(s) appeared while work was live: the owner re-appends them', [], { lines: statusOut.authority_untrusted });
  // status evaluates the ticket budget only (no phase); a spent phase budget shows as the drive's own budget_stop judgment
  const b = statusOut.budget;
  if (b?.ticket?.state === 'stop_dispatch') block('budget_spent', 'owner', 'the ticket token budget is spent', [], { budget: b });
  else if (b && ((b.flags ?? []).length || b.ticket?.state === 'unknown')) block('budget_unknown', 'unknown', 'the budget cannot be evaluated', [], { budget: b });
  const live = (S.attempts ?? []).map((a, i) => [a, i]).filter(([a]) => LIVE.includes(a.status));
  if (live.length) block('attempts_live', 'unknown', 'attempts are live or their quiescence is unproven', live.map(([a, i]) => at(['attempts', i, 'status'], a.status)));
  if (L.usable && L.outcome === 'judgment' && !L.judgments.some(j => BINDING.has(j.code))) block('drive_judgment', 'judgment', 'the drive output ended in a judgment', [{ source: 'last', file: L.file, pointer: '/outcome', value: 'judgment' }], { judgments: L.judgments });
  if ((statusOut.unit_reviews_pending ?? []).length) block('unit_review_owed', 'off_happy_path', 'unit review(s) are owed', [], { units: statusOut.unit_reviews_pending });
  if (!X) block('candidate_unavailable', 'unknown', `the current candidate cannot be computed: ${input.candidate?.reason ?? 'unknown'}`);
  const ix = gateIndex(input.logText, S, files.log);
  const runners = Object.entries(S.config?.testCommands ?? {}).filter(([, e]) => e?.format && !e.evidence).map(([k]) => k);
  return { ...base, exists: true, candidate: { id: X, ...(X ? {} : { reason: input.candidate?.reason ?? null }) }, last: L,
    freshness: { problems: freshnessProblems(input.freshness) }, blockers,
    phases: phases({ S, X, at, L, statusOut, sec: input.sec, freshness: input.freshness }),
    gates: Object.fromEntries(['red', 'reassess', 'review', 'ship-ready'].map(g => [g, refusalOf(S, g, ix)])),
    facts: { excluded_reviewers: [...new Set((S.builders ?? []).map(x => x.identity))], red_runners: runners, freeze: S.freeze?.candidate ?? null } };
}

// ---------------------------------------------------------------------------- next

const STOP_REASON = { owner: 'an owner-reserved decision', judgment: 'an open engine judgment', unknown: 'a state this tool cannot read without inference',
  off_happy_path: 'off the happy path: the orchestrator decides inside the approved plan', no_progress: 'the same refusal repeated with no progress',
  refused: 'the gate refused: the orchestrator reads the refusal and decides' };
const BLOCKER_ORDER = ['owner', 'judgment', 'unknown', 'off_happy_path'];

/** Pure: one step (or one STOP) from an accepted-view. */
export function nextStep(v) {
  const cmd = (name, input) => ({ script: 'run-engine.mjs', cmd: name, flags: { repo: null, ticket: v.ticket, 'run-id': v.run_id }, ...(input !== undefined ? { input } : {}) });
  const stop = (phase, code, cls, reason, evidence = [], facts = {}) => ({ schema: NEXT_SCHEMA, phase, action: 'stop', command: null, role: null,
    reason: `${STOP_REASON[cls]}: ${reason}`, evidence, code, stop_class: cls, facts });
  const go = (phase, action, command, role, reason, evidence = [], facts = {}) => ({ schema: NEXT_SCHEMA, phase, action, command, role, reason, evidence, facts });
  if (v.error) return stop(null, v.error.code, 'unknown', `the engine refused to load the state: ${v.error.reason}`);
  if (!v.exists) return go('INIT', 'run', { ...cmd('init'), flags: { ...cmd('init').flags, dag: null } }, null,
    'no engine state: init the approved plan and DAG (init itself refuses without the owner\'s START)');
  const blocker = [...v.blockers].sort((a, b) => BLOCKER_ORDER.indexOf(a.class) - BLOCKER_ORDER.indexOf(b.class))[0];
  if (blocker) return stop(null, blocker.code, blocker.class, blocker.reason, blocker.evidence, blocker.facts);
  const gated = (phase, gate, step) => {
    const r = v.gates[gate];
    if (!r) return step;
    if (r.kind === 'identity_unavailable') return stop(phase, 'identity_unavailable', 'unknown', `a ${gate} refusal (seq ${r.seq}) has no joinable candidate_id`, [], { key: r.key });
    if (r.kind === 'no_progress') return stop(phase, 'no_progress', 'no_progress', `${gate} refused ${r.key.code} twice (seq ${r.seqs.join(', ')}) with no progress record between; only the gate's own acceptance clears this`, [], { key: r.key, at: r.at });
    return stop(phase, 'gate_refused', 'refused', `${gate} refused ${r.key.code} (seq ${r.seqs[0]}); next never re-names a gate that refused: only its own acceptance clears this`, [], { key: r.key, at: r.at });
  };
  const red = v.phases.find(x => x.phase === 'RED');
  // A drive cannot finish while RED is owed (the barrier holds the dependents), so an owed RED is what settles BUILD/PROVE then.
  const redOwed = red?.code === 'red_pending' && v.facts.red_runners.length === 1 ? cmd('gate red', { node: red.nodes[0], command: v.facts.red_runners[0] }) : null;
  for (const p of v.phases) {
    if (['accepted', 'not_applicable'].includes(p.state)) continue;
    if (p.state === 'unknown') return stop(p.phase, 'acceptance_unknown', 'unknown', `${p.phase}: ${p.reason}`, p.evidence,
      { settle_with: p.settle !== 'drive' ? null : ['BUILD', 'PROVE'].includes(p.phase) && redOwed ? redOwed : cmd('drive') });
    switch (p.phase) {
      case 'INIT': return stop('INIT', p.code ?? 'init_not_accepted', 'owner', p.reason, p.evidence);
      case 'BUILD': case 'PROVE': case 'RED': {
        if (red.code === 'red_pending') {
          if (!redOwed) return stop('RED', 'red_runner_ambiguous', 'unknown', `RED is owed for ${red.nodes[0]} but the DAG has ${v.facts.red_runners.length} RED runners`, red.evidence);
          return gated('RED', 'red', go('RED', 'run', redOwed, null, `accepted RED is owed for ${red.nodes[0]} before its dependents run`, red.evidence));
        }
        return go(p.phase, 'run', cmd('drive'), 'builder', `${p.reason}: drive dispatches them through the carrier`, p.evidence);
      }
      case 'REASSESS':
        if (p.code !== 'reassess_owed') return stop('REASSESS', p.code, 'owner', p.reason, p.evidence);
        return gated('REASSESS', 'reassess', go('REASSESS', 'run', cmd('gate reassess', {}), null,
          `${p.reason}: run gate reassess on the current candidate (add classifications/surfaces if it asks for them)`, p.evidence, { want: p.want }));
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

/** The binding and node-file freshness, read the way the engine checks them (verifyBinding digests, drift fingerprints). */
function readFreshness(repoRoot, S, planFile) {
  try {
    const text = existsSync(planFile) ? readFileSync(planFile, 'utf8') : null;
    let plan = false;
    try { plan = text !== null && planNarrativeDigest(text) === S.plan_digest; } catch { plan = false; }
    const dagRaw = typeof S.dag_file === 'string' && existsSync(S.dag_file) ? readFileSync(S.dag_file) : null;
    const dag = dagRaw !== null && sha(dagRaw) === S.dag_digest;
    const drifted = Object.entries(S.nodes ?? {}).filter(([, n]) => n.state === 'done' && isObj(n.fps)
      && Object.entries(fingerprints(repoRoot, Object.keys(n.fps))).some(([p, f]) => n.fps[p] !== f)).map(([id]) => id);
    return { plan, dag, drifted };
  } catch (e) { return { plan: false, dag: false, drifted: [], error: `freshness unreadable: ${e.message}` }; }
}

/** The current reassessment tuple parts (installed catalog digest, trusted addendum ids), read-only. */
async function readSecurity(S) {
  try {
    const cat = (await securityPlan()).loadCatalog({});
    if (!cat.ok) return { error: `catalog ${cat.code}` };
    return { catalog_digest: cat.digest, addendum_set: securityEvents(S).addenda.map(a => a.addendum_id).sort() };
  } catch (e) { return { error: e.message }; }
}

/** Read the run and return the accepted-view. */
export async function readRun({ repoRoot, ticket, runId, lastFile, statusFn = status }) {
  if (!SAFE_ID.test(ticket ?? '') || !SAFE_ID.test(runId ?? '') || typeof repoRoot !== 'string') throw new Error('repo, a safe ticket and run id are required');
  // S1: the one placement resolver (legacy per-worktree or durable common-dir run directory); ambiguity is status's refusal
  let placed = null;
  try { placed = enginePaths(repoRoot, ticket, { prefer: 'legacy' }); } catch { /* status refuses state_placement_ambiguous below */ }
  const files = placed ? { state: placed.state, log: placed.log }
    : { state: gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.state.json`), log: gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.engine.jsonl`) };
  const input = { ticket, runId, files, S: null, raw: null, statusOut: null, logText: '', candidate: null, last: null };
  const before = existsSync(files.state) ? readFileSync(files.state, 'utf8') : null;
  try { input.statusOut = await statusFn({ repoRoot, ticket, runId }); } catch (e) { input.statusError = { code: e.code ?? 'status_failed', message: e.message }; }
  if (input.statusError) return acceptedView(input);
  input.raw = readFileSync(files.state, 'utf8');
  // status read the file itself: a commit between the two reads would mix two states
  if (input.raw !== before) return acceptedView({ ...input, statusError: { code: 'state_moved', message: 'the engine state changed during the read; read again' } });
  input.S = JSON.parse(input.raw);
  input.logText = existsSync(files.log) ? readFileSync(files.log, 'utf8') : '';
  input.candidate = baseCandidate(repoRoot, input.S, input.S.pinned_exclusions ?? []);
  input.freshness = readFreshness(repoRoot, input.S, resolve(repoRoot, '.specs', 'plans', `${ticket}.md`));
  input.sec = securityOn(input.S) ? await readSecurity(input.S) : null;
  if (lastFile !== undefined) {
    const file = resolve(lastFile);
    try {
      if (statSync(file).size > MAX_LAST_BYTES) throw new Error(`larger than ${MAX_LAST_BYTES} bytes`);
      input.last = { file, value: JSON.parse(readFileSync(file, 'utf8')) };
    } catch (e) { input.last = { file, error: `unreadable --last: ${e.message}` }; }
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
