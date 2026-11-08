/**
 * RED specs for the AIS-HARNESS-2 ais2-review-3 REPAIR batch (ais2-review-2 findings: Opus N3-N6,
 * Codex blockers 1-4, handover items 3/5/8/10/11 re-verified). Test names start with the batch
 * item letter (A..G). Every test drives the REAL engine: the `node run-engine.mjs` CLI on a temp
 * git repo with a fake provider CLI, or the exported command functions when a test needs an
 * injected seam (hooks, groupAlive). No test hand-edits the engine state file.
 *
 * ============================ CONTRACT ADDITIONS (review-3) ============================
 * Builders: a builder recorded as '<provider>:provider-default' (no modelMap entry) is the same
 *   reviewer as EVERY identity of that provider ('<provider>:<anything>'): 'reviewer_is_builder'.
 * Runners: RED and proof runners reach 'exited' only after whole-group quiescence is proven
 *   (killed and awaited). Unknown or surviving group -> the attempt stays 'unknown', its locks stay
 *   held, the gate returns 'quiescence_unknown' (judgment_point) and no RED evidence or
 *   LOCAL_PROOF is recorded; a proof runner also leaves a durable judgment.
 * ship-ready: after the engine-run proof, the approval binding (run id, plan narrative, DAG bytes)
 *   is re-verified with the candidate; drift drops the proof and refuses (judgment_point).
 * REPAIR start: a review repair is dispatched only when the current candidate equals the freeze;
 *   otherwise 'post_freeze_drift' on the repair (nothing launched, no round spent).
 * Overflow: an original FAIL whose primary or second opinion has overflow:true is terminal: it is
 *   recorded (overflow:true) but opens no repair (code 'review_terminal', judgment_point);
 *   only a RUN-STATE RETRY linked to it continues. A PASS with a second-opinion overflow is
 *   'outcome_inconsistent'.
 * Worker appends: a worker's verified RUN-STATE append is recorded (PLAN_APPENDED); a worker
 *   append of START, DAG_BOUND or RETRY is an ownership violation, and gate review never honours
 *   a RETRY that a worker appended (review-4 generalizes this to every dispatched path: only
 *   state.authority.trusted lines count; see run-engine-review4.test.mjs).
 * Round counters: an automatic infra retry of a review repair re-dispatches within the round it
 *   already holds (never 'round_limit').
 * =========================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { init, drive, gate } from './run-engine.mjs';
import { POSIX, fixture, codes, runStateEvents, waitUntil, passReview, failReview, confirmReview,
  primaryReview, secondOpinion } from './engine-test-fixture.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment';
const FAILING_SPEC = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails on assertion', () => { assert.equal(1, 2); });\n`;
const RED_SPECS = [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }];
const TAP_RUNNER = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };
const PROOF = { proof: { cmd: process.execPath, args: ['-e', ''] } };

const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); };
const shipReadyEvents = (fx) => runStateEvents(fx.planFile).filter(e => e.event === 'SHIP_READY');

function redFixture(t, { nodes, config = {}, behaviour = {} } = {}) {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: TAP_RUNNER }, ...config },
    nodes: nodes ?? [{ id: 'r', writes: ['src/r.txt'], resources: ['db:test'], redSpecs: RED_SPECS },
      { id: 'p', deps: ['r'], writes: ['src/p.txt'] }],
    behaviour: { r: { write: { 'src/r.txt': 'r1' } }, p: { write: { 'src/p.txt': 'p1' } }, ...behaviour } });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), FAILING_SPEC);
  return fx;
}

/** FAIL review rx-1 on src/a.txt after building a; `fix` is the repair brief's node id. */
function failed(t, { config = {}, behaviour = {} } = {}) {
  const fx = fixture(t, { commit: true, config, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } }, ...behaviour } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  return fx;
}

// ------------------------------------------------------------------ A provider-default builders

test('A a provider-default builder matches every reviewer of its provider (primary, second opinion, confirmation)', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  assert.ok(fx.readState().builders.some(b => b.identity === 'claude:provider-default'), 'the default fixture records the unresolved model');
  const cand = fx.candidate();
  refused(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { reviewer_identity: 'claude:claude-opus-5-5' }) })), 'reviewer_is_builder');
  refused(fx.gate('review', passReview('rx-1', cand, { second_opinion: secondOpinion(cand, { reviewer_identity: 'claude:claude-sonnet-x' }) })), 'reviewer_is_builder');
  ok(fx.gate('review', failReview('rx-1', cand, 'src/a.txt', fx.prompt('fix'))), 'a different provider is still independent');
  ok(fx.cli('drive'));
  const c2 = fx.candidate();
  const bad = confirmReview('rx-1', c2);
  bad.primary.reviewer_identity = 'claude:claude-opus-5-5';
  refused(fx.gate('review', bad), 'reviewer_is_builder');
});

