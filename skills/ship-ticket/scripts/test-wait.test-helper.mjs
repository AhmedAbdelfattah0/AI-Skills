/**
 * Handshake waits for tests that drive real child processes (issue #49). Not a test file.
 *
 * A test that needs a child to have done something waits for the child's own observable marker
 * (a file it wrote, a log line, a dead pid) instead of sleeping for a fixed time. Each wait keeps
 * one generous upper bound, and that bound is only a failure timeout: on a quiet machine the
 * handshake is seen in milliseconds, and under CPU starvation the test still passes, or fails with
 * a message naming the handshake it never saw instead of an ENOENT or a bare assertion.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Upper bound for any handshake wait. A failure timeout, never a pass condition. */
export const HANDSHAKE_BOUND_MS = 120000;

/**
 * `timeoutMs` for a worker that is expected to finish by itself. It is the test's failure bound,
 * not the behaviour under test; the production defaults are untouched.
 */
export const WORKER_FAILURE_BOUND_MS = 120000;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Poll `pred` until it returns a truthy value (returned) or `ms` passes. Throws an Error naming
 * `what` on expiry. `pred` may be async; a throw inside it counts as "not yet" (a file mid-write).
 */
export async function waitFor(pred, what, { ms = HANDSHAKE_BOUND_MS, every = 25 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= end) throw new Error(`handshake not observed within ${ms} ms: ${what}`);
    await delay(every);
  }
}

/** Wait until `path` exists (a marker the child writes). */
export const waitForFile = (path, what, opts) => waitFor(() => existsSync(path), `${what} (waiting for ${path})`, opts);

/**
 * True when `pid` no longer runs: gone (ESRCH) or a zombie (it died and only awaits reaping by
 * its new parent, which under load can take a while). POSIX only.
 */
export function processGone(pid) {
  const vanished = () => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  if (vanished()) return true;
  if (process.platform === 'win32') return false; // no zombie state to read
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  // Fail closed: an unusable ps never reports a process as dead; only ESRCH or a read 'Z' does.
  if (r.error || r.status !== 0) return vanished();
  return r.stdout.trim().startsWith('Z');
}
