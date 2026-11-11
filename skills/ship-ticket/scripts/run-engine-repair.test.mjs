/**
 * RED specs for the AIS-HARNESS-2 review-2 REPAIR batch (the 17 reconciled findings of
 * ais2-review-1, .specs/reviews/AIS-HARNESS-2/HANDOVER.md). Test names start with the finding
 * number (R1..R17) or X for the "also fix" items. Every test drives the REAL engine: the
 * `node run-engine.mjs <command>` CLI on a temp git repo with a fake provider CLI, or the same
 * exported command functions when a test needs an injected seam (hooks, groupAlive). No test
 * hand-edits the engine state file.
 *
 * ============================ CONTRACT ADDITIONS (review-2) ============================
 * Digests: planNarrativeDigest and the DAG digest are 'sha256:<hex>' (the skill's canonical
 *   form). START approved_plan_digest, DAG_BOUND dag_digest and a DAG digest listed in the plan
 *   narrative are accepted in either 'sha256:' or legacy 'sha256-' spelling (normalized).
 * DAG config:
 *   candidateExclusions  exactly ['.specs/plans/<ticket>.md', 'session-log.md'] (any order) or
 *                        absent (defaulted to that pair); anything else -> dag_invalid at init.
 *   testCommands         { [name]: { cmd, args: [string], format?: 'tap'|'vitest-json'|'jest-json' } }.
 *                        Entries with a format are RED runners. `gate ship-ready` runs EVERY
 *                        entry as the local proof (exit 0 = pass).
 * Binding: drive, resume, mark and every gate re-verify, before any mutation: state.run_id ==
 *   --run-id ('run_mismatch'), the plan narrative digest ('approval_mismatch') and the DAG bytes
 *   ('dag_mismatch'). Gates return them as judgment points; mark throws.
 * gate red input: { node, command?: <testCommands name>, specs? }. command/format/resources/
 *   timeoutMs never come from the input (usage error). Resources are the node's.
 * gate review input adds repair_prompt_file (absolute path of the repair brief), required when an
 *   accepted FAIL opens a repair ('repair_prompt_missing'). An accepted FAIL enqueues
 *   repairs[{ id: 'repair-<rx>', kind:'review', review_execution, writes: write_set, state:'pending' }].
 *   A new original review after any earlier original (FAIL or the freeze) needs a RUN-STATE event
 *   { run_id, event:'RETRY', review_execution:<new rx>, predecessor:<last rx>, authorized_by }
 *   ('retry_unauthorized'). Reviewers must differ from every builder ('reviewer_is_builder';
 *   identity '<provider>:<model>' or a ':'-suffixed extension of it) and from each other
 *   ('reviewers_not_distinct'). The primary contract's nested rows and outcome enums are validated.
 * Builders: state.builders[] { provider, model, node, identity: '<provider>:<model>' } per real dispatch.
 * Repair completion appends { kind:'repair', review_execution, old_candidate, new_candidate,
 *   write_set, attempt_id } to review_chain and re-freezes on new_candidate. Round counters
 *   increase only when the dispatch is actually launched.
 * RED barrier: a node (or a repair, through the nodes whose writes it overlaps) whose dependency
 *   has redSpecs waits for accepted RED evidence that is still valid: spec digests unchanged and
 *   the resolved config.base commit unchanged; otherwise the evidence is dropped, the engine
 *   re-runs RED and the judgment 'red_invalidated' names the re-run (run-engine-wave0.test.mjs N2).
 * Quiescence: an attempt is recorded only after its whole process group is gone (killed and
 *   awaited after the launcher exits). Unknown quiescence (Windows) -> 'quiescence_unknown',
 *   never done.
 * Ownership: worker snapshots include the ticket plan file; only a verified RUN-STATE append is
 *   allowed there. A snapshot git cannot produce -> 'ownership_unavailable' (judgment).
 * ship-ready also refuses: 'nodes_unfinished', 'attempts_live', 'repairs_open',
 *   'judgments_unresolved'; local proof only from the engine-run testCommands (input
 *   local_proof is a usage error).
 * Budgets: usage = engine records + the imported file git-path ai-skills/ship-ticket/<ticket>.usage.jsonl,
 *   deduplicated by source_execution_id, evaluated with the dispatching item's phase before every
 *   node AND repair dispatch. status.budget = { ticket, phase, flags } (null without a budget).
 *   Engine usage records carry role and source 'engine'.
 * Telemetry: a failing run-log or RUN-STATE sink never fails a command: the event stays in the
 *   outbox and status.telemetry_degraded lists it; resume replays it.
 * mark failed->pending that clears a judgment records cleared_judgments [{ code, node }] on its MARK event.
 * =========================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { init, drive, acquireLock, planNarrativeDigest } from './run-engine.mjs';
import { verifyReviewExecution } from './carrier.mjs';
import { POSIX, fixture, codes, runStateEvents, runLogEvents, waitUntil, delay, passReview, failReview,
  confirmReview, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { WORKER_FAILURE_BOUND_MS, processGone } from './test-wait.test-helper.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment';
const injected = () => Object.assign(new Error('injected fault'), { code: 'injected' });
const FAILING_SPEC = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails on assertion', () => { assert.equal(1, 2); });\n`;
const RED_SPECS = [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }];
const TAP_RUNNER = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };

/** RED node r (spec outside every node's fingerprints) and production node p depending on it. */
function redFixture(t, { nodes, config = {}, behaviour = {} } = {}) {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: TAP_RUNNER }, ...config },
    nodes: nodes ?? [{ id: 'r', writes: ['src/r.txt'], resources: ['db:test'], redSpecs: RED_SPECS },
      { id: 'p', deps: ['r'], writes: ['src/p.txt'] }],
    behaviour: { r: { write: { 'src/r.txt': 'r1' } }, p: { write: { 'src/p.txt': 'p1' } }, ...behaviour } });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), FAILING_SPEC);
  return fx;
}

