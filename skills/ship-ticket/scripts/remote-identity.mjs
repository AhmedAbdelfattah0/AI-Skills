/**
 * S-12 (ASTF-6): the remote a pinned base is read from, and which repository it names. Node built-ins only.
 *
 * Provenance (ported, trimmed): repositoryOf and sameRepository from commit a890b0d skills/ship-ticket/scripts/engine-ci.mjs
 * (lines 283-294), configAll, remoteIdentity and resolveBaseRef from a890b0d skills/ship-ticket/scripts/engine-identity.mjs
 * (lines 50-87 and 112-118). Changed by S-12 Round 1: a push URL is checked whatever the fetch URL is, remoteUrl is new, and
 * resolveBaseRef ends its options with `--` (it is given a URL). Callers run all of it under engine-base-read.mjs underHardenedGit. Left out on purpose: the release-identity tuple (publicationOf,
 * verifyReleaseBinding, identityRecord), which is S-28a's. S-28b b0 adds resolveTool and pinnedTool (from a890b0d engine-ci.mjs 253-282; hardened in PR #121 Round 1, see their comments). This module lives beside the engine, not in lib/: lib/ holds the hardened git runner and its directory scans.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';
import { authGit } from './engine-base.mjs';

const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const no = (code, reason) => ({ ok: false, code, reasons: [reason] });

/**
 * The GitHub repository a remote URL names: { host, owner, repo, slug: 'host/owner/repo' } or null (a local path, a URL with
 * no owner/repo). https://host/owner/repo(.git), ssh://[user@]host[:port]/owner/repo(.git) and [user@]host:owner/repo(.git).
 */
export function repositoryOf(url) {
  const u = String(url ?? '').trim();
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u)
    ?? /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  if (!m || /^[A-Za-z]$/.test(m[1])) return null; // C:\path is a Windows path, not host C
  const [host, owner, repo] = [m[1].toLowerCase(), m[2], m[3]];
  if (![owner, repo].every(x => /^[A-Za-z0-9_.-]+$/.test(x))) return null;
  return { host, owner, repo, slug: `${host}/${owner}/${repo}` };
}

/** Whether two repository identities are the same repository (GitHub names are case-insensitive). */
export const sameRepository = (a, b) => Boolean(a?.slug && b?.slug) && a.slug.toLowerCase() === b.slug.toLowerCase();

