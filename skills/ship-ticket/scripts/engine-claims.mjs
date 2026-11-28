/**
 * S2 (P2): the run engine's glue to the host claim store (host-claims.mjs). Only with `config.hostClaims`; without it every
 * function is a no-op (null), so a legacy run's dispatch is unchanged. It is glue, not a scheduler.
 *
 * ONE claim lifecycle (S2 round 2, RCA-S2-ROUND2), used by every call site (workers, repairs, gate RED, the ship-ready
 * proof batch, unit-check batches, evidence):
 *   const cx = await admitOp(E, key, spec)       // BEFORE anything is spent, recorded or launched
 *   if (cx?.held) -> pending work (waiting diagnostic); if (cx?.refused) -> a refusal (a permanent condition)
 *   await runClaimed(E, cx, async () => { ... })  // release in `finally` over the WHOLE post-admission interval
 *     - every attempt created inside carries `host_claim: hostRecord(cx)` from its first commit (before launch), so
 *       reconcile (releaseSettledClaims) can always recover a claim whose release was refused or never ran;
 *     - the launcher's group is bound (bindOp, lock-free) before its release byte; a batch rebinds per command.
 * A hold never spends a budget, a re-run slot or a ceiling, and is never a judgment. The one escalation is a host-scoped
 * Blocked (an unknown holder): `E.hostBlocked`, refreshed (also to null) by every admission.
 */
import { randomUUID } from 'node:crypto';
import { claim as hostClaim, bindClaim, releaseClaim, storeDir, peakSampler } from './host-claims.mjs';
import { leaderStart } from './engine-quiesce.mjs';
import { note } from './engine-dag.mjs';

export const claimsOn = (S) => Boolean(S?.config?.hostClaims);
const waits = (E) => (E.hostWaiting ??= new Map());
/** The waiting diagnostics of this engine command ({ code: 'host_held', node, reasons, reason }). */
export const waitingOf = (E) => [...waits(E).values()];

/** The per-operation spec of a set of runners (testCommands entries): heavy if any is (runners default heavy). */
export function runnerSpec(S, names) {
  const entries = names.map(n => S.config.testCommands?.[n] ?? {});
  const labels = [...new Map(entries.filter(e => e.hostContainerLabel).map(e => [JSON.stringify(e.hostContainerLabel), e.hostContainerLabel])).values()];
  return { cls: entries.some(e => (e.hostClass ?? 'heavy') === 'heavy') ? 'heavy' : 'light', resources: entries.flatMap(e => e.hostResources ?? []), labels };
}

/**
 * Admission of operation `key` with { cls, resources, labels } BEFORE its spawn (and before anything is spent):
 * null (no hostClaims, or a light operation with no shared resource), { claim } when admitted, { held, reason } on a
 * capacity hold, { refused, code, reason } on a permanent condition (operations carrying different container labels:
 * one claim carries one label pair).
 */
export async function admitOp(E, key, { cls, resources = [], labels = [] }) {
  const { S, ctx } = E;
  if (!claimsOn(S)) return null;
  if (labels.length > 1) return { refused: true, code: 'host_labels_conflict', reason: `${key} spans operations with different container labels; one claim carries one label pair (fix the DAG)` };
  if (cls !== 'heavy' && !resources.length) return null;
  const platform = ctx.platform ?? process.platform;
  const hold = (reasons, reason) => {
    if (!waits(E).has(key)) note(S, 'HOST_HELD', { node: key, reasons });
    waits(E).set(key, { code: 'host_held', node: key, reasons, reason });
    return { held: true, reason };
  };
  if (platform === 'win32') return hold(['platform_unsupported'], 'host claims need POSIX process groups (Windows: unsupported, known limit D4)');
  const hc = ctx.hostClaims ?? {};
  const dir = hc.dir ?? storeDir(ctx.env ?? process.env);
  const safe = (x) => String(x).replace(/[^A-Za-z0-9._-]/g, '_');
  const opId = `${safe(S.ticket)}.${safe(S.run_id)}.${safe(key)}.${randomUUID().slice(0, 8)}`;
  let r;
  try {
    r = await hostClaim({ dir, opId, cls, resources, containerLabel: labels[0] ?? null, cwd: ctx.repoRoot, ...(hc.snapshot ? { snapshot: hc.snapshot } : {}),
      ...(hc.now ? { now: hc.now } : {}), ...(hc.docker ? { docker: hc.docker } : {}), ...(hc.waitMs !== undefined ? { waitMs: hc.waitMs } : {}) });
  } catch (e) {
    // F5: a busy store is a hold (retried on the next command), never a thrown drive.
    if (e.code === 'lock_timeout' || e.code === 'lock_held') return hold(['host_store_busy'], `the host claim store is busy (${e.code}); retried on the next command`);
    throw e;
  }
  E.hostBlocked = r.blocked ?? null; // N3: refreshed by every reconciliation, so a holder resolved in this command is not reported
  if (r.admit) { waits(E).delete(key); return { claim: { dir, op_id: opId } }; }
  // F10: host sampling is macOS only; elsewhere a heavy operation holds (snapshot_unavailable).
  const where = platform !== 'darwin' && r.reasons.includes('snapshot_unavailable') ? `; host sampling is macOS only, so on ${platform} a heavy operation stays held` : '';
  return hold(r.reasons, `host admission held (${r.reasons.join(', ')}); queued until capacity returns${where}`);
}