const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); };

// ------------------------------------------------------------------ R1 binding re-verified by every gate

test('R1 gate commands re-verify run identity and the approved plan and DAG digests before any mutation', async (t) => {
  const fx = redFixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const cand = fx.candidate();
  const plan = readFileSync(fx.planFile, 'utf8');
  writeFileSync(fx.planFile, plan.replace('Approved narrative.', 'Edited after approval.'));
  const drifted = fx.gate('review', passReview('rx-1', cand));
  refused(drifted, 'approval_mismatch');
  assert.equal(drifted.out.judgment_point, true);
  assert.equal(fx.readState().review_chain.length, 0, 'nothing recorded after approval drift');
  const mark = fx.cli('mark', { node: 'p', transition: 'pending->cancelled', reason: 'scope' });
  assert.notEqual(mark.status, 0, 'mark refuses after approval drift');
  assert.equal(fx.readState().nodes.p.state, 'pending');
  writeFileSync(fx.planFile, plan);

  const dag = readFileSync(fx.dagFile, 'utf8');
  writeFileSync(fx.dagFile, dag + '\n');
  refused(fx.gate('red', { node: 'r', command: 'unit' }), 'dag_mismatch');
  assert.deepEqual(fx.readState().attempts, [], 'the RED runner never ran against an unbound DAG');
  writeFileSync(fx.dagFile, dag);

  refused(fx.gate('review', passReview('rx-1', cand), { runId: 'run-2' }), 'run_mismatch');
  ok(fx.gate('review', passReview('rx-1', cand)), 'with the binding intact the same review is accepted');
});

// ------------------------------------------------------------------ R2 quiescence before done

test('R2 a node is done only after its whole process group is gone (a background descendant is reaped)', { skip: WIN_SKIP }, async (t) => {
  // timeoutMs is only a failure bound: the worker finishes by itself (#49).
  const fx = fixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS } });
  const pidFile = join(fx.root, 'sleeper.pid');
  fx.behave({ a: { write: { 'src/a.txt': 'a1' }, sleeper: pidFile } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  ok(r);
  assert.equal(r.out.nodes.a.state, 'done');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  // A killed descendant may linger as a zombie until its new parent reaps it, which under load took
  // longer than this 1 s window (#49); processGone counts a zombie as dead. The window is unchanged.
  assert.ok(await waitUntil(() => processGone(pid), 1000), 'the descendant was killed before the node was recorded done');
});

test('R2 unknown quiescence after a clean exit is a judgment point and the node is not done', async (t) => {
  const fx = fixture(t);
  await init(fx.ctx());
  const r = await drive(fx.ctx({ groupAlive: () => null }));
  assert.equal(r.outcome, 'judgment');
  assert.ok(codes(r).includes('quiescence_unknown'), JSON.stringify(r.judgments));
  assert.notEqual(r.nodes.a.state, 'done');
  assert.equal(r.nodes.a.retries, 0, 'never retried without proven quiescence');
});

// ------------------------------------------------------------------ R3 lock barrier

