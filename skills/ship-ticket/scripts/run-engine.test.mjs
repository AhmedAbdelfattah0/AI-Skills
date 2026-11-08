/**
 * RED specs for the durable run engine (AIS-HARNESS-2, plan P0-1, acceptance criteria 1-5).
 *
 * ============================== ENGINE API CONTRACT ==============================
 * The `engine` node implements exactly this. Everything here is what the tests use;
 * the engine may add fields to returned objects and to the state, never rename them.
 *
 * Sync exports
 *   planNarrativeDigest(text) -> 'sha256:<64 hex>' (the skill's canonical form; 'sha256-' is accepted and normalized)
 *     sha256 of `text` with everything strictly between the RUN-STATE markers removed
 *     (markers kept): text.slice(0, indexOf(BEGIN) + BEGIN.length) + text.slice(indexOf(END)).
 *   validateEngineDag(doc) -> normalized DAG ({ schema, config, nodes: [...] }).
 *     Throws { code: 'dag_invalid' } on a wrong schema or ANY unknown field in `config`
 *     or in a node. Config fields: provider, modelMap, permissionMode, billing, width,
 *     memoryBudgetMb, timeoutMs, budget, candidateExclusions, testCommands, base.
 *     Node fields: id, deps, reads, writes, othersOwned, resources, risk, complexity,
 *     modelTier, estimatedMemoryMb, promptFile, phase, role, evidence, redSpecs.
 *
 * Async exports (return promises; tests always await). Every one takes a context `ctx`:
 *   { repoRoot,            absolute path of the git work tree (workers run with cwd = repoRoot)
 *     ticket, runId,       plan file is <repoRoot>/.specs/plans/<ticket>.md
 *     dagFile,             absolute path of the ship-ticket-engine-dag-v1 JSON (init/drive)
 *     env?,                child environment (default process.env); PATH resolves the provider CLI
 *     verifySubscription?, (provider, env) => true|false|'unverified' (carrier semantics)
 *     handleSignals?,      false in tests
 *     spawn?,              child_process.spawn-compatible; the ONLY way the engine starts a launcher
 *     pid?, host?,         lock identity (default process.pid, os.hostname())
 *     processInfo?,        (pid) => { alive: boolean, startTime: string|null } (default: real)
 *     groupAlive?,         (pgid) => true|false|null; null = quiescence unknown (Windows default)
 *     platform?,           default process.platform
 *     fs?,                 { renameSync? } override used for the state rename
 *     hooks? }             { boundary(name, info) } called (and awaited) at named points; a throw
 *                          there aborts the operation exactly at that point.
 *
 *   Persistence boundaries (hook called BEFORE the step; throwing means the step never ran):
 *     'temp-write', 'temp-fsync', 'rename', 'dir-fsync'          (every state commit)
 *     'run-log-append', 'run-state-append'                        (event sinks, after the commit)
 *   Launch handshake boundaries (hook called AFTER the step completed):
 *     'after-intent'  launch intent {attempt_id, node, pre_snapshot_digest} committed
 *     'after-spawn'   launcher spawned in its own process group, blocked on the release byte
 *     'after-pid'     {pid, pgid} committed, release byte NOT yet sent
 *     'after-release' release byte sent
 *   Lock boundary: 'lock-stale-observed' (a stale lock was read, before any recovery step).
 *   Every mutating command (init, drive, resume, mark) takes the lock and releases it on EVERY exit
 *   path, including a throw from a hook; a later command must not see 'lock_held' from it.
 *
 *   init(ctx) -> { state_file, run_id, plan_digest, dag_digest, binding: 'plan'|'dag_bound' }
 *     Recomputes planNarrativeDigest(plan) and requires it to equal approved_plan_digest of the
 *     START event with run_id = ctx.runId (else { code: 'approval_mismatch' }). DAG digest =
 *     'sha256:' + sha256(raw bytes of dagFile). It must appear in the plan narrative (binding
 *     'plan') or in exactly one DAG_BOUND RUN-STATE event of the same run
 *     {run_id, event:'DAG_BOUND', dag_digest} (binding 'dag_bound'); else { code: 'dag_unbound' }.
 *     A second DAG_BOUND in the same run (rebinding/supersede) is 'dag_unbound'. Invalid DAG ->
 *     'dag_invalid'. Refusals create no state file.
 *     State: git rev-parse --git-path ai-skills/ship-ticket/<ticket>.state.json
 *   status(ctx) -> STATUS (read-only):
 *     { schema: 'ship-ticket-engine-status-v1', ticket, run_id,
 *       nodes: { [id]: { state: 'pending'|'running'|'done'|'failed'|'cancelled'|'stale',
 *                        attempts: number, retries: number } },
 *       repairs: [{ id, state }],
 *       judgments: [{ code, node?, reason }],
 *       rounds: { prove_repair_batches: number, review_repairs: { [review_execution]: number } },
 *       confirmation: null | { review_execution, closure: [node ids, sorted] } }
 *   drive(ctx) -> STATUS & { outcome: 'done'|'judgment'|'waiting' }
 *     Re-verifies plan and DAG digests BEFORE any spawn (mismatch -> judgment 'approval_mismatch'
 *     / 'dag_mismatch', nothing spawned). Dispatches ready nodes (deps done) and open repairs.
 *   resume(ctx) -> STATUS   reconciles attempts, staleness, pending events (outbox replay).
 *   mark(ctx & { node, transition: 'failed->pending'|'pending->cancelled', reason }) -> STATUS
 *     Any other transition, a missing reason, or any extra key (gate, writes, othersOwned,
 *     billing, rounds, ...) -> { code: 'mark_refused' }, state untouched. 'failed->pending'
 *     increments `retries`; when retries is already 1 -> { code: 'retry_cap' }.
 *     Records event { run_id, event: 'MARK', event_id, node, transition, reason } in BOTH the
 *     engine event file (git-path ai-skills/ship-ticket/<ticket>.engine.jsonl; never the timing
 *     log <ticket>.jsonl, which run-log.mjs owns) and the plan's RUN-STATE block, after the state
 *     commit, idempotently by event_id.
 *   acquireLock(ctx) -> { lockFile, release() }
 *     Lock: git-path ai-skills/ship-ticket/<ticket>.lock, created O_EXCL with
 *     { pid, process_start_time, host, run_id, nonce }. Held by a live process with the same
 *     start time -> { code: 'lock_held' } (every mutating command too). Same host and dead PID,
 *     or alive PID with another start time -> recovered. Foreign host -> 'lock_foreign_host',
 *     unparseable -> 'lock_malformed', both with a recovery instruction in the message.
 *     Recovery takes <lockFile>.recovery with O_EXCL; marker present -> 'lock_held'.
 *   writeStateAtomic(file, state, { hooks?, fs?, platform? }) -> void
 *     temp write, fsync, rename, dir fsync. On win32 a rename EPERM/EBUSY is retried, bounded
 *     (<= 10 attempts); elsewhere it is thrown at once.
 *
 * Judgment codes (STATUS.judgments[].code): approval_mismatch, dag_mismatch, crash_with_writes,
 *   quiescence_unknown, post_freeze_drift, repair_outside_findings, repair_unauthorized,
 *   round_limit; review-2 additions are listed in run-engine-repair.test.mjs.
 *
 * State fields written by `gate` (engine reads them; only the labelled defensive test seeds them):
 *   freeze: null | { candidate, seq }                               REVIEW freeze
 *   review_chain: [{ review_execution, kind, outcome: 'PASS'|'FAIL', findings: [{ id, severity, paths }],
 *                    write_set }]   (the canonical gate.mjs gateReview record; no other shape)
 *   risk_labels: union of config.riskLabels (any harness RISK_EVIDENCE label, incl. 'ui') and node risk
 *   events[] also carries { seq, type: 'RESUME', outcome } | { seq, type: 'INFRA_RETRY', node } |
 *     { seq, type: 'ADMISSION_REFUSED', node } for eval.mjs.
 *   ctx.admissionProbe? is passed to harness admit() as its probe (tests only).
 *   repairs: [{ id, kind: 'review'|'prove', review_execution?, writes, promptFile, state }]
 *   rounds: { prove_repair_batches, review_repairs: { [review_execution]: n } }
 * ==================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync,
  readdirSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planNarrativeDigest, validateEngineDag, init, status, drive, resume, mark, acquireLock,
  writeStateAtomic } from './run-engine.mjs';
import { gateReview, gateShipReady } from './gate.mjs';
import { evaluateRun } from './eval.mjs';
import { buildRun } from './run-summary.mjs';
import { POSIX, BEGIN, END, narrativeDigest, delay, codes, fixture, spawnSpy, runStateEvents, runLogEvents, waitUntil,
  STAGED, STAGED_BEHAVIOUR, passReview, failReview, confirmReview, primaryReview, secondOpinion } from './engine-test-fixture.mjs';

const ENGINE_URL = new URL('./run-engine.mjs', import.meta.url).href;
/** Windows cannot prove process-group quiescence, so a finished attempt there is a judgment, never done (R2). */
const POSIX_ONLY = POSIX ? false : 'POSIX process groups: on Windows every attempt ends in quiescence_unknown';
const injected = () => Object.assign(new Error('injected fault'), { code: 'injected' });

