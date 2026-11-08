/**
 * Attempts of the durable run engine (run-engine.mjs): the launch handshake through the carrier's
 * launcher, whole-group quiescence before an attempt is recorded, reconciliation of attempts left
 * by a crashed engine or gate (workers, RED runners and proof runners alike), the RED dispatch
 * barrier, budget admission, durable resource locks, builder identities and finding-bound REPAIR
 * with its repair record. `E` is the command context built by run-engine.mjs `open()`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { schedule, admit } from './harness.mjs';
import { prepareDispatch, childEnv, spawnSpec, workerRunStateAppend } from './carrier.mjs';
import { extractUsage, evaluateBudget, addUsageRecords } from './usage.mjs';
import * as io from './engine-io.mjs';
import { retire, LIVE, leaderStart } from './engine-quiesce.mjs';
import { judgment, note, closure, scope, under, overlap, providerOk, clampTimeout } from './engine-dag.mjs';
import { depDone, stateMemo } from './engine-units.mjs';

const MAX_PROVE_BATCHES = 2, MAX_REVIEW_REPAIRS = 1, MAX_RETRIES = 1;
const UNSETTLED = ['intent', 'launched'];
const RUNNER_KINDS = ['gate-red', 'proof', 'unit-check'];
const itemOf = (S, a) => (a.kind === 'repair' ? S.repairs.find(r => r.id === a.node) : S.nodes[a.node]);
const pushJudgment = (S, code, node, reason) => { if (!S.judgments.some(j => j.code === code && j.node === node)) S.judgments.push(judgment(code, node, reason)); };
const transientOnce = (list, code, node, reason) => { if (!list.some(j => j.code === code && j.node === node)) list.push(judgment(code, node, reason)); };

// ---- usage and budgets ------------------------------------------------------------------------

/** Whether `r` passes usage.mjs record validation (provider, run_id, counters, source fields). */
function validUsage(r) {
  try { addUsageRecords([], [r]); return true; } catch { return false; }
}

/**
 * Engine usage plus the imported file (`<ticket>.usage.jsonl`: usage.mjs import-session/import-codex
 * --out), deduplicated by source_execution_id (the engine's aggregate wins). An import line that is
 * malformed or not a valid usage record counts as unknown usage, so the budget is flagged
 * unenforceable rather than silently under-counted or crashing the command.
 */
export function usageRecords(E) {
  const { S, P } = E;
  const text = io.readIfExists(P.usage) ?? '';
  const imported = text.split(/\r?\n/).filter(l => l.trim()).map((line, i) => {
    let r = null;
    try { r = JSON.parse(line); } catch { /* malformed: counted as unknown below */ }
    if (r && typeof r === 'object' && typeof r.run_id === 'string' && r.run_id !== S.run_id) return r; // another run: filtered below
    return validUsage(r) ? r
      : { provider: S.config.provider, run_id: S.run_id, source: 'import-invalid', source_execution_id: `invalid:${i + 1}` };
  }).filter(r => r.run_id === S.run_id);
  return addUsageRecords(S.usage, imported).records;
}

/** Budget verdict for `phase` (or the ticket only); null when the DAG sets no budget. */
export function budgetVerdict(E, phase) {
  const budget = E.S.config.budget;
  if (!budget) return null;
  return evaluateBudget(usageRecords(E), budget, phase ? { phase } : {});
}

/** Budget admission immediately before a node or repair dispatch, with its phase. */
function budgetOk(E, transient, phase) {
  const v = budgetVerdict(E, phase);
  if (!v || v.dispatch_allowed) return true;
  const which = v.phase?.state === 'stop_dispatch' ? `${phase} phase budget reached (${v.phase.used}/${v.phase.limit})` : `ticket budget reached (${v.ticket.used}/${v.ticket.limit})`;
  transientOnce(transient, 'budget_stop', null, which);
  return false;
}

// ---- RED barrier ------------------------------------------------------------------------------

