#!/usr/bin/env node
/**
 * Durable run engine for ship-ticket (AIS-HARNESS-2, plan P0-1). Node built-ins only.
 *
 * Owns the per-ticket state ledger `ship-ticket-engine-state-v1` (git-path
 * ai-skills/ship-ticket/<ticket>.state.json, never committed) and drives the bound
 * `ship-ticket-engine-dag-v1`: approval binding (re-verified before every mutation), one lock,
 * atomic commits with an event outbox whose sinks never block, the launch handshake and
 * whole-group quiescence (engine-attempts.mjs), content-fingerprint staleness, the REVIEW freeze,
 * finding-bound REPAIR authorized from engine state, and the gate CLI (engine-gates.mjs). REVIEW
 * is never dispatched. The API contract is the comment blocks at the top of run-engine.test.mjs
 * and run-engine-repair.test.mjs.
 *
 * CLI: run-engine.mjs init|status|drive|resume|mark|clear-unit|rebind|archive --repo <dir> --ticket <key> --run-id <id>
 *        [--dag <file>] [--until <node>] [--node <id> --transition <t> --reason <text>] [--unit <unit>]
 *      run-engine.mjs gate red|review|ship-ready|unit-review|reassess --repo <dir> --ticket <key> --run-id <id> --input <json-file> [--unit <unit>]
 *        prints { gate, ok, code, judgment_point, reasons, candidate_id, ... }; exit 0 accepted,
 *        2 refused or judgment point (incl. lock_held), 1 usage error (incl. an invalid input file).
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isEntrypoint } from './harness.mjs';
import { truncatedOutputs } from './run-summary.mjs';
import { eventLine } from './run-state.mjs';
import { childEnv, verifySubscription as cliSubscription } from './carrier.mjs';
import * as io from './engine-io.mjs';
import { planNarrativeDigest, validateEngineDag, closure, coded, judgment, note, normDigest, sha, runStateEvents, gateInput,
  BEGIN, END, legacyApproval, securityOn, pairKey, auditOn } from './engine-dag.mjs';
import { reconcile, dispatchNodes, runRepairs, budgetVerdict, redPending, clearSpent } from './engine-attempts.mjs';
import { GATES, gateNo, refreshRed, redInvalidJudgments, securityPlan, catalogOptions, securityJudgments, designContract } from './engine-gates.mjs';
import { observeAuthority, trustedEvents, malformedRunState } from './engine-authority.mjs';
import { unretired, LIVE } from './engine-quiesce.mjs';
import { hasUnits, unitDrift, unitWork, runUnitChecks, bindingHeld, unitStates, unitJudgments, unitProjection, restoreCheckFailed, ceiling, clearUnit } from './engine-units.mjs';
import { unitReviewOn, unitReviewJudgments, withReviews, pendingReviews, reconcileReviews } from './engine-unit-review.mjs';

export { acquireLock, writeStateAtomic } from './engine-io.mjs';
export { planNarrativeDigest, validateEngineDag } from './engine-dag.mjs';

const STATE_SCHEMA = 'ship-ticket-engine-state-v1';
const STATUS_SCHEMA = 'ship-ticket-engine-status-v1';
const CTX_KEYS = new Set(['repoRoot', 'ticket', 'runId', 'dagFile', 'env', 'verifySubscription', 'handleSignals', 'spawn',
  'pid', 'host', 'processInfo', 'groupAlive', 'platform', 'fs', 'hooks', 'allowApiBilling', 'until', 'admissionProbe', 'catalogFile', 'now']);
const MARKS = { 'failed->pending': ['failed', 'pending'], 'pending->cancelled': ['pending', 'cancelled'] };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RETRIES = 1;

function locate(ctx) {
  if (!SAFE_ID.test(ctx?.ticket ?? '') || !SAFE_ID.test(ctx?.runId ?? '') || typeof ctx.repoRoot !== 'string')
    throw coded('bad_context', 'repoRoot, safe ticket and runId required');
  const base = `ai-skills/ship-ticket/${ctx.ticket}`;
  return { state: io.gitPath(ctx.repoRoot, base + '.state.json'), log: io.gitPath(ctx.repoRoot, base + '.engine.jsonl'),
    usage: io.gitPath(ctx.repoRoot, base + '.usage.jsonl'), attempts: io.gitPath(ctx.repoRoot, base + '.attempts'),
    planRel: `.specs/plans/${ctx.ticket}.md`, plan: join(ctx.repoRoot, '.specs', 'plans', ctx.ticket + '.md') };
}

/**
 * Plan narrative digest, required to equal the START event's approved_plan_digest for this run
 * (either digest spelling). With engine state, only a trusted START counts (engine-authority.mjs).
 * A malformed RUN-STATE block is refused first ('run_state_malformed').
 */
function approvedPlan(ctx, P, S = null) {
  const text = io.readIfExists(P.plan);
  if (text === null || text.indexOf(BEGIN) < 0) throw coded('approval_mismatch', `${P.plan} is missing or has no RUN-STATE block`);
  const malformed = malformedRunState(text);
  if (malformed.length) throw coded('run_state_malformed', malformed[0].reason);
  const digest = planNarrativeDigest(text);
  const events = runStateEvents(text);
  const start = (S ? trustedEvents(S, 'START') : events.filter(e => e.event === 'START')).filter(e => e.run_id === ctx.runId).at(-1);
  if (!start || normDigest(start.approved_plan_digest) !== digest) throw coded('approval_mismatch', `plan narrative does not match START of ${ctx.runId}`);
  return { text, digest, events, start };
}