/**
 * Timeout for `hang` fixtures. The fake CLI's first start through the sh shim costs 300-750 ms on
 * macOS; a 400 ms timeout could kill it before it logged its run (flaky runs('a') counts). The
 * engine's behaviour under test (timeout -> failed, never auto-retried) does not depend on the value.
 */
// 1500 ms (2x the worst unloaded cold start) flaked once with run-engine-repair.test.mjs running in
// parallel under the full suite; 3000 ms leaves headroom for that load.
const HANG_TIMEOUT_MS = 3000;

/** Run `drive` in a child process that SIGKILLs itself at a handshake boundary (a real engine crash). */
function crashAt(fx, boundary) {
  const script = join(fx.root, 'crash-driver.mjs');
  writeFileSync(script, `import { drive } from ${JSON.stringify(ENGINE_URL)};
const ctx = JSON.parse(process.argv[2]);
await drive({ ...ctx, verifySubscription: () => true, handleSignals: false,
  hooks: { boundary(name) { if (name === ${JSON.stringify(boundary)}) process.kill(process.pid, 'SIGKILL'); } } });
`);
  const r = spawnSync(process.execPath, [script, JSON.stringify({ repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1', dagFile: fx.dagFile })],
    { env: fx.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, 'SIGKILL', `engine must reach the '${boundary}' boundary and die there; stderr: ${r.stderr}`);
}

// ------------------------------------------------------------------ AC1 approval

test('AC1 planNarrativeDigest ignores RUN-STATE contents and binds the narrative', () => {
  const plan = `# Plan\n\nBody.\n${BEGIN}\n{"event":"START"}\n${END}\n`;
  const d = planNarrativeDigest(plan);
  assert.equal(d, narrativeDigest(plan));
  assert.match(d, /^sha256:[0-9a-f]{64}$/, 'the skill\'s canonical digest form (R13)');
  assert.equal(planNarrativeDigest(plan.replace('{"event":"START"}', '{"event":"START"}\n{"event":"MARK"}')), d);
  assert.notEqual(planNarrativeDigest(plan.replace('Body.', 'Body!')), d);
});

test('AC1 validateEngineDag rejects unknown fields in run config and in a node', (t) => {
  const fx = fixture(t);
  const dag = JSON.parse(readFileSync(fx.dagFile, 'utf8'));
  assert.equal(validateEngineDag(dag).nodes.length, 1);
  assert.throws(() => validateEngineDag({ ...dag, config: { ...dag.config, allowApiBilling: true } }), { code: 'dag_invalid' });
  assert.throws(() => validateEngineDag({ ...dag, nodes: [{ ...dag.nodes[0], sneaky: 1 }] }), { code: 'dag_invalid' });
  assert.throws(() => validateEngineDag({ ...dag, extra: {} }), { code: 'dag_invalid' });
  assert.throws(() => validateEngineDag({ ...dag, schema: 'ship-ticket-engine-dag-v0' }), { code: 'dag_invalid' });
});

test('AC1 init binds the approved narrative and a DAG digest listed in the plan', async (t) => {
  const fx = fixture(t, { nodes: STAGED });
  const r = await init(fx.ctx());
  assert.equal(r.binding, 'plan');
  assert.equal(r.dag_digest, fx.dagDigest);
  assert.equal(r.plan_digest, narrativeDigest(readFileSync(fx.planFile, 'utf8')));
  assert.equal(realpathSync(r.state_file), realpathSync(fx.stateFile()));
  const s = await status(fx.ctx());
  assert.equal(s.schema, 'ship-ticket-engine-status-v1');
  assert.deepEqual(Object.keys(s.nodes).sort(), ['a', 'b', 'c']);
  for (const n of Object.values(s.nodes)) assert.equal(n.state, 'pending');
  assert.deepEqual(s.judgments, []);
});

test('AC1 init accepts exactly one DAG_BOUND event from the same run', async (t) => {
  const fx = fixture(t, { bind: 'dag_bound' });
  assert.equal((await init(fx.ctx())).binding, 'dag_bound');
});

test('AC1 init refuses a plan narrative that no longer matches START', async (t) => {
  const fx = fixture(t);
  writeFileSync(fx.planFile, readFileSync(fx.planFile, 'utf8').replace('Approved narrative.', 'Edited after approval.'));
  await assert.rejects(async () => init(fx.ctx()), { code: 'approval_mismatch' });
  assert.equal(existsSync(fx.stateFile()), false, 'a refused init creates no state');
});

test('AC1 init refuses an unbound DAG, a DAG_BOUND from another run and a superseded DAG_BOUND', async (t) => {
  const unbound = fixture(t, { bind: 'none' });
  await assert.rejects(async () => init(unbound.ctx()), { code: 'dag_unbound' });
  const otherRun = fixture(t, { bind: 'none', extraEvents: (d) => [{ run_id: 'run-0', event: 'DAG_BOUND', dag_digest: d }] });
  await assert.rejects(async () => init(otherRun.ctx()), { code: 'dag_unbound' });
  const superseded = fixture(t, { bind: 'dag_bound', extraEvents: (d) => [{ run_id: 'run-1', event: 'DAG_BOUND', dag_digest: d }] });
  await assert.rejects(async () => init(superseded.ctx()), { code: 'dag_unbound' }, 'DAG_BOUND cannot be rewritten or superseded');
  const invalid = fixture(t, { bind: 'none' });
  const dag = JSON.parse(readFileSync(invalid.dagFile, 'utf8'));
  dag.nodes[0].unknownField = true;
  writeFileSync(invalid.dagFile, JSON.stringify(dag));
  await assert.rejects(async () => init(invalid.ctx()), { code: 'dag_invalid' });
});

test('AC1 drive re-verifies plan and DAG digests before every dispatch', async (t) => {
  const planDrift = fixture(t);
  await init(planDrift.ctx());
  writeFileSync(planDrift.planFile, readFileSync(planDrift.planFile, 'utf8').replace('Approved narrative.', 'Edited.'));
  const spy1 = spawnSpy();
  const r1 = await drive(planDrift.ctx({ spawn: spy1.fn }));
  assert.equal(r1.outcome, 'judgment');
  assert.ok(codes(r1).includes('approval_mismatch'));
  assert.equal(spy1.calls.length, 0);
  assert.deepEqual(planDrift.runs(), []);

  const dagDrift = fixture(t);
  await init(dagDrift.ctx());
  writeFileSync(dagDrift.dagFile, readFileSync(dagDrift.dagFile, 'utf8') + '\n');
  const spy2 = spawnSpy();
  const r2 = await drive(dagDrift.ctx({ spawn: spy2.fn }));
  assert.equal(r2.outcome, 'judgment');
  assert.ok(codes(r2).includes('dag_mismatch'));
  assert.equal(spy2.calls.length, 0);
  assert.deepEqual(dagDrift.runs(), []);
});

test('AC1 mark allows only pending->cancelled and failed->pending, and nothing else', async (t) => {
  const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
  await init(fx.ctx());
  const before = readFileSync(fx.stateFile(), 'utf8');
  const refused = [
    { node: 'a', transition: 'pending->done', reason: 'r' },
    { node: 'a', transition: 'pending->running', reason: 'r' },
    { node: 'a', transition: 'failed->pending', reason: 'r' }, // a is pending, not failed
    { node: 'c', transition: 'pending->cancelled' }, // no reason
    { node: 'c', transition: 'pending->cancelled', reason: 'r', gate: { red: 'accepted' } },
    { node: 'c', transition: 'pending->cancelled', reason: 'r', writes: ['src'] },
    { node: 'c', transition: 'pending->cancelled', reason: 'r', othersOwned: ['docs'] },
    { node: 'c', transition: 'pending->cancelled', reason: 'r', billing: 'api' },
    { node: 'c', transition: 'pending->cancelled', reason: 'r', rounds: { prove_repair_batches: 0 } },
    { node: 'zz', transition: 'pending->cancelled', reason: 'r' },
  ];
  for (const m of refused) await assert.rejects(async () => mark(fx.ctx(m)), { code: 'mark_refused' }, JSON.stringify(m));
  assert.equal(readFileSync(fx.stateFile(), 'utf8'), before, 'refused marks leave state untouched');
  const s = await mark(fx.ctx({ node: 'c', transition: 'pending->cancelled', reason: 'out of scope' }));
  assert.equal(s.nodes.c.state, 'cancelled');
  await assert.rejects(async () => mark(fx.ctx({ node: 'c', transition: 'cancelled->pending', reason: 'r' })), { code: 'mark_refused' });
});

test('AC1 failed->pending counts as an attempt and is capped at one retry', async (t) => {
  const fx = fixture(t, { config: { timeoutMs: HANG_TIMEOUT_MS }, behaviour: { a: { hang: true } } });
  await init(fx.ctx());
  const first = await drive(fx.ctx());
  assert.equal(first.nodes.a.state, 'failed');
  assert.equal(first.nodes.a.retries, 0);
  const marked = await mark(fx.ctx({ node: 'a', transition: 'failed->pending', reason: 'retry after fix' }));
  assert.equal(marked.nodes.a.state, 'pending');
  assert.equal(marked.nodes.a.retries, 1);
  const second = await drive(fx.ctx());
  assert.equal(second.nodes.a.state, 'failed');
  assert.equal(fx.runs('a').length, 2);
  await assert.rejects(async () => mark(fx.ctx({ node: 'a', transition: 'failed->pending', reason: 'again' })), { code: 'retry_cap' });
});

// ------------------------------------------------------------------ AC2 lock

test('AC2 a second mutator is refused while the lock is held', async (t) => {
  const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
  await init(fx.ctx());
  const lock = await acquireLock(fx.ctx());
  assert.equal(realpathSync(lock.lockFile), realpathSync(fx.lockFile()));
  const held = JSON.parse(readFileSync(fx.lockFile(), 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.equal(held.host, hostname());
  assert.equal(held.run_id, 'run-1');
  assert.equal(typeof held.nonce, 'string');
  assert.ok('process_start_time' in held);
  await assert.rejects(async () => acquireLock(fx.ctx()), { code: 'lock_held' });
  await assert.rejects(async () => mark(fx.ctx({ node: 'c', transition: 'pending->cancelled', reason: 'r' })), { code: 'lock_held' });
  await assert.rejects(async () => drive(fx.ctx()), { code: 'lock_held' });
  await lock.release();
  assert.equal(existsSync(fx.lockFile()), false);
  const again = await acquireLock(fx.ctx());
  await again.release();
});

test('AC2 a dead or reused PID on the same host is recovered; a live holder is not', async (t) => {
  const fx = fixture(t);
  const writeLock = (extra = {}) => {
    mkdirSync(dirname(fx.lockFile()), { recursive: true });
    writeFileSync(fx.lockFile(), JSON.stringify({ pid: 424242, process_start_time: 'T0', host: hostname(), run_id: 'run-1', nonce: 'old', ...extra }));
  };
  const me = { pid: 5001 };
  const info = (other) => (pid) => (pid === 5001 ? { alive: true, startTime: 'me' } : other);

  writeLock();
  const dead = await acquireLock(fx.ctx({ ...me, processInfo: info({ alive: false, startTime: null }) }));
  assert.equal(JSON.parse(readFileSync(fx.lockFile(), 'utf8')).pid, 5001, 'dead PID recovered');
  await dead.release();

  writeLock();
  const reused = await acquireLock(fx.ctx({ ...me, processInfo: info({ alive: true, startTime: 'T1' }) }));
  assert.equal(JSON.parse(readFileSync(fx.lockFile(), 'utf8')).pid, 5001, 'PID reuse (different start time) recovered');
  await reused.release();

  writeLock();
  await assert.rejects(async () => acquireLock(fx.ctx({ ...me, processInfo: info({ alive: true, startTime: 'T0' }) })), { code: 'lock_held' });
  assert.equal(JSON.parse(readFileSync(fx.lockFile(), 'utf8')).nonce, 'old', 'a live lock is never broken');
});

test('AC2 a foreign-host or malformed lock is refused with a recovery instruction', async (t) => {
  const fx = fixture(t);
  mkdirSync(dirname(fx.lockFile()), { recursive: true });
  const foreign = JSON.stringify({ pid: 424242, process_start_time: 'T0', host: 'some-other-host', run_id: 'run-1', nonce: 'x' });
  writeFileSync(fx.lockFile(), foreign);
  const dead = () => ({ alive: false, startTime: null });
  await assert.rejects(async () => acquireLock(fx.ctx({ processInfo: dead })),
    (e) => e.code === 'lock_foreign_host' && /recover|remove|delete/i.test(e.message));
  assert.equal(readFileSync(fx.lockFile(), 'utf8'), foreign);
  writeFileSync(fx.lockFile(), '{not json');
  await assert.rejects(async () => acquireLock(fx.ctx({ processInfo: dead })),
    (e) => e.code === 'lock_malformed' && /recover|remove|delete/i.test(e.message));
  assert.equal(readFileSync(fx.lockFile(), 'utf8'), '{not json');
});

test('AC2 concurrent recovery of a stale lock has exactly one winner', async (t) => {
  const fx = fixture(t);
  mkdirSync(dirname(fx.lockFile()), { recursive: true });
  writeFileSync(fx.lockFile(), JSON.stringify({ pid: 424242, process_start_time: 'T0', host: hostname(), run_id: 'run-1', nonce: 'stale' }));
  const info = (pid) => (pid === 424242 ? { alive: false, startTime: null } : { alive: true, startTime: 'start-' + pid });
  const outcomes = [];
  let interleaved = false;
  const second = async () => {
    try { outcomes.push(['second', await acquireLock(fx.ctx({ pid: 5002, processInfo: info }))]); }
    catch (e) { outcomes.push(['second', e]); }
  };
  try {
    // The first recoverer is paused right after it observed the stale lock; the second runs to completion.
    outcomes.push(['first', await acquireLock(fx.ctx({ pid: 5001, processInfo: info,
      hooks: { boundary: async (name) => { if (name === 'lock-stale-observed' && !interleaved) { interleaved = true; await second(); } } } }))]);
  } catch (e) { outcomes.push(['first', e]); }
  assert.equal(interleaved, true, 'the engine exposes the lock-stale-observed boundary');
  const winners = outcomes.filter(([, r]) => !(r instanceof Error));
  const losers = outcomes.filter(([, r]) => r instanceof Error);
  assert.equal(winners.length, 1, 'exactly one recoverer wins');
  assert.equal(losers[0][1].code, 'lock_held');
  assert.equal(JSON.parse(readFileSync(fx.lockFile(), 'utf8')).pid, winners[0][0] === 'first' ? 5001 : 5002);

  // A recovery marker held by another recoverer also refuses.
  await winners[0][1].release();
  writeFileSync(fx.lockFile(), JSON.stringify({ pid: 424242, process_start_time: 'T0', host: hostname(), run_id: 'run-1', nonce: 'stale' }));
  writeFileSync(fx.lockFile() + '.recovery', JSON.stringify({ pid: 5003 }));
  await assert.rejects(async () => acquireLock(fx.ctx({ pid: 5001, processInfo: info })), { code: 'lock_held' });
});

// ------------------------------------------------------------------ AC3 persistence

test('AC3 writeStateAtomic leaves the old or the new complete state at every boundary', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'run-engine-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'T-1.state.json');
  const seen = [];
  await writeStateAtomic(file, { v: 1 }, { hooks: { boundary: (n) => { seen.push(n); } } });
  assert.deepEqual(seen, ['temp-write', 'temp-fsync', 'rename', 'dir-fsync']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1 });
  assert.deepEqual(readdirSync(dir), ['T-1.state.json'], 'no temp file left behind');
  const expected = { 'temp-write': 1, 'temp-fsync': 1, rename: 1, 'dir-fsync': 2 };
  for (const [boundary, v] of Object.entries(expected)) {
    writeFileSync(file, JSON.stringify({ v: 1 }));
    await assert.rejects(async () => writeStateAtomic(file, { v: 2 }, { hooks: { boundary: (n) => { if (n === boundary) throw injected(); } } }),
      { code: 'injected' }, boundary);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v }, `fault at ${boundary}`);
  }
});

test('AC3 Windows rename retries EPERM/EBUSY a bounded number of times', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'run-engine-rename-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 's.json');
  const flaky = (codesToThrow) => {
    const calls = { n: 0 };
    return { calls, renameSync: (a, b) => { calls.n++; const c = codesToThrow[calls.n - 1]; if (c) throw Object.assign(new Error(c), { code: c }); renameSync(a, b); } };
  };
  const ok = flaky(['EPERM', 'EBUSY']);
  await writeStateAtomic(file, { v: 1 }, { platform: 'win32', fs: ok });
  assert.equal(ok.calls.n, 3);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1 });

  const stuck = flaky(Array(100).fill('EPERM'));
  await assert.rejects(async () => writeStateAtomic(file, { v: 2 }, { platform: 'win32', fs: stuck }), { code: 'EPERM' });
  assert.ok(stuck.calls.n > 1 && stuck.calls.n <= 10, `bounded retries, got ${stuck.calls.n}`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1 });

  const posix = flaky(['EPERM']);
  await assert.rejects(async () => writeStateAtomic(file, { v: 3 }, { platform: 'linux', fs: posix }), { code: 'EPERM' });
  assert.equal(posix.calls.n, 1, 'no retry outside Windows');
});

