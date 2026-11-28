#!/usr/bin/env node
/**
 * The ship-ticket supervisor (PR-5 / S7a; CONSOLIDATED §7 P3, §7.1, §8 P3; TRACK-B row S7a). The SMALLEST reliable driver
 * of an approved wave: it reuses the wave model (wave.mjs), the accepted view and its next step (engine-accepted.mjs), the
 * carrier's routing (carrier.mjs prepareAgentTask: the same tier -> modelMap code as every writer), the engine's durable
 * launcher (engine-io.mjs startLauncher: own process group, release handshake, atomic completion envelope), the engine's
 * process identity (engine-quiesce.mjs), the persisted deadline record (lib/deadline.mjs) and its durable I/O
 * (supervisor-journal.mjs on lib/durable-io.mjs). It adds no scheduler, no new store beyond the one wave journal, and no
 * merge: Automatic Merge is persisted and enforced as "never merged here" until the merge executor (PR-6b) exists.
 *
 * CLI (exit 0 done, 2 refused, 1 usage):
 *   supervisor.mjs tick   --wave <manifest> [--state-dir <dir>]   one-shot, under the journal lock (a held lock is a no-op)
 *   supervisor.mjs sweep  --wave <manifest> [--state-dir <dir>]   deadline enforcement, never under the journal lock
 *   supervisor.mjs install|uninstall --wave <manifest> [--state-dir <dir>] [--write true]
 *     prints the two LaunchAgent plists (tick, sweep) and their paths; only `--write true` writes (or removes) them, and only
 *     under ~/Library/LaunchAgents. It never runs launchctl: bootstrapping is an owner action (H3).
 *
 * TICK (one-shot; launchd StartInterval, no KeepAlive): take the journal lock (busy -> exit, no overlap), record its own
 * identity and bound, bind the wave (manifest digest + merge strategy, fixed at the first tick; a later change is refused as
 * a plan change), settle every unsettled op (envelopes, probes), then for each READY ticket in admission order
 * (evaluateReadiness/admissionOrder over the engine-derived states, with journal-Blocked tickets overlaid as failed so their
 * dependents hold and independent tickets continue): readRun + nextStep and at most one effect:
 *   run drive | gate red | gate reassess | gate ship-ready -> a launch op through the host-admission adapter (admittedCommand)
 *   dispatch review original                -> three read-only launch ops (primary, second opinion, reconcile), then ONE
 *                                              collect op that records the assembled input with `gate review` once
 *                                              (second opinion: the approved manifest routes, see SECOND OPINION below)
 *   dispatch review confirmation            -> primary + second-opinion legs, then the collect op (no reconciliation)
 *   stop owner_publish                      -> recorded ship-ready; merge per the persisted strategy (never merged here)
 *   stop after two failed review rounds     -> an RCA op (routed agent task) -> a different evidence-backed path ->
 *                                              `succeed` (PR-4b: not merged, refused -> ticket Blocked), else ticket Blocked
 *   any stop needing an authority event     -> refused (requestAuthority), the ticket alone is Blocked
 *   every other engine stop                 -> PARKED (recomputed every tick from the engine; never journal-Blocked)
 * Journal-Blocked (permanent for this wave) is reserved for the supervisor's own dead ends: an exhausted ambiguous op, a
 * failed or refused review leg, a refused authority need, an exhausted recovery. There is no unblock command (owner: a new
 * wave journal).
 * Never drives or repairs a ticket while any op of it is live (a review in flight included). A third review of the same
 * loop is never dispatched: two FAILs in the engine's review_chain route to recovery.
 *
 * LAUNCH OP (supervisor-journal.mjs protocol): intent (op id fixed from persisted state) -> receipt file -> launcher spawned
 * (detached, its own group) -> pid, pgid, leader_start and the persisted deadline committed WHILE STILL AT intent -> release
 * byte -> acted. So an op at intent without a pid was never released (re-acted under the same id); with a pid it is
 * ambiguous (never replayed; the envelope or the group identity settles it, else bounded re-probe -> Blocked).
 *
 * SWEEP (a separate launchd job, so a hung tick cannot stop enforcement): `run-engine reconcile --deadlines true` per
 * durable run (bounded subprocess), then the journal's own ops and the running tick: lock-free read, persisted deadline
 * observed with the clock resolveSweepClock allows, only an identity-VERIFIED expired group is signalled (killGroup), and
 * the timeout is recorded only if the journal lock is free (else the next tick settles it from the group identity).
 * UNQUALIFIED: lib/deadline MEASUREMENT_QUALIFIED is false (G0 not passed), so in production resolveSweepClock gives no
 * clock and the sweep measures and signals nothing (reported `unmeasured`); tests inject a testClock().
 *
 * SECOND OPINION (PR-5b, S7 Option A): its routes are the owner's CONFIGURATION, never this file's: the ordered
 * `review_routes` entries of role `second_opinion` in the approved wave manifest (wave.mjs; digest-bound, persisted in the
 * wave binding, so a changed list is `wave_plan_changed`). A provider id is resolved only through the carrier's adapter lookup
 * (supportsAgentProvider; an unknown id or no second_opinion route refuses the wave). ONE attempt per route, in order, each on
 * its budget (route budget_ms, default SECOND_OPINION_BUDGET_MS); the next route only after the previous one was unusable
 * (failed, refused, timed out, no artifact such as a usage-limit reply). None usable -> that ticket alone is Blocked
 * `second_opinion_unavailable`. Provenance: the requested route is stamped at intent; what the carrier adapter built (provider,
 * model, argv) and, when the provider reports it, the model it served must match it, else `second_opinion_provenance_mismatch`
 * (a refusal, never a pass and never a fallback). The artifact's route and reviewer_identity are stamped `<provider>:<model>`
 * from the launch; the collect op records `second_opinion: <provider:model>` and `same_provider` (vs the primary's provider).
 *
 * PR-2 SEAM: real host admission is `host-admit.mjs run -- <cmd>` (merged with PR-2: claim, derived weight, stdout passed
 * through, a hold exits ADMISSION_HELD_EXIT 75; a permanent refusal exits 2 and reads as nothing_ran). Every heavy command goes
 * through `admittedCommand` only, so it is re-pointed in one place; exit ADMISSION_HELD_EXIT is read as "held, nothing ran".
 * A hold is never a Block (PR-5b): the next attempt is paced (HOLD_RETRY_*), so the journal grows by at most one op per
 * HOLD_RETRY_MAX_MS per held op; after HOLD_LONG_MS the tick output flags `long_hold` for the owner, the retries continue.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { isEntrypoint } from './harness.mjs';
import { parseManifest, verifyWave, readTicket, evaluateReadiness, admissionOrder, mergeStrategyOf, reviewRoutesOf } from './wave.mjs';
import { readRun, nextStep } from './engine-accepted.mjs';
import { prepareAgentTask, childEnv, verifySubscription, spawnSpec, supportsAgentProvider } from './carrier.mjs';
import { extractUsage } from './usage.mjs';
import { startLauncher, RELEASE, groupAlive, commonGitDir, boundary } from './engine-io.mjs';
import { finalMessage } from './worker-report.mjs';
import { groupIdentity, killGroup, leaderStart, processInfo, sameStart } from './engine-quiesce.mjs';
import { armRecord, observe, resolveSweepClock } from './lib/deadline.mjs';
import { enginePaths } from './lib/run-placement.mjs';
import { AUTHORITY_EVENTS } from './run-state.mjs';
import { journalPaths, withJournal, readJournal, opId, repoId, coded, MAX_PROBES } from './supervisor-journal.mjs';
import { GATE_FIELDS } from './engine-dag.mjs';
import { ADMISSION_HELD_EXIT } from './host-admit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SUPERVISOR_SCHEMA = 'ship-ticket-supervisor-v1';
export const RUN_ENGINE = join(HERE, 'run-engine.mjs');
export const HOST_ADMIT = join(HERE, 'host-admit.mjs');
/** The tick's own bound (also its in-process watchdog); the sweep kills a tick past it (identity-verified). */
export const TICK_BOUND_MS = 15 * 60 * 1000;
/** F3: a persisted bound on each supervisor-launched `drive` (supplementary liveness watchdog, not the attempt deadlines). */
export const DRIVE_BOUND_MS = 4 * 60 * 60 * 1000;
export const GATE_BOUND_MS = 2 * 60 * 60 * 1000;
export const AGENT_BOUND_MS = 45 * 60 * 1000;
/** PR-5b: the policy's per-attempt budget of a second-opinion route (cross-model.md: 10 minutes); a route's budget_ms may lower it. */
export const SECOND_OPINION_BUDGET_MS = 10 * 60 * 1000;
const PROVENANCE_MISMATCH = 'second_opinion_provenance_mismatch';
export const RECONCILE_BOUND_MS = 120 * 1000;
/** PR-2 seam: the exit status by which `host-admit run` reports "held, the command did not run" (host-admit.mjs owns it). */
export { ADMISSION_HELD_EXIT };
/**
 * Outcomes that mean NOTHING RAN (the command never took effect in the engine): re-tried under a derived generation
 * `<gen>.r<k>`. `nothing_ran` (the engine recorded nothing: its run lock was held, a usage/bad_input refusal, an eventless gate
 * refusal, a wrapper or fork failure, a kill) at most RETRY_LIMITS.nothing_ran times, then the ticket alone is Blocked naming
 * the op. `held` (admission held it) is NEVER a Block (PR-5b): it is re-tried without a count limit, paced below.
 */
