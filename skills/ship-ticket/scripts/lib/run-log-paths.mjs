/**
 * Where ship-ticket run logs (`<ticket>.jsonl`) live (S5, F05). Dependency-free ESM: node built-ins only.
 *
 * One place per repository: `<git-common-dir>/ai-skills/ship-ticket/`, shared by the main checkout and every linked
 * worktree, so a run whose phases are logged from two worktrees is one file and no event is split or lost.
 * Before S5 the log lived at `git rev-parse --git-path ai-skills/ship-ticket`, which in a linked worktree is the
 * per-worktree gitdir (`<common>/worktrees/<name>/ai-skills/ship-ticket`). Those old files are LEGACY: read, never
 * written, moved, copied or deleted. In the main checkout the old path IS the common dir.
 *
 * Readers choose their scope:
 * - writers (run-log start/end/event, carrier REPAIR authorisation): common, then the OWN legacy dir;
 * - reporting (run-log summary): additionally every sibling worktree's legacy dir, never used for an
 *   authorisation decision.
 *
 * Engine files (.state.json, .engine.jsonl, .usage.jsonl, .attempts) are not run logs and stay per-worktree.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const LOG_SUBDIR = join('ai-skills', 'ship-ticket');
/** Per-worktree subdirectory of REVIEW authority records (`<git-path>/ai-skills/ship-ticket/review-auth/<ticket>.jsonl`). No
 *  ticket name can address it: a ticket id has no `/`, so every shared write is a FILE directly in the log directory. */
export const AUTH_SUBDIR = 'review-auth';
/** Per-worktree subdirectory recording legacy rows excluded by `migrate --resolve-duplicates` (verbatim copies). */
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
 * Legacy (read-only) directories. `own`: this worktree's old directory, or null when it is the common dir (the main
 * checkout). `siblings`, only with `{ siblings: true }` (reporting only): every other linked worktree's old directory
 * that exists, sorted, found by listing `<common>/worktrees/*` read-only.
 */
export function legacyLogDirs(repo, { siblings = false } = {}) {
  const common = commonLogDir(repo);
  const ownRaw = ownLogDir(repo);
  const own = samePath(ownRaw, common) ? null : ownRaw;
  if (!siblings) return { own, siblings: [] };
  const worktrees = join(gitDirPath(repo, ['--git-common-dir']), 'worktrees');
  let names = [];
  try { names = readdirSync(worktrees).sort(); } catch { /* no linked worktree */ }
  const found = names.map((n) => join(worktrees, n, LOG_SUBDIR))
    .filter((d) => existsSync(d) && !samePath(d, common) && !(own && samePath(d, own)));
  return { own, siblings: found };
}

/** The directories a writer (and an authorisation) reads, in order: common, then the own legacy dir when separate. */
export function writerLogDirs(repo) {
  const { own } = legacyLogDirs(repo);
  return [commonLogDir(repo), ...(own ? [own] : [])];
}

/** The directories a report reads: the writer's, then every sibling worktree's legacy dir. */
export function reportLogDirs(repo) {
  const { own, siblings } = legacyLogDirs(repo, { siblings: true });
  return [commonLogDir(repo), ...(own ? [own] : []), ...siblings];
}

/**
 * The `<ticket>.jsonl` of each directory that has one, in the order given, parsed by the caller's
 * `parse(bytes, path)` (run-log's rowsFromText, measure/events readEvents, ...): this module never interprets a row.
 * Returns `[{ dir, path, bytes, parsed }]`; a directory listed twice is read once.
 */