test('AC3 a crash at each commit/event boundary is reconciled by resume without duplicate events', async (t) => {
  for (const boundary of ['temp-write', 'rename', 'dir-fsync', 'run-log-append', 'run-state-append']) {
    const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
    await init(fx.ctx());
    const planDigest = narrativeDigest(readFileSync(fx.planFile, 'utf8'));
    await assert.rejects(async () => mark(fx.ctx({ node: 'c', transition: 'pending->cancelled', reason: 'scope',
      hooks: { boundary: (n) => { if (n === boundary) throw injected(); } } })), { code: 'injected' }, boundary);
    await resume(fx.ctx());
    const s = await resume(fx.ctx()); // a replayed resume is a no-op
    const committed = !['temp-write', 'rename'].includes(boundary);
    assert.equal(s.nodes.c.state, committed ? 'cancelled' : 'pending', boundary);
    const logMarks = runLogEvents(fx.engineLog()).filter(e => e.event === 'MARK');
    const stateMarks = runStateEvents(fx.planFile).filter(e => e.event === 'MARK');
    assert.equal(logMarks.length, committed ? 1 : 0, `run-log MARK events after a fault at ${boundary}`);
    assert.equal(stateMarks.length, committed ? 1 : 0, `RUN-STATE MARK events after a fault at ${boundary}`);
    if (committed) {
      assert.equal(logMarks[0].event_id, stateMarks[0].event_id);
      assert.equal(stateMarks[0].run_id, 'run-1');
    }
    assert.equal(narrativeDigest(readFileSync(fx.planFile, 'utf8')), planDigest, 'RUN-STATE appends never touch the narrative');
  }
});