/** What changed since RED evidence `ev` was accepted ({ changed, moved }), or null when it still binds. */
export function redChanges(E, ev) {
  const { S, ctx } = E;
  E.baseCommit ??= io.resolveCommit(ctx.repoRoot, S.config.base ?? 'HEAD');
  const changed = Object.entries(ev.spec_digests ?? {}).filter(([f, digest]) => io.repoFileDigest(ctx.repoRoot, f) !== digest).map(([f]) => f);
  const moved = ev.base_commit !== undefined && ev.base_commit !== E.baseCommit;
  return changed.length || moved ? { changed, moved } : null;
}

/** What invalidated RED of `d` (the text every red_invalidated reason starts with). */
export const invalidCause = (d, inv) => (inv.base_moved ? `config.base moved since RED of ${d}`
  : `spec file(s) changed since RED of ${d}: ${inv.changed.join(', ')}`);

/**
 * Drop the RED evidence of `d` (RED_INVALIDATED, which also resets gateRed's dispatched-before-RED
 * ordering) into `S.gates.red_invalid[d]` with the old evidence, so the next drive re-runs RED
 * (engine-gates.mjs refreshRed) and restored bytes can restore it. Never silent.
 */
export function invalidateRed(E, d, { changed, moved }) {
  const { S } = E;
  const ev = S.gates.red[d];
  delete S.gates.red[d];
  note(S, 'RED_INVALIDATED', { node: d, changed, base_moved: moved });
  (S.gates.red_invalid ??= {})[d] = { changed, base_moved: moved, seq: S.seq, command: ev.command, evidence: ev, rerun: null };
}

/**
 * Whether the accepted RED evidence of RED-bearing node `d` is still valid: every spec file digest
 * and the resolved config.base commit are unchanged. A drive re-runs invalid RED before it
 * dispatches (refreshRed); a change seen mid-dispatch is invalidated here and re-run next drive.
 * A dependent's own writes never invalidate it.
 */
function redValid(E, d, transient) {
  const ev = E.S.gates.red[d];
  if (!ev) return false;
  const what = redChanges(E, ev);
  if (!what) return true;
  invalidateRed(E, d, what);
  transientOnce(transient, 'red_invalidated', d, `${invalidCause(d, E.S.gates.red_invalid[d])}; the next drive re-runs RED`);
  return false;
}

/** RED barrier for a node: every dependency that declares redSpecs has valid accepted RED. */
const redReady = (E, n, transient) => n.deps.every(d => !E.S.nodes[d].redSpecs.length || redValid(E, d, transient));

/** RED barrier for a repair: it inherits the prerequisites of every node whose writes it overlaps. */
function repairRedReady(E, r, transient) {
  const affected = Object.values(E.S.nodes).filter(n => n.writes.some(w => r.writes.some(p => overlap(w, p))));
  const missing = [...new Set(affected.flatMap(n => n.deps))].filter(d => E.S.nodes[d].redSpecs.length && !E.S.gates.red[d]);
  if (missing.length) { transientOnce(transient, 'red_required', r.id, `repair waits for accepted RED of ${missing.join(', ')}`); return false; }
  return affected.every(n => redReady(E, n, transient));
}

/** Done RED-bearing nodes without accepted RED (the orchestrator's next `gate red`). */
export const redPending = (S) => Object.entries(S.nodes).filter(([id, n]) => n.redSpecs.length && n.state === 'done' && !S.gates.red[id]).map(([id]) => id);

// ---- attempts ---------------------------------------------------------------------------------

/** Net change since the attempt's pre-snapshot, minus concurrently owned paths; null when unknowable. */
function changes(E, a) {
  const now = io.snapshot(E.ctx.repoRoot);
  if (!now || !a.pre_snapshot) return null;
  const changed = io.diffSnapshots(a.pre_snapshot, now).filter(p => !under(p, a.excluded));
  if (!changed.includes(E.P.planRel) || !workerRunStateAppend(planBefore(a), io.readIfExists(E.P.plan))) return changed;
  note(E.S, 'PLAN_APPENDED', { attempt_id: a.attempt_id, node: a.node }); // a verified RUN-STATE append, kept auditable
  return changed.filter(p => p !== E.P.planRel);
}

const planBefore = (a) => (a.plan_before_file ? io.readIfExists(a.plan_before_file) : null);