export const RETRY_LIMITS = Object.freeze({ nothing_ran: 4 });
const RETRYABLE = new Set(['held', 'nothing_ran']);
/** PR-5b hold pacing: the wait after the k-th consecutive hold is min(MAX, BASE * 2^(k-1)); LONG flags a long hold (no Block). */
export const HOLD_RETRY_BASE_MS = 60 * 1000;
export const HOLD_RETRY_MAX_MS = 30 * 60 * 1000;
export const HOLD_LONG_MS = 24 * 60 * 60 * 1000;
/** PR-5b: tick and sweep start at decorrelated offsets (launchd starts both at load), so lock collisions do not repeat in lockstep. */
export const START_JITTER_MS = Object.freeze({ tick: Object.freeze({ base: 0, spread: 15000 }), sweep: Object.freeze({ base: 20000, spread: 20000 }) });
/** How long a settle waits for a launcher's group to vanish after its envelope before counting a probe. */
const QUIESCE_WAIT_MS = 3000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const STATUS_SCHEMA = 'ship-ticket-engine-status-v1';
/** Two unsuccessful review rounds on a candidate line end the review/repair loop (§7.1 rule 2). */
export const MAX_FAILED_ROUNDS = 2;
/** The ONLY engine commands the supervisor launches. None of them writes RUN-STATE. */
export const ENGINE_COMMANDS = Object.freeze(['drive', 'gate red', 'gate reassess', 'gate ship-ready', 'gate review', 'reconcile']);
/** The engine commands nextStep may name that the supervisor launches as ops (gate review is the collect op). */
const LAUNCHED = Object.freeze(['drive', 'gate red', 'gate reassess', 'gate ship-ready']);
export const DEFAULT_STATE_DIR = () => join(homedir(), '.ai-skills-state', 'supervisor');
const OUTPUT_CAP = 1024 * 1024;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------------- seams (re-pointable)

/** PR-2 adapter: the command that runs `argv` under host admission. The ONE place heavy commands are admitted. */
export const admittedCommand = (argv) => ({ file: process.execPath, args: [HOST_ADMIT, 'run', '--', ...argv], shell: false });

/** The argv of an allowed engine command for ticket `t` (anything else is refused). */
export function engineArgv(sub, t, extra = []) {
  if (!ENGINE_COMMANDS.includes(sub)) throw coded('command_refused', `the supervisor launches only ${ENGINE_COMMANDS.join(', ')}; not ${sub}`);
  return [process.execPath, RUN_ENGINE, ...sub.split(' '), '--repo', t.worktree, '--ticket', t.key, '--run-id', t.run_id, ...extra];
}

/**
 * The supervisor never writes an authority event. Every path that would need one (an owner RETRY of a terminal review, a
 * security waiver an RCA proposes, ...) ends here: refused, the ticket alone is Blocked. Independent tickets continue.
 */
export async function requestAuthority(J, key, event, why) {
  await J.block(key, 'authority_required', `${why}: ${event} is an owner authority event; the supervisor never writes one`, { needs: event, authority_refused: true });
  return { refused: true, needs: event };
}

/** PR-4b seam: `run-engine succeed` (successor generation) is not merged, so every succession is refused here. */
export const succeedUnavailable = async () => { throw coded('succession_unavailable', 'run-engine succeed (PR-4b) is not merged: the recovery path cannot execute yet'); };

const defaultDeps = () => ({
  verifyWave, readTicket,
  readManifest: (file) => parseManifest(readFileSync(file, 'utf8')),
  readState: (t) => { try { const P = enginePaths(t.worktree, t.key); return P && existsSync(P.state) ? JSON.parse(readFileSync(P.state, 'utf8')) : null; } catch { return null; } },
  runDir: (t) => { const P = enginePaths(t.worktree, t.key, { prefer: 'durable' }); return P.placement === 'durable' ? join(P.dir, 'supervisor') : join(P.dir, `${t.key}.supervisor`); },
  repoOf: (t) => repoId(realpathSync(commonGitDir(t.worktree))),
  next: async (t, lastFile) => nextStep(await readRun({ repoRoot: t.worktree, ticket: t.key, runId: t.run_id, lastFile })),
  admitted: admittedCommand,
  agentSpec: (plan, env) => spawnSpec(plan.executable, plan.args, process.platform, env),
  verifySubscription,
  startLauncher,
  isAlive: (pgid) => groupAlive(pgid),
  armClock: undefined, // the real clock (arming only); tests pass a testClock()
  sweepClock: undefined, // resolveSweepClock: no clock while MEASUREMENT_QUALIFIED is false
  reconcile: (t) => runEngine(engineArgv('reconcile', t, ['--deadlines', 'true']), RECONCILE_BOUND_MS),
  succeed: succeedUnavailable,
  prepareAgent: prepareAgentTask, // the carrier's routing of every agent task (a seam only so a test can drift it)
  now: () => Date.now(), // hold pacing only (never an op id, never a deadline)
  hooks: undefined,
  env: process.env,
});

/** Injected deps over the defaults; an injected `undefined` keeps the default. */
const withDefaults = (d) => { const out = defaultDeps(); for (const [k, v] of Object.entries(d ?? {})) if (v !== undefined) out[k] = v; return out; };

/** The sweep's bounded `reconcile --deadlines` only (never under the journal lock; every other engine command is a launch op). */
function runEngine(argv, timeout) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, signal: r.signal ?? null, json, timed_out: r.error?.code === 'ETIMEDOUT' };
}

// ---------------------------------------------------------------------------------------------------- wave + readiness

/**
 * Verify and read the wave. A wave whose manifest is intact but some TICKETS fail their binding (an unreadable or moved plan,
 * e.g. a finished ticket's worktree removed) is `partial`: those tickets are listed in `unbound` and parked, the others
 * continue. The caller accepts a partial wave only after a fully verified first tick bound the same digest.
 */
function loadWave(manifestPath, deps, { routes: checkRoutes = true } = {}) {
  const v = deps.verifyWave(manifestPath);
  const partial = !v.ok && v.code === 'wave_unapproved' && typeof v.digest === 'string' && !(v.unlisted ?? []).length && isObj(v.tickets);
  if (!v.ok && !partial) return { ok: false, code: v.code ?? 'wave_unverified', problems: v.problems ?? [] };
  const p = deps.readManifest(manifestPath);
  if (!p.ok) return { ok: false, code: p.problems[0]?.code ?? 'wave_manifest_unreadable', problems: p.problems };
  if (p.digest !== v.digest) return { ok: false, code: 'wave_manifest_moved', problems: [] };
  const unbound = partial ? Object.fromEntries(Object.entries(v.tickets).filter(([, x]) => !x?.ok).map(([k, x]) => [k, x?.reason ?? 'unbound'])) : {};
  // the sweep skips the route check: deadline enforcement of live ops never stops on a route configuration problem
  const routes = checkRoutes ? reviewRoutesCheck(p.manifest) : { ok: true, all: [], second: [] };
  if (!routes.ok) return { ok: false, code: routes.code, problems: [{ code: routes.code, detail: routes.detail }] };
  return { ok: true, partial, unbound, manifest: p.manifest, digest: p.digest, merge_strategy: mergeStrategyOf(p.manifest), review_routes: routes.all, second_routes: routes.second };
}