/**
 * W3-record audit timestamps (config.auditRecord only; never read by a decision). Stamps every event
 * of `S` that has no `at`, and every terminal attempt (any status outside LIVE: exited, abandoned,
 * timed_out, crashed, orphaned, spawn_failed, retried; all carry quiesced:true past the persistence
 * guard) that has no `ended_at`, with `at`. No clock and no I/O: the caller passes the instant. Never
 * throws on any state shape. `memo` ({ ev, end }: Maps, one per command, never persisted) keeps the
 * first instant given to each item, so a snapshot that lost the stamp (gateRed commits clones of
 * its own private copy, gate.mjs) gets the same value again; an item loaded with its stamp keeps it.
 */
export function stampAudit(S, at, memo) {
  const keep = (m, k) => { if (!m.has(k)) m.set(k, at); return m.get(k); };
  for (const e of Array.isArray(S?.events) ? S.events : []) {
    if (e && typeof e === 'object' && e.at === undefined) e.at = keep(memo.ev, `${e.seq}\u0000${e.type}`);
  }
  for (const a of Array.isArray(S?.attempts) ? S.attempts : []) {
    if (a && typeof a === 'object' && !LIVE.includes(a.status) && a.quiesced === true && a.ended_at === undefined) a.ended_at = keep(memo.end, a.attempt_id);
  }
}

/** The instant commit() stamps with: the in-process test clock `ctx.now` (never set by the CLI), else the wall clock. */
function auditNow(ctx) {
  if (ctx.now === undefined) return new Date().toISOString();
  const at = typeof ctx.now === 'function' ? ctx.now() : undefined;
  if (typeof at !== 'string') throw coded('bad_context', 'ctx.now must be a function returning an ISO timestamp string');
  return at;
}

/** Context for one command: paths, state, serialized commits and live in-process attempts. */
function open(ctx) {
  const P = locate(ctx);
  const E = { ctx, P, S: null, live: new Map(), refused: new Set(), lock: Promise.resolve(), verifyBinding: () => verifyBinding(E),
    stamps: { ev: new Map(), end: new Map() },
    alive: (pgid) => (ctx.groupAlive ?? ((g) => io.groupAlive(g, ctx.platform ?? process.platform)))(pgid),
    load() {
      if (!existsSync(P.state)) throw coded('no_state', `no engine state for ${ctx.ticket}; run init`);
      E.S = JSON.parse(readFileSync(P.state, 'utf8'));
      for (const [k, v] of Object.entries({ builders: [], telemetry_degraded: [], locks: {}, repairs: [], outbox: [] })) E.S[k] ??= v;
      E.S.rounds ??= { prove_repair_batches: 0, review_repairs: {} };
      // commit() never persists an unretired attempt, so one on disk predates the `quiesced` field.
      const legacy = unretired(E.S);
      if (legacy.length) throw coded('legacy_state', `${P.state} predates quiescence tracking (attempts ${legacy.map(a => a.attempt_id).join(', ')} `
        + 'are terminal without `quiesced`); confirm none of their processes still runs, delete the state file and re-run init');
      return E.S;
    },
    /** Classify new RUN-STATE authority lines (the one writer of state.authority). */
    observe() { observeAuthority(E.S, io.readIfExists(P.plan), E.alive); },
    async commit() {
      // Persistence guard: no attempt leaves the live set except through engine-quiesce.mjs retire().
      const bad = unretired(E.S);
      if (bad.length) throw coded('unquiesced_exit', `attempt(s) ${bad.map(a => `${a.attempt_id}:${a.status}`).join(', ')} left the live set without proven quiescence`);
      // W3-record: snapshot-preparation time, not decision time. Stamped in place here, before the clone,
      // the queue and the atomic write, so a commit queued behind this one carries the same values. A
      // write that fails before its rename persists nothing: the command ends, and the next command's first
      // commit stamps those items (or the ones that replace them) with its own instant. A failure after the
      // rename (the directory fsync) leaves this stamped snapshot installed, and its stamps are kept.
      if (auditOn(E.S)) stampAudit(E.S, auditNow(ctx), E.stamps);
      const data = structuredClone(E.S), prev = E.lock;
      let done; E.lock = new Promise(r => { done = r; });
      await prev;
      try { await io.writeStateAtomic(P.state, data, { hooks: ctx.hooks, fs: ctx.fs, platform: ctx.platform }); } finally { done(); }
    } };
  return E;
}

/**
 * Run `fn` under the ticket lock, releasing it on every exit path. The state is loaded (unless
 * `load` is false: init) and RUN-STATE authority observed before `fn`, and observed and committed
 * again after it, so an owner line appended between commands is trusted at the next command and a
 * line appended while this command's attempts ran is not.
 */
async function locked(ctx, fn, { load = true } = {}) {
  const E = open(ctx);
  const lock = await io.acquireLock(ctx);
  const onSignal = () => { lock.release().finally(() => process.exit(130)); };
  const signals = ctx.handleSignals === false ? [] : ['SIGINT', 'SIGTERM'];
  for (const s of signals) process.on(s, onSignal);
  try {
    if (load) { E.load(); E.observe(); }
    const out = await fn(E);
    if (E.S) { E.observe(); await E.commit(); }
    return out;
  } finally { for (const s of signals) process.off(s, onSignal); await lock.release(); }
}

/**
 * Re-verify, before any mutation, that this is the state's run and that the plan narrative and the
 * DAG bytes still match the approval binding. Returns judgments (empty when bound).
 */
