/**
 * Opt-in units of the durable run engine (AIS-HARNESS-3 Wave 2a). A DAG whose nodes carry no
 * `unit` never reaches this module's mutating paths: `S.unit_checks` exists only when one does.
 *
 * A unit is the set of nodes sharing a `unit` tag. Once all its nodes are done, at a quiescent
 * point, the engine runs the union of their `checks` (config.testCommands) under the runner
 * protocol: attempt kind 'unit-check', the unit's resources as durable locks, retire() before any
 * result counts. The stored check evidence is bound to the current fingerprints of the unit's
 * reads and writes, the resolved config.base commit, each node's attempt count and each dependency
 * unit's evidence; its validity is recomputed at every use (the projection is never authority).
 * Wave 2b-i adds the run-wide re-check ceiling (`parent_ceiling`) and the owner clearing path
 * (`clearUnit`, authorized by a trusted RUN-STATE UNIT_CLEAR).
 * `E` is run-engine.mjs's command context.
 */
import { randomUUID } from 'node:crypto';
import { spawnSpec } from './carrier.mjs';
import * as io from './engine-io.mjs';
import { retire, leaderStart, LIVE } from './engine-quiesce.mjs';
import { note, judgment, closure, clampTimeout, coded } from './engine-dag.mjs';
import { trustedEvents, untrustedEvents } from './engine-authority.mjs';

/** Verified evidence invalidated more often than this in one run is an invalidation storm. */
export const MAX_UNIT_INVALIDATIONS = 2;
/**
 * Default of `config.unitRecheckCeiling`: unit check re-runs (a unit checked again after a failed,
 * stale or cleared result) allowed per run across ALL units together. A constant: neither the unit
 * count nor the node count scales it.
 */
export const DEFAULT_UNIT_RECHECK_CEILING = 4;
const J = JSON.stringify;

/** Whether the run has units (the DAG tagged at least one node). */
export const hasUnits = (S) => S.unit_checks !== undefined;

/** `gate red`/proof/unit-check runner deps: durable commits, the launcher, binding re-check. */
export function runnerDeps(E) {
  const { ctx } = E, platform = ctx.platform ?? process.platform, env = ctx.env ?? process.env;
  return io.gateRedDeps({ repoRoot: ctx.repoRoot, dir: E.P.attempts, platform, env, alive: E.alive, spawnFn: ctx.spawn,
    commit: async (snap) => { E.S = snap; await E.commit(); }, toSpec: (cmd, args) => spawnSpec(cmd, args, platform, env),
    verifyBinding: () => E.verifyBinding() });
}

/** A prototype-free record (unit and check names are keys; `constructor` must stay an ordinary name). */
export const dict = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));

/**
 * Static unit structure derived from the bound nodes, in dependency order: { nodes, checks,
 * acceptance, resources, paths, deps, upstream, upstreamPaths } per unit. `deps` are the nearest
 * units a node of the unit depends on (through unit-less nodes); `upstream` every transitive
 * dependency node outside the unit, and `upstreamPaths` the declared paths of the unit-less ones.
 */
export function units(S) {
  const out = new Map();
  for (const n of Object.values(S.nodes)) {
    if (n.unit === undefined) continue;
    if (!out.has(n.unit)) out.set(n.unit, { nodes: [], checks: [], acceptance: [], resources: [], paths: [], deps: [], upstream: [], upstreamPaths: [] });
    const u = out.get(n.unit);
    u.nodes.push(n.id);
    for (const [k, list] of [['checks', n.checks], ['acceptance', n.acceptance], ['resources', n.resources], ['paths', [...n.reads, ...n.writes]]])
      for (const x of list ?? []) if (!u[k].includes(x)) u[k].push(x);
  }
  for (const [name, u] of out) {
    const seen = new Set(), queue = u.nodes.flatMap(id => S.nodes[id].deps);
    while (queue.length) {
      const d = S.nodes[queue.shift()];
      if (seen.has(d.id) || d.unit === name) continue;
      seen.add(d.id);
      u.upstream.push(d.id);
      if (d.unit !== undefined) { if (!u.deps.includes(d.unit)) u.deps.push(d.unit); }
      else for (const p of [...d.reads, ...d.writes]) if (!u.upstreamPaths.includes(p)) u.upstreamPaths.push(p);
      queue.push(...d.deps);
    }
    u.paths.sort(); u.upstream.sort(); u.upstreamPaths.sort();
  }
  const order = [], placed = new Set();
  while (order.length < out.size) {
    for (const [name, u] of out) if (!placed.has(name) && u.deps.every(d => placed.has(d))) { placed.add(name); order.push(name); }
  }
  return dict(order.map(name => [name, out.get(name)]));
}