/** The claim identity an attempt carries from its first commit (undefined without a claim). */
export const hostRecord = (cx) => (cx?.claim ? { op_id: cx.claim.op_id, dir: cx.claim.dir, released: false } : undefined);

/** Bind the claim of `cx` to a launched group (lock-free, see host-claims.mjs bindClaim) and start its peak sampler. */
export async function bindOp(E, cx, pgid) {
  if (!cx?.claim) return;
  await bindClaim({ dir: cx.claim.dir, opId: cx.claim.op_id, pgid, leaderStart: leaderStart(pgid) });
  cx.peak ??= peakSampler(E.ctx.hostClaims?.loadavg ? { loadavg: E.ctx.hostClaims.loadavg } : {});
}

/** Run `body` with the claim of `cx`, releasing it in `finally` over the whole post-admission interval. */
export async function runClaimed(E, cx, body) {
  if (!cx?.claim) return body(cx);
  try { return await body(cx); } finally { await releaseOp(E, cx); }
}

/** The final release of `cx` (once): every attempt record carrying it is updated; a refused release is kept for reconcile. */
export async function releaseOp(E, cx) {
  if (cx.finished) return;
  cx.finished = true;
  const recs = (E.S?.attempts ?? []).filter(a => a.host_claim?.op_id === cx.claim.op_id);
  await releaseHostClaim(E, recs, cx.claim, cx.peak?.stop() ?? null);
}

/**
 * Release claim `c` (records `recs`: the attempts carrying it). The store refuses while the group lives or a labelled
 * container remains: the claim then stays charged and `released: false` for reconcile. F2: `absent` (already reclaimed,
 * its peak persisted) counts as released. F5: a store failure is retained, never thrown.
 */
export async function releaseHostClaim(E, recs, c, peak = null) {
  if (!c) return;
  const list = Array.isArray(recs) ? recs : recs ? [recs] : [];
  const env = list.map(a => a.envelope).filter(Boolean).at(-1) ?? null;
  let r;
  try {
    r = await releaseClaim({ dir: c.dir, opId: c.op_id, peak: { ...(peak ?? {}), ...(env ? { peak_rss_mb: env.peak_rss_mb, peak_cpu_pct: env.peak_cpu_pct, resource_samples: env.resource_samples } : {}) },
      ...(E.ctx.hostClaims?.docker ? { docker: E.ctx.hostClaims.docker } : {}), ...(E.ctx.hostClaims?.waitMs !== undefined ? { waitMs: E.ctx.hostClaims.waitMs } : {}) });
  } catch (e) { r = { released: false, reason: `store_error:${e.code ?? e.message}` }; }
  const released = r.released || r.reason === 'absent';
  for (const a of list) { a.host_claim.released = released; a.host_claim.release_reason = r.reason; }
  if (!released) note(E.S, 'HOST_CLAIM_KEPT', { node: list[0]?.node ?? null, op_id: c.op_id, reason: r.reason });
}

/** Release the claims of settled attempts an earlier command left unreleased (crash recovery; the store decides). */
export async function releaseSettledClaims(E, live) {
  const byOp = new Map();
  for (const a of E.S.attempts ?? []) {
    if (!a.host_claim || a.host_claim.released !== false) continue;
    if (!byOp.has(a.host_claim.op_id)) byOp.set(a.host_claim.op_id, []);
    byOp.get(a.host_claim.op_id).push(a);
  }
  for (const [op, recs] of byOp) {
    if (recs.some(a => live.includes(a.status))) continue;
    await releaseHostClaim(E, recs, { op_id: op, dir: recs[0].host_claim.dir });
  }
}

/**
 * Wrap a runner launcher (engine-io.mjs gateRunner) for the claim of `cx`: each launch binds the claim to the runner's
 * group before the caller writes the release byte (a batch rebinds per command). The release is NOT here: it is the
 * runClaimed `finally` of the call site. A bind failure (an I/O error: the bind takes no lock) writes no byte (the
 * launcher exits 125, nothing runs) and is rethrown.
 */
export function claimedRunner(E, cx, spawnRunner) {
  return async (args) => {
    const launch = await spawnRunner(args);
    if (!cx?.claim) return launch;
    try { await bindOp(E, cx, launch.pgid); } catch (e) {
      launch.cancel?.();
      await launch.done.catch(() => {});
      throw e;
    }
    return launch;
  };
}
