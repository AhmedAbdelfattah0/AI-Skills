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
 * otherwise returns a refusal that records no decision; publish needs `publication`. `init` is the
 * bootstrap and needs only the approved plan. status, resume, mark, rebind, archive and `context`
 * are not gated.
 *
 * Skill pin (enroll): in a git install the skill commit (`gitReader`), whose blobs no later
 * work-tree write can change; every delivery reads those blobs. In a copy install the manifest digest
 * at enrollment: a later delivery re-verifies the files on disk and refuses any change. Enrollment is
 * once per run, refused while an attempt may still run, and in a copy install refused once any
 * attempt has run (its files could be worker-written).
 *
 * No degraded or owner-approved bypass exists. The engine has no channel that proves a human said
 * something (START, RETRY and waivers are orchestrator-appended RUN-STATE lines, trusted against
 * dispatched code, not against the orchestrator), so a degradation is a refusal: WAIT_FOR_USER.
 *
 * Residual (same user, not a boundary): a process running as the user can rewrite the engine state
 * or the skill's git history, import these modules and call the seams directly, or push with git/gh.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as io from './engine-io.mjs';
import { coded } from './engine-dag.mjs';
import { LIVE } from './engine-quiesce.mjs';
import { checkShipReady } from './ship-ready-check.mjs';
import { deliverPhase, verifySkill, fsReader, gitReader, SKILL_DIR, PHASES, sha256, MANIFEST_REL } from './context-manifest.mjs';

export const AUTHORIZE_SCHEMA = 'ship-ticket-authorize-v1';
export const STAGES = Object.freeze(['build', 'publish', 'complete']);
/** The context phase each stage and gate needs, delivered from the pinned skill. */
export const STAGE_PHASE = Object.freeze({ build: 'build', publish: 'ship', complete: 'ship',
  red: 'build', review: 'review', 'unit-review': 'review', reassess: 'review', 'ship-ready': 'ship' });
/** `complete` stops here until slice E6 records CI evidence: explicit, never a silent allow. */
export const CI_PLACEHOLDER = 'ci_evidence_unavailable';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const gitOut = (repo, args, env) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000, ...(env ? { env } : {}) });
  return r.status === 0 ? r.stdout.trim() : null;
};
const refusal = (code, reason, lifecycle) => ({ ok: false, code, reasons: [reason], lifecycle });

/** The reader a new enrollment pins: the skill commit when the skill is committed in git, else its files. */
export function currentReader(skillDir = SKILL_DIR) {
  const g = gitReader(skillDir);
  return g && !g.missing && g.read(MANIFEST_REL) ? g : fsReader(skillDir);
}

/** The reader an enrollment pinned. */
const pinnedReader = (en, skillDir) => (en.mode === 'git' ? gitReader(skillDir, en.skill_revision) ?? { mode: 'git', revision: en.skill_revision, missing: true } : fsReader(skillDir));