/** What the evidence of unit `u` would be bound to now. `cache` holds the resolved base commit for one command. */
function binding(S, root, u, U, cache) {
  if (!('base' in cache)) cache.base = io.resolveCommit(root, S.config.base ?? 'HEAD');
  return { fps: io.fingerprints(root, U.paths), base_commit: cache.base,
    attempts: Object.fromEntries(U.nodes.map(id => [id, S.nodes[id].attempts ?? 0])),
    deps: Object.fromEntries(U.deps.map(d => [d, S.unit_checks[d]?.evidence?.id ?? null])),
    upstream: Object.fromEntries(U.upstream.map(id => [id, S.nodes[id].attempts ?? 0])),
    upstream_fps: io.fingerprints(root, U.upstreamPaths) };
}

const SETTLED = ['done', 'cancelled'];
/** Member or upstream nodes not settled now (a member failed only by its unit's check keeps failed evidence bound). */
const unsettled = (S, ids, members) => ids.filter(id => !SETTLED.includes(S.nodes[id].state) && !(members && S.nodes[id].unit_check_failed));

/** Why bound evidence `ev` no longer holds against `now` (null when it holds): changed paths, base, node re-runs, dependencies. */
function causeOf(S, ev, now, depsVerified) {
  const diff = (a = {}, b = {}) => Object.keys({ ...a, ...b }).filter(p => a[p] !== b[p]);
  const changed = [...diff(ev.binding.fps, now.fps), ...diff(ev.binding.upstream_fps, now.upstream_fps)];
  const rerun = [...diff(ev.binding.attempts, now.attempts), ...unsettled(S, Object.keys(now.attempts), true)];
  const upstream = [...new Set([...diff(ev.binding.upstream, now.upstream), ...unsettled(S, Object.keys(now.upstream), false)])].sort();
  const deps = Object.keys(now.deps).filter(d => ev.binding.deps[d] !== now.deps[d] || !depsVerified(d));
  const moved = ev.binding.base_commit !== now.base_commit;
  if (!changed.length && !rerun.length && !upstream.length && !deps.length && !moved) return null;
  return { ...(changed.length ? { changed } : {}), ...(moved ? { base_moved: true } : {}), ...(rerun.length ? { rerun: [...new Set(rerun)] } : {}),
    ...(upstream.length ? { upstream } : {}), ...(deps.length ? { dependencies: deps } : {}) };
}

/**
 * Current state of every unit: verified | failed (evidence still bound) | stale (bound no more) |
 * pending (never checked), with the cause of staleness. Computed from the work tree, never stored.
 */
export function unitStates(S, root, cache = {}) {
  const all = units(S), out = dict();
  for (const [u, U] of Object.entries(all)) {
    const ev = S.unit_checks[u]?.evidence;
    if (!ev) { out[u] = { state: 'pending', cause: null, now: null }; continue; }
    const now = binding(S, root, u, U, cache);
    const cause = causeOf(S, ev, now, (d) => out[d].state === 'verified');
    out[u] = { state: cause ? 'stale' : ev.state, cause, now };
  }
  return out;
}

/** Whether node `n` may count dependency `d` as done: done, and (another unit's) unit verified. */
export function depDone(E, n, d, states) {
  const dep = E.S.nodes[d];
  if (dep.state !== 'done') return false;
  if (dep.unit === undefined || dep.unit === n.unit || !hasUnits(E.S)) return true;
  return states().get(dep.unit) === 'verified';
}

/** Unit states computed at most once per call of the returned function's owner (one dispatch-loop pass). */
export const stateMemo = (E) => {
  let m = null;
  return () => (m ??= new Map(Object.entries(unitStates(E.S, E.ctx.repoRoot, E.unitCache ??= {})).map(([u, s]) => [u, s.state])));
};

