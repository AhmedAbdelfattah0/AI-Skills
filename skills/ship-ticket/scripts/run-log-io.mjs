/**
 * The write paths of `<ticket>.jsonl` (S-04a2). Lock: lib/durable-io.mjs `acquireLock` on `<log>.lock` (never the engine's
 * per-ticket lock). Sidecars: durable-io `writeStateAtomic`. The append and the quarantine rewrite are custom (durable-io has
 * only a JSON replace). Only run-log.mjs calls these (a structural test pins it). Invariants (measure/events.mjs header):
 * - I1: `check(after, before)` sees the WHOLE file as it will be after the write (committed bytes + loss record + new text)
 *   and throws to refuse; no existing byte is written, moved or truncated before it passes. A log that did not exist is created
 *   (empty) before `check` runs; when the write is refused and the path still names that same (device, inode) empty file, it is removed again (`locked`).
 * - I2: bytes leave the log only after they are durable in `<log>.lost-<offset>-<sha12>[-<layout8>].json` (verbatim, base64), and the
 *   same write carries the `log_loss` record `marker(info)` returns. The sidecar is the durable record of the removed bytes;
 *   a refusal before the write leaves every existing byte as it was, and after a failed write restoring the original bytes is best effort.
 * - I3: only the bytes after the last LF are torn (measure/events.mjs `committedLength`).
 * - Replace (win32): the quarantine reads the log, CLOSES it, and only then renames its temp over it (durable-io `renameRetrying`,
 *   which also retries a transient win32 EPERM/EBUSY/EACCES). A refused replace removes the temp and leaves the log unchanged;
 *   the sidecar written before it is then a redundant copy, never the only one.
 * Cancellation (`lockOptions.signal`) applies to the lock wait only: once the lock is held the operation runs to completion.
 * The awaits inside the lock are the `hooks.boundary` test fault-injection points, the sidecar write (durable-io `writeStateAtomic`)
 * and, on win32, the rename retry waits (durable-io `renameRetrying`, `opts.wait` seam).
 */
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { acquireLock, boundary, renameRetrying, writeStateAtomic } from './lib/durable-io.mjs';
import { committedLength } from './measure/events.mjs';

const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
/** A log larger than this is refused rather than read into memory (L3). */
export const LOG_BYTES_MAX = 64 * 1024 * 1024;
export const LOSS_SCHEMA = 'ship-ticket-run-log-loss-v1';
/** `info.layout` (non-enumerable, set for a multi-piece quarantine) hashes every piece's offset and length, so two recoveries
 *  with equal removed bytes and first offset but different later offsets never share a sidecar (the earlier one is never replaced). */
export const sidecarPath = (file, { offset, sha256, layout }) => `${file}.lost-${offset}-${sha256.slice(0, 12)}${layout ? `-${layout}` : ''}.json`;
/** Add diagnostic fields to a thrown value when it is an object we may write to (a frozen or primitive throw is rethrown as is). */
const annotate = (error, fields) => { if (error !== null && typeof error === 'object') for (const [k, v] of Object.entries(fields)) { try { Object.defineProperty(error, k, { value: v, enumerable: false, configurable: true, writable: true }); } catch { /* frozen */ } } };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const seams = ({ fs = {} }) => ({ write: fs.writeSync ?? writeSync, fsync: fs.fsyncSync ?? fsyncSync, truncate: fs.ftruncateSync ?? ftruncateSync,
  open: fs.openSync ?? openSync, close: fs.closeSync ?? closeSync, rename: fs.renameSync ?? renameSync });
const writeAll = (write, fd, data, at) => { const n = write(fd, data, 0, data.length, at); if (n !== data.length) throw coded('short_write', `${n} of ${data.length} bytes`); };

/** Remove `file` only when it is still the very file this process created (same device and inode as the handle's) and is empty.
 *  Best effort: a failure here never hides the error that got us here, and another creator's file is never removed. */
function dropIfOurs(file, mine) {
  try { const now = statSync(file); if (now.dev === mine.dev && now.ino === mine.ino && now.size === 0) unlinkSync(file); } catch { /* absent, or not removable: leave it */ }
}

/**
 * Lock, open (read-write, never append mode: truncation must work on win32) and read; `body` runs with the file's bytes. With
 * `hold` false the log is closed before `body` runs and `body` gets no fd: a replace-by-rename never targets a file this process
 * holds open (win32 refuses it with EPERM). Mutual exclusion is `<log>.lock`, never the log's own handle.
 */
async function locked(file, opts, hold, body) {
  const { waitMs = 10000, lock = acquireLock, lockCtx = {}, lockOptions = {} } = opts;
  const handle = await lock({ lockFile: `${file}.lock`, runId: 'run-log', ...lockCtx }, { waitMs, ...lockOptions });
  let mine = null; // dev/ino of the log this process created with its own exclusive open
  try {
    const { open, close } = seams(opts);
    const created = !existsSync(file);
    let fd = open(file, created ? 'wx+' : 'r+', 0o600);
    if (created) { const st = fstatSync(fd); mine = { dev: st.dev, ino: st.ino }; }
    try {
      await boundary(opts.hooks, 'append-read', { file });
      const size = fstatSync(fd).size;
      if (size > (opts.maxBytes ?? LOG_BYTES_MAX)) throw coded('log_too_large', `${file} is ${size} bytes`);
      const buf = Buffer.alloc(size);
      for (let at = 0; at < size;) { const n = readSync(fd, buf, at, size - at, at); if (n === 0) throw coded('short_read', file); at += n; }
      if (!hold) { const f = fd; fd = null; close(f); }
      return await body(fd, buf, created);
    } finally { if (fd !== null) close(fd); }
  } catch (error) {
    if (mine) dropIfOurs(file, mine); // a refused first write must not leave the empty log `open('wx+')` created
    throw error;
  } finally { await handle.release(); }
}

