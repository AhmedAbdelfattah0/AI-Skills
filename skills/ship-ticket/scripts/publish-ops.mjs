#!/usr/bin/env node
/**
 * PR-6a (S7b publication; CONSOLIDATED §7 P3, §7.2, §8 P3; TRACK-A "Reconciliation of uncertain operations"; DEBATE D-g): the
 * PUBLICATION operations of the supervisor's wave journal. A SHIP_READY ticket of a wave whose owner-approved manifest says
 * `publication: pull_request` gets, in order, three journal ops, each `intent -> direct-object probe -> conditional act ->
 * record`, op id `repo:ticket:op:generation` with generation `c<candidate_id>` (plus `.r<k>` after a proven nothing-ran):
 *
 *   commit  ADOPT-OR-PARK, never create. The SHIP commit is the one commit of ship.md "One commit" (made after its pre-commit
 *           confirmations, which the supervisor does not run). The op is a record, no effect: HEAD is on the ticket branch,
 *           has ONE parent equal to the recorded merge base, and the work tree has no delta outside the candidate's
 *           excluded recording files -> the commit OID, its tree and parent are recorded. Otherwise PARKED (recomputed
 *           every tick): never a blind recommit.
 *   push    the exact commit OID to refs/heads/<branch> of the run's remote, after verifying the remote names the run's
 *           pinned repository identity (S.base.identity) and the local branch still is that OID. A plain NON-force
 *           `git push <remote> <oid>:refs/heads/<branch>` (owner rule SKILL.md "Never force-push without explicit owner
 *           authority": no --force, no --force-with-lease, no `+` refspec). Probe = `git ls-remote <url> refs/heads/<branch>`
 *           (the exact ref line): the OID -> adopted; another OID -> refused `push_requires_force`; absent -> act.
 *   pr      only after the push is recorded. Probe = `gh pr list --repo <o/r> --head <branch> --state all --json ...`;
 *           adopt ONLY the one PR of the same repository (not cross-repository), head ref, base, state OPEN and (recorded
 *           number or headRefOid == the pushed OID); several -> refused `pr_multiple_matches`; an OPEN same head/base PR
 *           on another head OID -> refused `pr_conflict_open`; none -> `gh pr create` once. A post-create list miss is NOT
 *           proof of non-creation: the op stays `ambiguous`.
 *
 * ACT / NOTHING-RAN / AMBIGUOUS. Every git/gh command runs in a DETACHED child (this file's CLI, launched by the supervisor's
 * launch protocol: pid, pgid, leader_start and the deadline persisted before the release byte), never under the journal lock.
 * The child FSYNCS an act marker (`<op>.act`) immediately before its one mutating command. Settlement reads the child's JSON
 * result and the marker, never an exit code alone:
 *   done | adopted              recorded (published)
 *   refused                     recorded; the ticket alone is Blocked naming the code
 *   not_applied, no marker      nothing ran (a probe failed before the act): re-decided by the next tick under `.r<k>`, bounded
 *   no result,   no marker      nothing ran (killed before the act)
 *   ambiguous, or no result with the marker present   AMBIGUOUS: never replayed. Bounded READ-ONLY probe launches
 *                               (`<op>.probe`, `<gen>.p<k>`, at most MAX_PROBES, one per tick); a direct-object match records it;
 *                               otherwise the ticket alone is Blocked `ambiguous_unresolved` naming the op, which stays ambiguous.
 *
 * EXACT HEAD (what is and is not bound). The engine binds the review PASS and the ship-ready gate to the candidate id (a digest
 * of the changed paths' content vs the merge base), not to a commit OID. Before the push intent the supervisor requires, in the
 * same tick: `next` is owner_publish (SHIP_READY accepted for the candidate computed from the work tree NOW), the engine state
 * names that candidate in the latest review PASS, the freeze, the local proof and SHIP_READY, the adopted commit is HEAD and
 * the work tree has no delta outside the excluded recording files (so the pushed tree is the reviewed candidate). The intent
 * records the OID, the candidate id and the ship-ready seq. A review bound to the commit OID itself is not built (PR-6b/D-b).
 *
 * THREAT MODEL: accidental races and crashes among cooperating same-user processes; the journal and run files are same-user
 * trusted. Candidate-generated text (the PR title from the plan heading) is an argv element (`--title=<t>`) and the body a file
 * (`--body-file`): no shell anywhere. This module never merges, deploys or touches a tracker, and writes no authority event.
 *
 * CLI (the child; exit 0 with one JSON line on stdout, whatever the outcome): publish-ops.mjs run|probe --spec <file>
 */
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isEntrypoint } from './harness.mjs';
import { authGit } from './engine-base.mjs';
import { remoteIdentity, remoteUrl } from './remote-identity.mjs';
import { strictGithub } from './github-identity.mjs';
import { groupIdentity } from './engine-quiesce.mjs';
import { opId, MAX_PROBES } from './supervisor-journal.mjs';