function verifyBinding(E) {
  const { S, ctx } = E;
  if (S.run_id !== ctx.runId) return [judgment('run_mismatch', null, `engine state belongs to run ${S.run_id}, not ${ctx.runId}`)];
  const out = [];
  try {
    const approved = approvedPlan(ctx, E.P, S);
    if (approved.digest !== S.plan_digest) out.push(judgment('approval_mismatch', null, 'plan narrative differs from the one bound at init'));
    // Grandfathering is by the trusted START's approval time, never by a missing field (AIS-HARNESS-4 Wave B).
    else if (!securityOn(S) && !legacyApproval(approved.start)) out.push(judgment('security_policy_required', null,
      'the trusted START is not approved before the security policy cutoff, and the bound DAG has no config.securityPolicy 2'));
  } catch (e) {
    if (e.code === 'run_state_malformed') out.push(judgment(e.code, null, e.message));
    else if (e.code === 'approval_mismatch') out.push(judgment('approval_mismatch', null, 'plan narrative no longer matches the approved START'));
    else throw e;
  }
  const raw = io.readIfExists(ctx.dagFile ?? S.dag_file);
  if (raw === null || sha(raw) !== S.dag_digest) out.push(judgment('dag_mismatch', null, 'DAG bytes differ from the bound digest'));
  if (securityOn(S) && S.security?.reapproval) out.push(judgment('security_reapproval', null,
    `reassessment of ${S.security.reapproval.candidate_id} needs REAPPROVAL (a new START and plan digest; WAIT_FOR_USER)`));
  return out;
}

/** Done nodes whose read/write fingerprints changed: stale with their closure, or post_freeze_drift judgments. */
function drift(E, { mutate = true } = {}) {
  const { S, ctx } = E;
  const drifted = Object.entries(S.nodes).filter(([, n]) => n.state === 'done' && n.fps
    && Object.entries(io.fingerprints(ctx.repoRoot, Object.keys(n.fps))).some(([p, f]) => n.fps[p] !== f)).map(([id]) => id);
  if (S.freeze) return drifted.map(id => judgment('post_freeze_drift', id, 'input or output changed after the REVIEW freeze'));
  if (mutate) for (const id of closure(S, drifted)) if (S.nodes[id].state === 'done') S.nodes[id].state = 'stale';
  return [];
}

/** Compact STATUS: the only thing the orchestrator reads. */
function view(E, transient = []) {
  const S = E.S;
  const failed = Object.entries(S.nodes).filter(([, n]) => n.state === 'failed')
    .map(([id, n]) => judgment('node_failed', id, n.reason ?? 'terminal failure; an explicit mark failed->pending is required'));
  // A failed final-review (or PROVE) repair is terminal for its execution: only an owner RETRY of the
  // review continues (it cancels the repair). A failed unit repair is unit_review_terminal already.
  const failedRepairs = S.repairs.filter(r => r.state === 'failed' && r.kind !== 'unit-review')
    .map(r => judgment('repair_failed', r.id, `${r.reason ?? 'terminal failure'}; continuing needs a RUN-STATE RETRY linked to review ${r.review_execution}`));
  const budget = budgetVerdict(E);
  const cache = {}, units = hasUnits(S) ? unitStates(S, E.ctx.repoRoot, cache) : null;
  return { schema: STATUS_SCHEMA, ticket: S.ticket, run_id: S.run_id,
    nodes: Object.fromEntries(Object.entries(S.nodes).map(([id, n]) => [id, { state: n.state, attempts: n.attempts, retries: n.retries }])),
    repairs: S.repairs.map(r => ({ id: r.id, state: r.state })),
    judgments: [...S.judgments, ...transient.filter(j => !(j.code === 'security_reapproval' && S.security?.reapproval)), ...failed, ...failedRepairs,
      ...redInvalidJudgments(S), ...(units ? unitJudgments(S, units) : []), ...(unitReviewOn(S) ? unitReviewJudgments(S, units) : []), ...securityJudgments(S)],
    rounds: structuredClone(S.rounds), confirmation: S.confirmation ?? null, red_pending: redPending(S),
    budget: budget && { ticket: budget.ticket, phase: budget.phase, flags: budget.flags,
      ...(budget.phase_unknown.records ? { phase_unknown: budget.phase_unknown } : {}) },
    authority_untrusted: (S.authority?.untrusted ?? []).map(u => JSON.parse(u.line)),
    telemetry_degraded: structuredClone(S.telemetry_degraded),
    ...(units ? { units: withReviews(S, unitProjection(S, E.ctx.repoRoot, cache), units), unit_ceiling: ceiling(S) } : {}),
    ...(unitReviewOn(S) ? { unit_reviews_pending: pendingReviews(S, units) } : {}),
    ...(truncatedOutputs(S).length ? { truncated_outputs: truncatedOutputs(S) } : {}) };
}

/** Record a sink failure as telemetry degradation (never a command failure). */
function degrade(S, sink, ev, e) {
  S.telemetry_degraded.push({ sink, event_id: ev.event_id, error: e.code ?? e.message, at: new Date().toISOString() });
  S.telemetry_degraded = S.telemetry_degraded.slice(-50);
}

/**
 * Deliver outbox events to the engine log and RUN-STATE (idempotent by event_id). A sink failure
 * is recorded as telemetry degradation and the event stays in the outbox for the next replay; it
 * never fails the command. A throw at a hook boundary (a simulated crash) still propagates.
 */
