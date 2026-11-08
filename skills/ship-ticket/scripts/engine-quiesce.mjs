/**
 * The one way an attempt of the durable run engine (worker, RED runner or proof runner) leaves the
 * live set: `retire()` proves its whole process group gone (killing and awaiting survivors) and only
 * then gives it a terminal status and releases its resource locks. run-engine.mjs `commit()` refuses
 * to persist a terminal attempt that did not pass through here. Node built-ins only, no imports,
 * so gate.mjs can use it without a module cycle.
 */

/** Attempt statuses during which dispatched code may still run (unknown: quiescence unproven). */
export const LIVE = ['intent', 'launched', 'running', 'unknown'];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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
 * Proven: `quiesced` is set, `status` (when given) applied and every lock `a` holds released;
 * returns true. Not proven: status 'unknown', locks kept; returns false (the caller raises the
 * quiescence_unknown judgment).
 */
export async function retire(S, a, isAlive, status) {
  const quiet = a.pid === undefined || a.pid === null ? false : await quiesce(a.pgid, isAlive);
  if (quiet !== false) { a.status = 'unknown'; return false; }
  a.quiesced = true;
  if (status) a.status = status;
  for (const [r, holder] of Object.entries(S.locks ?? {})) if (holder === a.attempt_id) delete S.locks[r];
  return true;
}

/** The persistence guard: attempts in a terminal status that never passed through retire(). */
export const unretired = (S) => (S.attempts ?? []).filter(a => !LIVE.includes(a.status) && a.quiesced !== true);
