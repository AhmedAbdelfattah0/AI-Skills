/**
 * Mandatory enrollment, stage authorization, degradation and publish for the durable run engine
 * (P0 slices E1 and E4). Node built-ins only. The CLI is run-engine.mjs (enroll, context, authorize,
 * degrade, approve-degraded, publish); this module owns their records and decisions.
 *
 * Records: one engine-owned ledger per ticket, `git rev-parse --git-path
 * ai-skills/ship-ticket/<TICKET>.enrollment.json` (schema ship-ticket-enrollment-v1), never committed.
 * It exists before the engine state does (enroll and the UNDERSTAND/PLAN context run before `init`),
 * is written only under the ticket's engine lock with the engine's atomic writer, and is keyed by
 * run id: ENROLLED, CONTEXT_DELIVERED, DEGRADED, DEGRADED_APPROVED, PUBLISHED. Every event is also
 * mirrored to <TICKET>.engine.jsonl as telemetry, and that copy is NEVER read back: a line forged
 * in the engine log or in the plan's RUN-STATE authorizes nothing. Decisions read only this ledger
 * and the engine state (SHIP_READY, binding), exactly as the gates read only the state.
 *
 * What is ENFORCED (by the engine, for the supported path):
 * - `publish` pushes only after `authorize publish` allows: enrolled run, no unapproved degradation,
 *   ship context delivered against the current manifest, the trusted plan/DAG binding intact, an
 *   engine SHIP_READY for the candidate recomputed now, a clean tree (what is pushed is what was
 *   reviewed), a ticket branch, and a RUN-STATE SHIP_READY backed by the engine GATE line.
 * - `drive` (BUILD/PROVE) and `init` refuse an ENROLLED run whose build / plan context is absent or stale.
 * - the opt-in git-guard pre-push hook applies the same `authorize publish` to ticket branches.
 * What is only DETECTED (recorded, not prevented):
 * - DEGRADED_APPROVED is an orchestrator-recorded owner decision. The engine has no way to prove a
 *   human said it: START and RETRY in RUN-STATE separate dispatched code from the orchestrator, not
 *   the orchestrator from the human. It therefore requires a non-empty verbatim `--owner-quote`, is
 *   refused while an engine attempt may still run (the analogue of RUN-STATE's trust window; during
 *   `drive` the ticket lock already excludes it), is bound to one DEGRADED event and, for publish,
 *   to the HEAD it approved. An approved degraded publish SKIPS the SHIP_READY/candidate checks.
 * - CONTEXT_DELIVERED proves VERIFIED DELIVERY: the exact manifest-checked bytes were printed as the
 *   `context` tool result. It does not prove that the model read, understood or followed them.
 * - An un-enrolled `drive` is not blocked (the existing engine API is kept); it simply can never publish.
 * Residual (a same-user process): this ledger, like the engine state, is a plain file in Git
 * metadata. A process running as the user that rewrites it with well-formed JSON (or recomputes any
 * digest) is accepted; a malformed rewrite fails closed (enrollment_unreadable). Plain `git push`,
 * `gh pr create` and the hook bypasses listed in git-guard.mjs remain possible: this is a guardrail
 * on the supported path, not a security boundary.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as io from './engine-io.mjs';
import { coded, judgment } from './engine-dag.mjs';
import { LIVE } from './engine-quiesce.mjs';
import { checkShipReady } from './ship-ready-check.mjs';
import { deliverPhase, verifySkill, loadManifest, SKILL_DIR, PHASES, sha256 } from './context-manifest.mjs';

export const ENROLL_SCHEMA = 'ship-ticket-enrollment-v1';
export const AUTHORIZE_SCHEMA = 'ship-ticket-authorize-v1';
export const STAGES = Object.freeze(['build', 'publish', 'complete']);
/** The context phase each stage needs delivered (against the current manifest). */
export const STAGE_CONTEXT = Object.freeze({ build: 'build', publish: 'ship', complete: 'ship' });
/** `complete` stops here until slice E6 records CI evidence: explicit, never a silent allow. */
export const CI_PLACEHOLDER = 'ci_evidence_unavailable';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT = 4000;
const TYPES = ['ENROLLED', 'CONTEXT_DELIVERED', 'DEGRADED', 'DEGRADED_APPROVED', 'PUBLISHED'];