export const PUBLISH_SCHEMA = 'ship-ticket-publish-v1';
export const PUBLISH_OPS = fileURLToPath(import.meta.url);
/** The persisted bound of one publication child (the sweep enforces it like every launch op). */
export const PUBLISH_BOUND_MS = 15 * 60 * 1000;
export const PR_FIELDS = 'number,state,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,url';
/** Paths whose uncommitted delta does not change the candidate (ship.md "Candidate identity": the plan and the session log). */
export const SESSION_LOG = 'session-log.md';
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CANDIDATE = /^[0-9a-f]{64}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TITLE_MAX = 200;
const QUIESCE_WAIT_MS = 3000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const eqi = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------------------------------- pure

/**
 * The publication preconditions read from the engine state (in addition to `next` being owner_publish): the latest review
 * record is an original or confirmation PASS on candidate X, and the freeze, the local proof and SHIP_READY all name X.
 * -> { ok: true, candidate, ship_ready_seq } | { ok: false, reason }
 */
export function publishPreconditions(S, n) {
  const no = (reason) => ({ ok: false, reason });
  if (n?.code !== 'owner_publish') return no(`next is ${n?.code ?? n?.action ?? 'unknown'}, not owner_publish: SHIP_READY is not accepted for the current candidate`);
  const X = S?.ship_ready?.candidate_id;
  if (typeof X !== 'string' || !CANDIDATE.test(X)) return no('the engine state names no SHIP_READY candidate');
  const last = (S.review_chain ?? []).at(-1);
  if (!last || !['original', 'confirmation'].includes(last.kind) || last.outcome !== 'PASS') return no('the latest review record is not an original or confirmation PASS');
  if (last.candidate_id !== X) return no(`the latest review PASS is of ${last.candidate_id ?? 'no candidate'}, SHIP_READY of ${X}`);
  if (S.freeze?.candidate !== X) return no(`the freeze names ${S.freeze?.candidate ?? 'nothing'}, SHIP_READY ${X}`);
  if (S.local_proof?.candidate_id !== X) return no(`the local proof names ${S.local_proof?.candidate_id ?? 'nothing'}, SHIP_READY ${X}`);
  const okGate = (S.events ?? []).filter((e) => e?.type === 'GATE' && e.gate === 'ship-ready').at(-1);
  if (okGate && okGate.ok !== true) return no('the latest ship-ready gate decision refused');
  return { ok: true, candidate: X, ship_ready_seq: S.ship_ready.seq ?? null };
}

/**
 * Where the ticket publishes: the run's pinned base (S.base: remote NAME, repository identity on github.com, base ref) and the
 * merge base SHIP_READY recorded, plus the manifest branch. -> { ok: true, ... } | { ok: false, reason }
 */
export function publishTarget(S, t) {
  const B = S?.base, no = (reason) => ({ ok: false, reason });
  if (!isObj(B) || typeof B.identity !== 'string') return no('the run has no pinned repository identity (S.base.identity): publication needs a repository-identity-bound run');
  const gh = strictGithub(`https://${B.identity}`);
  if (!gh || gh.slug !== B.identity.toLowerCase()) return no(`S.base.identity ${JSON.stringify(B.identity)} is not a github.com repository`);
  if (typeof B.remote !== 'string' || !REMOTE_NAME.test(B.remote)) return no(`S.base.remote ${JSON.stringify(B.remote)} is not a remote name`);
  if (typeof B.ref !== 'string' || !BRANCH.test(B.ref)) return no('S.base.ref names no base branch');
  const mb = S.ship_ready?.base?.merge_base ?? S.freeze?.base?.merge_base ?? B.merge_base;
  if (typeof mb !== 'string' || !OID.test(mb)) return no('no merge base is recorded for SHIP_READY');
  if (typeof t?.branch !== 'string' || !BRANCH.test(t.branch) || t.branch === B.ref) return no(`the ticket branch ${JSON.stringify(t?.branch)} is not a publishable branch`);
  return { ok: true, remote: B.remote, identity: gh.slug, owner: gh.owner, repo: gh.repo, base: B.ref, merge_base: mb, branch: t.branch };
}