/** EVERY configured value of `key` (all scopes): { ok: true, values } ([] when unset, git exit 1) | { ok: false, reason } (any other failure). */
function configAll(repoRoot, key) {
  const r = spawnSync('git', ['config', '--get-all', key], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  if (r.status === 1 && !r.error) return { ok: true, values: [] };
  if (r.status !== 0 || r.error) return { ok: false, reason: `git config --get-all ${key} failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()})` };
  return { ok: true, values: r.stdout.split('\n').map(s => s.trim()).filter(Boolean) };
}

/**
 * THE reader of a remote's repository identity. A remote NAME must be unambiguous: exactly one configured remote.<name>.url
 * (git fetch and ls-remote use the FIRST of several, git push uses ALL of them) and at most one remote.<name>.pushurl (git push
 * uses ALL push URLs), naming the same repository as the URL. Several fetch URLs, several push URLs, or a push URL of another
 * repository are `remote_ambiguous`: the engine never selects one of several conflicting values. Read from the CONFIGURED values
 * (before any insteadOf rewrite: a documented residual). A URL is parsed as given.
 * -> { ok: true, identity: { remote_name, url, host, owner, repo, slug } | null (no GitHub repository) } | { ok: false, code: 'remote_ambiguous', reasons }
 */
export function remoteIdentity(repoRoot, remote = 'origin') {
  const given = String(remote ?? '');
  if (!SAFE_REMOTE.test(given)) { const id = repositoryOf(given); return { ok: true, identity: id ? { remote_name: null, url: given, ...id } : null }; }
  const urls = configAll(repoRoot, `remote.${given}.url`), pushes = configAll(repoRoot, `remote.${given}.pushurl`);
  for (const r of [urls, pushes]) if (!r.ok) return no('remote_ambiguous', `${r.reason}: the remote ${given} cannot be read unambiguously`);
  const fix = 'configure exactly one URL (and at most one push URL, of the same repository) for the remote, or start a new run';
  if (urls.values.length > 1) return no('remote_ambiguous', `remote ${given} has ${urls.values.length} fetch URLs (${urls.values.join(', ')}): git fetches from the first and pushes to all; ${fix}`);
  if (pushes.values.length > 1) return no('remote_ambiguous', `remote ${given} has ${pushes.values.length} push URLs (${pushes.values.join(', ')}): git pushes to all of them; ${fix}`);
  const url = urls.values[0] ?? null;
  const id = repositoryOf(url);
  const push = pushes.values[0] ?? null;
  // S-12 Round 1: a push URL is compared even when the fetch URL names no GitHub repository (a local path, file://, another host):
  // the same literal URL or the same repository, else remote_ambiguous
  if (push !== null && push !== url && !(id && sameRepository(repositoryOf(push), id)))
    return no('remote_ambiguous', `remote ${given} fetches from ${id?.slug ?? url} but pushes to ${repositoryOf(push)?.slug ?? push}: a push URL of another repository; ${fix}`);
  if (!id) return { ok: true, identity: null };
  return { ok: true, identity: { remote_name: given, url, ...id } };
}

/**
 * S-12 Round 1: the ONE configured URL of remote `name`, which every ls-remote of a pinned run is given (never the bare name: git
 * reads a name with no URL as a local path, e.g. an in-tree directory or worktree called `origin`). base_unverified when no URL
 * is configured or it could be read as an option; remote_ambiguous when several are.
 */
export function remoteUrl(repoRoot, name) {
  const urls = configAll(repoRoot, `remote.${name}.url`);
  if (!urls.ok) return no('remote_ambiguous', `${urls.reason}: the remote ${name} cannot be read unambiguously`);
  if (urls.values.length === 0) return no('base_unverified', `remote ${name} has no configured URL: git would read "${name}" as a local path; configure remote.${name}.url`);
  if (urls.values.length > 1) return no('remote_ambiguous', `remote ${name} has ${urls.values.length} fetch URLs (${urls.values.join(', ')})`);
  if (urls.values[0].startsWith('-')) return no('base_unverified', `remote ${name} has a URL that git would read as an option: ${urls.values[0]}`);
  return { ok: true, url: urls.values[0] };
}

/**
 * The base ref of record: config.base when it names a branch, else the remote's default branch as the REMOTE names it
 * (`git ls-remote --symref <remote> HEAD`, read once here; never refs/remotes/<remote>/HEAD). -> { ok, ref } | refusal
 */
export function resolveBaseRef(S, repoRoot, remote) {
  if (S?.config?.base && S.config.base !== 'HEAD') return { ok: true, ref: S.config.base };
  const r = authGit(repoRoot, ['ls-remote', '--symref', '--', remote, 'HEAD']);
  if (r.status !== 0) return no('base_remote_unavailable', `git ls-remote --symref ${remote} HEAD failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}): the default branch cannot be resolved`);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(r.stdout);
  return m ? { ok: true, ref: m[1] } : no('base_remote_unavailable', `remote ${remote} names no default branch (ls-remote --symref HEAD): bind config.base`);
}

const PIN_DIGEST = /^sha256:[0-9a-f]{64}$/;
const sha256Of = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/**
 * The bytes of `path` iff it is a regular file, read through ONE descriptor opened without following a symlink and without
 * blocking (a FIFO is refused by fstat, never read): { ok: true, bytes } | { ok: false, kind: 'missing' | 'symlink' |
 * 'not_regular' | 'unreadable', detail }. O_NOFOLLOW/O_NONBLOCK are 0 where the platform lacks them (Windows).
 */
function readRegular(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { ok: false, kind: 'missing', detail: e.code };
    if (e.code === 'ELOOP' || e.code === 'EMLINK') return { ok: false, kind: 'symlink', detail: e.code };
    if (e.code === 'EISDIR') return { ok: false, kind: 'not_regular', detail: e.code };
    return { ok: false, kind: 'unreadable', detail: e.code ?? String(e) };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, kind: 'not_regular', detail: 'fstat' };
    return { ok: true, bytes: readFileSync(fd) };
  } catch (e) { return { ok: false, kind: 'unreadable', detail: e.code ?? String(e) }; } finally { closeSync(fd); }
}

