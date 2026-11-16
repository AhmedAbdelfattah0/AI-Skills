/**
 * Enrollment, admission and publication for the durable run engine (P0 slices E1 and E4). Node
 * built-ins only. The commands are run-engine.mjs enroll|context|authorize|publish; the records live
 * in the engine state (`state.enrollment`, `state.contexts`, `state.published`), so `resume` and
 * `archive` carry them and nothing outside the engine's own ledger is ever read as authority.
 *
 * Lifecycle (each a distinct, reported state; `lifecycle()`):
 *   none          no engine state: `context` delivers unrecorded, nothing else runs
 *   unactivated   `init` created the run (plan approval and DAG binding verified); not enrolled
 *   enrolled      `enroll` pinned the skill (plan approval re-verified); a phase context is missing
 *   admitted      the `build` context was delivered from the pinned skill: drive, carrier dispatch, gate red
 *   evidence      an engine SHIP_READY still holds for the current candidate
 *   publication   `authorize publish` allows (computed, never stored)
 * Enforced entry points: drive and carrier.mjs dispatch need `admitted` (stage build); gate needs
 * the gate's phase context (red: build, review/unit-review/reassess: review, ship-ready: ship) and
 * otherwise returns a refusal that records no decision; publish needs `publication`; `authorize complete`
 * is CUMULATIVE (round 4): the whole publish conjunction again, then the release identity (engine-identity.mjs: publication_id,
 * STRICT assurance, a verified PR read LIVE read-only with the pinned gh) and a CI_EVIDENCE PASS of exactly that publication. `init` is the
 * bootstrap and needs only the approved plan. status, resume, mark, rebind, archive and `context`
 * are not gated.
 *
 * Skill pin (enroll): ONLY references/ (through the context manifest) and the SKILL.md digest are
 * pinned. In a git install the pin is the skill commit (`gitReader`): every delivery reads that
 * commit's blobs, so a later work-tree edit of the skill changes nothing delivered. In a copy install
 * the pin is the manifest digest: a later delivery re-verifies the files and refuses any change.
 * Enrollment is once per run, refused while an attempt may still run, and in a copy install refused
 * once any attempt has run. The engine's scripts are NOT pinned: they run from disk as installed.
 * The trust anchor is state.json, which any process of the same user can write; and when the target
 * repository is the skill repository itself, a worker can commit to and so rewrite the pinned source.
 *
 * No degraded or owner-approved bypass exists. The engine has no channel that proves a human said
 * something (START, RETRY and waivers are orchestrator-appended RUN-STATE lines, trusted against
 * dispatched code, not against the orchestrator), so a degradation is a refusal: WAIT_FOR_USER.
 *
 * Residual (same user, not a boundary): a process running as the user can rewrite the engine state
 * or the skill's git history, import these modules and call the seams directly, or push with git/gh.
 *
 * R0-S repair batch. Closed or refused on the SUPPORTED paths (commands, config files, HOME, PATH, ordering):
 *   history_unavailable        a failed or overflowing history listing (never read as empty; 256 MiB buffer)
 *   push_destination_mismatch / push_to_default_branch / cross_ticket_push   git-guard binds the destination ref
 *   review_binding_missing / review_provenance_unbound   an authorizing review without a freshness binding, or not
 *                              engine-dispatched under the strict policy, never authorizes publish
 *   policy_unapproved          a relaxed assurance setting (reviewProvenance, acceptNativeReview, ciRequiredChecks,
 *                              ciNoChecksMinutes) without the plan binding and the approved policy line (engine-dag.mjs)
 *   policy_drift / config_drift  the state's config is not the bound DAG's (DETECTED before every command)
 *   enrollment_repo_unknown / enrollment_branch_unknown   no captured repository or branch is never a wildcard
 *   gh_unpinned / gh_drift     `ci` and `publish --pr-title` run only the gh pinned at enroll (path + sha256)
 *   ci_head_unverified / ci_remote_moved   complete needs CI evidence that verified the branch head, and the remote
 *                              branch still at that head
 * R0-S batch 2: pr_base_unbound (a --base or recorded intent base other than the bound one: config.base, else the remote default
 * branch; the history check runs from the SHIP_READY merge base), review_fail_unconsumed / review_dispatch_live at authorize publish
 * (engine-review-dispatch.mjs openReviewFail), ci_repo_mismatch at complete (PUBLISHED.repository, engine-ci.mjs), pr_repo_unknown.
 * R0-S round 3 (N-BASE): base_unverified / base_remote_unavailable / base_moved_local / base_moved_remote (engine-base.mjs): the merge
 * base is measured from the commit the remote names for the base (ls-remote), recorded at the review freeze with the repository
 * identity, re-verified at ship-ready and here; a local base ref (config.base branch, or origin/<default>) is never the authority.
 * R0-S round 4 (engine-identity.mjs, ONE verifier): enroll records the repository identity and pins gh (no late pin); the PR base is the
 * base of record frozen before review in both modes (never refs/remotes/<r>/HEAD; remote_unconfigured / pr_base_required are gone);
 * identity_unbound, identity_changed, publication_mismatch, pr_required, pr_state, pr_*_mismatch, pr_unavailable, assurance_relaxed.
 * Still the same-user residual (documented, not closed): rewriting state.json, the ledgers, a relay or launcher output
 * TOGETHER with the digests that bind them; replacing the relay or gh BEFORE their pin (the pin trusts that moment's
 * home and PATH); importing the modules and calling the in-process seams (ctx.ciProvider, ctx.relayHome); `git` itself
 * is resolved through PATH everywhere; the git-guard bypasses in git-guard.mjs; turn-end enforcement (no Stop hook in R0-S).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as io from './engine-io.mjs';
import { coded, assuranceOf } from './engine-dag.mjs';
import { LIVE } from './engine-quiesce.mjs';
import { checkShipReady } from './ship-ready-check.mjs';
import { reviewFreshness } from './engine-freshness.mjs';
import { openReviewFail } from './engine-review-dispatch.mjs';
import { ciAuthorize, resolveTool, pinnedTool, remoteHeadOf, ghEnv, ghProvider, prNumberOf } from './engine-ci.mjs';
import { authGit } from './engine-base.mjs';
import { verifyReleaseBinding, remoteIdentity, identityRecord, publicationOf, prRows, prBinding } from './engine-identity.mjs';
import { deliverPhase, verifySkill, fsReader, gitReader, SKILL_DIR, PHASES, sha256, MANIFEST_REL } from './context-manifest.mjs';

export const AUTHORIZE_SCHEMA = 'ship-ticket-authorize-v1';
export const STAGES = Object.freeze(['build', 'publish', 'complete']);
/** The context phase each stage and gate needs, delivered from the pinned skill. */
export const STAGE_PHASE = Object.freeze({ build: 'build', publish: 'ship', complete: 'ship',
  red: 'build', review: 'review', 'unit-review': 'review', reassess: 'review', 'ship-ready': 'ship' });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The remote enroll reads the run's repository identity from (once; engine-identity.mjs remoteIdentity). */