/** The exact line of `ref` in `git ls-remote` output -> { state: 'present', oid } | { state: 'absent' } | { state: 'invalid' }. */
export function parseLsRemote(stdout, ref) {
  let found = null;
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(\S+)$/.exec(line);
    if (!m) return { state: 'invalid' };
    if (m[2] !== ref) continue; // ls-remote patterns match path-component tails: only the exact ref counts
    if (found) return { state: 'invalid' };
    found = m[1];
  }
  return found ? { state: 'present', oid: found } : { state: 'absent' };
}

/**
 * Which listed PRs are THIS ticket's (pure; the gh list filter is never trusted): same repository (not cross-repository), head
 * ref, base and state OPEN, and the recorded number or headRefOid == the pushed OID.
 * -> { kind: 'one', pr } | { kind: 'many', prs } | { kind: 'conflict', prs } (an OPEN same head/base PR on another OID) | { kind: 'none' }
 */
export function matchPrs(prs, { owner, repo, head, base, oid, number = null }) {
  if (!Array.isArray(prs)) return { kind: 'none' };
  const same = prs.filter((p) => isObj(p) && p.headRefName === head && p.baseRefName === base && p.isCrossRepository === false
    && eqi(p.headRepositoryOwner?.login, owner) && eqi(p.headRepository?.name, repo) && Number.isSafeInteger(p.number));
  const open = same.filter((p) => p.state === 'OPEN');
  const mine = open.filter((p) => (number !== null && p.number === number) || p.headRefOid === oid);
  if (mine.length > 1) return { kind: 'many', prs: mine.map((p) => p.number) };
  if (mine.length === 1) return { kind: 'one', pr: { number: mine[0].number, url: typeof mine[0].url === 'string' ? mine[0].url : null } };
  if (open.length) return { kind: 'conflict', prs: open.map((p) => p.number) };
  return { kind: 'none' };
}

/** The PR/commit title from the plan's first `# ` heading: one line, control characters removed, at most TITLE_MAX. */
export function publishTitle(planText, key) {
  const h = /^# (.+)$/m.exec(String(planText ?? ''))?.[1] ?? '';
  // eslint-disable-next-line no-control-regex
  let title = h.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title.includes(key)) title = title ? `${key}: ${title}` : key;
  return title.slice(0, TITLE_MAX);
}

export function publishBody(t, pre, target) {
  return [`Ticket ${t.key}, run ${t.run_id}.`, '',
    `Candidate ${pre.candidate}: the latest review PASS, the local proof and SHIP_READY (engine seq ${pre.ship_ready_seq}) name it.`,
    `Branch ${target.branch} into ${target.base} of ${target.identity}. Plan: ${t.plan}.`, '',
    'Opened by the ship-ticket supervisor. The supervisor does not merge it.', ''].join('\n');
}