async function deliver(E) {
  if (!E.S.outbox.length) return;
  const kept = [];
  for (const ev of E.S.outbox) {
    let failed = false;
    await io.boundary(E.ctx.hooks, 'run-log-append', { event_id: ev.event_id });
    // W3-record: a switch-on GATE row carries untrusted text; eventLine escapes the line breaks JSON.stringify leaves raw.
    try { io.appendLogOnce(E.P.log, ev, auditOn(E.S) && ev.event === 'GATE' ? eventLine : undefined); } catch (e) { degrade(E.S, 'engine-log', ev, e); failed = true; }
    await io.boundary(E.ctx.hooks, 'run-state-append', { event_id: ev.event_id });
    // gate decisions stay in the engine log; SHIP_READY and MARK reach the plan's RUN-STATE
    if (ev.event !== 'GATE') try { io.appendRunStateOnce(E.P.plan, ev); } catch (e) { degrade(E.S, 'run-state', ev, e); failed = true; }
    if (failed) kept.push(ev);
    else E.S.telemetry_degraded = E.S.telemetry_degraded.filter(d => d.event_id !== ev.event_id);
  }
  E.S.outbox = kept;
  await E.commit();
}

/**
 * Security policy at init (AIS-HARNESS-4 Wave B). Without config.securityPolicy only a run whose START
 * was approved before SECURITY_POLICY_CUTOFF is admitted (security_policy_required). With policy 2:
 * the installed catalog loads and is the one the plan was approved against (catalog_unavailable),
 * every control id is in it (dag_invalid), and the approved narrative carries both the
 * `security-pairs` line of exactly the DAG's pairs and a verified §3a machine block with the same
 * pairs and catalog digest (security_pairs_mismatch), every surface path of which lies inside the Design
 * Contract (designContract of the DAG nodes, matched by reassess itself: else the first gate reassess ends in
 * a permanent REAPPROVAL; security_pairs_mismatch naming the path).
 */
async function bindSecurity(ctx, config, nodes, start, text, narrative) {
  if (config.securityPolicy === undefined) {
    if (!legacyApproval(start)) throw coded('security_policy_required', 'a run approved after the security policy cutoff needs config.securityPolicy 2 with catalogDigest and controlCoverage');
    return;
  }
  const sp = await securityPlan();
  const cat = sp.loadCatalog(catalogOptions(ctx));
  if (!cat.ok) throw coded('catalog_unavailable', `${cat.code}: ${(cat.reasons ?? []).join('; ')}`);
  if (cat.digest !== config.catalogDigest) throw coded('catalog_unavailable', `config.catalogDigest ${config.catalogDigest} is not the installed catalog ${cat.digest}; re-select and re-approve`);
  const known = new Set(cat.catalog.controls.map(c => c.id));
  const unknown = config.controlCoverage.map(p => p.control).filter(c => !known.has(c));
  if (unknown.length) throw coded('dag_invalid', `config.controlCoverage names control(s) not in the catalog: ${[...new Set(unknown)].join(', ')}`);
  const ids = config.controlCoverage.map(pairKey).sort();
  const line = sp.pairsLine({ catalogDigest: config.catalogDigest, pairs: ids });
  if (!narrative.includes(line)) throw coded('security_pairs_mismatch', 'the approved narrative has no security-pairs line for exactly the DAG\'s controlCoverage and catalogDigest');
  const block = sp.parsePlanSecurityBlock(text);
  if (!block || block.catalog_digest !== config.catalogDigest || JSON.stringify(block.pairs) !== JSON.stringify(ids))
    throw coded('security_pairs_mismatch', 'the approved §3a security-plan block is missing, invalid or names other pairs than config.controlCoverage');
  // The reassess gate's own contract check over the approved surfaces alone (no changed file, no input surface).
  const res = sp.reassess({ plan: text, catalog: cat, inventory: [], changed: { contract_paths: designContract(nodes), files: [] } });
  // Fail closed: an approved block reassess cannot reassess would bind here and refuse at the first gate.
  if (!res.ok) throw coded('security_pairs_mismatch', `the approved §3a security-plan block cannot be reassessed (${res.code}): ${(res.reasons ?? []).join('; ')}`);
  const outside = res.reapproval_basis.filter(b => b.kind === 'out-of-plan-path').map(b => b.path);
  if (outside.length) throw coded('security_pairs_mismatch', `the approved §3a surface path(s) ${outside.join(', ')} lie outside every node's writes (the Design Contract); re-plan and re-approve`);
}

/** Create the state ledger after verifying the approved narrative, the DAG binding and the pinned exclusions. */
export async function init(ctx) {
  return locked(ctx, async (E) => {
    if (existsSync(E.P.state)) throw coded('state_exists', `${E.P.state} already exists`);
    const { text, digest, events, start } = approvedPlan(ctx, E.P);
    let raw;
    try { raw = readFileSync(ctx.dagFile); } catch { throw coded('dag_invalid', 'dagFile unreadable'); }
    let doc;
    try { doc = JSON.parse(raw); } catch { throw coded('dag_invalid', 'DAG is not JSON'); }
    const dag = validateEngineDag(doc, { ticket: ctx.ticket });
    const dagDigest = sha(raw);
    const narrative = text.slice(0, text.indexOf(BEGIN)) + text.slice(text.indexOf(END));
    await bindSecurity(ctx, dag.config, dag.nodes, start, text, narrative);
    const bound = events.filter(e => e.event === 'DAG_BOUND' && e.run_id === ctx.runId);
    const listed = narrative.includes(dagDigest) || narrative.includes(dagDigest.replace(/^sha256:/, 'sha256-'));
    const binding = listed ? 'plan' : bound.length === 1 && normDigest(bound[0].dag_digest) === dagDigest ? 'dag_bound' : null;
    if (!binding) throw coded('dag_unbound', 'the DAG digest is neither in the approved plan nor in exactly one DAG_BOUND of this run');
    E.S = { schema: STATE_SCHEMA, ticket: ctx.ticket, run_id: ctx.runId, plan_digest: digest, dag_digest: dagDigest, binding,
      dag_file: resolve(ctx.dagFile), created_at: new Date().toISOString(), seq: 0, config: dag.config,
      pinned_exclusions: [...dag.config.candidateExclusions], risk_labels: [...new Set([...dag.config.riskLabels, ...dag.nodes.flatMap(n => n.risk)])],
      nodes: Object.fromEntries(dag.nodes.map(n => [n.id, { ...n, state: 'pending', attempts: 0, retries: 0, fps: null }])),
      attempts: [], events: [], judgments: [], outbox: [], usage: [], freeze: null, review_chain: [], repairs: [], builders: [],
      rounds: { prove_repair_batches: 0, review_repairs: {} }, confirmation: null, gates: { red: {} }, locks: {}, telemetry_degraded: [],
      ...(dag.nodes.some(n => n.unit !== undefined) ? { unit_checks: Object.fromEntries([...new Set(dag.nodes.map(n => n.unit).filter(u => u !== undefined))]
        .map(u => [u, { evidence: null, stale: false, invalidations: 0, causes: [] }])) } : {}),
      ...(dag.config.unitReview === true ? { unit_reviews: Object.fromEntries([...new Set(dag.nodes.map(n => n.unit).filter(u => u !== undefined))]
        .map(u => [u, { chain: [] }])) } : {}) };
    E.observe(); // no attempt exists yet: every authority line present at init is trusted
    await E.commit();
    return { state_file: E.P.state, run_id: ctx.runId, plan_digest: digest, dag_digest: dagDigest, binding };
  }, { load: false });
}

