/**
 * The one way an attempt of the durable run engine (worker, RED runner or proof runner) leaves the
 * live set: `retire()` proves its whole process group gone (killing and awaiting survivors) and only
 * then gives it a terminal status and releases its resource locks. run-engine.mjs `commit()` refuses
 * to persist a terminal attempt that did not pass through here. Node built-ins only, no local
 * imports, so gate.mjs can use it without a module cycle.
 */
import { spawnSync } from 'node:child_process';

/** Attempt statuses during which dispatched code may still run (unknown: quiescence unproven). */
export const LIVE = ['intent', 'launched', 'running', 'unknown'];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/** `ps -o lstart=` of `pid` under `env`, or null. */
function lstart(pid, env) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, ...(env ? { env } : {}) });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
/** S1 (m7): the canonical, time-zone and locale independent environment of a start-time read. */
const CANON_ENV = () => ({ ...process.env, TZ: 'UTC', LC_ALL: 'C', LC_TIME: 'C', LANG: 'C' });

/**
 * Real process liveness and start time (POSIX `ps lstart`; null where unavailable). S1 (m7): `startTime` is read under
 * TZ=UTC and the C locale, so two processes with different TZ/LC_* agree on it; `startTimeLocal` (lazy) is the same read
 * under the inherited environment, the form records written before S1 carry. Compare with sameStart/differentStart.
 */
export function processInfo(pid) {
  let alive;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive || process.platform === 'win32') return { alive, startTime: null };
  let local;
  return { alive, startTime: lstart(pid, CANON_ENV()), get startTimeLocal() { return local === undefined ? (local = lstart(pid, null)) : local; } };
}

/** Whether probe `now` ({ startTime, startTimeLocal? }) matches the recorded start time `recorded` in either form. */
export const sameStart = (now, recorded) => recorded != null && now?.startTime != null
  && (now.startTime === recorded || (now.startTimeLocal != null && now.startTimeLocal === recorded));
/**
 * Whether `recorded` is PROVEN different from the probe (both known, and neither form matches): a mismatch caused only by
 * the pre-S1 local-time format reads as the same process (held), never as a reused pid.
 */
export const differentStart = (now, recorded) => recorded != null && now?.startTime != null && !sameStart(now, recorded);

/**
 * S1 (round-3 recovery): the start-time identity of a lock or recovery-marker record. `process_start_time` keeps the exact
 * representation 705ae1b writes (the inherited-environment `ps lstart` string), so an engine without S1 that compares it
 * raw with its own local probe still sees a live holder as live. The canonical (TZ/locale independent) form goes in a
 * SEPARATE field, `start_identity`, read only by S1 readers. A probe stub without `startTimeLocal` (tests) writes its one
 * form as `process_start_time`, as before.
 */
export const startRecord = (now) => {
  if (!now || now.startTime == null) return { process_start_time: null };
  const local = now.startTimeLocal;
  return local === undefined ? { process_start_time: now.startTime } : { process_start_time: local ?? null, start_identity: now.startTime };
};
/**
 * Whether record `rec` ({ process_start_time, start_identity? }) is PROVEN to name another process than probe `now`: the
 * canonical `start_identity` when the record has it, else the pre-S1 field in either form (differentStart). An unknown
 * start time on either side proves nothing (the holder is kept).
 */
export function recordDiffers(now, rec) {
  if (rec?.start_identity != null && now?.startTime != null) return now.startTime !== rec.start_identity;
  return differentStart(now, rec?.process_start_time ?? null);
}

/** Start time of a just-launched group leader, recorded on its attempt as `leader_start` (null when unknowable). */
export const leaderStart = (pid) => (pid ? processInfo(pid).startTime : null);

/**
 * Whether the group of attempt `a` may be a reused pgid: its recorded leader pid is alive now with
 * a different start time. A leader that is gone while members remain cannot be a reused group (a
 * pid is not reallocated while its process group has members).
 */
function reused(a) {
  if (!a.leader_start || !a.pgid) return false;
  const now = processInfo(a.pgid);
  return now.alive && differentStart(now, a.leader_start);
}

/**
 * S1 (P1): the identity of attempt `a`'s process group for an enforcer that did NOT launch it (the deadline sweep):
 * 'verified' only when `leader_start` is recorded and the leader pid is alive now with exactly that start time;
 * 'gone' when no member of the group exists; otherwise 'unknown' (no pgid, no recorded or readable start time, a
 * different start time, or a dead leader whose group still has members, which this check cannot attribute). Only
 * 'verified' may be signalled. Stricter than reused(), which treats an absent `leader_start` as not reused.
 */
