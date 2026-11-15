/**
 * P0 slices E1 (mandatory engine enrollment) and E4 (trusted context delivery). Drives the REAL
 * engine and carrier CLIs on a temp repo with a fake provider, a fake `gh` and a local bare remote;
 * no model call. Contract: engine-enroll.mjs header and execution-harness.md, Enrollment and
 * authorization. Lifecycle: none -> unactivated (init) -> enrolled (enroll) -> admitted (build
 * context) -> evidence (SHIP_READY) -> publication (authorize publish).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, passReview, failReview, runStateEvents } from './engine-test-fixture.mjs';
import { enrollFixture, skillCopy } from './engine-enroll.test-helper.mjs';
import { buildManifest, manifestText } from './context-manifest.mjs';
import { publish } from './engine-enroll.mjs';
import { readEngine } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const ENGINE = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const CARRIER = fileURLToPath(new URL('./carrier.mjs', import.meta.url));
const spawnCli = (fx, args) => spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', env: fx.env });
const allowed = (r, lifecycle) => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.out.allow, true); if (lifecycle) assert.equal(r.out.lifecycle, lifecycle); };
const denied = (r, code, lifecycle) => {
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.out?.allow ?? r.out?.ok ?? false, false, r.stdout);
  assert.equal(r.out?.code, code, r.stdout);
  if (lifecycle) assert.equal(r.out.lifecycle, lifecycle, r.stdout);
};
const authorize = (fx, stage, runId) => fx.cli('authorize', { stage }, runId ? { runId } : undefined);

/** Ship-ready and committed: the state in which `publish` is the next action. */
function shippable(t, opts) {
  const fx = enrollFixture(t, opts);
  fx.toShipReady();
  fx.commitAll();
  return fx;
}

/** A carrier config for node `a` of the fixture run (the hand-run worker dispatch path). */
function carrierRun(fx) {
  const start = runStateEvents(fx.planFile).find(e => e.event === 'START');
  const cfg = join(fx.root, 'carrier.json');
  writeFileSync(cfg, JSON.stringify({ phase: 'BUILD', provider: 'claude', nodeId: 'a', workdir: fx.repo, ownership: { writes: ['src'] },
    timeoutMs: 60000, promptFile: fx.prompt('a'), approval: { ticket: 'T-1', runId: 'run-1', approvedPlanDigest: start.approved_plan_digest } }));
  return spawnSync(process.execPath, [CARRIER, 'run', cfg], { encoding: 'utf8', env: fx.env, cwd: fx.repo, timeout: 90000 });
}

test('lifecycle: none -> unactivated -> enrolled -> admitted -> evidence -> publication, then complete stops at the CI placeholder', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  denied(authorize(fx, 'build'), 'not_enrolled', 'none');
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0, 'init is the bootstrap: it needs only the approved plan');
  denied(authorize(fx, 'build'), 'not_enrolled', 'unactivated');
  const e = fx.cli('enroll');
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual([e.out.lifecycle, e.out.enrollment.mode], ['enrolled', 'git'], 'the in-repo skill is pinned to its commit');
  assert.match(e.out.enrollment.skill_revision, /^[0-9a-f]{40}$/);
  assert.equal(fx.cli('enroll').out.already, true, 'enroll is idempotent');
  denied(authorize(fx, 'build'), 'context_missing', 'enrolled');
  const c = fx.cli('context', { phase: 'build' });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, new RegExp(`skill commit ${e.out.enrollment.skill_revision}`));
  allowed(authorize(fx, 'build'), 'admitted');
  for (const phase of ['review', 'ship']) assert.equal(fx.cli('context', { phase }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).status, 0);
  assert.equal(fx.gate('ship-ready', {}).status, 0);
  denied(authorize(fx, 'publish'), 'tree_dirty', 'evidence');
  fx.commitAll(); // config.base HEAD: the merge base recorded with SHIP_READY keeps the candidate computable after the commit
  const a = authorize(fx, 'publish');
  allowed(a, 'publication');
  assert.deepEqual(Object.keys(a.out.binding), ['head', 'tree', 'candidate_id', 'branch']);
  denied(authorize(fx, 'complete'), 'publish_evidence_missing');
  const body = join(fx.root, 'pr.md');
  writeFileSync(body, 'PR body');
  const p = spawnCli(fx, ['publish', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1', '--pr-title', 'T-1: ship', '--pr-body-file', body, '--draft']);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(fx.remoteHead(), fx.head());
  assert.deepEqual(fx.ghLog(), [['pr', 'create', '--head', 'T-1-work', '--title', 'T-1: ship', '--body-file', body, '--draft']]);
  assert.equal(fx.readState().published.at(-1).head, fx.head());
  const done = authorize(fx, 'complete');
  denied(done, 'ci_evidence_unavailable', 'publication');
  assert.match(done.out.reasons[0], /slice E6/);
  assert.equal(fx.git(['status', '--porcelain']).stdout, '', 'publish wrote nothing into the work tree');
});