/** Record a retired (quiescent) attempt from its envelope: done, an automatic retry, a violation or a failure. */
function record(E, a, item, env) {
  const { S } = E;
  a.envelope = env;
  const out = io.readIfExists(env.stdout_file);
  S.usage.push({ provider: a.provider, run_id: S.run_id, node_id: a.node, phase: a.phase, role: a.role, attempt_id: a.attempt_id,
    source: 'engine', source_execution_id: a.attempt_id, ...(out === null ? {} : extractUsage(a.provider, out) ?? {}) });
  const changed = changes(E, a);
  if (changed === null) {
    item.state = 'failed'; item.reason = 'ownership check unavailable: git could not snapshot the work tree';
    pushJudgment(S, 'ownership_unavailable', a.node, item.reason);
    return;
  }
  if (env.exit_code === 0 && !env.spawn_error && providerOk(a.provider, out)) {
    const outside = changed.filter(p => !under(p, a.allowed));
    if (outside.length) {
      item.state = 'failed'; item.reason = 'wrote outside its write set: ' + outside.join(', ');
      pushJudgment(S, a.kind === 'repair' ? 'repair_outside_findings' : 'ownership_violation', a.node, item.reason);
      return;
    }
    item.state = 'done'; item.reason = null;
    if (a.kind === 'node') item.fps = io.fingerprints(E.ctx.repoRoot, [...item.reads, ...item.writes]);
    else completeRepair(E, item, a, changed.length ? changed : item.writes);
    return;
  }
  if (!changed.length && (item.retries ?? 0) < MAX_RETRIES) {
    item.retries = (item.retries ?? 0) + 1; item.state = 'pending'; a.status = 'retried';
    item.reason = `automatic retry after ${env.spawn_error ?? 'provider error'}`;
    note(S, 'INFRA_RETRY', { node: a.node, attempt_id: a.attempt_id, cause: env.spawn_error ?? 'provider_error' });
    return;
  }
  item.state = 'failed';
  item.reason = out === null ? 'worker left no output file' : env.spawn_error ? `spawn error ${env.spawn_error}` : `provider error (exit ${env.exit_code})`;
}

/**
 * After an authorized REPAIR: re-bind the affected closure's fingerprints, append the repair record
 * { kind:'repair', review_execution, old_candidate, new_candidate, write_set, attempt_id } and
 * re-freeze on the new candidate, which the targeted confirmation must review.
 */
function completeRepair(E, repair, a, paths) {
  const { S, ctx } = E;
  const hit = Object.entries(S.nodes).filter(([, n]) => [...n.reads, ...n.writes].some(p => paths.some(q => overlap(p, q)))).map(([id]) => id);
  const ids = closure(S, hit);
  for (const id of ids) if (S.nodes[id].fps) S.nodes[id].fps = io.fingerprints(ctx.repoRoot, Object.keys(S.nodes[id].fps));
  if (repair.kind !== 'review') return;
  S.confirmation = { review_execution: repair.review_execution, closure: ids };
  const c = io.candidateId(ctx.repoRoot, S.config.base ?? 'HEAD', S.pinned_exclusions);
  if (!c.candidate_id) { pushJudgment(S, 'candidate_unavailable', repair.id, `repaired candidate not computable: ${c.reason}`); return; }
  S.review_chain.push({ review_execution: repair.review_execution, kind: 'repair', old_candidate: repair.old_candidate ?? null,
    new_candidate: c.candidate_id, write_set: [...repair.writes], attempt_id: a.attempt_id });
  note(S, 'REPAIR_RECORDED', { review_execution: repair.review_execution, new_candidate: c.candidate_id });
  S.freeze = { candidate: c.candidate_id, seq: S.seq };
  S.frozen_candidate = c.candidate_id;
}

const unquiet = (S, a, item) => {
  if (item) { item.state = 'failed'; item.reason = 'process-group quiescence not proven (unknowable, or alive after SIGKILL)'; }
  pushJudgment(S, 'quiescence_unknown', a.node, `cannot prove process group ${a.pgid ?? a.pid} has exited; nothing recorded`);
};

