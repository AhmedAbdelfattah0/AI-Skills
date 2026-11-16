/**
 * Verified base commit (R0-S repair round 3, defect N-BASE). Node built-ins only.
 *
 * The candidate is computed against a merge base, and a merge base derived from a LOCAL ref (a config.base branch such as
 * `trunk`, or the remote-tracking `origin/<default>` authorize publish reads with config.base HEAD) is no authority: any
 * process of the user can move it (`git branch -f trunk HEAD`, `git update-ref refs/remotes/origin/main ...`). Moved onto a
 * commit that carries unreviewed work, the merge base absorbs that work, the candidate no longer contains it, and a PR
 * against the REMOTE base would ship it. So the base the reviewed range is measured from is the commit the REMOTE names for
 * the base branch (`git ls-remote`), on the remote whose repository identity is recorded with it:
 *
 *   base_unverified          no configured remote, a different repository than the one recorded, no common history with
 *                            the remote base, or (config.base a branch) a review freeze / SHIP_READY without a verified base
 *   base_remote_unavailable  ls-remote failed, the remote has no such branch, or its commit is not in the local repository
 *                            (fetch it: ancestry is never assumed)
 *   base_moved_local         merge-base(HEAD, <local ref>) is not merge-base(HEAD, <remote base commit>): the local ref was moved
 *                            (or carries local-only commits the branch contains), so the candidate omits commits the PR would ship
 *   base_moved_remote        the remote base no longer descends from the base commit recorded at the review freeze (a force-push
 *                            or a rewind of the base branch)
 *
 * Policy for a remote base that ADVANCED with commits the branch does not contain: accepted. The merge base (and so the
 * three-dot range a PR shows) is still the reviewed one. A branch that merges or rebases onto the advanced base changes its
 * merge base, which review freshness refuses (review_base_moved; authorize publish base_mismatch): the owner re-freezes with
 * a RETRY (a new original review against the new base), never silently.
 *
 * Enforced: with config.base a branch, gate review (original and confirmation) verifies the base before accepting and the
 * original's freeze records { ref, remote, identity, repository, sha }; gate ship-ready re-verifies it against that record
 * and binds it to SHIP_READY; authorize publish (so publish and the pre-push hook) re-verifies it against SHIP_READY's record.
 * With config.base HEAD the freeze merge base is already a commit; authorize publish measures it against the remote default
 * branch's commit from ls-remote, never the remote-tracking ref.
 *
 * Residual (same user, documented, not closed): the remote is reached through the repository's git config, so a same-user
 * `insteadOf` or `remote set-url` can redirect ls-remote (the URL identity recorded at the freeze is compared, the bytes behind
 * it are not); a push to the base branch itself (git-guard's bypasses) moves the remote base; state.json, which holds the
 * record, is same-user writable. No cryptographic attestation of the remote's answer.
 */
import { spawnSync } from 'node:child_process';
import { remoteRepository } from './engine-ci.mjs';

export const BASE_CODES = Object.freeze(['base_unverified', 'base_remote_unavailable', 'base_moved_local', 'base_moved_remote']);
/** The remote a config.base branch is verified on at the gates (publish's default remote). */
export const BASE_REMOTE = 'origin';
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const git = (repo, args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 60000 });
const out = (r) => (r.status === 0 ? r.stdout.trim() : null);
const no = (code, reason) => ({ ok: false, code, reasons: [reason] });

/** Whether config.base names a branch (not HEAD). */
export const branchBase = (S) => Boolean(S?.config?.base) && S.config.base !== 'HEAD';

/** The identity of remote `remote`: { remote, url, repository, identity } (identity: the GitHub slug, else the URL), or null when unconfigured. */
export function remoteIdentity(repoRoot, remote) {
  if (!SAFE_REMOTE.test(String(remote ?? ''))) return null;
  const url = out(git(repoRoot, ['config', '--get', `remote.${remote}.url`]));
  if (!url) return null;
  const repository = remoteRepository(repoRoot, remote)?.slug ?? null;
  return { remote, url, repository, identity: repository ? repository.toLowerCase() : `url:${url}` };
}

