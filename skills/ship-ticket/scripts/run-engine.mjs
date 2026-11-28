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
 *      run-engine.mjs reconcile --deadlines true ... (S1: the persisted-deadline sweep of a durable run; reconcileDeadlines)
 *        [--dag <file>] [--until <node>] [--node <id> --transition <t> --reason <text>] [--unit <unit>]
 *      run-engine.mjs archive ... [--retire true]; run-engine.mjs adopt ... --from <archive dir> (S-13a, engine-adopt.mjs)
 *      run-engine.mjs gate red|review|ship-ready|unit-review|reassess --repo <dir> --ticket <key> --run-id <id> --input <json-file> [--unit <unit>]
 *        prints { gate, ok, code, judgment_point, reasons, candidate_id, ... }; exit 0 accepted,
 *        2 refused or judgment point (incl. lock_held), 1 usage error (incl. an invalid input file).
 *      run-engine.mjs preflight --repo <dir> --ticket <key> --dag <file> [--plan <file>]
 *        plan-time dry run of init's plan and DAG checks (no START, state or write); exit 0 with the
 *        obligation matrix, 1 with `run-engine: <code>: ...` (F12a).
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, renameSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isEntrypoint } from './harness.mjs';
import { truncatedOutputs } from './run-summary.mjs';
import { eventLine } from './run-state.mjs';
import { childEnv, verifySubscription as cliSubscription } from './carrier.mjs';
import * as io from './engine-io.mjs';
import { planNarrativeDigest, validateEngineDag, closure, coded, judgment, note, normDigest, sha, runStateEvents, gateInput,
  BEGIN, END, legacyApproval, securityOn, pairKey, auditOn, evidenceEntries, flatEntry, baseRef, pinnedBaseOn, dagReadWriteConflicts } from './engine-dag.mjs';
import { reconcile, dispatchNodes, runRepairs, budgetVerdict, redPending, clearSpent } from './engine-attempts.mjs';
import { GATES, gateNo, refreshRed, redInvalidJudgments, securityPlan, catalogOptions, securityJudgments, designContract, testKindsModules, testKindsOn, testKindsStatus } from './engine-gates.mjs';
import { observeAuthority, trustedEvents, malformedRunState } from './engine-authority.mjs';
import { unretired, LIVE } from './engine-quiesce.mjs';
import { hasUnits, unitDrift, unitWork, runUnitChecks, bindingHeld, unitStates, unitJudgments, unitProjection, restoreCheckFailed, ceiling, clearUnit } from './engine-units.mjs';
import { unitReviewOn, unitReviewJudgments, withReviews, pendingReviews, reconcileReviews } from './engine-unit-review.mjs';
import { ENGINE_POLICY_VERSION, POLICY_SEMANTICS, TEST_KINDS_POLICY_VERSION, recordedVersion, runPolicy, skillCommit, pinnedVersion, durableVersion } from './engine-policy.mjs';
import { pinBaseRecord, baseStatus, baseCandidate, onBase, wellFormedBase } from './engine-base-read.mjs';
import { archiveRoot, readArchive, windowRefusal, sourceRefusal, adoptable, applyAdoption, retireRefusal, retireLive, retireObserve as observeForRetire, archiveFinality, sourceState } from './engine-adopt.mjs';
import { redChanges } from './engine-attempts.mjs';
import { claimsOn, waitingOf } from './engine-claims.mjs';
import { repoIdentityOn } from './engine-dag.mjs';
import { repoIdentityVersion } from './engine-policy.mjs';
import { identityStateHolds, bindIdentity } from './engine-identity.mjs';
import { enginePaths, durablePaths, legacyStatesAnywhere } from './lib/run-placement.mjs';
import { samePath } from './lib/run-log-paths.mjs';
import { observe, MEASUREMENT_QUALIFIED, resolveSweepClock } from './lib/deadline.mjs';
import { groupIdentity, retire } from './engine-quiesce.mjs';
import { settle } from './engine-attempts.mjs';

export { writeStateAtomic } from './engine-io.mjs';
/** The ticket's engine lock (S1: in the run's placement: an existing run's, else the default of a new run, durable). */
export const acquireLock = (ctx, options) => io.acquireLock(ctx?.lockFile ? ctx : { ...ctx, lockFile: enginePaths(ctx.repoRoot, ctx.ticket, { prefer: 'durable' }).lock }, options);
export { planNarrativeDigest, validateEngineDag } from './engine-dag.mjs';

const STATE_SCHEMA = 'ship-ticket-engine-state-v1';

/** The top level of the work tree at `repoRoot` (realpath when it exists), recorded on a durable run as `worktree`. */
function worktreeTop(repoRoot) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  const top = r.status === 0 ? r.stdout.trim() : resolve(repoRoot);
  try { return realpathSync(top); } catch { return resolve(top); }
}
const STATUS_SCHEMA = 'ship-ticket-engine-status-v1';
const CTX_KEYS = new Set(['repoRoot', 'ticket', 'runId', 'dagFile', 'env', 'verifySubscription', 'handleSignals', 'spawn',
  'pid', 'host', 'processInfo', 'groupAlive', 'platform', 'fs', 'hooks', 'allowApiBilling', 'until', 'admissionProbe', 'policy', 'catalogFile', 'now']);
CTX_KEYS.add('deadlineClock'); // S1: the in-process test clock of the deadline sweep (never set by the CLI)
CTX_KEYS.add('hostClaims'); // S2: test seam of the host claim store { dir, snapshot, now, docker, loadavg } (the CLI uses the default store)
const RUNNER_KINDS = ['gate-red', 'proof', 'unit-check', 'evidence'];
const MARKS = { 'failed->pending': ['failed', 'pending'], 'pending->cancelled': ['pending', 'cancelled'] };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RETRIES = 1;

