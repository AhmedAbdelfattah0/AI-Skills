/**
 * Release identity (R0-S round 4): ONE recorded tuple, verified by ONE authority, `verifyReleaseBinding(stage, ...)`. Node built-ins only.
 *
 * The guarantee is "same configured repository identity" (trust on first use at enroll), NOT proof that it is the repository the owner
 * intended. Fields, by the point that records them (each immutable once recorded; only the listed transitions change them):
 *   ENROLL       state.enrollment: run_id, ticket, repo (the local toplevel), identity { remote_name, host, owner, repo, slug } read
 *                once by `readIdentity` (the one reader of a remote's repository), tools.gh { path, sha256 } (gh is pinned HERE or never:
 *                no later pin authorizes release). No GitHub origin at enroll: identity null; publish, ci and complete refuse
 *                identity_unbound (the gates still run).
 *   FREEZE       captured BEFORE the reviewer launches (engine-review-dispatch.mjs: each REVIEW_DISPATCHED receipt carries `base` and the
 *                engine-minted `review_execution_id`), adopted by gate review (original) into state.freeze.base: { remote, identity, ref,
 *                sha, merge_base }, in BOTH base modes. With config.base HEAD the ref is resolved once with `git ls-remote --symref <remote>
 *                HEAD`; a remote-tracking ref (refs/remotes/<r>/HEAD, refs/remotes/<r>/<b>) is never read. Repair and confirmation keep it.
 *   SHIP_READY   ship_ready.base (the freeze record, re-verified), merge_base, candidate_id.
 *   PUBLICATION  publication_id = sha256(canonical { identity, destination_ref, head, tree, base { ref, sha, merge_base }, candidate_id,
 *                pr { number, head_repo, base_repo, base_ref } | null }) (`publicationOf`). One permitted change of a head's publication:
 *                pr null -> one verified PR (publish --pr-title, or ci --pr); never a PR -> null or -> another PR, never another field.
 *   CI EVIDENCE  publication_id, head, repository, checks, PR snapshot (engine-ci.mjs).
 *   COMPLETE     the same verifier, cumulatively, plus a LIVE read-only `gh api repos/<o>/<r>/pulls/<n>` with the pinned gh.
 *
 * A required field that is missing is a refusal (identity_unbound; a missing base record keeps its existing code base_unverified), never
 * a skip: review/ship-ready need the freeze base whenever an identity is recorded or config.base is a branch; publish, ci and complete need
 * the identity; ci and complete the pinned gh and the publication tuple; complete a bound PR and STRICT assurance. Reason codes: identity_unbound, identity_changed,
 * remote_ambiguous (round 5: several fetch or push URLs, or a push URL of another repository; `remoteIdentity`), pr_required, pr_state, pr_base_mismatch,
 * pr_head_mismatch, pr_repo_mismatch, pr_unavailable, publication_mismatch, assurance_relaxed, gh_unpinned, gh_drift, and the base codes
 * of engine-base.mjs. Callers (one line each): gate review and gate ship-ready (engine-gates.mjs), authorize publish (engine-enroll.mjs:
 * publish(), the git-guard hook and `next` call it), `ci` (run-engine.mjs), authorize complete (engine-enroll.mjs).
 *
 * Authoritative git reads (ancestry, merge base, candidate, history) run with --no-replace-objects (`authGit`): a `git replace` object never
 * changes what the engine judges. Residuals (documented, not closed): a same-user rewrite of state.json; importing these modules; a tool
 * replaced before its pin; git URL rewriting (url.<base>.insteadOf / pushInsteadOf, GIT_CONFIG_* in the environment) redirects the
 * configured identity to other bytes (the identity is the CONFIGURED URL); the git-guard bypasses; no cryptographic attestation.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { repositoryOf, pinnedTool, sameRepository } from './engine-ci.mjs';
import { verifyBase, authGit } from './engine-base.mjs';
import { assuranceOf } from './engine-dag.mjs';

export { authGit };

export const IDENTITY_CODES = Object.freeze(['identity_unbound', 'identity_changed', 'remote_ambiguous', 'pr_required', 'pr_state', 'pr_base_mismatch', 'pr_head_mismatch',
  'pr_repo_mismatch', 'pr_unavailable', 'publication_mismatch', 'assurance_relaxed']);
export const STAGES = Object.freeze(['review', 'ship-ready', 'publish', 'ci', 'complete']);
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const no = (code, reason) => ({ ok: false, code, reasons: [reason] });

const out = (r) => (r.status === 0 ? r.stdout.trim() : null);

/** EVERY configured value of `key` (all scopes): { ok: true, values } ([] when unset, git exit 1) | { ok: false, reason } (any other failure). */
function configAll(repoRoot, key) {
  const r = spawnSync('git', ['config', '--get-all', key], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  if (r.status === 1 && !r.error) return { ok: true, values: [] };
  if (r.status !== 0 || r.error) return { ok: false, reason: `git config --get-all ${key} failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()})` };
  return { ok: true, values: r.stdout.split('\n').map(s => s.trim()).filter(Boolean) };
}

/**
 * R0-S round 5 (item 1): THE reader of a remote's repository identity. A remote NAME must be unambiguous: exactly one configured
 * remote.<name>.url (git fetch and ls-remote use the FIRST of several, git push uses ALL of them) and at most one remote.<name>.pushurl
 * (git push uses ALL push URLs), naming the same repository as the URL. Several fetch URLs, several push URLs, or a push URL of another
 * repository are `remote_ambiguous`: the engine never selects one of several conflicting values. Read from the CONFIGURED values (before
 * any insteadOf rewrite: a documented residual). A URL (`git push <url>`, the hook's $1 when no remote names it) is parsed as given.
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
/** The identity alone (null when none or ambiguous): callers that must tell ambiguity apart use remoteIdentity. */
export function readIdentity(repoRoot, remote = 'origin') {
  const r = remoteIdentity(repoRoot, remote);
  return r.ok ? r.identity : null;
}

/** Whether two identities name the same host/owner/repo (GitHub names are case-insensitive). */
export const sameIdentity = (a, b) => Boolean(a && b) && sameRepository(a, b);
/** The identity record enroll keeps (no URL: the configured URL may be re-spelled; the repository may not change). */
export const identityRecord = (id) => (id ? { remote_name: id.remote_name, host: id.host, owner: id.owner, repo: id.repo, slug: id.slug } : null);

/** The canonical JSON a publication id is the digest of (keys sorted at every level). */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The publication tuple and its id. `pr` is { number, head_repo, base_repo, base_ref } or null (branch-only). */
export function publicationOf({ identity, branch, head, tree, base, candidate_id, pr }) {
  const tuple = { identity: identity ? identity.slug.toLowerCase() : null, destination_ref: `refs/heads/${branch}`, head, tree,
    base: base ? { ref: base.ref, sha: base.sha, merge_base: base.merge_base } : null, candidate_id,
    pr: pr ? { number: pr.number, head_repo: String(pr.head_repo).toLowerCase(), base_repo: String(pr.base_repo).toLowerCase(), base_ref: pr.base_ref } : null };
  return { tuple, publication_id: 'sha256:' + createHash('sha256').update(canonical(tuple)).digest('hex') };
}

/**
 * The base ref of record for a new freeze: config.base when it names a branch, else the remote's default branch as the REMOTE names it
 * (`git ls-remote --symref <remote> HEAD`, read once here; never refs/remotes/<remote>/HEAD). -> { ok, ref } | refusal
 */
export function resolveBaseRef(S, repoRoot, remote) {
  if (S?.config?.base && S.config.base !== 'HEAD') return { ok: true, ref: S.config.base };
  const r = authGit(repoRoot, ['ls-remote', '--symref', remote, 'HEAD']);
  if (r.status !== 0) return no('base_remote_unavailable', `git ls-remote --symref ${remote} HEAD failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}): the default branch cannot be resolved`);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(r.stdout);
  return m ? { ok: true, ref: m[1] } : no('base_remote_unavailable', `remote ${remote} names no default branch (ls-remote --symref HEAD): bind config.base`);
}

/** The enrolled identity against the remote now (`remote`: the given push remote or URL, else the recorded remote name). */
function identityNow(S, repoRoot, remote, required) {
  const rec = S?.enrollment?.identity ?? null;
  if (!rec) return required ? no('identity_unbound', 'the enrollment recorded no repository identity (no GitHub origin at enroll): nothing is published, collected or completed for an unbound run; start a new run with origin configured') : { ok: true, identity: null };
  const name = remote ?? rec.remote_name;
  const read = remoteIdentity(repoRoot, name);
  if (!read.ok) return read; // remote_ambiguous (round 5): never one of several values
  const cur = read.identity;
  if (!sameIdentity(cur, rec)) return no('identity_changed', `${name} now names ${cur?.slug ?? 'no GitHub repository'}; this run enrolled ${rec.slug} (remote ${rec.remote_name}): `
    + 'a release never targets another repository than the one enrolled (restore the remote URL, or start a new run)');
  return { ok: true, identity: rec, remote: name };
}

/**
 * Capture a freeze base (review dispatch, or gate review under a policy with no dispatch): the base ref of record and the commit the remote
 * names for it now, with merge-base(HEAD, that commit). -> { ok, base: { remote, identity, ref, sha, merge_base } | null } | refusal.
 * With no identity recorded and config.base HEAD there is nothing to verify against: base null (publish refuses identity_unbound later).
 */
export function captureBase(S, repoRoot, { localMergeBase } = {}) {
  const id = identityNow(S, repoRoot, undefined, false);
  if (!id.ok) return id;
  const branch = Boolean(S?.config?.base) && S.config.base !== 'HEAD';
  if (!id.identity) return branch ? no('base_unverified', `no repository identity was recorded at enroll: the base ${S.config.base} cannot be verified on a remote (a local ref is never the base authority)`) : { ok: true, base: null };
  const ref = resolveBaseRef(S, repoRoot, id.remote);
  if (!ref.ok) return ref;
  const v = verifyBase(repoRoot, { ref: ref.ref, remote: id.remote, identity: id.identity, ...(branch ? { localMergeBase } : {}) });
  return v.ok ? { ok: true, base: baseRecord(v.base) } : v;
}
const baseRecord = ({ remote, identity, ref, sha, merge_base }) => ({ remote, identity, ref, sha, merge_base });

/**
 * Re-verify a freeze base captured earlier for the same review execution (a later dispatch of it, before any original is accepted): the
 * enrolled identity, and the remote base descending from the frozen commit (a rewind is base_moved_remote). The same merge base keeps the
 * recorded base (an advance only); a moved merge base (the branch merged or rebased onto the base) re-captures it (`refrozen`): the
 * receipts of the earlier base then never pair with the new ones (review_receipt_base) and a FAIL of the earlier base still binds
 * (review_fail_unconsumed) until the owner RETRY names it. -> { ok, base, refrozen? } | refusal
 */
export function verifyFrozenBase(S, repoRoot, recorded, localMergeBase) {
  const id = identityNow(S, repoRoot, undefined, false);
  if (!id.ok) return id;
  if (!recorded) return id.identity ? no('base_unverified', 'the execution froze no base while an identity is recorded') : { ok: true, base: null };
  const branch = Boolean(S?.config?.base) && S.config.base !== 'HEAD';
  const v = verifyBase(repoRoot, { ref: recorded.ref, remote: id.remote ?? recorded.remote, identity: id.identity, recorded, ...(branch ? { localMergeBase } : {}) });
  if (!v.ok) return v;
  if (v.base.merge_base !== recorded.merge_base) { const c = captureBase(S, repoRoot, { localMergeBase }); return c.ok ? { ...c, refrozen: true } : c; }
  return { ok: true, base: recorded };
}

/** A live PR (REST shape, `prFromRest`) against a publication: null when every row holds, else the refusal. */
export function prRows(view, pub, identity) {
  if (!view) return no('pr_unavailable', 'the PR could not be read');
  const want = pub.pr ?? null;
  if (want && view.number !== want.number) return no('publication_mismatch', `PR #${view.number} is not the publication's PR #${want.number}`);
  if (view.state !== 'open' || view.merged === true) return no('pr_state', `PR #${view.number} is ${view.merged ? 'merged' : view.state ?? 'in an unknown state'}: only an OPEN PR completes (the owner merges after complete)`);
  if (!view.base_repo || !view.head_repo || view.base_repo.toLowerCase() !== identity.slug.toLowerCase() || view.head_repo.toLowerCase() !== identity.slug.toLowerCase())
    return no('pr_repo_mismatch', `PR #${view.number} is ${view.head_repo ?? '?'} -> ${view.base_repo ?? '?'}; the run enrolled ${identity.slug} (head and base)`);
  if (view.head_sha !== pub.head || view.head_ref !== pub.branch) return no('pr_head_mismatch', `PR #${view.number} heads ${view.head_ref ?? '?'} at ${view.head_sha ?? '?'}; published ${pub.branch} at ${pub.head}`);
  if (view.base_ref !== pub.release_base?.ref || (want && view.base_ref !== want.base_ref)) return no('pr_base_mismatch', `PR #${view.number} targets ${view.base_ref ?? '?'}; the reviewed base is ${pub.release_base?.ref ?? '?'} (a retargeted PR never completes)`);
  return null;
}
/** The PR fields a publication binds, from a verified view. */
export const prBinding = (view) => ({ number: view.number, head_repo: view.head_repo, base_repo: view.base_repo, base_ref: view.base_ref, url: view.url ?? null });

/** The gh pinned at enroll, verified (no later pin authorizes release). */
const ghPinned = (S) => { const g = pinnedTool(S?.enrollment?.tools?.gh); return g.ok ? { ok: true, path: g.path } : no(g.code, g.reason); };

/**
 * THE authority. `stage`: 'review' | 'ship-ready' | 'publish' | 'ci' | 'complete'. Read-only (authorize, the hook and `next` are lock-free).
 * args: { S, repoRoot, kind? (review), recorded? (review original: the receipts' freeze base; null under a no-dispatch policy),
 *   localMergeBase? (the candidate's merge base, compared in branch mode), remote? (publish: the push remote or URL), pub? (ci/complete),
 *   view? (ci/complete: the PR read for pub; complete reads it LIVE), inProcess? (an in-process CI provider: no gh needed) }
 * -> { ok: true, identity, base? } | { ok: false, code, reasons }
 */
export function verifyReleaseBinding(stage, a) {
  const { S, repoRoot } = a;
  if (!STAGES.includes(stage)) throw new Error(`verifyReleaseBinding: unknown stage ${stage}`);
  if (!S?.enrollment) return no('identity_unbound', 'the run is not enrolled: no release identity is recorded');
  const late = ['publish', 'ci', 'complete'].includes(stage);
  const id = identityNow(S, repoRoot, stage === 'publish' ? a.remote : undefined, late);
  if (!id.ok) return id;
  const branch = Boolean(S.config?.base) && S.config.base !== 'HEAD';
  // ---- the base of record, re-verified on the remote (both modes) -------------------------------------------------------------------
  let recorded;
  if (stage === 'review') recorded = a.kind === 'original' ? a.recorded : S.freeze?.base ?? null;
  else if (stage === 'ship-ready') recorded = S.freeze?.base ?? null;
  else recorded = S.ship_ready?.base ?? null;
  let base = null;
  const needBase = branch || Boolean(id.identity);
  if (needBase) {
    if (!recorded?.sha || !recorded.ref) {
      if (stage === 'review' && a.kind === 'original' && a.recorded === null) { // a policy with no dispatch: the gate freezes here
        const c = captureBase(S, repoRoot, { localMergeBase: a.localMergeBase });
        if (!c.ok) return c;
        return { ok: true, identity: id.identity, base: c.base };
      }
      return no('base_unverified', `no verified base commit is recorded for this ${stage === 'publish' || late ? 'SHIP_READY' : 'review freeze'} (frozen before base verification, or the record was lost): `
        + 'run gate ship-ready again; a freeze without one needs an owner RETRY');
    }
    if (branch && recorded.ref !== S.config.base) return no('base_unverified', `the recorded base is ${recorded.ref}, config.base is ${S.config.base}`);
    if (id.identity && recorded.identity && recorded.identity !== id.identity.slug.toLowerCase())
      return no('identity_changed', `the base was frozen on ${recorded.identity}; this run enrolled ${id.identity.slug}`);
    // A remote base that advanced is accepted when it descends from the frozen commit (verifyBase) and the merge base is unchanged: the
    // reviewed range is judged by review freshness at the gates (review_base_moved / review_stale) and by base_mismatch against the
    // SHIP_READY merge base at authorize publish and complete.
    const v = verifyBase(repoRoot, { ref: recorded.ref, remote: id.remote ?? recorded.remote, identity: id.identity, recorded, ...(branch ? { localMergeBase: a.localMergeBase } : {}) });
    if (!v.ok) return v;
    base = v.base;
  }
  if (!late) return { ok: true, identity: id.identity, base };
  // ---- publication, PR, CI identity (ci, complete) ----------------------------------------------------------------------------------
  if (stage === 'publish') return { ok: true, identity: id.identity, base };
  if (!a.inProcess) { const g = ghPinned(S); if (!g.ok) return g; }
  const pub = a.pub;
  if (!pub?.publication_id || !pub.identity || !pub.release_base) return no('identity_unbound', `the PUBLISHED record of ${pub?.head ?? 'HEAD'} carries no publication identity (published before R0-S round 4): publish again`);
  if (pub.identity !== id.identity.slug.toLowerCase()) return no('publication_mismatch', `the publication is of ${pub.identity}; this run enrolled ${id.identity.slug}`);
  if (publicationOf({ identity: id.identity, branch: pub.branch, head: pub.head, tree: pub.tree, base: pub.release_base, candidate_id: pub.candidate_id, pr: pub.pr }).publication_id !== pub.publication_id)
    return no('publication_mismatch', `the PUBLISHED record of ${pub.head} does not match its publication id (an edited record)`);
  if (stage === 'ci') {
    if (a.view !== undefined) { const r = prRows(a.view, pub, id.identity); if (r) return r; } // a PR named but unreadable: pr_unavailable
    return { ok: true, identity: id.identity, base };
  }
  // complete: cumulative (the caller ran the publish conjunction first), then the publication now, assurance, the PR live.
  if (assuranceOf(S).level !== 'STRICT') return no('assurance_relaxed', `the run is RELAXED (${JSON.stringify(assuranceOf(S).relaxed)}${assuranceOf(S).unbound_reviews.length ? `; unbound reviews: ${assuranceOf(S).unbound_reviews.join(', ')}` : ''}): a relaxed run never completes`);
  const now = publicationOf({ identity: id.identity, branch: pub.branch, head: pub.head, tree: pub.tree, base: S.ship_ready?.base, candidate_id: S.ship_ready?.candidate_id, pr: pub.pr });
  if (now.publication_id !== pub.publication_id) return no('publication_mismatch', `the reviewed release (SHIP_READY candidate and base) is not the one published as ${pub.publication_id}: publish the current SHIP_READY`);
  if (!pub.pr) return no('pr_required', `the publication of ${pub.head} has no verified PR: authoritative completion needs one (publish --pr-title, or ci --pr <n>)`);
  const r = prRows(a.view ?? null, pub, id.identity);
  if (r) return r;
  return { ok: true, identity: id.identity, base };
}