/**
 * Settle an attempt with no in-process owner, or one whose launcher just exited. Envelope present
 * or group gone: retire() kills and awaits any surviving group member first (whole-group
 * quiescence); only then is it recorded. A live group without an envelope -> 'live' (never a
 * duplicate writer); unknown quiescence -> judgment, locks kept; quiescent with no relevant writes
 * (or never released) -> re-queued.
 */
async function settle(E, a, { timedOut = false, wait = 0 } = {}) {
  const { S } = E;
  const item = itemOf(S, a);
  if (!item) { if (!(await retire(S, a, E.alive, 'orphaned'))) unquiet(S, a, null); return; }
  let env = io.readJson(a.envelope_file);
  if (!env && a.status === 'intent') { // never released: no pid was recorded
    if (await retire(S, a, E.alive, 'abandoned')) item.state = 'pending'; else unquiet(S, a, item);
    return;
  }
  if (!env) {
    let alive = E.alive(a.pgid);
    for (const until = Date.now() + wait; alive === true && Date.now() < until && !env; alive = E.alive(a.pgid)) { await io.delay(50); env = io.readJson(a.envelope_file); }
    env ??= io.readJson(a.envelope_file);
    if (!env && alive === true && !timedOut) return 'live';
  }
  if (!(await retire(S, a, E.alive, 'exited'))) return unquiet(S, a, item);
  if (env) return record(E, a, item, env);
  if (timedOut) { a.status = 'timed_out'; item.state = 'failed'; item.reason = 'timeout (never retried automatically)'; return; }
  const changed = changes(E, a);
  if (changed === null) {
    a.status = 'crashed'; item.state = 'failed'; item.reason = 'worker died without an envelope; ownership check unavailable';
    pushJudgment(S, 'ownership_unavailable', a.node, item.reason);
    return;
  }
  if (changed.length) {
    a.status = 'crashed'; item.state = 'failed'; item.reason = 'worker died without an envelope after writing';
    pushJudgment(S, 'crash_with_writes', a.node, `changed: ${changed.join(', ')}`);
    return;
  }
  a.status = 'abandoned'; item.state = 'pending';
}

/** A RED or proof runner left by a crashed gate: live -> blocks; unknown -> judgment; gone -> retired 'abandoned', locks released. */
async function settleRunner(E, a) {
  const alive = a.status === 'intent' ? false : E.alive(a.pgid);
  if (alive === true) return 'live';
  if (alive === null || !(await retire(E.S, a, E.alive, 'abandoned'))) {
    pushJudgment(E.S, 'quiescence_unknown', a.node, `cannot prove ${a.kind} runner group ${a.pgid ?? a.pid} has exited`);
    return 'live';
  }
}

/**
 * Remove and return ({ code, node }[]) the SPENT judgments of `S`: a quiescence_unknown whose every
 * attempt has since been retired (its group proven gone), so the hazard it reported is over. A
 * worker's node stays failed (only mark retries it); a runner's gate can simply run again.
 */
export function clearSpent(S) {
  const spent = (j) => {
    const mine = S.attempts.filter(a => a.node === j.node);
    return j.code === 'quiescence_unknown' && mine.length > 0 && mine.every(a => !LIVE.includes(a.status) && a.quiesced === true);
  };
  const cleared = S.judgments.filter(spent).map(j => ({ code: j.code, node: j.node }));
  S.judgments = S.judgments.filter(j => !spent(j));
  return cleared;
}

/** Settle every unfinished attempt left by an earlier engine or gate process (workers and runners). */
export async function reconcile(E, wait) {
  let live = false;
  for (const a of E.S.attempts) {
    if (E.live.has(a.attempt_id)) continue;
    const runner = RUNNER_KINDS.includes(a.kind);
    // A worker left 'unknown' (its item already failed with a judgment) is retired, releasing its
    // locks, once its group is proven gone (retire kills survivors). Until then it is live: keeps its
    // locks and blocks dispatch, so a node marked failed->pending never runs beside it.
    if (!runner && a.status === 'unknown') { if (!(await retire(E.S, a, E.alive, 'abandoned'))) live = true; continue; }
    if (!(runner ? ['intent', 'running', 'unknown'] : UNSETTLED).includes(a.status)) continue;
    if ((runner ? await settleRunner(E, a) : await settle(E, a, { wait })) === 'live') live = true;
  }
  return live;
}