/** I2: persist the bytes leaving the log, verbatim, before they leave it. */
async function saveLost(file, info, pieces, opts) {
  await boundary(opts.hooks, 'append-sidecar', { file });
  await writeStateAtomic(sidecarPath(file, info), { schema: LOSS_SCHEMA, log: file.split(/[\\/]/).pop(), ...info,
    pieces: pieces.map(([from, bytes]) => ({ offset: from, base64: bytes.toString('base64') })) }, { fs: { fsyncSync: seams(opts).fsync }, platform: opts.platform });
}
const lossInfo = (offset, bytes, cause, pieces) => {
  const info = { offset, bytes: bytes.length, sha256: sha(bytes), cause };
  if (pieces && pieces.length > 1) Object.defineProperty(info, 'layout', { value: sha(Buffer.from(JSON.stringify(pieces.map(([from, b]) => [from, b.length])))).slice(0, 8), enumerable: false });
  return info;
};

/**
 * Append `text` (whole LF-terminated lines). A torn tail is moved to a sidecar and replaced by `marker(info)` + `text` in one
 * positional write; after a failure once the write has started, restoring the original bytes is best effort (the sidecar is the durable record). Options: `check(after, before)`,
 * `marker(info) -> text` (required when a torn tail exists), `waitMs`, `maxBytes`; test seams `lock`, `lockCtx`, `lockOptions`,
 * `hooks`, `fs` ({ writeSync, fsyncSync, ftruncateSync, openSync, closeSync, renameSync }), `platform`, `wait` (win32 rename retry wait). Resolves `{ lost: info | null, bytes }`.
 */
export async function appendLocked(file, text, opts = {}) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw coded('bad_append', 'text must be whole LF-terminated lines');
  const { write, fsync, truncate, open, close } = seams(opts), platform = opts.platform ?? process.platform;
  return locked(file, opts, true, async (fd, buf, created) => {
    const committed = committedLength(buf), tail = buf.subarray(committed);
    const info = tail.length ? lossInfo(committed, tail, 'torn_tail') : null;
    if (info && !opts.marker) throw coded('loss_unrecorded', `${file} has a torn tail and no loss record was supplied`);
    const out = Buffer.from((info ? opts.marker(info) : '') + text, 'utf8');
    const before = buf.subarray(0, committed);
    if (opts.check) opts.check(Buffer.concat([before, out]), before);
    if (info) await saveLost(file, info, [[committed, tail]], opts);
    await boundary(opts.hooks, 'append-write', { file });
    try {
      writeAll(write, fd, out, committed);
      if (buf.length > committed + out.length) truncate(fd, committed + out.length);
      await boundary(opts.hooks, 'append-fsync', { file });
      fsync(fd);
      if (created && platform !== 'win32') { const dfd = open(dirname(file), 'r'); try { fsync(dfd); } finally { close(dfd); } }
    } catch (error) {
      try { writeAll(write, fd, tail, committed); truncate(fd, buf.length); } catch { /* the sidecar holds the tail; R11 drops a torn rest */ }
      throw error;
    }
    return { lost: info, bytes: out.length };
  });
}

/**
 * I4: move the byte ranges `select(buf)` names (sorted, disjoint [from, to)) to a sidecar and atomically replace the log with
 * the remaining bytes + `marker(info)`. `check(after, before)` must accept the result. Resolves the loss info, or null when
 * nothing is selected (the log is untouched). A failure before the replace leaves the log as it was. If only the directory fsync
 * AFTER a successful replace fails, the quarantine HAS taken effect (log replaced, sidecar written) yet the call rejects; that error
 * carries `replaced: true` and `loss: info` so a caller can tell it from a refusal. A temp file that could not be removed after a
 * failure is named on the error as `leaked_tmp`.
 */
export async function quarantineLocked(file, { select, marker, check, ...opts }) {
  const { write, fsync, open, close, rename } = seams(opts), platform = opts.platform ?? process.platform;
  return locked(file, opts, false, async (_closed, buf) => {
    const ranges = select(buf);
    if (!ranges.length) return null;
    const pieces = ranges.map(([from, to]) => [from, buf.subarray(from, to)]);
    const keep = [];
    let at = 0;
    for (const [from, to] of ranges) { keep.push(buf.subarray(at, from)); at = to; }
    keep.push(buf.subarray(at));
    const info = lossInfo(ranges[0][0], Buffer.concat(pieces.map(([, b]) => b)), 'quarantine', pieces);
    const after = Buffer.concat([...keep, Buffer.from(marker(info), 'utf8')]);
    if (check) check(after, buf);
    await saveLost(file, info, pieces, opts);
    await boundary(opts.hooks, 'append-write', { file });
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      const t = open(tmp, 'wx', 0o600);
      try { writeAll(write, t, after, 0); fsync(t); } finally { close(t); }
      await renameRetrying(tmp, file, { rename, platform, wait: opts.wait });
    } catch (error) {
      try { unlinkSync(tmp); } catch (gone) { if (gone?.code !== 'ENOENT') annotate(error, { leaked_tmp: tmp }); } // ENOENT: never created
      throw error;
    }
    try {
      if (platform !== 'win32') { const dfd = open(dirname(file), 'r'); try { fsync(dfd); } finally { close(dfd); } }
    } catch (error) { annotate(error, { replaced: true, loss: info }); throw error; }
    return info;
  });
}
