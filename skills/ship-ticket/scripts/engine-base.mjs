// S-12 (ASTF-6) provenance: ported unchanged from commit a890b0d (branch fix/P0-engine-enrollment, R0-S repair round 3),
// skills/ship-ticket/scripts/engine-base.mjs, git blob 2ea46c719fa62ce350784a8e91185e79e5195857: every line below this header is
// that blob, byte for byte. On main S-12 uses verifyBase, authGit and BASE_CODES for the pinned base of a run (run-engine.mjs
// init, gate reassess, status). The review freeze and engine-identity.mjs verifyReleaseBinding the comment below names are
// S-28a. OD-5 revised: callers run it under engine-base-read.mjs underHardenedGit (env); TODO(S-02a0c): lib git runner.
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
 * R0-S round 4: this module only CHECKS a base; the authority that decides when and against which record is engine-identity.mjs
 * verifyReleaseBinding (both base modes: the freeze records { remote, identity, ref, sha, merge_base } BEFORE the reviewer launches,
 * with config.base HEAD the ref resolved once by `ls-remote --symref`). The remote's identity is compared by the caller against the
 * ENROLLED identity (identity_changed). Every git call here runs with --no-replace-objects (`authGit`).
 *
 * Residual (same user, documented, not closed): the remote is reached through the repository's git config, so a same-user
 * `insteadOf` or `remote set-url` can redirect ls-remote (the URL identity recorded at the freeze is compared, the bytes behind
 * it are not); a push to the base branch itself (git-guard's bypasses) moves the remote base; state.json, which holds the
 * record, is same-user writable. No cryptographic attestation of the remote's answer.
 */
import { spawnSync } from 'node:child_process';

export const BASE_CODES = Object.freeze(['base_unverified', 'base_remote_unavailable', 'base_moved_local', 'base_moved_remote']);

/** git for authoritative reads: replacement objects off (flag and environment), so `git replace` never changes ancestry or contents (E-a). */
export function authGit(repoRoot, args, { env = process.env, timeout = 60000, maxBuffer } = {}) {
  return spawnSync('git', ['--no-replace-objects', ...args], { cwd: repoRoot, encoding: 'utf8', timeout, ...(maxBuffer ? { maxBuffer } : {}),
    env: { ...env, GIT_NO_REPLACE_OBJECTS: '1' } });
}
const out = (r) => (r.status === 0 ? r.stdout.trim() : null);
const no = (code, reason) => ({ ok: false, code, reasons: [reason] });

/**
 * Verify the base branch `ref` on `remote` (a remote name or URL whose identity the caller verified) -> { ok: true, base } | { ok: false, code, reasons }.
 * `base` is { ref, remote, identity, sha, remote_head, merge_base }: `sha` is the base commit of record (the recorded one when `recorded`
 * is given, else the remote's head now), `merge_base` is merge-base(HEAD, remote head). `localMergeBase` (the merge base the candidate was
 * computed against from a local config.base branch) must equal it when given.
 */
export function verifyBase(repoRoot, { ref, remote, identity = null, recorded = null, localMergeBase }) {
  const ls = authGit(repoRoot, ['ls-remote', remote, `refs/heads/${ref}`]);
  if (ls.status !== 0) return no('base_remote_unavailable', `git ls-remote ${remote} refs/heads/${ref} failed (${(ls.stderr || ls.error?.message || `exit ${ls.status}`).trim()}): the base commit cannot be verified`);
  const head = ls.stdout.split('\n').map(l => l.split(/\s+/)).find(([, name]) => name === `refs/heads/${ref}`)?.[0] ?? null;
  if (!head) return no('base_remote_unavailable', `remote ${remote} has no branch ${ref}: the base commit cannot be verified`);
  if (authGit(repoRoot, ['cat-file', '-e', `${head}^{commit}`]).status !== 0)
    return no('base_remote_unavailable', `the remote base ${ref} is at ${head}, which is not in the local repository: fetch it (git fetch ${remote} ${ref}), then retry`);
  if (recorded && recorded.sha !== head) {
    const a = authGit(repoRoot, ['merge-base', '--is-ancestor', recorded.sha, head]);
    if (a.status === 1) return no('base_moved_remote', `the remote base ${ref} is at ${head}, which does not descend from the reviewed base commit ${recorded.sha} (a force-push or rewind): the owner re-freezes with a RETRY (a new original review)`);
    if (a.status !== 0) return no('base_remote_unavailable', `the reviewed base commit ${recorded.sha} could not be compared with the remote base ${head}: ${(a.stderr || '').trim()}`);
  }
  const mergeBase = out(authGit(repoRoot, ['merge-base', 'HEAD', head]));
  if (!mergeBase) return no('base_unverified', `HEAD shares no history with the remote base ${ref} (${head})`);
  if (localMergeBase !== undefined && localMergeBase !== mergeBase)
    return no('base_moved_local', `the candidate's merge base ${localMergeBase ?? 'none'} (from the local ref) is not merge-base(HEAD, ${remote}/${ref} = ${head}) ${mergeBase}: `
      + `the local base ref was moved (or carries commits the remote base does not), so the candidate would omit commits a PR ships; reset it to the remote base (git fetch ${remote}; git branch -f ${ref} ${remote}/${ref}) or the owner decides`);
  return { ok: true, base: { ref, remote, identity: identity ? identity.slug.toLowerCase() : null, sha: recorded?.sha ?? head, remote_head: head, merge_base: mergeBase } };
}