/**
 * One attempt through the launch handshake; resolves once it is settled and committed. Returns
 * true once the launch intent was committed (an actual dispatch): `job.onLaunch` runs in that same
 * commit, so round counters move only with a real dispatch.
 */
async function runAttempt(E, job) {
  const { ctx, S, P } = E;
  const { item } = job, cfg = S.config, platform = ctx.platform ?? process.platform;
  const timeoutMs = clampTimeout(cfg.timeoutMs);
  item.state = 'running';
  let plan;
  try {
    plan = prepareDispatch({ phase: job.phase, provider: cfg.provider, nodeId: item.id, workdir: ctx.repoRoot, repoRoot: ctx.repoRoot,
      ownership: { writes: job.writes, othersOwned: job.othersOwned }, timeoutMs, billing: cfg.billing, allowApiBilling: ctx.allowApiBilling === true,
      promptFile: job.promptFile, permissionMode: cfg.permissionMode, modelMap: cfg.modelMap, risk: item.risk ?? [],
      complexity: item.complexity ?? 'medium', modelTier: item.modelTier, reviewExecution: job.reviewExecution, role: item.role });
  } catch (e) { item.state = 'failed'; item.reason = 'dispatch refused: ' + e.message; await E.commit(); return false; }
  const env = childEnv(cfg.provider, plan.billing, ctx.env ?? process.env);
  const spec = spawnSpec(plan.executable, plan.args, platform, env);
  mkdirSync(P.attempts, { recursive: true });
  const id = 'att-' + randomUUID();
  const pre = io.snapshot(ctx.repoRoot);
  const planBefore = io.readIfExists(P.plan);
  const planBeforeFile = join(P.attempts, id + '.plan-before');
  if (planBefore !== null) writeFileSync(planBeforeFile, planBefore, { mode: 0o600 });
  const a = { attempt_id: id, kind: job.kind, node: item.id, phase: job.phase, provider: cfg.provider, model: plan.model, role: plan.role,
    status: 'intent', resources: [...(job.resources ?? [])], pre_snapshot: pre, pre_snapshot_digest: io.sha(JSON.stringify(pre)),
    plan_before_file: planBefore === null ? null : planBeforeFile, allowed: job.allowed, excluded: [...job.othersOwned],
    envelope_file: join(P.attempts, id + '.envelope.json'), out_file: join(P.attempts, id + '.out'), started_at: new Date().toISOString() };
  for (const b of E.live.values()) { b.excluded.push(...job.writes); a.excluded.push(...b.writes); }
  E.live.set(id, Object.assign(a, { writes: job.writes }));
  S.attempts.push(a);
  for (const r of a.resources) S.locks[r] = id;
  const identity = `${cfg.provider}:${plan.model}`;
  if (!S.builders.some(b => b.identity === identity && b.node === item.id)) S.builders.push({ provider: cfg.provider, model: plan.model, node: item.id, identity });
  item.attempts = (item.attempts ?? 0) + 1;
  job.onLaunch?.();
  note(S, 'DISPATCH', { node: item.id, attempt_id: id });
  try {
    await E.commit();
    await io.boundary(ctx.hooks, 'after-intent', { attempt_id: id, node: item.id });
    const child = io.startLauncher({ spawnFn: ctx.spawn, spec, cwd: ctx.repoRoot, env, platform,
      files: { promptFile: plan.promptFile, outFile: a.out_file, envelopeFile: a.envelope_file, attemptId: id } });
    const exited = new Promise(r => { child.on('exit', r); child.on('error', r); });
    child.stdin.on('error', () => {});
    await io.boundary(ctx.hooks, 'after-spawn', { attempt_id: id });
    if (!child.pid) { await exited; await settleSpawnFailure(E, a, item); return true; }
    a.pid = child.pid; a.pgid = platform === 'win32' ? null : child.pid; a.leader_start = leaderStart(a.pgid); a.status = 'launched';
    await E.commit();
    await io.boundary(ctx.hooks, 'after-pid', { attempt_id: id, pid: a.pid, pgid: a.pgid });
    await new Promise(r => child.stdin.end(io.RELEASE, r));
    await io.boundary(ctx.hooks, 'after-release', { attempt_id: id });
    let timedOut = false, killing = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killing = platform === 'win32' ? spawnSync('taskkill', ['/pid', String(a.pid), '/T', '/F'], { stdio: 'ignore' }) : io.killGroup(a.pgid, E.alive);
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
    await killing;
    await settle(E, a, { timedOut, wait: 2000 });
    await E.commit();
    return true;
  } finally { E.live.delete(id); }
}

