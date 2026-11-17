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
 *   (default: the per-ticket path, as before). No engine caller passes either.
 * - acquireLock takes an opt-in second argument `{ waitMs, signal, now, sleep }`. Without it a
 *   call is one attempt, exactly as before.
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
 * `signal.reason`; it returns a release handle instead of running an operation; no default wait.
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
 * at once. `signal` is checked before every attempt, during every sleep and after the
 * `lock-stale-observed` hook (the only await inside an attempt) before the recovery marker is
 * created, so an abort rejects with `signal.reason`, owning no lock and leaving no marker. Once a
 * handle is returned the caller owns cancellation.
 */
export async function acquireLock(ctx, { waitMs, signal, now = () => performance.now(), sleep = (ms, sig) => timerSleep(ms, undefined, { signal: sig }) } = {}) {
  const lockFile = ctx.lockFile ?? gitPath(ctx.repoRoot, `ai-skills/ship-ticket/${ctx.ticket}.lock`);
  const info = ctx.processInfo ?? processInfo;
  const pid = ctx.pid ?? process.pid;
  const host = ctx.host ?? hostname();
  const mine = { pid, process_start_time: info(pid)?.startTime ?? null, host, run_id: ctx.runId, nonce: randomUUID() };
  mkdirSync(dirname(lockFile), { recursive: true });
  const create = () => {
    try { writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx', mode: 0o600 }); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  };
  const handle = { lockFile, release: async () => {
    try { if (JSON.parse(readFileSync(lockFile, 'utf8')).nonce === mine.nonce) unlinkSync(lockFile); } catch { /* already gone */ }
  } };
  const attempt = async () => {
    if (create()) return handle;
    let raw;
    // ENOENT here means the holder released between our create and this read (retryable when waiting).
    try { raw = readFileSync(lockFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') e.lockVanished = true; throw e; }
    let held;
    try { held = JSON.parse(raw); if (!held || typeof held.pid !== 'number' || typeof held.host !== 'string') throw new Error(); }
    catch { throw coded('lock_malformed', `${lockFile} is unreadable; ${RECOVER} it by hand`); }
    if (held.host !== host) throw coded('lock_foreign_host', `${lockFile} is held by host ${held.host}; on that host ${RECOVER} it`);
    const other = info(held.pid) ?? { alive: false, startTime: null };
    // Recovery needs proof: a dead PID, or a live PID whose known start time differs (reuse). A live
    // holder whose start time is unknown on either side is treated as the holder, never broken.
    const reused = other.startTime !== null && (held.process_start_time ?? null) !== null && other.startTime !== held.process_start_time;
    if (other.alive && !reused) throw coded('lock_held', `pid ${held.pid} holds ${lockFile}`);
    await boundary(ctx.hooks, 'lock-stale-observed', { lockFile, held });
    signal?.throwIfAborted(); // cancellation re-checked after the await, before any state change
    const marker = lockFile + '.recovery';
    try { writeFileSync(marker, JSON.stringify({ pid, nonce: mine.nonce }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw coded('lock_held', `another recovery is in progress (${marker}); if none is, ${RECOVER} the marker`); throw e; }
    try {
      let current = null;
      try { current = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* removed or rewritten */ }
      if (current?.nonce !== held.nonce) throw coded('lock_held', `${lockFile} was recovered by another process`);
      unlinkSync(lockFile);
      if (!create()) throw coded('lock_held', `${lockFile} was taken during recovery`);
      return handle;
    } finally { try { unlinkSync(marker); } catch { /* gone */ } }
  };
  if (waitMs === undefined) { signal?.throwIfAborted(); return attempt(); }
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError(`waitMs must be a finite number >= 0, got ${waitMs}`);
  const platform = ctx.platform ?? process.platform;
  const transient = (e) => ['lock_held', 'lock_malformed'].includes(e.code) || e.lockVanished === true || (platform === 'win32' && e.code === 'EPERM');
  const deadline = now() + waitMs;
  for (let backoff = 20; ; backoff = Math.min(backoff * 2, 200)) {
    signal?.throwIfAborted();
    try { return await attempt(); } catch (e) {
      if (!transient(e)) throw e;
      if (now() >= deadline) {
        if (e.code === 'lock_held' || e.lockVanished) throw coded('lock_timeout', `waited ${waitMs} ms for ${lockFile} (${e.message})`);
        throw e;
      }
    }
    try { await sleep(Math.min(backoff, Math.max(0, deadline - now())), signal); }
    catch (e) { signal?.throwIfAborted(); throw e; }
  }
}
