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
 * `E` is run-engine.mjs's command context.
 */
import { randomUUID } from 'node:crypto';
import { spawnSpec } from './carrier.mjs';
import * as io from './engine-io.mjs';
import { retire, leaderStart, LIVE } from './engine-quiesce.mjs';
import { note, judgment, closure, clampTimeout } from './engine-dag.mjs';

/** Verified evidence invalidated more often than this in one run is an invalidation storm. */
export const MAX_UNIT_INVALIDATIONS = 2;
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
  a.envelope = { exitCode: result.exitCode, timedOut: result.timedOut };
  return { name, exit_code: result.exitCode, result: result.exitCode === 0 && !result.timedOut ? 'pass' : 'fail', ...(result.error ? { error: result.error } : {}) };
}

/**
 * Run the checks of every ready unit (nothing live, no durable judgment), in dependency order,
 * each unit at most once per engine command. Before each pick, stale evidence is recorded as an
 * invalidation (unitDrift), so a re-check inside one drive counts toward the storm guard. A check
 * whose runner failed to start is retried once (UNIT_CHECK_RETRY); a failing exit is never
 * retried. Checks that change the declared paths of ANY unit fail with those paths as the cause.
 * Evidence is bound to the binding taken after the checks, so a failure stays bound (never re-run
 * by itself). A failure before the freeze marks the unit's nodes failed. Returns whether a unit
 * became verified (dependents may now be ready).
 */
export async function runUnitChecks(E) {
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
    E.unitChecked.add(u);
    const all = units(S), U = all[u], watched = [...new Set(Object.values(all).flatMap(x => x.paths))].sort();
    const pre = io.fingerprints(E.ctx.repoRoot, watched), results = [];
    for (const name of U.checks) {
      let r = await runCheck(E, u, name, U.resources);
      if (!r.refusal && r.error) { note(E.S, 'UNIT_CHECK_RETRY', { unit: u, check: name, cause: r.error }); r = await runCheck(E, u, name, U.resources); }
      if (r.refusal) return progressed;
      results.push(r);
    }
    const post = io.fingerprints(E.ctx.repoRoot, watched);
    const touched = watched.filter(p => post[p] !== pre[p]);
    const passed = !touched.length && results.every(r => r.result === 'pass');
    const c = io.candidateId(E.ctx.repoRoot, E.S.config.base ?? 'HEAD', E.S.pinned_exclusions);
    note(E.S, 'UNIT_CHECKED', { unit: u, state: passed ? 'verified' : 'failed', checks: results.map(r => ({ name: r.name, result: r.result })) });
    const reason = passed ? null : touched.length ? `checks changed declared unit files: ${touched.join(', ')}`
      : `check(s) failed: ${results.filter(r => r.result !== 'pass').map(r => `${r.name} (exit ${r.exit_code}${r.error ? `, ${r.error}` : ''})`).join(', ')}`;
    const rec = E.S.unit_checks[u];
    E.unitCache = {};
    rec.evidence = { id: `${u}@${E.S.seq}`, state: passed ? 'verified' : 'failed', results, binding: binding(E.S, E.ctx.repoRoot, u, U, E.unitCache), candidate_id: c.candidate_id ?? null,
      seq: E.S.seq, ...(reason ? { reason } : {}) };
    rec.stale = false;
    if (!passed && !E.S.freeze) for (const id of U.nodes) Object.assign(E.S.nodes[id], { state: 'failed', reason: `unit ${u} ${reason}`, unit_check_failed: true });
    await E.commit();
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
      invalidations: rec.invalidations ?? 0, causes: rec.causes ?? [] }];
  }));
}