export function readLogRows(dirs, ticket, parse = (bytes) => bytes) {
  const out = [];
  for (const dir of dirs) {
    if (!dir || out.some((s) => samePath(s.dir, dir))) continue;
    const path = join(dir, `${ticket}.jsonl`);
    let bytes;
    try { bytes = readFileSync(path); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    out.push({ dir, path, bytes, parsed: parse(bytes, path) });
  }
  return out;
}

/**
 * THE join of one ticket's run-log rows over several files (S5 repairs 3-4). run-log (summary, check, the writers, migrate,
 * the integrity line) and eval.mjs all call it, so every reader sees the same rows.
 *
 * ACCOUNTING RULE (repair 4). Rows are compared by their JSON text (a verbatim copy is the same text). For each distinct row
 * text, let C = its occurrences in the common (shared) log and L = its occurrences over ALL legacy sources together (after
 * each source's recorded exclusions). The join holds max(C, L) occurrences: every common occurrence, and each common copy
 * excuses exactly ONE legacy occurrence (the migrated one); every further occurrence is a genuine duplicate and stays, so
 * buildRun reports it (duplicate_start, invalid_pair) in every reader. The shared log does not record which worktree
 * migrated a copy (recording it would make a shared row an authority-like claim), so the excused occurrence is counted, not
 * named; the counts are the same whichever it is. The result is a pure function of the multiset of (source, row) pairs:
 * independent of the order of the sources and of which worktree reads. With rows from more than one source the rows are
 * ordered by (timestamp, start before end, row text); a single source keeps its file order (pre-S5 behaviour).
 *
 * EXCLUSIONS (repair 4). `excludedRows(dir, ticket)` returns `{ rows, problem }`. Only ENOENT means "no exclusions"; every
 * other read error (EACCES, EISDIR, ...) and every unparsable line is a `problem` ({ code: 'excluded_unreadable', path,
 * errno | line }), never an empty set. Readers report it as a degradation; writers refuse.
 */
const keyOf = (row) => JSON.stringify(row);
export function excludedRows(dir, ticket) {
  const path = join(dir, EXCLUDED_SUBDIR, `${ticket}.jsonl`);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' ? { rows: [] } : { rows: [], problem: { code: 'excluded_unreadable', path, errno: e?.code ?? String(e) } }; }
  const rows = [];
  const lines = text.split('\n');
  const torn = lines.pop(); // '' when the text ends with a newline
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return { rows, problem: { code: 'excluded_unreadable', path, line: i + 1, errno: 'invalid_json' } }; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { rows, problem: { code: 'excluded_unreadable', path, line: i + 1, errno: 'not_a_row' } };
    rows.push(row);
  }
  if (torn) return { rows, problem: { code: 'excluded_unreadable', path, line: lines.length + 1, errno: 'incomplete_tail' } };
  return { rows };
}
export function subtractRows(rows, minus) {
  if (!minus.length) return rows;
  const debt = new Map();
  for (const row of minus) debt.set(keyOf(row), (debt.get(keyOf(row)) ?? 0) + 1);
  return rows.filter((row) => { const n = debt.get(keyOf(row)) ?? 0; if (n > 0) { debt.set(keyOf(row), n - 1); return false; } return true; });
}
const EVENT_ORDER = { start: 0, end: 1 };
/** The accounting rule: the common rows, plus the legacy rows beyond what the common copies excuse (see above). */
export function joinRows(commonRows, legacyLists) {
  const sources = [commonRows, ...legacyLists].filter((l) => l.length);
  if (sources.length <= 1) return sources[0] ?? [];
  const excuse = new Map();
  for (const row of commonRows) excuse.set(keyOf(row), (excuse.get(keyOf(row)) ?? 0) + 1);
  const legacy = [];
  for (const list of legacyLists) for (const row of list) {
    const n = excuse.get(keyOf(row)) ?? 0;
    if (n > 0) excuse.set(keyOf(row), n - 1); else legacy.push(row);
  }
  return [...legacy, ...commonRows].map((row) => [row, keyOf(row)]).sort(([a, ka], [b, kb]) => {
    const t = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    if (t) return t;
    const e = (EVENT_ORDER[a.event] ?? 2) - (EVENT_ORDER[b.event] ?? 2);
    return e || (ka < kb ? -1 : ka > kb ? 1 : 0);
  }).map(([row]) => row);
}
/**
 * `sources` = `[{ dir, rows }]`; the one whose dir is `commonDir` is the common log, every other is a legacy source that
 * loses its recorded exclusions. Returns `{ rows, problems }`; with a problem the rows of that source are joined WITHOUT
 * exclusions and the caller must report (reader) or refuse (writer): never a silent "no exclusions".
 */
export function unionLogRows(sources, ticket, commonDir) {
  const isCommon = (s) => commonDir !== undefined && samePath(s.dir, commonDir);
  const problems = [];
  const legacy = sources.filter((s) => !isCommon(s)).map((s) => {
    const { rows, problem } = excludedRows(s.dir, ticket);
    if (problem) problems.push(problem);
    return subtractRows(s.rows, rows);
  });
  const common = sources.filter(isCommon).flatMap((s) => s.rows);
  return { rows: joinRows(common, legacy), problems };
}

/**
 * The exact filesystem operations an append to `file` performs (appendRows: mkdir -p of its directory, `<file>.lock`
 * created in it, `<file>` opened for append), checked read-only. Shared by `check`, batch prevalidation and the REVIEW
 * authority copy itself. Returns null when every operation can succeed, else the reason.
 */
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