export function groupIdentity(a, isAlive, info = processInfo) {
  if (!a?.pgid || !Number.isInteger(a.pgid) || a.pgid <= 0) return 'unknown';
  const group = isAlive(a.pgid);
  if (group === false) return 'gone';
  if (group !== true || !a.leader_start) return 'unknown';
  const now = info(a.pgid);
  if (now.alive && sameStart(now, a.leader_start)) return 'verified';
  // The leader exits right after publishing its envelope, so it can die between the group probe and the start-time read:
  // 'gone' only on a fresh positive proof that no member of the group exists (the same proof the first probe accepts).
  return isAlive(a.pgid) === false ? 'gone' : 'unknown';
}

/**
 * S1 (E8): a durable run never signals a group whose leader pid is alive while its start time was not recorded: without
 * `leader_start` a live leader cannot be told from a reused pid (reused() treats it as not reused).
 */
function unverifiedLeader(a) {
  return !a.leader_start && Boolean(a.pgid) && processInfo(a.pgid).alive;
}

/** SIGTERM then SIGKILL the group, waiting for it to go; returns the final liveness (null when unknowable). */
export async function killGroup(pgid, isAlive) {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    if (isAlive(pgid) !== true) return isAlive(pgid);
    try { process.kill(-pgid, sig); } catch { /* gone */ }
    const until = Date.now() + 3000;
    while (Date.now() < until && isAlive(pgid) === true) await delay(50);
  }
  return isAlive(pgid);
}

/**
 * Whole-group quiescence: SIGTERM/SIGKILL any surviving member of `pgid` and wait. Returns false
 * (proven gone), true (still alive) or null (unknowable: Windows, no pgid).
 */
export async function quiesce(pgid, isAlive) {
  const alive = isAlive(pgid);
  return alive === true && pgid ? killGroup(pgid, isAlive) : alive;
}

/**
 * Retire attempt `a` of state `S`. An attempt with no recorded pid was never released (the release
 * byte follows the durable pid commit), so nothing ran; otherwise its group must be proven gone.
 * A group whose leader pid was reused is never signalled (it is not ours): not proven.
 * Proven: `quiesced` is set, `status` (when given) applied and every lock `a` holds released;
 * returns true. Not proven: status 'unknown', locks kept; returns false (the caller raises the
 * quiescence_unknown judgment).
 */
export async function retire(S, a, isAlive, status, { bootEnded = false, owned = false } = {}) {
  const unreleased = a.pid === undefined || a.pid === null;
  // S1: `bootEnded` (the deadline sweep saw another boot id than the attempt's): every process of that boot is gone, so the
  // attempt is proven quiescent WITHOUT probing or signalling its pgid, which after a reboot may name an unrelated group.
  if (bootEnded && !unreleased) return proven(S, a, status);
  // S1 (Codex 1): in a durable run (S.durable), a process that did NOT launch the attempt (reconcile, resume, a later gate,
  // the sweep: `owned` false) signals only a POSITIVELY verified group (groupIdentity 'verified'); 'gone' needs no
  // signal; anything else (a failed start-time read, no recorded leader_start, a dead leader whose group still has
  // members) is unknown: no signal, locks kept. The launcher's own process (`owned`, right after its child exited) and a
  // legacy run keep the frozen reused() rule.
  if (!unreleased && S.durable && !owned && !['verified', 'gone'].includes(groupIdentity(a, isAlive))) { a.status = 'unknown'; return false; }
  if (!unreleased && (reused(a) || (S.durable && unverifiedLeader(a)))) { a.status = 'unknown'; return false; }
  const quiet = unreleased ? false : await quiesce(a.pgid, isAlive);
  if (quiet !== false) { a.status = 'unknown'; return false; }
  return proven(S, a, status);
}

/** Quiescence proven: mark `a` retired with `status` and release every lock it holds. */
function proven(S, a, status) {
  a.quiesced = true;
  if (status) a.status = status;
  for (const [r, holder] of Object.entries(S.locks ?? {})) if (holder === a.attempt_id) delete S.locks[r];
  return true;
}

/** The persistence guard: attempts in a terminal status that never passed through retire(). */
export const unretired = (S) => (S.attempts ?? []).filter(a => !LIVE.includes(a.status) && a.quiesced !== true);