/**
 * The candidate paths for `name` on `env`'s PATH, in order, for `platform` (pure; exported for the Windows-branch test). Only
 * ABSOLUTE PATH entries are used: a relative entry (or an empty one, which a shell reads as the cwd) would resolve against
 * whatever directory the caller runs in. win32 tries `<name>.exe` then `<name>.cmd` in each entry and never the bare name,
 * which Windows cannot execute; POSIX tries the bare name.
 */
export function toolCandidates(name, env = process.env, platform = process.platform) {
  const P = platform === 'win32' ? win32 : posix;
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  return String(env.PATH ?? env.Path ?? '').split(P.delimiter).filter(d => d && P.isAbsolute(d)).flatMap(d => names.map(n => P.join(d, n)));
}

/**
 * R0-S N4 (from a890b0d engine-ci.mjs:253-282, S-28b b0): the realpath and sha256 of the first EXECUTABLE `name` on PATH, or
 * null. `enroll` (S-28b b1) pins `gh` this way and later runs exactly that file: a stub put earlier on PATH changes nothing.
 * Round 1 hardening: `name` must be a plain file name (no path separator, not '.'/'..', no NUL: a TypeError otherwise, a caller
 * bug); relative PATH entries are never used; on POSIX the file must be executable by this process (X_OK) and a regular file;
 * the hashed bytes are read from the realpath through readRegular.
 * Residuals (UNCLOSED): the resolution trusts PATH at pin time; and between this hash (or pinnedTool's) and the later exec the
 * file can be swapped (hash-to-exec TOCTOU), since the caller execs by path, not by the verified descriptor.
 */
export function resolveTool(name, env = process.env, platform = process.platform) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new TypeError(`resolveTool: ${JSON.stringify(name)} is not a plain tool name`);
  for (const p of toolCandidates(name, env, platform)) {
    try {
      if (platform !== 'win32') accessSync(p, constants.X_OK);
      const real = realpathSync(p);
      const r = readRegular(real);
      if (r.ok) return { path: real, sha256: sha256Of(r.bytes) };
    } catch { /* not here, or not executable */ }
  }
  return null;
}

/**
 * The pinned tool, verified: { ok: true, path } | { ok: false, code, reason }. Codes: `<name>_unpinned` (no pin: null or
 * undefined), `<name>_pin_invalid` (anything else that is not { path: string absolute on THIS platform, without NUL, sha256: 'sha256:<64 hex>' }),
 * `<name>_drift` (the path is now missing, a symlink, not a regular file, or has other bytes) and `<name>_unreadable` (it exists
 * but cannot be read). A failed read is never compared with the digest (Round 1 MAJOR B: a null digest matched a failed read).
 */
export function pinnedTool(pin, name = 'gh') {
  if (pin === null || pin === undefined) return { ok: false, code: `${name}_unpinned`, reason: `no ${name} was pinned at enroll (none on PATH then): start a new run with ${name} installed` };
  const shapeOk = typeof pin === 'object' && !Array.isArray(pin) && typeof pin.path === 'string' && pin.path.length > 0 && !pin.path.includes('\0')
    && isAbsolute(pin.path) && typeof pin.sha256 === 'string' && PIN_DIGEST.test(pin.sha256);
  if (!shapeOk) return { ok: false, code: `${name}_pin_invalid`, reason: `the ${name} pin is malformed (want { path: <absolute path>, sha256: 'sha256:<64 hex>' }): start a new run` };
  const r = readRegular(pin.path);
  if (!r.ok) {
    if (r.kind === 'unreadable') return { ok: false, code: `${name}_unreadable`, reason: `${pin.path}, the ${name} this run pinned at enroll, cannot be read (${r.detail}): fix its permissions or start a new run` };
    const now = { missing: 'missing', symlink: 'a symbolic link', not_regular: 'not a regular file' }[r.kind];
    return { ok: false, code: `${name}_drift`, reason: `${pin.path} is not the ${name} this run pinned at enroll (${pin.sha256}, now ${now}): restore it or start a new run` };
  }
  const digest = sha256Of(r.bytes);
  if (digest !== pin.sha256) return { ok: false, code: `${name}_drift`, reason: `${pin.path} is not the ${name} this run pinned at enroll (${pin.sha256}, now ${digest}): restore it or start a new run` };
  return { ok: true, path: pin.path };
}