/**
 * PR-5b: a supervised wave's review routes (the manifest object itself is checked: wave.mjs validates the shape when it parses
 * the file). Every provider id must have a verified carrier adapter; a `second_opinion` route is required; its budget is at most
 * the policy figure. Other roles are optional and not routed by this release.
 */
function reviewRoutesCheck(m) {
  const all = Array.isArray(m?.review_routes) ? m.review_routes : [];
  const unknown = all.find((r) => !isObj(r) || !supportsAgentProvider(r.provider));
  if (unknown) return { ok: false, code: 'review_route_provider_unknown', detail: `review route provider ${JSON.stringify(unknown?.provider)} has no verified carrier adapter` };
  const second = reviewRoutesOf(m, 'second_opinion');
  if (!second.length) return { ok: false, code: 'second_opinion_route_missing', detail: 'the approved wave manifest names no second_opinion review route: the mandatory second opinion has no route' };
  const over = second.find((r) => r.budget_ms !== undefined && !(Number.isInteger(r.budget_ms) && r.budget_ms >= 1000 && r.budget_ms <= SECOND_OPINION_BUDGET_MS));
  if (over) return { ok: false, code: 'second_opinion_budget_invalid', detail: `a second_opinion attempt budget is 1000..${SECOND_OPINION_BUDGET_MS} ms (policy), not ${over.budget_ms}` };
  return { ok: true, all, second: second.map((r) => ({ provider: r.provider, model: r.model, budget_ms: r.budget_ms ?? SECOND_OPINION_BUDGET_MS })) };
}

const live = (o) => o.state !== 'recorded';
const opsOf = (J, key) => Object.values(J.doc.ops).filter((o) => o.ticket === key);
const seqOf = (S) => (Number.isSafeInteger(S?.seq) ? S.seq : S?.events?.at(-1)?.seq ?? 0);
/** Failed review rounds of the engine's review chain (original or confirmation FAIL records; counted, never reset). */
export const failedRounds = (S) => (S?.review_chain ?? []).filter((r) => ['original', 'confirmation'].includes(r.kind) && r.outcome === 'FAIL').length;
const inChain = (S, c) => (S?.review_chain ?? []).some((r) => r.review_execution === c.rx && r.kind === c.kind);

// ---------------------------------------------------------------------------------------------------- launch ops

