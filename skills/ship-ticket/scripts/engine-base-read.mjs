/**
 * S-12 (ASTF-6): THE module every pinned-base read goes through. Node built-ins only.
 *
 * A pin is only as strong as its weakest read (S-12 Round 1). So on a pinned run EVERY git read derived from the base runs
 * under underHardenedGit: no inherited GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR,
 * GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG*, GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, GIT_SSH_COMMAND,
 * ...), so nothing redirects a read to another checkout or another transport; replace refs off (GIT_NO_REPLACE_OBJECTS=1, which
 * also makes GIT_REPLACE_REF_BASE inert) and grafts off (GIT_GRAFT_FILE=<null device>), so no object or ancestry is rewritten.
 * The repository is the root passed explicitly (cwd). That covers:
 * - init: pinBaseRecord (the pin S.base); gate reassess: pinnedBaseRefusal; status: baseStatus;
 * - every engine read derived from the base: baseCandidate (candidate-id.mjs and its git children inherit the environment),
 *   baseCommit, onBase (the reassess diff, the test-kind declaration).
 * engine-base.mjs (ported byte for byte) takes its environment from process.env; underHardenedGit supplies it (OD-5, revised:
 * authGit is kept, the authority over its environment is the caller's). A flag-off run takes none of this: its reads are as before.
 *
 * Residuals (documented, not closed): the remote is reached through the repository's own and the user's git config (insteadOf,
 * credential helpers); a remote URL re-pointed at another repository mid-run is not detected (identity_changed is S-28a);
 * state.json is same-user writable; inherited GIT_SSH_COMMAND / GIT_ASKPASS are not honored for these reads (use ssh config or
 * a credential helper).
 */
import { devNull } from 'node:os';
import { coded, baseRef, pinnedBaseOn } from './engine-dag.mjs';
import * as io from './engine-io.mjs';
import { verifyBase, authGit } from './engine-base.mjs';
import { remoteIdentity, remoteUrl, resolveBaseRef } from './remote-identity.mjs';

const no = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: true, reasons, ...extra });
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The environment of a hardened base read: `env` without any GIT_* variable, replace refs and grafts off. */
export function hardenedGitEnv(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k)));
  return { ...clean, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };
}

/**
 * Run the SYNCHRONOUS `fn` with process.env replaced by hardenedGitEnv(process.env), restored afterwards on every path: every
 * git (or candidate-id) child `fn` spawns, including those of engine-base.mjs authGit, inherits it. No other code runs while
 * `fn` runs (it is synchronous), so nothing else sees the swap; a `fn` that returns a promise is refused (it would outlive it).
 */