test('R3 drive keeps the lock until every launched attempt has settled, then rethrows', { skip: WIN_SKIP }, async (t) => {
  // timeoutMs is only a failure bound: worker a ends when the flag appears (#49).
  const fx = fixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS }, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', writes: ['src/b.txt'] }] });
  const flag = join(fx.root, 'release-a');
  fx.behave({ a: { write: { 'src/a.txt': 'a1' }, waitFor: flag }, b: { write: { 'src/b.txt': 'b1' } } });
  await init(fx.ctx());
  const nodeOf = new Map();
  let thrown = false;
  const hooks = { boundary: async (name, info) => {
    if (name === 'after-intent') nodeOf.set(info.attempt_id, info.node);
    if (name === 'after-release' && nodeOf.get(info.attempt_id) === 'b' && !thrown) {
      thrown = true;
      setTimeout(() => writeFileSync(flag, ''), 300);
      throw injected();
    }
  } };
  await assert.rejects(async () => drive(fx.ctx({ hooks })), { code: 'injected' });
  assert.equal(thrown, true);
  assert.equal(existsSync(fx.lockFile()), false, 'the lock is released on the way out');
  assert.equal(fx.readState().nodes.a.state, 'done', 'the sibling settled and committed before the lock was released');
});

// ------------------------------------------------------------------ R4 RED runner recovery and durable locks

test('R4 a surviving RED runner from a crashed gate blocks dispatch of a node sharing its resource', { skip: WIN_SKIP }, async (t) => {
  // The runner marks (outside the repo) that it was released and started, then holds db:test.
  const hold = "require('fs').writeFileSync('../runner.started', ''); setTimeout(() => {}, 60000)";
  const fx = redFixture(t, { config: { testCommands: { unit: { cmd: process.execPath, args: ['-e', hold], format: 'tap' } } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], resources: ['db:test'], redSpecs: RED_SPECS },
      { id: 'w', writes: ['src/w.txt'], resources: ['db:test'] }],
    behaviour: { w: { write: { 'src/w.txt': 'w1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const input = join(fx.root, 'red-input.json');
  writeFileSync(input, JSON.stringify({ node: 'r', command: 'unit' }));
  const gate = fx.spawnCli('gate red', { input });
  let runner;
  assert.ok(await waitUntil(() => { try { runner = fx.readState().attempts.find(a => a.kind === 'gate-red' && a.status === 'running'); } catch { /* mid-write */ } return Boolean(runner?.pgid); }, 15000));
  t.after(() => { try { process.kill(-runner.pgid, 'SIGKILL'); } catch { /* gone */ } });
  // 'running' is committed before the release byte; kill the gate only once the runner really started.
  assert.ok(await waitUntil(() => existsSync(join(fx.root, 'runner.started')), 15000), 'the released runner started');
  gate.kill('SIGKILL');
  await new Promise(r => gate.once('exit', r));

  const blocked = fx.cli('drive', { until: 'w' });
  ok(blocked);
  assert.equal(fx.runs('w').length, 0, 'no worker may share db:test with a live RED runner');
  assert.notEqual(blocked.out.outcome, 'done');

  process.kill(-runner.pgid, 'SIGKILL');
  assert.ok(await waitUntil(() => { try { process.kill(-runner.pgid, 0); return false; } catch { return true; } }));
  const after = fx.cli('drive', { until: 'w' });
  ok(after);
  assert.equal(after.out.nodes.w.state, 'done');
  const s = fx.readState();
  assert.equal(s.locks['db:test'], undefined, 'the dead runner released its lock');
  assert.equal(s.attempts.find(a => a.attempt_id === runner.attempt_id).status, 'abandoned');
});

// ------------------------------------------------------------------ R5 RED bound to the DAG; the barrier

test('R5 RED command, format and resources come from the bound DAG; the input only selects', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const smuggled = fx.gate('red', { node: 'r', command: { cmd: process.execPath, args: ['-e', ''] }, format: 'tap' });
  assert.equal(smuggled.status, 1, 'a command or format in the input is a usage error');
  assert.equal(fx.gate('red', { node: 'r', command: 'unit', resources: [] }).status, 1, 'resources never come from the input');
  refused(fx.gate('red', { node: 'r', command: 'nope' }), 'unknown_command');
  const accepted = fx.gate('red', { node: 'r', command: 'unit' });
  ok(accepted);
  assert.equal(accepted.out.code, 'red_accepted');
  const s = fx.readState();
  assert.equal(s.gates.red.r.format, 'tap', 'format from the DAG entry');
  assert.equal(s.gates.red.r.command, 'unit');
  assert.deepEqual(s.attempts.find(a => a.kind === 'gate-red').resources, ['db:test'], 'resources from the DAG node');
});

test('R5 barrier: a dependent of an unaccepted RED node is not dispatched; accepted RED releases it', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const first = fx.cli('drive');
  ok(first);
  assert.equal(first.out.nodes.r.state, 'done');
  assert.equal(first.out.nodes.p.state, 'pending');
  assert.equal(fx.runs('p').length, 0, 'production work waits for RED');
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const second = fx.cli('drive');
  ok(second);
  assert.equal(second.out.nodes.p.state, 'done');
});

test('R5 barrier: RED evidence is invalidated when a spec file changes; re-running RED releases the dependent', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const first = fx.readState().gates.red.r.attempt_id;
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), FAILING_SPEC + '// edited after RED\n');
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(codes(r.out).includes('red_invalidated'), JSON.stringify(r.out.judgments));
  assert.equal(fx.runs('p').length, 0);
  const rerun = fx.readState();
  const now = rerun.gates.red.r?.attempt_id;
  assert.notEqual(now, first, 'stale evidence is dropped and the engine re-ran RED (wave0 N2)');
  // PR #38 4507604554: the new evidence is a completed gate-red attempt the engine accepted, not an absent id.
  assert.ok(rerun.attempts.some(a => a.attempt_id === now && a.kind === 'gate-red' && a.status === 'exited'), JSON.stringify(rerun.attempts));
  assert.ok(rerun.events.some(e => e.type === 'RED_ACCEPTED' && e.attempt_id === now));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  assert.equal(fx.cli('drive').out.nodes.p.state, 'done');
});