/**
 * The run's files (S1: lib/run-placement.mjs, the one placement resolver). An existing state decides its placement
 * (legacy `--git-path` or the durable common-dir run directory); with none, `prefer` (init's choice from the DAG) or legacy.
 */
function locate(ctx, prefer = 'legacy') {
  if (!SAFE_ID.test(ctx?.ticket ?? '') || !SAFE_ID.test(ctx?.runId ?? '') || typeof ctx.repoRoot !== 'string')
    throw coded('bad_context', 'repoRoot, safe ticket and runId required');
  const F = enginePaths(ctx.repoRoot, ctx.ticket, { prefer });
  return { placement: F.placement, runDir: F.dir, lock: F.lock, state: F.state, log: F.log, usage: F.usage, attempts: F.attempts,
    planRel: `.specs/plans/${ctx.ticket}.md`, plan: join(ctx.repoRoot, '.specs', 'plans', ctx.ticket + '.md') };
}

/**
 * S1 (M1): init's placement. Every NEW run is durable (policy versions 13-24, engine-policy.mjs DURABLE_VERSION_OF) unless its
 * DAG sets the documented escape hatch `config.durableRun: false`, the environment sets SHIP_TICKET_PLACEMENT=legacy, or the engine (an injected ctx.policy of a test simulating
 * an engine without S1) has no durable versions. An unreadable DAG is durable too: init refuses it before writing anything.
 */
function initPlacement(ctx) {
  const semantics = (ctx.policy ?? { semantics: POLICY_SEMANTICS }).semantics;
  if (!Object.values(semantics).some(f => f?.durableRun === true)) return 'legacy';
  // the operational escape hatch (frozen-byte tests, an install that must keep per-worktree state): never bound by a DAG digest,
  // so a run's DAG is the same bytes on an engine with and without S1 (the origin/main differentials rely on it)
  if ((ctx.env ?? process.env).SHIP_TICKET_PLACEMENT === 'legacy') return 'legacy';
  try { return JSON.parse(readFileSync(ctx.dagFile, 'utf8'))?.config?.durableRun === false ? 'legacy' : 'durable'; } catch { return 'durable'; }
}

