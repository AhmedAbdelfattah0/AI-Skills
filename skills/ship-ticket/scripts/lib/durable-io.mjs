/**
 * Durable I/O shared by every writer of engine state: the atomic JSON state write and the
 * per-ticket engine lock, moved verbatim from engine-io.mjs (S-30a), which re-exports them.
 * Node built-ins plus engine-quiesce.mjs (itself free of local imports), so any script can
 * import this module without a cycle.
 *
 * Differences from the engine-io.mjs originals (982a10f):
 * - writeStateAtomic also retries a win32 rename EACCES (upstream's transient set; antivirus
 *   and indexers surface it): the only behavioural change on a default path, win32 only.
 * - Two default-valued seams: writeStateAtomic's `fs.fsyncSync` and acquireLock's `ctx.lockFile`
 *   (default: the per-ticket path, as before). run-engine.mjs forwards its `ctx.fs` (a test-only
 *   field) to writeStateAtomic, so an engine test could reach `fs.fsyncSync`; no caller passes
 *   `ctx.lockFile`.
 * - acquireLock refuses a lock record whose pid is not an integer in 1..2^31-1 as `lock_malformed`
 *   (fail closed). Before, such a record was probed as a dead PID (or as a process group) and
 *   recovered; only a hand-edited or corrupted record can carry one.
 * - acquireLock takes an opt-in second argument `{ waitMs, signal, now, sleep }`. Without it a
 *   call is one attempt, exactly as before. Cancellation follows invariants I1-I4 (see acquireLock);
 *   the `TEST_SEAM` option key is test-only and engine-io.mjs does not re-export it.
 *
 * Opt-in bounded wait: derived from deepseek-harness@39163dd30f703a79079e2d2446545cff3c453738
 * packages/util/atomic-write/src/index.ts `withFileLock` (retry loop, exponential back-off
 * 20 ms doubling to 200 ms, AbortSignal checked before every attempt and during every sleep).
 * MIT, Copyright (c) 2026 DeepSeek. Modifications: plain JS for Node 18; it wraps our lock
 * protocol (pid + process start time + host + nonce, recovery marker) instead of upstream's
 * `<pid>\n` record and takeover claim; the deadline is on a monotonic clock (performance.now,
 * not Date.now), so a wall-clock jump neither extends nor cuts the wait; each sleep is clamped to
 * the deadline, so a timeout lands within `waitMs` plus one attempt; the signal is also re-checked
 * after every await inside an attempt, before any state change; an abort rejects with
 * `signal.reason` (or, when releasing a lock it took fails, with `lock_cancel_leaked` carrying that
 * reason); it returns a release handle instead of running an operation; no default wait.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify, merge,
 *   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 *   to whom the Software is furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 *   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 *   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 *   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * Windows: processInfo() reports startTime null there, so a live PID is always taken as the
 * holder (no reuse proof) and only a dead PID is recovered. Unchanged from engine-io.mjs.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as timerSleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { processInfo } from '../engine-quiesce.mjs';

/** Same shape as engine-dag.mjs `coded` (kept local: engine-dag imports harness.mjs and gate.mjs). */
const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

export const delay = (ms) => new Promise(r => setTimeout(r, ms));
/** Await the `boundary` hook, if any; a throw there aborts the caller at exactly that point. */
export const boundary = async (hooks, name, info) => { if (hooks?.boundary) await hooks.boundary(name, info); };

/** Absolute `git rev-parse --git-path <rel>` for the work tree at `repoRoot`. */
export function gitPath(repoRoot, rel) {
  const r = spawnSync('git', ['rev-parse', '--git-path', rel], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw coded('not_a_repo', `${repoRoot} is not a git work tree`);
  return resolve(repoRoot, r.stdout.trim());
}

/**
 * Atomically persist `state` as JSON: temp write, fsync, rename, directory fsync,
 * each preceded by its hook boundary. On win32 a rename EPERM/EBUSY/EACCES is retried
 * up to 10 attempts; elsewhere it is thrown at once. A short write, or any failure before the
 * rename, removes the temp file, so the old state stays complete.
 */
export async function writeStateAtomic(file, state, { hooks, fs = {}, platform = process.platform } = {}) {
  const rename = fs.renameSync ?? renameSync, write = fs.writeSync ?? writeSync, fsync = fs.fsyncSync ?? fsyncSync;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let renamed = false, fd = null;
  try {
    await boundary(hooks, 'temp-write', { file });
    fd = openSync(tmp, 'wx', 0o600);
    const data = Buffer.from(JSON.stringify(state, null, 1) + '\n');
    if (write(fd, data) !== data.length) throw new Error(`short write of ${file}`);
    await boundary(hooks, 'temp-fsync', { file });
    fsync(fd);
    closeSync(fd); fd = null;
    await boundary(hooks, 'rename', { file });
    for (let attempt = 1; ; attempt++) {
      try { rename(tmp, file); break; } catch (e) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 10) throw e;
        await delay(10 * attempt);
      }
    }
    renamed = true;
    await boundary(hooks, 'dir-fsync', { file });
    if (platform !== 'win32') {
      const dfd = openSync(dir, 'r');
      try { fsync(dfd); } finally { closeSync(dfd); }
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (!renamed) try { unlinkSync(tmp); } catch { /* never created */ }
  }
}