test('R5 barrier: one accepted RED releases every dependent even after a sibling dependent wrote files', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t, { config: { width: 1 }, nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: RED_SPECS },
    { id: 'p', deps: ['r'], writes: ['src/p.txt'] }, { id: 'q', deps: ['r'], writes: ['src/q.txt'] }],
  behaviour: { q: { write: { 'src/q.txt': 'q1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const r = fx.cli('drive');
  ok(r);
  assert.equal(r.out.nodes.p.state, 'done');
  assert.equal(r.out.nodes.q.state, 'done');
});

test('R5 barrier applies to repairs: a repair over a node whose RED evidence is no longer valid waits for RED', { skip: WIN_SKIP }, async (t) => {
  const fx = redFixture(t, { behaviour: { fix: { write: { 'src/p.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  ok(fx.cli('drive'));
  // The spec changes before the freeze (a spec edit after it is post_freeze_drift, never absorbed by the repair).
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), FAILING_SPEC + '// repair spec\n');
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/p.txt', fx.prompt('fix'))));
  const blocked = fx.cli('drive');
  assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
  assert.ok(codes(blocked.out).includes('red_invalidated'), JSON.stringify(blocked.out.judgments));
  assert.equal(fx.runs('fix').length, 0, 'the repair waits for valid RED');
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 're-established RED after invalidation is not dispatched_before_red');
  const done = fx.cli('drive');
  ok(done);
  assert.equal(done.out.repairs.find(x => x.id === 'repair-rx-1')?.state, 'done');
});

// ------------------------------------------------------------------ R6 review freeze and retry authorization

test('R6 a new original review after a FAIL or after the freeze needs a RUN-STATE RETRY linked to its predecessor', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const cand = fx.candidate();
  ok(fx.gate('review', failReview('rx-1', cand, 'src/a.txt', fx.prompt('fix'))));
  refused(fx.gate('review', passReview('rx-2', cand)), 'retry_unauthorized');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-0', authorized_by: 'owner' });
  refused(fx.gate('review', passReview('rx-2', cand)), 'retry_unauthorized');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  ok(fx.gate('review', passReview('rx-2', cand)), 'an authorized retry linked to its predecessor is accepted');
  const s = fx.readState();
  assert.ok(s.review_chain.some(r => r.kind === 'retry' && r.review_execution === 'rx-2' && r.predecessor === 'rx-1'));
  assert.equal(s.repairs.find(r => r.review_execution === 'rx-1').state, 'cancelled', 'the superseded repair is closed');
  refused(fx.gate('review', passReview('rx-3', cand)), 'retry_unauthorized');
});

// ------------------------------------------------------------------ R7 builder roster

test('R7 builder identities come from real dispatches; a builder or a duplicate reviewer is refused', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { modelMap: { inherit: 'claude-sonnet-test' } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const s = fx.readState();
  assert.ok(s.builders.some(b => b.provider === 'claude' && b.model === 'claude-sonnet-test' && b.node === 'a'
    && b.identity === 'claude:claude-sonnet-test'), JSON.stringify(s.builders));
  const cand = fx.candidate();
  const asBuilder = passReview('rx-1', cand, { primary: primaryReview(cand, { reviewer_identity: 'claude:claude-sonnet-test' }) });
  refused(fx.gate('review', asBuilder), 'reviewer_is_builder');
  const soBuilder = passReview('rx-1', cand, { second_opinion: secondOpinion(cand, { reviewer_identity: 'claude:claude-sonnet-test:relay' }) });
  refused(fx.gate('review', soBuilder), 'reviewer_is_builder');
  const same = passReview('rx-1', cand, { second_opinion: secondOpinion(cand, { reviewer_identity: 'opus:review' }) });
  refused(fx.gate('review', same), 'reviewers_not_distinct');
  ok(fx.gate('review', passReview('rx-1', cand)));
});

// ------------------------------------------------------------------ R8 review contract (CLI)

test('R8 the CLI refuses empty coverage/criteria/rules and an outcome outside its enum', async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const cand = fx.candidate();
  for (const over of [{ coverage_partitions: [] }, { acceptance_criteria: [] }, { rule_rows: [] }, { security_outcome: 'BANANA' },
    { rule_rows: [{ subject_id: 'X', outcome: 'MAYBE', evidence: 'e' }] }, { acceptance_criteria: [{ criterion: 'AC1', outcome: 'PASS' }] }]) {
    refused(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, over) })), 'incomplete_contract');
  }
  assert.equal(fx.readState().review_chain.length, 0);
});

