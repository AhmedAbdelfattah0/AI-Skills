/**
 * Where ship-ticket run logs (`<ticket>.jsonl`) live (S5, F05, cutover). Dependency-free ESM: node built-ins only.
 *
 * One place per repository: `<git-common-dir>/ai-skills/ship-ticket/`, shared by the main checkout and every linked
 * worktree: the ONLY runtime telemetry source of every reader and writer.
 * Before S5 the log lived at `git rev-parse --git-path ai-skills/ship-ticket`, which in a linked worktree is the
 * per-worktree gitdir (`<common>/worktrees/<name>/ai-skills/ship-ticket`). Those old files are a read-only ARCHIVE:
 * never written, moved, copied, deleted or merged into a figure. Normal commands only count the own worktree's one
 * (`legacyPresent`); `run-log.mjs legacy` prints it for audit; the carrier's REPAIR read is unchanged. In the main
 * checkout the old path IS the common dir, so its pre-S5 history is the shared log.
 *
 * Engine files (.state.json, .engine.jsonl, .usage.jsonl, .attempts) are not run logs: they stay per-worktree unless the
 * run is durable (S1, every new run: lib/run-placement.mjs places them in <git-common-dir>/ai-skills/ship-ticket/runs/).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const LOG_SUBDIR = join('ai-skills', 'ship-ticket');
/** Per-worktree subdirectory of REVIEW authority records (`<git-path>/ai-skills/ship-ticket/review-auth/<ticket>.jsonl`). No
 *  ticket name can address it: a ticket id has no `/`, so every shared write is a FILE directly in the log directory. */
export const AUTH_SUBDIR = 'review-auth';
/** Reserved ticket name kept so isReservedTicket stays byte-identical (the `excluded/` mechanism was removed). */
export const EXCLUDED_SUBDIR = 'excluded';
/**
 * Ticket ids that are refused, compared case-insensitively (APFS and NTFS fold case): a `.engine` or `.review-auth` suffix
 * (the run engine's file, the pre-repair authority file name) and the two subdirectory names.
 */
export function isReservedTicket(ticket) {
  const t = String(ticket).toLowerCase();
  return t.endsWith('.engine') || t.endsWith('.review-auth') || t === AUTH_SUBDIR || t === EXCLUDED_SUBDIR;
}

const coded = (code, message) => Object.assign(new Error(message), { code });

function revParse(repo, args) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * An absolute directory git reports for `repo`. `--path-format=absolute` (git >= 2.31) first; an older git prints a
 * path relative to the directory git ran in (`-C repo`), so it is resolved against `repo` itself, never against the
 * top level (from a subdirectory, `../.git` is relative to the subdirectory). Throws `not_a_repo`.
 */
function gitDirPath(repo, args) {
  const abs = revParse(repo, ['--path-format=absolute', ...args]);
  if (abs && isAbsolute(abs)) return abs;
  const raw = revParse(repo, args);
  if (raw === null || raw === '') throw coded('not_a_repo', `${repo} is not inside a git work tree`);
  return isAbsolute(raw) ? raw : resolve(repo, raw);
}

/** Whether two directories are the same (realpath: case and symlinks on Windows and macOS; the resolved path when absent). */
export function samePath(a, b) {
  const canon = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  return canon(a) === canon(b);
}

/** The shared run-log directory of the repository containing `repo` (absolute; it may not exist yet). */
export function commonLogDir(repo) {
  return join(gitDirPath(repo, ['--git-common-dir']), LOG_SUBDIR);
}

/**
 * Whether `repo`'s own gitdir IS the common dir (the main checkout, where `--git-path ai-skills/ship-ticket` names the shared
 * log). Compared on the two git directories, which always exist, so realpath decides (case and symlinks). Throws `not_a_repo`.
 */
export function ownDirIsShared(repo) {
  return samePath(gitDirPath(repo, ['--git-dir']), gitDirPath(repo, ['--git-common-dir']));
}