const gitOut = (repo, args, env) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000, ...(env ? { env } : {}) });
  return r.status === 0 ? r.stdout.trim() : null;
};
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT;

function paths(ctx) {
  if (!SAFE_ID.test(ctx?.ticket ?? '') || typeof ctx?.repoRoot !== 'string') throw coded('bad_context', 'repoRoot and a safe ticket required');
  if (ctx.runId !== undefined && !SAFE_ID.test(ctx.runId)) throw coded('bad_context', 'run id must be a safe id');
  const base = `ai-skills/ship-ticket/${ctx.ticket}`;
  return { ledger: io.gitPath(ctx.repoRoot, base + '.enrollment.json'), log: io.gitPath(ctx.repoRoot, base + '.engine.jsonl'),
    plan: join(ctx.repoRoot, '.specs', 'plans', ctx.ticket + '.md') };
}

/** The ledger ({ ok, L }; L null when absent) or a fail-closed refusal for anything not of the ledger's shape. */
function readLedger(P, ticket) {
  if (!existsSync(P.ledger)) return { ok: true, L: null };
  const bad = (why) => ({ ok: false, code: 'enrollment_unreadable', reasons: [`${P.ledger}: ${why}; it is never repaired by hand`] });
  let L;
  try { L = JSON.parse(readFileSync(P.ledger, 'utf8')); } catch { return bad('not JSON'); }
  if (L?.schema !== ENROLL_SCHEMA || L.ticket !== ticket || !Array.isArray(L.events) || !Number.isInteger(L.seq)) return bad('not an enrollment ledger of this ticket');
  for (const e of L.events) if (!e || !TYPES.includes(e.type) || !SAFE_ID.test(e.run_id ?? '') || !Number.isInteger(e.seq)) return bad('holds an event of unknown shape');
  return { ok: true, L };
}

const ofRun = (L, runId, type) => (L?.events ?? []).filter(e => e.run_id === runId && e.type === type);
const latest = (L, runId, type) => ofRun(L, runId, type).at(-1) ?? null;