/** S1 (Codex 2): whether `S` is a durable run owned by another worktree than the caller's. */
function foreignWorktree(S, repoRoot) {
  return S?.durable !== undefined && !samePath(S.durable.worktree, worktreeTop(repoRoot));
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
function open(ctx, prefer) {
  const P = locate(ctx, prefer);
  const E = { ctx, P, S: null, policy: null, live: new Map(), refused: new Set(), lock: Promise.resolve(), verifyBinding: () => verifyBinding(E),
    stamps: { ev: new Map(), end: new Map() },
    alive: (pgid) => (ctx.groupAlive ?? ((g) => io.groupAlive(g, ctx.platform ?? process.platform)))(pgid),
    load() {
      if (!existsSync(P.state)) throw coded('no_state', `no engine state for ${ctx.ticket}; run init`);
      E.S = JSON.parse(readFileSync(P.state, 'utf8'));
      // S-27-min: before any default or check, the run's policy version must be one this engine supports (fail closed).
      E.policy = runPolicy(E.S, ctx.policy);
      // S-01b2 P5r: the version 2 flag, S.test_kinds and config.testKinds come together or not at all (rev 5 section 6 row 8)
      if (new Set([testKindsOn(E), E.S.test_kinds !== undefined, E.S.config?.testKinds !== undefined]).size !== 1)
        throw coded('test_kinds_state_missing', `policy_version ${E.S.policy_version}, test_kinds state and config.testKinds disagree: a partial activation is never resumed`);
      // V0 single-entry invariant (R1), re-checked on every load: P4r refuses two RECORDS, not two DECLARED entries
      if (E.S.test_kinds && evidenceEntries(E.S.config).map(([n]) => n).join() !== E.S.test_kinds.entry)
        throw coded('multi_entry_unsupported_v0', `the run's evidence entries (${evidenceEntries(E.S.config).map(([n]) => n).join(', ') || 'none'}) are not exactly its bound entry ${E.S.test_kinds.entry}`);
      // S-12: the pinned-base flag of the run's version, S.base and config.pinnedBase come together or not at all (no partial pin is resumed)
      // (S-12 Round 1: presence is the KEY, so a null/false/0 S.base counts; a pin must be well-formed, never read as no pin)
      if (new Set([E.policy.semantics.pinnedBase === true, Object.hasOwn(E.S, 'base'), pinnedBaseOn(E.S)]).size !== 1)
        throw coded('base_state_missing', `policy_version ${E.S.policy_version}, the pinned base state and config.pinnedBase disagree: a partial pin is never resumed`);
      if (Object.hasOwn(E.S, 'base') && !wellFormedBase(E.S.base))
        throw coded('base_state_missing', 'S.base is not a well-formed pin { remote, identity, ref, sha, merge_base, pinned_at_seq }: a partial pin is never resumed');
      // S-28a: the repository-identity flag of the run's version and config.repoIdentity come together; under it S.base names a
      // repository (not the converse: a v5-8 run on a GitHub origin records one too) and a freeze / SHIP_READY carries its exact base
      const repoIdentity = E.policy.semantics.repoIdentity === true;
      if (repoIdentity !== repoIdentityOn(E.S) || (repoIdentity && !identityStateHolds(E.S)))
        throw coded('identity_state_missing', `policy_version ${E.S.policy_version}: the repository identity state (config.repoIdentity, S.base.identity, the freeze and SHIP_READY base records) is partial or malformed: it is never resumed`);
      // S1: the durableRun flag of the run's version, S.durable and the placement come together or not at all
      if (new Set([E.policy.semantics.durableRun === true, Object.hasOwn(E.S, 'durable'), P.placement === 'durable']).size !== 1
        || (Object.hasOwn(E.S, 'durable') && !(E.S.durable && typeof E.S.durable.worktree === 'string' && E.S.durable.version === 1)))
        throw coded('durable_state_missing', `policy_version ${E.S.policy_version}, S.durable and the ${P.placement} placement of ${P.state} disagree: a partial durable run is never resumed`);
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
async function locked(ctx, fn, { load = true, waitMs, prefer, foreign = false } = {}) {
  const E = open(ctx, prefer);
  // S1: a durable run's lock lives in its common-dir run directory; a legacy run keeps its per-worktree lock (unchanged).
  const lockCtx = E.P.placement === 'durable' ? { ...ctx, lockFile: E.P.lock } : ctx;
  const lock = await (waitMs === undefined ? io.acquireLock(lockCtx) : io.acquireLock(lockCtx, { waitMs }));
  const onSignal = () => { lock.release().finally(() => process.exit(130)); };
  const signals = ctx.handleSignals === false ? [] : ['SIGINT', 'SIGTERM'];
  for (const s of signals) process.on(s, onSignal);
  try {
    if (load) {
      E.load();
      // S1 (Codex 2): ownership is checked right after the load, before any observation or write: a refused command leaves
      // the shared state byte-identical. A command allowed from elsewhere (`foreign`: the deadline sweep) never observes
      // authority from the caller's plan, which is not the run's.
      E.foreign = foreignWorktree(E.S, ctx.repoRoot);
      if (E.foreign && !foreign) throw coded('worktree_mismatch', `engine state of ${E.S.ticket} belongs to the worktree ${E.S.durable.worktree}, not ${ctx.repoRoot}`);
      if (!E.foreign) E.observe();
    }
    const out = await fn(E);
    if (E.S) { if (!E.foreign) E.observe(); await E.commit(); }
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
    ...(claimsOn(S) ? { waiting: waitingOf(E) } : {}), // S2 (Codex-3): capacity holds are waiting diagnostics, never judgments
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
  if (block.policy === 3) await bindObligations(sp, cat, block, nodes, ctx.repoRoot);
}

/** File-shaped DAG writes (a basename with an extension): the plan-time paths the surface inventory checks, path-only (L4: lines, extensionless and directory writes are checked at reassess, within its limits). */
const writtenFiles = (nodes) => [...new Set(nodes.flatMap(n => n.writes ?? []).filter(w => /.\.[A-Za-z0-9]+$/.test(w.split('/').pop())))].sort();

/**
 * Block format 3 (F12a) at init and preflight: the full surface x control obligation matrix must be complete
 * (security-plan.mjs obligationMatrix: every cell exactly one disposition, every dropped pair a cited, catalog-gated
 * fact; its refusal code is thrown as is), and every file-shaped DAG write whose path alone raises a surface-introducing
 * signal (test-named or not: no filename exemption) must be a listed surface (surface_inventory_incomplete). Line-based
 * signals and extensionless or directory writes are checked at reassess, within its limits (known limitation L4). Format 2 blocks are
 * not checked here (unchanged).
 */
async function bindObligations(sp, cat, block, nodes, root) {
  const m = sp.obligationMatrix(cat, block);
  if (!m.ok) throw coded(m.code, `the approved §3a obligation matrix does not verify: ${(m.reasons ?? []).join('; ')}`);
  const gaps = sp.inventoryGaps({ files: writtenFiles(nodes), surfacePaths: block.surfaces.map(s => s.path) });
  if (gaps.length) throw coded('surface_inventory_incomplete', `DAG-written path(s) raise a surface signal but no §3a surface lists them: ${gaps.map(g => `${g.path} (${g.kinds.join(', ')})`).join('; ')}`);
  // B3: plan time checks the repository tree; a cited file one of the nodes will write is deferred to gate review.
  const cited = sp.verifyCitations(block, { root, pending: [...new Set(nodes.flatMap(n => n.writes ?? []))] });
  if (!cited.ok) throw coded(cited.code, `a §3a surface-fact citation does not verify: ${(cited.reasons ?? []).join('; ')}`);
}

/**
 * F12a plan-time preflight: the checks `init` runs on the plan and DAG (validateEngineDag, bindSecurity, and for a
 * format-3 block the obligation matrix and inventory completeness), callable BEFORE approval: no lock, no state, no
 * START and no write. It also refuses a node that reads what a transitive dependent writes (dag_read_write_dependency,
 * STAB-410 F-9), a check init never runs. A DAG without config.securityPolicy is refused (security_policy_required: no START approves it).
 * ctx: { repoRoot, ticket, dagFile, planFile?, catalogFile? }. Returns the obligation matrix, or throws a coded refusal.
 */
export async function preflight(ctx) {
  if (!SAFE_ID.test(ctx?.ticket ?? '') || typeof ctx.repoRoot !== 'string') throw coded('bad_context', 'repoRoot and a safe ticket required');
  const planFile = ctx.planFile ?? join(ctx.repoRoot, '.specs', 'plans', ctx.ticket + '.md');
  let text, doc;
  try { text = readFileSync(planFile, 'utf8'); } catch { throw coded('plan_invalid', `plan ${planFile} unreadable`); }
  try { doc = JSON.parse(readFileSync(ctx.dagFile, 'utf8')); } catch { throw coded('dag_invalid', 'dagFile unreadable or not JSON'); }
  const dag = validateEngineDag(doc, { ticket: ctx.ticket });
  // STAB-410 F-9 (plan time only, never init): a node must not read what a transitive dependent writes.
  const rw = dagReadWriteConflicts(dag.nodes);
  if (rw.length) throw coded('dag_read_write_dependency', `node ${rw[0].reader} reads ${rw[0].read}, which its dependent node ${rw[0].writer} writes (${rw[0].write}): the write would make the finished reader stale; reorder the nodes or move the read${rw.length > 1 ? ` (${rw.length} such pairs: ${rw.map((c) => `${c.reader}<-${c.writer}`).join(', ')})` : ''}`);
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  const narrative = b >= 0 && e > b ? text.slice(0, b) + text.slice(e) : text;
  await bindSecurity(ctx, dag.config, dag.nodes, null, text, narrative);
  const sp = await securityPlan();
  const block = sp.parsePlanSecurityBlock(text);
  const m = sp.obligationMatrix(sp.loadCatalog(catalogOptions(ctx)), block);
  if (!m.ok) throw coded(m.code, `the §3a obligation matrix does not verify: ${(m.reasons ?? []).join('; ')}`);
  return { ok: true, code: 'preflight_ok', writes: 'none', block_format: block.policy, effective_pairs: block.pairs.length,
    dropped_pairs: (block.na_pairs ?? []).length, counts: m.counts, matrix_digest: m.matrix_digest, matrix: m.matrix };
}

/**
 * S-27-min: the policy version a new run is pinned to (this engine's, or the injected ctx.policy of a
 * test simulating another engine) and the commit of the skill checkout this module runs from.
 */
function newRunPolicy(ctx, active = false, obligations = false, pinned = false, identity = false, durable = false) {
  const engine = ctx.policy ?? { current: ENGINE_POLICY_VERSION, semantics: POLICY_SEMANTICS };
  // F12a: a format-3 security block pins version 3 (4 with test kinds); an engine whose semantics lack it refuses here.
  const version = obligations ? recordedVersion({ testKinds: active, obligations }) : active ? TEST_KINDS_POLICY_VERSION : engine.current;
  // S-12: a pinned base adds its flag to the version of the other flags (engine-policy.mjs PINNED_BASE_VERSION_OF)
  const pinnedOrNot = pinned ? pinnedVersion(version) : version;
  // S-28a: repoIdentity adds its flag to the pinned version (engine-policy.mjs REPO_IDENTITY_VERSION_OF)
  const flagged = identity ? repoIdentityVersion(pinnedOrNot) : pinnedOrNot;
  // S1 (M1): a durable run records the durable row of its other flags (13-24); an engine without one cannot start it
  const recorded = durable ? durableVersion(flagged, engine.semantics) : flagged;
  if (recorded === null) throw coded('policy_version_unsupported', `no durable-run policy version for policy_version ${flagged}`);
  return { policy_version: runPolicy({ policy_version: recorded }, engine).version,
    skill_commit: skillCommit(dirname(fileURLToPath(import.meta.url))) };
}

/**
 * S-01b2 P5r activation (design rev 5 section 5, rev 6 INIT rows): null for an inactive run (no plan carrier, no committed
 * declaration, no config.testKinds: nothing is bound and policy_version stays as before), else the bound S.test_kinds.
 * Refusals: test_kinds_policy_required, plan_tags_missing, test_kinds_needs_security_policy, requiredFor's first code,
 * declaration_invalid/base_invalid, test_kinds_runner_missing, multi_entry_unsupported_v0 (V0: kind evidence from exactly
 * ONE runner entry) and runner_unsupported (P4r readEntry: an unsupported runner is reported, never bypassed; commands
 * without `evidence` are untouched and still run in the proof). Without config.testKinds an unresolvable base is "no declaration".
 */
async function bindTestKinds(ctx, config, text, pinned = null) {
  const tk = await import('./test-kinds.mjs'); // the opt-in probe only: an inactive run never loads the evidence modules
  let declaration = null, baseSha = null;
  // S-12: a pinned run reads the declaration at its pinned merge base, through the base-read module
  try { ({ declaration, baseSha } = pinned ? onBase(pinned, () => tk.readDeclaration(ctx.repoRoot, baseRef(pinned))) : tk.readDeclaration(ctx.repoRoot, config.base ?? 'HEAD')); }
  catch (e) { if (config.testKinds !== undefined || !['base_invalid', 'repo_unavailable'].includes(e.code)) throw coded(e.code ?? 'declaration_invalid', e.message); }
  const opted = tk.optIn({ planText: text, declaration });
  if (config.testKinds === undefined) { if (opted) throw coded('test_kinds_policy_required', 'the plan or the base declaration opts in to test kinds, but the DAG has no config.testKinds'); return null; }
  if (!opted) throw coded('plan_tags_missing', 'config.testKinds needs a plan test-triggers line or a committed .ship-ticket/test-triggers.json');
  if (config.securityPolicy !== 2) throw coded('test_kinds_needs_security_policy', 'config.testKinds needs config.securityPolicy 2');
  const M = await testKindsModules(), req = M.tk.requiredFor({ planText: text, declaration, baseSha });
  if (req.status !== 'required') throw coded(req.errors[0] ?? 'test_kinds_error', `test kinds requirement refused: ${req.errors.join(', ')}`);
  const entries = evidenceEntries(config);
  if (!entries.length) throw coded('test_kinds_runner_missing', 'config.testKinds needs one config.testCommands entry with evidence');
  if (entries.length > 1) throw coded('multi_entry_unsupported_v0', `kind evidence comes from exactly one runner entry in V0, not ${entries.map(([n]) => n).join(', ')}`);
  try { M.io.readEntry(flatEntry(...entries[0])); } catch (e) { throw coded(M.io.codeOf(e, 'test_kinds_error'), `config.testCommands.${entries[0][0]} is not a supported evidence runner (V0: ${M.io.RUNNER.cmd} ${M.io.RUNNER.args.join(' ')} [{files}])`); }
  const line = text.slice(0, text.indexOf(BEGIN)).split(/\r?\n/).map(l => l.trimStart()).find(l => /^(?:risk_floor:[ \t]*)?risk-floor:/.test(l));
  const rec = M.rf.parseRecordedLine(line); // requiredFor already validated exactly one strict line
  return { base_sha: baseSha, policy: 1, entry: entries[0][0], bound: { tags: req.tags, items: req.items, kinds: req.provenance, protected: [] }, declaration,
    floor: { line, claimed: rec.claimed, ai: rec.ai }, tests: { globs: declaration?.tests?.globs ?? [] }, records: {}, refused: null, freeze_evidence: null };
}

/** Create the state ledger after verifying the approved narrative, the DAG binding and the pinned exclusions. */
export async function init(ctx) {
  const placement = initPlacement(ctx);
  // S1 (Codex 3): every init of a ticket, in either placement and from any worktree, reserves its placement under ONE
  // common lock (the durable run directory's lock, which a durable init also runs under), so a legacy and a durable init
  // can never both publish. A legacy init takes it in addition to its own per-worktree lock.
  const reserve = placement === 'legacy' ? await io.acquireLock({ ...ctx, lockFile: durablePaths(ctx.repoRoot, ctx.ticket).lock }) : null;
  try { return await initLocked(ctx, placement); } finally { await reserve?.release(); }
}

/** The placement conflict of a new run of `ticket` (a state in the other placement, in ANY worktree), or null. */
function placementConflict(ctx, placement) {
  if (placement === 'legacy') { const D = durablePaths(ctx.repoRoot, ctx.ticket); return existsSync(D.state) ? D.state : null; }
  return legacyStatesAnywhere(ctx.repoRoot, ctx.ticket)[0] ?? null;
}

async function initLocked(ctx, placement) {
  return locked(ctx, async (E) => {
    if (existsSync(E.P.state)) throw coded('state_exists', `${E.P.state} already exists`);
    const conflict = () => {
      const other = placementConflict(ctx, E.P.placement);
      if (other) throw coded('state_exists', `engine state of ${ctx.ticket} already exists at ${other} (another placement or worktree); finish or archive that run (run-engine.mjs archive --retire true from its worktree) before starting a new one`);
    };
    conflict();
    const { text, digest, events, start } = approvedPlan(ctx, E.P);
    let raw;
    try { raw = readFileSync(ctx.dagFile); } catch { throw coded('dag_invalid', 'dagFile unreadable'); }
    let doc;
    try { doc = JSON.parse(raw); } catch { throw coded('dag_invalid', 'DAG is not JSON'); }
    const dag = validateEngineDag(doc, { ticket: ctx.ticket });
    const dagDigest = sha(raw);
    const narrative = text.slice(0, text.indexOf(BEGIN)) + text.slice(text.indexOf(END));
    await bindSecurity(ctx, dag.config, dag.nodes, start, text, narrative);
    const obligations = dag.config.securityPolicy === 2 && (await securityPlan()).parsePlanSecurityBlock(text)?.policy === 3;
    // S-28a: trust on first use from ONE snapshot of the remote's URLs (engine-identity.mjs bindIdentity): remote_ambiguous, or
    // identity_unbound when it names no repository on github.com (nothing written); the pin is then read by that snapshot only
    const idBound = repoIdentityOn(dag) ? bindIdentity(ctx.repoRoot, dag.config.pinnedBase.remote) : null;
    if (idBound && !idBound.ok) throw coded(idBound.code, idBound.reasons.join('; '));
    const pin = pinnedBaseOn(dag) ? pinBaseRecord(ctx.repoRoot, dag.config, idBound?.record) : null; // before the declaration read: it reads at the base
    const testKinds = await bindTestKinds(ctx, dag.config, text, pin ? { base: pin.base, config: dag.config } : null);
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
        .map(u => [u, { chain: [] }])) } : {}),
      ...newRunPolicy(ctx, testKinds !== null, obligations, pin !== null, repoIdentityOn(dag), E.P.placement === 'durable'), ...(testKinds ? { test_kinds: testKinds } : {}),
      ...(E.P.placement === 'durable' ? { durable: { version: 1, worktree: worktreeTop(ctx.repoRoot) } } : {}) };
    if (pin) {
      note(E.S, 'BASE_PINNED', { ...pin.base });
      E.S.base = { ...pin.base, pinned_at_seq: E.S.seq };
      if (repoIdentityOn(dag)) note(E.S, 'IDENTITY_BOUND', { remote: pin.base.remote, identity: pin.base.identity });
      if (pin.local !== undefined && pin.local !== pin.base.merge_base)
        note(E.S, 'BASE_LOCAL_DIVERGED', { advisory: true, ref: dag.config.base, expected: pin.base.merge_base, observed: pin.local });
    }
    E.observe(); // no attempt exists yet: every authority line present at init is trusted
    conflict(); // S1 (Codex 3): revalidated under the reservation lock right before publication
    await E.commit();
    return { state_file: E.P.state, run_id: ctx.runId, plan_digest: digest, dag_digest: dagDigest, binding };
  }, { load: false, prefer: placement });
}

/** Read-only STATUS (freeze drift is reported, nothing is written). */
export async function status(ctx) {
  const E = open(ctx);
  E.load();
  reconcileReviews(E); // in memory only: status writes nothing
  const out = view(E, drift(E, { mutate: false }));
  if (testKindsOn(E)) out.test_kinds = await testKindsStatus(E);
  if (E.S.base) out.base = baseStatus(E); // S-12: advisory only (never a judgment), and only for a pinned run
  return out;
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
    // S2: the one host-scoped escalation (an unknown claim holder) is a judgment; a plain capacity hold is `waiting` only.
    if (E.hostBlocked) transient.push(judgment('host_blocked', null, `unknown host claim holder(s) ${E.hostBlocked.op_ids.join(', ')} stay charged; resolve them (prove the group gone or remove the record); light work continues`));
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
 * freeze (TICKET-A). Re-binds the drifted done nodes' fingerprints to the work tree, and only when
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
    const c = baseCandidate(ctx.repoRoot, S, S.pinned_exclusions);
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
 * deletes (TICKET-A lost its state, engine log and usage ledger that way). Destination:
 * <git common dir>/ai-skills/ship-ticket/archive/<ticket>/<run-id>-<n>/ with state.json,
 * engine.jsonl, usage.jsonl (when present) and manifest.json { ticket, run_id, archived_at,
 * files: name -> sha256 }. Takes the lock but neither observes nor commits (engine state and RUN-STATE
 * observation are untouched, so the copy is the state as left behind); refuses another run's id
 * (`run_mismatch`); never overwrites an earlier archive.
 * `retire: true` (S-13a, OD-1) then moves the live state, engine log and usage into <archive>/retired/ so a new run can `init`:
 * refused while an attempt is live or unretired (`retire_live_attempts`) or when the live bytes differ from the copy
 * (`retire_mismatch`); files are renamed, never deleted, the state last (engine-adopt.mjs retireLive).
 */
export async function archive(ctx) {
  const extra = Object.keys(ctx ?? {}).filter(k => !CTX_KEYS.has(k) && k !== 'retire');
  if (extra.length || ![undefined, true].includes(ctx.retire)) throw coded('archive_refused', `archive takes only retire: true (got ${extra.length ? extra : `retire ${ctx.retire}`})`);
  return locked(ctx, async (E) => {
    if (!existsSync(E.P.state)) throw coded('no_state', `no engine state for ${ctx.ticket}; run init`);
    let runId, raw;
    try { raw = JSON.parse(readFileSync(E.P.state, 'utf8')); runId = raw.run_id; } catch { throw coded('state_unreadable', `${E.P.state} is not valid JSON`); }
    if (runId !== ctx.runId) throw coded('run_mismatch', `engine state belongs to run ${runId}, not ${ctx.runId}`);
    // S1 (Codex 2, m9): a durable run is archived from any worktree (its own may be gone); --retire from another worktree
    // only once the owning worktree no longer exists, and then without observing the caller's plan (not the run's).
    const foreign = foreignWorktree(raw, ctx.repoRoot);
    if (foreign && ctx.retire && existsSync(raw.durable.worktree))
      throw coded('worktree_mismatch', `engine state of ${ctx.ticket} belongs to the worktree ${raw.durable.worktree}, not ${ctx.repoRoot}; retire it from there`);
    const busy = ctx.retire ? retireRefusal(raw) : null;
    if (busy) throw coded('retire_live_attempts', busy);
    // retire finishes the RUN-STATE observation first and persists it, so the archived (final) state has classified every line
    // from another worktree (its own gone) nothing is observed: the caller's plan is not the run's
    const retireObserve = foreign ? (S) => S.authority !== undefined && S.authority !== null : observeForRetire;
    const authorityPresent = ctx.retire ? retireObserve(raw, io.readIfExists(E.P.plan), E.alive) : null;
    if (ctx.retire) await io.writeStateAtomic(E.P.state, raw, { hooks: ctx.hooks, fs: ctx.fs, platform: ctx.platform });
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
      // S1: a durable run also preserves the outputs its records reference (attempts/: worker .out, envelopes, plan
      // snapshots), with their own sha256 list (outputs.json); manifest.json and its file set are unchanged.
      if (E.P.placement === 'durable' && existsSync(E.P.attempts)) {
        cpSync(E.P.attempts, join(stage, 'outputs', 'attempts'), { recursive: true, verbatimSymlinks: true });
        const listed = Object.fromEntries(readdirSync(join(stage, 'outputs', 'attempts')).sort()
          .map(f => [f, sha(readFileSync(join(stage, 'outputs', 'attempts', f)))]));
        writeFileSync(join(stage, 'outputs.json'), JSON.stringify({ ticket: ctx.ticket, run_id: ctx.runId, attempts: listed }, null, 2) + '\n');
      }
      renameSync(stage, dir);
    } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
    if (!ctx.retire) return { archive: dir, files };
    // S1: the run directory's attempts/ is renamed (never deleted) into the archive BEFORE the engine files (m8), so a new
    // run starts clean and a crash never strands a retired run's outputs beside a new run.
    const retired = await retireLive({ dir, files, sources: { 'state.json': E.P.state, 'engine.jsonl': E.P.log, 'usage.jsonl': E.P.usage }, hooks: ctx.hooks,
      record: { run_id: runId, final_seq: raw.seq, authority_present: authorityPresent },
      moveFirst: E.P.placement === 'durable' && existsSync(E.P.attempts) ? [[E.P.attempts, 'attempts']] : [] });
    return { archive: dir, files, retired };
  }, { load: false });
}

/**
 * S1 (P1): the deadline sweep, `reconcile --deadlines true`: an enforcer that is NOT the launcher of the attempts it
 * checks. Invoked in-session (no scheduler is installed). It runs under the run's lock: a driving process holds that lock
 * for its whole command, so while one is alive (even hung) the sweep waits for the lock and that driver's in-process timers
 * are the only bound. Durable runs only (`deadlines_unsupported` otherwise: a legacy attempt has no persisted deadline). It
 * may run from another worktree than the run's (its own may be gone); it then never observes that caller's plan and never
 * records ownership or fingerprints against the caller's tree (an expired attempt is settled by the timeout branch only).
 *
 * The D5 measurement is UNQUALIFIED (lib/deadline.mjs MEASUREMENT_QUALIFIED false), and resolveSweepClock is the gate: the
 * CLI binds no clock, so the sweep measures nothing and signals nothing; each released LIVE attempt with a persisted
 * deadline records `deadline.last_sweep { measured: false, reason: 'measurement_unqualified', identity }`. With a clock
 * (only an in-process testClock() until G0 passes):
 * - expired while the group is 'verified' (engine-quiesce.mjs groupIdentity: leader alive with exactly the recorded
 *   `leader_start`): `deadline.over_while_alive` is recorded, the group is killed, and the attempt is settled through
 *   settle(..., { timedOut, deadlineWins }): `timed_out`, an envelope written after the deadline kept as `late_envelope`.
 * - expired with identity 'unknown' (null or mismatched leader_start, a failed probe, a dead leader with live members): NO
 *   signal; status `unknown`, a quiescence_unknown judgment, every lock kept (capacity stays charged).
 * - group 'gone': a timeout only when an over-limit charge was recorded while it was verified alive (L1); otherwise the
 *   charge cannot tell when it ended, nothing is invented: the attempt is left to `resume` (action none).
 * - another boot id: proven gone by boot identity (no probe, no signal), settled through settle(..., { bootEnded }) in the
 *   owning worktree (an envelope from before the reboot is recorded normally); the unmeasured interval is recorded.
 * `deadline.timed_out` is written only when the attempt really ends `timed_out`.
 * Returns { ticket, run_id, measurement, swept: [{ attempt_id, kind, identity, action, charged_ms?, status }] }.
 */
export async function reconcileDeadlines(ctx) {
  const clock = resolveSweepClock(ctx.deadlineClock); // throws deadline_clock_refused for any non-test injected clock
  return locked(ctx, async (E) => {
    if (E.P.placement !== 'durable') throw coded('deadlines_unsupported', `${ctx.ticket} is not a durable run: its attempts carry no persisted deadline`);
    if (E.S.run_id !== ctx.runId) throw coded('run_mismatch', `engine state belongs to run ${E.S.run_id}, not ${ctx.runId}`);
    const measurement = clock === null ? 'unqualified' : MEASUREMENT_QUALIFIED ? 'qualified' : 'test_clock';
    const swept = [];
    const unknown = (a, reason) => {
      a.status = 'unknown';
      if (!E.S.judgments.some(j => j.code === 'quiescence_unknown' && j.node === a.node)) E.S.judgments.push(judgment('quiescence_unknown', a.node, reason));
    };
    const runner = (a) => RUNNER_KINDS.includes(a.kind);
    for (const a of E.S.attempts) {
      if (!LIVE.includes(a.status) || !a.deadline || a.pid === undefined || a.pid === null) continue;
      const identity = groupIdentity(a, E.alive);
      const row = { attempt_id: a.attempt_id, kind: a.kind, identity };
      if (clock === null) {
        a.deadline.last_sweep = { measured: false, reason: 'measurement_unqualified', identity };
        swept.push({ ...row, action: 'none', reason: 'measurement_unqualified', status: a.status });
        continue;
      }
      const m = observe(a.deadline, clock);
      row.charged_ms = m.charged_ms;
      if (m.boot_ended) {
        if (runner(a) || E.foreign) {
          await retire(E.S, a, E.alive, runner(a) ? 'abandoned' : 'crashed', { bootEnded: true });
          const item = a.kind === 'repair' ? E.S.repairs.find(r => r.id === a.node) : E.S.nodes[a.node];
          if (!runner(a) && item) { item.state = 'failed'; item.reason = 'the host rebooted during the attempt (settled from another worktree; ownership not checked)'; }
        } else await settle(E, a, { bootEnded: true });
        swept.push({ ...row, identity: 'gone_by_boot', action: 'settled', status: a.status });
        continue;
      }
      if (identity === 'verified' && m.measured && m.expired) a.deadline.over_while_alive = { charged_ms: m.charged_ms };
      const overAlive = a.deadline.over_while_alive !== undefined;
      if (!m.measured || !m.expired || (identity === 'gone' && !overAlive)) { swept.push({ ...row, action: 'none', status: a.status }); continue; }
      if (identity === 'unknown') {
        unknown(a, `deadline of ${a.attempt_id} expired (${m.charged_ms}/${a.deadline.limit_ms} ms) but its process group ${a.pgid ?? a.pid} has no verified identity: not signalled, its capacity stays charged`);
        swept.push({ ...row, action: 'no_signal', status: a.status });
        continue;
      }
      if (identity === 'verified') await io.killGroup(a.pgid, E.alive);
      if (runner(a)) { if (!(await retire(E.S, a, E.alive, 'timed_out'))) unknown(a, `cannot prove ${a.kind} runner group ${a.pgid} has exited after its deadline`); }
      else await settle(E, a, { timedOut: true, deadlineWins: true });
      if (a.status === 'timed_out') a.deadline.timed_out = { charged_ms: m.charged_ms, signalled: identity === 'verified' };
      swept.push({ ...row, action: identity === 'verified' ? 'killed' : 'settled', status: a.status });
    }
    if (swept.length) note(E.S, 'DEADLINE_SWEEP', { measurement, swept: swept.map(r => ({ attempt_id: r.attempt_id, action: r.action, status: r.status })) });
    return { ticket: ctx.ticket, run_id: ctx.runId, measurement, swept };
  }, { foreign: true });
}

/** How long a second `adopt` waits for the ticket lock before lock_timeout (it then finds the window spent). */
const ADOPT_LOCK_WAIT_MS = 30000;

/**
 * S-13a: adopt the still-valid done nodes and RED evidence of the archived run at `from` into this new run (engine-adopt.mjs).
 * Attended and owner-invoked; no authority of its own (the new run's trusted START is the approval). A whole refusal throws
 * (exit 1) and writes nothing; otherwise the one commit of `locked` persists every adopted node, the carried RED and one
 * ADOPTED engine note. A RED that cannot be carried is the judgment adopt_red_unverified/adopt_red_missing (exit 2).
 */
export async function adopt(ctx) {
  const extra = Object.keys(ctx ?? {}).filter(k => !CTX_KEYS.has(k) && k !== 'from');
  if (extra.length || typeof ctx.from !== 'string' || !ctx.from) throw coded('adopt_refused', `adopt takes --from <archive dir> and no other fields${extra.length ? ` (got ${extra})` : ''}`);
  return locked(ctx, async (E) => {
    const unbound = verifyBinding(E);
    if (unbound.length) throw coded(unbound[0].code, unbound.map(j => j.reason).join('; '));
    const closed = windowRefusal(E.S);
    if (closed) throw coded('adoption_window_closed', `${closed}: adoption happens once, right after init`);
    const src = readArchive(ctx.from, { root: archiveRoot(ctx.repoRoot, ctx.ticket), ticket: ctx.ticket, runId: ctx.runId });
    const ss = sourceState(src, { planText: io.readIfExists(E.P.plan), isAlive: E.alive, final: archiveFinality(src) });
    const no = sourceRefusal(ss, E.S, ctx.policy);
    if (no) throw coded(no.code, no.reason);
    const v = adoptable({ newS: E.S, oldS: ss.state, fingerprints: (paths) => io.fingerprints(ctx.repoRoot, paths), redChanges: (ev) => redChanges(E, ev) });
    applyAdoption(E.S, src, v, ss.roster);
    const out = view(E);
    return { ...out, adoption: { from: src.dir, from_run: src.state.run_id, adopted: v.adopted, rejected: v.rejected, red_carried: Object.keys(v.red).sort() },
      outcome: v.judgments.length ? 'judgment' : 'adopted' };
  }, { waitMs: ADOPT_LOCK_WAIT_MS });
}

const GATE_REFUSALS = new Set(['worktree_mismatch', 'durable_state_missing', 'state_placement_ambiguous', 'lock_held', 'lock_foreign_host', 'lock_malformed', 'no_state', 'policy_version_unsupported', 'test_kinds_state_missing', 'multi_entry_unsupported_v0', 'base_state_missing', 'identity_state_missing']);

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
      const c = baseCandidate(ctx.repoRoot, E.S, E.S.pinned_exclusions);
      if (ctx.gate === 'reassess') E.candidatePaths = c.paths ?? [];
      // SHIP conjunction (Wave 3.5, seeded seed 20): a done node whose declared input or output drifted is not done.
      const drifted = ctx.gate === 'ship-ready' ? drift(E, { mutate: false }) : [];
      let v = drifted.length ? gateNo(drifted[0].code, drifted.map(j => `${j.node}: ${j.reason}`), { judgment_point: true })
        : c.candidate_id ? await GATES[ctx.gate](E, input, c.candidate_id)
        : gateNo('candidate_unavailable', [c.reason], { judgment_point: true });
      // S2 (m1): on the gate path too, a hold beside an unknown holder escalates as the host-scoped Blocked.
      if (v.code === 'host_held' && E.hostBlocked) v = gateNo('host_blocked', [`unknown host claim holder(s) ${E.hostBlocked.op_ids.join(', ')} stay charged; resolve them (prove the group gone or remove the record)`, ...(v.reasons ?? [])], { judgment_point: true });
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
  if (cmd === 'preflight') { // F12a: plan-time, before approval: no run id, no state, no write
    const extra = Object.keys(flags).filter(k => !['repo', 'ticket', 'dag', 'plan'].includes(k));
    if (extra.length || !flags.repo || !flags.ticket || !flags.dag) throw new Error('Usage: run-engine.mjs preflight --repo <dir> --ticket <key> --dag <file> [--plan <file>]');
    return preflight({ repoRoot: resolve(flags.repo), ticket: flags.ticket, dagFile: resolve(flags.dag), ...(flags.plan ? { planFile: resolve(flags.plan) } : {}) });
  }
  const allowed = ['repo', 'ticket', 'run-id', 'dag', 'until', 'node', 'transition', 'reason', 'input', 'unit', 'retire', 'from', 'deadlines'];
  const unknown = Object.keys(flags).filter(k => !allowed.includes(k));
  if (unknown.length || !flags.repo || !flags.ticket || !flags['run-id'] || (cmd === 'gate') !== Boolean(flags.input)) throw new Error('Usage: run-engine.mjs init|status|drive|resume|mark|clear-unit|rebind|archive|adopt --repo <dir> --ticket <key> --run-id <id> [--dag <file>] [--until <node>] [--node <id> --transition <t> --reason <text>] [--unit <unit>]\n       run-engine.mjs rebind --repo <dir> --ticket <key> --run-id <id> --reason <text>\n       run-engine.mjs archive ... [--retire true] | adopt ... --from <archive dir>\n       run-engine.mjs gate red|review|ship-ready|unit-review|reassess --repo <dir> --ticket <key> --run-id <id> --input <json-file> [--unit <unit>]');
  const ctx = { repoRoot: resolve(flags.repo), ticket: flags.ticket, runId: flags['run-id'],
    ...(flags.dag ? { dagFile: resolve(flags.dag) } : {}), ...(flags.until ? { until: flags.until } : {}) };
  const commands = { init, status, drive, resume,
    reconcile: () => { if (flags.deadlines !== 'true') throw new Error('Usage: run-engine.mjs reconcile --deadlines true --repo <dir> --ticket <key> --run-id <id>');
      return reconcileDeadlines(ctx); },
    mark: () => mark({ ...ctx, node: flags.node, transition: flags.transition, reason: flags.reason }),
    'clear-unit': () => clearUnitCmd({ ...ctx, unit: flags.unit }),
    rebind: () => rebind({ ...ctx, reason: flags.reason }),
    archive: () => archive({ ...ctx, ...(flags.retire !== undefined ? { retire: flags.retire === 'true' ? true : flags.retire } : {}),
      ...(Object.keys(flags).some(k => !['repo', 'ticket', 'run-id', 'retire'].includes(k)) ? { extra: 1 } : {}) }),
    adopt: () => adopt({ ...ctx, from: flags.from, ...(Object.keys(flags).some(k => !['repo', 'ticket', 'run-id', 'from'].includes(k)) ? { extra: 1 } : {}) }),
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