// ------------------------------------------------------------------ B runner quiescence

test('B a proof runner whose process group cannot be proven gone records no LOCAL_PROOF and leaves a judgment', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: PROOF } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  const r = await gate(fx.ctx({ gate: 'ship-ready', input: {}, groupAlive: () => null }));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'quiescence_unknown');
  assert.equal(r.judgment_point, true);
  const s = fx.readState();
  assert.equal(s.local_proof ?? null, null, 'no local proof from a runner that may still be running');
  assert.ok(!s.events.some(e => e.type === 'LOCAL_PROOF'));
  assert.ok(s.judgments.some(j => j.code === 'quiescence_unknown'), JSON.stringify(s.judgments));
  assert.notEqual(s.attempts.find(a => a.kind === 'proof').status, 'exited');
  assert.deepEqual(shipReadyEvents(fx), []);
});

test('B a RED runner group that survives the kill is not exited: no evidence, its lock stays held', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const r = await gate(fx.ctx({ gate: 'red', input: { node: 'r', command: 'unit' }, groupAlive: () => true }));
  assert.equal(r.code, 'quiescence_unknown', JSON.stringify(r));
  assert.equal(r.judgment_point, true);
  const s = fx.readState();
  assert.equal(s.gates.red.r, undefined, 'no RED evidence from an unquiesced runner');
  const a = s.attempts.find(x => x.kind === 'gate-red');
  assert.notEqual(a.status, 'exited');
  assert.equal(s.locks['db:test'], a.attempt_id, 'the resource stays locked');
  assert.ok(fx.gate('ship-ready', {}).out.reasons.includes('attempts_live'), 'an unquiesced runner blocks ship-ready');
});

// ------------------------------------------------------------------ C binding re-verified after the proof

test('C a proof command that edits the excluded plan narrative never yields SHIP_READY', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { proof: { cmd: process.execPath,
    args: ['-e', "require('fs').appendFileSync('.specs/plans/T-1.md', '\\nedited by proof\\n')"] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  const r = fx.gate('ship-ready', {});
  refused(r, 'approval_mismatch');
  assert.equal(r.out.judgment_point, true);
  assert.deepEqual(shipReadyEvents(fx), [], 'no SHIP_READY after the proof drifted the approval');
  const s = fx.readState();
  assert.equal(s.ship_ready ?? null, null);
  assert.notEqual(s.local_proof?.candidate_id, fx.candidate(), 'the drifted proof is not reusable');
});

test('C a proof command that edits the bound DAG never yields SHIP_READY', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { proof: { cmd: process.execPath,
    args: ['-e', "const f = require('path').join(process.cwd(), '..', 'dag.json'); require('fs').appendFileSync(f, '\\n')"] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  const r = fx.gate('ship-ready', {});
  refused(r, 'dag_mismatch');
  const s = fx.readState();
  assert.ok(!(s.local_proof?.candidate_id === fx.candidate()), 'the drifted proof is dropped');
  assert.equal(s.ship_ready ?? null, null);
});

// ------------------------------------------------------------------ D repair starts from the freeze

test('D drift after the freeze outside every node and the write set blocks the repair; it is never absorbed', { skip: WIN_SKIP }, async (t) => {
  const fx = failed(t);
  const frozen = fx.readState().freeze.candidate;
  writeFileSync(join(fx.repo, 'docs', 'unrelated.txt'), 'slipped in after the freeze');
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(j => j.code === 'post_freeze_drift' && j.node === 'repair-rx-1'), JSON.stringify(r.out.judgments));
  assert.equal(fx.runs('fix').length, 0, 'the repair never ran on a drifted tree');
  assert.equal(r.out.rounds.review_repairs['rx-1'] ?? 0, 0);
  const s = fx.readState();
  assert.equal(s.freeze.candidate, frozen, 'the confirmation freeze did not absorb the drift');
  assert.ok(!s.review_chain.some(e => e.kind === 'repair'));
  rmSync(join(fx.repo, 'docs', 'unrelated.txt'));
  const after = fx.cli('drive');
  ok(after, 'with the drift reverted the repair proceeds');
  assert.equal(after.out.repairs[0].state, 'done');
  assert.equal(fx.readState().review_chain.find(e => e.kind === 'repair').old_candidate, frozen);
});

// ------------------------------------------------------------------ E overflow is terminal

test('E an overflow FAIL opens no repair, reaches no confirmation or SHIP_READY; only a linked RETRY continues', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: PROOF },
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const cand = fx.candidate();
  const over = failReview('rx-1', cand, 'src/a.txt', fx.prompt('fix'));
  over.primary.overflow = true;
  const r = fx.gate('review', over);
  assert.equal(r.out?.code, 'review_terminal', r.stdout);
  assert.equal(r.out.judgment_point, true);
  assert.equal(r.status, 2, 'a judgment point exits 2');
  const s = fx.readState();
  assert.deepEqual(s.repairs, [], 'no ordinary repair is enqueued');
  assert.equal(s.review_chain.find(e => e.review_execution === 'rx-1').overflow, true);
  ok(fx.cli('drive'));
  assert.equal(fx.runs('fix').length, 0);
  refused(fx.gate('review', confirmReview('rx-1', cand)), 'chain_broken');
  refused(fx.gate('ship-ready', {}), 'review_not_accepted');
  refused(fx.gate('review', passReview('rx-2', cand)), 'retry_unauthorized');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  ok(fx.gate('review', passReview('rx-2', cand)));
  assert.equal(fx.gate('ship-ready', {}).out.code, 'ship_ready');
});

