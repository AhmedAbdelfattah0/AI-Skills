// S-02a0a: resolve the git binary to an absolute path, parse its version, and enforce the floors.
// Design: .claude/factory-assessment/consolidation-2026-11/S-02-design.md §2.1. Custom code; nothing
// is copied from upstream here. Node 18 compatible, synchronous, no dependency.
// Fails closed by design: a cwd of `/` (or any cwd above every PATH dir) bans every candidate and
// yields git_unavailable. The fourth T6 row (grafts refused) needs a handle and lands with S-02a0c.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// Pinned per mechanism from the Git 2.55.0 docs (Documentation/RelNotes/*.adoc, Documentation/git.adoc).
// `--end-of-options` is per parser: parse-options commands 2.24.0, rev-parse 2.30.0. The combined
// `--end-of-options <rev> -- <path>` form was broken for some commands until 2.43.1 and is NOT relied
// on at the 2.32 floor: S-02a0c must not combine them in one op, or must raise that op's floor.
export const GIT_FLOOR = Object.freeze([2, 32, 0]);
export const PARTIAL_CLONE_FLOOR = Object.freeze([2, 45, 0]);
export const CAPABILITIES = Object.freeze([
  { id: '--end-of-options (parse-options commands)', since: '2.24.0', evidence: 'RelNotes/2.24.0.adoc:18', enforcement: 'floor' },
  { id: 'rev-parse --end-of-options', since: '2.30.0', evidence: 'RelNotes/2.30.0.adoc:74-76', enforcement: 'floor' },
  { id: '--end-of-options <rev> -- <path>', since: '2.43.1', evidence: 'RelNotes/2.43.1.adoc:40-42 (fixed for many, not all, commands)', enforcement: 'not-relied-on below 2.43.1: S-02a0c must not combine, or must raise that op floor' },
  { id: 'GIT_CONFIG_COUNT/KEY/VALUE', since: '2.31.0', evidence: 'RelNotes/2.31.0.adoc:127-130; git-config.adoc:484', enforcement: 'floor' },
  { id: 'rev-parse --path-format=absolute', since: '2.31.0', evidence: 'RelNotes/2.31.0.adoc:39', enforcement: 'floor' },
  { id: 'GIT_CONFIG_GLOBAL', since: '2.32.0', evidence: 'RelNotes/2.32.0.adoc:92', enforcement: 'floor' },
  { id: '--no-lazy-fetch', since: '2.45.0', evidence: 'RelNotes/2.45.0.adoc:120; git.adoc:187,949', enforcement: 'partial-clone-floor' },
  { id: 'GIT_GRAFT_FILE', since: null, evidence: 'absent from git.adoc', enforcement: 'not-relied-on: grafts are refused' },
].map(Object.freeze));

/** The message is the code only: never stdout, PATH contents or paths. */
export class GitCapabilityError extends Error {
  constructor(code) { super(code); this.name = 'GitCapabilityError'; this.code = code; }
  toJSON() { return { code: this.code }; }
}

const realFs = {
  realpath(p) { try { return realpathSync.native(p); } catch { return null; } },
  isExecutableFile(p, platform) {
    try {
      if (!statSync(p).isFile()) return false;
      if (platform !== 'win32') accessSync(p, constants.X_OK);
      return true;
    } catch { return false; }
  },
};

function inside(child, parent, P) {
  const rel = P.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel));
}

/**
 * First `git` (POSIX) or `git.exe` (Windows; never .cmd/.bat/.com shims) on PATH, as a realpath.
 * Empty, relative and drive-relative PATH entries are skipped (they search the cwd), and so is any
 * candidate whose PATH spelling or realpath lies in the cwd or an excluded dir (the candidate tree).
 */