// ------------------------------------------------------------------ R9 repair -> confirmation through the CLI

test('R9 end to end via CLI: FAIL review -> finding-bound REPAIR -> repair record -> targeted confirmation -> SHIP_READY', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } },
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const c1 = fx.candidate();
  const fail = fx.gate('review', failReview('rx-1', c1, 'src/a.txt', fx.prompt('fix')));
  ok(fail);
  assert.deepEqual(fx.cli('status').out.repairs, [{ id: 'repair-rx-1', state: 'pending' }], 'the accepted FAIL enqueued its repair');

  const repaired = fx.cli('drive');
  ok(repaired);
  assert.equal(repaired.out.repairs[0].state, 'done');
  assert.equal(fx.runs('fix').length, 1);
  assert.equal(readFileSync(join(fx.repo, 'src', 'a.txt'), 'utf8'), 'fixed');
  assert.equal(repaired.out.rounds.review_repairs['rx-1'], 1);
  assert.deepEqual(repaired.out.confirmation, { review_execution: 'rx-1', closure: ['a'] });
  const c2 = fx.candidate();
  assert.notEqual(c2, c1);
  const record = fx.readState().review_chain.find(r => r.kind === 'repair');
  assert.equal(record.review_execution, 'rx-1');
  assert.equal(record.old_candidate, c1);
  assert.equal(record.new_candidate, c2);
  assert.deepEqual(record.write_set, ['src/a.txt']);

  refused(fx.gate('ship-ready', {}), 'review_not_accepted');
  ok(fx.gate('review', confirmReview('rx-1', c2)));
  const ship = fx.gate('ship-ready', {});
  ok(ship);
  assert.equal(ship.out.code, 'ship_ready');
  assert.deepEqual(runStateEvents(fx.planFile).filter(e => e.event === 'SHIP_READY').map(e => e.candidate_id), [c2]);
});

test('R9 round counters increase only on an actual dispatch: a refused repair dispatch spends nothing', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const brief = fx.prompt('fix');
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', brief)));
  rmSync(brief);
  const r = fx.cli('drive');
  assert.equal(r.out.repairs[0].state, 'failed', r.stdout);
  assert.equal(r.out.rounds.review_repairs['rx-1'] ?? 0, 0, 'a dispatch refused before launch spends no round');
  assert.equal(fx.runs('fix').length, 0);
});

test('R9 an accepted FAIL without a repair brief is refused and not recorded', async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const { repair_prompt_file: _drop, ...noBrief } = failReview('rx-1', fx.candidate(), 'src/a.txt', '/x');
  refused(fx.gate('review', noBrief), 'repair_prompt_missing');
  assert.equal(fx.readState().review_chain.length, 0);
});

