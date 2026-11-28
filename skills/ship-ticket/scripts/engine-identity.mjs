/**
 * S-28a (ASTF-5): the repository identity a run is bound to, and the remote base of record. Node built-ins only.
 *
 * Opt-in: `config.repoIdentity: true` (which needs config.pinnedBase; policy versions 9-12). Trust on first use at init: the
 * identity of record is S.base.{ remote, identity } (S-12's pin), a repository on github.com. No other key holds it.
 *
 * Attempt 2: ONE snapshot per check. readRepoIdentity reads remote.<r>.url and remote.<r>.pushurl in ONE `git config -z
 * --get-regexp` process and returns a frozen record (github-identity.mjs: one strict parser for every value). Every consumer
 * receives that record and reads no remote URL itself:
 *   init              bindIdentity, then S-12 pinBaseRecord(root, config, record) (resolveBaseRef and verifyBase by record.url)
 *   reassess          checkedIdentity, then S-12 pinnedBaseRefusal(E, record): ONE base check, the same as a flag-off run's
 *   review original   checkedIdentity, then verifyBase against S.base (the pin); the freeze records the remote head NOW
 *   confirmation      checkedIdentity, then verifyBase against S.freeze.base (a rewind below the freeze sha is base_moved_remote)
 *   ship-ready        checkedIdentity, then verifyBase against S.freeze.base, before the proof AND again after it (a second,
 *                     independent snapshot: a proof command can re-point the remote); SHIP_READY binds the freeze base
 * What the snapshot covers, exactly: the configured url/pushurl values of ONE `git config` process. ls-remote is a separate git
 * process that reads config itself (url.*.insteadOf, http.*, core.sshCommand): the identity is the CONFIGURED URL, not a proven
 * endpoint. pushInsteadOf, branch.*.pushRemote and remote.pushDefault are not bound here (S-28b's publication binding); the
 * engine never pushes. A merge base other than the pinned one, or a moved local base branch, is base_moved_local (S-12: a new
 * run re-pins). Every refusal is a judgment point that never latches; the caller writes nothing but its GATE line.
 *
 * Provenance: identityNow, captureBase, verifyFrozenBase and the review and ship-ready stages of verifyReleaseBinding of commit
 * a890b0d skills/ship-ticket/scripts/engine-identity.mjs (lines 112-247), rewritten on main, not ported: the identity of record is
 * S.base, not S.enrollment (S-28b); P's `refrozen` re-capture is dropped (PLAN-S12 OD-3); the publication half is not here
 * (S-28b or never, OD-12). TODO(S-02a0c): authGit under underHardenedGit until the lib git runner covers these reads.
 * Residuals (documented, not closed): the endpoint behind the configured URL is unproven and the ls-remote answer unattested;
 * a same-user rewrite of state.json together with the URL; between two gates nothing is re-read (ship-ready reads again after
 * its proof); a proof adding url.<other>.insteadOf <the run's URL> still reaches SHIP_READY (served by the other repository, but
 * ship_ready.base stays the freeze sha); `status` is an advisory read of the configured URL (OD-10), not the snapshot.
 */
import { repoIdentityOn } from './engine-dag.mjs';
import { underHardenedGit, wellFormedBase, localMergeBase, movedRoute } from './engine-base-read.mjs';
import { verifyBase, authGit } from './engine-base.mjs';
import { identityRecord, validIdentityRecord } from './github-identity.mjs';

export const IDENTITY_CODES = Object.freeze(['identity_changed', 'identity_unbound', 'identity_state_missing']);
const no = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: true, reasons, ...extra });
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const exact = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === keys;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
 * THE read: remote.<remote>.url and .pushurl from ONE `git config -z --get-regexp` process (all scopes, NUL-separated, so a value
 * holding a newline can never forge a key; every regex metacharacter of the remote name escaped). -> { ok: true, record, seen }
 * (record: identityRecord, or null when the values name no repository on github.com; seen: the fetch URL as configured) |
 * remote_ambiguous (several fetch or push values, a push URL of another repository or not on github.com, an unreadable config:
 * any exit other than 0 or 1, an empty or malformed value).
 */
export function readRepoIdentity(root, remote) {
  return underHardenedGit(() => {
    const r = authGit(root, ['config', '-z', '--get-regexp', `^remote\\.${reEscape(remote)}\\.(url|pushurl)$`]);
    const fail = (why) => ({ ok: false, code: 'remote_ambiguous', judgment_point: true, reasons: [`remote ${remote}: ${why}; configure exactly one URL `
      + '(and at most one push URL, of the same repository on github.com), or start a new run'] });
    if (r.error || (r.status !== 0 && r.status !== 1)) return fail(`git config failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()})`);
    const urls = [], pushes = [];
    for (const rec of (r.status === 0 ? r.stdout : '').split('\0').filter((x) => x !== '')) {
      const nl = rec.indexOf('\n'), key = nl < 0 ? rec : rec.slice(0, nl), value = nl < 0 ? '' : rec.slice(nl + 1);
      if (value === '') return fail(`${key} has no value`);
      if (key === `remote.${remote}.url`) urls.push(value);
      else if (key === `remote.${remote}.pushurl`) pushes.push(value);
      else return fail(`unexpected config key ${JSON.stringify(key)}`);
    }
    if (urls.length > 1) return fail(`${urls.length} fetch URLs (${urls.join(', ')})`);
    if (pushes.length > 1) return fail(`${pushes.length} push URLs (${pushes.join(', ')})`);
    if (!urls.length) return { ok: true, record: null, seen: null };
    const record = identityRecord(urls[0], pushes[0] ?? null);
    if (!record && pushes.length && identityRecord(urls[0], null))
      return fail(`fetches from ${urls[0]} but pushes to ${pushes[0]}: a push URL of another repository, or not on github.com`);
    return { ok: true, record, seen: urls[0] };
  });
}

