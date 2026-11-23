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
 * Residuals (documented, not closed): the identity is the CONFIGURED URL (insteadOf, pushInsteadOf and credential helpers are
 * not resolved); the ls-remote answer is not attested; a same-user rewrite of state.json together with the URL; between two
 * gates nothing is re-read (the next gate reads again).
 */
import { repoIdentityOn } from './engine-dag.mjs';
import { underHardenedGit, wellFormedBase, localMergeBase } from './engine-base-read.mjs';
import { verifyBase } from './engine-base.mjs';
import { remoteIdentity, remoteUrl, sameRepository } from './remote-identity.mjs';

export const IDENTITY_CODES = Object.freeze(['identity_changed', 'identity_unbound', 'identity_state_missing']);
const no = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: true, reasons, ...extra });
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const exact = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === keys;

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
 * The remote's repository identity now against the identity of record (S.base.identity): null when it holds (or the flag is
 * off), else identity_changed (another repository, or none: a plain path), remote_ambiguous, or identity_state_missing.
 */
export function identityRefusal(E, stage) {
  if (!repoIdentityOn(E.S)) return null;
  const B = E.S.base;
  if (!wellFormedBase(B) || typeof B.identity !== 'string') return no('identity_state_missing', ['the run binds a repository identity but S.base names none: a partial activation is never resumed']);
  return underHardenedGit(() => {
    const id = remoteIdentity(E.ctx.repoRoot, B.remote);
    if (!id.ok) return no(id.code, id.reasons);
    if (sameRepository(id.identity, { slug: B.identity })) return null;
    const now = id.identity?.slug.toLowerCase() ?? null;
    return no('identity_changed', [`gate ${stage}: remote ${B.remote} now names ${now ?? 'no GitHub repository'}; this run is bound to ${B.identity}: `
      + `restore the remote URL (git remote set-url ${B.remote} <url of ${B.identity}>) and retry, or start a new run`], { expected: B.identity, observed: now });
  });
}

/**
 * The remote base against `recorded` (S.base at an original, the freeze base after it), read by the remote's one URL:
 * { ok: true, base } (the remote head now, with the pinned merge base) | base_unverified / remote_ambiguous /
 * base_remote_unavailable / base_moved_remote / base_moved_local { expected, observed }.
 */
export function verifyFrozenBase(E, recorded) {
  const S = E.S, B = S.base, root = E.ctx.repoRoot;
  return underHardenedGit(() => {
    const u = remoteUrl(root, B.remote);
    if (!u.ok) return no(u.code, u.reasons);
    const v = verifyBase(root, { ref: B.ref, remote: u.url, recorded });
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

/** An original review's freeze base: the remote head now, verified against the pin. */
export const captureFreezeBase = (E) => verifyFrozenBase(E, E.S.base);

const RECORDED = { review: (S) => S.base, confirmation: (S) => S.freeze?.base, 'ship-ready': (S) => S.freeze?.base };

/**
 * One gate's identity and base check: null with the flag off; else the refusal, or { ok: true, base } where base is the freeze
 * base to record (review original: captured now) or the one already recorded (confirmation, ship-ready). `stage`: 'review'
 * (an original), 'confirmation' or 'ship-ready'.
 */
export function identityStage(E, stage) {
  if (!repoIdentityOn(E.S)) return null;
  return underHardenedGit(() => identityRefusal(E, stage) ?? frozenBase(E, stage, RECORDED[stage](E.S)));
}

function frozenBase(E, stage, recorded) {
  if (stage !== 'review' && !wellFormedFreezeBase(recorded, E.S.base))
    return no('base_unverified', [`gate ${stage}: no verified base is recorded with the review freeze: an owner RETRY (a new original review) freezes one`]);
  const v = verifyFrozenBase(E, recorded);
  if (!v.ok) return v;
  return { ok: true, base: stage === 'review' ? v.base : recorded };
}
