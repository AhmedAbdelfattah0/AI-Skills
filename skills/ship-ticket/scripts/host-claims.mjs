/**
 * S2 (P2): the host-wide claim store. ONE durable record per running (or about to run) operation that uses host capacity
 * or a shared host resource, so admission reads occupancy from records instead of a caller-supplied count
 * (host-admit.mjs `--running`, removed) and the engine's lone heavy node no longer starts unadmitted
 * (engine-attempts.mjs fits() width-1 early return; still the legacy branch for DAGs without config.hostClaims).
 * It is a store plus the reuse of three merged primitives, not a scheduler: nothing here launches, queues or retries.
 *   - policy and sampling: harness.mjs admitHost/hostSnapshot (FR2b a61794d, 96e43e8, 4c16a02), unchanged;
 *   - the short mutation lock and atomic writes: lib/durable-io.mjs acquireLock/writeStateAtomic (14ca581/a906c67);
 *   - container liveness: docker-lifecycle.mjs ownedContainers (f71b648 + d58b81b/922c397), exact owner/run labels.
 *
 * LOCATION `~/.ai-skills-state/host-resources/` (override: env AI_SKILLS_HOST_RESOURCES_DIR, an absolute path; under the
 * test runner the default is refused, so a test can never touch the real store):
 *   claims/<op_id>.json  ship-ticket-host-claim-v1 { op_id, class, weight, resources:[{resource, mode}], container_label,
 *                        pgid, leader_start, claimer:{pid, process_start_time, start_identity?, host}, claimed_at, bound_at }
 *   claims.lock          the durable-io lock, held only while the claims are re-read, decided and written (never while sampling)
 *   samples.jsonl        every admission decision with its host samples, every reclaim, and each post-admission peak
 *   blocked.json         the ONE host-scoped Blocked while any holder is unknown (cleared with its cause)
 * TRUST: same-user (disclosed). Any process of this user can write the store; records are not authenticated.
 *
 * PROTOCOL (the caller's order): claim() BEFORE spawn -> spawn the launcher (it waits for the release byte) ->
 * bindClaim() with the group's pgid and leader start BEFORE the release byte -> release byte -> ... -> releaseClaim().
 *   - Σ weights of live and unknown holders + the request <= the heavy slots admitHost grants, decided under the lock on a
 *     fresh sample taken before it. heavy weight >= 1, light weight 0 (light work never waits for capacity).
 *   - A W claim excludes every R or W claim on the same canonical resource (realpathSync.native of the deepest existing
 *     ancestor, so two spellings of one installation are one resource; exact match, no hierarchy). Opaque names
 *     (`db:`, `port:`, ...) compare as strings.
 *   - A holder is reclaimed only on PROOF: never bound and its claimer proven dead (the launcher exits 125 without the
 *     byte, so nothing ran), or its group proven gone (engine-quiesce.mjs groupIdentity) AND, for a labelled claim, Docker
 *     reporting no container with its exact labels. The container check comes BEFORE the removal. Never by age.
 *   - Anything else that is not proven live (malformed record, foreign host, a live claimer or leader whose start
 *     identity is unrecorded or unreadable, a dead leader with members left, only stopped labelled containers, a Docker
 *     failure) is UNKNOWN; Docker is probed OUTSIDE the lock and the verdict applies only to the record version probed: it stays charged (weight 1 when the
 *     record is unreadable) and raises one host-scoped Blocked.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir, hostname, loadavg as osLoadavg } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, writeStateAtomic } from './lib/durable-io.mjs';
import { groupIdentity, processInfo, startRecord, recordDiffers, sameStart } from './engine-quiesce.mjs';
import { admitHost, hostSnapshot, HOST_POLICY } from './harness.mjs';
import { ownedContainers, reusableContainers } from './docker-lifecycle.mjs';
import { createHash } from 'node:crypto';

export const STORE_ENV = 'AI_SKILLS_HOST_RESOURCES_DIR';
export const CLAIM_SCHEMA = 'ship-ticket-host-claim-v1';
export const BLOCKED_SCHEMA = 'ship-ticket-host-blocked-v1';
const SAFE_OP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OPAQUE = /^(port|db|cache|docker|fixture|generator|lock):[A-Za-z0-9._/-]{1,100}$/;
const MAX_WEIGHT = 32;
const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** The store directory: env override (absolute), else ~/.ai-skills-state/host-resources; the default is refused under the test runner. */
export function storeDir(env = process.env, { home = homedir() } = {}) {
  const o = env[STORE_ENV];
  if (o !== undefined && o !== '') {
    if (!isAbsolute(o)) throw coded('host_store_invalid', `${STORE_ENV} must be an absolute path`);
    return resolve(o);
  }
  if (env.NODE_TEST_CONTEXT) throw coded('host_store_default_in_test', `a test must inject a store (dir or ${STORE_ENV}); the real one is never used under the test runner`);
  return join(home, '.ai-skills-state', 'host-resources');
}