test('E a second-opinion overflow is terminal on FAIL and inconsistent with PASS', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const cand = fx.candidate();
  const so = secondOpinion(cand, { outcome: 'FAIL', overflow: true, findings: [{ id: 'S1', severity: 'major', path: 'src/a.txt' }] });
  const pass = passReview('rx-1', cand, { second_opinion: so, reconciliation: { dispositions: [{ finding_id: 'S1', source: 'codex', disposition: 'reject' }] } });
  refused(fx.gate('review', pass), 'outcome_inconsistent');
  const fail = failReview('rx-1', cand, 'src/a.txt', fx.prompt('fix'));
  fail.second_opinion = so;
  fail.reconciliation.dispositions.push({ finding_id: 'S1', source: 'codex', disposition: 'fix' });
  assert.equal(fx.gate('review', fail).out?.code, 'review_terminal');
  assert.deepEqual(fx.readState().repairs, []);
});

// ------------------------------------------------------------------ F re-verified handover items (adversarial probes)

test('F5 a moved config.base invalidates RED evidence before a dependent dispatch', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'mid-run'], { cwd: fx.repo, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(j => j.code === 'red_invalidated' && /config\.base moved/.test(j.reason)), JSON.stringify(r.out.judgments));
  assert.equal(fx.runs('p').length, 0);
});

test('F8 an empty reviewed path, an empty coverage partition or a reasonless exclusion is refused', async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const cand = fx.candidate();
  for (const over of [{ reviewed_paths: [''] }, { coverage_partitions: [{ identity: 'opus:review', owned: [], outcome: 'PASS' }] },
    { reasoned_exclusions: [{}] }, { reasoned_exclusions: [{ path: 'x' }] }, { findings: [{ id: 'F1' }] }]) {
    refused(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, over) })), 'incomplete_contract');
  }
  assert.equal(fx.readState().review_chain.length, 0);
});

test('F10 ship-ready refuses a live attempt left by a crashed engine and an open repair', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'h', writes: ['src/h.txt'] }],
    config: { testCommands: PROOF }, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, h: { hang: true } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const engine = fx.spawnCli('drive');
  let att;
  assert.ok(await waitUntil(() => { try { att = fx.readState().attempts.find(a => a.node === 'h' && a.status === 'launched'); } catch { /* mid-write */ } return Boolean(att?.pgid); }, 15000));
  t.after(() => { try { process.kill(-att.pgid, 'SIGKILL'); } catch { /* gone */ } });
  assert.ok(await waitUntil(() => fx.runs('h').length > 0, 15000));
  engine.kill('SIGKILL');
  await new Promise(r => engine.once('exit', r));
  const r = fx.gate('ship-ready', {});
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.out.reasons.includes('attempts_live'), r.stdout);

  const open = failed(t);
  const o = open.gate('ship-ready', {});
  assert.equal(o.status, 2);
  assert.ok(o.out.reasons.includes('repairs_open'), o.stdout);
});

test('F11 phase_tokens are enforced for a REPAIR dispatch with imported REPAIR-phase usage', { skip: WIN_SKIP }, async (t) => {
  const fx = failed(t, { config: { budget: { phase_tokens: 50 } } });
  mkdirSync(dirname(fx.usageFile()), { recursive: true });
  writeFileSync(fx.usageFile(), JSON.stringify({ provider: 'claude', run_id: 'run-1', role: 'repair', source: 'session', phase: 'REPAIR',
    source_execution_id: 's:1', input_tokens: 60, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }) + '\n');
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(j => j.code === 'budget_stop' && /REPAIR phase/.test(j.reason)), JSON.stringify(r.out.judgments));
  assert.equal(fx.runs('fix').length, 0);
});

