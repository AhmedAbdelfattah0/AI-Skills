/**
 * S2 (P2): the run engine's glue to the host claim store (host-claims.mjs), shared by worker and repair dispatch
 * (engine-attempts.mjs) and by every runner of the engine (gate RED, ship-ready proof, unit checks, evidence) through
 * engine-units.mjs runnerDeps. Only with `config.hostClaims`; every function is a no-op (null) without it, so a legacy run's
 * dispatch is unchanged. It is glue, not a scheduler: it claims before a spawn, binds before the release byte, releases
 * after the group is gone and records a hold as a WAITING diagnostic (never a judgment, never failed evidence).
 *
 * Waiting diagnostics (`E.hostWaiting`, surfaced by run-engine.mjs view() as `waiting`) are per engine command: a key
 * admitted later in the same command is cleared, and the next command starts empty. A host-scoped Blocked (an unknown
 * holder) is the one escalation: drive reports it as the transient judgment `host_blocked`.
 */
import { randomUUID } from 'node:crypto';
import { claim as hostClaim, bindClaim, releaseClaim, storeDir, peakSampler } from './host-claims.mjs';
import { leaderStart } from './engine-quiesce.mjs';
import { note } from './engine-dag.mjs';

export const claimsOn = (S) => Boolean(S?.config?.hostClaims);
const waits = (E) => (E.hostWaiting ??= new Map());
/** The waiting diagnostics of this engine command ({ code: 'host_held', node, reasons, reason }). */
export const waitingOf = (E) => [...waits(E).values()];

/**
 * Take the host claim of operation `key` (a node, repair or runner) BEFORE its spawn: null when none is needed (no
 * hostClaims, or a light operation with no shared resource), { dir, op_id } when admitted, false when held.
 */
export async function takeClaim(E, key, { cls, resources = [], containerLabel = null }) {
  const { S, ctx } = E;
  if (!claimsOn(S) || (cls !== 'heavy' && !resources.length)) return null;
  const platform = ctx.platform ?? process.platform;
  const hold = (reasons, reason) => {
    if (!waits(E).has(key)) note(S, 'HOST_HELD', { node: key, reasons });
    waits(E).set(key, { code: 'host_held', node: key, reasons, reason });
    return false;
  };
  if (platform === 'win32') return hold(['platform_unsupported'], 'host claims need POSIX process groups (Windows: unsupported, known limit D4)');
  const hc = ctx.hostClaims ?? {};
  const dir = hc.dir ?? storeDir(ctx.env ?? process.env);
  const safe = (x) => String(x).replace(/[^A-Za-z0-9._-]/g, '_');
  const opId = `${safe(S.ticket)}.${safe(S.run_id)}.${safe(key)}.${randomUUID().slice(0, 8)}`;
  let r;
  try {
    r = await hostClaim({ dir, opId, cls, resources, containerLabel, cwd: ctx.repoRoot, ...(hc.snapshot ? { snapshot: hc.snapshot } : {}),
      ...(hc.now ? { now: hc.now } : {}), ...(hc.docker ? { docker: hc.docker } : {}), ...(hc.waitMs !== undefined ? { waitMs: hc.waitMs } : {}) });
  } catch (e) {
    // F5: a busy store is a hold (retried on the next command), never a thrown drive.
    if (e.code === 'lock_timeout' || e.code === 'lock_held') return hold(['host_store_busy'], `the host claim store is busy (${e.code}); retried on the next command`);
    throw e;
  }
  if (r.blocked) E.hostBlocked = r.blocked; // N5: also when this request is admitted beside the unknown holder
  if (r.admit) { waits(E).delete(key); return { dir, op_id: opId }; }
  // F10: host sampling is macOS only; elsewhere a heavy operation holds (snapshot_unavailable) until run where it can be sampled.
  const where = platform !== 'darwin' && r.reasons.includes('snapshot_unavailable') ? `; host sampling is macOS only, so on ${platform} a heavy operation stays held` : '';
  return hold(r.reasons, `host admission held (${r.reasons.join(', ')}); queued until capacity returns${where}`);
}