export function underHardenedGit(fn) {
  const saved = { ...process.env }, hard = hardenedGitEnv(saved);
  for (const k of Object.keys(process.env)) if (!Object.hasOwn(hard, k)) delete process.env[k];
  Object.assign(process.env, hard);
  try {
    const r = fn();
    if (r !== null && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') throw coded('base_read_async', 'underHardenedGit runs synchronous reads only');
    return r;
  } finally {
    for (const k of Object.keys(process.env)) if (!Object.hasOwn(saved, k)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** Whether `S` is a pinned run (config.pinnedBase, or an S.base key of any value: a malformed one is refused, never ignored). */
const pinned = (S) => pinnedBaseOn(S) || Object.hasOwn(S ?? {}, 'base');
/** Run `fn` (a base-derived git read): hardened on a pinned run, as before on any other. */
export const onBase = (S, fn) => (pinned(S) ? underHardenedGit(fn) : fn());
/** The candidate id measured from the run's base (baseRef). */
export const baseCandidate = (root, S, exclusions) => onBase(S, () => io.candidateId(root, baseRef(S), exclusions));
/** The run's base commit (baseRef resolved). */
export const baseCommit = (root, S) => onBase(S, () => io.resolveCommit(root, baseRef(S)));

/** Whether `B` is exactly a recorded pin: { remote, identity, ref, sha, merge_base, pinned_at_seq }, each well-formed. */
export function wellFormedBase(B) {
  return B !== null && typeof B === 'object' && !Array.isArray(B)
    && Object.keys(B).sort().join() === 'identity,merge_base,pinned_at_seq,ref,remote,sha'
    && typeof B.remote === 'string' && SAFE_REMOTE.test(B.remote) && (B.identity === null || (typeof B.identity === 'string' && B.identity.length > 0))
    && typeof B.ref === 'string' && B.ref.length > 0 && SHA.test(B.sha) && SHA.test(B.merge_base) && Number.isInteger(B.pinned_at_seq) && B.pinned_at_seq > 0;
}

/**
 * init with config.pinnedBase { remote }: the base of record is the commit the REMOTE names for the base branch (config.base when
 * it names a branch, else the remote's default branch, `ls-remote --symref`), read once here; its merge base with HEAD is what
 * every base read of the run uses (baseRef). Throws coded refusals (nothing is written): remote_ambiguous; base_unverified (no
 * configured URL, a detached HEAD, a branch with no upstream, no shared history); base_remote_unavailable.
 */
export function pinBaseRecord(root, config) {
  return underHardenedGit(() => {
    const remote = config.pinnedBase.remote;
    const id = remoteIdentity(root, remote);
    if (!id.ok) throw coded(id.code, id.reasons.join('; '));
    const u = remoteUrl(root, remote);
    if (!u.ok) throw coded(u.code, u.reasons.join('; '));
    if (authGit(root, ['symbolic-ref', '-q', 'HEAD']).status !== 0)
      throw coded('base_unverified', 'HEAD is detached: a pinned base is recorded for a branch, so check out the ticket branch, then init');
    if (authGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).status !== 0)
      throw coded('base_unverified', `the current branch has no upstream: set one (git branch --set-upstream-to=${remote}/<branch>), then init`);
    const ref = resolveBaseRef({ config }, root, u.url);
    if (!ref.ok) throw coded(ref.code, ref.reasons.join('; '));
    const v = verifyBase(root, { ref: ref.ref, remote: u.url, identity: id.identity });
    if (!v.ok) throw coded(v.code, v.reasons.join('; '));
    return { base: { remote, identity: v.base.identity, ref: v.base.ref, sha: v.base.sha, merge_base: v.base.merge_base }, local: localMergeBase(root, config) };
  });
}

/**
 * merge-base(HEAD, refs/heads/<config.base>) when config.base names a local branch that exists; undefined when there is no
 * local base branch to compare (config.base absent or HEAD, or no such branch); null when the two share no history.
 * Called under underHardenedGit.
 */
export function localMergeBase(root, config) {
  const b = config?.base;
  if (!b || b === 'HEAD') return undefined;
  const ref = authGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]);
  if (ref.status !== 0) return undefined;
  const mb = authGit(root, ['merge-base', 'HEAD', ref.stdout.trim()]);
  return mb.status === 0 ? mb.stdout.trim() : null;
}

/**
 * gate reassess on a pinned run: the remote base is read again (verifyBase against the recorded base, by the remote's one URL)
 * before any security decision. null on a run that pins nothing, or when the base holds. Every refusal is a judgment point that
 * NEVER latches (no S.security write): base_state_missing (a malformed pin), remote_ambiguous / base_unverified (the remote's
 * URLs now), base_remote_unavailable, base_moved_remote, base_moved_local { expected, observed }.
 */
export function pinnedBaseRefusal(E) {
  if (!pinned(E.S)) return null;
  const B = E.S.base, root = E.ctx.repoRoot;
  if (!wellFormedBase(B)) return no('base_state_missing', ['the run pins its base but S.base is not a well-formed pin: a partial pin is never resumed']);
  return underHardenedGit(() => {
    const id = remoteIdentity(root, B.remote);
    if (!id.ok) return no(id.code, id.reasons);
    const u = remoteUrl(root, B.remote);
    if (!u.ok) return no(u.code, u.reasons);
    const v = verifyBase(root, { ref: B.ref, remote: u.url, recorded: B });
    if (!v.ok) return no(v.code, v.reasons);
    const moved = (observed, reason) => no('base_moved_local', [reason], { expected: B.merge_base, observed });
    if (v.base.merge_base !== B.merge_base) return moved(v.base.merge_base, `merge-base(HEAD, ${B.remote}/${B.ref}) is ${v.base.merge_base}, not the pinned `
      + `${B.merge_base}: the branch merged or rebased onto another base during the run; archive the run and start a new one (it pins the new base)`);
    const local = localMergeBase(root, E.S.config);
    if (local !== undefined && local !== B.merge_base) return moved(local, `merge-base(HEAD, local ${E.S.config.base}) is ${local ?? 'none'}, not the pinned `
      + `${B.merge_base}: the local base branch was not moved with the remote (or carries local-only commits); reset it (git fetch ${B.remote}; `
      + `git branch -f ${E.S.config.base} ${B.remote}/${B.ref}) or the owner decides, then retry`);
    return null;
  });
}

/**
 * The `base` block of a pinned run's status: the pin and advisories, never a judgment (status writes nothing). The remote head
 * now against the pinned sha: base_advanced (it descends from the pin: no effect on the run), base_rewound (the pin descends from
 * it), base_diverged (neither), base_remote_changed (not fetched: ancestry unknown); base_remote_unavailable; base_moved_local.
 */
export function baseStatus(E) {
  const B = E.S.base, root = E.ctx.repoRoot;
  return underHardenedGit(() => {
    const advisory = [], u = remoteUrl(root, B.remote);
    const ls = u.ok ? authGit(root, ['ls-remote', '--', u.url, `refs/heads/${B.ref}`], { timeout: 15000 }) : null;
    const now = ls?.status === 0 ? ls.stdout.split('\n').map(l => l.split(/\s+/)).find(([, name]) => name === `refs/heads/${B.ref}`)?.[0] ?? null : null;
    if (!now) advisory.push({ code: 'base_remote_unavailable', reason: u.ok ? `ls-remote ${B.remote} refs/heads/${B.ref} gave no commit` : u.reasons[0] });
    else if (now !== B.sha) {
      const anc = (a, b) => authGit(root, ['merge-base', '--is-ancestor', a, b]).status;
      const fwd = anc(B.sha, now), back = fwd === 0 ? 1 : anc(now, B.sha);
      const code = fwd === 0 ? 'base_advanced' : back === 0 ? 'base_rewound' : fwd === 1 && back === 1 ? 'base_diverged' : 'base_remote_changed';
      advisory.push({ code, pinned: B.sha, remote_now: now });
    }
    const local = localMergeBase(root, E.S.config);
    if (local !== undefined && local !== B.merge_base) advisory.push({ code: 'base_moved_local', expected: B.merge_base, observed: local });
    return { ...structuredClone(B), advisory };
  });
}