/** The pre-S5 location for `repo`: `git rev-parse --git-path ai-skills/ship-ticket`, absolute. */
export function ownLogDir(repo) {
  return gitDirPath(repo, ['--git-path', 'ai-skills/ship-ticket']);
}

/**
 * This worktree's pre-S5 directory: `own`, or null when it is the common dir (the main checkout). No other worktree's
 * directory is ever resolved (cutover: no sibling dependency).
 */
export function legacyLogDirs(repo) {
  const ownRaw = ownLogDir(repo);
  return { own: samePath(ownRaw, commonLogDir(repo)) ? null : ownRaw };
}

/** Lines counted by `legacyPresent` at most from the first MiB of a legacy log. */
export const LEGACY_PRESENT_BYTES = 1024 * 1024;
/** The most bytes the explicit audit and `abandon`'s membership scan read from one archive (the shared log's own cap). */
export const LEGACY_READ_MAX = 64 * 1024 * 1024;
/**
 * THE safe read of an archive file `<dir>/<ticket>.jsonl` (cutover), shared by `legacyPresent`, `run-log.mjs legacy` and
 * `abandon`: lstat first; only a REGULAR file is opened (never a symlink, directory, FIFO or socket), with O_NOFOLLOW and
 * O_NONBLOCK; at most `limit` bytes are read. Returns `{ status: 'absent' }` (ENOENT), `{ status: 'unavailable', path,
 * errno }` (`not_regular` or any other error: never an empty result), or `{ status: 'present', path, size, bytes,
 * truncated }`.
 */
