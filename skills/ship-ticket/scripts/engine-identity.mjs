/**
 * S-28a (ASTF-5): the repository identity a run is bound to, and the remote base of record. Node built-ins only.
 *
 * Opt-in: `config.repoIdentity: true` (which needs config.pinnedBase; policy versions 9-12). Trust on first use at init: the
 * identity of record is S.base.{ remote, identity } (S-12's pin), which must name a GitHub repository. No other key holds it.
 * Every later gate review (original and confirmation), gate ship-ready and gate reassess reads, under underHardenedGit, the
 * remote's identity again (identity_changed, remote_ambiguous) and the remote base against the base of record:
 *   review original   verifyBase against S.base (the pin); the freeze records the remote head NOW as the base of record
 *   confirmation      verifyBase against S.freeze.base (a rewind below the freeze sha is base_moved_remote)
 *   ship-ready        verifyBase against S.freeze.base; SHIP_READY binds the freeze base (an advanced head is not adopted)
 *   reassess          the identity only, first: S-12's pinnedBaseRefusal follows (so no ls-remote goes to a re-pointed URL)
 * A merge base other than the pinned one, or a moved local base branch, is base_moved_local (S-12: a new run re-pins). Every
 * refusal is a judgment point that never latches; the caller writes nothing but its GATE line.
 *
 * Provenance: identityNow, captureBase, verifyFrozenBase and the review and ship-ready stages of verifyReleaseBinding of commit
 * a890b0d skills/ship-ticket/scripts/engine-identity.mjs (lines 112-247), rewritten on main, not ported: the identity of record is
 * S.base, not S.enrollment (no enrollment on main: S-28b); P's `refrozen` re-capture is dropped (on main a moved merge base is
 * base_moved_local, PLAN-S12 OD-3); ls-remote is given the remote's ONE configured URL (S-12 Round 1); the publication half
 * (publicationOf, prRows, prBinding, ghPinned, stages publish/ci/complete) is not here (S-28b or never, OD-12).
 * TODO(S-02a0c): the reads use engine-base.mjs authGit (and remote-identity.mjs `git config --get-all`) under underHardenedGit
 * until the lib git runner covers them.
 * Round 1: the URL is read ONCE per check (checkedRemote) and the base is read by that identity-checked URL; only a repository on
 * github.com binds (githubUrl: no other host, no port); ship-ready checks again after its proof (engine-gates.mjs).
 * Residuals (documented, not closed): the identity is the CONFIGURED URL (insteadOf, pushInsteadOf and credential helpers are
 * not resolved); the ls-remote answer is not attested; a same-user rewrite of state.json together with the URL; between two
 * gates nothing is re-read (the next gate reads again; ship-ready reads again after its proof).
 */
import { repoIdentityOn } from './engine-dag.mjs';
import { underHardenedGit, wellFormedBase, localMergeBase } from './engine-base-read.mjs';
import { verifyBase } from './engine-base.mjs';
import { remoteIdentity, sameRepository } from './remote-identity.mjs';

export const IDENTITY_CODES = Object.freeze(['identity_changed', 'identity_unbound', 'identity_state_missing']);
const no = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: true, reasons, ...extra });
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const exact = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === keys;

/**
 * Round 1: a URL naming a repository ON github.com, the only identity a repoIdentity run binds (OD-3): https/http/ssh/git URLs
 * whose host is exactly github.com with no port, or the scp form [user@]github.com:owner/repo. remote-identity.mjs repositoryOf
 * also parses other hosts and drops a port (its flag-off consumers are unchanged); this check is S-28a's alone.
 */
const GITHUB_URL = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/|(?:[^@/\s:]+@)?github\.com:)/i;
export const githubUrl = (url) => typeof url === 'string' && GITHUB_URL.test(url);

/** Whether `B` is exactly a freeze base of the pin `pin`: { remote, identity, ref, sha, merge_base }, all but sha equal to the pin's. */
export function wellFormedFreezeBase(B, pin) {
  return exact(B, 'identity,merge_base,ref,remote,sha') && wellFormedBase(pin) && typeof pin.identity === 'string'
    && B.remote === pin.remote && B.identity === pin.identity && B.ref === pin.ref && B.merge_base === pin.merge_base
    && typeof B.sha === 'string' && SHA.test(B.sha);
}

/** The load invariant under the flag: S.base names a repository; a freeze and a SHIP_READY are exact records with a freeze base. */
export function identityStateHolds(S) {
  if (!wellFormedBase(S?.base) || typeof S.base.identity !== 'string') return false;
  const frozen = S.freeze === null || (exact(S.freeze, 'base,candidate,seq') && wellFormedFreezeBase(S.freeze.base, S.base));
  const shipped = S.ship_ready === undefined || (exact(S.ship_ready, 'base,candidate_id,seq') && wellFormedFreezeBase(S.ship_ready.base, S.base));
  return frozen && shipped;
}

/**
 * init (trust on first use): null when the pinned remote's one URL names a repository on github.com and it is the one pinned,
 * else the reason (the caller refuses identity_unbound): a local path, another host (gitlab.com), a port, no URL.
 */
