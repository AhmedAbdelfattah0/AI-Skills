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
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const LOG_SUBDIR = join('ai-skills', 'ship-ticket');

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