export function readArchive(dir, ticket, limit) {
  const path = join(dir, `${ticket}.jsonl`);
  let st;
  try { st = lstatSync(path); } catch (e) { return e?.code === 'ENOENT' ? { status: 'absent' } : { status: 'unavailable', path, errno: e?.code ?? String(e) }; }
  if (!st.isFile()) return { status: 'unavailable', path, errno: 'not_regular' };
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const buf = Buffer.alloc(Math.min(limit, st.size));
    const n = buf.length ? readSync(fd, buf, 0, buf.length, 0) : 0;
    return { status: 'present', path, size: st.size, bytes: buf.subarray(0, n), truncated: st.size > limit };
  } catch (e) { return { status: 'unavailable', path, errno: e?.code ?? String(e) }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/**
 * `legacy_present` (cutover): whether this worktree's `<dir>/<ticket>.jsonl` exists, counted through `readArchive` with a
 * 1 MiB bound (newlines counted, nothing parsed). `{ files: 0 }` only for ENOENT; anything else that is not a readable
 * regular file is `{ files: 1, lines: 'unavailable', errno }`. Readers report it; it never feeds a figure.
 */
export function legacyPresent(dir, ticket) {
  const r = readArchive(dir, ticket, LEGACY_PRESENT_BYTES);
  if (r.status === 'absent') return { files: 0 };
  if (r.status === 'unavailable') return { files: 1, path: r.path, lines: 'unavailable', errno: r.errno };
  let lines = 0;
  for (const b of r.bytes) if (b === 0x0a) lines += 1;
  return { files: 1, path: r.path, lines, ...(r.truncated ? { truncated: true } : {}) };
}
/**
 * The timing-log tickets of one archive dir (not engine, usage or authority files). `{ tickets }`, or `{ errno }` when the
 * directory cannot be listed for any reason other than ENOENT (never an empty listing in its place).
 */
export function archiveTickets(dir) {
  let names;
  try { names = readdirSync(dir); } catch (e) { return e?.code === 'ENOENT' ? { tickets: [] } : { tickets: [], errno: e?.code ?? String(e) }; }
  return { tickets: names.filter((n) => n.endsWith('.jsonl') && !/\.(engine|usage|review-auth)\.jsonl$/.test(n) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(n.slice(0, -6))).map((n) => n.slice(0, -6)).sort() };
}

/** Reserved by `abandon` (AC15): no other writer may use this name or an event id with this prefix (case-insensitive). */
export const ABANDON_NAME = 'legacy_abandoned';
export const ABANDON_ID_PREFIX = 'legacy-abandoned';
export function isReservedInterval(name, eventId) {
  return String(name).toLowerCase() === ABANDON_NAME || String(eventId).toLowerCase().startsWith(ABANDON_ID_PREFIX);
}
/** The validated abandon record (exactly what `abandon` writes); a look-alike is ordinary history. */
const isAbandonRow = (r) => r?.kind === 'activity' && r.name === ABANDON_NAME && /^legacy-abandoned\.[0-9a-f]{12}$/.test(r.event_id ?? '')
  && r.metrics?.legacy_run === true && (r.event === 'start' || (r.event === 'end' && r.outcome === 'abandoned'));
/**
 * The one labelling rule every reader applies to a run (summary, eval, the integrity line): an `abandon` record makes the
 * run's outcome `abandoned` (the recorded workflow outcome is kept as `recorded_outcome`): never 'complete', so no reader
 * counts it as completed or accepted. A run with any row marked `legacy_worktree: true` gets `partial_legacy: 'possible'`:
 * part of it may live in a pre-S5 archive that no figure includes.
 */
export function labelLegacyRun(run, rows) {
  const abandoned = rows.some((r) => r.event === 'end' && isAbandonRow(r));
  const partial = rows.some((r) => r?.metrics?.legacy_worktree === true);
  if (!abandoned && !partial) return run;
  return { ...run, ...(abandoned ? { outcome: 'abandoned', recorded_outcome: run.outcome, abandoned: true } : {}), ...(partial ? { partial_legacy: 'possible' } : {}) };
}

const fsKind = (p) => {
  let l;
  try { l = lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return 'absent'; throw e; }
  if (!l.isSymbolicLink()) return l.isDirectory() ? 'dir' : 'file';
  try { return statSync(p).isDirectory() ? 'dir' : 'file'; } catch (e) { if (e?.code === 'ENOENT') return 'dangling'; throw e; }
};
const fsAccess = (p, mode, what) => { try { accessSync(p, mode); return null; } catch { return `${p} is not writable (${what})`; } };
/** `mkdir -p dir` plus creating files in it: the nearest existing ancestor (or `dir`) is a directory, writable and searchable;
 *  an existing `dir` is also readable (the append opens it to fsync a newly created file). */
export function dirPreflight(dir) {
  let probe = dir;
  try {
    for (;;) {
      const k = fsKind(probe);
      if (k === 'dangling') return `${probe} is a dangling symbolic link (mkdir would fail)`;
      if (k === 'file') return `${probe} is not a directory (mkdir would fail)`;
      if (k === 'dir') break;
      const up = dirname(probe);
      if (up === probe) return `${probe} has no existing parent directory`;
      probe = up;
    }
    // An existing target directory is also opened for reading (the directory fsync after a file is created there, POSIX).
    const read = probe === dir && process.platform !== 'win32' ? fsConstants.R_OK : 0;
    return fsAccess(probe, fsConstants.W_OK | fsConstants.X_OK | read, probe === dir ? 'files and their .lock are created there, and it is opened for fsync' : 'the directory is created there');
  } catch (e) { return `${probe}: ${e?.code ?? e}`; }
}
export function appendPreflight(file) {
  const dirProblem = dirPreflight(dirname(file));
  if (dirProblem) return dirProblem;
  try {
    const f = fsKind(file);
    if (f === 'dangling') return `${file} is a dangling symbolic link`;
    if (f === 'dir') return `${file} is a directory, not a log file`;
    if (f === 'file') return fsAccess(file, fsConstants.W_OK, 'it is opened for append');
    return null;
  } catch (e) { return `${file}: ${e?.code ?? e}`; }
}
