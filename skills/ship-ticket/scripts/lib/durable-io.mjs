/**
 * Durable I/O shared by every writer of engine state: the atomic JSON state write and the
 * per-ticket engine lock, moved verbatim from engine-io.mjs (S-30a), which re-exports them. S-04a2 adds `renameRetrying`
 * (the win32 rename retry, extracted from writeStateAtomic and also used by run-log-io's quarantine replace).
 * Node built-ins plus engine-quiesce.mjs (itself free of local imports), so any script can
 * import this module without a cycle.
 *
 * Differences from the engine-io.mjs originals (982a10f):
 * - writeStateAtomic also retries a win32 rename EACCES (upstream's transient set; antivirus
 *   and indexers surface it): the only behavioural change on a default path, win32 only.
 * - Two default-valued seams: writeStateAtomic's `fs.fsyncSync` and acquireLock's `ctx.lockFile`
 *   (default: the per-ticket path, as before). run-engine.mjs forwards its `ctx.fs` (a test-only
 *   field) to writeStateAtomic, so an engine test could reach `fs.fsyncSync`; since S1 run-engine.mjs
 *   passes `ctx.lockFile` for a durable run (its common-dir run directory), and run-log-io for its log.
 * - acquireLock refuses a lock record whose pid is not an integer in 1..2^31-1 as `lock_malformed`
 *   (fail closed). Before, such a record was probed as a dead PID (or as a process group) and
 *   recovered; only a hand-edited or corrupted record can carry one.
 * - acquireLock takes an opt-in second argument `{ waitMs, signal, now, sleep }`. Without it a
 *   call is one attempt, exactly as before. Cancellation follows invariants I1-I4 (see acquireLock);
 *   the `TEST_SEAM` option key is test-only and engine-io.mjs does not re-export it. With
 *   `waitMs`, an invalid value is now refused before the lock-path lookup and the directory create
 *   (4e487d9 refused it after them). The lock-stale-observed hook is awaited as is: a hook that
 *   never settles delays cancellation (hooks are test and crash-injection seams).
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
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as timerSleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { processInfo, startRecord, recordDiffers } from '../engine-quiesce.mjs';

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
 * Replace `to` with `from` by rename. On win32 a rename EPERM/EBUSY/EACCES (antivirus, indexers) is retried up to 10 attempts,
 * waiting `wait(10 * attempt)` between them; elsewhere, and for any other error, it is thrown at once. The caller must not
 * hold `to` open: win32 refuses to replace an open file, and no retry fixes a handle the caller itself keeps.
 * It is async: even when the first rename succeeds, awaiting it yields to the microtask queue before the caller's next step.
 * The caller is suspended meanwhile, so for writeStateAtomic the order rename -> `dir-fsync` hook -> directory fsync is unchanged
 * (pinned by durable-io.test.mjs "writeStateAtomic order").
 */
export async function renameRetrying(from, to, { rename = renameSync, platform = process.platform, wait = delay } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { rename(from, to); return; } catch (e) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 10) throw e;
      await wait(10 * attempt);
    }
  }
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
    await renameRetrying(tmp, file, { rename, platform });
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

/** link() errors meaning "this filesystem has no hard links": the marker falls back to an exclusive create. */
const NO_LINK = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS', 'EMLINK']);
/** How many stale-marker takeovers may nest (each needs a recoverer killed inside the previous takeover's window). */
const MARKER_DEPTH = 3;
/** N4: how many exclusive creates one attempt makes while the lock keeps vanishing between its create and its read. */
const VANISH_TRIES = 3;

/**
 * S1 (P1, N8): exclusive claim of the recovery marker `path` with record `rec` ({ pid, process_start_time, host, nonce,
 * start_identity? }: the same identity representation as the lock record).
 * Returns { release() } (removes the marker only while it is still ours). The marker is published complete or not at all:
 * written to a private temp file, then hard-linked to `path` (link fails with EEXIST when it exists), so a kill -9 never
 * leaves a partial marker. An existing marker is refused (`lock_held`) unless it is PROVEN stale: same host (a marker
 * without `host` predates the field and was written here), and its pid dead or alive with a known start time that differs
 * from a recorded one (the lock's own rule). A malformed marker, an unknown start time on either side of a live pid, or a
 * foreign host proves nothing and is refused, as before. Taking over a stale instance N needs the nested claim
 * `<path>.<N>`, so of two recoverers that both judged N stale exactly one replaces it; the other is refused because the
 * marker it read is gone or no longer N. The winner re-reads `path` (still N: only the holder of `<path>.<N>` or N's
 * dead owner could have removed it) and renames its own complete record over it. Nesting is bounded (MARKER_DEPTH).
 */