/** Canonical identity of a shared resource: an opaque name as is, a path as the realpath of its deepest existing ancestor. */
export function canonicalResource(r, cwd = process.cwd()) {
  if (typeof r !== 'string' || r === '' || r.length > 4096 || r.includes('\0')) throw coded('host_resource_invalid', `resource ${JSON.stringify(r)}`);
  if (OPAQUE.test(r)) return r;
  let head = resolve(cwd, r);
  const tail = [];
  for (;;) {
    try { const real = realpathSync.native(head); return tail.length ? join(real, ...tail.reverse()) : real; } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = dirname(head);
      if (parent === head) return resolve(cwd, r);
      tail.push(basename(head)); head = parent;
    }
  }
}

/** POSIX process-group liveness: true, false (proven gone) or null (unknowable). */
export function groupAlive(pgid) {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 0) return null;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : e.code === 'ESRCH' ? false : null; }
}

const paths = (dir) => ({ claims: join(dir, 'claims'), lock: join(dir, 'claims.lock'), samples: join(dir, 'samples.jsonl'), blocked: join(dir, 'blocked.json') });
const claimFile = (dir, id) => join(paths(dir).claims, `${id}.json`);

function validClaim(c, id) {
  return isObj(c) && c.schema === CLAIM_SCHEMA && c.op_id === id && SAFE_OP.test(id) && ['heavy', 'light'].includes(c.class)
    && Number.isInteger(c.weight) && c.weight >= 0 && c.weight <= MAX_WEIGHT && Array.isArray(c.resources)
    && c.resources.every(x => isObj(x) && typeof x.resource === 'string' && ['R', 'W'].includes(x.mode))
    && (c.container_label === null || (isObj(c.container_label) && SAFE_LABEL.test(c.container_label.owner ?? '') && SAFE_LABEL.test(c.container_label.run ?? '')))
    && (c.pgid === null || (Number.isInteger(c.pgid) && c.pgid > 0)) && (c.leader_start === null || typeof c.leader_start === 'string')
    && isObj(c.claimer) && Number.isInteger(c.claimer.pid) && c.claimer.pid > 0 && typeof c.claimer.host === 'string'
    && (c.claimer.process_start_time === null || typeof c.claimer.process_start_time === 'string')
    && (c.claimer.start_identity === undefined || c.claimer.start_identity === null || typeof c.claimer.start_identity === 'string');
}

/** Every claim record: [{ id, claim }] with claim null when unreadable or malformed. Read-only. */
export function listClaims(dir) {
  let names = [];
  try { names = readdirSync(paths(dir).claims); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.json')).sort().map(n => {
    const id = n.slice(0, -5);
    let c = null, raw = null;
    try { raw = readFileSync(join(paths(dir).claims, n), 'utf8'); c = JSON.parse(raw); } catch { /* unreadable: unknown */ }
    return { id, claim: validClaim(c, id) ? c : null, version: raw === null ? null : createHash('sha256').update(raw).digest('hex') };
  });
}

/** Whether probe `now` POSITIVELY names the process of record `rec` (S1 identity: start_identity, else either pre-S1 form). */
const recordMatches = (now, rec) => (rec?.start_identity != null && now?.startTime != null ? now.startTime === rec.start_identity : sameStart(now, rec?.process_start_time ?? null));