/** Read-only STATUS (freeze drift is reported, nothing is written). */
export async function status(ctx) {
  const E = open(ctx);
  E.load();
  reconcileReviews(E); // in memory only: status writes nothing
  return view(E, drift(E, { mutate: false }));
}

/** Reconcile attempts, the outbox, spent judgments and staleness after a crash or restart (refused when the binding drifted). */
export async function resume(ctx) {
  return locked(ctx, async (E) => {
    const unbound = verifyBinding(E);
    if (unbound.length) return view(E, unbound);
    await deliver(E);
    const live = await reconcile(E, 1000);
    const cleared = clearSpent(E.S);
    const transient = drift(E);
    unitDrift(E);
    reconcileReviews(E);
    note(E.S, 'RESUME', { outcome: transient.length || E.S.judgments.length ? 'judgment' : live ? 'waiting' : 'reconciled',
      ...(cleared.length ? { cleared_judgments: cleared } : {}) });
    await E.commit();
    return view(E, transient);
  });
}

/** Re-verify the binding, reconcile, then dispatch ready nodes and authorized repairs until done or a judgment point. */
export async function drive(ctx) {
  return locked(ctx, async (E) => {
    const transient = verifyBinding(E);
    if (transient.length) return { ...view(E, transient), outcome: 'judgment' };
    await deliver(E);
    const live = await reconcile(E, 0);
    transient.push(...drift(E));
    unitDrift(E);
    reconcileReviews(E); // idempotent: also recovers a crash between a unit re-check and its binding
    const work = Object.values(E.S.nodes).some(n => ['pending', 'stale'].includes(n.state)) || E.S.repairs.some(r => r.state === 'pending') || unitWork(E);
    if (!live && !transient.length && !E.S.judgments.length && work) await refreshRed(E, transient); // may replace E.S
    const S = E.S;
    if (!live && !transient.length && !S.judgments.length && work) {
      const auth = S.config.billing === 'subscription'
        ? (ctx.verifySubscription ?? cliSubscription)(S.config.provider, childEnv(S.config.provider, 'subscription', ctx.env ?? process.env)) : true;
      if (auth !== true) transient.push(judgment('billing_unverified', null, 'subscription login not proven; refusing to risk API billing'));
      else {
        try { await dispatchNodes(E, transient, hasUnits(E.S) ? { onIdle: () => runUnitChecks(E, transient), hold: () => unitWork(E) } : {}); } finally { await E.commit(); }
        if (!bindingHeld(transient)) await runRepairs(E, transient); // a unit check drifted the binding: dispatch nothing more
        if (hasUnits(E.S)) { unitDrift(E); await runUnitChecks(E, transient); } // a repair's fingerprint refresh is never renewed evidence
        reconcileReviews(E); // a repaired unit verified again: the evidence its targeted confirmation reviews
        for (const j of drift(E, { mutate: false })) transient.push(j);
      }
    }
    await E.commit();
    const out = view(E, transient);
    const finished = Object.values(S.nodes).every(n => ['done', 'cancelled'].includes(n.state))
      && S.repairs.every(r => !['pending', 'running'].includes(r.state)) && (!out.units || Object.values(out.units).every(u => u.state === 'verified'));
    return { ...out, outcome: out.judgments.length ? 'judgment' : finished && !live ? 'done' : 'waiting' };
  });
}

/**
 * Restricted manual transition: only failed->pending (capped retry) and pending->cancelled, with a
 * reason. failed->pending clears the node's judgments and every spent one (engine-attempts.mjs
 * clearSpent) and records them as `cleared_judgments` [{ code, node }] on the MARK event (the
 * reason is the recorded authorization). `resume` clears spent judgments the same way.
 */
