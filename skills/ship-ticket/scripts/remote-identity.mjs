/**
 * S-12 (ASTF-6): the remote a pinned base is read from, and which repository it names. Node built-ins only.
 *
 * Provenance (ported, trimmed): repositoryOf and sameRepository from commit a890b0d skills/ship-ticket/scripts/engine-ci.mjs
 * (lines 283-294), configAll, remoteIdentity and resolveBaseRef from a890b0d skills/ship-ticket/scripts/engine-identity.mjs
 * (lines 50-87 and 112-118), unchanged in behaviour. Left out on purpose: the release-identity tuple (publicationOf,
 * verifyReleaseBinding, identityRecord), which is S-28a's, and resolveTool/pinnedTool, which wait for their first consumer
 * (S-28a, S-15). This module lives beside the engine, not in lib/: lib/ holds the hardened git runner and its directory scans.
 */
import { spawnSync } from 'node:child_process';
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
  if (!id) return { ok: true, identity: null };
  const push = pushes.values[0] ?? null;
  if (push !== null && !sameRepository(repositoryOf(push), id))
    return no('remote_ambiguous', `remote ${given} fetches from ${id.slug} but pushes to ${repositoryOf(push)?.slug ?? push}: a push URL of another repository; ${fix}`);
  return { ok: true, identity: { remote_name: given, url, ...id } };
}

/**
 * The base ref of record: config.base when it names a branch, else the remote's default branch as the REMOTE names it
 * (`git ls-remote --symref <remote> HEAD`, read once here; never refs/remotes/<remote>/HEAD). -> { ok, ref } | refusal
 */
export function resolveBaseRef(S, repoRoot, remote) {
  if (S?.config?.base && S.config.base !== 'HEAD') return { ok: true, ref: S.config.base };
  const r = authGit(repoRoot, ['ls-remote', '--symref', remote, 'HEAD']);
  if (r.status !== 0) return no('base_remote_unavailable', `git ls-remote --symref ${remote} HEAD failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}): the default branch cannot be resolved`);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(r.stdout);
  return m ? { ok: true, ref: m[1] } : no('base_remote_unavailable', `remote ${remote} names no default branch (ls-remote --symref HEAD): bind config.base`);
}