const RECOVER = 'stop every engine command for this ticket, confirm no engine process is running, then remove';

/**
 * Test-only seam key of acquireLock's options (never re-exported by engine-io.mjs; no production
 * caller passes it). `options[TEST_SEAM] = { step(name), readLock(path), unlinkLock(path) }`:
 * - `step(name)` is called synchronously at each named point of the call: `enter`, `attempt`,
 *   `acquired` (our exclusive create succeeded), `hook`/`hooked` (around the lock-stale-observed
 *   await), `sleep`/`slept` (around each back-off sleep) and `commit` (immediately before the one
 *   success return; nothing is awaited between it and the return). A test aborts the signal from
 *   it, synchronously or after N microtasks, to reach every await and microtask boundary.
 * - `readLock`/`unlinkLock` replace readFileSync/unlinkSync in the cancellation release only
 *   (fault injection for the leak report). The normal `handle.release()` and the stale-lock
 *   recovery never use them.
 */
export const TEST_SEAM = Symbol('durable-io acquireLock test seam');

/**
 * Take the per-ticket engine lock (`O_EXCL` file holding {pid, process_start_time,
 * host, run_id, nonce}). A same-host lock whose PID is dead, or alive with a
 * different start time, is recovered; concurrent recoverers race on an `O_EXCL`
 * recovery marker and re-check the observed nonce, so exactly one wins.
 *
 * Opt-in `{ waitMs, signal, now, sleep }`: without `waitMs` one attempt is made and every error is
 * thrown as it arises (`signal` is still honoured). `now` (monotonic ms) and `sleep(ms, signal)`
 * are test seams, defaulting to performance.now and an abortable timer. With `waitMs` (finite, >= 0) a refused attempt is retried with back-off until the
 * deadline. Retried: `lock_held` (live holder, recovery in progress, lost race), `lock_malformed`
 * (the holder may be between its exclusive create and its write), `ENOENT` (the holder released
 * between our create and our read) and, on win32, `EPERM` (a lock still being deleted). At the
 * deadline `lock_held` and `ENOENT` become `lock_timeout`; `lock_malformed` and `EPERM` are
 * rethrown as they are. Any other error (`lock_foreign_host`, `not_a_repo`, EISDIR, ...) is thrown
 * at once.
 *
 * Cancellation (invariants; every decision is the one function `cancelFirst`):
 * - I4 An already-aborted signal rejects with `signal.reason` before any work: before argument
 *   validation, the lock-path lookup (`not_a_repo`), the directory create and any probe, so no
 *   setup error can win over it and nothing is created.
 * - I2 The signal is checked before every attempt, after the lock-stale-observed await before any
 *   state change, before an attempt's error is classified (so the reason is never classified,
 *   wrapped or turned into lock_timeout), and after every sleep. An aborted call rejects with
 *   exactly `signal.reason`, whatever value it is (null, a string, an object carrying a `code`);
 *   the one exception is I3.
 * - I1 There is one success exit. After the last await, in the same synchronous turn as the
 *   `return`, the signal is checked; if it is aborted the lock we just took is released and the
 *   call rejects. So a handle is returned only if the signal was not aborted when the call
 *   resolved. An abort after that belongs to the caller (re-check `signal.aborted` after `await`
 *   if that matters).
 * - I3 If releasing the lock we took fails during cancellation (anything but "already gone" or
 *   "now someone else's"), the failure is never silent: the call rejects with an AggregateError,
 *   `code: 'lock_cancel_leaked'`, `errors: [signal.reason, failure]`, `reason: signal.reason`,
 *   `cause: failure`, and `leakedLock: { lockFile, nonce, pid, release }`; `release()` (synchronous)
 *   retries the removal and throws if it fails again. The normal `handle.release()` keeps its documented
 *   behaviour (nonce-checked, best effort, never throws).
 */