/**
 * Verify the base branch `ref` on `remote` -> { ok: true, base } | { ok: false, code, reasons }. `base` is
 * { ref, remote, identity, repository, sha, remote_head, merge_base }: `sha` is the base commit of record (the recorded one when
 * `recorded` is given, else the remote's head now), `merge_base` is merge-base(HEAD, remote head). `localMergeBase` (the merge base the
 * candidate was computed against from the local ref) must equal it.
 */
export function verifyBase(repoRoot, { ref, remote = BASE_REMOTE, recorded = null, localMergeBase }) {
  const id = remoteIdentity(repoRoot, remote);
  if (!id) return no('base_unverified', `remote ${remote} is not a configured remote: the base ${ref} cannot be verified on the repository the PR targets (a local ref is never the base authority)`);
  if (recorded && recorded.identity !== id.identity)
    return no('base_unverified', `the base was verified on ${recorded.identity} (remote ${recorded.remote}), remote ${remote} is now ${id.identity}: another repository is never the reviewed base`);
  const ls = git(repoRoot, ['ls-remote', remote, `refs/heads/${ref}`]);
  if (ls.status !== 0) return no('base_remote_unavailable', `git ls-remote ${remote} refs/heads/${ref} failed (${(ls.stderr || ls.error?.message || `exit ${ls.status}`).trim()}): the base commit cannot be verified`);
  const head = ls.stdout.split('\n').map(l => l.split(/\s+/)).find(([, name]) => name === `refs/heads/${ref}`)?.[0] ?? null;
  if (!head) return no('base_remote_unavailable', `remote ${remote} has no branch ${ref}: the base commit cannot be verified`);
  if (git(repoRoot, ['cat-file', '-e', `${head}^{commit}`]).status !== 0)
    return no('base_remote_unavailable', `the remote base ${ref} is at ${head}, which is not in the local repository: fetch it (git fetch ${remote} ${ref}), then retry`);
  if (recorded && recorded.sha !== head) {
    const a = git(repoRoot, ['merge-base', '--is-ancestor', recorded.sha, head]);
    if (a.status === 1) return no('base_moved_remote', `the remote base ${ref} is at ${head}, which does not descend from the reviewed base commit ${recorded.sha} (a force-push or rewind): the owner re-freezes with a RETRY (a new original review)`);
    if (a.status !== 0) return no('base_remote_unavailable', `the reviewed base commit ${recorded.sha} could not be compared with the remote base ${head}: ${(a.stderr || '').trim()}`);
  }
  const mergeBase = out(git(repoRoot, ['merge-base', 'HEAD', head]));
  if (!mergeBase) return no('base_unverified', `HEAD shares no history with the remote base ${ref} (${head})`);
  if (localMergeBase !== undefined && localMergeBase !== mergeBase)
    return no('base_moved_local', `the candidate's merge base ${localMergeBase ?? 'none'} (from the local ref) is not merge-base(HEAD, ${remote}/${ref} = ${head}) ${mergeBase}: `
      + `the local base ref was moved (or carries commits the remote base does not), so the candidate would omit commits a PR ships; reset it to the remote base (git fetch ${remote}; git branch -f ${ref} ${remote}/${ref}) or the owner decides`);
  return { ok: true, base: { ref, remote, identity: id.identity, repository: id.repository, sha: recorded?.sha ?? head, remote_head: head, merge_base: mergeBase } };
}

/**
 * The gates' check with config.base a branch: null (nothing to verify: config.base HEAD) | { ok: true, base } | { ok: false, code, reasons }.
 * `recorded` is the base of record (S.freeze.base / S.ship_ready.base); `requireRecord` refuses its absence (base_unverified).
 */
export function gateBase(S, repoRoot, { localMergeBase, recorded = null, requireRecord = false }) {
  if (!branchBase(S)) return null;
  if (requireRecord && !recorded?.sha) return no('base_unverified', `no verified base commit is recorded for this ${recorded === null ? 'review freeze' : 'record'} (frozen before base verification, or the record was lost): the owner appends a RETRY for a new original review`);
  if (recorded && recorded.ref !== S.config.base) return no('base_unverified', `the recorded base is ${recorded.ref}, config.base is ${S.config.base}`);
  return verifyBase(repoRoot, { ref: S.config.base, remote: recorded?.remote ?? BASE_REMOTE, recorded, localMergeBase });
}