const pushJudgment = (S, code, node, reason) => { if (!S.judgments.some(j => j.code === code && j.node === node)) S.judgments.push(judgment(code, node, reason)); };

/**
 * Record the invalidation of every unit whose evidence no longer binds (drive and resume), in
 * dependency order, with its cause; the units of its dependent closure (engine-dag closure()) are
 * invalidated with it. A verified unit invalidated more than MAX_UNIT_INVALIDATIONS times raises a
 * durable `unit_invalidation_storm` instead of re-running its checks.
 */
export function unitDrift(E) {
  const { S } = E;
  if (!hasUnits(S)) return;
  const states = unitStates(S, E.ctx.repoRoot, E.unitCache ??= {}), all = units(S);
  const invalidate = (u, cause) => {
    const rec = S.unit_checks[u];
    if (!rec.evidence || rec.stale) return;
    rec.stale = true;
    if (rec.evidence.state === 'verified') rec.invalidations = (rec.invalidations ?? 0) + 1;
    note(S, 'UNIT_INVALIDATED', { unit: u, evidence: rec.evidence.id, cause, invalidations: rec.invalidations ?? 0 });
    rec.causes = [...(rec.causes ?? []), { seq: S.seq, evidence: rec.evidence.id, cause }].slice(-20);
    if ((rec.invalidations ?? 0) > MAX_UNIT_INVALIDATIONS) pushJudgment(S, 'unit_invalidation_storm', u, `unit ${u} check evidence was invalidated `
      + `${rec.invalidations} times in this run (last: ${J(cause)}); its checks are not re-run again: the owner decides (decomposition or contract churn)`);
    const touched = new Set(closure(S, all[u].nodes).map(id => S.nodes[id].unit).filter(x => x !== undefined && x !== u));
    for (const v of Object.keys(all)) if (touched.has(v)) invalidate(v, { dependency: u });
  };
  // Restored bytes re-bind the evidence, so a later change counts as a new invalidation.
  for (const [u, s] of Object.entries(states)) if (s.state !== 'stale' && S.unit_checks[u].stale) S.unit_checks[u].stale = false;
  for (const [u, s] of Object.entries(states)) if (s.state === 'stale') invalidate(u, s.cause);
}

/** Units whose nodes are all done, whose checks have not passed on the current binding, and whose dependencies are verified. */
function checkReady(S, states) {
  const all = units(S);
  return Object.keys(all).filter(u => all[u].nodes.every(id => SETTLED.includes(S.nodes[id].state)) && !unsettled(S, all[u].upstream, false).length
    && ['pending', 'stale'].includes(states[u].state) && all[u].deps.every(d => states[d].state === 'verified'));
}

/** Units whose checks the engine would run now (an invalidation storm runs none). */
const readyUnits = (E, states) => checkReady(E.S, states).filter(u => (E.S.unit_checks[u].invalidations ?? 0) <= MAX_UNIT_INVALIDATIONS
  && !E.unitChecked?.has(u));

/** Whether a drive has unit checks to run (dispatch then holds new nodes until they ran). */
export const unitWork = (E) => hasUnits(E.S) && readyUnits(E, unitStates(E.S, E.ctx.repoRoot, E.unitCache ??= {})).length > 0;

/** The launcher's truncation flag (B12) carried onto an attempt envelope; empty when output fit. */
export const truncation = (r) => (r?.truncated === true ? { truncated: true, stdout_bytes: r.stdout_bytes } : {});

/**
 * Held slots of the parent-wide ceiling (Wave 2b-ii): an open unit repair holds its re-check and
 * its confirmation, so no other unit's re-check or review cycle can consume them. Present only
 * while a hold exists.
 */
const holdsOf = (S) => S.unit_ceiling?.holds ?? [];
const heldOf = (S) => holdsOf(S).reduce((t, h) => t + h.slots.length, 0);

/** The parent-wide re-check ceiling of this run: { limit, used } (+ `reserved` while an open unit repair holds slots). */
export const ceiling = (S) => {
  const reserved = heldOf(S);
  return { limit: S.config.unitRecheckCeiling ?? DEFAULT_UNIT_RECHECK_CEILING, used: S.unit_ceiling?.used ?? 0, ...(reserved ? { reserved } : {}) };
};