/** The launcher itself failed to start (no pid recorded, nothing ran): retired, retried once, then failed. */
async function settleSpawnFailure(E, a, item) {
  if (!(await retire(E.S, a, E.alive, 'spawn_failed'))) { unquiet(E.S, a, item); await E.commit(); return; }
  if ((item.retries ?? 0) < MAX_RETRIES) {
    item.retries = (item.retries ?? 0) + 1; item.state = 'pending';
    note(E.S, 'INFRA_RETRY', { node: a.node, attempt_id: a.attempt_id, cause: 'launcher_spawn_failed' });
  } else { item.state = 'failed'; item.reason = 'launcher spawn failed'; }
  await E.commit();
}

/** Whether `n` may start beside the running nodes: durable locks, scheduler conflicts/width/memory, then live admission. */
function fits(E, n, running) {
  if (n.resources.some(r => E.S.locks[r] !== undefined)) return false;
  const members = [...[...running].map(id => E.S.nodes[id]), n];
  const plain = members.map(m => ({ id: m.id, reads: m.reads, writes: m.writes, resources: m.resources, risk: m.risk,
    complexity: m.complexity, estimatedMemoryMb: m.estimatedMemoryMb }));
  const s = schedule({ phase: n.phase, nodes: plain, maxConcurrency: E.S.config.width, memoryBudgetMb: E.S.config.memoryBudgetMb ?? null });
  if (s.waves[0].nodes.length !== members.length) return false;
  if (members.length === 1) return true;
  const verdict = admit({ phase: n.phase, members: members.length, estimatedMemoryMb: members.reduce((t, m) => t + m.estimatedMemoryMb, 0) },
    E.ctx.admissionProbe ?? {});
  if (!verdict.admitted && !E.refused.has(n.id)) { E.refused.add(n.id); note(E.S, 'ADMISSION_REFUSED', { node: n.id, reasons: verdict.reasons }); }
  return verdict.admitted;
}

/**
 * Continuous dispatch of ready nodes (deps done, a dependency of another unit verified, valid RED
 * for RED-bearing deps, budget admitted) until nothing more can start. While `hold()` (unit checks
 * are ready) no new node starts; once nothing runs, `onIdle` (the unit checks) runs, and when it
 * reports progress dispatch continues, so checks are never starved by continuous dispatch. Every launched
 * attempt is awaited (allSettled) before this returns or rethrows, so the caller's lock is never
 * released while a sibling can still commit.
 */
export async function dispatchNodes(E, transient, { onIdle, hold } = {}) {
  const { S } = E;
  const limit = scope(S, E.ctx.until);
  const running = new Map();
  let failure = null, stop = false;
  try {
    for (;;) {
      if (!failure && !stop && !S.judgments.length && !hold?.()) {
        const states = stateMemo(E);
        const ready = Object.values(S.nodes).filter(n => ['pending', 'stale'].includes(n.state) && !running.has(n.id)
          && (!limit || limit.has(n.id)) && n.deps.every(d => depDone(E, n, d, states)) && redReady(E, n, transient));
        for (const n of ready) {
          if (!budgetOk(E, transient, n.phase)) { stop = true; break; }
          if (!fits(E, n, running.keys())) continue;
          running.set(n.id, runAttempt(E, { kind: 'node', item: n, phase: n.phase, writes: n.writes, othersOwned: n.othersOwned,
            allowed: n.writes, promptFile: n.promptFile, resources: n.resources })
            .catch(e => { failure ??= e; }).finally(() => running.delete(n.id)));
        }
      }
      if (!running.size) { if (!failure && !stop && onIdle && await onIdle()) continue; break; }
      await Promise.race(running.values());
    }
  } finally { await Promise.allSettled(running.values()); }
  if (failure) throw failure;
}