// ------------------------------------------------------------------ AC4 attempts and crashes

test('AC4 drive dispatches ready nodes in dependency order and records each attempt', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
  await init(fx.ctx());
  const r = await drive(fx.ctx());
  assert.equal(r.outcome, 'done');
  for (const id of ['a', 'b', 'c']) { assert.equal(r.nodes[id].state, 'done', id); assert.equal(r.nodes[id].attempts, 1, id); }
  const order = fx.runs();
  assert.ok(order.indexOf('a') < order.indexOf('b'), 'b waits for a');
  assert.equal(readFileSync(join(fx.repo, 'src', 'b.txt'), 'utf8'), 'b1');
});

test('AC4 an engine crash before release never runs the worker; resume re-queues it', { skip: POSIX_ONLY }, async (t) => {
  for (const boundary of ['after-intent', 'after-spawn', 'after-pid']) {
    const fx = fixture(t);
    await init(fx.ctx());
    crashAt(fx, boundary);
    await delay(300);
    assert.deepEqual(fx.runs(), [], `no worker may run without the release byte (${boundary})`);
    const s = await resume(fx.ctx());
    assert.equal(s.nodes.a.state, 'pending', `dead, no envelope, no writes -> re-queued (${boundary})`);
    assert.deepEqual(codes(s), []);
    const done = await drive(fx.ctx());
    assert.equal(done.nodes.a.state, 'done');
    assert.equal(fx.runs('a').length, 1, boundary);
  }
});