/** Paths of `git status --porcelain=v1 -z --untracked-files=all` output (renames give both paths). */
export function statusPaths(stdout) {
  const parts = String(stdout ?? '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2))) { if (parts[i + 1]) out.push(parts[i + 1]); i++; }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- local reads (tick)

/**
 * Bounded LOCAL git reads (no network, no effect): HEAD, its tree and parents, the current branch and the work-tree delta outside
 * `excluded`. -> { ok: true, head, tree, parents, on_branch, delta } | { ok: false, reason }
 */
export function localHead(worktree, branch, excluded = []) {
  const g = (args) => authGit(worktree, args, { timeout: 30000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const head = g(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0) return { ok: false, reason: 'HEAD does not resolve to a commit' };
  const sym = g(['symbolic-ref', '-q', 'HEAD']);
  const tree = g(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
  const par = g(['rev-list', '--parents', '-n', '1', 'HEAD']);
  const st = g(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (tree.status !== 0 || par.status !== 0 || st.status !== 0) return { ok: false, reason: 'git could not read the work tree' };
  const skip = new Set(excluded);
  return { ok: true, head: head.stdout.trim(), tree: tree.stdout.trim(), parents: par.stdout.trim().split(/\s+/).slice(1),
    on_branch: sym.status === 0 && sym.stdout.trim() === `refs/heads/${branch}`, delta: statusPaths(st.stdout).filter((p) => !skip.has(p)) };
}

// ---------------------------------------------------------------------------------------------------- supervisor side

/**
 * One publication step of a SHIP_READY ticket (called from the supervisor's owner_publish branch, under the journal lock). At most
 * one new op per call; every network command is a detached launch. `sup` = the supervisor's launch protocol { launch, launchGen,
 * opFiles }. Returns a stepTicket result.
 */
export async function publishStep(J, ctx, t, S, n, sup) {
  const pre = publishPreconditions(S, n);
  if (!pre.ok) return { blocked: await J.block(t.key, 'publish_preconditions_unmet', `no publication: ${pre.reason}`) };
  const target = publishTarget(S, t);
  if (!target.ok) return { blocked: await J.block(t.key, 'publish_target_unbound', target.reason) };
  const repo = ctx.repo(t), gen = `c${pre.candidate}`;
  const cur = (op) => { const g = sup.launchGen(J, repo, t.key, op, gen); return { g, prior: J.op(opId(repo, t.key, op, g.gen)) }; };
  const spent = async (g, op) => ({ blocked: await J.block(t.key, 'retries_exhausted', `${g.last.op_id}: ${op} did not run ${g.spent} times (${g.last.result?.cause ?? g.spent})`, { op_id: g.last.op_id }) });
  const excluded = [t.plan, SESSION_LOG, ...(Array.isArray(S.pinned_exclusions) ? S.pinned_exclusions : [])];
  const head = () => ctx.deps.localHead(t.worktree, target.branch, excluded);

  // 1. commit: adopt-or-park (a record; no effect)
  let { g, prior } = cur('commit');
  if (!prior) {
    if (g.spent) return spent(g, 'commit');
    const h = head();
    if (!h.ok) return { parked: 'publish_head_unreadable', reason: h.reason };
    if (!h.on_branch) return { parked: 'publish_branch_mismatch', reason: `HEAD is not refs/heads/${target.branch}` };
    if (h.head === target.merge_base) return { parked: 'awaiting_commit', reason: 'the SHIP commit does not exist yet: the supervisor adopts it, never creates it (ship.md "One commit")' };
    if (h.parents.length !== 1 || h.parents[0] !== target.merge_base) return { parked: 'commit_unrecognized', reason: `HEAD ${h.head} is not ONE commit on the recorded merge base ${target.merge_base}` };
    if (h.delta.length) return { parked: 'awaiting_commit', reason: `the work tree has uncommitted candidate paths: ${h.delta.slice(0, 5).join(', ')}` };
    const id = opId(repo, t.key, 'commit', g.gen);
    await J.intent({ op_id: id, ticket: t.key, kind: 'launch', spec_kind: 'publish', mode: 'record', op: 'commit', gen: g.gen, commit: h.head, tree: h.tree, parent: h.parents[0], candidate: pre.candidate });
    prior = await J.move(id, 'recorded', { result: { outcome: 'published', commit: h.head, tree: h.tree, parent: h.parents[0] } }, 'after-commit-record');
  }
  if (prior.result?.outcome !== 'published') return { parked: 'commit_not_recorded', op_id: prior.op_id };
  const commit = prior.result.commit;

  // 2. push the exact OID (non-force)
  ({ g, prior } = cur('push'));
  if (!prior) {
    if (g.spent) return spent(g, 'push');
    const h = head();
    if (!h.ok || h.head !== commit || !h.on_branch || h.delta.length)
      return { blocked: await J.block(t.key, 'publish_head_moved', `the adopted commit ${commit} is no longer the clean HEAD of ${target.branch}: the reviewed candidate cannot be bound to the push`) };
    const spec = { op: 'push', worktree: t.worktree, remote: target.remote, identity: target.identity, branch: target.branch, oid: commit, candidate: pre.candidate, ship_ready_seq: pre.ship_ready_seq };
    return { publishing: await sup.launch(J, ctx, t, { op: 'push', gen: g.gen, bound: PUBLISH_BOUND_MS, publish: { mode: 'run', spec } }) };
  }
  if (prior.result?.outcome !== 'published') return { parked: 'push_not_recorded', op_id: prior.op_id };
  const pushed = prior.result.oid;

  // 3. the PR (only after the push is recorded)
  ({ g, prior } = cur('pr'));
  if (!prior) {
    if (g.spent) return spent(g, 'pr');
    let title = t.key;
    try { title = publishTitle(readFileSync(join(t.worktree, t.plan), 'utf8'), t.key); } catch { /* the key alone */ }
    const spec = { op: 'pr', worktree: t.worktree, remote: target.remote, identity: target.identity, owner: target.owner, repo: target.repo,
      branch: target.branch, base: target.base, oid: pushed, title };
    return { publishing: await sup.launch(J, ctx, t, { op: 'pr', gen: g.gen, bound: PUBLISH_BOUND_MS, publish: { mode: 'run', spec, body: publishBody(t, pre, target) } }) };
  }
  if (prior.result?.outcome !== 'published') return { parked: 'pr_not_recorded', op_id: prior.op_id };
  J.doc.ship_ready[t.key] = { at_seq: S.seq ?? null,
    merge: ctx.strategy === 'owner' ? 'awaiting_owner_merge' : 'prevented: merge executor not implemented (PR-6b); awaiting owner merge',
    publication: { candidate: pre.candidate, commit, pushed: { remote: target.remote, ref: `refs/heads/${target.branch}`, oid: pushed },
      pr: { repo: `${target.owner}/${target.repo}`, number: prior.result.number, url: prior.result.url ?? null, base: target.base } } };
  await J.commit();
  return { ship_ready: J.doc.ship_ready[t.key] };
}

function readOut(file) {
  try {
    const text = readFileSync(file, 'utf8').trim().split('\n').at(-1);
    const v = JSON.parse(text);
    return isObj(v) && v.schema === PUBLISH_SCHEMA && typeof v.outcome === 'string' ? v : null;
  } catch { return null; }
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

/**
 * Settle one live publication op (every tick, before any new effect). The ONE classifier of publication results: the child's
 * JSON result plus the act marker, never an exit code alone. A probe op only records what it saw; its ambiguous parent decides.
 */
export async function settlePublish(J, ctx, o, sup) {
  const { deps } = ctx;
  if (o.mode === 'record') return o.state === 'intent' ? J.move(o.op_id, 'recorded', { result: { outcome: 'nothing_ran', cause: 'interrupted before its record' } }) : o;
  if (o.state === 'ambiguous') return o.probe_of ? o : reprobe(J, ctx, o, sup);
  // never released: nothing ran. Recorded (not re-acted here), so the next tick re-checks every precondition before a retry.
  if (o.state === 'intent' && !o.pid) return J.move(o.op_id, 'recorded', { result: { outcome: 'nothing_ran', cause: 'never_released' } });
  const bounded = async (code, note) => {
    if ((o.probes ?? 0) >= MAX_PROBES) return o;
    if (await J.probe(o.op_id, note)) await J.block(o.ticket, code, `op ${o.op_id}: ${note} after ${MAX_PROBES} probes`, { op_id: o.op_id });
    return J.op(o.op_id);
  };
  const env = readJson(o.files.envelope);
  if (env) {
    for (const until = performance.now() + QUIESCE_WAIT_MS; o.pgid && deps.isAlive(o.pgid) !== false && performance.now() < until;) await delay(50);
    if (o.pgid && deps.isAlive(o.pgid) !== false) return bounded('group_not_quiescent', 'envelope written but its process group is still alive');
  } else {
    const id = groupIdentity({ pgid: o.pgid, leader_start: o.leader_start }, deps.isAlive);
    if (id === 'verified') return o; // still running; the sweep enforces its bound
    if (id !== 'gone') return bounded('identity_unknown', `group identity ${id}: neither verified running nor proven gone`);
  }
  const out = readOut(o.files.out);
  const marker = existsSync(o.files.act);
  if (o.probe_of) return J.move(o.op_id, 'recorded', { result: out ? { outcome: out.outcome, code: out.code ?? null, facts: out.facts ?? {} } : { outcome: 'lost' } });
  if (out && ['done', 'adopted'].includes(out.outcome)) return J.move(o.op_id, 'recorded', { result: { outcome: 'published', how: out.outcome, ...(out.facts ?? {}) } });
  if (out?.outcome === 'refused') {
    const r = await J.move(o.op_id, 'recorded', { result: { outcome: 'refused', code: out.code, reason: out.reason ?? null } });
    await J.block(o.ticket, out.code ?? 'publish_refused', `${o.op_id}: ${out.reason ?? out.code}`, { op_id: o.op_id });
    return r;
  }
  if (!marker && (!out || out.outcome === 'not_applied')) return J.move(o.op_id, 'recorded', { result: { outcome: 'nothing_ran', cause: out?.code ?? 'no_result' } });
  return J.move(o.op_id, 'ambiguous', { why: out?.reason ?? 'the act started (marker present) and left no conclusive result', ...(out?.facts ? { facts: out.facts } : {}) });
}

/** One bounded, read-only re-probe of an ambiguous publication op per tick: a direct-object match records it, else Blocked. */
async function reprobe(J, ctx, o, sup) {
  if ((o.probes ?? 0) >= MAX_PROBES) return o; // spent: the ticket is Blocked; the op stays ambiguous for the owner
  const t = ctx.ticket(o.ticket);
  if (!t) return o;
  const gen = `${o.gen}.p${(o.probes ?? 0) + 1}`;
  const p = J.op(opId(ctx.repo(t), t.key, `${o.op}.probe`, gen));
  if (!p) {
    await sup.launch(J, ctx, t, { op: `${o.op}.probe`, gen, bound: PUBLISH_BOUND_MS, publish: { mode: 'probe', spec: readJson(o.files.spec), probe_of: o.op_id } });
    return J.op(o.op_id);
  }
  if (p.state !== 'recorded') return o;
  const r = p.result ?? {};
  if (r.outcome === 'match') return J.move(o.op_id, 'recorded', { result: { outcome: 'published', how: 'probe', via: p.op_id, ...(r.facts ?? {}) } });
  if (r.outcome === 'refused') {
    await J.update(o.op_id, { probes: MAX_PROBES, last_probe: `${p.op_id}: refused ${r.code}` });
    await J.block(o.ticket, r.code ?? 'publish_refused', `${o.op_id} stays ambiguous: its probe ${p.op_id} refused ${r.code}`, { op_id: o.op_id });
    return J.op(o.op_id);
  }
  if (await J.probe(o.op_id, `probe ${p.op_id}: ${r.outcome}`)) await J.block(o.ticket, 'ambiguous_unresolved', `op ${o.op_id} stayed ambiguous after ${MAX_PROBES} direct-object probes`, { op_id: o.op_id });
  return J.op(o.op_id);
}

/** The intent fields and files of a publication launch op (called by the supervisor's launch at intent). */
export function publishIntent(files, publish) {
  mkdirSync(dirname(files.spec), { recursive: true });
  // the probe of an ambiguous op reads THAT op's marker and created-number files: its spec keeps them
  const spec = publish.probe_of ? publish.spec : { ...publish.spec, act_file: files.act, created_file: files.created,
    ...(publish.body !== undefined ? { body_file: files.body } : {}) };
  if (publish.body !== undefined) writeFileSync(files.body, publish.body, { mode: 0o600 });
  writeFileSync(files.spec, JSON.stringify(spec), { mode: 0o600 });
  return { spec_kind: 'publish', mode: publish.mode, ...(publish.probe_of ? { probe_of: publish.probe_of } : {}) };
}

/** The launch spec of a publication child (no host admission: git/gh are light ops). */
export const publishCommand = (mode, specFile) => ({ file: process.execPath, args: [PUBLISH_OPS, mode, '--spec', specFile], shell: false });

// ---------------------------------------------------------------------------------------------------- the child

const CHILD_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' });

/** Durable act marker: created exclusively and fsynced (file and directory) BEFORE the one mutating command. */
function writeDurable(file, value) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { const d = openSync(dirname(file), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* directory fsync unsupported */ }
}

function gh(args, cwd, timeout = 120000) {
  const r = spawnSync('gh', args, { cwd, env: CHILD_ENV(), encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').slice(0, 2000), error: r.error?.code ?? null };
}
const git = (cwd, args, timeout = 60000) => authGit(cwd, args, { timeout, env: CHILD_ENV() });

/** The remote is the run's repository (strict github.com parse of its one URL; a push URL of another repository is refused). */
function checkRemote(s) {
  if (!REMOTE_NAME.test(s.remote ?? '')) return { ok: false, code: 'publish_remote_unsupported', reason: `remote ${JSON.stringify(s.remote)} is not a remote name` };
  const r = remoteIdentity(s.worktree, s.remote);
  if (!r.ok) return { ok: false, code: 'publish_identity_mismatch', reason: r.reasons?.[0] ?? r.code };
  const slug = strictGithub(r.identity?.url ?? '')?.slug;
  if (slug !== s.identity) return { ok: false, code: 'publish_identity_mismatch', reason: `remote ${s.remote} names ${slug ?? 'no github.com repository'}, the run is bound to ${s.identity}` };
  const u = remoteUrl(s.worktree, s.remote);
  if (!u.ok) return { ok: false, code: 'publish_identity_mismatch', reason: u.reasons?.[0] ?? u.code };
  return { ok: true, url: u.url };
}

function remoteRef(s, url) {
  const ref = `refs/heads/${s.branch}`;
  const r = git(s.worktree, ['ls-remote', '--', url, ref]);
  if (r.status !== 0) return { state: 'unavailable' };
  return parseLsRemote(r.stdout, ref);
}

function pushChild(mode, s) {
  const rc = checkRemote(s);
  if (!rc.ok) return mode === 'probe' ? { outcome: 'inconclusive', code: rc.code } : { outcome: 'refused', code: rc.code, reason: rc.reason };
  if (mode === 'probe') {
    const p = remoteRef(s, rc.url);
    return p.state === 'present' && p.oid === s.oid ? { outcome: 'match', facts: { oid: s.oid } } : { outcome: p.state === 'absent' ? 'absent' : 'inconclusive', facts: { remote: p } };
  }
  const local = git(s.worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}^{commit}`], 30000);
  if (local.status !== 0 || local.stdout.trim() !== s.oid) return { outcome: 'refused', code: 'publish_head_moved', reason: `refs/heads/${s.branch} is not ${s.oid}` };
  const before = remoteRef(s, rc.url);
  if (before.state === 'present' && before.oid === s.oid) return { outcome: 'adopted', facts: { oid: s.oid } };
  if (before.state === 'present') return { outcome: 'refused', code: 'push_requires_force', reason: `refs/heads/${s.branch} on ${s.identity} is ${before.oid}, not ${s.oid}: a non-force push cannot publish it, and force needs explicit owner authority` };
  if (before.state !== 'absent') return { outcome: 'not_applied', code: 'remote_unavailable', reason: `ls-remote ${before.state}` };
  writeDurable(s.act_file, { op: 'push', oid: s.oid, ref: `refs/heads/${s.branch}`, remote: s.remote });
  const r = git(s.worktree, ['push', '--porcelain', s.remote, `${s.oid}:refs/heads/${s.branch}`], 300000);
  const after = remoteRef(s, rc.url);
  if (after.state === 'present' && after.oid === s.oid) return { outcome: 'done', facts: { oid: s.oid } };
  return { outcome: 'ambiguous', reason: `push exit ${r.status ?? r.signal ?? r.error?.code}; the remote ref reads ${after.state}${after.oid ? ` ${after.oid}` : ''}, not ${s.oid}`, facts: { remote: after } };
}

function listPrs(s) {
  const r = gh(['pr', 'list', '--repo', `${s.owner}/${s.repo}`, '--head', s.branch, '--state', 'all', '--limit', '100', '--json', PR_FIELDS], s.worktree);
  if (r.status !== 0) return { ok: false };
  try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? { ok: true, prs: v } : { ok: false }; } catch { return { ok: false }; }
}

function prChild(mode, s) {
  const rc = checkRemote(s);
  if (!rc.ok) return mode === 'probe' ? { outcome: 'inconclusive', code: rc.code } : { outcome: 'refused', code: rc.code, reason: rc.reason };
  const created = readJson(s.created_file);
  const target = { owner: s.owner, repo: s.repo, head: s.branch, base: s.base, oid: s.oid, number: Number.isSafeInteger(created?.number) ? created.number : null };
  const verdict = (m) => (m.kind === 'one' ? { outcome: mode === 'probe' ? 'match' : 'adopted', facts: { number: m.pr.number, url: m.pr.url } }
    : m.kind === 'many' ? { outcome: 'refused', code: 'pr_multiple_matches', reason: `several OPEN PRs match ${s.branch} -> ${s.base}: ${m.prs.join(', ')}` }
      : m.kind === 'conflict' ? { outcome: 'refused', code: 'pr_conflict_open', reason: `an OPEN PR ${m.prs.join(', ')} of ${s.branch} -> ${s.base} is on another head` } : null);
  if (mode === 'probe') {
    const l = listPrs(s);
    if (!l.ok) return { outcome: 'inconclusive' };
    return verdict(matchPrs(l.prs, target)) ?? { outcome: 'absent' };
  }
  const p = remoteRef(s, rc.url);
  if (p.state !== 'present' || p.oid !== s.oid) return p.state === 'present' ? { outcome: 'refused', code: 'pr_head_unpushed', reason: `refs/heads/${s.branch} is ${p.oid}, not the pushed ${s.oid}` }
    : { outcome: 'not_applied', code: 'remote_unavailable', reason: `ls-remote ${p.state}` };
  const l = listPrs(s);
  if (!l.ok) return { outcome: 'not_applied', code: 'pr_list_unavailable' };
  const v = verdict(matchPrs(l.prs, target));
  if (v) return v;
  writeDurable(s.act_file, { op: 'pr', repo: `${s.owner}/${s.repo}`, head: s.branch, base: s.base, oid: s.oid });
  const c = gh(['pr', 'create', '--repo', `${s.owner}/${s.repo}`, '--head', s.branch, '--base', s.base, `--title=${s.title}`, '--body-file', s.body_file], s.worktree);
  const number = Number(/\/pull\/(\d+)\s*$/m.exec(c.stdout)?.[1] ?? NaN);
  if (Number.isSafeInteger(number)) { try { writeDurable(s.created_file, { number }); } catch { /* the probe falls back to the head OID */ } }
  const after = listPrs(s);
  const m = after.ok ? matchPrs(after.prs, { ...target, number: Number.isSafeInteger(number) ? number : null }) : { kind: 'none' };
  if (m.kind === 'one') return { outcome: 'done', facts: { number: m.pr.number, url: m.pr.url } };
  return { outcome: 'ambiguous', reason: `pr create exit ${c.status ?? c.error}; the PR list ${after.ok ? `shows ${m.kind}` : 'was unavailable'}: a list miss is not proof of non-creation`,
    facts: { created_number: Number.isSafeInteger(number) ? number : null } };
}

export function child(mode, spec) {
  if (!['run', 'probe'].includes(mode) || !isObj(spec) || !['push', 'pr'].includes(spec.op)) return { outcome: 'not_applied', code: 'bad_spec' };
  if (!OID.test(spec.oid ?? '') || !BRANCH.test(spec.branch ?? '') || (spec.op === 'pr' && !BRANCH.test(spec.base ?? ''))) return { outcome: 'refused', code: 'bad_spec', reason: 'the publication spec is malformed' };
  return spec.op === 'push' ? pushChild(mode, spec) : prChild(mode, spec);
}

if (isEntrypoint(import.meta.url)) {
  const [mode, flag, file] = process.argv.slice(2);
  let result;
  try { result = flag === '--spec' ? child(mode, JSON.parse(readFileSync(file, 'utf8'))) : { outcome: 'not_applied', code: 'usage' }; }
  catch (e) {
    // an error after the act marker is ambiguous; before it, nothing ran
    let acted = false;
    try { acted = existsSync(JSON.parse(readFileSync(file, 'utf8')).act_file); } catch { /* no spec: nothing ran */ }
    result = { outcome: mode === 'probe' ? 'inconclusive' : acted ? 'ambiguous' : 'not_applied', code: 'child_error', reason: String(e?.message ?? e).slice(0, 500) };
  }
  process.stdout.write(JSON.stringify({ schema: PUBLISH_SCHEMA, mode, ...result }) + '\n');
}