/** Spend one slot of the ceiling (record `entry`), keeping the holds; with `slot`, it comes out of unit `entry.unit`'s hold. */
function spendOne(S, entry, slot) {
  const used = (S.unit_ceiling?.used ?? 0) + 1;
  let holds = holdsOf(S);
  if (slot) holds = holds.map(h => (h.unit === entry.unit && h.slots.includes(slot) ? { ...h, slots: h.slots.filter(x => x !== slot) } : h)).filter(h => h.slots.length);
  S.unit_ceiling = { used, rechecks: [...(S.unit_ceiling?.rechecks ?? []), entry].slice(-50), ...(holds.length ? { holds } : {}) };
  return used;
}

/** Whether unit `u` holds `slot` (an open unit repair's re-check or confirmation). */
const holds = (S, u, slot) => holdsOf(S).some(h => h.unit === u && h.slots.includes(slot));

/**
 * Before unit `u`'s checks run: a first check is free; a re-check (the unit already completed a
 * check round in this run, whatever later reset its evidence) spends one of the run's re-checks,
 * recorded with its kind (out of the unit's own repair hold when it has one). Once the unheld
 * allowance is spent, a durable `parent_ceiling` judgment is raised instead (no automatic retry;
 * nothing clears it in this run). Returns whether it was raised.
 */
function ceilingReached(E, u) {
  const { S } = E, rec = S.unit_checks[u];
  if (!(rec.rounds > 0)) return false;
  const { limit, used } = ceiling(S), held = holds(S, u, 'recheck');
  if (!held && used + heldOf(S) >= limit) {
    pushJudgment(S, 'parent_ceiling', u, `unit ${u} needs a re-check, but this run already spent its ${limit} unit re-check(s) `
      + `(config.unitRecheckCeiling, across all units): the owner decides (decomposition, contract churn or a flaky check)`);
    return true;
  }
  const kind = rec.cleared ? 'cleared' : rec.evidence?.state === 'failed' ? 'rerun' : 'invalidation';
  const n = spendOne(S, { unit: u, kind, seq: S.seq, ...(held ? { reserved: true } : {}) }, held ? 'recheck' : null);
  delete rec.cleared;
  note(S, 'UNIT_RECHECK', { unit: u, kind, used: n, limit, ...(held ? { reserved: true } : {}) });
  return false;
}

/**
 * A unit review cycle (Wave 2b-ii: a re-review, a unit repair, a targeted confirmation) spends one
 * of the SAME run-wide allowance the re-checks spend, recorded with its kind and trigger. With
 * `slot` it comes out of the unit's hold; otherwise it needs `reserve` (>= 1) unheld slots, and
 * `hold` slots are then held for the unit (an opened repair holds its re-check and confirmation).
 * Never raises a judgment: the gate decides. Returns whether it was spent.
 */
export function spendCeiling(S, u, kind, trigger, { reserve = 1, slot = null, hold = null } = {}) {
  const { limit, used } = ceiling(S), held = slot && holds(S, u, slot);
  if (!held && used + heldOf(S) + reserve > limit) return false;
  const n = spendOne(S, { unit: u, kind, seq: S.seq, trigger, ...(held ? { reserved: true } : {}) }, held ? slot : null);
  if (hold) S.unit_ceiling.holds = [...holdsOf(S), { unit: u, review_execution: hold.review_execution, slots: [...hold.slots] }];
  note(S, 'UNIT_REVIEW_CYCLE', { unit: u, kind, trigger, used: n, limit, ...(held ? { reserved: true } : {}) });
  return true;
}

/** Release the unused slots held for unit review execution `rx` (its cycle ended or was cancelled). */
export function releaseHold(S, rx, why) {
  const h = holdsOf(S).find(x => x.review_execution === rx);
  if (!h) return;
  const rest = holdsOf(S).filter(x => x !== h);
  if (rest.length) S.unit_ceiling.holds = rest; else delete S.unit_ceiling.holds;
  note(S, 'UNIT_CEILING_RELEASED', { unit: h.unit, review_execution: rx, slots: h.slots, why });
}