function claimMarker(path, rec, info, host, depth = 0, link = linkSync) {
  const body = JSON.stringify(rec);
  const tmp = `${path}.${rec.nonce}.${depth}.tmp`;
  const release = () => { try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === rec.nonce) unlinkSync(path); } catch { /* gone */ } };
  const refuse = (why) => coded('lock_held', `another recovery is in progress (${path}${why ? `: ${why}` : ''}); if none is, ${RECOVER} the marker`);
  writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 });
  try {
    try { link(tmp, path); return { release }; } catch (e) {
      if (NO_LINK.has(e.code)) {
        // S1 (m5): a filesystem without hard links (some exFAT/SMB/volume mounts): the pre-S1 exclusive create. A kill -9
        // between its create and its write leaves an empty marker, which is refused as unreadable (lock_held), as before S1.
        try { writeFileSync(path, body, { flag: 'wx', mode: 0o600 }); return { release }; } catch (w) { if (w.code !== 'EEXIST') throw w; }
      } else if (e.code !== 'EEXIST') throw e;
    }
    let m;
    try { m = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw refuse(e.code === 'ENOENT' ? 'it was released meanwhile' : 'unreadable'); }
    if (!m || !Number.isInteger(m.pid) || m.pid <= 0 || m.pid > 0x7fffffff || typeof m.nonce !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(m.nonce)) throw refuse('unreadable');
    if ((m.host ?? host) !== host) throw refuse(`written on host ${m.host}`);
    const o = info(m.pid) ?? { alive: false, startTime: null };
    const stale = !o.alive || recordDiffers(o, m);
    if (!stale || depth >= MARKER_DEPTH) throw refuse('');
    const sub = claimMarker(`${path}.${m.nonce}`, rec, info, host, depth + 1, link);
    try {
      let cur = null;
      try { cur = JSON.parse(readFileSync(path, 'utf8')); } catch { /* removed meanwhile */ }
      if (cur?.nonce !== m.nonce) throw refuse('it changed while being recovered');
      const swap = `${tmp}.swap`;
      writeFileSync(swap, body, { flag: 'wx', mode: 0o600 });
      try { renameSync(swap, path); } catch (e) { try { unlinkSync(swap); } catch { /* gone */ } throw e; }
      return { release };
    } finally { sub.release(); }
  } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}

/**
 * Test-only seam key of acquireLock's options (never re-exported by engine-io.mjs; no production
 * caller passes it). `options[TEST_SEAM] = { step(name), readLock(path), unlinkLock(path) }`:
 * - `step(name)` is called synchronously at each named point of the call: `enter`, `attempt`,
 *   `acquired` (our exclusive create succeeded), `hook`/`hooked` (around the lock-stale-observed
 *   await), `sleep`/`slept` (around each back-off sleep) and `commit` (immediately before the final
 *   cancellation check, which is the last thing before the one success return). A test aborts the signal from
 *   it, synchronously or after N microtasks, to reach every await and microtask boundary.
 * - `link(from, to)` (S1) replaces linkSync in the recovery marker publish and (N4) in the lock publish (a filesystem
 *   without hard links).
 * - `readLock`/`unlinkLock` replace readFileSync/unlinkSync in the cancellation release only
 *   (fault injection for the leak report). The normal `handle.release()` and the stale-lock
 *   recovery never use them.
 */
export const TEST_SEAM = Symbol('durable-io acquireLock test seam');