/** Skill provenance: SKILL.md digest, git revision of the installed folder (null for a copy install), manifest digest. */
export function skillInfo(skillDir = SKILL_DIR) {
  let rev = gitOut(skillDir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (rev && gitOut(skillDir, ['status', '--porcelain', '--', '.'])) rev += '-dirty';
  let skillDigest = null;
  try { skillDigest = sha256(readFileSync(join(skillDir, 'SKILL.md'))); } catch { /* reported as null */ }
  const m = loadManifest(skillDir);
  return { skill_revision: rev, skill_digest: skillDigest, manifest_digest: m.ok ? m.digest : null };
}

/** Append events built by `fn(L)` under the ticket lock (atomic write), then mirror them to the engine log (telemetry only). */
async function append(ctx, P, fn) {
  const lock = await io.acquireLock({ repoRoot: ctx.repoRoot, ticket: ctx.ticket, runId: ctx.runId ?? 'enroll', hooks: ctx.hooks });
  let added = [];
  try {
    const R = readLedger(P, ctx.ticket);
    if (!R.ok) throw coded(R.code, R.reasons.join('; '));
    const L = R.L ?? { schema: ENROLL_SCHEMA, ticket: ctx.ticket, seq: 0, events: [] };
    added = fn(L);
    if (!added.length) return [];
    for (const e of added) { e.seq = ++L.seq; e.at = new Date().toISOString(); L.events.push(e); }
    await io.writeStateAtomic(P.ledger, L, { hooks: ctx.hooks });
  } finally { await lock.release(); }
  for (const e of added) {
    try { io.appendLogOnce(P.log, { ...e, event: e.type, event_id: `enrollment-${ctx.ticket}-${e.seq}`, ticket: ctx.ticket }); } catch { /* telemetry only */ }
  }
  return added;
}

/**
 * `enroll`: idempotent. The same run with the same skill and manifest digests returns its ENROLLED;
 * a changed skill or manifest appends a new ENROLLED (`supersedes`), so earlier context is stale.
 * Without --run-id the ticket's latest enrolled run is reused, else a new id is minted.
 */
export async function enroll(ctx) {
  const P = paths(ctx);
  const repo = gitOut(ctx.repoRoot, ['rev-parse', '--show-toplevel']);
  const info = { ticket: ctx.ticket, repo, branch: gitOut(ctx.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    head: gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']), ...skillInfo() };
  let out = null;
  await append(ctx, P, (L) => {
    const runId = ctx.runId ?? (L.events.filter(e => e.type === 'ENROLLED').at(-1)?.run_id) ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const last = latest(L, runId, 'ENROLLED');
    if (last && last.skill_digest === info.skill_digest && last.manifest_digest === info.manifest_digest) { out = { already: true, event: last }; return []; }
    const e = { type: 'ENROLLED', run_id: runId, ...info, ...(last ? { supersedes: last.seq } : {}) };
    out = { already: false, event: e };
    return [e];
  });
  return { schema: ENROLL_SCHEMA, enrolled: true, run_id: out.event.run_id, already: out.already, ledger: P.ledger, event: out.event };
}

/**
 * Whether `phase` context was delivered for this enrollment against the skill as it is NOW:
 * the installed skill verifies against its manifest, the manifest and SKILL.md are the ones enrolled,
 * and the latest CONTEXT_DELIVERED of the phase names this manifest and this phase's exact inventory.
 */
function contextVerdict(L, runId, phase, enr, skillDir = SKILL_DIR) {
  const no = (code, reason) => ({ ok: false, code, reasons: [reason] });
  const v = verifySkill(skillDir);
  if (!v.ok) return { ok: false, code: v.code, reasons: v.reasons };
  if (v.digest !== enr.manifest_digest) return no('manifest_drift', `the installed manifest ${v.digest} is not the enrolled ${enr.manifest_digest}; re-run enroll, then context`);
  if (skillInfo(skillDir).skill_digest !== enr.skill_digest) return no('skill_drift', 'SKILL.md changed since enrollment; re-run enroll, then context');
  const d = ofRun(L, runId, 'CONTEXT_DELIVERED').filter(e => e.phase === phase).at(-1);
  if (!d) return no('context_missing', `no CONTEXT_DELIVERED for phase ${phase}; run run-engine.mjs context --phase ${phase}`);
  const want = v.manifest.phases[phase].map(p => ({ path: p, sha256: v.manifest.files[p] }));
  if (d.manifest_digest !== v.digest || JSON.stringify(d.inventory) !== JSON.stringify(want))
    return no('context_stale', `the ${phase} context was delivered against another manifest or inventory; run context --phase ${phase} again`);
  return { ok: true };
}

/** Judgments for `drive`/`init` of an ENROLLED run whose `phase` context is missing or stale ([] when not enrolled). */
export function enrolledContextJudgments(ctx, phase) {
  const P = paths(ctx);
  const R = readLedger(P, ctx.ticket);
  if (!R.ok) return [judgment(R.code, null, R.reasons.join('; '))];
  const enr = latest(R.L, ctx.runId, 'ENROLLED');
  if (!enr) return [];
  const c = contextVerdict(R.L, ctx.runId, phase, enr);
  return c.ok ? [] : [judgment(c.code, null, c.reasons.join('; '))];
}

/**
 * `context --phase <p>`: verify and deliver the phase's mandatory references. Never blocked by
 * enrollment or degradation (it is how an operator reads). It records CONTEXT_DELIVERED only for an
 * enrolled run, and refuses to deliver bytes of a manifest other than the enrolled one.
 * -> { delivered, recorded, code, reasons, text? }
 */
export async function context(ctx) {
  if (!PHASES.includes(ctx.phase)) throw coded('bad_input', `--phase must be one of ${PHASES.join(', ')}`);
  const d = deliverPhase(ctx.phase);
  if (!d.ok) return { delivered: false, recorded: false, code: d.code, reasons: d.reasons };
  const P = paths(ctx);
  const R = readLedger(P, ctx.ticket);
  if (!R.ok) return { delivered: true, recorded: false, code: R.code, reasons: R.reasons, text: d.text };
  const enr = latest(R.L, ctx.runId, 'ENROLLED');
  if (!enr) return { delivered: true, recorded: false, code: 'not_enrolled', reasons: [`run ${ctx.runId} is not enrolled; nothing recorded`], text: d.text };
  if (enr.manifest_digest !== d.digest) return { delivered: false, recorded: false, code: 'manifest_drift',
    reasons: [`the installed manifest ${d.digest} is not the enrolled ${enr.manifest_digest}; re-run enroll first`] };
  const info = skillInfo();
  if (info.skill_digest !== enr.skill_digest) return { delivered: false, recorded: false, code: 'skill_drift', reasons: ['SKILL.md changed since enrollment; re-run enroll first'] };
  const [ev] = await append(ctx, P, () => [{ type: 'CONTEXT_DELIVERED', run_id: ctx.runId, phase: ctx.phase, manifest_digest: d.digest,
    inventory: d.inventory, skill_revision: info.skill_revision }]);
  return { delivered: true, recorded: true, code: 'delivered', reasons: [], seq: ev.seq, text: d.text };
}

/** The latest DEGRADED of the run and the DEGRADED_APPROVED bound to it (each null when absent). */
function degradation(L, runId) {
  const degraded = latest(L, runId, 'DEGRADED');
  const approval = degraded ? ofRun(L, runId, 'DEGRADED_APPROVED').find(a => a.degraded_seq === degraded.seq && text(a.owner_quote)) ?? null : null;
  return { degraded, approval };
}

/**
 * `authorize --stage build|publish|complete`: read-only and lock-free (the pre-push hook calls it
 * while `publish` is pushing). -> { allow, code, reasons, ... }; the CLI exits 0 only on allow.
 * `readEngine(ctx)` -> { S, unbound } | { code, reasons } is run-engine.mjs's read-only state view.
 */
export async function authorize(ctx, readEngine) {
  if (!STAGES.includes(ctx.stage)) throw coded('bad_input', `--stage must be one of ${STAGES.join(', ')}`);
  const base = { schema: AUTHORIZE_SCHEMA, stage: ctx.stage, ticket: ctx.ticket, run_id: ctx.runId };
  const deny = (code, reasons, extra = {}) => ({ ...base, allow: false, code, reasons, ...extra });
  const allow = (code, extra = {}) => ({ ...base, allow: true, code, reasons: [], ...extra });
  const P = paths(ctx);
  const R = readLedger(P, ctx.ticket);
  if (!R.ok) return deny(R.code, R.reasons);
  const enr = latest(R.L, ctx.runId, 'ENROLLED');
  if (!enr) return deny('not_enrolled', [`run ${ctx.runId} of ${ctx.ticket} has no ENROLLED record; run run-engine.mjs enroll first`]);
  const dg = degradation(R.L, ctx.runId);
  if (dg.degraded && !dg.approval) return deny('degraded_unapproved', [`DEGRADED (${dg.degraded.reason}) has no DEGRADED_APPROVED; WAIT_FOR_USER, then approve-degraded with the owner's words`]);
  const c = contextVerdict(R.L, ctx.runId, STAGE_CONTEXT[ctx.stage], enr);
  if (!c.ok) return deny(c.code, c.reasons);

  const head = gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branchCheck = () => {
    const branch = gitOut(ctx.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) return { refusal: deny('branch_detached', ['HEAD is detached; publish pushes the ticket branch']) };
    if (!branch.toUpperCase().includes(ctx.ticket.toUpperCase())) return { refusal: deny('branch_not_ticket', [`branch ${branch} does not name ticket ${ctx.ticket}`]) };
    return { branch };
  };
  const complete = () => {
    const pub = latest(R.L, ctx.runId, 'PUBLISHED');
    if (!pub) return deny('publish_evidence_missing', ['no PUBLISHED record for this run; ship through run-engine.mjs publish']);
    if (pub.head !== head) return deny('publish_evidence_stale', [`PUBLISHED ${pub.head} is not HEAD ${head}`]);
    return deny(CI_PLACEHOLDER, ['CI evidence is not recorded by the engine yet (slice E6), so complete cannot be authorized']);
  };

  if (dg.approval) {
    const extra = { degraded: true, approval_seq: dg.approval.seq, skipped: ['engine_binding', 'ship_ready', 'candidate'] };
    if (ctx.stage === 'build') return allow('allow_degraded', extra);
    if (ctx.stage === 'complete') return complete();
    const b = branchCheck();
    if (b.refusal) return b.refusal;
    if (dg.approval.head !== head) return deny('degraded_approval_stale', [`DEGRADED_APPROVED covers ${dg.approval.head}, HEAD is ${head}`]);
    return allow('allow_degraded', { ...extra, head, branch: b.branch });
  }

  const eng = readEngine(ctx);
  if (eng.code) return deny(eng.code === 'no_state' ? 'engine_not_initialized' : eng.code, eng.reasons);
  if (eng.unbound.length) return deny(eng.unbound[0].code, eng.unbound.map(j => j.reason));
  if (ctx.stage === 'build') return allow('allow');
  if (ctx.stage === 'complete') return complete();
  const S = eng.S;
  if (!S.ship_ready?.candidate_id) return deny('ship_ready_missing', ['no engine SHIP_READY for this run; run gate ship-ready']);
  // SHIP_READY is a past decision: the state conjuncts gateShipReady judged must still hold now
  // (a later review, repair, judgment or attempt supersedes it even on the same candidate).
  const last = (S.review_chain ?? []).at(-1);
  const superseded = [
    !(last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' && last.candidate_id === S.ship_ready.candidate_id) && 'the last review is not a PASS of the ship-ready candidate',
    (S.repairs ?? []).some(r => ['pending', 'running'].includes(r.state)) && 'a repair is open',
    (S.judgments ?? []).length > 0 && 'judgments are unresolved',
    (S.attempts ?? []).some(a => LIVE.includes(a.status)) && 'attempts may still run',
    S.local_proof?.candidate_id !== S.ship_ready.candidate_id && 'the local proof is not of the ship-ready candidate',
  ].filter(Boolean);
  if (superseded.length) return deny('ship_ready_superseded', superseded);
  const baseRef = S.config?.base ?? 'HEAD';
  if (baseRef === 'HEAD') return deny('candidate_base_head', ['config.base is HEAD: after the commit the merge base moves and the candidate cannot be recomputed; bind the target base branch in the DAG']);
  const b = branchCheck();
  if (b.refusal) return b.refusal;
  const dirty = io.snapshot(ctx.repoRoot, S.pinned_exclusions ?? []);
  if (dirty === null) return deny('candidate_unavailable', ['git status failed']);
  if (Object.keys(dirty).length) return deny('tree_dirty', [`uncommitted candidate paths (the push would not be the reviewed bytes): ${Object.keys(dirty).sort().join(', ')}`]);
  const cand = io.candidateId(ctx.repoRoot, baseRef, S.pinned_exclusions ?? []);
  if (!cand.candidate_id) return deny('candidate_unavailable', [cand.reason]);
  if (cand.candidate_id !== S.ship_ready.candidate_id) return deny('candidate_stale', [`SHIP_READY is for ${S.ship_ready.candidate_id}, the candidate now is ${cand.candidate_id}`]);
  const plan = io.readIfExists(P.plan) ?? '', log = io.readIfExists(P.log) ?? '';
  const backed = checkShipReady(plan, log, { runId: ctx.runId, requireEvent: true });
  if (!backed.ok || !backed.shipReady.includes(cand.candidate_id)) return deny('ship_ready_unbacked',
    [backed.reason || `RUN-STATE has no SHIP_READY for ${cand.candidate_id}; run resume to deliver the engine outbox`]);
  return allow('allow', { candidate_id: cand.candidate_id, head, branch: b.branch });
}

/** `degrade --reason`: record DEGRADED for an enrolled run (publish/complete stay denied until DEGRADED_APPROVED). */
export async function degrade(ctx) {
  if (!text(ctx.reason)) throw coded('degrade_refused', '--reason must be non-empty');
  const P = paths(ctx);
  const [ev] = await append(ctx, P, (L) => {
    if (!latest(L, ctx.runId, 'ENROLLED')) throw coded('not_enrolled', `run ${ctx.runId} is not enrolled`);
    return [{ type: 'DEGRADED', run_id: ctx.runId, reason: ctx.reason, head: gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']) }];
  });
  return { schema: ENROLL_SCHEMA, degraded: true, run_id: ctx.runId, seq: ev.seq, next: 'WAIT_FOR_USER for the owner decision, then approve-degraded --owner-quote "<their words>"' };
}

/**
 * `approve-degraded --owner-quote "<verbatim owner words>"`: DETECTED, not ENFORCED (see the header).
 * Refused without an unapproved DEGRADED, without a quote, or while an engine attempt may still run.
 */
export async function approveDegraded(ctx, readEngine) {
  if (!text(ctx.ownerQuote)) throw coded('approval_refused', `--owner-quote must quote the owner's decision (1-${MAX_TEXT} characters)`);
  const P = paths(ctx);
  const [ev] = await append(ctx, P, (L) => {
    const dg = degradation(L, ctx.runId);
    if (!dg.degraded || dg.approval) throw coded('approval_refused', `run ${ctx.runId} has no unapproved DEGRADED`);
    const eng = readEngine(ctx);
    const live = (eng.S?.attempts ?? []).filter(a => LIVE.includes(a.status)).map(a => a.attempt_id);
    if (live.length) throw coded('attempts_live', `engine attempts may still run (${live.join(', ')}): dispatched code could record this; resume first`);
    return [{ type: 'DEGRADED_APPROVED', run_id: ctx.runId, degraded_seq: dg.degraded.seq, owner_quote: ctx.ownerQuote,
      head: gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']), trust: 'orchestrator-recorded' }];
  });
  return { schema: ENROLL_SCHEMA, approved: true, run_id: ctx.runId, seq: ev.seq, trust: ev.trust, head: ev.head };
}

/**
 * `publish`: the supported shipping path. authorize publish; on deny do nothing. Else push the
 * authorized branch, check the pushed ref is the authorized HEAD, open the PR only when a title and
 * body file are given, and record PUBLISHED. -> { published, code, ... }
 */
export async function publish(ctx, readEngine) {
  const remote = ctx.remote ?? 'origin';
  if (!SAFE_REMOTE.test(remote)) throw coded('bad_input', '--remote must be a remote name');
  if ((ctx.prTitle === undefined) !== (ctx.prBodyFile === undefined) || (ctx.draft && ctx.prTitle === undefined))
    throw coded('bad_input', '--pr-title and --pr-body-file go together (--draft needs them)');
  if (ctx.prTitle !== undefined && (!text(ctx.prTitle) || !existsSync(ctx.prBodyFile))) throw coded('bad_input', 'PR title must be non-empty and the body file must exist');
  const a = await authorize({ ...ctx, stage: 'publish' }, readEngine);
  if (!a.allow) return { published: false, ...a };
  const env = ctx.env ?? process.env;
  const ref = `refs/heads/${a.branch}`;
  const push = spawnSync('git', ['push', '-u', remote, `${ref}:${ref}`], { cwd: ctx.repoRoot, encoding: 'utf8', env, timeout: 600000 });
  if (push.status !== 0) return { published: false, allow: true, code: 'push_failed', reasons: [(push.stderr || push.error?.message || '').trim()] };
  const pushed = gitOut(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', ref], env);
  if (pushed !== a.head) return { published: false, allow: true, code: 'head_moved', reasons: [`authorized ${a.head}, the branch is now ${pushed}; nothing recorded`] };
  let pr = null, prError = null;
  if (ctx.prTitle !== undefined) {
    const r = spawnSync('gh', ['pr', 'create', '--head', a.branch, '--title', ctx.prTitle, '--body-file', ctx.prBodyFile, ...(ctx.draft ? ['--draft'] : [])],
      { cwd: ctx.repoRoot, encoding: 'utf8', env, timeout: 300000 });
    if (r.status === 0) pr = { url: r.stdout.trim().split('\n').at(-1) ?? '' };
    else prError = (r.stderr || r.error?.message || 'gh pr create failed').trim();
  }
  const P = paths(ctx);
  const [ev] = await append(ctx, P, () => [{ type: 'PUBLISHED', run_id: ctx.runId, head: a.head, branch: a.branch, remote,
    candidate_id: a.candidate_id ?? null, degraded: a.degraded === true, pr, ...(prError ? { pr_error: prError } : {}) }]);
  return { published: true, code: prError ? 'pr_failed' : 'published', reasons: prError ? [prError] : [], run_id: ctx.runId,
    head: a.head, branch: a.branch, remote, pr, seq: ev.seq, authorize: a.code };
}

const USAGE = `Usage: run-engine.mjs enroll --repo <dir> --ticket <key> [--run-id <id>]
       run-engine.mjs context --phase ${PHASES.join('|')} --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs authorize --stage ${STAGES.join('|')} --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs degrade --reason <text> --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs approve-degraded --owner-quote <owner's words> --repo <dir> --ticket <key> --run-id <id>
       run-engine.mjs publish --repo <dir> --ticket <key> --run-id <id> [--remote origin] [--pr-title <t> --pr-body-file <f> [--draft]]`;
const FLAGS = { enroll: [], context: ['phase'], authorize: ['stage'], degrade: ['reason'], 'approve-degraded': ['owner-quote'],
  publish: ['remote', 'pr-title', 'pr-body-file'] };
export const ENROLL_COMMANDS = Object.freeze(Object.keys(FLAGS));

/** CLI for the commands above. Prints, and returns the exit code (0 ok/allow, 2 refused/deny, 1 usage or failure). */
export async function enrollCli(argv, readEngine) {
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
  const unknown = Object.keys(flags).filter(k => !allowed.includes(k));
  if (unknown.length || !flags.repo || !flags.ticket || (cmd !== 'enroll' && !flags['run-id'])) throw new Error(USAGE);
  const ctx = { repoRoot: resolve(flags.repo), ticket: flags.ticket, ...(flags['run-id'] ? { runId: flags['run-id'] } : {}) };
  const json = (r) => process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  try {
    if (cmd === 'context') {
      const r = await context({ ...ctx, phase: flags.phase });
      if (r.text !== undefined) process.stdout.write(r.text);
      const { text: _t, ...summary } = r;
      process.stderr.write(`context: ${JSON.stringify(summary)}\n`);
      return r.delivered ? 0 : 2;
    }
    if (cmd === 'authorize') {
      const r = await authorize({ ...ctx, stage: flags.stage }, readEngine);
      json(r);
      if (!r.allow) process.stderr.write(`authorize: deny ${r.code}: ${r.reasons[0] ?? ''}\n`);
      return r.allow ? 0 : 2;
    }
    if (cmd === 'publish') {
      const r = await publish({ ...ctx, remote: flags.remote, prTitle: flags['pr-title'], prBodyFile: flags['pr-body-file'], draft }, readEngine);
      json(r);
      if (!r.published || r.code !== 'published') process.stderr.write(`publish: ${r.published ? '' : 'not published, '}${r.code}: ${r.reasons[0] ?? ''}\n`);
      return r.published && r.code === 'published' ? 0 : r.allow === false ? 2 : 1;
    }
    const r = cmd === 'enroll' ? await enroll(ctx) : cmd === 'degrade' ? await degrade({ ...ctx, reason: flags.reason })
      : await approveDegraded({ ...ctx, ownerQuote: flags['owner-quote'] }, readEngine);
    json(r);
    return 0;
  } catch (e) {
    if (!e.code || e.code === 'bad_context' || e.code === 'bad_input') throw e;
    process.stderr.write(`run-engine: ${e.message}\n`);
    return 2;
  }
}