test('AC4 a live worker after an engine crash is never duplicated; its envelope is recorded', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t);
  const finishFlag = join(fx.root, 'finish');
  fx.behave({ a: { write: { 'src/a.txt': 'a1' }, waitFor: finishFlag } });
  await init(fx.ctx());
  crashAt(fx, 'after-release');
  assert.ok(await waitUntil(() => fx.runs('a').length === 1), 'released worker started');
  const spy = spawnSpy();
  const live = await resume(fx.ctx({ spawn: spy.fn }));
  assert.equal(live.nodes.a.state, 'running', 'a live process group stays running');
  setTimeout(() => writeFileSync(finishFlag, ''), 300);
  await drive(fx.ctx({ spawn: spy.fn }));
  let last;
  assert.ok(await waitUntil(async () => (last = await resume(fx.ctx({ spawn: spy.fn }))).nodes.a.state !== 'running'));
  assert.equal(last.nodes.a.state, 'done', 'envelope recorded');
  assert.equal(spy.calls.length, 0, 'no duplicate writer was spawned');
  assert.equal(fx.runs('a').length, 1);
});

test('AC4 a dead worker with an envelope is recorded, not re-run', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t);
  await init(fx.ctx());
  crashAt(fx, 'after-release');
  assert.ok(await waitUntil(() => fx.runs('a').length === 1));
  let s;
  assert.ok(await waitUntil(async () => (s = await resume(fx.ctx())).nodes.a.state !== 'running'), 'worker and launcher finish and write the envelope');
  assert.equal(s.nodes.a.state, 'done');
  assert.equal(s.nodes.a.attempts, 1);
  assert.equal(fx.runs('a').length, 1);
});

test('AC4 a dead worker that wrote files without an envelope is a judgment point', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t, { behaviour: { a: { write: { 'src/a.txt': 'partial' }, killGroup: true } } });
  await init(fx.ctx());
  const r = await drive(fx.ctx());
  assert.equal(r.outcome, 'judgment');
  assert.ok(r.judgments.some(j => j.code === 'crash_with_writes' && j.node === 'a'));
  const spy = spawnSpy();
  const again = await drive(fx.ctx({ spawn: spy.fn }));
  assert.ok(codes(again).includes('crash_with_writes'));
  assert.equal(spy.calls.length, 0);
  assert.equal(fx.runs('a').length, 1, 'never retried automatically');
});