/**
 * init: the record a repoIdentity run binds, or a coded refusal to throw: remote_ambiguous as read; identity_unbound when the
 * remote names no repository on github.com (a local path, another host, a port, plaintext http/git, no URL).
 */
export function bindIdentity(root, remote) {
  const r = readRepoIdentity(root, remote);
  if (!r.ok) return r;
  if (r.record) return { ok: true, record: r.record };
  return { ok: false, code: 'identity_unbound', reasons: [`config.repoIdentity binds the run to the repository on github.com its remote ${remote} names, but `
    + `it names ${r.seen ?? 'nothing (no URL)'}: not a https://github.com/<owner>/<repo>, ssh://github.com/<owner>/<repo> or git@github.com:<owner>/<repo> `
    + 'URL; configure one, or drop config.repoIdentity'] };
}

/**
 * A gate's identity check, from ONE snapshot: { ok: true, record } when the remote's values name the run's repository
 * (S.base.identity) | identity_changed (another repository, another host, a port, plaintext, none) | remote_ambiguous |
 * identity_state_missing.
 */
export function checkedIdentity(E, stage) {
  const B = E.S.base;
  if (!wellFormedBase(B) || typeof B.identity !== 'string') return no('identity_state_missing', ['the run binds a repository identity but S.base names none: a partial activation is never resumed']);
  const r = readRepoIdentity(E.ctx.repoRoot, B.remote);
  if (!r.ok) return r;
  if (r.record?.identity === B.identity) return { ok: true, record: r.record };
  const now = r.record?.identity ?? null;
  return no('identity_changed', [`gate ${stage}: remote ${B.remote} now names ${now ?? (r.seen ? `${r.seen}, not a repository on github.com` : 'no URL')}; this run `
    + `is bound to ${B.identity}: restore the remote URL (git remote set-url ${B.remote} <url of ${B.identity}>) and retry, or start a new run`],
    { expected: B.identity, observed: now });
}

/** The identity check alone (S-28b/S-14 callers that order other checks between): null when it holds or the flag is off. */
export function identityRefusal(E, stage) {
  if (!repoIdentityOn(E.S)) return null;
  const r = checkedIdentity(E, stage);
  return r.ok ? null : r;
}

/**
 * The remote base against `recorded`, read by `record.url` (the snapshot checkedIdentity returned; never re-read). Strict inputs:
 * `recorded` is the pin itself (S.base) or a well-formed freeze base, and `record` a valid record naming the run's identity;
 * anything else is base_unverified, never a check skipped. -> { ok: true, base } (the remote head now, the pinned merge base) |
 * base_unverified / base_remote_unavailable / base_moved_remote / base_moved_local { expected, observed }.
 */
export function verifyFrozenBase(E, recorded, record) {
  const S = E.S, B = S.base, root = E.ctx.repoRoot;
  const recordOk = recorded === B ? wellFormedBase(B) && typeof B.identity === 'string' : wellFormedFreezeBase(recorded, B);
  const snap = recordOk ? validIdentityRecord(record, B?.identity) : null; // the validated COPY is what is read below
  if (!recordOk || !snap) return no('base_unverified', [`no verified base record${recordOk ? '' : ' (no well-formed freeze base)'} or `
    + 'no identity snapshot of this run to verify the remote base by: a review freeze without a base needs an owner RETRY (a new original review freezes one)']);
  return underHardenedGit(() => {
    const v = verifyBase(root, { ref: B.ref, remote: snap.url, recorded });
    if (!v.ok) return no(v.code, v.reasons);
    const moved = (observed, reason) => no('base_moved_local', [reason], { expected: B.merge_base, observed });
    if (v.base.merge_base !== B.merge_base) return moved(v.base.merge_base, `merge-base(HEAD, ${B.remote}/${B.ref}) is ${v.base.merge_base}, not the pinned ${B.merge_base}: `
      + `the branch merged or rebased onto another base during the run; ${movedRoute(S)}`);
    const local = localMergeBase(root, S.config);
    if (local !== undefined && local !== B.merge_base) return moved(local, `merge-base(HEAD, local ${S.config.base}) is ${local ?? 'none'}, not the pinned ${B.merge_base}: `
      + `reset the local base branch (git fetch ${B.remote}; git branch -f ${S.config.base} ${B.remote}/${B.ref}) or the owner decides, then retry`);
    return { ok: true, base: { remote: B.remote, identity: B.identity, ref: B.ref, sha: v.base.remote_head, merge_base: B.merge_base } };
  });
}

/** An original review's freeze base: the remote head now, verified against the pin by the snapshot `record`. */
export const captureFreezeBase = (E, record) => verifyFrozenBase(E, E.S.base, record);

const RECORDED = { review: (S) => S.base, confirmation: (S) => S.freeze?.base, 'ship-ready': (S) => S.freeze?.base };

/**
 * One check, identity THEN base, from ONE snapshot: null with the flag off; else the refusal, or { ok: true, base } where base is
 * the freeze base to record (review original: captured now) or the one already recorded (confirmation, ship-ready).
 */
export function identityStage(E, stage) {
  if (!repoIdentityOn(E.S)) return null;
  return underHardenedGit(() => {
    const id = checkedIdentity(E, stage);
    if (!id.ok) return id;
    const v = verifyFrozenBase(E, RECORDED[stage](E.S), id.record);
    if (!v.ok) return v;
    return { ok: true, base: stage === 'review' ? v.base : RECORDED[stage](E.S) };
  });
}