// ------------------------------------------------------------------ R10 ship-ready completeness and engine-run proof

test('R10 ship-ready refuses unfinished nodes and unresolved judgments, and never takes local proof from the input', async (t) => {
  const fx = fixture(t, { commit: true, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', deps: ['a'], writes: ['src/b.txt'] }],
    config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const cand = fx.candidate();
  ok(fx.gate('review', passReview('rx-1', cand)));
  const unfinished = fx.gate('ship-ready', {});
  refused(unfinished, 'nodes_unfinished');
  assert.equal(fx.gate('ship-ready', { local_proof: { candidate_id: cand, commands: [{ cmd: 'echo pass', result: 'pass' }] } }).status, 1,
    'local proof is never self-attested');
  await drive(fx.ctx({ groupAlive: () => null })); // a ends with a quiescence_unknown judgment
  const judged = fx.gate('ship-ready', {});
  assert.equal(judged.status, 2);
  assert.ok(judged.out.reasons.includes('judgments_unresolved'), judged.stdout);
});

test('R10 local proof is produced by the engine running every bound testCommands entry', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: { cmd: process.execPath, args: ['-e', ''] },
    bad: { cmd: process.execPath, args: ['-e', 'process.exit(3)'] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  const r = fx.gate('ship-ready', {});
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.reasons.includes('missing_local_proof'), r.stdout);
  const proof = fx.readState().local_proof;
  assert.deepEqual(proof.commands.map(c => [c.name, c.result, c.exit_code]).sort(), [['bad', 'fail', 3], ['ok', 'pass', 0]]);
});

test('R10 a proof command that changes the work tree is refused; SHIP_READY is never recorded for a stale candidate', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { gen: { cmd: process.execPath, args: ['-e', "require('fs').writeFileSync('gen.txt', 'x')"] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  refused(fx.gate('ship-ready', {}), 'candidate_mismatch');
  assert.deepEqual(runStateEvents(fx.planFile).filter(e => e.event === 'SHIP_READY'), []);
  assert.equal(fx.readState().local_proof.candidate_id, null, 'a proof that changed the tree is bound to no tree (PR #38 4505924540)');
});

// ------------------------------------------------------------------ R11 budgets

const usageRow = (id, tokens, over = {}) => JSON.stringify({ provider: 'claude', run_id: 'run-1', role: 'orchestrator', source: 'session',
  source_execution_id: id, input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, ...over });

test('R11 imported usage counts before every dispatch, deduplicated by source_execution_id', { skip: WIN_SKIP }, async (t) => {
  const dup = fixture(t, { config: { budget: { ticket_tokens: 500 } } });
  ok(dup.cli('init', { dag: dup.dagFile }));
  mkdirSync(dirname(dup.usageFile()), { recursive: true });
  writeFileSync(dup.usageFile(), usageRow('s:1', 300) + '\n' + usageRow('s:1', 300) + '\n');
  ok(dup.cli('drive'), 'the same execution imported twice counts once');
  assert.equal(dup.runs('a').length, 1);

  const over = fixture(t, { config: { budget: { ticket_tokens: 500 } } });
  ok(over.cli('init', { dag: over.dagFile }));
  mkdirSync(dirname(over.usageFile()), { recursive: true });
  writeFileSync(over.usageFile(), usageRow('s:1', 1000) + '\n');
  const r = over.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(codes(r.out).includes('budget_stop'));
  assert.equal(over.runs('a').length, 0);
});

test('R11 phase_tokens are enforced with the dispatching node phase', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { config: { budget: { phase_tokens: 5 } }, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', deps: ['a'], writes: ['src/b.txt'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(codes(r.out).includes('budget_stop'));
  assert.equal(fx.runs('b').length, 0, 'BUILD used 6 of 5 phase tokens');
});

test('R11 repairs go through budget admission', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { budget: { ticket_tokens: 100 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  writeFileSync(fx.usageFile(), usageRow('reviewer:1', 200, { role: 'reviewer' }) + '\n');
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(codes(r.out).includes('budget_stop'));
  assert.equal(fx.runs('fix').length, 0);
  assert.equal(r.out.rounds.review_repairs['rx-1'] ?? 0, 0);
});

test('R11 status shows the budget warning and budget_unenforceable; engine usage carries role and source', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { config: { budget: { ticket_tokens: 7 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const warn = fx.cli('status').out;
  assert.equal(warn.budget.ticket.state, 'warn', JSON.stringify(warn.budget));
  const rec = fx.readState().usage[0];
  assert.equal(rec.role, 'builder');
  assert.equal(rec.source, 'engine');
  writeFileSync(fx.usageFile(), JSON.stringify({ provider: 'codex', run_id: 'run-1', role: 'reviewer', source: 'codex', source_execution_id: 'relay-1',
    input_tokens: null, output_tokens: null, usage_status: 'unknown' }) + '\n');
  assert.ok(fx.cli('status').out.budget.flags.includes('budget_unenforceable'));
});

test('R11 an import line that parses but is not a valid usage record is unknown usage, never a crash', async (t) => {
  const fx = fixture(t, { config: { budget: { ticket_tokens: 500 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  mkdirSync(dirname(fx.usageFile()), { recursive: true });
  writeFileSync(fx.usageFile(), usageRow('s:1', 10, { provider: 'gpt' }) + '\n' + usageRow('s:2', 1.5) + '\n' + '{not json\n');
  const s = fx.cli('status');
  ok(s);
  assert.ok(s.out.budget.flags.includes('budget_unenforceable'), JSON.stringify(s.out.budget));
});

// ------------------------------------------------------------------ R12 telemetry never blocks

test('R12 an unwritable engine log degrades telemetry; the command commits and resume replays the event', async (t) => {
  const fx = fixture(t, { nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'c', writes: ['src/c.txt'] }] });
  ok(fx.cli('init', { dag: fx.dagFile }));
  mkdirSync(fx.engineLog(), { recursive: true }); // appends fail with EISDIR
  ok(fx.cli('mark', { node: 'c', transition: 'pending->cancelled', reason: 'scope' }), 'a sink failure never fails the mark');
  const s = fx.cli('status').out;
  assert.equal(s.nodes.c.state, 'cancelled');
  assert.ok(s.telemetry_degraded.some(d => d.sink === 'engine-log'), JSON.stringify(s.telemetry_degraded));
  assert.equal(runStateEvents(fx.planFile).filter(e => e.event === 'MARK').length, 1);
  rmSync(fx.engineLog(), { recursive: true });
  ok(fx.cli('resume'));
  assert.equal(runLogEvents(fx.engineLog()).filter(e => e.event === 'MARK').length, 1, 'replayed once');
  assert.equal(runStateEvents(fx.planFile).filter(e => e.event === 'MARK').length, 1, 'never duplicated');
  assert.deepEqual(fx.readState().outbox, []);
});

test('R12 carrier REPAIR authorization comes from engine state whenever it exists', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  const approval = { ticket: 'T-1', run_id: 'run-1' };
  assert.equal(existsSync(fx.runLog()), false);
  verifyReviewExecution(fx.repo, approval, 'rx-1'); // no run log: engine state authorizes
  writeFileSync(fx.runLog(), JSON.stringify({ event: 'start', kind: 'phase', name: 'REVIEW', run_id: 'run-1', metrics: { review_execution: 'rx-9' } }) + '\n');
  assert.throws(() => verifyReviewExecution(fx.repo, approval, 'rx-9'), /engine state/);
});

// ------------------------------------------------------------------ R13 digest format

test('R13 init accepts the canonical sha256: START digest and normalizes the legacy sha256- spelling', async (t) => {
  const colon = fixture(t);
  assert.match(planNarrativeDigest(readFileSync(colon.planFile, 'utf8')), /^sha256:[0-9a-f]{64}$/);
  ok(colon.cli('init', { dag: colon.dagFile }));
  const dash = fixture(t, { digestForm: 'dash' });
  ok(dash.cli('init', { dag: dash.dagFile }), 'legacy dash spelling is normalized');
  const bound = fixture(t, { digestForm: 'dash', bind: 'dag_bound' });
  const r = bound.cli('init', { dag: bound.dagFile });
  ok(r);
  assert.equal(r.out.binding, 'dag_bound');
});

// ------------------------------------------------------------------ R14 plan file in worker snapshots

test('R14 worker snapshots include the plan file: a RUN-STATE append is allowed, a narrative edit is a violation', { skip: WIN_SKIP }, async (t) => {
  const append = fixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' }, appendRunState: true } } });
  ok(append.cli('init', { dag: append.dagFile }));
  const r1 = append.cli('drive');
  ok(r1);
  assert.equal(r1.out.nodes.a.state, 'done');

  const forge = fixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' }, editPlan: true } } });
  ok(forge.cli('init', { dag: forge.dagFile }));
  const r2 = forge.cli('drive');
  assert.equal(r2.status, 2, r2.stdout + r2.stderr);
  assert.ok(r2.out.judgments.some(j => j.code === 'ownership_violation' && /\.specs\/plans\/T-1\.md/.test(j.reason)), JSON.stringify(r2.out.judgments));
  assert.equal(r2.out.nodes.a.state, 'failed');
});

test('R14 a snapshot git cannot produce is ownership_unavailable, never clean', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' }, breakGit: true } } });
  await init(fx.ctx());
  t.after(() => rmSync(join(fx.repo, '.git', 'index'), { recursive: true, force: true }));
  const r = await drive(fx.ctx());
  assert.equal(r.outcome, 'judgment');
  assert.ok(codes(r).includes('ownership_unavailable'), JSON.stringify(r.judgments));
  assert.notEqual(r.nodes.a.state, 'done');
});

// ------------------------------------------------------------------ R15 lock fails closed

test('R15 a live lock holder with an unknown start time is lock_held and never broken', async (t) => {
  const fx = fixture(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  writeFileSync(fx.lockFile(), JSON.stringify({ pid: 424242, process_start_time: 'T0', host: hostname(), run_id: 'run-1', nonce: 'held' }));
  const info = (pid) => (pid === 424242 ? { alive: true, startTime: null } : { alive: true, startTime: 'me' });
  await assert.rejects(async () => acquireLock(fx.ctx({ pid: 5001, processInfo: info })), { code: 'lock_held' });
  assert.equal(JSON.parse(readFileSync(fx.lockFile(), 'utf8')).nonce, 'held');
});

// ------------------------------------------------------------------ R16 exclusions pinned at init

test('R16 init refuses candidateExclusions other than the exact pinned pair', async (t) => {
  for (const list of [['.specs/plans/T-1.md'], ['.specs/plans/T-1.md', 'session-log.md', 'docs'], ['.specs/plans', 'session-log.md'],
    ['.specs/plans/T-2.md', 'session-log.md']]) {
    const fx = fixture(t, { config: { candidateExclusions: list } });
    const r = fx.cli('init', { dag: fx.dagFile });
    assert.equal(r.status, 1, JSON.stringify(list) + r.stdout);
    assert.match(r.stderr, /dag_invalid/);
    assert.equal(existsSync(fx.stateFile()), false);
  }
  const reordered = fixture(t, { config: { candidateExclusions: ['session-log.md', '.specs/plans/T-1.md'] } });
  ok(reordered.cli('init', { dag: reordered.dagFile }));
});

// ------------------------------------------------------------------ R17 CI matrix

test('R17 every ship-ticket test file runs in the CI harness matrix', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const workflow = readFileSync(join(here, '..', '..', '..', '.github', 'workflows', 'validate.yml'), 'utf8');
  const missing = readdirSync(here).filter(f => f.endsWith('.test.mjs')).filter(f => !workflow.includes(`skills/ship-ticket/scripts/${f}`));
  assert.deepEqual(missing, []);
});

// ------------------------------------------------------------------ also-fix items

test('X mark failed->pending that clears quiescence_unknown records the authorization on its MARK event', async (t) => {
  const fx = fixture(t);
  await init(fx.ctx());
  const judged = await drive(fx.ctx({ groupAlive: () => null }));
  assert.ok(codes(judged).includes('quiescence_unknown'));
  ok(fx.cli('mark', { node: 'a', transition: 'failed->pending', reason: 'owner confirmed the worker tree is gone' }));
  const ev = runStateEvents(fx.planFile).find(e => e.event === 'MARK');
  assert.deepEqual(ev.cleared_judgments, [{ code: 'quiescence_unknown', node: 'a' }]);
  assert.equal(ev.reason, 'owner confirmed the worker tree is gone');
});

test('X a timeout uses the clamped value the dispatch was validated with', async (t) => {
  // A DAG timeout below the carrier minimum is clamped to 1000 ms for both validation and the timer.
  const fx = fixture(t, { config: { timeoutMs: 1 }, behaviour: { a: { waitFor: '/nonexistent-never' } } });
  await init(fx.ctx());
  const started = Date.now();
  const r = await drive(fx.ctx());
  assert.equal(r.nodes.a.state, 'failed');
  assert.ok(Date.now() - started >= 1000, 'the timer fired at the clamped 1000 ms, not at 1 ms');
  await delay(0);
});