export function resolveGitBinary({ env = process.env, cwd = process.cwd(), exclude = [], platform = process.platform, fs = realFs } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const absolute = win ? (d) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(d) : (d) => d.startsWith('/');
  // A relative cwd/exclude would be resolved against process.cwd(), silently banning the wrong dir.
  if (![cwd, ...exclude].every((d) => typeof d === 'string' && absolute(d))) throw new GitCapabilityError('git_resolver_bad_arg');
  const pathVar = win ? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] : env.PATH;
  const banned = [cwd, ...exclude].flatMap((d) => [P.resolve(d), fs.realpath(d)]).filter(Boolean);
  for (const raw of String(pathVar ?? '').split(win ? ';' : ':')) {
    const dir = win ? raw.replace(/^"(.*)"$/, '$1') : raw;
    if (!dir || !absolute(dir)) continue;
    const file = P.join(dir, win ? 'git.exe' : 'git');
    const real = fs.realpath(file);
    if (!real || [file, real].some((f) => banned.some((b) => inside(f, b, P)))) continue;
    if (fs.isExecutableFile(real, platform)) return real;
  }
  throw new GitCapabilityError('git_unavailable');
}

// Whole output, one line, printable ASCII only. Build suffixes (.windows.1, (Apple Git-154)) are
// accepted; an rc suffix marks a pre-release, which counts as below its own X.Y.Z (fail closed).
const VERSION = /^git version (\d{1,5})\.(\d{1,5})\.(\d{1,5})((?:[.-][0-9A-Za-z]+)*)(?: \([\x20-\x27\x2a-\x7e]*\))?\r?\n?$/;

export function parseGitVersion(out) {
  const bytes = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');
  // latin1 maps each byte to one code point, so any non-ASCII byte fails the ASCII-only pattern.
  // No text decoder here: S-02a0b's decodeStrict is the lib's only one.
  const m = VERSION.exec(bytes.toString('latin1'));
  if (!m) throw new GitCapabilityError('git_version_unparseable');
  const prerelease = m[4].split(/[.-]/).some((t) => /^rc\d*$/i.test(t));
  return Object.freeze({ raw: m[0].trimEnd(), version: [+m[1], +m[2], +m[3]], prerelease });
}

export function atLeast({ version, prerelease }, floor) {
  for (let i = 0; i < 3; i++) if (version[i] !== floor[i]) return version[i] > floor[i];
  return !prerelease;
}

/** General floor always; the partial-clone floor when the caller saw a promisor/partial clone. */
export function assertGitCapable(info, { partialClone = false } = {}) {
  if (!atLeast(info, GIT_FLOOR)) throw new GitCapabilityError('git_version_below_floor');
  if (partialClone && !atLeast(info, PARTIAL_CLONE_FLOOR)) throw new GitCapabilityError('partial_clone_unsupported');
  return info;
}

/**
 * Resolve, run `<abs git> --version` with every GIT_* removed, parse, enforce the general floor.
 * SIGKILL on timeout: a binary that ignores SIGTERM cannot hold the synchronous caller. This bounds
 * the direct child only; a descendant holding the pipes stays design R-A2 (UNVERIFIED).
 */
export function probeGit(opts = {}) {
  const bin = resolveGitBinary(opts);
  const env = { ...(opts.env ?? process.env) };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('GIT_')) delete env[k];
  env.LC_ALL = 'C';
  const r = spawnSync(bin, ['--version'], { env, cwd: path.dirname(bin), shell: false, windowsHide: true, timeout: opts.timeoutMs ?? 10_000, killSignal: 'SIGKILL', maxBuffer: 4096 });
  const launch = { ENOENT: 'git_unavailable', EACCES: 'git_unavailable', ETIMEDOUT: 'git_timeout', ENOBUFS: 'git_output_truncated' };
  if (r.error) throw new GitCapabilityError(launch[r.error.code] ?? 'git_launch_failed');
  if (r.signal) throw new GitCapabilityError('git_signal');
  if (r.status !== 0) throw new GitCapabilityError('git_failed');
  const parsed = parseGitVersion(r.stdout);
  return assertGitCapable(Object.freeze({ path: bin, ...parsed, noLazyFetch: atLeast(parsed, PARTIAL_CLONE_FLOOR) }));
}