/**
 * Release claim `c` once its attempt is over; the store refuses while the group lives (it then stays charged and a later
 * reconcile retries). F2: `absent` (already reclaimed by another claimer, its peak persisted) counts as released.
 * F5: a store failure leaves `released: false` for reconcile instead of throwing.
 */
export async function releaseHostClaim(E, a, c, peak = null) {
  if (!c) return;
  const env = a?.envelope ?? null;
  let r;
  try {
    r = await releaseClaim({ dir: c.dir, opId: c.op_id, peak: { ...(peak ?? {}), ...(env ? { peak_rss_mb: env.peak_rss_mb, peak_cpu_pct: env.peak_cpu_pct, resource_samples: env.resource_samples } : {}) },
      ...(E.ctx.hostClaims?.docker ? { docker: E.ctx.hostClaims.docker } : {}), ...(E.ctx.hostClaims?.waitMs !== undefined ? { waitMs: E.ctx.hostClaims.waitMs } : {}) });
  } catch (e) { r = { released: false, reason: `store_error:${e.code ?? e.message}` }; }
  const released = r.released || r.reason === 'absent';
  if (a?.host_claim) { a.host_claim.released = released; a.host_claim.release_reason = r.reason; }
  if (!released) note(E.S, 'HOST_CLAIM_KEPT', { node: a?.node ?? null, op_id: c.op_id, reason: r.reason });
}

/** Release the claims of attempts an earlier engine left settled but unreleased (crash recovery; the store decides). */
export async function releaseSettledClaims(E, live) {
  for (const a of E.S.attempts ?? []) if (a.host_claim && a.host_claim.released === false && !live.includes(a.status)) await releaseHostClaim(E, a, a.host_claim);
}

/** A runner's per-operation class and shared resources: its testCommands entry, heavy by default (a test suite). */
export function runnerClass(S, name) {
  const e = S.config.testCommands?.[name];
  return { cls: e?.hostClass ?? 'heavy', resources: e?.hostResources ?? [], containerLabel: e?.hostContainerLabel ?? null };
}

/** Admission of one runner before its attempt exists: null (no claim needed), { claim } or { held, reason }. */
export async function admitRunner(E, { kind, node, name }) {
  if (!claimsOn(E.S)) return null;
  const key = `${kind}.${node}`;
  const c = await takeClaim(E, key, runnerClass(E.S, name));
  if (c === false) return { held: true, reason: waits(E).get(key).reason };
  return c ? { claim: c } : null;
}

/**
 * Wrap a runner launcher (engine-io.mjs gateRunner) so a call carrying `hostClaim` binds the claim to the runner's group
 * before the caller writes the release byte, and releases it once the group is proven gone (gateRunner's `done` awaits
 * whole-group quiescence). A bind failure writes no byte (the launcher exits 125) and is reported as a runner failure.
 */
export function claimedRunner(E, spawnRunner) {
  return async ({ hostClaim: c, ...args }) => {
    if (!c) return spawnRunner(args);
    let launch;
    try { launch = await spawnRunner(args); } catch (e) { await releaseHostClaim(E, null, c); throw e; }
    try { await bindClaim({ dir: c.dir, opId: c.op_id, pgid: launch.pgid, leaderStart: leaderStart(launch.pgid) }); } catch (e) {
      launch.cancel?.();
      await launch.done.catch(() => {});
      await releaseHostClaim(E, null, c);
      throw e;
    }
    const peak = peakSampler(E.ctx.hostClaims?.loadavg ? { loadavg: E.ctx.hostClaims.loadavg } : {});
    const done = launch.done.finally(async () => { await releaseHostClaim(E, null, c, peak.stop()); });
    done.catch(() => {});
    return { ...launch, done };
  };
}