export async function mark(ctx) {
  const extra = Object.keys(ctx ?? {}).filter(k => !CTX_KEYS.has(k) && !['node', 'transition', 'reason'].includes(k));
  if (extra.length || !Object.hasOwn(MARKS, ctx.transition ?? '') || typeof ctx.reason !== 'string' || !ctx.reason.trim())
    throw coded('mark_refused', `only failed->pending and pending->cancelled with a reason and no other fields${extra.length ? ` (got ${extra})` : ''}`);
  return locked(ctx, async (E) => {
    const S = E.S;
    const unbound = verifyBinding(E);
    if (unbound.length) throw coded(unbound[0].code, unbound.map(j => j.reason).join('; '));
    const n = S.nodes[ctx.node];
    const [from, to] = MARKS[ctx.transition];
    if (!n || n.state !== from) throw coded('mark_refused', `node ${ctx.node} is not ${from}`);
    let cleared = [];
    if (ctx.transition === 'failed->pending') {
      if ((n.retries ?? 0) >= MAX_RETRIES) throw coded('retry_cap', `node ${ctx.node} already used its retry`);
      n.retries = (n.retries ?? 0) + 1;
      cleared = S.judgments.filter(j => j.node === ctx.node).map(j => ({ code: j.code, node: j.node }));
      S.judgments = S.judgments.filter(j => j.node !== ctx.node);
      cleared.push(...clearSpent(S));
      restoreCheckFailed(S, ctx.node);
    }
    n.state = to;
    const ev = { run_id: S.run_id, event: 'MARK', event_id: 'mark-' + randomUUID(), node: ctx.node, transition: ctx.transition,
      reason: ctx.reason, ...(cleared.length ? { cleared_judgments: cleared } : {}), timestamp: new Date().toISOString() };
    note(S, 'MARK', { node: ctx.node, event_id: ev.event_id, ...(cleared.length ? { cleared_judgments: cleared } : {}) });
    S.outbox.push(ev);
    await E.commit();
    await deliver(E);
    return view(E);
  });
}

/**
 * Owner clearing of a unit dead end (engine-units.mjs clearUnit): authorized only by a trusted
 * RUN-STATE UNIT_CLEAR linked to the unit's current evidence. The UNIT_CLEARED event (with the
 * owner's reason) reaches RUN-STATE like MARK. Refusals throw (CLI exit 1).
 */
export async function clearUnitCmd(ctx) {
  const extra = Object.keys(ctx ?? {}).filter(k => !CTX_KEYS.has(k) && k !== 'unit');
  if (extra.length || typeof ctx.unit !== 'string' || !ctx.unit) throw coded('unit_clear_refused', `clear-unit takes --unit and no other fields${extra.length ? ` (got ${extra})` : ''}`);
  return locked(ctx, async (E) => {
    const unbound = verifyBinding(E);
    if (unbound.length) throw coded(unbound[0].code, unbound.map(j => j.reason).join('; '));
    let entry;
    try { entry = clearUnit(E, ctx.unit); } catch (e) { await E.commit(); throw e; } // the authority observation stays recorded
    E.S.outbox.push({ run_id: E.S.run_id, event: 'UNIT_CLEARED', event_id: 'unit-clear-' + randomUUID(), unit: ctx.unit, ...entry,
      timestamp: new Date().toISOString() });
    await E.commit();
    await deliver(E);
    return view(E);
  });
}

/**
 * Owner acceptance of hand edits made to done nodes' files between the last drive and the review
 * freeze (SCRUM-307). Re-binds the drifted done nodes' fingerprints to the work tree, and only when
 * that tree is exactly the frozen candidate: the review then saw these bytes, so the fingerprints
 * were the only stale part. It never moves the freeze, and drift(), startsFromFreeze and the
 * ship-ready conjunction are untouched. The reason is the recorded authorization (like `mark`);
 * the REBIND event carries each node's path deltas. Not offered with units (their evidence bindings
 * are not re-bound). A changed RED spec still needs `gate red`. Refusals throw (CLI exit 1).
 */
export async function rebind(ctx) {
  const extra = Object.keys(ctx ?? {}).filter(k => !CTX_KEYS.has(k) && k !== 'reason');
  if (extra.length || typeof ctx.reason !== 'string' || !ctx.reason.trim())
    throw coded('rebind_refused', `rebind takes --reason (non-empty) and no other fields${extra.length ? ` (got ${extra})` : ''}`);
  return locked(ctx, async (E) => {
    const S = E.S;
    const unbound = verifyBinding(E);
    if (unbound.length) throw coded(unbound[0].code, unbound.map(j => j.reason).join('; '));
    if (!S.freeze) throw coded('rebind_no_freeze', 'no review freeze: before it a drifted node is re-run (stale), not rebound');
    if (hasUnits(S)) throw coded('rebind_units', 'rebind does not cover runs with units (their evidence bindings are not re-bound)');
    const live = S.attempts.filter(a => LIVE.includes(a.status)).map(a => a.attempt_id);
    if (live.length) throw coded('rebind_attempts_live', `attempts still live: ${live.join(', ')}`);
    const c = io.candidateId(ctx.repoRoot, S.config.base ?? 'HEAD', S.pinned_exclusions);
    if (!c.candidate_id || c.candidate_id !== S.freeze.candidate)
      throw coded('rebind_not_frozen_tree', `work tree is ${c.candidate_id ?? c.reason}, frozen is ${S.freeze.candidate}: revert the edit or record an owner RETRY for a new review`);
    const nodes = [];
    for (const [id, n] of Object.entries(S.nodes)) {
      if (n.state !== 'done' || !n.fps) continue;
      const now = io.fingerprints(ctx.repoRoot, Object.keys(n.fps));
      const paths = Object.keys(n.fps).filter(q => n.fps[q] !== now[q]).map(q => ({ path: q, from: n.fps[q] ?? null, to: now[q] ?? null }));
      if (paths.length) nodes.push({ node: id, paths, fps: now });
    }
    if (!nodes.length) throw coded('rebind_nothing_drifted', 'no done node has drifted input or output');
    // The frozen candidate vouches only for the bytes it covers: a drifted path outside it (excluded, e.g. session-log.md) was never reviewed.
    const covered = new Set(c.paths ?? []);
    const outside = [...new Set(nodes.flatMap(n => n.paths.map(p => p.path)))].filter(p => !covered.has(p));
    if (outside.length) throw coded('rebind_uncovered', `drifted paths the frozen candidate does not cover (excluded or unchanged from the base) are never rebound: ${outside.join(', ')}; revert them`);
    for (const n of nodes) S.nodes[n.node].fps = n.fps;
    const ev = { run_id: S.run_id, event: 'REBIND', event_id: 'rebind-' + randomUUID(), candidate_id: c.candidate_id, reason: ctx.reason,
      nodes: nodes.map(({ node, paths }) => ({ node, paths })), timestamp: new Date().toISOString() };
    note(S, 'REBIND', { event_id: ev.event_id, nodes: nodes.map(n => n.node) });
    S.outbox.push(ev);
    await E.commit();
    await deliver(E);
    return view(E);
  });
}