/** REPAIR authorization from engine state alone: the gate review chain and the round counters. */
function authorize(S, r, batchOpen) {
  if (r.kind === 'review') {
    const rx = r.review_execution;
    // Canonical gate.mjs gateReview record only: { kind:'original', outcome, findings: [{ id, severity, paths }], write_set }.
    const fail = (S.review_chain ?? []).find(e => e.review_execution === rx && e.outcome === 'FAIL'
      && Array.isArray(e.write_set) && Array.isArray(e.findings) && e.findings.every(f => Array.isArray(f?.paths)));
    if (!fail) return { code: 'repair_unauthorized', reason: `no canonical FAIL review record ${rx} in engine state` };
    // A repair already holding its round (re-queued by an automatic infra retry) re-dispatches within it.
    if ((S.rounds.review_repairs[rx] ?? 0) >= MAX_REVIEW_REPAIRS && !r.round_held) return { code: 'round_limit', reason: `review ${rx} already had its repair` };
    if (!r.writes?.length || !r.writes.every(p => under(p, fail.write_set))) return { code: 'repair_unauthorized', reason: 'repair writes exceed the finding paths' };
    return { allowed: r.writes, phase: 'REPAIR' };
  }
  if (r.kind === 'prove') {
    if (S.rounds.prove_repair_batches >= MAX_PROVE_BATCHES && !batchOpen) return { code: 'round_limit', reason: 'two PROVE repair batches already used' };
    return { allowed: r.writes, phase: 'PROVE' };
  }
  return { code: 'repair_unauthorized', reason: `unknown repair kind ${r.kind}` };
}

/**
 * A review repair starts from the frozen candidate: any drift since the freeze (even outside every
 * node's fingerprints and the finding-bound write set) is post_freeze_drift, never absorbed into
 * the repaired candidate the confirmation reviews.
 */
function startsFromFreeze(E, r, transient) {
  const c = io.candidateId(E.ctx.repoRoot, E.S.config.base ?? 'HEAD', E.S.pinned_exclusions);
  const frozen = E.S.freeze?.candidate;
  if (c.candidate_id && c.candidate_id === frozen && (r.old_candidate ?? frozen) === frozen) return true;
  transientOnce(transient, 'post_freeze_drift', r.id, `work tree is ${c.candidate_id ?? c.reason}, frozen is ${frozen ?? '(none)'}: `
    + 'unexpected drift since the freeze; the repair waits (revert the drift or decide)');
  return false;
}

/** Authorized repairs, each through the RED barrier and budget admission; counters move only on a real dispatch. */
export async function runRepairs(E, transient) {
  const { S } = E;
  let batchOpen = false;
  for (const r of S.repairs) {
    if (r.state !== 'pending' || S.judgments.length) continue;
    const auth = authorize(S, r, batchOpen);
    if (auth.code) { transient.push(judgment(auth.code, r.id, auth.reason)); continue; }
    if (!repairRedReady(E, r, transient)) continue;
    if (r.kind === 'review' && !startsFromFreeze(E, r, transient)) continue;
    if (!budgetOk(E, transient, auth.phase)) break;
    const onLaunch = () => {
      if (r.kind === 'review') {
        if (!r.round_held) S.rounds.review_repairs[r.review_execution] = (S.rounds.review_repairs[r.review_execution] ?? 0) + 1;
        r.round_held = true;
      } else if (!batchOpen) { S.rounds.prove_repair_batches += 1; batchOpen = true; }
    };
    await runAttempt(E, { kind: 'repair', item: r, phase: auth.phase, writes: r.writes, othersOwned: [], allowed: auth.allowed,
      promptFile: r.promptFile, reviewExecution: r.review_execution, onLaunch });
  }
}