/** Release one held slot of `rx` (a repair that needed no re-check). */
export function releaseSlot(S, rx, slot) {
  const h = holdsOf(S).find(x => x.review_execution === rx && x.slots.includes(slot));
  if (!h) return;
  h.slots = h.slots.filter(x => x !== slot);
  if (!h.slots.length) return releaseHold(S, rx, 'spent');
  note(S, 'UNIT_CEILING_RELEASED', { unit: h.unit, review_execution: rx, slots: [slot], why: 'not needed' });
}

/** The holds of the run (engine-unit-review.mjs reconciles them). */
export const ceilingHolds = (S) => holdsOf(S);

/** One check through the runner protocol; `{ refusal }` when its group's quiescence is not proven (nothing recorded). */
async function runCheck(E, u, name, resources) {
  const c = E.S.config.testCommands[name];
  const a = { attempt_id: 'att-' + randomUUID(), kind: 'unit-check', node: u, check: name, status: 'intent', resources: [...resources] };
  E.S.attempts.push(a);
  for (const r of resources) E.S.locks[r] = a.attempt_id;
  await E.commit();
  let result;
  try {
    const launch = await runnerDeps(E).spawnRunner({ attempt_id: a.attempt_id, command: { cmd: c.cmd, args: c.args ?? [] }, timeoutMs: clampTimeout(E.S.config.timeoutMs) });
    Object.assign(a, { pid: launch.pid, pgid: launch.pgid, leader_start: leaderStart(launch.pgid), status: 'running' });
    await E.commit();
    await io.boundary(E.ctx.hooks, 'unit-check-running', { attempt_id: a.attempt_id, unit: u, check: name });
    launch.release();
    result = await launch.done;
  } catch (e) { result = { exitCode: null, timedOut: false, error: e.message, quiescent: true }; } // retire() decides
  if (result.quiescent !== true || !(await retire(E.S, a, E.alive, 'exited'))) {
    a.status = 'unknown';
    pushJudgment(E.S, 'quiescence_unknown', u, `cannot prove unit-check runner group ${a.pgid ?? a.pid} (${u}/${name}) has exited; no check evidence recorded`);
    await E.commit();
    return { refusal: true };
  }
  a.envelope = { exitCode: result.exitCode, timedOut: result.timedOut, ...truncation(result) };
  return { name, exit_code: result.exitCode, result: result.exitCode === 0 && !result.timedOut ? 'pass' : 'fail', ...(result.error ? { error: result.error } : {}) };
}

/**
 * Run the checks of every ready unit (nothing live, no durable judgment), in dependency order,
 * each unit at most once per engine command. Before each pick, stale evidence is recorded as an
 * invalidation (unitDrift), so a re-check inside one drive counts toward the storm guard, and every
 * re-check spends the run's parent-wide ceiling (ceilingReached). A check whose runner failed to
 * start is retried once (UNIT_CHECK_RETRY, an infra retry: it spends no re-check); a failing exit
 * is never retried. Checks that change the declared paths of ANY node (unit-less upstream
 * generators included) or move the config.base commit fail with that cause. Evidence is bound to
 * the binding taken after the checks, so a failure stays bound (never re-run by itself). A failure
 * before the freeze marks the unit's nodes failed. Checks ran repository code: when they drifted the
 * approval binding (plan narrative, DAG bytes) nothing is recorded (UNIT_CHECK_DROPPED, the drift
 * judgments go to `transient`), so no dependent dispatches on that evidence. Returns whether a
 * unit became verified.
 */