test('un-enrolled protected execution is refused at drive, gate, carrier dispatch and publish; nothing runs or is recorded', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const d = fx.cli('drive');
  assert.equal(d.status, 2);
  assert.ok(d.out.judgments.some(j => j.code === 'not_enrolled'), d.stdout);
  for (const [kind, input] of [['review', passReview('rx-1', fx.candidate())], ['ship-ready', {}]]) {
    const g = fx.gate(kind, input);
    assert.equal(g.status, 2, g.stdout);
    assert.equal(g.out.code, 'not_enrolled', g.stdout);
    assert.equal(g.out.ok, false);
  }
  const S = fx.readState();
  assert.deepEqual([S.review_chain.length, S.ship_ready ?? null, S.attempts.length], [0, null, 0], 'no authoritative decision and no attempt');
  const c = carrierRun(fx);
  assert.equal(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stderr, /not_enrolled/);
  assert.deepEqual(fx.runs(), [], 'no worker was launched by drive or the carrier');
  const p = fx.cli('publish');
  assert.equal(p.status, 2);
  assert.equal(fx.remoteHead(), null);
});

test('carrier dispatch is admitted only for an enrolled run with the build context: the same launch then runs', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('enroll').status, 0);
  assert.equal(fx.cli('context', { phase: 'review' }).status, 0);
  const wrong = carrierRun(fx);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /context_missing/, 'the wrong phase context does not admit a worker');
  assert.deepEqual(fx.runs(), []);
  assert.equal(fx.cli('context', { phase: 'build' }).status, 0);
  const ok = carrierRun(fx);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(fx.runs(), ['a']);
});

test('missing, wrong-phase and forged context records are refused (gate ship-ready needs ship, drive needs build)', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('enroll').status, 0);
  assert.equal(fx.cli('context', { phase: 'build' }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.equal(fx.cli('context', { phase: 'review' }).status, 0);
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).status, 0);
  const sr = fx.gate('ship-ready', {});
  assert.equal(sr.out.code, 'context_missing', sr.stdout);
  assert.equal(fx.readState().ship_ready ?? null, null);
  // a hand-written context record whose inventory is not the pinned skill's is stale
  fx.editState(S => { S.contexts.ship = { ...S.contexts.review }; });
  assert.equal(fx.gate('ship-ready', {}).out.code, 'context_stale');
  fx.editState(S => { S.contexts.build.inventory[0].sha256 = 'sha256:' + '0'.repeat(64); });
  assert.ok(fx.cli('drive').out.judgments.some(j => j.code === 'context_stale'));
});

test('a gate never issues PASS on an invalid enrollment (another run\'s enrollment record)', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  fx.editState(S => { S.enrollment.run_id = 'run-0'; });
  const g = fx.gate('review', passReview('rx-1', fx.candidate()));
  assert.equal(g.out.code, 'not_enrolled', g.stdout);
  assert.equal(fx.readState().review_chain.length, 0);
});

test('no degraded or owner-approved bypass exists: the commands are gone and forged approvals change nothing', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  for (const cmd of ['degrade', 'approve-degraded']) assert.equal(fx.cli(cmd, { reason: 'x' }).status, 1, cmd);
  fx.appendRunState({ run_id: 'run-1', event: 'DEGRADED_APPROVED', owner_quote: 'ship it', authorized_by: 'owner' });
  fx.editState(S => { S.degraded_approved = { owner_quote: 'ship it' }; });
  fx.commitAll();
  denied(authorize(fx, 'publish'), 'ship_ready_missing');
  assert.equal(fx.cli('publish').status, 2);
  assert.equal(fx.remoteHead(), null);
});