/**
 * The Docker verdict of a labelled claim whose group is gone: 'gone' (no container with its exact labels), 'running', or
 * 'stopped' (only exited containers remain), or 'failed'. It is taken OUTSIDE the claim lock (Codex-4).
 */
export function dockerVerdict(label, docker = spawnSync) {
  try {
    if (!ownedContainers(label.owner, label.run, docker).length) return 'gone';
    return reusableContainers(label.owner, label.run, docker).length ? 'running' : 'stopped';
  } catch { return 'failed'; }
}
const DOCKER_STATE = { gone: { state: 'reclaimable', why: 'group_and_containers_gone' }, running: { state: 'live', why: 'container_alive' },
  stopped: { state: 'unknown', why: 'container_stopped' }, failed: { state: 'unknown', why: 'docker_failed' } };

/**
 * The holder state of one claim: { state: 'live'|'unknown'|'reclaimable', why, needsDocker? }. Only proof makes a claim
 * reclaimable. Live needs a POSITIVE identity match (Codex-5): a live claimer or leader whose start identity is unrecorded
 * or unreadable is unknown (charged, Blocked); a proven different start or a dead process is reclaimable. Docker is asked
 * (exact labels) only once the group is proven gone: `docker` is the verdict taken outside the lock (dockerVerdict), or
 * absent, then the claim is `needsDocker` (still charged as unknown until probed). A failure or stopped containers prove nothing.
 */
export function holderState(c, deps = {}, docker, { ownRelease = false } = {}) {
  const { info = processInfo, isAlive = groupAlive, host = hostname() } = deps;
  if (!c) return { state: 'unknown', why: 'malformed' };
  if (c.claimer.host !== host) return { state: 'unknown', why: 'foreign_host' };
  const claimer = () => { const o = info(c.claimer.pid) ?? { alive: false, startTime: null }; return !o.alive || recordDiffers(o, c.claimer) ? 'dead' : recordMatches(o, c.claimer) ? 'alive' : 'unknown'; };
  if (c.pgid === null) {
    const who = claimer();
    if (who === 'dead') return { state: 'reclaimable', why: 'claimer_dead_never_bound' };
    return who === 'alive' ? { state: 'live', why: 'claimer_alive' } : { state: 'unknown', why: 'claimer_identity_unknown' };
  }
  const id = groupIdentity({ pgid: c.pgid, leader_start: c.leader_start }, isAlive, info);
  if (id === 'verified') return { state: 'live', why: 'group_alive' };
  // S2 round 2: a live claimer keeps its bound claim (a batch rebinds it command by command, and the owner releases it in
  // its own finally). Its own release (`ownRelease`) is judged on the group and the containers alone.
  if (!ownRelease && claimer() === 'alive') return { state: 'live', why: 'claimer_alive' };
  if (id === 'unknown') return { state: 'unknown', why: 'group_unknown' };
  if (!c.container_label) return { state: 'reclaimable', why: 'group_gone' };
  return docker ? DOCKER_STATE[docker] : { state: 'unknown', why: 'docker_unprobed', needsDocker: true };
}

/** Outside the lock: the Docker verdict of every labelled claim whose group is gone, keyed by op_id and record version. */
function probeOutside(dir, deps) {
  const out = new Map();
  for (const { id, claim: c, version } of listClaims(dir)) {
    // judged on group alone (ownRelease), so an owner's own release of a labelled claim also has its verdict ready
    if (holderState(c, deps, undefined, { ownRelease: true }).needsDocker) out.set(id, { version, verdict: dockerVerdict(c.container_label, deps.docker ?? spawnSync) });
  }
  return out;
}
/** A probe applies only to the exact record version it was taken on; anything else stays charged (unprobed). */
const probed = (probes, id, version) => (probes.get(id)?.version === version ? probes.get(id).verdict : undefined);