/**
 * Take the per-ticket engine lock (`O_EXCL` file holding {pid, process_start_time,
 * host, run_id, nonce}). A same-host lock whose PID is dead, or alive with a
 * different start time, is recovered; concurrent recoverers race on an `O_EXCL`
 * recovery marker and re-check the observed nonce, so exactly one wins. S1 (P1, N8): the marker
 * records { pid, process_start_time, host, nonce }; a marker left by a recoverer killed inside the
 * window is recovered by the next acquire once it is PROVEN stale by the lock's own rule (claimMarker),
 * where before it was refused until removed by hand. A durable run passes its common-dir `ctx.lockFile`.
 *
 * Opt-in `{ waitMs, signal, now, sleep }`: without `waitMs` one attempt is made and every error is
 * thrown as it arises (`signal` is still honoured). `now` (monotonic ms) and `sleep(ms, signal)`
 * are test seams, defaulting to performance.now and an abortable timer. With `waitMs` (finite, >= 0) a refused attempt is retried with back-off until the
 * deadline. Retried: `lock_held` (live holder, recovery in progress, lost race), `lock_malformed`
 * (a pre-N4 writer, or the no-hard-link fallback, may be between its exclusive create and its write), `ENOENT` (the holder released
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
  // S1: process_start_time byte-compatible with 705ae1b (its local `ps lstart`), the canonical form beside it (start_identity)
  const started = startRecord(info(pid));
  mine = { pid, process_start_time: started.process_start_time, host, run_id: ctx.runId, nonce: randomUUID(),
    ...(started.start_identity !== undefined ? { start_identity: started.start_identity } : {}) };
  mkdirSync(dirname(lockFile), { recursive: true });
  const link = seam?.link ?? linkSync;
  /**
   * N4 (D6): the lock is published complete or not at all. The record goes to a private temp file beside the lock, which is
   * then hard-linked to the lock path (link fails with EEXIST when the lock exists: the same exclusivity as O_EXCL), so a
   * contender never reads a created-but-unwritten lock as `lock_malformed`. Same bytes and mode as the pre-N4 create. If
   * the temp file cannot be written or the link fails for any reason but EEXIST (no hard links: exFAT, some SMB/volume
   * mounts; or an error the pre-N4 create would surface itself), the pre-N4 exclusive create runs instead, so no acquire
   * that succeeded before can fail now; only that fallback keeps the create-then-write window.
   * The temp file is staged once per attempt and kept until the attempt ends (`unstage`), so a stale-lock recovery's
   * unlink is followed directly by the link: the lock path is absent no longer than with the pre-N4 unlink-then-create.
   */
  const body = JSON.stringify(mine), tmp = `${lockFile}.${mine.nonce}.tmp`;
  let staged; // undefined: not staged yet; true: tmp holds our record; false: it cannot be used (the fallback runs)
  const unstage = () => { if (staged) try { unlinkSync(tmp); } catch { /* already gone */ } staged = undefined; };
  const create = () => {
    if (staged === undefined) { try { writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 }); staged = true; } catch { staged = false; } }
    let linked = false;
    if (staged) {
      try { link(tmp, lockFile); linked = true; } catch (e) { if (e.code === 'EEXIST') return false; } // EEXIST: the lock exists
      try { unlinkSync(tmp); } catch { /* already gone */ }
      staged = linked ? undefined : false;
    }
    if (!linked) {
      try { writeFileSync(lockFile, body, { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    }
    owned = true;
    step('acquired');
    return true;
  };
  const handle = { lockFile, release: async () => {
    try { if (JSON.parse(readFileSync(lockFile, 'utf8')).nonce === mine.nonce) unlinkSync(lockFile); } catch { /* already gone */ }
  } };
  /** One protocol attempt: true when we now hold the lock; a refusal throws. Its only await is the hook. */
  const attempt = async () => {
    let raw;
    // ENOENT here means the lock vanished between our create and this read: its holder released it, or a recoverer is between
    // its unlink and its publish. N4: the exclusive create is tried again at once (bounded, VANISH_TRIES), so a contender
    // takes a free lock or sees the new holder instead of failing on the gap; a lock that keeps vanishing is still reported
    // (retryable when waiting).
    for (let tries = 1; ; tries++) {
      if (create()) return true;
      try { raw = readFileSync(lockFile, 'utf8'); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; if (tries >= VANISH_TRIES) { e.lockVanished = true; throw e; } }
    }
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
    // S1: the canonical start_identity when the record has one, else the pre-S1 field in either form (engine-quiesce.mjs
    // recordDiffers), so a TZ/locale or format difference alone never proves reuse.
    const reused = recordDiffers(other, held);
    if (other.alive && !reused) throw coded('lock_held', `pid ${held.pid} holds ${lockFile}`);
    step('hook');
    await boundary(ctx.hooks, 'lock-stale-observed', { lockFile, held });
    step('hooked');
    cancelFirst(); // after the await, before any state change
    // S1 (P1, N8): the marker records the recoverer's identity { pid, process_start_time, host, nonce }, so a recoverer killed
    // inside this window leaves a marker the next acquire can prove stale (claimMarker) instead of refusing it forever.
    const claim = claimMarker(lockFile + '.recovery', { pid, process_start_time: mine.process_start_time, host, nonce: mine.nonce,
      ...(mine.start_identity !== undefined ? { start_identity: mine.start_identity } : {}) }, info, host, 0, seam?.link ?? linkSync);
    try {
      let current = null;
      try { current = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* removed or rewritten */ }
      if (current?.nonce !== held.nonce) throw coded('lock_held', `${lockFile} was recovered by another process`);
      unlinkSync(lockFile);
      if (!create()) throw coded('lock_held', `${lockFile} was taken during recovery`);
      return true;
    } finally { claim.release(); }
  };
  const platform = ctx.platform ?? process.platform;
  const transient = (e) => ['lock_held', 'lock_malformed'].includes(e?.code) || e?.lockVanished === true || (platform === 'win32' && e?.code === 'EPERM');
  const deadline = wait ? now() + waitMs : 0;
  for (let backoff = 20; ; backoff = Math.min(backoff * 2, 200)) {
    step('attempt');
    cancelFirst(); // before every attempt
    try { await attempt(); unstage(); break; } catch (e) {
      unstage(); // N4: the attempt's temp file never outlives it
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
  // I1, the one success exit: the check is the last thing before the return (no await, no foreign
  // code between them; the test seam runs before it).
  step('commit');
  cancelFirst();
  return handle;
}