export const IDENTITY_REMOTE = 'origin';

const gitOut = (repo, args, env) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000, ...(env ? { env } : {}) });
  return r.status === 0 ? r.stdout.trim() : null;
};
/** An authoritative read (merge base, tree): replacement objects off (E-a). */
const authOut = (repo, args) => { const r = authGit(repo, args, { timeout: 30000 }); return r.status === 0 ? r.stdout.trim() : null; };
/** The history listing's buffer: far above any real branch; past it the call fails and the caller refuses. */
export const HISTORY_MAX_BUFFER = 256 * 1024 * 1024;
/**
 * The paths every commit of `range` touched (NUL-separated, no renames) -> { ok: true, paths } | { ok: false, reason }.
 * A non-zero exit, a spawn error or a buffer overflow (ENOBUFS) is { ok: false }: never read as an empty history.
 */
export function historyPaths(repo, range, { spawn = spawnSync, maxBuffer = HISTORY_MAX_BUFFER } = {}) {
  const r = spawn('git', ['--no-replace-objects', 'log', '--format=', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', range], { cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  if (r.error || r.status !== 0) return { ok: false, reason: (r.error?.code ?? r.error?.message ?? (r.stderr || `git log exited ${r.status}`)).toString().trim() };
  return { ok: true, paths: r.stdout.split('\0').map(p => p.replace(/^\n/, '')).filter(Boolean) };
}
const refusal = (code, reason, lifecycle) => ({ ok: false, code, reasons: [reason], lifecycle });
const NEW_RUN = 'operator path: start a new run (new run id, START, init, enroll)';

/** Whether `branch` names `ticket` as a whole token (T-1 in T-1-work or feat/T-1, not in T-10-x); case-insensitive. */
export function branchNames(branch, ticket) {
  const b = String(branch ?? '').toUpperCase(), k = String(ticket).toUpperCase();
  for (let i = b.indexOf(k); i >= 0; i = b.indexOf(k, i + 1)) {
    const before = i === 0 ? '' : b[i - 1], after = b[i + k.length] ?? '';
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
  }
  return false;
}

/** The reader a new enrollment pins: the skill commit when the skill is committed in git, else its files. */
export function currentReader(skillDir = SKILL_DIR) {
  const g = gitReader(skillDir);
  return g && !g.missing && g.read(MANIFEST_REL) ? g : fsReader(skillDir);
}

/** The reader an enrollment pinned. */
const pinnedReader = (en, skillDir) => (en.mode === 'git' ? gitReader(skillDir, en.skill_revision) ?? { mode: 'git', revision: en.skill_revision, missing: true } : fsReader(skillDir));

/** Verify the skill exactly as enrolled (git: the pinned commit; copy: the files, against the enrolled manifest digest). */
const pinCache = new Map(); // git pins are immutable commits: verify each once per process
function pinnedSkill(en, skillDir) {
  const key = en.mode === 'git' ? `${skillDir}\u0000${en.skill_revision}\u0000${en.manifest_digest}\u0000${en.skill_digest}` : null;
  if (key && pinCache.has(key)) return pinCache.get(key);
  const reader = pinnedReader(en, skillDir);
  const v = verifySkill(skillDir, reader);
  let out;
  if (v.code === 'manifest_phases_changed') out = refusal('skill_drift', `the installed engine scripts expect other mandatory references than the skill this run enrolled (a skill update changed PHASE_REFS); ${NEW_RUN}`);
  else if (!v.ok) out = v;
  else if (v.digest !== en.manifest_digest) out = refusal('manifest_drift', `the skill manifest is ${v.digest}, the run enrolled ${en.manifest_digest}; ${NEW_RUN}`);
  else {
    const skill = reader.read('SKILL.md');
    out = !skill || sha256(skill) !== en.skill_digest ? refusal('skill_drift', `SKILL.md is not the one this run enrolled (a skill update or edit); ${NEW_RUN}`) : { ...v, reader };
  }
  if (key && out.ok) pinCache.set(key, out);
  return out;
}

const live = (S) => (S.attempts ?? []).filter(a => LIVE.includes(a.status)).map(a => a.attempt_id);

/**
 * `enroll` (inside the engine lock, after the binding verified): pin the skill to the run. Idempotent
 * for the same pin; another pin is enrollment_conflict. Refused while an attempt may run, and in a
 * copy install once any attempt has run.
 */
export function enrollIn(E, skillDir = SKILL_DIR) {
  const { S, ctx } = E;
  if (live(S).length) throw coded('attempts_live', `attempts may still run (${live(S).join(', ')}); resume first`);
  const reader = currentReader(skillDir);
  const v = verifySkill(skillDir, reader);
  if (!v.ok) throw coded(v.code, v.reasons.join('; '));
  const skill = reader.read('SKILL.md');
  if (!skill) throw coded('skill_missing', 'SKILL.md is missing from the skill');
  const pin = { mode: reader.mode, skill_revision: reader.revision, skill_digest: sha256(skill), manifest_digest: v.digest };
  if (S.enrollment) {
    if (['mode', 'skill_revision', 'skill_digest', 'manifest_digest'].every(k => S.enrollment[k] === pin[k])) return { already: true, enrollment: S.enrollment };
    throw coded('enrollment_conflict', `run ${S.run_id} is enrolled to ${S.enrollment.skill_revision ?? S.enrollment.manifest_digest}; a skill change mid-run is not re-pinned; ${NEW_RUN}`);
  }
  if (reader.mode === 'copy' && (S.attempts ?? []).length)
    throw coded('enrollment_after_execution', `this run already executed ${S.attempts.length} attempt(s) without enrollment and the skill is a copy install, whose files those attempts could have written; ${NEW_RUN}`);
  // R0-S round 5 (item 1): an ambiguous origin (several fetch or push URLs, a push URL of another repository) is never enrolled.
  const remote = remoteIdentity(ctx.repoRoot, IDENTITY_REMOTE);
  if (!remote.ok) throw coded(remote.code, remote.reasons.join('; '));
  S.enrollment = { run_id: S.run_id, ticket: S.ticket, repo: gitOut(ctx.repoRoot, ['rev-parse', '--show-toplevel']),
    branch: gitOut(ctx.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']), head: gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    // R0-S round 4 (D1): the repository identity, read ONCE here by the one reader; gh pinned here or never.
    identity: identityRecord(remote.identity),
    tools: { gh: resolveTool('gh', ctx.env ?? process.env) }, ...pin, attempts_before: (S.attempts ?? []).length, at: new Date().toISOString() };
  S.contexts = {};
  return { already: false, enrollment: S.enrollment };
}

/** `context` delivery: from the pinned skill when enrolled, else from the skill as installed now (unrecorded). */
export function deliver(S, phase, skillDir = SKILL_DIR) {
  if (!PHASES.includes(phase)) throw coded('bad_input', `--phase must be one of ${PHASES.join(', ')}`);
  if (!S?.enrollment) return deliverPhase(phase, skillDir, currentReader(skillDir));
  const p = pinnedSkill(S.enrollment, skillDir);
  if (!p.ok) return p;
  const d = deliverPhase(phase, skillDir, p.reader);
  return d.ok ? { ...d, record: { revision: p.reader.revision, manifest_digest: d.digest, inventory: d.inventory, at: new Date().toISOString() } } : d;
}

/** Record a delivered context in the state (inside the lock). Refused while an attempt may run. */
export function recordContext(S, phase, record) {
  if (live(S).length) throw coded('attempts_live', `attempts may still run (${live(S).join(', ')}); the delivery was not recorded`);
  S.contexts = { ...(S.contexts ?? {}), [phase]: record };
}

/**
 * Admission of the run held by state `S` for a stage or gate kind: enrolled for this run, the
 * pinned skill still verifies, and the phase context was delivered from it. -> { ok, code, reasons, lifecycle }
 */
export function admission(S, stage, skillDir = SKILL_DIR) {
  const en = S?.enrollment;
  if (!en || en.run_id !== S.run_id) return refusal('not_enrolled', `run ${S?.run_id} is not enrolled; run run-engine.mjs enroll (after init)`, 'unactivated');
  const phase = STAGE_PHASE[stage];
  const p = pinnedSkill(en, skillDir);
  if (!p.ok) return { ok: false, code: p.code, reasons: p.reasons, lifecycle: 'enrolled' };
  const want = p.manifest.phases[phase].map(f => ({ path: f, sha256: p.manifest.files[f] }));
  const c = S.contexts?.[phase];
  if (!c) return refusal('context_missing', `no ${phase} context delivered for this run; run run-engine.mjs context --phase ${phase}`, 'enrolled');
  if (c.manifest_digest !== en.manifest_digest || c.revision !== (en.mode === 'git' ? en.skill_revision : null) || JSON.stringify(c.inventory) !== JSON.stringify(want))
    return refusal('context_stale', `the recorded ${phase} context is not the pinned skill's; run context --phase ${phase} again`, 'enrolled');
  return { ok: true, code: 'admitted', reasons: [], lifecycle: 'admitted' };
}

/** Why the recorded SHIP_READY no longer holds in state terms ([] when it does). */
export function supersededBy(S) {
  const last = (S.review_chain ?? []).at(-1), c = S.ship_ready?.candidate_id;
  return [
    !(last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' && last.candidate_id === c) && 'the last review is not a PASS of the ship-ready candidate',
    (S.repairs ?? []).some(r => ['pending', 'running'].includes(r.state)) && 'a repair is open',
    (S.judgments ?? []).length > 0 && 'judgments are unresolved',
    live(S).length > 0 && 'attempts may still run',
    S.local_proof?.candidate_id !== c && 'the local proof is not of the ship-ready candidate',
  ].filter(Boolean);
}

/** Lifecycle of a loaded state (status/authorize diagnostics). */
export function lifecycle(S, skillDir = SKILL_DIR) {
  if (!S) return 'none';
  const a = admission(S, 'build', skillDir);
  if (!a.ok) return a.lifecycle;
  return S.ship_ready?.candidate_id && !supersededBy(S).length ? 'evidence' : 'admitted';
}

/**
 * `authorize --stage build|publish|complete`: read-only and lock-free (the pre-push hook calls it
 * while `publish` pushes). `readEngine(ctx)` -> { S, unbound } | { code, reasons }.
 * A publish allow names the head commit, its tree, the candidate and the branch it covers.
 */
export async function authorize(ctx, readEngine) {
  if (!STAGES.includes(ctx.stage)) throw coded('bad_input', `--stage must be one of ${STAGES.join(', ')}`);
  const base = { schema: AUTHORIZE_SCHEMA, stage: ctx.stage, ticket: ctx.ticket, run_id: ctx.runId };
  const deny = (code, reasons, lc) => ({ ...base, allow: false, code, reasons, lifecycle: lc });
  const eng = readEngine(ctx);
  if (eng.code) return deny(eng.code === 'no_state' ? 'not_enrolled' : eng.code, eng.reasons, eng.code === 'no_state' ? 'none' : 'unknown');
  const S = eng.S;
  if (eng.unbound.length) return deny(eng.unbound[0].code, eng.unbound.map(j => j.reason), lifecycle(S));
  const a = admission(S, ctx.stage);
  if (!a.ok) return deny(a.code, a.reasons, lifecycle(S));
  if (ctx.stage === 'build') return { ...base, allow: true, code: 'allow', reasons: [], lifecycle: lifecycle(S) };
  const head = gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (ctx.stage === 'complete') {
    const pub = (S.published ?? []).findLast(p => p.head === head);
    if (!pub) return deny('publish_evidence_missing', [`no PUBLISHED record for HEAD ${head}; ship through run-engine.mjs publish`], lifecycle(S));
    // R0-S round 4 (D3): CUMULATIVE: the whole publish conjunction (review, repair, candidate, base, history) holds now, not only CI.
    const core = publishCore(ctx, S, head, deny);
    if (!core.allow) return core;
    // The PR is read LIVE (read-only, the pinned gh, the enrolled repository) for the verifier's PR rows.
    const view = livePr(ctx, S, pub);
    const vr = verifyReleaseBinding('complete', { S, repoRoot: ctx.repoRoot, pub, view, inProcess: Boolean(ctx.ciProvider) });
    if (!vr.ok) return deny(vr.code, vr.reasons, 'publication');
    // P0 E6-min: CI PASS recorded by run-engine.mjs ci for exactly this publication (engine-ci.mjs ciAuthorize, publication_id).
    const c = ciAuthorize(S, pub);
    if (!c.ok) return deny(c.code, c.reasons, 'publication');
    // R0-S N3: and the published branch still points at that head now (a push after the collection moved what the PR ships).
    const now = remoteHeadOf(ctx.repoRoot, pub);
    if (!now.ok) return deny('remote_unavailable', [`the published branch could not be read: ${now.error}`], 'publication');
    if (now.head !== pub.head) return deny('ci_remote_moved', [`the remote branch ${pub.branch} is ${now.head ?? 'gone'}, the published (and CI-verified) head is ${pub.head}: publish the new head and collect its CI`], 'publication');
    return { ...base, allow: true, code: 'allow', reasons: [], lifecycle: 'publication',
      binding: { head, publication_id: pub.publication_id, pr: pub.pr.number, assurance: assuranceOf(S).level, ci: { state: c.evidence.state, collected_at: c.evidence.collected_at, checks: c.evidence.checks.length, required: c.evidence.required } } };
  }
  return publishCore(ctx, S, head, deny);
}

/** The live PR of publication `pub` for complete (null when none is recorded, gh is not the pinned one, or the read failed: the verifier refuses). */
function livePr(ctx, S, pub) {
  if (!pub?.pr?.number || !S.enrollment?.identity) return null;
  let provider = ctx.ciProvider;
  if (!provider) {
    const gh = pinnedTool(S.enrollment.tools?.gh);
    if (!gh.ok) return null;
    provider = ghProvider({ repoRoot: ctx.repoRoot, env: ctx.env ?? process.env, bin: gh.path, repository: S.enrollment.identity });
  }
  const v = provider.pullRequest(pub.pr.number);
  return v?.ok ? v.pr : null;
}

/**
 * The publish conjunction (authorize publish; and, cumulatively, authorize complete). Read-only and lock-free.
 * A publish allow names the head commit, its tree, the candidate, the branch and the base of record it covers.
 */
function publishCore(ctx, S, head, deny) {
  const base = { schema: AUTHORIZE_SCHEMA, stage: ctx.stage, ticket: ctx.ticket, run_id: ctx.runId };
  if (!S.ship_ready?.candidate_id) return deny('ship_ready_missing', ['no engine SHIP_READY for this run; run gate ship-ready'], lifecycle(S));
  if (!S.ship_ready.merge_base) return deny('ship_ready_regate', ['this SHIP_READY predates the recorded merge base (an engine update); run gate ship-ready again'], lifecycle(S));
  const superseded = supersededBy(S);
  if (superseded.length) return deny('ship_ready_superseded', superseded, lifecycle(S));
  // R0-S batch 2 (item 2c): an ungated reviewer FAIL (or a running reviewer) of the authorizing review's owed review blocks publish.
  const open = openReviewFail(S);
  if (open) return deny(open.code, [open.reason], 'evidence');
  const top = gitOut(ctx.repoRoot, ['rev-parse', '--show-toplevel']);
  // R0-S N7: an enrollment whose repository or branch was not captured is never a wildcard.
  if (!S.enrollment.repo) return deny('enrollment_repo_unknown', ['the enrollment recorded no repository (git failed at enroll): start a new run'], 'evidence');
  if (S.enrollment.repo !== top) return deny('enrollment_repo_mismatch', [`enrolled in ${S.enrollment.repo}, authorizing in ${top}`], 'evidence');
  const branch = gitOut(ctx.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return deny('branch_detached', ['HEAD is detached; publish pushes the ticket branch'], 'evidence');
  if (!branchNames(branch, ctx.ticket)) return deny('branch_not_ticket', [`branch ${branch} does not name ticket ${ctx.ticket} as a whole token`], 'evidence');
  if (!S.enrollment.branch) return deny('enrollment_branch_unknown', ['the enrollment recorded no branch (a detached HEAD or a git failure at enroll): enroll on the ticket branch in a new run'], 'evidence');
  if (branchNames(S.enrollment.branch, ctx.ticket) && S.enrollment.branch !== branch)
    return deny('branch_mismatch', [`the run enrolled on ${S.enrollment.branch}, HEAD is ${branch}`], 'evidence');
  // R0-S round 4 (D1-D3): the enrolled repository identity (the push remote, or URL, names it), and the base of record bound to SHIP_READY
  // (frozen before the reviewer launched, both base modes), re-verified on the remote. The PR base is that record's ref: never a local
  // ref, never refs/remotes/<remote>/HEAD, never chosen on the command line (a --base or recorded intent naming another is pr_base_unbound).
  const configured = S.config?.base && S.config.base !== 'HEAD' ? S.config.base : null;
  const prBase = S.ship_ready.base?.ref ?? configured;
  const intent = S.publish_intent?.head === head && typeof S.publish_intent.base === 'string' ? S.publish_intent.base : null;
  for (const [src, given] of [['--base', ctx.base], ['the recorded publish intent', intent]]) {
    if (given != null && given !== prBase)
      return deny('pr_base_unbound', [`${src} names ${given}; the PR base bound at the review freeze is ${prBase ?? 'none'}: a PR base is never chosen on the command line`], 'evidence');
  }
  const mbLocal = configured ? authOut(ctx.repoRoot, ['merge-base', configured, 'HEAD']) : undefined;
  const vr = verifyReleaseBinding('publish', { S, repoRoot: ctx.repoRoot, remote: ctx.remote, localMergeBase: mbLocal });
  if (!vr.ok) return deny(vr.code, vr.reasons, 'evidence');
  const mb = vr.base.merge_base;
  if (mb !== S.ship_ready.merge_base) return deny('base_mismatch', [`the reviewed candidate is relative to ${S.ship_ready.merge_base}, but merge-base(${prBase} on the remote, HEAD) is ${mb}: the branch carries history the review did not cover`], 'evidence');
  const dirty = io.snapshot(ctx.repoRoot, S.pinned_exclusions ?? []);
  if (dirty === null) return deny('candidate_unavailable', ['git status failed'], 'evidence');
  if (Object.keys(dirty).length) return deny('tree_dirty', [`uncommitted candidate paths (the push would not be the reviewed bytes): ${Object.keys(dirty).sort().join(', ')}`], 'evidence');
  // The merge base recorded with SHIP_READY: with config.base HEAD the merge base moves at the commit, the recorded commit does not.
  const cand = io.candidateId(ctx.repoRoot, S.ship_ready.merge_base ?? S.config?.base ?? 'HEAD', S.pinned_exclusions ?? []);
  if (!cand.candidate_id) return deny('candidate_unavailable', [cand.reason], 'evidence');
  if (cand.candidate_id !== S.ship_ready.candidate_id) return deny('candidate_stale', [`SHIP_READY is for ${S.ship_ready.candidate_id}, the candidate now is ${cand.candidate_id}`], 'admitted');
  // E3: and against the merge base the authorizing review was bound to (a review is valid only for the bytes it covered).
  const fresh = reviewFreshness(S, ctx.repoRoot);
  if (fresh && !fresh.fresh) return deny(fresh.code, fresh.reasons, 'admitted');
  // History, not only the final tree: every PATH any commit since the merge base touched is a reviewed candidate path
  // (or an excluded one), so a later-reverted commit cannot carry an unreviewed path to the remote. This checks paths,
  // not bytes: an intermediate commit may still hold other, unreviewed bytes of a reviewed path (the final tree is
  // the reviewed one). A git log that fails or overflows its buffer is history_unavailable, never an empty history.
  const covered = new Set([...(cand.paths ?? []), ...(S.pinned_exclusions ?? [])]);
  const hist = historyPaths(ctx.repoRoot, `${S.ship_ready.merge_base}..HEAD`); // from the frozen review base, never a recomputed one
  if (!hist.ok) return deny('history_unavailable', [`the history since the merge base could not be inspected (${hist.reason}): nothing is published without it`], 'evidence');
  const outside = [...new Set(hist.paths.filter(p => !covered.has(p)))].sort();
  if (outside.length) return deny('history_outside_candidate', [`commits since the merge base touch ${outside.length} path(s) outside the reviewed candidate: `
    + `${outside.slice(0, 20).join(', ')}${outside.length > 20 ? `, ... (${outside.length - 20} more)` : ''}`], 'evidence');
  const plan = io.readIfExists(join(ctx.repoRoot, '.specs', 'plans', ctx.ticket + '.md')) ?? '';
  const log = io.readIfExists(io.gitPath(ctx.repoRoot, `ai-skills/ship-ticket/${ctx.ticket}.engine.jsonl`)) ?? '';
  const backed = checkShipReady(plan, log, { runId: ctx.runId, requireEvent: true });
  if (!backed.ok || !backed.shipReady.includes(cand.candidate_id))
    return deny('ship_ready_unbacked', [backed.reason || `RUN-STATE has no SHIP_READY for ${cand.candidate_id}; run resume to deliver the engine outbox`], 'evidence');
  return { ...base, allow: true, code: 'allow', reasons: [], lifecycle: 'publication',
    binding: { head, tree: authOut(ctx.repoRoot, ['rev-parse', 'HEAD^{tree}']), candidate_id: cand.candidate_id, branch, base: prBase, merge_base: mb, base_sha: vr.base.remote_head,
      identity: vr.identity.slug.toLowerCase(), assurance: assuranceOf(S).level } };
}

/**
 * `publish`: authorize publish, then authorize AGAIN immediately before the push and require the same
 * binding (head, tree, candidate, branch); push exactly that commit (`<sha>:refs/heads/<branch>`),
 * check the remote ref is that commit, open the PR only when a title and body file are given, and
 * record PUBLISHED. Before the push it records PUBLISH_INTENT { head, branch, base, remote } (`recordIntent`,
 * under the run lock): an explicit --base, so the pre-push hook's lock-free authorize resolves the same PR base.
 * Residual TOCTOU: the remote can still move after the check, and direct git/gh pushes never pass through
 * here. `ctx.beforePush` is a test seam run between the two authorizations.
 */
export async function publish(ctx, readEngine, recordPublished, recordIntent = async () => {}) {
  const remote = ctx.remote;
  if (remote !== undefined && !SAFE_REMOTE.test(remote)) throw coded('bad_input', '--remote must be a remote name');
  if ((ctx.prTitle === undefined) !== (ctx.prBodyFile === undefined) || (ctx.draft && ctx.prTitle === undefined))
    throw coded('bad_input', '--pr-title and --pr-body-file go together (--draft needs them)');
  if (ctx.prTitle !== undefined && (!ctx.prTitle.trim() || !existsSync(ctx.prBodyFile))) throw coded('bad_input', 'PR title must be non-empty and the body file must exist');
  const a = await authorize({ ...ctx, stage: 'publish' }, readEngine);
  if (!a.allow) return { published: false, ...a };
  if (ctx.beforePush) await ctx.beforePush();
  const again = await authorize({ ...ctx, stage: 'publish' }, readEngine);
  if (!again.allow) return { published: false, ...again };
  if (JSON.stringify(again.binding) !== JSON.stringify(a.binding))
    return { published: false, allow: false, code: 'authorization_moved', reasons: [`authorized ${JSON.stringify(a.binding)}, now ${JSON.stringify(again.binding)}`], lifecycle: again.lifecycle };
  const { head, branch, tree, candidate_id } = a.binding;
  const S = readEngine(ctx).S;
  const identity = S.enrollment.identity;
  const releaseBase = { ref: S.ship_ready.base.ref, sha: S.ship_ready.base.sha, merge_base: S.ship_ready.base.merge_base };
  const deny = (code, reason) => ({ published: false, allow: false, code, reasons: [reason], lifecycle: a.lifecycle });
  // R0-S round 4 (D4): a head is published as ONE tuple. A second publication must equal the first; the one permitted change is pr null ->
  // one verified PR (a recorded PR is re-verified and reused, never replaced or dropped). Checked BEFORE anything is pushed.
  const prior = (S.published ?? []).findLast(p => p.head === head && p.publication_id) ?? null;
  const draft = publicationOf({ identity, branch, head, tree, base: releaseBase, candidate_id, pr: prior?.pr ?? null });
  if (prior && draft.publication_id !== prior.publication_id)
    return deny('publication_mismatch', `${head} was published as ${prior.publication_id} (${prior.identity}, base ${prior.release_base?.ref}); this publication differs: a head is published once (start a new run to change it)`);
  // The PR already bound for this branch (this head's, else an earlier head's: GitHub moves a PR's head with its branch) is LOOKED UP and
  // re-verified for this head, never created twice.
  const known = prior?.pr ?? (S.published ?? []).findLast(p => p.branch === branch && p.pr && p.identity === identity.slug.toLowerCase())?.pr ?? null;
  // R0-S N4: a PR is opened or re-verified only with the gh pinned at enroll (checked before anything is pushed).
  const gh = ctx.prTitle !== undefined || known ? pinnedTool(S.enrollment?.tools?.gh) : null;
  if (gh && !gh.ok && !ctx.ciProvider) return deny(gh.code, gh.reason);
  const pushTo = remote ?? identity.remote_name;
  await recordIntent(ctx, { head, branch, base: a.binding.base, remote: pushTo, at: new Date().toISOString() });
  const env = ctx.env ?? process.env;
  // R0-S round 5 (item 1): the push remote is re-read immediately before the push: one URL, at most one push URL, the enrolled repository.
  const dest = remoteIdentity(ctx.repoRoot, pushTo);
  if (!dest.ok) return deny(dest.code, dest.reasons[0]);
  if (dest.identity?.slug?.toLowerCase() !== identity.slug.toLowerCase()) return deny('identity_changed', `${pushTo} now names ${dest.identity?.slug ?? 'no GitHub repository'}; this run enrolled ${identity.slug}`);
  const push = spawnSync('git', ['push', pushTo, `${head}:refs/heads/${branch}`], { cwd: ctx.repoRoot, encoding: 'utf8', env, timeout: 600000 });
  if (push.status !== 0) return { published: false, allow: true, code: 'push_failed', reasons: [(push.stderr || push.error?.message || '').trim()] };
  const remoteHead = gitOut(ctx.repoRoot, ['ls-remote', pushTo, `refs/heads/${branch}`], env)?.split(/\s+/)[0] ?? null;
  if (remoteHead !== head) return { published: false, allow: true, code: 'remote_mismatch', reasons: [`pushed ${head}, the remote branch is ${remoteHead}; nothing recorded`] };
  const provider = gh ? ctx.ciProvider ?? ghProvider({ repoRoot: ctx.repoRoot, env, bin: gh.path, repository: identity }) : null;
  const facts = { head, branch, release_base: releaseBase };
  let pr = known, prError = null, prCode = null;
  if (known) {
    // A recorded PR is re-verified read-only (never a second create).
    const v = provider.pullRequest(known.number);
    const rows = prRows(v?.ok ? v.pr : null, { ...facts, pr: known }, identity);
    // This head's own recorded PR failing its rows records nothing (its publication stands; complete refuses live). An EARLIER head's PR
    // (closed, retargeted) is not bound to this new head: it is recorded branch-only with the refusal (never completes; `ci --pr` may bind a
    // verified PR), so `next` never re-offers the same publish in a loop.
    if (rows && prior?.pr) return { published: true, code: rows.code, reasons: rows.reasons, run_id: ctx.runId, head, branch, recorded: false };
    if (rows) { pr = null; prError = rows.reasons[0]; prCode = rows.code; }
  } else if (ctx.prTitle !== undefined) {
    const r = spawnSync(gh.path, ['pr', 'create', '-R', identity.slug, '--head', branch, '--base', releaseBase.ref, '--title', ctx.prTitle, '--body-file', ctx.prBodyFile, ...(ctx.draft ? ['--draft'] : [])],
      { cwd: ctx.repoRoot, encoding: 'utf8', env: ghEnv(env), timeout: 300000 });
    const number = r.status === 0 ? prNumberOf(r.stdout.trim().split('\n').at(-1)) : null;
    if (!number) prError = (r.status === 0 ? `gh pr create printed no PR URL: ${r.stdout.trim()}` : (r.stderr || r.error?.message || 'gh pr create failed')).trim();
    else {
      // The created PR is verified read-only before it is bound: head and base repository, head ref and sha, base ref, OPEN.
      const v = provider.pullRequest(number);
      const rows = prRows(v?.ok ? v.pr : null, facts, identity);
      if (rows) { prError = rows.reasons[0]; prCode = rows.code; } else pr = prBinding(v.pr);
    }
  }
  const pubn = publicationOf({ identity, branch, head, tree, base: releaseBase, candidate_id, pr });
  const entry = { ...a.binding, remote: pushTo, repository: { slug: identity.slug, host: identity.host, owner: identity.owner, repo: identity.repo },
    identity: identity.slug.toLowerCase(), release_base: releaseBase, pr, publication_id: pubn.publication_id, ...(prError ? { pr_error: prError } : {}), at: new Date().toISOString() };
  let recorded = true;
  try { await recordPublished(ctx, entry); } catch { recorded = false; }
  if (!recorded) return { published: true, code: 'published_unrecorded', reasons: ['the push succeeded but PUBLISHED could not be recorded; complete stays unauthorized'], run_id: ctx.runId, ...entry };
  return { published: true, code: prError ? prCode ?? 'pr_failed' : 'published', reasons: prError ? [prError] : [], run_id: ctx.runId, ...entry, lifecycle: 'publication' };
}

const USAGE = `Usage: run-engine.mjs enroll --repo <dir> --ticket <key> --run-id <id>             (after init)
       run-engine.mjs context --phase ${PHASES.join('|')} --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs authorize --stage ${STAGES.join('|')} --repo <dir> --ticket <key> --run-id <id> [--base <branch>] [--remote origin]
       run-engine.mjs publish --repo <dir> --ticket <key> --run-id <id> [--remote origin] [--base <branch>] [--pr-title <t> --pr-body-file <f> [--draft]]`;
const FLAGS = { enroll: [], context: ['phase'], authorize: ['stage', 'base', 'remote'], publish: ['remote', 'base', 'pr-title', 'pr-body-file'] };
export const ENROLL_COMMANDS = Object.freeze(Object.keys(FLAGS));

/**
 * CLI for the commands above; `cmds` = { readEngine, enroll, context, publish } from run-engine.mjs (publish runs under the run lock).
 * Prints, and returns the exit code (0 ok/allow, 2 refused/deny, 1 usage or failure).
 */
export async function enrollCli(argv, cmds) {
  const [cmd, ...all] = argv;
  const draft = cmd === 'publish' && all.includes('--draft');
  const rest = all.filter(a => !(draft && a === '--draft'));
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!k || rest[i + 1] === undefined || Object.hasOwn(flags, k)) throw new Error(`bad or repeated flag: ${rest[i]}\n${USAGE}`);
    flags[k] = rest[i + 1];
  }
  const allowed = ['repo', 'ticket', 'run-id', ...FLAGS[cmd]];
  if (Object.keys(flags).some(k => !allowed.includes(k)) || !flags.repo || !SAFE_ID.test(flags.ticket ?? '') || !SAFE_ID.test(flags['run-id'] ?? '')) throw new Error(USAGE);
  const ctx = { repoRoot: resolve(flags.repo), ticket: flags.ticket, runId: flags['run-id'] };
  const json = (r) => process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  try {
    if (cmd === 'context') {
      // R0-S C4: the bytes are written (the write callback completed) before the delivery is recorded.
      const emit = (text) => new Promise((res, rej) => { process.stdout.once('error', rej); process.stdout.write(text, (e) => (e ? rej(e) : res())); });
      const r = await cmds.context({ ...ctx, phase: flags.phase, emit });
      const { text: _t, ...summary } = r;
      process.stderr.write(`context: ${JSON.stringify(summary)}\n`);
      return r.delivered ? 0 : 2;
    }
    if (cmd === 'authorize') {
      const r = await authorize({ ...ctx, stage: flags.stage, base: flags.base, remote: flags.remote }, cmds.readEngine);
      json(r);
      if (!r.allow) process.stderr.write(`authorize: deny ${r.code}: ${r.reasons[0] ?? ''}\n`);
      return r.allow ? 0 : 2;
    }
    if (cmd === 'publish') {
      const r = await cmds.publish({ ...ctx, remote: flags.remote, base: flags.base, prTitle: flags['pr-title'], prBodyFile: flags['pr-body-file'], draft });
      json(r);
      if (r.code !== 'published') process.stderr.write(`publish: ${r.published ? '' : 'not published, '}${r.code}: ${r.reasons[0] ?? ''}\n`);
      return r.code === 'published' ? 0 : r.allow === false ? 2 : 1;
    }
    json(await cmds.enroll(ctx));
    return 0;
  } catch (e) {
    if (!e.code || e.code === 'bad_input') throw e;
    process.stderr.write(`run-engine: ${e.message}\n`);
    return 2;
  }
}