export function unboundIdentity(repoRoot, remote, pinned) {
  return underHardenedGit(() => {
    const id = remoteIdentity(repoRoot, remote);
    const url = id.ok ? id.identity?.url ?? null : null;
    if (id.ok && id.identity && githubUrl(url) && pinned.identity === id.identity.slug.toLowerCase()) return null;
    return `config.repoIdentity binds the run to the repository on github.com its remote ${remote} names, but that remote names `
      + `${id.ok ? (id.identity ? `${url} (not a github.com repository URL: another host or a port)` : 'none (a local path or another host)') : id.reasons.join('; ')}: `
      + 'configure a https://github.com/<owner>/<repo> (or git@github.com:<owner>/<repo>) URL, or drop config.repoIdentity';
  });
}

/**
 * THE identity read of a gate, read ONCE: the remote's one configured URL must name the run's repository (S.base.identity) on
 * github.com. -> { ok: true, url } (the identity-checked URL, which the base read is then given) | identity_changed (another
 * repository, another host or a port, or none: a plain path) | remote_ambiguous | identity_state_missing.
 */
export function checkedRemote(E, stage) {
  const B = E.S.base;
  if (!wellFormedBase(B) || typeof B.identity !== 'string') return no('identity_state_missing', ['the run binds a repository identity but S.base names none: a partial activation is never resumed']);
  return underHardenedGit(() => {
    const id = remoteIdentity(E.ctx.repoRoot, B.remote);
    if (!id.ok) return no(id.code, id.reasons);
    const url = id.identity?.url ?? null;
    if (id.identity && githubUrl(url) && sameRepository(id.identity, { slug: B.identity })) return { ok: true, url };
    const now = id.identity && githubUrl(url) ? id.identity.slug.toLowerCase() : null;
    return no('identity_changed', [`gate ${stage}: remote ${B.remote} now names ${now ?? (url ? `${url}, not a github.com repository URL` : 'no GitHub repository')}; `
      + `this run is bound to ${B.identity}: restore the remote URL (git remote set-url ${B.remote} <url of ${B.identity}>) and retry, or start a new run`],
      { expected: B.identity, observed: now });
  });
}

/** The identity check alone (reassess, and S-28b/S-14 callers): null when it holds or the flag is off, else the refusal. */
export function identityRefusal(E, stage) {
  if (!repoIdentityOn(E.S)) return null;
  const r = checkedRemote(E, stage);
  return r.ok ? null : r;
}

/**
 * The remote base against `recorded`, read by `url`, the URL checkedRemote returned (never re-read from config, so the base
 * verified is the identity verified). Strict inputs: `recorded` is the pin itself (S.base, an original) or a well-formed freeze
 * base, and `url` a github.com URL; anything else is base_unverified, never a check skipped. -> { ok: true, base } (the remote head
 * now, with the pinned merge base) | base_unverified / base_remote_unavailable / base_moved_remote / base_moved_local { expected, observed }.
 */
export function verifyFrozenBase(E, recorded, url) {
  const S = E.S, B = S.base, root = E.ctx.repoRoot;
  const recordOk = recorded === B ? wellFormedBase(B) && typeof B.identity === 'string' : wellFormedFreezeBase(recorded, B);
  if (!recordOk || !githubUrl(url)) return no('base_unverified', [`no verified base record${recordOk ? '' : ' (no well-formed freeze base)'} or no identity-checked URL to verify `
    + 'the remote base against: a review freeze without a base needs an owner RETRY (a new original review freezes one)']);
  return underHardenedGit(() => {
    const v = verifyBase(root, { ref: B.ref, remote: url, recorded });
    if (!v.ok) return no(v.code, v.reasons);
    const moved = (observed, reason) => no('base_moved_local', [reason], { expected: B.merge_base, observed });
    if (v.base.merge_base !== B.merge_base) return moved(v.base.merge_base, `merge-base(HEAD, ${B.remote}/${B.ref}) is ${v.base.merge_base}, not the pinned ${B.merge_base}: `
      + 'the branch merged or rebased onto another base during the run; archive the run and start a new one (it pins the new base)');
    const local = localMergeBase(root, S.config);
    if (local !== undefined && local !== B.merge_base) return moved(local, `merge-base(HEAD, local ${S.config.base}) is ${local ?? 'none'}, not the pinned ${B.merge_base}: `
      + `reset the local base branch (git fetch ${B.remote}; git branch -f ${S.config.base} ${B.remote}/${B.ref}) or the owner decides, then retry`);
    return { ok: true, base: { remote: B.remote, identity: B.identity, ref: B.ref, sha: v.base.remote_head, merge_base: B.merge_base } };
  });
}

/** An original review's freeze base: the remote head now, verified against the pin by the identity-checked `url`. */
export const captureFreezeBase = (E, url) => verifyFrozenBase(E, E.S.base, url);

const RECORDED = { review: (S) => S.base, confirmation: (S) => S.freeze?.base, 'ship-ready': (S) => S.freeze?.base };

/**
 * One gate's check, identity THEN base (one URL read): null with the flag off; else the refusal, or { ok: true, base } where base
 * is the freeze base to record (review original: captured now) or the one already recorded (confirmation, ship-ready). `stage`:
 * 'review' (an original), 'confirmation' or 'ship-ready'.
 */
export function identityStage(E, stage) {
  if (!repoIdentityOn(E.S)) return null;
  return underHardenedGit(() => {
    const id = checkedRemote(E, stage);
    if (!id.ok) return id;
    const v = verifyFrozenBase(E, RECORDED[stage](E.S), id.url);
    if (!v.ok) return v;
    return { ok: true, base: stage === 'review' ? v.base : RECORDED[stage](E.S) };
  });
}
