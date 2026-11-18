/**
 * The one append path of `<ticket>.jsonl` (S-04a2): the lock is lib/durable-io.mjs `acquireLock` (on its own
 * `<ticket>.jsonl.lock`, never the engine's per-ticket lock); the append itself is custom, because durable-io has only a
 * JSON replace. Under the lock, synchronously: read the file, apply the R11 rule (measure/events.mjs `committedLength`),
 * run the caller's `check` on the committed bytes (a throw refuses: nothing is truncated or written), truncate a torn
 * tail or torn record, write the whole record text in ONE positional write at the committed length (the file is opened
 * read-write, never in append mode, so truncation works on win32 too), fsync, and fsync the directory of a new file (POSIX).
 * Any failure after the write starts (short write, write or fsync error) rolls the file back to the committed length, so a
 * rejection always means "committed history only"; if even the rollback fails, the torn bytes are left for R11 to drop.
 * Cancellation (`lockOptions.signal`) applies to the lock wait only: once the lock is held the append runs to completion.
 * Only run-log.mjs calls this (a structural test pins it).
 */
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLock, boundary } from './lib/durable-io.mjs';
import { committedLength } from './measure/events.mjs';

const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/**
 * Append `text` (whole LF-terminated lines) to `file`. Options: `check(committedBuffer)`; `waitMs` (lock wait, default 10 s);
 * seams for tests: `lock` (acquireLock), `lockCtx` (merged into its ctx), `lockOptions` (merged into its options),
 * `hooks.boundary(name)` (append-read, append-truncate, append-write, append-fsync), `fs` ({ writeSync, fsyncSync, ftruncateSync }),
 * `platform`. Resolves `{ truncated, bytes }`.
 */
export async function appendLocked(file, text, { check, waitMs = 10000, lock = acquireLock, lockCtx = {}, lockOptions = {}, hooks, fs = {}, platform = process.platform } = {}) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw coded('bad_append', 'text must be whole LF-terminated lines');
  const data = Buffer.from(text, 'utf8');
  const write = fs.writeSync ?? writeSync, fsync = fs.fsyncSync ?? fsyncSync, truncate = fs.ftruncateSync ?? ftruncateSync;
  const handle = await lock({ lockFile: `${file}.lock`, runId: 'run-log', ...lockCtx }, { waitMs, ...lockOptions });
  try {
    const created = !existsSync(file);
    const fd = openSync(file, created ? 'wx+' : 'r+', 0o600);
    try {
      await boundary(hooks, 'append-read', { file });
      const size = fstatSync(fd).size, buf = Buffer.alloc(size);
      for (let at = 0; at < size;) { const n = readSync(fd, buf, at, size - at, at); if (n === 0) throw coded('short_read', file); at += n; }
      const committed = committedLength(buf);
      if (check) check(buf.subarray(0, committed));
      await boundary(hooks, 'append-truncate', { file });
      if (committed < size) truncate(fd, committed);
      await boundary(hooks, 'append-write', { file });
      try {
        const written = write(fd, data, 0, data.length, committed);
        if (written !== data.length) throw coded('short_write', `${written} of ${data.length} bytes to ${file}`);
        await boundary(hooks, 'append-fsync', { file });
        fsync(fd);
        if (created && platform !== 'win32') { const dfd = openSync(dirname(file), 'r'); try { fsync(dfd); } finally { closeSync(dfd); } }
      } catch (error) {
        try { truncate(fd, committed); } catch { /* left torn: R11 drops it */ }
        throw error;
      }
      return { truncated: size - committed, bytes: data.length };
    } finally { closeSync(fd); }
  } finally { await handle.release(); }
}