test('AC4 unknown process-group quiescence (Windows) is a judgment point', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t);
  await init(fx.ctx());
  crashAt(fx, 'after-pid');
  const s = await resume(fx.ctx({ groupAlive: () => null }));
  assert.ok(s.judgments.some(j => j.code === 'quiescence_unknown' && j.node === 'a'));
  assert.notEqual(s.nodes.a.state, 'pending', 'never re-queued without proven quiescence');
});

test('AC4 a timeout alone never triggers an automatic retry', async (t) => {
  const fx = fixture(t, { config: { timeoutMs: HANG_TIMEOUT_MS }, behaviour: { a: { hang: true } } });
  await init(fx.ctx());
  const r = await drive(fx.ctx());
  assert.equal(r.nodes.a.state, 'failed');
  assert.equal(r.nodes.a.retries, 0);
  assert.equal(fx.runs('a').length, 1);
});

test('AC4 a provider error with proven quiescence and no writes retries once, then fails', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t, { behaviour: { a: { exit: 1 } } });
  await init(fx.ctx());
  const r = await drive(fx.ctx());
  assert.equal(r.nodes.a.state, 'failed');
  assert.equal(r.nodes.a.retries, 1);
  assert.equal(r.nodes.a.attempts, 2);
  assert.equal(fx.runs('a').length, 2, 'retry cap is 1 per node');
});

// ------------------------------------------------------------------ AC5 staleness

async function stagedDone(t) {
  const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
  await init(fx.ctx());
  const r = await drive(fx.ctx());
  assert.equal(r.outcome, 'done');
  return fx;
}
const states = (s) => Object.fromEntries(Object.entries(s.nodes).map(([k, v]) => [k, v.state]));

test('AC5 a changed read input invalidates the node and its dependency closure, then re-runs it', { skip: POSIX_ONLY }, async (t) => {
  const fx = await stagedDone(t);
  writeFileSync(join(fx.repo, 'docs', 'in.txt'), 'input v2');
  assert.deepEqual(states(await resume(fx.ctx())), { a: 'stale', b: 'stale', c: 'done' });
  const r = await drive(fx.ctx());
  assert.deepEqual(states(r), { a: 'done', b: 'done', c: 'done' });
  assert.deepEqual([fx.runs('a').length, fx.runs('b').length, fx.runs('c').length], [2, 2, 1]);
});

test('AC5 a timestamp-only change is not staleness', { skip: POSIX_ONLY }, async (t) => {
  const fx = await stagedDone(t);
  const future = new Date(Date.now() + 3600_000);
  utimesSync(join(fx.repo, 'docs', 'in.txt'), future, future);
  utimesSync(join(fx.repo, 'src', 'a.txt'), future, future);
  assert.deepEqual(states(await resume(fx.ctx())), { a: 'done', b: 'done', c: 'done' });
  const spy = spawnSpy();
  await drive(fx.ctx({ spawn: spy.fn }));
  assert.equal(spy.calls.length, 0);
});

test('AC5 a deleted or changed output invalidates its dependency closure', { skip: POSIX_ONLY }, async (t) => {
  const fx = await stagedDone(t);
  rmSync(join(fx.repo, 'src', 'b.txt'));
  assert.deepEqual(states(await resume(fx.ctx())), { a: 'done', b: 'stale', c: 'done' });
  await drive(fx.ctx());
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'hand edit');
  assert.deepEqual(states(await resume(fx.ctx())), { a: 'stale', b: 'stale', c: 'done' });
});