// ------------------------------------------------------------------ G worker appends, infra retry rounds, the allSettled barrier

test('G a worker cannot forge a RETRY: the append is a violation and gate review ignores it', { skip: WIN_SKIP }, async (t) => {
  const forged = { run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' };
  const fx = failed(t, { behaviour: { fix: { write: { 'src/a.txt': 'fixed' }, appendEvent: forged } } });
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(j => j.code === 'repair_outside_findings' && /\.specs\/plans\/T-1\.md/.test(j.reason)), JSON.stringify(r.out.judgments));
  assert.ok(runStateEvents(fx.planFile).some(e => e.event === 'RETRY'), 'the forged line is in the plan file');
  refused(fx.gate('review', passReview('rx-2', fx.candidate())), 'retry_unauthorized');
});

test('G a forged RETRY from a worker that then hangs (timed out) is still never honoured', { skip: WIN_SKIP }, async (t) => {
  const forged = { run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' };
  const fx = failed(t, { config: { timeoutMs: 1000 }, behaviour: { fix: { appendEvent: forged, hang: true } } });
  const r = fx.cli('drive');
  assert.equal(r.out.repairs[0].state, 'failed', r.stdout);
  assert.ok(runStateEvents(fx.planFile).some(e => e.event === 'RETRY'), 'the forged line is in the plan file');
  refused(fx.gate('review', passReview('rx-2', fx.candidate())), 'retry_unauthorized');
});

test('G a NOTE appended by a worker is still allowed and recorded', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' }, appendEvent: { event: 'NOTE', note: 'progress' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  ok(r);
  assert.equal(r.out.nodes.a.state, 'done');
  assert.ok(fx.readState().events.some(e => e.type === 'PLAN_APPENDED' && e.node === 'a'), 'the append stays auditable');
});

test('G an automatic infra retry of a review repair re-dispatches within its round (never round_limit)', { skip: WIN_SKIP }, async (t) => {
  const fx = failed(t, { behaviour: { fix: { exit: 1 } } });
  const first = fx.cli('drive');
  ok(first);
  assert.equal(first.out.repairs[0].state, 'pending', 'provider error with no writes: automatic retry');
  assert.equal(first.out.rounds.review_repairs['rx-1'], 1);
  fx.behave({ fix: { write: { 'src/a.txt': 'fixed' } } });
  const second = fx.cli('drive');
  ok(second);
  assert.ok(!codes(second.out).includes('round_limit'), JSON.stringify(second.out.judgments));
  assert.equal(second.out.repairs[0].state, 'done');
  assert.equal(fx.runs('fix').length, 2);
  assert.equal(second.out.rounds.review_repairs['rx-1'], 1, 'the retry spent no second round');
});

test('G a throw inside the dispatch loop still waits for every running sibling before the lock is released', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { config: { budget: { ticket_tokens: 1e9 }, width: 2 },
    nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'c', writes: ['src/c.txt'] }, { id: 'b', writes: ['src/b.txt'] }] });
  const flag = join(fx.root, 'release-a');
  const usageDir = relative(fx.repo, fx.usageFile()) + '/x';
  // c creates the usage path as a directory; a is released only once c's settle is COMMITTED (no
  // timer), so the rescan after c throws EISDIR in budgetOk(b) while a is still running.
  fx.behave({ a: { write: { 'src/a.txt': 'a1' }, waitFor: flag }, c: { write: { 'src/c.txt': 'c1', [usageDir]: '' } }, b: { write: { 'src/b.txt': 'b1' } } });
  await init(fx.ctx());
  const hooks = { boundary: async (name) => {
    if (name !== 'dir-fsync' || existsSync(flag)) return;
    if (JSON.parse(readFileSync(fx.stateFile(), 'utf8')).attempts.some(x => x.node === 'c' && x.status === 'exited')) writeFileSync(flag, '');
  } };
  await assert.rejects(async () => drive(fx.ctx({ hooks })), { code: 'EISDIR' });
  assert.equal(existsSync(fx.lockFile()), false, 'the lock is released on the way out');
  assert.equal(fx.readState().nodes.a.state, 'done', 'the running sibling settled and committed before the rethrow');
  assert.equal(fx.runs('b').length, 0);
});