/**
 * Copy the run's durable records out of the work tree's own git dir, which `git worktree remove`
 * deletes (SCRUM-307 lost its state, engine log and usage ledger that way). Destination:
 * <git common dir>/ai-skills/ship-ticket/archive/<ticket>/<run-id>-<n>/ with state.json,
 * engine.jsonl, usage.jsonl (when present) and manifest.json { ticket, run_id, archived_at,
 * files: name -> sha256 }. Takes the lock but neither observes nor commits (engine state and RUN-STATE
 * observation are untouched, so the copy is the state as left behind); refuses another run's id
 * (`run_mismatch`); never overwrites an earlier archive.
 */
export async function archive(ctx) {
  const extra = Object.keys(ctx ?? {}).filter(k => !CTX_KEYS.has(k));
  if (extra.length) throw coded('archive_refused', `archive takes no fields (got ${extra})`);
  return locked(ctx, async (E) => {
    if (!existsSync(E.P.state)) throw coded('no_state', `no engine state for ${ctx.ticket}; run init`);
    let runId;
    try { runId = JSON.parse(readFileSync(E.P.state, 'utf8')).run_id; } catch { throw coded('state_unreadable', `${E.P.state} is not valid JSON`); }
    if (runId !== ctx.runId) throw coded('run_mismatch', `engine state belongs to run ${runId}, not ${ctx.runId}`);
    const base = join(io.commonGitDir(ctx.repoRoot), 'ai-skills', 'ship-ticket', 'archive', ctx.ticket);
    mkdirSync(base, { recursive: true });
    let n = readdirSync(base).filter(d => d.startsWith(ctx.runId + '-') && /^\d+$/.test(d.slice(ctx.runId.length + 1))).length + 1, dir;
    while (existsSync(dir = join(base, `${ctx.runId}-${n}`))) n++;
    // Stage, then publish: a failed copy never leaves a numbered directory (the ticket lock excludes a concurrent archive).
    const stage = join(base, `.staging-${ctx.runId}-${n}-${randomUUID()}`);
    mkdirSync(stage);
    const files = {};
    try {
      for (const [name, src] of [['state.json', E.P.state], ['engine.jsonl', E.P.log], ['usage.jsonl', E.P.usage]]) {
        if (!existsSync(src)) continue;
        copyFileSync(src, join(stage, name));
        files[name] = sha(readFileSync(join(stage, name)));
      }
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ ticket: ctx.ticket, run_id: ctx.runId, archived_at: new Date().toISOString(), files }, null, 2) + '\n');
      renameSync(stage, dir);
    } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
    return { archive: dir, files };
  }, { load: false });
}

const GATE_REFUSALS = new Set(['lock_held', 'lock_foreign_host', 'lock_malformed', 'no_state']);

/** W3-record GATE line bounds: reasons keeps its first AUDIT_REASONS_MAX strings, each cut to AUDIT_TEXT_MAX characters. */
export const AUDIT_REASONS_MAX = 20;
export const AUDIT_TEXT_MAX = 500;
const isRecordObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boundedText = (v) => typeof v === 'string' && v.length <= AUDIT_TEXT_MAX;
/** Cut to AUDIT_TEXT_MAX code units without leaving a lone high surrogate at the cut. */
const cutText = (s) => { const t = s.slice(0, AUDIT_TEXT_MAX); return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t; };

/**
 * The W3-record fields of one GATE line (config.auditRecord only), built fresh from the decision `v`
 * and the submitted `input`, neither of which is mutated. Untrusted diagnostic text, never authority:
 * nothing reads it back. `reasons`: the decision's string reasons, at most 20, each cut to 500
 * characters (present when there is one). review and unit-review also carry the submitted
 * `review_execution` and the `primary`/`second_opinion` outcomes as `primary_outcome` and
 * `second_opinion_outcome`, and unit-review its `unit`: each only when it is a string of at most 500
 * characters, else omitted (an identifier is never cut, so a cut one cannot pass for another). Total
 * over any JSON input.
 */
export function gateAuditFields(kind, input, v) {
  const out = {};
  const reasons = (Array.isArray(v?.reasons) ? v.reasons : []).filter(r => typeof r === 'string').slice(0, AUDIT_REASONS_MAX).map(cutText);
  if (reasons.length) out.reasons = reasons;
  if ((kind !== 'review' && kind !== 'unit-review') || !isRecordObj(input)) return out;
  if (kind === 'unit-review' && boundedText(input.unit)) out.unit = input.unit;
  if (boundedText(input.review_execution)) out.review_execution = input.review_execution;
  const p = isRecordObj(input.primary) ? input.primary.outcome : undefined, so = isRecordObj(input.second_opinion) ? input.second_opinion.outcome : undefined;
  if (boundedText(p)) out.primary_outcome = p;
  if (boundedText(so)) out.second_opinion_outcome = so;
  return out;
}