/** STAGED run on a committed repo (candidate ids computable), driven to done through the CLI. */
function stagedCommitted(t, behaviour = {}) {
  const fx = fixture(t, { nodes: STAGED, commit: true, behaviour: { ...STAGED_BEHAVIOUR, ...behaviour } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const r = fx.cli('drive');
  assert.equal(r.out?.outcome, 'done', r.stdout + r.stderr);
  return fx;
}

test('AC5 drift after the REVIEW freeze is a judgment point, not an automatic re-run', { skip: POSIX_ONLY }, async (t) => {
  const fx = stagedCommitted(t);
  assert.equal(fx.gate('review', passReview('review-1', fx.candidate())).status, 0, 'the accepted review freezes the candidate');
  writeFileSync(join(fx.repo, 'docs', 'in.txt'), 'input v2');
  const s = await resume(fx.ctx());
  assert.ok(codes(s).includes('post_freeze_drift'));
  const spy = spawnSpy();
  const r = await drive(fx.ctx({ spawn: spy.fn }));
  assert.equal(r.outcome, 'judgment');
  assert.equal(spy.calls.length, 0);
  assert.equal(fx.runs('a').length, 1);
});

test('AC5 an authorized REPAIR writes its finding-bound set from engine state alone; confirmation covers the closure', { skip: POSIX_ONLY }, async (t) => {
  const fx = stagedCommitted(t, { fix: { write: { 'src/a.txt': 'fixed' } } });
  assert.equal(fx.gate('review', failReview('review-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))).status, 0);
  rmSync(fx.runLog(), { force: true }); // authorization must not depend on the timing log
  const r = fx.cli('drive').out;
  assert.deepEqual(codes(r), []);
  assert.equal(r.repairs.find(x => x.id === 'repair-review-1')?.state, 'done');
  assert.equal(fx.runs('fix').length, 1);
  assert.equal(readFileSync(join(fx.repo, 'src', 'a.txt'), 'utf8'), 'fixed');
  assert.deepEqual(r.confirmation, { review_execution: 'review-1', closure: ['a', 'b'] });
  assert.equal(r.rounds.review_repairs['review-1'], 1);
});

test('AC5 a REPAIR writing outside its finding-bound set is a violation', { skip: POSIX_ONLY }, async (t) => {
  const fx = stagedCommitted(t, { fix: { write: { 'src/a.txt': 'fixed', 'src/c.txt': 'collateral' } } });
  assert.equal(fx.gate('review', failReview('review-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))).status, 0);
  const r = fx.cli('drive').out;
  assert.ok(r.judgments.some(j => j.code === 'repair_outside_findings'), JSON.stringify(r.judgments));
  assert.equal(r.repairs.find(x => x.id === 'repair-review-1')?.state, 'failed');
});

test('a PASS review opens no REPAIR, even when the run log has a REVIEW start', { skip: POSIX_ONLY }, async (t) => {
  const fx = stagedCommitted(t);
  assert.equal(fx.gate('review', passReview('review-1', fx.candidate())).status, 0);
  mkdirSync(dirname(fx.runLog()), { recursive: true });
  writeFileSync(fx.runLog(), JSON.stringify({ event: 'start', kind: 'phase', name: 'REVIEW', run_id: 'run-1',
    metrics: { review_execution: 'review-1' } }) + '\n');
  const spy = spawnSpy();
  const r = await drive(fx.ctx({ spawn: spy.fn }));
  assert.deepEqual(r.repairs, []);
  assert.equal(spy.calls.length, 0);
});

/**
 * Defensive checks of the engine's REPAIR authorization on records the CLI can no longer produce
 * (a legacy verdict-shaped record, a spent review round, a third PROVE batch). They seed state on
 * purpose: the supported path (gate review -> repair) is covered end to end by R9 in
 * run-engine-repair.test.mjs, and these prove `authorize` still fails closed on anything else.
 */
test('defensive: a legacy record, a spent REVIEW repair and a third PROVE batch are refused before any spawn', async (t) => {
  const seeded = async (chain, rounds, repairs) => {
    const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
    await init(fx.ctx());
    for (const node of ['a', 'b', 'c']) await mark(fx.ctx({ node, transition: 'pending->cancelled', reason: 'repair-only run' }));
    const promptFile = fx.prompt('repair-1');
    fx.editState(s => { s.review_chain = chain; s.rounds = rounds; s.repairs = repairs(promptFile); });
    const spy = spawnSpy();
    const r = await drive(fx.ctx({ spawn: spy.fn }));
    return { r, spy };
  };
  const review = (pf) => [{ id: 'repair-1', kind: 'review', review_execution: 'review-1', writes: ['src/a.txt'], promptFile: pf, state: 'pending' }];
  const legacy = await seeded([{ review_execution: 'review-1', verdict: 'FAIL', findings: [{ id: 'F1', path: 'src/a.txt' }] }],
    { prove_repair_batches: 0, review_repairs: {} }, review);
  assert.ok(codes(legacy.r).includes('repair_unauthorized'), JSON.stringify(legacy.r.judgments));
  const canonical = [{ review_execution: 'review-1', kind: 'original', outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', paths: ['src/a.txt'] }], write_set: ['src/a.txt'] }];
  const spent = await seeded(canonical, { prove_repair_batches: 0, review_repairs: { 'review-1': 1 } }, review);
  assert.ok(codes(spent.r).includes('round_limit'));
  assert.equal(spent.r.rounds.review_repairs['review-1'], 1, 'counters are never reset');
  const prove = await seeded([], { prove_repair_batches: 2, review_repairs: {} },
    (pf) => [{ id: 'repair-1', kind: 'prove', writes: ['src/a.txt'], promptFile: pf, state: 'pending' }]);
  assert.ok(codes(prove.r).includes('round_limit'));
  assert.equal(prove.r.rounds.prove_repair_batches, 2);
  for (const x of [legacy, spent, prove]) assert.equal(x.spy.calls.length, 0, 'nothing launched');
});

// ------------------------------------------------------------------ integration seams (PROVE repair batch 1)

const RUN_LOG = new URL('./run-log.mjs', import.meta.url);
const runLogCli = (fx, verb, extra = []) => spawnSync(process.execPath, [fileURLToPath(RUN_LOG), verb, '--repo', fx.repo,
  '--ticket', 'T-1', '--run-id', 'run-1', '--kind', 'phase', '--name', 'BUILD', '--event-id', 'build-1', ...extra], { encoding: 'utf8' });

test('seam: engine events go to <ticket>.engine.jsonl; run-log.mjs start/end still work after a mark', async (t) => {
  const fx = fixture(t, { nodes: STAGED, behaviour: STAGED_BEHAVIOUR });
  await init(fx.ctx());
  await mark(fx.ctx({ node: 'c', transition: 'pending->cancelled', reason: 'scope' }));
  assert.equal(runLogEvents(fx.engineLog()).filter(e => e.event === 'MARK').length, 1, 'MARK is in the engine event file');
  assert.equal(runLogEvents(fx.runLog()).length, 0, 'the timing log holds no engine rows');
  const started = runLogCli(fx, 'start');
  assert.equal(started.status, 0, started.stderr);
  const ended = runLogCli(fx, 'end', ['--outcome', 'pass']);
  assert.equal(ended.status, 0, ended.stderr);
  assert.deepEqual(runLogEvents(fx.runLog()).map(r => r.event), ['start', 'end']);
});

test('seam: config.riskLabels (incl. ui) is validated, stored and enforced by ship-ready; node risk stays routing-only', async (t) => {
  const base = { schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }, nodes: [{ id: 'a', promptFile: 'p.txt' }] };
  assert.deepEqual(validateEngineDag({ ...base, config: { ...base.config, riskLabels: ['ui'] } }).config.riskLabels, ['ui']);
  assert.throws(() => validateEngineDag({ ...base, config: { ...base.config, riskLabels: ['bogus'] } }), { code: 'dag_invalid' });
  assert.throws(() => validateEngineDag({ ...base, config: { ...base.config, riskLabels: 'ui' } }), { code: 'dag_invalid' });
  assert.throws(() => validateEngineDag({ ...base, nodes: [{ id: 'a', promptFile: 'p.txt', risk: ['ui'] }] }), { code: 'dag_invalid' });

  const fx = fixture(t, { config: { riskLabels: ['ui'] }, nodes: [{ id: 'a', writes: ['src/a.txt'], risk: ['concurrency'] }] });
  await init(fx.ctx());
  const state = fx.readState();
  assert.deepEqual([...state.risk_labels].sort(), ['concurrency', 'ui']);
  const verdict = gateShipReady({ state, current: {} });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.missing.includes('parity-measurements'), JSON.stringify(verdict.missing));
  assert.ok(verdict.missing.includes('interleaving-spec'));
});

test('seam: an engine fixture run feeds eval: resumes, infra retries, admission refusals and severities are not unknown', { skip: POSIX_ONLY }, async (t) => {
  const fx = fixture(t, { nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', writes: ['src/b.txt'] }],
    behaviour: { a: { exit: 1 }, b: { write: { 'src/b.txt': 'b1' } } } });
  await init(fx.ctx());
  // One CPU: two concurrent members are refused admission, so b waits for a.
  const probe = { cpus: () => [{}], freemem: () => 64 * 1024 ** 3, totalmem: () => 64 * 1024 ** 3, platform: 'darwin' };
  const r = await drive(fx.ctx({ admissionProbe: probe }));
  assert.equal(r.nodes.a.retries, 1, 'provider error with proven quiescence retried once');
  assert.equal(r.nodes.b.state, 'done');
  await resume(fx.ctx());
  const state = fx.readState();
  const types = state.events.map(e => e.type);
  assert.ok(types.includes('INFRA_RETRY'), JSON.stringify(types));
  assert.ok(types.includes('ADMISSION_REFUSED'), JSON.stringify(types));
  const resumed = state.events.filter(e => e.type === 'RESUME');
  assert.equal(resumed.length, 1);
  assert.equal(typeof resumed[0].outcome, 'string');
  assert.ok(state.events.every(e => Number.isInteger(e.seq)), 'every engine event is sequenced');

  const review = gateReview({ state: { frozen_candidate: 'cand-1', builders: [], review_chain: [] }, review_execution: 'review-1', kind: 'original',
    primary: primaryReview('cand-1', { reviewed_paths: ['src/b.txt'], findings: [{ id: 'F1', severity: 'minor', path: 'src/b.txt' }] }),
    second_opinion: secondOpinion('cand-1'),
    reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'defer — follow-up ticket' }] } });
  assert.equal(review.ok, true, JSON.stringify(review.reasons));
  state.review_chain.push(review.record);

  for (const [verb, extra] of [['start', []], ['end', ['--outcome', 'pass']]]) assert.equal(runLogCli(fx, verb, extra).status, 0);
  const m = evaluateRun(buildRun('T-1', 'run-1', runLogEvents(fx.runLog())), { state });
  assert.equal(m.infra_retries, 1);
  assert.ok(m.admission_refusals >= 1, JSON.stringify(m.admission_refusals));
  assert.equal(m.resumes.attempts, 1);
  assert.notDeepEqual(Object.keys(m.resumes.outcomes), ['unknown']);
  assert.deepEqual(m.findings_by_severity, { minor: 1 });
});

// ------------------------------------------------------------------ gate CLI (PROVE repair batch 2)
//
// run-engine.mjs gate <red|review|ship-ready> --repo <dir> --ticket <key> --run-id <id> --input <json-file>
//   Takes the engine lock, calls the matching gate.mjs decision with the engine state, commits the
//   returned state, appends a GATE engine event (idempotent event_id) and prints
//   { gate, ok, code, judgment_point, reasons, ... }. Exit 0 accepted, 2 refused/judgment point
//   (incl. lock_held), 1 usage error (unknown flag, unreadable input, unknown input field).
//   The candidate id is always computed by the engine (candidate-id.mjs, config.base, the PINNED
//   exclusions); RED specs come from the DAG node; input never carries state.

const gateFixture = (t, opts = {}) => {
  const fx = fixture(t, { ...opts, commit: true });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  return fx;
};

test('gate CLI: red runs the DAG-bound command and persists accepted RED; a passing spec is refused', async (t) => {
  const fx = gateFixture(t, { config: { testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'red.test.mjs'], format: 'tap' } } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: [{ file: 'red.test.mjs', name: 'fails on assertion' }] },
      { id: 'g', writes: ['src/g.txt'], redSpecs: [{ file: 'red.test.mjs', name: 'already passes' }] }] });
  writeFileSync(join(fx.repo, 'red.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`
    + `test('fails on assertion', () => { assert.equal(1, 2); });\ntest('already passes', () => {});\n`);
  const cand = fx.candidate();
  const ok = fx.gate('red', { node: 'r', command: 'unit' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.out?.ok, true);
  assert.equal(ok.out?.code, 'red_accepted');
  const s = fx.readState();
  assert.equal(s.gates.red.r?.baseline_candidate, cand, 'RED is bound to the candidate the engine computed');
  assert.ok(s.events.some(e => e.type === 'RED_ACCEPTED' && e.node === 'r'));
  assert.ok(runLogEvents(fx.engineLog()).some(e => e.event === 'GATE' && e.gate === 'red' && e.code === 'red_accepted'));

  const refused = fx.gate('red', { node: 'g', command: 'unit' });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.equal(refused.out?.code, 'spec_not_failing');
  assert.equal(fx.readState().gates.red.g, undefined);
  assert.equal(fx.gate('red', { node: 'r', command: 'unit', specs: [{ file: 'x', name: 'y' }], extra: 1 }).status, 1, 'unknown input fields are usage errors');
});

test('gate CLI: review records an accepted review against the computed candidate; a stale candidate is refused', async (t) => {
  const fx = gateFixture(t);
  const cand = fx.candidate();
  const ok = fx.gate('review', passReview('review-1', cand));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.out?.code, 'review_accepted');
  const s = fx.readState();
  assert.equal(s.review_chain.length, 1);
  assert.equal(s.review_chain[0].candidate_id, cand);
  assert.equal(s.freeze?.candidate, cand);

  const fresh = gateFixture(t);
  const stale = fresh.gate('review', passReview('review-1', 'f'.repeat(64)));
  assert.equal(stale.status, 2, stale.stdout + stale.stderr);
  assert.equal(stale.out?.code, 'stale_candidate');
  assert.equal(fresh.readState().review_chain.length, 0, 'a refused review is not recorded');
  assert.equal(fresh.gate('review', { ...passReview('review-3', cand), state: { frozen_candidate: 'x' } }).status, 1, 'input can never carry state');
});

test('gate CLI: ship-ready appends SHIP_READY to RUN-STATE exactly once, even when run twice', { skip: POSIX_ONLY }, async (t) => {
  const fx = gateFixture(t, { config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } } });
  assert.equal(fx.cli('drive').status, 0);
  const cand = fx.candidate();
  assert.equal(fx.gate('review', passReview('review-1', cand)).status, 0);
  const first = fx.gate('ship-ready', {});
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.out?.code, 'ship_ready');
  const second = fx.gate('ship-ready', {});
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const ready = runStateEvents(fx.planFile).filter(e => e.event === 'SHIP_READY');
  assert.equal(ready.length, 1, JSON.stringify(ready));
  assert.equal(ready[0].candidate_id, cand);

  const altered = fx.gate('ship-ready', { exclusions: ['.specs/plans/T-1.md'] });
  assert.equal(altered.status, 2, altered.stdout + altered.stderr);
  assert.equal(altered.out?.code, 'exclusions_altered');
});

test('gate CLI: a held engine lock refuses the gate (exit 2, lock_held)', async (t) => {
  const fx = gateFixture(t);
  const lock = await acquireLock(fx.ctx());
  t.after(() => lock.release());
  const r = fx.gate('review', passReview('review-1', fx.candidate()));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.out?.ok, false);
  assert.equal(r.out?.code, 'lock_held');
  assert.equal(fx.readState().review_chain.length, 0);
});