function readJsonFile(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readText(file) { try { const b = readFileSync(file); return b.length > OUTPUT_CAP ? null : b.toString('utf8'); } catch { return null; } }

/** The op's files in its ticket's run directory (deterministic from the op id). */
function opFiles(dir, id) {
  const base = join(dir, id.replace(/:/g, '__'));
  return { prompt: `${base}.prompt`, out: `${base}.out`, envelope: `${base}.envelope.json`, receipt: `${base}.receipt`, input: `${base}.input.json`, brief: `${base}.repair-brief.md` };
}

/**
 * The generation to use for op `op` at `base`: the base, or `<base>.r<k>` after k recorded nothing-ran outcomes (persisted,
 * deterministic). `spent` names the exhausted cause (RETRY_LIMITS) and `last` the last retried op.
 */
function launchGen(J, repo, key, op, base) {
  let nothing = 0, held = 0, firstHeld = null, last = null;
  for (let k = 0; ; k++) {
    const gen = k ? `${base}.r${k}` : base;
    const o = J.op(opId(repo, key, op, gen));
    const out = o?.result?.outcome;
    if (!RETRYABLE.has(out)) return { gen, last, held, firstHeld, spent: nothing >= RETRY_LIMITS.nothing_ran ? 'nothing_ran' : null };
    if (out === 'held') { held += 1; firstHeld ??= o; } else { nothing += 1; held = 0; firstHeld = null; }
    last = o;
  }
}

/**
 * PR-5b: after a hold the next attempt waits (paced, never a Block). Returns the wait to report, or null to launch now. The
 * clock (deps.now) paces only; an op id never depends on it.
 */
function heldWait(ctx, g) {
  if (g.last?.result?.outcome !== 'held') return null;
  const now = ctx.deps.now(), at = g.last.result.at;
  const wait = Math.min(HOLD_RETRY_MAX_MS, HOLD_RETRY_BASE_MS * 2 ** Math.min(Math.max(g.held - 1, 0), 20));
  const since = g.firstHeld?.result?.at;
  if (!Number.isFinite(at) || now >= at + wait) return null;
  return { held: 'admission', attempts: g.held, retry_after_ms: at + wait - now, op_id: g.last.op_id, long_hold: Number.isFinite(since) && now - since >= HOLD_LONG_MS };
}

/**
 * Release one launch op that is at intent with no pid: receipt, spawn (own group), pid + identity + deadline committed
 * BEFORE the release byte, release, acted. A failed spawn is recorded (nothing ran).
 */
async function act(J, ctx, o) {
  const { deps } = ctx;
  const f = o.files;
  mkdirSync(dirname(f.out), { recursive: true });
  for (const x of [f.out, f.envelope, f.receipt]) rmSync(x, { force: true }); // an earlier unreleased attempt's files: nothing ran
  let spec, env, plan;
  try { ({ spec, env, plan } = o.spec_kind === 'agent' ? agentLaunch(ctx, o) : { spec: deps.admitted(o.argv), env: deps.env }); }
  catch (e) { return J.move(o.op_id, 'recorded', { result: classify(ctx, o, { launch_error: { code: e.code ?? 'refused', reason: e.message } }) }); }
  if (!existsSync(f.prompt)) writeFileSync(f.prompt, '', { mode: 0o600 });
  writeFileSync(f.receipt, String(o.attempt), { flag: 'wx', mode: 0o600 });
  await boundary(deps.hooks, 'after-receipt', { op_id: o.op_id });
  const attemptId = `${o.op_id.replace(/[^A-Za-z0-9._-]/g, '_')}.a${o.attempt}`.slice(0, 120);
  const child = deps.startLauncher({ spec, cwd: o.cwd, env, platform: process.platform,
    files: { promptFile: f.prompt, outFile: f.out, envelopeFile: f.envelope, attemptId } });
  child.on('error', () => {});
  child.stdin?.on('error', () => {});
  if (!child.pid) return J.move(o.op_id, 'recorded', { result: classify(ctx, o, { launch_error: { code: 'spawn_failed', reason: 'the launcher did not start' } }) });
  const pgid = process.platform === 'win32' ? null : child.pid;
  await J.update(o.op_id, { pid: child.pid, pgid, leader_start: leaderStart(pgid), attempt_id: attemptId,
    deadline: armRecord(o.bound_ms, deps.armClock ?? undefined), ...(o.requested ? { launched: { provider: plan.provider, model: plan.model } } : {}) }, 'after-pid');
  await new Promise((r) => child.stdin.end(RELEASE, r));
  await boundary(deps.hooks, 'after-release', { op_id: o.op_id });
  child.unref();
  return J.move(o.op_id, 'acted', { released: true }, 'after-acted');
}

/** The routed, read-only agent task of a review leg or an RCA: prepareAgentTask (tier -> modelMap), billing env, subscription check. */
function agentLaunch(ctx, o) {
  const plan = agentPlan(ctx, { route: o.route, requested: o.requested, nodeId: o.node_id, workdir: o.cwd, timeoutMs: Math.min(o.bound_ms, 3600000), promptFile: o.files.prompt });
  const env = childEnv(plan.provider, plan.billing, ctx.deps.env);
  if (plan.billing === 'subscription' && ctx.deps.verifySubscription(plan.provider, env) === false)
    throw coded('subscription_unverified', `subscription authentication not verified for ${plan.provider}`);
  return { spec: ctx.deps.agentSpec(plan, env), env, plan };
}

/**
 * The carrier's plan of an agent task. With `requested` (a second-opinion route) the plan must launch exactly that route: the
 * adapter's provider and model, and the model in the argv it built; otherwise PROVENANCE_MISMATCH (refused, nothing launched).
 */
function agentPlan(ctx, { route, requested, ...task }) {
  const plan = ctx.deps.prepareAgent({ ...route, ...task });
  if (requested && (plan.provider !== requested.provider || plan.model !== requested.model || plan.model_applied !== true || !plan.args.includes(requested.model)))
    throw coded(PROVENANCE_MISMATCH, `route ${requested.provider}:${requested.model} requested, the carrier adapter built ${plan.provider}:${plan.model}`);
  return plan;
}

/** Intent (or the existing record) for a launch op, then act on it when it is at intent with no pid. */
async function launch(J, ctx, t, { op, gen, argv, bound, prompt, route, requested, nodeId, input, collect, record }) {
  const id = opId(ctx.repo(t), t.key, op, gen);
  let o = J.op(id);
  if (o && o.state !== 'intent') return { op_id: id, state: o.state, existing: true };
  if (!o) {
    const files = opFiles(ctx.deps.runDir(t), id);
    mkdirSync(dirname(files.prompt), { recursive: true });
    if (prompt !== undefined) writeFileSync(files.prompt, prompt, { mode: 0o600 });
    if (input !== undefined) writeFileSync(files.input, JSON.stringify(input), { mode: 0o600 });
    o = await J.intent({ op_id: id, ticket: t.key, kind: 'launch', op, gen, cwd: t.worktree, bound_ms: bound, files,
      seq_at: seqOf(ctx.deps.readState(t)), ...(collect ? { collect } : {}), ...(record ?? {}),
      ...(route ? { spec_kind: 'agent', route, node_id: nodeId, ...(requested ? { requested } : {}) } : { spec_kind: 'engine', argv: input !== undefined ? [...argv, '--input', files.input] : argv }) });
  }
  if (o.pid) return { op_id: id, state: o.state };
  o = await act(J, ctx, o);
  return { op_id: id, state: o.state };
}

/**
 * THE classifier of a finished launch (the one place). An agent task: ran or failed by its exit. An engine command: decided
 * from the ENGINE'S OWN RECORD, never from the exit code alone:
 *   collect (gate review)  `collected` when the review chain holds this execution; `refused` only when the engine logged a
 *                          review GATE refusal after the launch; otherwise `nothing_ran`.
 *   drive                  `held` on the admission exit; `ran` when the engine printed its status or its event seq moved;
 *   gate red|reassess|ship-ready  `held` on the admission exit; `ran` only when the engine RECORDED the decision (a GATE event
 *                          of that gate after the launch: run-engine gate() notes every decision it makes; a refusal it returns
 *                          without an event, e.g. worktree_mismatch, no_state, lock_*, binding drift, took no effect);
 *   otherwise `nothing_ran` (its run lock was held, a usage/bad_input refusal, a wrapper failure, a kill).
 * A launch that never started (`env.launch_error`: the spec threw, the fork failed) is `nothing_ran` for an engine command and
 * a coded `refused` for an agent task (a review leg's route was refused: its caller decides, e.g. the next second-opinion route).
 */
function classify(ctx, o, env) {
  if (env.launch_error) return o.spec_kind === 'agent' ? { outcome: 'refused', code: env.launch_error.code, reason: env.launch_error.reason }
    : { outcome: 'nothing_ran', cause: env.launch_error.code, reason: env.launch_error.reason };
  if (o.spec_kind === 'agent') return { outcome: env.exit_code === 0 ? 'ran' : 'failed', exit_code: env.exit_code, ...(env.spawn_error ? { spawn_error: String(env.spawn_error) } : {}), out: o.files.out };
  const t = ctx.ticket(o.ticket);
  const S = t ? ctx.deps.readState(t) : null;
  const out = readJsonFile(o.files.out);
  const cause = isObj(out) && typeof out.code === 'string' ? out.code : `exit ${env.exit_code ?? env.signal ?? 'unknown'}`;
  if (o.collect && inChain(S, o.collect)) return { outcome: 'collected' };
  if (env.exit_code === ADMISSION_HELD_EXIT) return { outcome: 'held', at: ctx.deps.now() }; // collect included (PR-5b)
  if (o.collect) {
    const refusal = (S?.events ?? []).find((e) => e.type === 'GATE' && e.gate === 'review' && e.ok === false && e.seq > (o.seq_at ?? 0)
      && (e.review_execution === undefined || e.review_execution === o.collect.rx));
    if (refusal) return { outcome: 'refused', code: refusal.code ?? null, seq: refusal.seq };
    return { outcome: 'nothing_ran', cause };
  }
  const moved = seqOf(S) !== (o.seq_at ?? seqOf(S));
  const gate = o.op.startsWith('gate.') ? o.op.slice('gate.'.length) : null;
  const ran = gate === null ? moved || (isObj(out) && out.schema === STATUS_SCHEMA && typeof out.outcome === 'string')
    : Array.isArray(S?.events) ? S.events.some((e) => e.type === 'GATE' && e.gate === gate && e.seq > (o.seq_at ?? 0)) : moved;
  if (ran) return { outcome: 'ran', exit_code: env.exit_code, out: o.files.out };
  return { outcome: 'nothing_ran', cause };
}

/** Settle one unsettled op (every tick, before any new effect). */
async function settle(J, ctx, o) {
  const { deps } = ctx;
  if (o.kind === 'call') { // an interrupted succession call: it may have taken effect, so it is never repeated
    if (o.state === 'intent') o = await J.move(o.op_id, 'ambiguous', { why: 'interrupted between the call and its record' });
    if ((o.probes ?? 0) >= MAX_PROBES) return o;
    if (await J.probe(o.op_id, 'no direct probe for a succession call')) await J.block(o.ticket, 'ambiguous_unresolved', `op ${o.op_id} stayed ambiguous after ${MAX_PROBES} probes`, { op_id: o.op_id });
    return J.op(o.op_id);
  }
  if (o.state === 'intent' && !o.pid) {
    const t = ctx.ticket(o.ticket);
    // never released: re-act under the same id, unless the engine state moved past the generation it was decided at
    if (t && !o.collect && (o.op === 'drive' || o.op.startsWith('gate.')) && genSeq(o.gen) !== seqOf(deps.readState(t)))
      return J.move(o.op_id, 'recorded', { result: { outcome: 'superseded', reason: 'never released; the engine state moved since' } });
    return t ? act(J, ctx, o) : o;
  }
  if (o.state === 'intent') o = await J.move(o.op_id, 'ambiguous', { why: 'crashed between the pid record and the release record' });
  const env = readJsonFile(o.files.envelope);
  const spent = (o.probes ?? 0) >= MAX_PROBES; // budget spent, ticket Blocked: only proven quiescence can still settle it
  const bounded = async (code, note) => {
    if (spent) return o;
    if (await J.probe(o.op_id, note)) await J.block(o.ticket, code, `op ${o.op_id}: ${note} after ${MAX_PROBES} probes`, { op_id: o.op_id });
    return J.op(o.op_id);
  };
  if (env) {
    // recorded only once whole-group quiescence is proven: a descendant still in the group keeps it unsettled (bounded)
    // the launcher exits right after its envelope: give the group a short bounded moment before counting a probe
    for (const until = performance.now() + QUIESCE_WAIT_MS; o.pgid && deps.isAlive(o.pgid) !== false && performance.now() < until;) await delay(50);
    if (o.pgid && deps.isAlive(o.pgid) !== false) return bounded('group_not_quiescent', 'envelope written but its process group is still alive');
    return J.move(o.op_id, 'recorded', { result: classify(ctx, o, env) });
  }
  const id = groupIdentity({ pgid: o.pgid, leader_start: o.leader_start }, deps.isAlive);
  if (id === 'verified') return o; // still running; the sweep enforces its bound
  if (o.state === 'acted' && id === 'gone') {
    // the launcher died without its envelope: the engine's own record decides whether anything took effect
    const result = classify(ctx, o, { exit_code: null, signal: 'no_envelope' });
    if (result.outcome === 'nothing_ran' && !o.collect && o.spec_kind === 'engine') return J.move(o.op_id, 'recorded', { result: { ...result, ...(o.timed_out ? { timed_out: o.timed_out } : {}) } });
    if (o.collect) return J.move(o.op_id, 'recorded', { result });
    return J.move(o.op_id, 'recorded', { result: { outcome: o.timed_out ? 'timed_out' : 'lost', ...(o.timed_out ? { charged_ms: o.timed_out.charged_ms } : {}) } });
  }
  if (o.state === 'acted') return bounded('identity_unknown', `group identity ${id}: neither verified running nor proven gone`);
  return bounded('ambiguous_unresolved', `no envelope; group ${id}`);
}

// ---------------------------------------------------------------------------------------------------- reviews

const LEGS = ['primary', 'second', 'reconcile'];

function reviewPrompt(t, leg, kind, rx, facts, artifacts = null) {
  // UNQUALIFIED: the reviewer brief text. The gate (gate review) validates every field of what comes back.
  return [`# ship-ticket ${kind} review, leg ${leg}`, `ticket ${t.key}, run ${t.run_id}, review_execution ${rx}, candidate ${facts.candidate_id}.`,
    `Excluded reviewer identities (builders): ${JSON.stringify(facts.excluded_reviewers ?? [])}.`,
    leg === 'reconcile'
      ? `Reconcile the two artifacts below. Reply with ONLY the JSON input of run-engine.mjs gate review (kind ${kind}, review_execution ${rx}), whose primary and second_opinion are these artifacts unchanged.\n${JSON.stringify(artifacts)}`
      : `Review per references/review.md. Reply with ONLY the JSON ${leg === 'primary' ? 'primary' : 'second_opinion'} artifact of gate review for candidate ${facts.candidate_id}.`,
    ''].join('\n\n');
}

/** The final message of a finished agent op as JSON, or null. */
function agentJson(o) {
  const text = readText(o.files.out);
  if (text === null) return null;
  const msg = finalMessage(o.route.provider, text);
  if (msg.is_error || typeof msg.text !== 'string') return null;
  try { return JSON.parse(msg.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

/** The models a finished agent op's provider reports it served (usage.mjs), or null when the provider names none. */
function reportedModels(o) {
  const text = readText(o.files.out);
  if (text === null) return null;
  try { const u = extractUsage(o.route.provider, text); return Array.isArray(u?.models_used) && u.models_used.length ? u.models_used : null; } catch { return null; }
}
/** A served model id is the requested one, or its dated/variant form (`<id>-<suffix>`, `<id>[...]`). */
const servedAs = (served, requested) => { const strip = (m) => String(m).replace(/\[[^\]]*\]$/, ''); return strip(served) === strip(requested) || strip(served).startsWith(`${strip(requested)}-`); };

/**
 * PR-5b: one recorded second-opinion attempt. `usable` with the launch-stamped artifact; `mismatch` when what launched (or what
 * the provider reports it served) is not the requested route; otherwise unusable with the reason (the next route is tried).
 */
function secondVerdict(o) {
  const r = o.result ?? {};
  if (r.code === PROVENANCE_MISMATCH) return { mismatch: r.reason ?? r.code };
  if (r.outcome !== 'ran') return { why: r.code ?? r.outcome ?? 'unknown' };
  const L = o.launched;
  if (!isObj(L) || L.provider !== o.requested?.provider || L.model !== o.requested?.model) return { mismatch: `launched ${JSON.stringify(L ?? null)} is not the requested route ${JSON.stringify(o.requested ?? null)}` };
  const served = reportedModels(o);
  if (served && !served.some((m) => servedAs(m, L.model))) return { mismatch: `route ${L.provider}:${L.model} requested, the provider reports it served ${served.join(', ')}` };
  const art = agentJson(o);
  if (!isObj(art)) return { why: 'no JSON artifact (unavailable, usage limit or unreadable)' };
  const id = `${L.provider}:${L.model}`;
  return { usable: true, artifact: { ...art, route: id, reviewer_identity: id } };
}

/**
 * Review dispatch and collection for one review execution: legs in order, then ONE collect op (gate review once). The second
 * opinion takes the approved manifest routes in order, one attempt each (PR-5b, S7 Option A; see the header).
 */
async function review(J, ctx, t, S, { kind, rx, facts }) {
  const repo = ctx.repo(t), prefix = kind === 'original' ? 'review' : 'confirmation';
  const primaryRoute = { provider: S?.config?.provider, modelMap: S?.config?.modelMap ?? {}, billing: S?.config?.billing };
  const soRoutes = ctx.secondRoutes ?? [];
  const soName = (i) => (i === 0 ? 'second' : `second-${i + 1}`);
  const soRoute = (r) => ({ provider: r.provider, modelMap: { strong: r.model }, billing: S?.config?.billing });
  const requestedOf = (r) => ({ provider: r.provider, model: r.model });
  const leg = (name) => J.op(opId(repo, t.key, `${prefix}.${name}`, rx));
  // every leg's route is resolved (tier -> modelMap, the carrier's own refusals, second-opinion provenance) before any leg is launched
  const checks = [['primary', primaryRoute, null], ...(kind === 'original' ? [['reconcile', primaryRoute, null]] : []),
    ...soRoutes.map((r, i) => [soName(i), soRoute(r), requestedOf(r)])];
  let primaryPlan = null;
  for (const [name, route, requested] of checks) {
    let plan;
    try { plan = agentPlan(ctx, { route, requested, nodeId: `${prefix}-${name}`, workdir: t.worktree, timeoutMs: 1000, promptFile: fileURLToPath(import.meta.url) }); }
    catch (e) { return { blocked: await J.block(t.key, e.code === PROVENANCE_MISMATCH ? PROVENANCE_MISMATCH : 'review_route_refused', `${name}: ${e.message}`) }; }
    if (name === 'primary') primaryPlan = plan;
    else if (requested && plan.provider === primaryPlan.provider && plan.model === primaryPlan.model)
      return { blocked: await J.block(t.key, 'second_opinion_not_distinct', `${name}: route ${plan.provider}:${plan.model} is the primary reviewer's own route`) };
  }
  if (!soRoutes.length) return { blocked: await J.block(t.key, 'second_opinion_route_missing', 'no approved second_opinion route') };
  const started = [];
  if (!leg('primary')) started.push(await launch(J, ctx, t, { op: `${prefix}.primary`, gen: rx, bound: AGENT_BOUND_MS, route: primaryRoute, nodeId: `${prefix}-primary`,
    prompt: reviewPrompt(t, 'primary', kind, rx, facts) }));
  // the second opinion: ONE attempt per approved route, in order; the next only once the previous is recorded unusable
  let so = null;
  const attempts = [];
  for (let i = 0; i < soRoutes.length && so === null; i++) {
    const o = leg(soName(i));
    if (!o) {
      started.push(await launch(J, ctx, t, { op: `${prefix}.${soName(i)}`, gen: rx, bound: soRoutes[i].budget_ms, route: soRoute(soRoutes[i]), requested: requestedOf(soRoutes[i]),
        nodeId: `${prefix}-${soName(i)}`, prompt: reviewPrompt(t, 'second', kind, rx, facts) }));
      so = 'started';
    } else if (live(o)) so = 'live';
    else {
      const v = secondVerdict(o);
      if (v.mismatch) return { blocked: await J.block(t.key, PROVENANCE_MISMATCH, `${o.op_id}: ${v.mismatch}`, { op_id: o.op_id }) };
      if (v.usable) so = { op: o, artifact: v.artifact };
      else attempts.push({ op_id: o.op_id, outcome: o.result?.outcome ?? null, why: v.why });
    }
  }
  if (so === null) return { blocked: await J.block(t.key, 'second_opinion_unavailable', `no approved second-opinion route produced a usable review (${attempts.map((a) => `${a.op_id}: ${a.why}`).join('; ')})`, { attempts }) };
  if (started.length) return { dispatched: started };
  const p = leg('primary');
  if (live(p) || so === 'live') return { waiting: 'review legs live' };
  if (p.result?.outcome !== 'ran') return { blocked: await J.block(t.key, 'review_leg_failed', `${p.op_id} ended ${p.result?.outcome}`, { op_id: p.op_id }) };
  const artifacts = { primary: agentJson(p), second_opinion: so.artifact };
  if (!isObj(artifacts.primary)) return { blocked: await J.block(t.key, 'review_leg_unreadable', 'a review leg left no JSON artifact', { op_id: p.op_id }) };
  // provenance of the collected second opinion, recorded on the collect op (never a cross-provider claim for one provider)
  const provenance = { second_opinion: so.artifact.route, same_provider: so.op.launched.provider === primaryPlan.provider, second_opinion_op: so.op.op_id };
  if (kind === 'confirmation') return collect(J, ctx, t, { prefix, kind, rx, input: { kind, review_execution: rx, ...artifacts }, provenance }); // gate.mjs confirm(): no reconciliation
  const r = leg('reconcile');
  if (!r) return { dispatched: [await launch(J, ctx, t, { op: `${prefix}.reconcile`, gen: rx, bound: AGENT_BOUND_MS, route: primaryRoute, nodeId: `${prefix}-reconcile`,
    prompt: reviewPrompt(t, 'reconcile', kind, rx, facts, artifacts) })] };
  if (live(r)) return { waiting: 'reconcile leg live' };
  const input = r.result?.outcome === 'ran' ? agentJson(r) : null;
  // the reconciler may add the reconciliation, never replace what the reviewers wrote
  if (!isObj(input) || input.kind !== kind || input.review_execution !== rx
    || JSON.stringify(input.primary) !== JSON.stringify(artifacts.primary) || JSON.stringify(input.second_opinion) !== JSON.stringify(artifacts.second_opinion))
    return { blocked: await J.block(t.key, 'review_input_invalid', 'the reconciled gate input is missing, of another execution, or altered a reviewer artifact', { op_id: r.op_id }) };
  // only the review gate's own input fields reach it (an unknown key is the gate's bad_input usage error)
  const fields = Object.fromEntries(Object.entries(input).filter(([k]) => GATE_FIELDS.review.includes(k) && k !== 'repair_prompt_file'));
  return collect(J, ctx, t, { prefix, kind, rx, input: fields, provenance });
}

/** The fixed findings of an original FAIL input (reconciliation disposition `fix`), from both reviewers. */
function fixFindings(input) {
  const disp = Array.isArray(input.reconciliation?.dispositions) ? input.reconciliation.dispositions : [];
  const fixed = (f, primary) => disp.some((d) => isObj(d) && d.finding_id === f.id && d.disposition === 'fix' && (primary ? d.source === 'primary' : d.source !== 'primary'));
  return [...(input.primary?.findings ?? []).filter((f) => isObj(f) && fixed(f, true)).map((f) => ({ source: 'primary', ...f })),
    ...(input.second_opinion?.findings ?? []).filter((f) => isObj(f) && fixed(f, false)).map((f) => ({ source: 'second_opinion', ...f }))];
}

/**
 * The supervisor-owned, finding-bound repair brief of an actionable original FAIL (engine-gates: an accepted FAIL that opens a
 * repair needs `repair_prompt_file`). Written once in the run directory from the collected findings; deterministic bytes.
 * The NODE line names the repair (the repair writer's prompt id). UNQUALIFIED: the brief text for a real repair writer.
 */
function repairBrief(t, rx, findings) {
  return [`NODE=repair-${rx}`, `# ship-ticket repair brief: ${t.key} ${t.run_id}, review_execution ${rx}`,
    'Fix exactly these review findings, inside the paths they name; change nothing else.',
    ...findings.map((f) => `- ${f.source} ${f.id}: ${JSON.stringify(f)}`), ''].join('\n');
}

/**
 * Collect one review execution exactly once: the engine's review chain is probed first; otherwise `gate review` runs as an
 * ADMITTED, DETACHED engine launch op (pid/pgid/leader_start/deadline persisted before the release byte, never a spawnSync
 * under the journal lock) and the classifier reads the chain or a logged refusal. A nothing-ran outcome (run lock held,
 * usage refusal, wrapper failure, kill) is re-tried under `<rx>.r<k>`, bounded, then the ticket alone is Blocked.
 */
async function collect(J, ctx, t, { prefix, kind, rx, input, provenance }) {
  const repo = ctx.repo(t);
  if (inChain(ctx.deps.readState(t), { rx, kind })) return { collected: 'in_chain' };
  const g = launchGen(J, repo, t.key, prefix, rx);
  const prior = J.op(opId(repo, t.key, prefix, g.gen));
  if (prior?.state === 'recorded') return prior.result?.outcome === 'collected' ? { collected: prior.op_id } : { parked: 'gate_refused', op_id: prior.op_id, code: prior.result?.code ?? null };
  if (!prior && g.spent) return { blocked: await J.block(t.key, 'retries_exhausted', `${g.last.op_id}: gate review recorded nothing ${RETRY_LIMITS[g.spent]} times (${g.last.result?.cause ?? g.spent})`, { op_id: g.last.op_id }) };
  const wait = prior ? null : heldWait(ctx, g);
  if (wait) return wait;
  let full = input;
  if (kind === 'original' && input.primary?.outcome === 'FAIL') {
    const findings = fixFindings(input);
    if (findings.length) {
      const brief = opFiles(ctx.deps.runDir(t), opId(repo, t.key, prefix, rx)).brief;
      mkdirSync(dirname(brief), { recursive: true });
      if (!existsSync(brief)) writeFileSync(brief, repairBrief(t, rx, findings), { mode: 0o600 });
      full = { ...input, repair_prompt_file: brief };
    }
  }
  return { collecting: await launch(J, ctx, t, { op: prefix, gen: g.gen, argv: engineArgv('gate review', t), bound: GATE_BOUND_MS, input: full, collect: { rx, kind }, record: provenance }) };
}

// ---------------------------------------------------------------------------------------------------- recovery (§7.1)

/** After two failed rounds: one RCA op (routed agent task); its record decides succession (PR-4b) or ticket-local Blocked. */
async function recover(J, ctx, t, S) {
  const rx = (S?.review_chain ?? []).filter((r) => r.kind === 'original').at(-1)?.review_execution ?? 'rx';
  const id = opId(ctx.repo(t), t.key, 'rca', rx);
  const o = J.op(id);
  if (!o) {
    const findings = (S?.review_chain ?? []).filter((r) => r.outcome === 'FAIL').map((r) => ({ kind: r.kind, review_execution: r.review_execution, fix_findings: r.fix_findings ?? [], candidate_id: r.candidate_id ?? null }));
    const prompt = [`# ship-ticket root-cause analysis: ${t.key} ${t.run_id}`, `Two review rounds failed on ${rx}. Findings: ${JSON.stringify(findings)}.`,
      'Reply with ONLY JSON { "hypothesis": string, "evidence": [string], "differs": string (what the new path changes vs the failed approach and why the evidence supports it), "path": "succession" | "blocked" }.', ''].join('\n\n');
    return { rca: await launch(J, ctx, t, { op: 'rca', gen: rx, bound: AGENT_BOUND_MS, nodeId: 'rca', prompt,
      route: { provider: S?.config?.provider, modelMap: S?.config?.modelMap ?? {}, billing: S?.config?.billing } }) };
  }
  if (live(o)) return { waiting: 'rca live' };
  const rca = o.result?.outcome === 'ran' ? agentJson(o) : null;
  if (!isObj(rca)) return { blocked: await J.block(t.key, 'rca_unreadable', `RCA ${id} left no readable record`, { op_id: id }) };
  const wants = [rca.event, ...(Array.isArray(rca.authority) ? rca.authority : [])].filter((e) => AUTHORITY_EVENTS.includes(e));
  if (wants.length) return { blocked: await requestAuthority(J, t.key, wants[0], `RCA ${id} proposes an authority event`) };
  const record = { hypothesis: String(rca.hypothesis ?? ''), evidence: Array.isArray(rca.evidence) ? rca.evidence.map(String) : [], differs: String(rca.differs ?? ''), path: rca.path };
  if (record.path !== 'succession' || !record.differs.trim() || !record.evidence.length)
    return { blocked: await J.block(t.key, 'recovery_no_different_path', 'the RCA names no different, evidence-backed path', { op_id: id, rca: record }) };
  const sid = opId(ctx.repo(t), t.key, 'succeed', rx);
  const s = J.op(sid);
  if (s?.state === 'recorded') return { succeeded: s.result };
  if (s) return { waiting: 'succession unsettled' }; // settle() resolves an interrupted call (ambiguous, bounded)
  await J.intent({ op_id: sid, ticket: t.key, kind: 'call', op: 'succeed', gen: rx, rca_op: id });
  try {
    const result = await ctx.deps.succeed(t, record);
    await J.move(sid, 'recorded', { result: { outcome: 'succeeded', ...(isObj(result) ? { detail: result } : {}) } });
    return { succeeded: J.op(sid).result };
  } catch (e) {
    await J.move(sid, 'recorded', { result: { outcome: 'refused', code: e.code ?? 'succession_failed' } });
    return { blocked: await J.block(t.key, e.code ?? 'succession_failed', e.message, { op_id: id, rca: record }) };
  }
}

// ---------------------------------------------------------------------------------------------------- one ticket

async function stepTicket(J, ctx, t) {
  const { deps } = ctx;
  const ops = opsOf(J, t.key);
  if (ops.some(live)) return { skipped: 'op_live', ops: ops.filter(live).map((o) => o.op_id) };
  const S = deps.readState(t);
  const rounds = failedRounds(S);
  if (rounds >= MAX_FAILED_ROUNDS) return recover(J, ctx, t, S); // §7.1: the loop ends; never a third review, never a stale drive
  const lastDrive = ops.filter((o) => o.op === 'drive' && o.result?.out && existsSync(o.result.out)).sort((a, b) => genSeq(b.gen) - genSeq(a.gen))[0];
  const n = await deps.next(t, lastDrive?.result.out);
  const engineRun = async (cmd, input) => {
    const op = cmd === 'drive' ? 'drive' : `gate.${cmd.split(' ')[1]}`;
    if (!LAUNCHED.includes(cmd)) return { parked: `${cmd}_not_supervised` };
    const base = `s${seqOf(S)}`;
    const g = launchGen(J, ctx.repo(t), t.key, op, base);
    const gen = g.gen;
    const prior = J.op(opId(ctx.repo(t), t.key, op, gen));
    if (!prior && g.spent) return { blocked: await J.block(t.key, 'retries_exhausted', `${g.last.op_id}: ${cmd} did not run (${g.spent}, last ${g.last.result?.cause ?? g.spent}) ${RETRY_LIMITS[g.spent]} times`, { op_id: g.last.op_id }) };
    // already ran at this engine state: no blind re-run. Parked (recomputed every tick) until the engine state moves.
    if (prior?.state === 'recorded') return { parked: 'no_progress', op_id: prior.op_id, outcome: prior.result?.outcome ?? null };
    const wait = prior ? null : heldWait(ctx, g);
    if (wait) return wait;
    return { launched: await launch(J, ctx, t, { op, gen, argv: engineArgv(cmd, t), bound: cmd === 'drive' ? DRIVE_BOUND_MS : GATE_BOUND_MS, input }) };
  };
  if (n.action === 'run') {
    if (n.command.cmd === 'init') return { parked: 'init_not_supervised' }; // init binds the owner START and the DAG file: the owner starts the run
    return engineRun(n.command.cmd, n.command.input);
  }
  if (n.action === 'dispatch') {
    const kind = n.command.input?.kind ?? 'original';
    const rx = n.command.input?.review_execution ?? 'rx-1';
    if (kind === 'original' && (S?.review_chain ?? []).length) return requestAuthority(J, t.key, 'RETRY', 'a new original review after one already ran');
    return review(J, ctx, t, S, { kind, rx, facts: n.facts ?? {} });
  }
  // stop
  if (n.code === 'acceptance_unknown' && n.facts?.settle_with?.cmd) return engineRun(n.facts.settle_with.cmd, n.facts.settle_with.input);
  if (n.code === 'owner_publish') {
    J.doc.ship_ready[t.key] = { at_seq: seqOf(S), merge: ctx.strategy === 'owner' ? 'awaiting_owner_merge' : 'prevented: merge executor not implemented (PR-6b); awaiting owner merge' };
    await J.commit();
    return { ship_ready: J.doc.ship_ready[t.key] };
  }
  if (['review_terminal', 'review_fail_no_repair', 'confirmation_fail', 'candidate_moved'].includes(n.code)) return requestAuthority(J, t.key, 'RETRY', `review stop ${n.code}`);
  // Every other stop is the engine's own state (owner, judgment, unknown, refused, no_progress): PARKED, not journal-Blocked.
  // It is recomputed from the engine every tick (nothing to unblock by hand); the ticket holds its dependents, others continue.
  return { parked: n.code ?? 'stopped', stop_class: n.stop_class ?? null };
}
const genSeq = (g) => Number(/^s(\d+)/.exec(String(g))?.[1] ?? -1);

// ---------------------------------------------------------------------------------------------------- tick

/** One tick. Returns { code, out }. */
export async function tick({ manifestPath, stateDir = DEFAULT_STATE_DIR() }, depsIn = {}) {
  const deps = withDefaults(depsIn);
  const w = loadWave(manifestPath, deps);
  if (!w.ok) return { code: 2, out: { schema: SUPERVISOR_SCHEMA, outcome: 'refused', code: w.code, problems: w.problems } };
  const paths = journalPaths(stateDir, w.manifest.wave_id);
  mkdirSync(paths.dir, { recursive: true });
  const byKey = new Map(w.manifest.tickets.map((t) => [t.key, t]));
  const repos = new Map();
  const ctx = { deps, strategy: w.merge_strategy, secondRoutes: w.second_routes, ticket: (k) => byKey.get(k) ?? null,
    repo: (t) => { if (!repos.has(t.key)) repos.set(t.key, deps.repoOf(t)); return repos.get(t.key); } };
  try {
    return await withJournal(paths, w.manifest.wave_id, async (J) => {
      const info = processInfo(process.pid);
      J.doc.tick = { pid: process.pid, start_identity: info.startTime ?? null, deadline: armRecord(TICK_BOUND_MS, deps.armClock ?? undefined) };
      if (w.partial && J.doc.binding?.manifest_digest !== w.digest) {
        J.doc.tick = null; await J.commit();
        return { code: 2, out: { schema: SUPERVISOR_SCHEMA, outcome: 'refused', code: 'wave_unapproved', unbound: w.unbound, reason: 'a wave starts only fully bound' } };
      }
      if (!J.doc.binding) J.doc.binding = { manifest_digest: w.digest, merge_strategy: w.merge_strategy, review_routes: w.review_routes };
      else if (J.doc.binding.manifest_digest !== w.digest || J.doc.binding.merge_strategy !== w.merge_strategy
        || JSON.stringify(J.doc.binding.review_routes ?? null) !== JSON.stringify(w.review_routes)) {
        J.doc.tick = null; await J.commit();
        return { code: 2, out: { schema: SUPERVISOR_SCHEMA, outcome: 'refused', code: 'wave_plan_changed', reason: 'the manifest (its merge strategy or review routes) changed since this wave started: a plan change is the owner\'s' } };
      }
      await J.commit('after-tick-start');
      const out = { schema: SUPERVISOR_SCHEMA, outcome: 'ticked', wave_id: w.manifest.wave_id, merge_strategy: w.merge_strategy, settled: [], tickets: {} };
      for (const o of Object.values(J.doc.ops).filter(live)) {
        try { const s = await settle(J, ctx, o); out.settled.push({ op_id: o.op_id, state: s?.state ?? null }); }
        catch (e) { await J.block(o.ticket, e.code ?? 'settle_failed', e.message, { op_id: o.op_id }); }
      }
      const nodes = w.manifest.tickets.map((t) => {
        let state;
        if (J.doc.blocked[t.key]) state = 'failed';
        else if (J.doc.ship_ready[t.key]) state = 'ship_ready';
        else if (w.unbound[t.key]) state = 'waiting_owner'; // its plan binding fails now (ticket-local): parked, others continue
        else { try { state = deps.readTicket(t).state; } catch { state = 'corrupt'; } }
        return { id: t.key, deps: t.deps, dep_mode: t.dep_mode, state, owner_required: t.owner_required === true, class: 'heavy', priority: t.priority ?? 0, owns: t.owns ?? [] };
      });
      const { decisions, ready } = evaluateReadiness(nodes);
      out.decisions = Object.fromEntries(Object.entries(decisions).map(([k, d]) => [k, d.state]));
      for (const key of admissionOrder(nodes, ready)) {
        try { out.tickets[key] = await stepTicket(J, ctx, byKey.get(key)); }
        catch (e) { out.tickets[key] = { blocked: await J.block(key, e.code ?? 'supervisor_error', e.message) }; }
      }
      out.blocked = J.doc.blocked;
      if (w.partial) out.unbound = w.unbound;
      J.doc.tick = null;
      await J.commit();
      return { code: 0, out };
    }, { hooks: deps.hooks });
  } catch (e) {
    if (e.code === 'journal_busy') return { code: 0, out: { schema: SUPERVISOR_SCHEMA, outcome: 'busy', reason: e.message } };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------- sweep

/** One sweep: engine reconcile per run, then the journal's own deadlines (lock-free read; signals only verified groups). */
export async function sweep({ manifestPath, stateDir = DEFAULT_STATE_DIR() }, depsIn = {}) {
  const deps = withDefaults(depsIn);
  const w = loadWave(manifestPath, deps, { routes: false });
  if (!w.ok) return { code: 2, out: { schema: SUPERVISOR_SCHEMA, outcome: 'refused', code: w.code } };
  const paths = journalPaths(stateDir, w.manifest.wave_id);
  const doc = readJournal(paths, w.manifest.wave_id);
  const out = { schema: SUPERVISOR_SCHEMA, outcome: 'swept', reconcile: {}, ops: {}, tick: null, measurement: 'qualified' };
  for (const t of w.manifest.tickets) {
    if (!deps.readState(t)?.durable) { out.reconcile[t.key] = 'no_durable_run'; continue; }
    const r = deps.reconcile(t);
    out.reconcile[t.key] = r.timed_out ? 'timed_out' : r.status;
  }
  const clock = resolveSweepClock(deps.sweepClock);
  if (!clock) out.measurement = 'unqualified: MEASUREMENT_QUALIFIED is false (G0), nothing measured or signalled';
  const killed = [];
  for (const o of Object.values(doc.ops)) {
    if (!live(o) || !o.pgid || !o.deadline) continue;
    if (!clock) { out.ops[o.op_id] = 'unmeasured'; continue; }
    const seen = observe(structuredClone(o.deadline), clock);
    if (seen.boot_ended || !seen.expired) { out.ops[o.op_id] = seen.boot_ended ? 'boot_ended' : 'within_bound'; continue; }
    const id = groupIdentity({ pgid: o.pgid, leader_start: o.leader_start }, deps.isAlive);
    if (id !== 'verified') { out.ops[o.op_id] = `expired_${id}`; continue; }
    const after = await killGroup(o.pgid, deps.isAlive);
    out.ops[o.op_id] = after === false ? 'killed' : 'kill_unproven';
    if (after === false) killed.push({ id: o.op_id, charged_ms: seen.charged_ms });
  }
  if (doc.tick && clock) {
    const seen = observe(structuredClone(doc.tick.deadline), clock);
    const now = processInfo(doc.tick.pid);
    if (seen.expired && now.alive && doc.tick.start_identity && sameStart(now, doc.tick.start_identity)) {
      try { process.kill(doc.tick.pid, 'SIGKILL'); out.tick = 'killed'; } catch { out.tick = 'kill_failed'; }
    } else out.tick = seen.expired ? 'expired_unverified' : 'within_bound';
  }
  if (killed.length) {
    try {
      await withJournal(paths, w.manifest.wave_id, async (J) => {
        for (const k of killed) if (J.op(k.id) && live(J.op(k.id))) await J.update(k.id, { timed_out: { charged_ms: k.charged_ms } });
      });
      out.settlement = 'recorded';
    } catch (e) { out.settlement = e.code === 'journal_busy' ? 'deferred_to_tick' : `failed: ${e.message}`; }
  }
  return { code: 0, out };
}

// ---------------------------------------------------------------------------------------------------- launchd (LaunchAgents)

// launchd starts jobs with a minimal PATH (no nvm/Homebrew node): bake the absolute interpreter and a PATH that still finds
// git, gh and the provider CLIs; XML-escape every value (adapted from scripts/autoupdate.mjs jobEnv/xml, not its updater job).
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function jobEnv(home) {
  const nodeBin = process.execPath;
  const path = [dirname(nodeBin), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((p, i, a) => a.indexOf(p) === i).join(':');
  return { nodeBin, path };
}
export const label = (waveId, job) => `com.ai-skills.ship-ticket.supervisor.${waveId}.${job}`;
export const INTERVALS = Object.freeze({ tick: 120, sweep: 60 });

/**
 * The plist of one job. No KeepAlive (one-shot jobs on StartInterval, E-6): launchd starts no second instance while one runs
 * and skips firings missed while asleep (man launchd.plist). No StandardOutPath/StandardErrorPath (launchd opens them before
 * the process starts; see scripts/autoupdate.mjs). AbandonProcessGroup true: launchd does not kill the job's process group
 * when it exits; the launched work runs in groups of its own anyway (startLauncher), so this is NOT an enforcement mechanism.
 */
export function plistXml({ waveId, job, manifestPath, stateDir, home, workdir }) {
  const { nodeBin, path } = jobEnv(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label(waveId, job))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBin)}</string>
    <string>${xml(join(HERE, 'supervisor.mjs'))}</string>
    <string>${xml(job)}</string>
    <string>--wave</string>
    <string>${xml(manifestPath)}</string>
    <string>--state-dir</string>
    <string>${xml(stateDir)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string><key>HOME</key><string>${xml(home)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(workdir)}</string>
  <key>StartInterval</key><integer>${INTERVALS[job]}</integer>
  <key>RunAtLoad</key><true/>
  <!-- AbandonProcessGroup: launched work lives in its own process groups; this keeps launchd from killing them at job exit. It enforces nothing. -->
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/** install/uninstall: print by default; `write` writes or removes ONLY the two label files under <home>/Library/LaunchAgents. Never runs launchctl. */
export function installPlan({ manifestPath, stateDir, home = homedir(), remove = false, write = false }, deps = {}) {
  const w = loadWave(manifestPath, withDefaults(deps));
  if (!w.ok) return { code: 2, out: { outcome: 'refused', code: w.code } };
  const dir = join(home, 'Library', 'LaunchAgents');
  const jobs = ['tick', 'sweep'].map((job) => ({ job, label: label(w.manifest.wave_id, job), path: join(dir, `${label(w.manifest.wave_id, job)}.plist`),
    xml: remove ? null : plistXml({ waveId: w.manifest.wave_id, job, manifestPath, stateDir, home, workdir: dirname(manifestPath) }) }));
  if (write) {
    mkdirSync(dir, { recursive: true });
    for (const j of jobs) { if (remove) { try { unlinkSync(j.path); } catch (e) { if (e.code !== 'ENOENT') throw e; } } else writeFileSync(j.path, j.xml, { mode: 0o644 }); }
  }
  const domain = 'gui/$(id -u)';
  return { code: 0, out: { outcome: write ? (remove ? 'removed' : 'written') : 'dry_run', jobs,
    owner_commands: jobs.map((j) => remove ? `launchctl bootout ${domain}/${j.label}` : `launchctl bootstrap ${domain} ${j.path}`),
    note: write && !remove
      ? 'written, not bootstrapped now: but launchd loads every plist in ~/Library/LaunchAgents at the NEXT LOGIN (RunAtLoad), so a written plan ACTIVATES then; remove it with uninstall --write true if that is not intended. LaunchAgents run only while the owner is logged in (Option A)'
      : 'nothing was written or bootstrapped: writing (--write true) activates the jobs at the next login (RunAtLoad); bootstrapping now is an owner action (H3). LaunchAgents run only while the owner is logged in (Option A)' } };
}

// ---------------------------------------------------------------------------------------------------- CLI

export async function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!k || rest[i + 1] === undefined || Object.hasOwn(flags, k) || !['wave', 'state-dir', 'write'].includes(k)) throw Object.assign(new Error(`bad, unknown or repeated flag: ${rest[i]}`), { usage: true });
    flags[k] = rest[i + 1];
  }
  if (!['tick', 'sweep', 'install', 'uninstall'].includes(cmd) || !flags.wave || (flags.write !== undefined && flags.write !== 'true'))
    throw Object.assign(new Error('usage: supervisor.mjs tick|sweep|install|uninstall --wave <manifest> [--state-dir <dir>] [--write true]'), { usage: true });
  const manifestPath = resolve(flags.wave);
  const stateDir = flags['state-dir'] ? resolve(flags['state-dir']) : DEFAULT_STATE_DIR();
  if (!isAbsolute(stateDir)) throw Object.assign(new Error('--state-dir must resolve to an absolute path'), { usage: true });
  if (cmd === 'tick' || cmd === 'sweep') { // decorrelated start (START_JITTER_MS): launchd fires both jobs together at load
    const J = START_JITTER_MS[cmd];
    await (deps.sleep ?? delay)(J.base + Math.floor((deps.random ?? Math.random)() * J.spread));
  }
  if (cmd === 'tick') {
    const watchdog = setTimeout(() => process.exit(70), TICK_BOUND_MS); // the tick's own in-process bound
    watchdog.unref();
    try { return await tick({ manifestPath, stateDir }, deps); } finally { clearTimeout(watchdog); }
  }
  if (cmd === 'sweep') return sweep({ manifestPath, stateDir }, deps);
  return installPlan({ manifestPath, stateDir, remove: cmd === 'uninstall', write: flags.write === 'true', home: deps.home ?? homedir() }, deps);
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(({ code, out }) => { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exitCode = code; },
    (e) => { process.stderr.write(`supervisor: ${e.message}\n`); process.exitCode = e.usage ? 1 : 2; });
}