export async function acquireLock(ctx, options = {}) {
  const { waitMs, signal, now = () => performance.now(), sleep = (ms, sig) => timerSleep(ms, undefined, { signal: sig }) } = options;
  const seam = options[TEST_SEAM];
  const step = seam?.step ?? (() => {});
  let lockFile = null, mine = null, owned = false;
  /** Cancellation release: removes our lock; "gone" or "someone else's" is fine, anything else throws. */
  const releaseOwned = () => {
    let current;
    try { current = JSON.parse((seam?.readLock ?? readFileSync)(lockFile, 'utf8')); }
    catch (e) { if (e?.code === 'ENOENT') return; throw e; }
    if (current?.nonce !== mine.nonce) return;
    try { (seam?.unlinkLock ?? unlinkSync)(lockFile); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  };
  /** The single cancellation decision (I2); when we own the lock it is released first (I1, I3). */
  const cancelFirst = () => {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (owned) {
      try { releaseOwned(); } catch (failure) {
        throw Object.assign(new AggregateError([reason, failure], `acquireLock was cancelled after taking ${lockFile}, and releasing it failed (${failure?.code ?? failure}); `
          + `this process still holds it: call leakedLock.release(), or ${RECOVER} it`),
        { code: 'lock_cancel_leaked', reason, cause: failure, leakedLock: { lockFile, nonce: mine.nonce, pid: mine.pid, release: releaseOwned } });
      }
    }
    throw reason;
  };
  step('enter');
  cancelFirst(); // I4: before any work
  const wait = waitMs !== undefined;
  if (wait && (!Number.isFinite(waitMs) || waitMs < 0)) throw new TypeError(`waitMs must be a finite number >= 0, got ${waitMs}`);
  lockFile = ctx.lockFile ?? gitPath(ctx.repoRoot, `ai-skills/ship-ticket/${ctx.ticket}.lock`);
  const info = ctx.processInfo ?? processInfo;
  const pid = ctx.pid ?? process.pid;
  const host = ctx.host ?? hostname();
  mine = { pid, process_start_time: info(pid)?.startTime ?? null, host, run_id: ctx.runId, nonce: randomUUID() };
  mkdirSync(dirname(lockFile), { recursive: true });
  const create = () => {
    try { writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    owned = true;
    step('acquired');
    return true;
  };
  const handle = { lockFile, release: async () => {
    try { if (JSON.parse(readFileSync(lockFile, 'utf8')).nonce === mine.nonce) unlinkSync(lockFile); } catch { /* already gone */ }
  } };
  /** One protocol attempt: true when we now hold the lock; a refusal throws. Its only await is the hook. */
  const attempt = async () => {
    if (create()) return true;
    let raw;
    // ENOENT here means the holder released between our create and this read (retryable when waiting).
    try { raw = readFileSync(lockFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') e.lockVanished = true; throw e; }
    let held;
    try {
      held = JSON.parse(raw);
      if (!held || typeof held.pid !== 'number' || typeof held.host !== 'string') throw new Error();
      // Fail closed: a pid process.kill cannot probe (non-integer, <= 0: a group, > int32) proves nothing.
      if (!Number.isInteger(held.pid) || held.pid <= 0 || held.pid > 0x7fffffff) throw new Error();
    }
    catch { throw coded('lock_malformed', `${lockFile} is unreadable; ${RECOVER} it by hand`); }
    if (held.host !== host) throw coded('lock_foreign_host', `${lockFile} is held by host ${held.host}; on that host ${RECOVER} it`);
    const other = info(held.pid) ?? { alive: false, startTime: null };
    // Recovery needs proof: a dead PID, or a live PID whose known start time differs (reuse). A live
    // holder whose start time is unknown on either side is treated as the holder, never broken.
    const reused = other.startTime !== null && (held.process_start_time ?? null) !== null && other.startTime !== held.process_start_time;
    if (other.alive && !reused) throw coded('lock_held', `pid ${held.pid} holds ${lockFile}`);
    step('hook');
    await boundary(ctx.hooks, 'lock-stale-observed', { lockFile, held });
    step('hooked');
    cancelFirst(); // after the await, before any state change
    const marker = lockFile + '.recovery';
    try { writeFileSync(marker, JSON.stringify({ pid, nonce: mine.nonce }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw coded('lock_held', `another recovery is in progress (${marker}); if none is, ${RECOVER} the marker`); throw e; }
    try {
      let current = null;
      try { current = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* removed or rewritten */ }
      if (current?.nonce !== held.nonce) throw coded('lock_held', `${lockFile} was recovered by another process`);
      unlinkSync(lockFile);
      if (!create()) throw coded('lock_held', `${lockFile} was taken during recovery`);
      return true;
    } finally { try { unlinkSync(marker); } catch { /* gone */ } }
  };
  const platform = ctx.platform ?? process.platform;
  const transient = (e) => ['lock_held', 'lock_malformed'].includes(e?.code) || e?.lockVanished === true || (platform === 'win32' && e?.code === 'EPERM');
  const deadline = wait ? now() + waitMs : 0;
  for (let backoff = 20; ; backoff = Math.min(backoff * 2, 200)) {
    step('attempt');
    cancelFirst(); // before every attempt
    try { await attempt(); break; } catch (e) {
      cancelFirst(); // decided before any classification of `e`
      if (!wait || !transient(e)) throw e;
      if (now() >= deadline) {
        if (e.code === 'lock_held' || e.lockVanished) throw coded('lock_timeout', `waited ${waitMs} ms for ${lockFile} (${e.message})`);
        throw e;
      }
    }
    step('sleep');
    try { await sleep(Math.min(backoff, Math.max(0, deadline - now())), signal); }
    catch (e) { cancelFirst(); throw e; }
    step('slept');
  }
  // I1, the one success exit: nothing is awaited between this check and the return.
  cancelFirst();
  step('commit');
  return handle;
}