export async function runUnitChecks(E, transient = []) {
  if (!hasUnits(E.S)) return false;
  let progressed = false;
  E.unitChecked ??= new Set();
  for (;;) {
    const S = E.S;
    if (S.judgments.length || E.live.size || S.attempts.some(a => LIVE.includes(a.status))) return progressed;
    E.unitCache = {};
    unitDrift(E);
    if (S.judgments.length) { await E.commit(); return progressed; }
    const states = unitStates(S, E.ctx.repoRoot, E.unitCache);
    const u = readyUnits(E, states)[0];
    if (!u) return progressed;
    const all = units(S), U = all[u];
    if (ceilingReached(E, u)) { await E.commit(); return progressed; }
    E.unitChecked.add(u);
    // Every node's declared paths (unit-less upstream generators included) and the base commit.
    const watched = [...new Set(Object.values(S.nodes).flatMap(n => [...n.reads, ...n.writes]))].sort();
    const preBase = io.resolveCommit(E.ctx.repoRoot, S.config.base ?? 'HEAD');
    const pre = io.fingerprints(E.ctx.repoRoot, watched), results = [];
    for (const name of U.checks) {
      let r = await runCheck(E, u, name, U.resources);
      if (!r.refusal && r.error) { note(E.S, 'UNIT_CHECK_RETRY', { unit: u, check: name, cause: r.error }); r = await runCheck(E, u, name, U.resources); }
      if (r.refusal) return progressed;
      results.push(r);
    }
    const unbound = E.verifyBinding();
    if (unbound.length) {
      note(E.S, 'UNIT_CHECK_DROPPED', { unit: u, binding: unbound.map(j => j.code) });
      for (const j of unbound) if (!transient.some(x => x.code === j.code)) transient.push(j);
      await E.commit();
      return progressed;
    }
    const post = io.fingerprints(E.ctx.repoRoot, watched);
    const touched = watched.filter(p => post[p] !== pre[p]);
    const moved = io.resolveCommit(E.ctx.repoRoot, E.S.config.base ?? 'HEAD') !== preBase;
    const passed = !touched.length && !moved && results.every(r => r.result === 'pass');
    const c = io.candidateId(E.ctx.repoRoot, E.S.config.base ?? 'HEAD', E.S.pinned_exclusions);
    note(E.S, 'UNIT_CHECKED', { unit: u, state: passed ? 'verified' : 'failed', checks: results.map(r => ({ name: r.name, result: r.result })) });
    const reason = passed ? null : touched.length ? `checks changed declared files: ${touched.join(', ')}`
      : moved ? 'checks moved the config.base commit'
      : `check(s) failed: ${results.filter(r => r.result !== 'pass').map(r => `${r.name} (exit ${r.exit_code}${r.error ? `, ${r.error}` : ''})`).join(', ')}`;
    const rec = E.S.unit_checks[u];
    rec.rounds = (rec.rounds ?? 0) + 1;
    E.unitCache = {};
    rec.evidence = { id: `${u}@${E.S.seq}`, state: passed ? 'verified' : 'failed', results, binding: binding(E.S, E.ctx.repoRoot, u, U, E.unitCache), candidate_id: c.candidate_id ?? null,
      seq: E.S.seq, ...(reason ? { reason } : {}) };
    rec.stale = false;
    if (!passed && !E.S.freeze) for (const id of U.nodes) Object.assign(E.S.nodes[id], { state: 'failed', reason: `unit ${u} ${reason}`, unit_check_failed: true });
    await E.commit();
    await io.boundary(E.ctx.hooks, 'unit-checked', { unit: u, evidence: rec.evidence.id }); // evidence durable, nothing derived from it yet
    if (passed) progressed = true;
  }
}

/** Computed `unit_check_failed` judgments: units whose latest check failed (until a re-check replaces it). */
export const unitJudgments = (S, states) => Object.keys(states).filter(u => S.unit_checks[u].evidence?.state === 'failed')
  .map((u) => judgment('unit_check_failed', u, `unit ${u} ${S.unit_checks[u].evidence.reason}`));

/** Units not verified now (gate review and ship-ready refuse while any exist). */
export function unverified(E) {
  if (!hasUnits(E.S)) return [];
  return Object.entries(unitStates(E.S, E.ctx.repoRoot, {})).filter(([, s]) => s.state !== 'verified').map(([u, s]) => `${u}: ${s.state}`);
}

/**
 * The owner clearing path for a unit's two dead ends: a post-freeze `unit_check_failed` and a
 * `unit_invalidation_storm`. It requires a trusted RUN-STATE `UNIT_CLEAR` (engine-authority.mjs,
 * the RETRY model: observed while nothing dispatched could run) of this run naming the unit, the
 * unit's current evidence id as `predecessor`, `authorized_by` and `reason`; an untrusted match is
 * `unit_clear_unauthorized`, none is `unit_clear_refused`. It removes that unit's storm judgment and
 * resets only that unit's evidence and invalidation counter, so the next drive re-checks it. That
 * re-check still spends the run's parent-wide ceiling: the ceiling, its counter, a `parent_ceiling`
 * judgment and the unit's completed rounds are never reset. Returns the UNIT_CLEARED record.
 */