test('context provenance, git install: replaced work-tree bytes and a moved HEAD never change what is delivered', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  const s = skillCopy(fx, { git: true });
  assert.equal(s.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(s.cli('enroll').status, 0);
  const brief = join(s.dir, 'references', 'brief.md');
  const original = readFileSync(brief, 'utf8');
  writeFileSync(brief, 'FORGED BRIEF\n');
  writeFileSync(join(s.dir, 'references', 'context-manifest.json'), manifestText(buildManifest(s.dir))); // a consistent rewrite
  let c = s.cli('context', { phase: 'build' });
  assert.equal(c.status, 0, c.stderr);
  assert.ok(c.stdout.includes(original) && !c.stdout.includes('FORGED BRIEF'), 'the pinned commit is delivered');
  for (const a of [['add', '-A'], ['commit', '-q', '-m', 'forged']]) spawnSync('git', a, { cwd: s.dir, env: fx.env });
  c = s.cli('context', { phase: 'build' });
  assert.ok(c.stdout.includes(original) && !c.stdout.includes('FORGED BRIEF'), 'a new commit on the skill does not move the pin');
  assert.equal(s.cli('authorize', { stage: 'build' }).status, 0);
  const re = s.cli('enroll');
  assert.equal(re.status, 2);
  assert.match(re.stderr, /enrollment_conflict/, 'a run never re-pins to another skill revision');
});

test('context provenance, copy install: a replaced reference or a replaced (rebuilt) manifest is refused', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  const s = skillCopy(fx);
  assert.equal(s.cli('init', { dag: fx.dagFile }).status, 0);
  const e = s.cli('enroll');
  assert.equal(e.out.enrollment.mode, 'copy');
  assert.equal(s.cli('context', { phase: 'build' }).status, 0);
  assert.equal(s.cli('authorize', { stage: 'build' }).status, 0);
  const brief = join(s.dir, 'references', 'brief.md');
  const original = readFileSync(brief);
  writeFileSync(brief, 'FORGED BRIEF\n');
  let c = s.cli('context', { phase: 'build' });
  assert.equal(c.status, 2);
  assert.equal(c.stdout, '', 'nothing is delivered');
  assert.match(c.stderr, /reference_changed/);
  assert.match(s.cli('authorize', { stage: 'build' }).stderr, /reference_changed/);
  writeFileSync(join(s.dir, 'references', 'context-manifest.json'), manifestText(buildManifest(s.dir)));
  c = s.cli('context', { phase: 'build' });
  assert.match(c.stderr, /manifest_drift/);
  assert.match(s.cli('drive').stdout, /manifest_drift/);
  writeFileSync(brief, original);
  writeFileSync(join(s.dir, 'references', 'context-manifest.json'), manifestText(buildManifest(s.dir)));
  writeFileSync(join(s.dir, 'references', 'extra.md'), 'x');
  assert.match(s.cli('context', { phase: 'build' }).stderr, /reference_extra/);
  unlinkSync(join(s.dir, 'references', 'extra.md'));
  assert.equal(s.cli('context', { phase: 'build' }).status, 0, 'restoring the enrolled bytes restores delivery');
});

test('publish binds head, tree, candidate and branch: a change between authorize and push is authorization_moved', { skip: WIN_SKIP }, async (t) => {
  const fx = shippable(t);
  const ctx = { repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1', env: fx.env };
  let recorded = 0;
  const moved = await publish({ ...ctx, beforePush: async () => { fx.okGit(['commit', '-q', '--allow-empty', '-m', 'racing commit']); } }, readEngine, async () => { recorded++; });
  assert.equal(moved.code, 'authorization_moved', JSON.stringify(moved));
  const edited = await publish({ ...ctx, beforePush: async () => { writeFileSync(join(fx.repo, 'src', 'a.txt'), 'raced'); fx.commitAll('raced'); } }, readEngine, async () => { recorded++; });
  assert.equal(edited.code, 'candidate_stale', JSON.stringify(edited));
  assert.equal(recorded, 0);
  assert.equal(fx.remoteHead(), null, 'nothing was pushed');
});

test('stale candidate is denied; a non-candidate git event still allows; unreviewed committed bytes are tree_dirty', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  allowed(authorize(fx, 'publish'));
  fx.okGit(['commit', '-q', '--allow-empty', '-m', 'empty']);
  fx.okGit(['tag', 'v-test']);
  writeFileSync(join(fx.repo, 'session-log.md'), 'entry');
  fx.commitAll('log');
  allowed(authorize(fx, 'publish'), 'publication');
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'unreviewed');
  fx.commitAll('sneak');
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'a1');
  denied(authorize(fx, 'publish'), 'tree_dirty');
  fx.okGit(['checkout', '--', 'src/a.txt']);
  denied(authorize(fx, 'publish'), 'candidate_stale');
  denied(fx.cli('publish'), 'candidate_stale');
  assert.equal(fx.remoteHead(), null);
});