/** Record one gate decision: lock, re-verify the binding, compute the candidate, decide, commit state + GATE event, deliver. */
export async function gate(ctx) {
  const input = gateInput(ctx.gate, ctx.input);
  try {
    return await locked(ctx, async (E) => {
      const unbound = verifyBinding(E);
      if (unbound.length) return { gate: ctx.gate, candidate_id: null, ...gateNo(unbound[0].code, unbound.map(j => j.reason), { judgment_point: true }) };
      if (ctx.gate === 'review' && input.units_consumed !== undefined && !unitReviewOn(E.S)) throw coded('bad_input', 'gate review: units_consumed needs a DAG with config.unitReview');
      if ((ctx.gate === 'reassess' || input.addendum !== undefined) && !securityOn(E.S)) throw coded('bad_input', `gate ${ctx.gate}: needs a DAG with config.securityPolicy 2`);
      await deliver(E);
      reconcileReviews(E);
      const c = io.candidateId(ctx.repoRoot, E.S.config.base ?? 'HEAD', E.S.pinned_exclusions);
      if (ctx.gate === 'reassess') E.candidatePaths = c.paths ?? [];
      // SHIP conjunction (Wave 3.5, seeded seed 20): a done node whose declared input or output drifted is not done.
      const drifted = ctx.gate === 'ship-ready' ? drift(E, { mutate: false }) : [];
      const v = drifted.length ? gateNo(drifted[0].code, drifted.map(j => `${j.node}: ${j.reason}`), { judgment_point: true })
        : c.candidate_id ? await GATES[ctx.gate](E, input, c.candidate_id)
        : gateNo('candidate_unavailable', [c.reason], { judgment_point: true });
      const S = E.S;
      // W3-record: appended after the existing keys only with config.auditRecord (the binding-drift return above records nothing).
      const audit = auditOn(S) ? () => gateAuditFields(ctx.gate, input, v) : () => ({});
      note(S, 'GATE', { gate: ctx.gate, ok: v.ok, code: v.code, ...audit() });
      S.outbox.push({ run_id: S.run_id, event: 'GATE', event_id: `gate-${S.run_id}-${S.seq}`, gate: ctx.gate, ok: v.ok, code: v.code,
        candidate_id: c.candidate_id ?? null, timestamp: new Date().toISOString(), ...audit() });
      await E.commit();
      await deliver(E);
      return { gate: ctx.gate, candidate_id: c.candidate_id ?? null, ...v };
    });
  } catch (e) {
    if (!GATE_REFUSALS.has(e.code)) throw e;
    return { gate: ctx.gate, ...gateNo(e.code, [e.message], { judgment_point: e.code !== 'lock_held' }) };
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const gateKind = cmd === 'gate' ? rest.shift() : undefined;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined || Object.hasOwn(flags, rest[i].slice(2))) throw new Error('bad or repeated flag: ' + rest[i]);
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  const allowed = ['repo', 'ticket', 'run-id', 'dag', 'until', 'node', 'transition', 'reason', 'input', 'unit'];
  const unknown = Object.keys(flags).filter(k => !allowed.includes(k));
  if (unknown.length || !flags.repo || !flags.ticket || !flags['run-id'] || (cmd === 'gate') !== Boolean(flags.input)) throw new Error('Usage: run-engine.mjs init|status|drive|resume|mark|clear-unit|rebind|archive --repo <dir> --ticket <key> --run-id <id> [--dag <file>] [--until <node>] [--node <id> --transition <t> --reason <text>] [--unit <unit>]\n       run-engine.mjs rebind --repo <dir> --ticket <key> --run-id <id> --reason <text>\n       run-engine.mjs gate red|review|ship-ready|unit-review|reassess --repo <dir> --ticket <key> --run-id <id> --input <json-file> [--unit <unit>]');
  const ctx = { repoRoot: resolve(flags.repo), ticket: flags.ticket, runId: flags['run-id'],
    ...(flags.dag ? { dagFile: resolve(flags.dag) } : {}), ...(flags.until ? { until: flags.until } : {}) };
  const commands = { init, status, drive, resume,
    mark: () => mark({ ...ctx, node: flags.node, transition: flags.transition, reason: flags.reason }),
    'clear-unit': () => clearUnitCmd({ ...ctx, unit: flags.unit }),
    rebind: () => rebind({ ...ctx, reason: flags.reason }),
    archive: () => archive({ ...ctx, ...(Object.keys(flags).some(k => !['repo', 'ticket', 'run-id'].includes(k)) ? { extra: 1 } : {}) }),
    gate: () => { let input; try { input = JSON.parse(readFileSync(flags.input, 'utf8')); } catch (e) { throw new Error(`gate input ${flags.input}: ${e.message}`); }
      if (flags.unit !== undefined) { // gate unit-review only: --unit names (or must equal) the input's unit
        if (gateKind !== 'unit-review' || (input?.unit !== undefined && input.unit !== flags.unit)) throw new Error('--unit is for gate unit-review and must equal the input unit');
        input = { ...input, unit: flags.unit };
      }
      return gate({ ...ctx, gate: gateKind, input }); } };
  if (!Object.hasOwn(commands, cmd)) throw new Error('unknown command ' + cmd);
  return commands[cmd](ctx);
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(r => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    if (r?.outcome === 'judgment' || (r?.gate && (!r.ok || r.judgment_point === true))) process.exitCode = 2;
  }).catch(e => { process.stderr.write(`run-engine: ${e.message}\n`); process.exitCode = 1; });
}