/** Verify the skill exactly as enrolled (git: the pinned commit; copy: the files, against the enrolled manifest digest). */
function pinnedSkill(en, skillDir) {
  const reader = pinnedReader(en, skillDir);
  const v = verifySkill(skillDir, reader);
  if (!v.ok) return v;
  if (v.digest !== en.manifest_digest) return refusal('manifest_drift', `the skill manifest is ${v.digest}, the run enrolled ${en.manifest_digest}; start a new run`);
  const skill = reader.read('SKILL.md');
  if (!skill || sha256(skill) !== en.skill_digest) return refusal('skill_drift', 'SKILL.md is not the enrolled one; start a new run');
  return { ...v, reader };
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
    throw coded('enrollment_conflict', `run ${S.run_id} is enrolled to ${S.enrollment.skill_revision ?? S.enrollment.manifest_digest}; a skill change mid-run needs a new run`);
  }
  if (reader.mode === 'copy' && (S.attempts ?? []).length)
    throw coded('enrollment_after_execution', 'a copy-installed skill cannot be pinned after attempts ran (its files could be worker-written); start a new run');
  S.enrollment = { run_id: S.run_id, ticket: S.ticket, repo: gitOut(ctx.repoRoot, ['rev-parse', '--show-toplevel']),
    branch: gitOut(ctx.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']), head: gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    ...pin, attempts_before: (S.attempts ?? []).length, at: new Date().toISOString() };
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
function supersededBy(S) {
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

/** Carrier dispatch boundary (carrier.mjs dispatch): the approval's run must be ADMITTED in its engine state. Throws on refusal. */
export function verifyAdmission(repoRoot, approval) {
  const file = io.gitPath(repoRoot, `ai-skills/ship-ticket/${approval.ticket}.state.json`);
  if (!existsSync(file)) throw coded('not_enrolled', `no engine state for ${approval.ticket}: worker dispatch needs an initialized, enrolled and admitted run`);
  let S;
  try { S = JSON.parse(readFileSync(file, 'utf8')); } catch { throw coded('state_unreadable', `${file} is not JSON`); }
  const runId = approval.run_id ?? approval.runId;
  if (S.run_id !== runId) throw coded('run_mismatch', `engine state belongs to run ${S.run_id}, not ${runId}`);
  const a = admission(S, 'build');
  if (!a.ok) throw coded(a.code, a.reasons.join('; '));
  return a;
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
    if (!(S.published ?? []).some(p => p.head === head)) return deny('publish_evidence_missing', [`no PUBLISHED record for HEAD ${head}; ship through run-engine.mjs publish`], lifecycle(S));
    return deny(CI_PLACEHOLDER, ['CI evidence is not recorded by the engine yet (slice E6), so complete cannot be authorized'], 'publication');
  }
  if (!S.ship_ready?.candidate_id) return deny('ship_ready_missing', ['no engine SHIP_READY for this run; run gate ship-ready'], lifecycle(S));
  const superseded = supersededBy(S);
  if (superseded.length) return deny('ship_ready_superseded', superseded, lifecycle(S));
  const branch = gitOut(ctx.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return deny('branch_detached', ['HEAD is detached; publish pushes the ticket branch'], 'evidence');
  if (!branch.toUpperCase().includes(ctx.ticket.toUpperCase())) return deny('branch_not_ticket', [`branch ${branch} does not name ticket ${ctx.ticket}`], 'evidence');
  const dirty = io.snapshot(ctx.repoRoot, S.pinned_exclusions ?? []);
  if (dirty === null) return deny('candidate_unavailable', ['git status failed'], 'evidence');
  if (Object.keys(dirty).length) return deny('tree_dirty', [`uncommitted candidate paths (the push would not be the reviewed bytes): ${Object.keys(dirty).sort().join(', ')}`], 'evidence');
  // The merge base recorded with SHIP_READY: with config.base HEAD the merge base moves at the commit, the recorded commit does not.
  const cand = io.candidateId(ctx.repoRoot, S.ship_ready.merge_base ?? S.config?.base ?? 'HEAD', S.pinned_exclusions ?? []);
  if (!cand.candidate_id) return deny('candidate_unavailable', [cand.reason], 'evidence');
  if (cand.candidate_id !== S.ship_ready.candidate_id) return deny('candidate_stale', [`SHIP_READY is for ${S.ship_ready.candidate_id}, the candidate now is ${cand.candidate_id}`], 'admitted');
  const plan = io.readIfExists(join(ctx.repoRoot, '.specs', 'plans', ctx.ticket + '.md')) ?? '';
  const log = io.readIfExists(io.gitPath(ctx.repoRoot, `ai-skills/ship-ticket/${ctx.ticket}.engine.jsonl`)) ?? '';
  const backed = checkShipReady(plan, log, { runId: ctx.runId, requireEvent: true });
  if (!backed.ok || !backed.shipReady.includes(cand.candidate_id))
    return deny('ship_ready_unbacked', [backed.reason || `RUN-STATE has no SHIP_READY for ${cand.candidate_id}; run resume to deliver the engine outbox`], 'evidence');
  return { ...base, allow: true, code: 'allow', reasons: [], lifecycle: 'publication',
    binding: { head, tree: gitOut(ctx.repoRoot, ['rev-parse', 'HEAD^{tree}']), candidate_id: cand.candidate_id, branch } };
}

/**
 * `publish`: authorize publish, then authorize AGAIN immediately before the push and require the same
 * binding (head, tree, candidate, branch); push exactly that commit (`<sha>:refs/heads/<branch>`),
 * check the remote ref is that commit, open the PR only when a title and body file are given, and
 * record PUBLISHED. Residual TOCTOU: the remote can still move after the check, and direct git/gh
 * pushes never pass through here. `ctx.beforePush` is a test seam run between the two authorizations.
 */
export async function publish(ctx, readEngine, recordPublished) {
  const remote = ctx.remote ?? 'origin';
  if (!SAFE_REMOTE.test(remote)) throw coded('bad_input', '--remote must be a remote name');
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
  const { head, branch } = a.binding;
  const env = ctx.env ?? process.env;
  const push = spawnSync('git', ['push', remote, `${head}:refs/heads/${branch}`], { cwd: ctx.repoRoot, encoding: 'utf8', env, timeout: 600000 });
  if (push.status !== 0) return { published: false, allow: true, code: 'push_failed', reasons: [(push.stderr || push.error?.message || '').trim()] };
  const remoteHead = gitOut(ctx.repoRoot, ['ls-remote', remote, `refs/heads/${branch}`], env)?.split(/\s+/)[0] ?? null;
  if (remoteHead !== head) return { published: false, allow: true, code: 'remote_mismatch', reasons: [`pushed ${head}, the remote branch is ${remoteHead}; nothing recorded`] };
  let pr = null, prError = null;
  if (ctx.prTitle !== undefined) {
    const r = spawnSync('gh', ['pr', 'create', '--head', branch, '--title', ctx.prTitle, '--body-file', ctx.prBodyFile, ...(ctx.draft ? ['--draft'] : [])],
      { cwd: ctx.repoRoot, encoding: 'utf8', env, timeout: 300000 });
    if (r.status === 0) pr = { url: r.stdout.trim().split('\n').at(-1) ?? '' };
    else prError = (r.stderr || r.error?.message || 'gh pr create failed').trim();
  }
  const entry = { ...a.binding, remote, pr, ...(prError ? { pr_error: prError } : {}), at: new Date().toISOString() };
  await recordPublished(ctx, entry);
  return { published: true, code: prError ? 'pr_failed' : 'published', reasons: prError ? [prError] : [], run_id: ctx.runId, ...entry, lifecycle: 'publication' };
}

const USAGE = `Usage: run-engine.mjs enroll --repo <dir> --ticket <key> --run-id <id>             (after init)
       run-engine.mjs context --phase ${PHASES.join('|')} --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs authorize --stage ${STAGES.join('|')} --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs publish --repo <dir> --ticket <key> --run-id <id> [--remote origin] [--pr-title <t> --pr-body-file <f> [--draft]]`;
const FLAGS = { enroll: [], context: ['phase'], authorize: ['stage'], publish: ['remote', 'pr-title', 'pr-body-file'] };
export const ENROLL_COMMANDS = Object.freeze(Object.keys(FLAGS));

/**
 * CLI for the commands above; `cmds` = { readEngine, enroll, context, recordPublished } from run-engine.mjs.
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
      const r = await cmds.context({ ...ctx, phase: flags.phase });
      if (r.text !== undefined) process.stdout.write(r.text);
      const { text: _t, ...summary } = r;
      process.stderr.write(`context: ${JSON.stringify(summary)}\n`);
      return r.delivered ? 0 : 2;
    }
    if (cmd === 'authorize') {
      const r = await authorize({ ...ctx, stage: flags.stage }, cmds.readEngine);
      json(r);
      if (!r.allow) process.stderr.write(`authorize: deny ${r.code}: ${r.reasons[0] ?? ''}\n`);
      return r.allow ? 0 : 2;
    }
    if (cmd === 'publish') {
      const r = await publish({ ...ctx, remote: flags.remote, prTitle: flags['pr-title'], prBodyFile: flags['pr-body-file'], draft }, cmds.readEngine, cmds.recordPublished);
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