function appendRow(dir, row) {
  const fd = openSync(paths(dir).samples, 'a', 0o600);
  try { appendFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Under the lock: reclaim proven-free claims, classify the rest, keep the one host-scoped Blocked in step with the unknown set. */
async function reconcileLocked(dir, deps, probes = new Map()) {
  const live = [], unknown = [], reclaimed = [];
  for (const { id, claim: c, version } of listClaims(dir)) {
    const h = holderState(c, deps, probed(probes, id, version));
    if (h.state === 'reclaimable') {
      try { unlinkSync(claimFile(dir, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      appendRow(dir, { kind: 'reclaimed', op_id: id, at: new Date().toISOString(), why: h.why });
      reclaimed.push(id);
    // m2: an unprobed labelled claim (its group died after the outside probe) is charged but is not an unknown holder.
    } else (h.state === 'live' || h.why === 'docker_unprobed' ? live : unknown).push({ id, claim: c, why: h.why });
  }
  const ids = unknown.map(u => u.id).sort();
  const file = paths(dir).blocked;
  let blocked = null;
  if (!ids.length) { try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } } else {
    let prior = null;
    try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
    if (prior && JSON.stringify(prior.op_ids) === JSON.stringify(ids)) blocked = { raised: false, ...prior };
    else {
      const rec = { schema: BLOCKED_SCHEMA, code: 'host_claim_unknown', scope: 'host', op_ids: ids, why: unknown.map(u => `${u.id}:${u.why}`),
        raised_at: new Date().toISOString(), note: 'an unknown holder stays charged; resolve it (prove the group gone or remove the record by hand), light work continues' };
      await writeStateAtomic(file, rec);
      blocked = { raised: true, ...rec };
    }
  }
  return { live, unknown, reclaimed, blocked };
}

async function locked(dir, deps, fn) {
  mkdirSync(paths(dir).claims, { recursive: true });
  const lock = await acquireLock({ lockFile: paths(dir).lock, runId: 'host-claims', ...(deps.info ? { processInfo: deps.info } : {}) }, { waitMs: deps.waitMs ?? 60000 });
  try { return await fn(); } finally { await lock.release(); }
}

function resourcesOf(resources, cwd) {
  if (!Array.isArray(resources)) throw coded('host_resource_invalid', 'resources must be an array of { resource, mode }');
  return resources.map(x => {
    if (!isObj(x) || !['R', 'W'].includes(x.mode) || Object.keys(x).some(k => k !== 'resource' && k !== 'mode')) throw coded('host_resource_invalid', `resource entry ${JSON.stringify(x)} needs { resource, mode: R|W }`);
    return { resource: canonicalResource(x.resource, cwd), mode: x.mode };
  });
}

/**
 * Claim host capacity and shared resources for operation `opId`, BEFORE its spawn. Sampling (two hostSnapshot windows at
 * most, as host-admit always did) happens OUTSIDE the lock; the decision and the write happen under it, on a re-read of
 * every claim. Returns { admit, reason, reasons, op_id, class, weight, occupancy, heavy_slots, conflicts, unknown,
 * blocked, sampled }. Holds: held_resource (R/W conflict), admitHost's reasons (held_heavy included), held_resample (the
 * sample went stale while waiting for the lock), claim_exists.
 */
export async function claim({ dir, opId, cls, weight, resources = [], containerLabel = null, cwd, snapshot = hostSnapshot, now = Date.now,
  history, platform = process.platform, ...deps }) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw coded('host_store_invalid', 'dir must be an absolute path');
  if (!SAFE_OP.test(opId ?? '')) throw coded('host_claim_invalid', `op_id ${JSON.stringify(opId)} must be a safe id`);
  if (cls !== 'heavy' && cls !== 'light') throw coded('host_claim_invalid', 'class must be heavy or light');
  const w = weight ?? (cls === 'heavy' ? 1 : 0);
  if (!Number.isInteger(w) || (cls === 'heavy' ? w < 1 || w > MAX_WEIGHT : w !== 0)) throw coded('host_claim_invalid', `weight ${w}: heavy 1..${MAX_WEIGHT}, light 0`);
  if (containerLabel !== null && !(isObj(containerLabel) && SAFE_LABEL.test(containerLabel.owner ?? '') && SAFE_LABEL.test(containerLabel.run ?? '')))
    throw coded('host_claim_invalid', 'containerLabel must be { owner, run } safe ids');
  const mine = resourcesOf(resources, cwd);
  // Sampling outside the lock. A cold start is held (held_hysteresis) until two clean samples: a second window only then.
  let hist = history, before, snap = null;
  if (w > 0) {
    for (let round = 1; round <= 2; round++) {
      before = hist;
      snap = await snapshot({ platform });
      const r = admitHost(snap, 'HEAVY', { total: 0, heavy: 0 }, hist);
      hist = r.history;
      if (r.admit || r.reasons.some(x => x !== 'held_hysteresis' && x !== 'held_heavy')) break;
    }
  }
  const probes = probeOutside(dir, deps);
  return locked(dir, deps, async () => {
    const rec = await reconcileLocked(dir, deps, probes);
    const holders = [...rec.live, ...rec.unknown];
    const reasons = [];
    if (holders.some(h => h.id === opId)) reasons.push('claim_exists');
    // F6: an unreadable holder is charged its (unknown) resources too: it conflicts with every resource claim.
    const conflicts = holders.filter(h => (h.claim ? h.claim.resources.some(x => mine.some(m => m.resource === x.resource && (m.mode === 'W' || x.mode === 'W'))) : mine.length > 0)).map(h => h.id);
    if (conflicts.length) reasons.push('held_resource');
    const occupancy = holders.reduce((t, h) => t + (h.claim ? h.claim.weight : 1), 0);
    let v = null;
    if (w > 0) {
      v = admitHost(snap, 'HEAVY', { total: Math.max(holders.length, occupancy), heavy: occupancy }, before); // F3: total >= heavy for weights > 1
      for (const x of v.reasons) if (!reasons.includes(x)) reasons.push(x);
      const age = now() - snap?.now_ms;
      if (!(Number.isFinite(age) && age >= 0 && age <= HOST_POLICY.max_snapshot_age_ms) && !reasons.includes('held_resample')) reasons.push('held_resample');
      const slots = v.signals?.heavy_slots;
      if (Number.isInteger(slots) && occupancy + w > slots && !reasons.includes('held_heavy')) reasons.push('held_heavy');
    }
    const admit = reasons.length === 0;
    const heavySlots = v?.signals?.heavy_slots ?? null;
    appendRow(dir, { kind: 'admission', op_id: opId, at: new Date().toISOString(), class: cls, weight: w, admit, reasons, occupancy, heavy_slots: heavySlots,
      samples: snap?.samples ?? [], signals: v?.signals ?? null, conflicts, unknown: rec.unknown.map(u => u.id) });
    if (admit) {
      const info = deps.info ?? processInfo;
      await writeStateAtomic(claimFile(dir, opId), { schema: CLAIM_SCHEMA, op_id: opId, class: cls, weight: w, resources: mine,
        container_label: containerLabel, pgid: null, leader_start: null,
        claimer: { pid: process.pid, ...startRecord(info(process.pid)), host: deps.host ?? hostname() }, // S1 identity: process_start_time + start_identity
        claimed_at: new Date().toISOString(), bound_at: null });
    }
    return { admit, reason: admit ? 'admitted' : reasons[0], reasons, op_id: opId, class: cls, weight: w, occupancy, heavy_slots: heavySlots,
      conflicts, unknown: rec.unknown.map(u => u.id), blocked: rec.blocked, sampled: snap !== null, history: hist };
  });
}

/** Rewrite claim `opId` with its group's pgid and leader start; the caller does this BEFORE writing the release byte. */
/**
 * Rewrite claim `opId` with its group's pgid and leader start; the caller does this BEFORE writing the release byte.
 * LOCK-FREE (S2 round 2, m4): only the claimer writes its record, and no reconciler removes a record whose claimer is alive,
 * so the atomic rewrite needs no store lock and a busy store can never fail a bind. A batch (one claim for several
 * sequential commands) rebinds it to the next command once the previous group is gone.
 */
export async function bindClaim({ dir, opId, pgid, leaderStart = null, isAlive = groupAlive }) {
  if (!Number.isInteger(pgid) || pgid <= 0) throw coded('host_claim_invalid', `pgid ${pgid}`);
  const found = listClaims(dir).find(x => x.id === opId);
  if (!found?.claim) throw coded('host_claim_absent', `no readable claim ${opId}`);
  const c = found.claim;
  if (c.claimer.pid !== process.pid || (c.pgid !== null && c.pgid !== pgid && isAlive(c.pgid) !== false))
    throw coded('host_claim_not_ours', `claim ${opId} is not this process's claim, or its bound group still runs`);
  await writeStateAtomic(claimFile(dir, opId), { ...c, pgid, leader_start: typeof leaderStart === 'string' ? leaderStart : null, bound_at: new Date().toISOString() });
  return { bound: true };
}

/**
 * Release claim `opId` once its operation is over: only when its group is proven gone (and no labelled container remains),
 * or, never bound, by its own claimer. Persists the post-admission peak row. Returns { released, reason }.
 */
export async function releaseClaim({ dir, opId, peak = {}, loadavg = osLoadavg, ...deps }) {
  const probes = probeOutside(dir, deps);
  return locked(dir, deps, async () => {
    const found = listClaims(dir).find(x => x.id === opId);
    const peakRow = (c, extra = {}) => {
      const [l1, l5, l15] = loadavg();
      appendRow(dir, { kind: 'peak', op_id: opId, at: new Date().toISOString(), class: c?.class ?? null, weight: c?.weight ?? null,
        host_load1_at_release: l1, host_load5_at_release: l5, host_load15_at_release: l15, ...peakFields(peak), ...extra });
    };
    // F2: another claimer already reclaimed it (its group was proven gone): the owner's peak is still persisted.
    if (!found) { peakRow(null, { reclaimed_before_release: true }); return { released: false, reason: 'absent' }; }
    const c = found.claim;
    const own = c && c.pgid === null && c.claimer.pid === process.pid && c.claimer.host === (deps.host ?? hostname());
    const mine = c && c.claimer.pid === process.pid && c.claimer.host === (deps.host ?? hostname());
    const h = own ? { state: 'reclaimable', why: 'never_bound' } : holderState(c, deps, probed(probes, opId, found.version), { ownRelease: mine });
    if (h.state !== 'reclaimable') return { released: false, reason: h.why };
    unlinkSync(claimFile(dir, opId));
    peakRow(c);
    return { released: true, reason: h.why };
  });
}

const PEAK_KEYS = ['peak_rss_mb', 'peak_cpu_pct', 'resource_samples', 'host_load1_max', 'host_load5_max', 'host_load15_max', 'host_samples'];
const peakFields = (p) => Object.fromEntries(PEAK_KEYS.map(k => [k, isObj(p) && (typeof p[k] === 'number' || p[k] === 'unknown') ? p[k] : null]));

/** Read-only occupancy for an advisory check (host-admit without `run`): nothing is reclaimed or written. */
export function inspectClaims(dir, deps = {}) {
  const live = [], unknown = [];
  for (const { id, claim: c } of listClaims(dir)) {
    let h = holderState(c, deps);
    if (h.needsDocker) h = DOCKER_STATE[dockerVerdict(c.container_label, deps.docker ?? spawnSync)]; // read-only, no lock held
    if (h.state !== 'reclaimable') (h.state === 'live' ? live : unknown).push({ id, weight: c ? c.weight : 1, why: h.why });
  }
  return { live, unknown, occupancy: [...live, ...unknown].reduce((t, x) => t + x.weight, 0), blocked: existsSync(paths(dir).blocked) };
}

/**
 * The host-load peak while an admitted operation runs (the 342/236 overlap went from load 3.64 at admission to about 16):
 * os.loadavg every `intervalMs` (unref'd, observation only). stop() returns { host_load{1,5,15}_max, host_samples }.
 */
export function peakSampler({ loadavg = osLoadavg, intervalMs = 5000 } = {}) {
  const m = { host_load1_max: 0, host_load5_max: 0, host_load15_max: 0, host_samples: 0 };
  const take = () => { const [a, b, c] = loadavg(); m.host_load1_max = Math.max(m.host_load1_max, a); m.host_load5_max = Math.max(m.host_load5_max, b); m.host_load15_max = Math.max(m.host_load15_max, c); m.host_samples++; };
  take();
  const timer = setInterval(take, intervalMs); timer.unref?.();
  return { stop: () => { clearInterval(timer); take(); return { ...m }; } };
}