export function clearUnit(E, u) {
  const { S } = E;
  if (!hasUnits(S) || !Object.hasOwn(S.unit_checks, u)) throw coded('unit_clear_refused', `no unit ${u} in the bound DAG`);
  const rec = S.unit_checks[u];
  const storm = S.judgments.some(j => j.code === 'unit_invalidation_storm' && j.node === u);
  const failed = rec.evidence?.state === 'failed';
  if (!storm && !(failed && S.freeze)) throw coded('unit_clear_refused', `unit ${u} is not at a dead end (a post-freeze unit_check_failed or a `
    + `unit_invalidation_storm)${failed ? '; before the freeze, mark failed->pending one of its nodes' : ''}`);
  const predecessor = rec.evidence.id;
  const match = (e) => e.run_id === S.run_id && e.unit === u && e.predecessor === predecessor
    && typeof e.authorized_by === 'string' && e.authorized_by.trim() && typeof e.reason === 'string' && e.reason.trim();
  const clear = trustedEvents(S, 'UNIT_CLEAR').find(match);
  if (!clear && untrustedEvents(S, 'UNIT_CLEAR').some(match)) throw coded('unit_clear_unauthorized', `a UNIT_CLEAR for ${u} appeared while `
    + 'dispatched work could run, so it is not owner authority; once status shows nothing live, the owner re-appends a distinct UNIT_CLEAR (e.g. with a timestamp)');
  if (!clear) throw coded('unit_clear_unauthorized', `clearing unit ${u} needs a RUN-STATE UNIT_CLEAR { run_id: ${S.run_id}, unit: ${u}, `
    + `predecessor: ${predecessor}, authorized_by, reason } appended by the owner while nothing is live`);
  const cleared = storm ? ['unit_invalidation_storm'] : ['unit_check_failed'];
  S.judgments = S.judgments.filter(j => !(j.code === 'unit_invalidation_storm' && j.node === u));
  const entry = { seq: S.seq, predecessor, cleared, authorized_by: clear.authorized_by, reason: clear.reason };
  Object.assign(rec, { evidence: null, stale: false, invalidations: 0, cleared: true, clears: [...(rec.clears ?? []), entry] });
  note(S, 'UNIT_CLEARED', { unit: u, predecessor, cleared, authorized_by: clear.authorized_by });
  return entry;
}

/**
 * `mark failed->pending` of node `id`: the other nodes of its unit that failed only because the
 * unit's checks failed return to done (they are not re-run; only `id` spends its retry).
 */
export function restoreCheckFailed(S, id) {
  const n = S.nodes[id];
  if (!n.unit_check_failed) return;
  delete n.unit_check_failed;
  for (const m of Object.values(S.nodes)) if (m.unit === n.unit && m.id !== id && m.unit_check_failed && m.state === 'failed') {
    m.state = 'done'; m.reason = null; delete m.unit_check_failed;
  }
}

/**
 * The per-unit projection for `status` and `eval` (computed; `root` null reads the last stored
 * state instead of the work tree): nodes, dependencies, acceptance ids, checks, fingerprints,
 * evidence state, candidate id, invalidations and their causes.
 */
export function unitProjection(S, root, cache = {}) {
  const all = units(S), states = root ? unitStates(S, root, cache) : null;
  return dict(Object.entries(all).map(([u, U]) => {
    const rec = S.unit_checks[u] ?? {}, ev = rec.evidence;
    const state = states ? states[u].state : !ev ? 'pending' : rec.stale ? 'stale' : ev.state;
    return [u, { state, nodes: U.nodes, deps: U.deps, acceptance: U.acceptance, checks: U.checks,
      fingerprints: states?.[u].now?.fps ?? (root ? io.fingerprints(root, U.paths) : ev?.binding.fps ?? null),
      evidence: ev ? { id: ev.id, state: ev.state, candidate_id: ev.candidate_id, base_commit: ev.binding.base_commit,
        results: ev.results.map(r => ({ name: r.name, result: r.result, exit_code: r.exit_code })), ...(ev.reason ? { reason: ev.reason } : {}) } : null,
      ...(states?.[u].cause ? { stale_cause: states[u].cause } : {}),
      invalidations: rec.invalidations ?? 0, causes: rec.causes ?? [], ...(rec.clears ? { clears: rec.clears } : {}) }];
  }));
}

