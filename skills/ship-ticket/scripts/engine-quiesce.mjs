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

/** Real process liveness and start time (POSIX `ps lstart`; null where unavailable). */
export function processInfo(pid) {
  let alive;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive || process.platform === 'win32') return { alive, startTime: null };
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  return { alive, startTime: r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null };
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
  return now.alive && now.startTime !== null && now.startTime !== a.leader_start;
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
export async function retire(S, a, isAlive, status) {
  const unreleased = a.pid === undefined || a.pid === null;
  if (!unreleased && reused(a)) { a.status = 'unknown'; return false; }
  const quiet = unreleased ? false : await quiesce(a.pgid, isAlive);
  if (quiet !== false) { a.status = 'unknown'; return false; }
  a.quiesced = true;
  if (status) a.status = status;
  for (const [r, holder] of Object.entries(S.locks ?? {})) if (holder === a.attempt_id) delete S.locks[r];
  return true;
}

/** The persistence guard: attempts in a terminal status that never passed through retire(). */
export const unretired = (S) => (S.attempts ?? []).filter(a => !LIVE.includes(a.status) && a.quiesced !== true);
