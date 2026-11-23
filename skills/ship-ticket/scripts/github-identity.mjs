/**
 * S-28a attempt 2 (ASTF-5): THE parser of a repoIdentity run's remote URLs, and the record every consumer receives. A leaf
 * module: it imports nothing, so engine-base-read.mjs (S-12) and engine-identity.mjs can both use it without a cycle.
 *
 * strictGithub accepts a repository URL on github.com and nothing else: `https://github.com/<o>/<r>`, `ssh://[user@]github.com/<o>/<r>`
 * and the scp form `[user@]github.com:<o>/<r>`, each with an optional `.git` and trailing `/`. The host is compared
 * case-insensitively; owner and repo come from the SAME parse. Refused: any port; any other host or lookalike; `http://` and
 * `git://` (plaintext); a user part in an https URL (`https://evil.invalid#@github.com/...` and `?@` forms reach another host);
 * an ssh/scp user outside [A-Za-z0-9._-] or starting with '-'; an owner or repo starting with '-', or `.`/`..`; whitespace or
 * any character outside the grammar. remote-identity.mjs repositoryOf, which flag-off runs use, is a different, looser parser
 * and is not used on the flag path.
 */
const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const FORMS = [
  { re: /^https:\/\/([^/@:?#\s\\%]+)\/([^?#\s\\%]+)$/, user: false },
  { re: /^ssh:\/\/(?:([^/@:?#\s\\%]+)@)?([^/@:?#\s\\%]+)\/([^?#\s\\%]+)$/, user: true },
  { re: /^(?:([^/@:?#\s\\%]+)@)?([^/@:?#\s\\%]+):([^?#\s\\%]+)$/, user: true, scp: true },
];

/** -> { owner, repo, slug: 'github.com/<owner>/<repo>' (lower-cased) } | null. */
export function strictGithub(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  for (const f of FORMS) {
    const m = f.re.exec(url);
    if (!m) continue;
    const [user, host, path] = f.user ? [m[1], m[2], m[3]] : [undefined, m[1], m[2]];
    if (f.scp && /^[a-z][a-z0-9+.-]*$/i.test(host) && path.startsWith('//')) return null; // a scheme, never an scp host
    if (host.toLowerCase() !== 'github.com') return null;
    if (user !== undefined && !USER.test(user)) return null;
    const parts = path.replace(/\/$/, '').split('/');
    if (parts.length !== 2) return null;
    const owner = parts[0], repo = parts[1].replace(/\.git$/, '');
    if (![owner, repo].every((x) => NAME.test(x) && x !== '.' && x !== '..')) return null;
    return { owner, repo, slug: `github.com/${owner}/${repo}`.toLowerCase() };
  }
  return null;
}

/**
 * The record a consumer receives: frozen { url, push, identity }, built only from values that parse strictly and name ONE
 * repository (the push URL, when configured, the same one). A consumer re-validates it (validIdentityRecord) and compares
 * its identity with the run's: no consumer reads a remote URL itself.
 */
export function identityRecord(url, push) {
  const a = strictGithub(url), b = push === null ? null : strictGithub(push);
  if (!a || (push !== null && (!b || b.slug !== a.slug))) return null;
  return Object.freeze({ url, push, identity: a.slug });
}

/** Whether `v` is exactly such a record (frozen, exact keys, re-parsed), naming `identity` when given. */
export function validIdentityRecord(v, identity) {
  return v !== null && typeof v === 'object' && Object.isFrozen(v) && Object.keys(v).sort().join() === 'identity,push,url'
    && strictGithub(v.url)?.slug === v.identity && (v.push === null || strictGithub(v.push)?.slug === v.identity)
    && (identity === undefined || v.identity === identity);
}