test('a SHIP_READY superseded by a later FAIL review of the same candidate no longer authorizes publish', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  fx.commitAll('retry line');
  assert.equal(fx.gate('review', failReview('rx-2', fx.candidate(), 'src/a.txt', fx.prompt('fix'))).status, 0);
  denied(authorize(fx, 'publish'), 'ship_ready_superseded');
});

test('base contract: a DAG base branch works, and so does the default config.base HEAD after the commit', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t, { base: 'ship-base' });
  allowed(authorize(fx, 'publish'), 'publication');
  fx.okGit(['checkout', '-q', '-b', 'feature-x']);
  denied(authorize(fx, 'publish'), 'branch_not_ticket');
  fx.okGit(['checkout', '-q', '--detach']);
  denied(authorize(fx, 'publish'), 'branch_detached');
});

test('resume and archive keep the enrollment evidence', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('resume').status, 0);
  allowed(authorize(fx, 'build'), 'admitted');
  const a = fx.cli('archive');
  assert.equal(a.status, 0, a.stderr);
  const kept = JSON.parse(readFileSync(join(a.out.archive, 'state.json'), 'utf8'));
  assert.equal(kept.enrollment.run_id, 'run-1');
  assert.deepEqual(Object.keys(kept.contexts).sort(), ['build', 'review', 'ship']);
});

test('migration: a run without enrollment (any state created before this change) is diagnostic-only until enrolled', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  fx.editState(S => { delete S.enrollment; delete S.contexts; }); // the legacy shape: no enrollment keys at all
  assert.equal(fx.cli('status').status, 0);
  assert.equal(fx.cli('resume').status, 0);
  assert.equal(fx.cli('context', { phase: 'review' }).status, 0, 'context still delivers (unrecorded)');
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).out.code, 'not_enrolled');
  // a git install may enroll a legacy run after its attempts (the pin is a commit, no worker can rewrite it)
  const e = fx.cli('enroll');
  assert.equal(e.status, 0, e.stderr);
  assert.equal(e.out.enrollment.attempts_before, 1);
  for (const phase of ['review', 'ship']) assert.equal(fx.cli('context', { phase }).status, 0);
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).status, 0);
  // a copy install may not: its files could have been written by those attempts
  const g = enrollFixture(t, { admit: false });
  const s = skillCopy(g);
  assert.equal(s.cli('init', { dag: g.dagFile }).status, 0);
  g.editState(S => { S.attempts.push({ attempt_id: 'att-old', node: 'a', status: 'exited', quiesced: true }); });
  const refused = s.cli('enroll');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /enrollment_after_execution/);
});

test('two runs and two tickets never authorize each other; read-only commands are never blocked', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  allowed(authorize(fx, 'publish'));
  denied(authorize(fx, 'publish', 'run-2'), 'run_mismatch');
  const other = spawnCli(fx, ['authorize', '--stage', 'publish', '--repo', fx.repo, '--ticket', 'T-2', '--run-id', 'run-1']);
  assert.equal(JSON.parse(other.stdout).code, 'not_enrolled');
  const nostate = spawnCli(fx, ['context', '--phase', 'understand', '--repo', fx.repo, '--ticket', 'T-2', '--run-id', 'run-1']);
  assert.equal(nostate.status, 0);
  assert.match(nostate.stdout, /references\/understand\.md/);
  assert.match(nostate.stderr, /"recorded":false,"code":"no_state"/);
});

test('forged records: ENROLLED lines in RUN-STATE and the engine log are inert; a same-user state rewrite is the residual', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { admit: false });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  fx.appendRunState({ run_id: 'run-1', event: 'ENROLLED', mode: 'git' });
  appendFileSync(fx.engineLog(), JSON.stringify({ run_id: 'run-1', event: 'ENROLLED', event_id: 'forged' }) + '\n');
  denied(authorize(fx, 'build'), 'not_enrolled', 'unactivated');
  // RESIDUAL: a process of the same user copying a valid enrollment into the state file is accepted
  // (the engine state has no integrity protection against its own user).
  const g = enrollFixture(t);
  assert.equal(g.cli('init', { dag: g.dagFile }).status, 0);
  const valid = g.readState();
  fx.editState(S => { S.enrollment = valid.enrollment; S.contexts = valid.contexts; });
  allowed(authorize(fx, 'build'), 'admitted');
  writeFileSync(fx.stateFile(), '{');
  assert.equal(authorize(fx, 'build').out.code, 'state_unreadable', 'a malformed state fails closed');
  assert.ok(existsSync(fx.stateFile()));
});
