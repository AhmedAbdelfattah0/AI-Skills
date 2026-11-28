/**
 * S1 (P1 durable substrate): the §8 P1 negatives, the round-1 review findings, and their guards.
 *
 * Every hazard test drives a DEFAULT run (a DAG without config.durableRun), exactly as a run is started today, and puts
 * its behavioural assertion first, so on the frozen engine (705ae1b, where a default run is legacy) it fails for the real
 * reason: the hung worker is never bounded, a group with no verified identity is signalled, the state is lost with its
 * worktree. State is looked up in whichever placement exists (stateOf).
 *
 *   N1 kill -9 of the driver while a fake worker hangs: frozen recovery (`resume`) leaves it running; the deadline sweep
 *      (another process than its launcher) kills it after its persisted deadline and records `timed_out`.
 *   N2 90% of the deadline across repeated enforcer outages, restarts, a sleep and wall-clock steps: the charge never
 *      decreases and fires at the first observation past the deadline.
 *   N3 null or mismatched `leader_start`, a dead leader with live members: no signal, `unknown`, locks kept.
 *   N4 a recoverer killed inside the recovery-marker window: the next acquire recovers; exactly one of N racers wins.
 *   N5 `git worktree remove`: the engine state is intact.
 *
 * The D5 measurement is UNQUALIFIED: N1/N2 enforce only through an in-process testClock(); the CLI sweep measures nothing
 * and signals nothing (pinned below). This is G1 PARTIAL for production enforcement. No sleeps decide anything: the clock
 * is injected and process handshakes are files polled with waitUntil. Temp repos only; no Docker, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, POSIX, waitUntil, codes, gitPath } from './engine-test-fixture.mjs';
import { acquireLock } from './lib/durable-io.mjs';
import { processInfo } from './engine-quiesce.mjs';

const SKIP = POSIX ? false : 'POSIX process groups (Windows quiescence is unknown, known limit D4)';
const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const DURABLE_IO = fileURLToPath(new URL('./lib/durable-io.mjs', import.meta.url));
const LIMIT_MS = 600000; // the run timeout: the driver's own in-process timer never fires inside a test
const S1_REPAIRED = async () => 'durableVersion' in (await import('./engine-policy.mjs'));
/** A default DAG: no config.durableRun (on the engine before the S1 repair, durable needed the explicit opt-in). */
const DEFAULT = async () => (existsSync(fileURLToPath(new URL('./lib/run-placement.mjs', import.meta.url))) && !(await S1_REPAIRED()) ? { durableRun: { version: 1 } } : {});

const durableState = (repo) => join(repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'state.json');
/** The run's state file in whichever placement exists (durable common dir, else the worktree's --git-path). */
const stateOf = (repo) => (existsSync(durableState(repo)) ? durableState(repo) : gitPath(repo, 'ai-skills/ship-ticket/T-1.state.json'));
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const attemptOf = (repo, id) => readJson(stateOf(repo)).attempts.find(x => x.attempt_id === id);
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killQuietly = (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
/** The engine and the deadline module, loaded dynamically so this file also runs (RED) against an engine without them. */
const engine = () => import('./run-engine.mjs');
const deadlineMod = async () => { try { return await import('./lib/deadline.mjs'); } catch { return {}; } };

/** An injected test clock on the attempt's boot: `at(ms)` sets the monotonic reading to the attempt's start plus `ms`. */
async function clockFor(a) {
  const { testClock = (c) => c } = await deadlineMod();
  let off = 0n;
  const start = BigInt(a.deadline?.start_ns ?? '0');
  const c = testClock({ bootId: a.deadline?.boot_id ?? 'boot', nowNs: () => start + off });
  return { at(ms) { off = BigInt(ms) * 1000000n; return c; } };
}
/** Run the sweep, if this engine has one, with `clock` (on the frozen engine nothing exists that bounds the worker). */
async function sweep(fx, clock, extra = {}) {
  const { reconcileDeadlines } = await engine();
  return reconcileDeadlines?.(fx.ctx({ deadlineClock: clock, ...extra }));
}

/** Launch `drive` for `repo` and SIGKILL it once the hanging worker REALLY runs ('launched' precedes the release byte). */
async function killDriverAfterLaunch(t, fx, repo, stateFile) {
  const driver = spawn(process.execPath, [ENGINE_CLI, 'drive', '--repo', repo, '--ticket', 'T-1', '--run-id', 'run-1'], { env: fx.env, stdio: 'ignore' });
  const gone = new Promise(r => driver.on('exit', r));
  const launched = () => { try { return readJson(stateFile()).attempts.find(x => x.status === 'launched' && x.pgid); } catch { return undefined; } };
  assert.ok(await waitUntil(() => launched() && fx.runs('a').length > 0, 30000), 'the driver launched and released the hanging worker');
  const a = launched();
  t.after(() => killQuietly(a.pgid));
  driver.kill('SIGKILL');
  await gone;
  assert.ok(groupAlive(a.pgid), 'the worker group outlives its SIGKILLed driver');
  return a;
}

/** A default run whose node `a` hangs and whose driver was SIGKILLed: the worker group outlives it. Returns { fx, a }. */
async function orphanedHang(t, { resources = [] } = {}) {
  const fx = fixture(t, { config: { ...(await DEFAULT()), timeoutMs: LIMIT_MS }, nodes: [{ id: 'a', writes: ['src/a.txt'], resources }], behaviour: { a: { hang: true } } });
  const init = fx.cli('init', { dag: fx.dagFile });
  assert.equal(init.status, 0, `init: ${init.stderr}`);
  return { fx, a: await killDriverAfterLaunch(t, fx, fx.repo, () => stateOf(fx.repo)) };
}

/** A linked worktree `name` of `fx` on a new branch, with the run's plan. Returns { wt, cli(cmd, flags) } (CLI in the worktree). */
function linked(fx, name, plan = readFileSync(fx.planFile, 'utf8')) {
  const wt = join(fx.root, name);
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', name, wt], { cwd: fx.repo }).status, 0);
  mkdirSync(join(wt, '.specs', 'plans'), { recursive: true });
  writeFileSync(join(wt, '.specs', 'plans', 'T-1.md'), plan);
  const cli = (cmd, flags = {}) => spawnSync(process.execPath, [ENGINE_CLI, cmd, '--repo', wt, '--ticket', 'T-1', '--run-id', 'run-1',
    ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  return { wt, cli };
}

// ---------------------------------------------------------------- the default is durable (M1)

test('M1 a new run started as today (no config.durableRun) is durable: common-dir state, policy 13, recorded worktree, persisted deadlines', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: {} });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.ok(existsSync(durableState(fx.repo)), 'the state lives in <git-common-dir>/ai-skills/ship-ticket/runs/T-1/');
  assert.equal(existsSync(gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json')), false, 'nothing in the per-worktree placement');
  assert.equal(fx.cli('drive').status, 0);
  const s = readJson(durableState(fx.repo));
  assert.equal(s.policy_version, 13);
  assert.equal(typeof s.durable?.worktree, 'string');
  assert.ok(s.attempts[0].deadline, 'the attempt carries a persisted deadline');
});

for (const [hatch, opts] of [['config.durableRun: false', { config: { durableRun: false } }], ['SHIP_TICKET_PLACEMENT=legacy', { env: { SHIP_TICKET_PLACEMENT: 'legacy' } }]]) {
  test(`M1 the escape hatch ${hatch} keeps the legacy placement and semantics; the sweep refuses such a run`, { skip: SKIP }, async (t) => {
    const fx = fixture(t, { config: opts.config ?? {} });
    Object.assign(fx.env, opts.env ?? {});
    assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
    assert.equal(fx.cli('drive').status, 0);
    assert.ok(existsSync(gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json')));
    assert.equal(existsSync(durableState(fx.repo)), false);
    const s = readJson(gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json'));
    assert.equal(s.policy_version, 1);
    assert.equal(s.durable, undefined);
    assert.equal(s.attempts[0].deadline, undefined);
    const r = fx.cli('reconcile', { deadlines: 'true' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /deadlines_unsupported/);
  });
}

test('a durable state whose policy version, S.durable and placement disagree is never resumed (durable_state_missing)', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: {} });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const s = readJson(durableState(fx.repo));
  delete s.durable;
  writeFileSync(durableState(fx.repo), JSON.stringify(s));
  const r = fx.cli('status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /durable_state_missing/);
});

// ---------------------------------------------------------------- N1/N2: the deadline sweep (test clock)

test('N1 kill -9 driver + hung worker: frozen recovery leaves it running; the sweep kills it after its persisted deadline (timed_out)', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  assert.equal(fx.cli('resume').status, 0);
  assert.ok(groupAlive(a.pgid), 'resume does not bound a live worker');
  const clock = await clockFor(a);
  await sweep(fx, clock.at(LIMIT_MS - 1));
  assert.ok(groupAlive(a.pgid), 'before its deadline the worker is not signalled');
  await sweep(fx, clock.at(LIMIT_MS + 1));
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 10000), 'HAZARD: after kill -9 of its driver nothing bounded the hung worker');
  const b = attemptOf(fx.repo, a.attempt_id);
  assert.equal(b.status, 'timed_out');
  assert.equal(b.quiesced, true);
  assert.equal(b.deadline.timed_out.signalled, true);
  assert.equal(readJson(stateOf(fx.repo)).nodes.a.state, 'failed');
});

test('N2 90% consumed across repeated enforcer outages, restarts, a sleep and wall-clock steps: consumed execution never disappears, the deadline fires once past it', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const clock = await clockFor(a);
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  // PR-1b: the lock-free sweep writes nothing to the driver's state; its charge is in its own result and file
  const before = readFileSync(stateOf(fx.repo));
  let out;
  const charged = () => out?.swept?.find(x => x.attempt_id === a.attempt_id)?.charged_ms;
  // Each sweep is a fresh enforcer invocation (a restart); the gaps between them are outages; 0.40 -> 0.55 is a host sleep
  // on a clock that counts sleep (darwin uv_hrtime): it is charged, conservatively. The wall clock is stepped -1 h / +1 h.
  const marks = [0.10, 0.25, 0.40, 0.55, 0.70, 0.90];
  const steps = [0, -3600000, 3600000, -3600000, 3600000, 0];
  let last = -1;
  for (const [i, f] of marks.entries()) {
    Date.now = () => realNow() + steps[i];
    out = await sweep(fx, clock.at(Math.round(LIMIT_MS * f)));
    const c = charged();
    assert.equal(c, Math.round(LIMIT_MS * f), `the charge at ${f} is the full monotonic elapsed time (no outage dropped or capped, wall clock ignored)`);
    assert.ok(c > last, 'the charge never decreases');
    last = c;
    assert.ok(groupAlive(a.pgid), `below the deadline (${f}) the worker is not signalled`);
  }
  out = await sweep(fx, clock.at(Math.round(LIMIT_MS * 0.5))); // a backwards reading never reduces a recorded charge
  assert.deepEqual(readFileSync(stateOf(fx.repo)), before, 'below the deadline the sweep wrote nothing to the driver state');
  assert.equal(charged(), Math.round(LIMIT_MS * 0.9), 'consumed execution never disappears');
  await sweep(fx, clock.at(LIMIT_MS));
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 10000), 'the first observation at the deadline kills the group');
  assert.equal(attemptOf(fx.repo, a.attempt_id).status, 'timed_out');
});

// ---------------------------------------------------------------- N3 and Codex 1: no signal without positive identity

for (const [name, edit] of [['null', (b) => { b.leader_start = null; }], ['mismatched (a reused pid)', (b) => { b.leader_start = 'Thu Jan  1 00:00:00 1970'; }]]) {
  test(`N3 ${name} leader_start: an expired deadline sends no signal, the attempt is unknown and its slot stays charged`, { skip: SKIP }, async (t) => {
    const { fx, a } = await orphanedHang(t, { resources: ['db:main'] });
    const file = stateOf(fx.repo), s0 = readJson(file);
    edit(s0.attempts.find(x => x.attempt_id === a.attempt_id));
    writeFileSync(file, JSON.stringify(s0));
    await sweep(fx, (await clockFor(a)).at(LIMIT_MS * 2));
    assert.ok(groupAlive(a.pgid), 'no signal reached the unverified group');
    const s = readJson(file), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
    assert.equal(b.status, 'unknown');
    assert.notEqual(b.quiesced, true);
    assert.equal(s.locks['db:main'], a.attempt_id, 'the attempt keeps its resource lock (capacity stays charged)');
    assert.ok(codes(s).includes('quiescence_unknown'));
  });
}

test('N3 (E8) resume never signals a live leader whose start time was not recorded', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const file = stateOf(fx.repo), s0 = readJson(file);
  s0.attempts.find(x => x.attempt_id === a.attempt_id).leader_start = null;
  writeFileSync(file, JSON.stringify(s0));
  writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file })); // settle would now retire it
  assert.equal(fx.cli('resume').status, 0);
  assert.ok(groupAlive(a.pgid), 'HAZARD: a group with no verified leader identity was signalled');
  assert.equal(attemptOf(fx.repo, a.attempt_id).status, 'unknown');
});

test('Codex 1: recovery never signals a group whose leader is dead while members remain (identity not positively verified)', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { resources: ['db:main'] });
  process.kill(a.pgid, 'SIGKILL'); // the leader (the launcher) dies; the worker, in the same group, keeps running
  assert.ok(await waitUntil(() => !processInfo(a.pgid).alive, 5000));
  assert.ok(groupAlive(a.pgid), 'members remain');
  const file = stateOf(fx.repo), s0 = readJson(file);
  s0.attempts.find(x => x.attempt_id === a.attempt_id).status = 'unknown'; // reconcile retires an unknown worker attempt
  writeFileSync(file, JSON.stringify(s0));
  assert.equal(fx.cli('resume').status, 0);
  assert.ok(groupAlive(a.pgid), 'no signal reached a group that could not be positively verified');
  const s = readJson(file);
  assert.equal(s.attempts.find(x => x.attempt_id === a.attempt_id).status, 'unknown');
  assert.equal(s.locks['db:main'], a.attempt_id);
});

// ---------------------------------------------------------------- sweep settlement (latent L1-L5, Codex 4)

test('L5: an injected clock that is not a testClock() is refused (a caller cannot enable the unqualified measurement)', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const { reconcileDeadlines } = await engine();
  await assert.rejects(reconcileDeadlines(fx.ctx({ deadlineClock: { bootId: a.deadline.boot_id, nowNs: () => BigInt(a.deadline.start_ns) + 10n ** 15n } })),
    { code: 'deadline_clock_refused' });
  assert.ok(groupAlive(a.pgid));
});

test('L1: a group already gone whose overrun was never seen alive is not turned into a timeout (nothing invented): resume settles it', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  killQuietly(a.pgid); // the worker ends on its own (a crash), with no driver to see it
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 5000));
  await sweep(fx, (await clockFor(a)).at(LIMIT_MS * 3));
  const b = attemptOf(fx.repo, a.attempt_id);
  assert.notEqual(b.status, 'timed_out', 'the charge kept growing after the group ended: it proves no timeout');
  assert.equal(b.deadline?.timed_out, undefined);
  assert.equal(fx.cli('resume').status, 0);
  assert.equal(readJson(stateOf(fx.repo)).nodes.a.state, 'pending', 'resume re-queues it (no writes, no envelope), as before S1');
});

test('Codex 4 + L2: a sweep from another worktree kills an expired verified group; the deadline wins over an envelope written after it (kept as evidence); nothing is recorded against the caller\'s tree', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: { ...(await DEFAULT()), timeoutMs: LIMIT_MS }, commit: true, behaviour: { a: { hang: true } } });
  const { wt, cli } = linked(fx, 'feature');
  assert.equal(cli('init', { dag: fx.dagFile }).status, 0);
  const state = () => (existsSync(durableState(fx.repo)) ? durableState(fx.repo) : join(fx.repo, '.git', 'worktrees', 'feature', 'ai-skills', 'ship-ticket', 'T-1.state.json'));
  const a = await killDriverAfterLaunch(t, fx, wt, state);
  // PR-1b round 1 (SIMULATED interleave): the envelope "completes" AFTER the sweep recorded it absent past the deadline (an
  // envelope already present when the sweep looks is the owner's to settle, M1); the injected probe writes it right after the receipt
  const sweepFile = join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'attempts', 'deadline-sweep.jsonl');
  let wrote = false;
  const probe = (pgid) => {
    if (!wrote && existsSync(sweepFile) && readFileSync(sweepFile, 'utf8').includes('"type":"signal"')) { wrote = true; writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file })); }
    return groupAlive(pgid);
  };
  const { reconcileDeadlines } = await engine();
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: (await clockFor(a)).at(LIMIT_MS + 1), groupAlive: probe })); // from the MAIN checkout
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 10000), 'the expired verified group was killed');
  const s = readJson(state()), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
  assert.equal(b.status, 'timed_out', 'the deadline wins over the late envelope');
  assert.equal(s.nodes.a.state, 'failed');
  assert.equal(b.late_envelope?.exit_code, 0, 'the late envelope is kept as evidence');
  assert.equal(b.envelope, undefined, 'it was never recorded as the attempt\'s result');
});

test('L3: after a reboot (another boot id) the attempt is settled through settle(): a result written before the reboot is recorded, no pgid is probed or signalled', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const { testClock = (c) => c } = await deadlineMod();
  await sweep(fx, (await clockFor(a)).at(1000));
  writeFileSync(a.out_file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
  writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file }));
  await sweep(fx, testClock({ bootId: 'another-boot', nowNs: () => 5n }));
  assert.ok(groupAlive(a.pgid), 'the (here still running) group was not signalled: after a reboot its pgid may be anyone');
  const s = readJson(stateOf(fx.repo)), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
  assert.equal(b.quiesced, true);
  assert.equal(s.nodes.a.state, 'done', 'the result written before the reboot is recorded');
  assert.equal(b.deadline.charged_ms, 1000, 'the last measured charge is kept as a lower bound');
  assert.deepEqual(b.deadline.unmeasured, [{ reason: 'boot_changed', after_ms: 1000, to_boot: 'another-boot' }]);
});

test('the CLI sweep without the opt-in is unqualified: it measures nothing, signals nothing, and writes nothing (state byte-identical, no sweep file)', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const before = readFileSync(stateOf(fx.repo));
  const r = fx.cli('reconcile', { deadlines: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.measurement, 'unqualified');
  assert.deepEqual(r.out.swept.map(x => [x.attempt_id, x.action, x.reason]), [[a.attempt_id, 'none', 'measurement_unqualified']]);
  assert.ok(groupAlive(a.pgid));
  assert.deepEqual(readFileSync(stateOf(fx.repo)), before, 'PR-1b: the frozen (no opt-in) sweep never writes the driver state');
  assert.equal(existsSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'attempts', 'deadline-sweep.jsonl')), false);
  const b = attemptOf(fx.repo, a.attempt_id);
  assert.equal(b.status, 'launched');
  assert.equal(b.deadline.measurement, 'unqualified');
  assert.equal(b.deadline.enforcement, undefined, 'nothing is armed under the opt-in by default');
});

// ---------------------------------------------------------------- Codex 2: worktree ownership before any observation or write

test('Codex 2: a mutating command from another worktree is refused before it observes or writes: the shared state stays byte-identical', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: await DEFAULT(), commit: true, behaviour: {} });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  // the other worktree's plan carries an extra authority line that must never reach the run's state
  const { cli } = linked(fx, 'other', readFileSync(fx.planFile, 'utf8').replace('<!-- RUN-STATE:END -->', '{"run_id":"run-1","event":"NOTE","note":"from B"}\n<!-- RUN-STATE:END -->'));
  const before = readFileSync(stateOf(fx.repo));
  for (const cmd of ['drive', 'resume']) {
    const r = cli(cmd);
    assert.ok(readFileSync(stateOf(fx.repo)).equals(before), `${cmd}: the state is byte-identical after the refusal`);
    assert.notEqual(r.status, 0, `${cmd} from another worktree is refused`);
    assert.match(r.stderr + r.stdout, /worktree_mismatch/);
  }
  assert.deepEqual(fx.runs(), [], 'nothing was dispatched from the other worktree');
});

// ---------------------------------------------------------------- Codex 3: placement reservation across worktrees

test('Codex 3: a durable init of a ticket whose legacy run lives in another worktree is refused, and the legacy run keeps working', { skip: SKIP }, async (t) => {
  // ONE DAG (bound by the approved plan) for both inits: the main checkout's run is made legacy by the environment escape
  // hatch (an engine before the S1 repair: legacy by default), the linked worktree's init uses the default placement.
  const fx = fixture(t, { config: await DEFAULT(), commit: true, behaviour: {} });
  const legacyEnv = { ...fx.env, SHIP_TICKET_PLACEMENT: 'legacy' };
  const a = spawnSync(process.execPath, [ENGINE_CLI, 'init', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1', '--dag', fx.dagFile], { encoding: 'utf8', env: legacyEnv, timeout: 60000 });
  assert.equal(a.status, 0, a.stderr);
  if (!(await S1_REPAIRED())) { // on the round-1 engine the opt-in DAG made the main run durable: plant the legacy run instead
    const d = readFileSync(durableState(fx.repo));
    rmSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs'), { recursive: true, force: true });
    writeFileSync(gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json'), d);
  }
  assert.ok(existsSync(gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json')), 'the legacy run in the main checkout');
  const { cli } = linked(fx, 'third');
  const r = cli('init', { dag: fx.dagFile });
  assert.equal(existsSync(durableState(fx.repo)), false, 'no durable state was published beside the live legacy run');
  assert.notEqual(r.status, 0, 'the conflicting durable init is refused');
  assert.match(r.stderr, /state_exists/);
  assert.equal(spawnSync(process.execPath, [ENGINE_CLI, 'status', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'], { encoding: 'utf8', env: legacyEnv }).status, 0,
    'the existing legacy run is not stranded (no state_placement_ambiguous)');
});

test('both placements present for one ticket: every engine command refuses (state_placement_ambiguous); wave reports it corrupt, not "not started"', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: await DEFAULT() });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  mkdirSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket'), { recursive: true });
  copyFileSync(durableState(fx.repo), gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json'));
  const { readTicket } = await import('./wave.mjs');
  const w = readTicket({ worktree: fx.repo, key: 'T-1', run_id: 'run-1', plan: '.specs/plans/T-1.md', branch: 'main' });
  assert.deepEqual([w.state, w.reason], ['corrupt', 'status_state_placement_ambiguous'], 'reported as the ambiguity, not as "not started" or a workspace problem');
  const r = fx.cli('status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /state_placement_ambiguous/);
});

// ---------------------------------------------------------------- m8: archive --retire ordering

test('m8 archive --retire of a durable run: a crash at the state rename never leaves the retired attempts in the live run directory', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: await DEFAULT() });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const attempts = join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'attempts');
  assert.ok(existsSync(attempts));
  const { archive } = await engine();
  const hooks = { boundary: async (name, info) => { if (name === 'retire-rename' && info?.name === 'state.json') throw new Error('crash before the state rename'); } };
  await assert.rejects(archive(fx.ctx({ retire: true, hooks })), /crash before the state rename/);
  assert.equal(existsSync(attempts), false, 'the attempts were moved into the archive before any engine file');
  assert.ok(existsSync(durableState(fx.repo)), 'the state is still live (archive --retire again completes it)');
});

// ---------------------------------------------------------------- N5: worktree removal

test('N5 git worktree remove of the worktree a default run ran in: the engine state survives, none under .git/worktrees', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: await DEFAULT(), commit: true });
  const { wt, cli } = linked(fx, 'feature');
  assert.equal(cli('init', { dag: fx.dagFile }).status, 0);
  const drove = cli('drive');
  assert.equal(drove.status, 0, drove.stderr);
  assert.equal(spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: fx.repo }).status, 0);
  assert.equal(existsSync(wt), false);
  assert.ok(existsSync(durableState(fx.repo)), 'HAZARD: the engine state was deleted with its worktree');
  const s = readJson(durableState(fx.repo));
  assert.equal(s.nodes.a.state, 'done');
  assert.ok(s.attempts.length === 1 && s.attempts[0].deadline, 'the attempt record (with its deadline) is intact');
  assert.ok(existsSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'attempts', `${s.attempts[0].attempt_id}.out`)), 'the worker output too');
  const wts = join(fx.repo, '.git', 'worktrees');
  const under = existsSync(wts) ? readdirSync(wts, { recursive: true }).filter(p => String(p).includes('ai-skills')) : [];
  assert.deepEqual(under, [], '0 engine paths under .git/worktrees/');
  // Archived and retired from the main checkout once its worktree is gone (no plan of its own is observed there).
  const arch = spawnSync(process.execPath, [ENGINE_CLI, 'archive', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1', '--retire', 'true'], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  assert.equal(arch.status, 0, arch.stderr);
  const out = JSON.parse(arch.stdout);
  assert.ok(existsSync(join(out.archive, 'outputs.json')) && existsSync(join(out.archive, 'outputs', 'attempts')), 'referenced outputs archived');
  assert.ok(existsSync(join(out.archive, 'retired', 'attempts')) && !existsSync(durableState(fx.repo)), 'retired: a new run of the ticket can init');
});

test('archive --retire of a durable run from another worktree is refused while the owning worktree exists', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: await DEFAULT(), commit: true });
  const { cli } = linked(fx, 'owner');
  assert.equal(cli('init', { dag: fx.dagFile }).status, 0);
  const before = readFileSync(durableState(fx.repo));
  const r = fx.cli('archive', { retire: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worktree_mismatch/);
  assert.ok(readFileSync(durableState(fx.repo)).equals(before));
});

// ---------------------------------------------------------------- N4: the recovery marker

/** A pid that really existed and is now dead (killed -9), with the start time it had. */
async function deadProcess() {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  await waitUntil(() => processInfo(c.pid).startTime !== null, 5000);
  const startTime = processInfo(c.pid).startTime;
  const exited = new Promise(r => c.on('exit', r));
  c.kill('SIGKILL');
  await exited;
  return { pid: c.pid, startTime };
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const [shape, marker] of [
  ['a pre-S1 marker { pid, nonce }', (d) => ({ pid: d.pid, nonce: 'theirs-1' })],
  ['an S1 marker { pid, process_start_time, host, nonce }', (d) => ({ pid: d.pid, process_start_time: d.startTime, host: hostname(), nonce: 'theirs-2' })],
]) {
  test(`N4 kill -9 inside the marker window (${shape}) with a stale lock: the next acquire recovers`, { skip: SKIP }, async (t) => {
    const dir = scratch(t), lockFile = join(dir, 'lock');
    const dead = await deadProcess();
    // The on-disk state a recoverer killed between its marker create and its lock replace leaves behind (real dead pid).
    writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), run_id: 'old', nonce: 'held' }));
    writeFileSync(lockFile + '.recovery', JSON.stringify(marker(dead)));
    const h = await acquireLock({ lockFile, runId: 'r' });
    assert.equal(readJson(lockFile).pid, process.pid, 'the next acquire took the lock');
    assert.deepEqual(readdirSync(dir).sort(), ['lock'], 'the stale marker is gone and nothing else is left');
    await h.release();
  });
}

test('N4 a live recoverer\'s marker is never broken (its start time matches): lock_held', { skip: SKIP }, async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'lock');
  const dead = await deadProcess();
  writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), run_id: 'old', nonce: 'held' }));
  const mine = { pid: process.pid, process_start_time: processInfo(process.pid).startTime, host: hostname(), nonce: 'live' };
  writeFileSync(lockFile + '.recovery', JSON.stringify(mine));
  await assert.rejects(acquireLock({ lockFile, runId: 'r' }), { code: 'lock_held' });
  assert.deepEqual(readJson(lockFile + '.recovery'), mine);
});

test('N4 race: of 6 processes recovering one stale lock under one stale marker at once, exactly one holds the lock (no timing assumption)', { skip: SKIP }, async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'lock'), go = join(dir, 'go'), done = join(dir, 'done');
  const dead = await deadProcess();
  writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), run_id: 'old', nonce: 'held' }));
  writeFileSync(lockFile + '.recovery', JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), nonce: 'stale' }));
  // Every contender reports ready, waits for `go`, decides, reports, and holds (the winner keeps the lock) until the parent
  // has collected every decision (`done`): no contender can decide after the winner has exited.
  const src = (i) => `import { acquireLock } from ${JSON.stringify(DURABLE_IO)};
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, `ready-${i}`))}, '');
while (!existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 1));
let out;
try { await acquireLock({ lockFile: ${JSON.stringify(lockFile)}, runId: 'race' }); out = 'won'; } catch (e) { out = 'lost:' + e.code; }
writeFileSync(${JSON.stringify(join(dir, `result-${i}`))}, out);
while (!existsSync(${JSON.stringify(done)})) await new Promise(r => setTimeout(r, 5));`;
  const kids = Array.from({ length: 6 }, (_, i) => spawn(process.execPath, ['--input-type=module', '-e', src(i)], { stdio: ['ignore', 'ignore', 'inherit'] }));
  const exits = kids.map(k => new Promise(r => k.on('exit', r)));
  t.after(() => { for (const k of kids) try { k.kill('SIGKILL'); } catch { /* gone */ } });
  const all = (prefix) => [0, 1, 2, 3, 4, 5].every(i => existsSync(join(dir, `${prefix}-${i}`)));
  assert.ok(await waitUntil(() => all('ready'), 60000), 'every contender is ready');
  writeFileSync(go, '');
  assert.ok(await waitUntil(() => all('result'), 60000), 'every contender decided');
  const results = [0, 1, 2, 3, 4, 5].map(i => readFileSync(join(dir, `result-${i}`), 'utf8'));
  writeFileSync(done, '');
  await Promise.all(exits);
  assert.equal(results.filter(o => o === 'won').length, 1, `exactly one winner: ${results.join(' ')}`);
  assert.ok(results.filter(o => o !== 'won').every(o => o === 'lost:lock_held'), results.join(' '));
  assert.ok(!existsSync(lockFile + '.recovery'), 'no marker is left once the recovery is done');
});

test('m7 start times are time-zone independent: a live holder that locked under another TZ is never judged reused', { skip: SKIP }, async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'lock'), ready = join(dir, 'ready');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(DURABLE_IO)};
import { writeFileSync } from 'node:fs';
await acquireLock({ lockFile: ${JSON.stringify(lockFile)}, runId: 'tz' }); writeFileSync(${JSON.stringify(ready)}, ''); setTimeout(() => {}, 600000);`],
  { stdio: 'ignore', env: { ...process.env, TZ: 'Pacific/Kiritimati' } });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } });
  assert.ok(await waitUntil(() => existsSync(ready), 20000));
  const tz = process.env.TZ;
  process.env.TZ = 'America/Adak';
  try { await assert.rejects(acquireLock({ lockFile, runId: 'r' }), { code: 'lock_held' }, 'the live holder is never broken'); }
  finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  assert.equal(readJson(lockFile).pid, holder.pid);
});

test('m5 a filesystem without hard links: the recovery marker falls back to an exclusive create and recovery still succeeds', { skip: SKIP }, async (t) => {
  const { TEST_SEAM } = await import('./lib/durable-io.mjs');
  const dir = scratch(t), lockFile = join(dir, 'lock');
  const dead = await deadProcess();
  writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), run_id: 'old', nonce: 'held' }));
  const noLink = () => { throw Object.assign(new Error('ENOTSUP: operation not supported'), { code: 'ENOTSUP' }); };
  const h = await acquireLock({ lockFile, runId: 'r' }, { [TEST_SEAM]: { link: noLink } });
  assert.equal(readJson(lockFile).pid, process.pid);
  assert.deepEqual(readdirSync(dir), ['lock']);
  await h.release();
});

// ---------------------------------------------------------------- m3: synchronous child calls carry a timeout

test('m3 every synchronous child call in the S1-touched modules carries a timeout', () => {
  const files = ['run-engine.mjs', 'engine-attempts.mjs', 'engine-io.mjs', 'engine-quiesce.mjs', 'engine-gates.mjs', 'engine-units.mjs', 'gate.mjs', 'carrier.mjs',
    'check-pr-scope.mjs', 'engine-accepted.mjs', 'eval.mjs', 'wave.mjs', 'lib/durable-io.mjs', 'lib/run-placement.mjs', 'lib/deadline.mjs'];
  const missing = [];
  for (const f of files) {
    let src; try { src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/spawnSync\(/g)) {
      let depth = 0, end = m.index + 'spawnSync'.length;
      for (; end < src.length; end++) { if (src[end] === '(') depth++; else if (src[end] === ')' && --depth === 0) break; }
      if (!/timeout/.test(src.slice(m.index, end + 1))) missing.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------- lib/deadline.mjs (pure)

test('deadline record: an unknown boot id measures nothing and says so; a legacy state arms nothing; the mechanism is unqualified', async () => {
  const { armRecord, armAttempt, observe, MEASUREMENT_QUALIFIED, resolveSweepClock } = await import('./lib/deadline.mjs');
  assert.equal(MEASUREMENT_QUALIFIED, false, 'G0 has not passed: the flag stays off');
  assert.equal(resolveSweepClock(undefined), null, 'unqualified: no real clock is bound for enforcement');
  const rec = armRecord(1000, { bootId: null, nowNs: () => 0n });
  assert.deepEqual(observe(rec, { bootId: null, nowNs: () => 5000000000n }), { charged_ms: 0, expired: false, boot_ended: false, measured: false });
  assert.deepEqual(rec.unmeasured, [{ reason: 'boot_unknown' }], 'recorded explicitly as unmeasured, never as zero execution');
  const a = { pid: 7 };
  armAttempt({ config: {} }, a, 1000, { bootId: 'b', nowNs: () => 0n });
  assert.equal(a.deadline, undefined, 'a legacy run (no S.durable) records no deadline');
  armAttempt({ config: {}, durable: { version: 1, worktree: '/x' } }, a, 1000, { bootId: 'b', nowNs: () => 42n });
  assert.equal(a.deadline.start_ns, '42');
  assert.equal(a.deadline.measurement, 'unqualified');
});

// ---------------------------------------------------------------- round-3 recovery (RCA-S1-ROUND2)

/**
 * The lock-recovery decision of the FROZEN engine (705ae1b lib/durable-io.mjs acquireLock), copied verbatim: its processInfo
 * reads `ps -o lstart=` under the inherited environment and compares the record's `process_start_time` raw.
 */
function frozenRefuses(lockFile, env) {
  const held = JSON.parse(readFileSync(lockFile, 'utf8'));
  let alive;
  try { process.kill(held.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  const r = alive ? spawnSync('ps', ['-o', 'lstart=', '-p', String(held.pid)], { encoding: 'utf8', timeout: 5000, env }) : null;
  const other = { alive, startTime: r && r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null };
  const reused = other.startTime !== null && (held.process_start_time ?? null) !== null && other.startTime !== held.process_start_time;
  return other.alive && !reused; // true: lock_held (the frozen engine leaves the live holder alone)
}

for (const placement of ['legacy', 'durable']) {
  test(`mixed versions (${placement} placement): a frozen 705ae1b reader under a non-UTC TZ refuses to steal a live S1 holder's lock`, { skip: SKIP }, async (t) => {
    const fx = fixture(t, { config: {} });
    if (placement === 'legacy') fx.env.SHIP_TICKET_PLACEMENT = 'legacy';
    assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
    const lockFile = placement === 'legacy' ? gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.lock') : join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'lock');
    assert.equal(existsSync(stateOf(fx.repo)), true);
    const TZ = 'Asia/Karachi', env = { ...process.env, TZ };
    const ready = join(fx.root, 'held');
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(DURABLE_IO)};
import { writeFileSync } from 'node:fs';
await acquireLock({ lockFile: ${JSON.stringify(lockFile)}, runId: 'run-1' }); writeFileSync(${JSON.stringify(ready)}, ''); setTimeout(() => {}, 600000);`],
    { stdio: 'ignore', env });
    t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } });
    assert.ok(await waitUntil(() => existsSync(ready), 20000), 'the S1 holder took the lock');
    assert.equal(frozenRefuses(lockFile, env), true, 'the frozen reader sees the live S1 holder as the holder, never as a reused pid');
    const rec = readJson(lockFile);
    assert.equal(typeof rec.start_identity, 'string', 'the canonical identity is a separate field');
    assert.notEqual(rec.process_start_time, rec.start_identity, `${TZ} is not UTC: the two forms differ`);
  });
}

test('C-M1: a pre-S1 / escape-hatch archive (policy 1-12) is adoptable into a new default (durable, 13-24) run', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: {}, commit: true });
  fx.env.SHIP_TICKET_PLACEMENT = 'legacy';
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.equal(readJson(gitPath(fx.repo, 'ai-skills/ship-ticket/T-1.state.json')).policy_version, 1);
  const arch = fx.cli('archive', { retire: 'true' });
  assert.equal(arch.status, 0, arch.stderr);
  delete fx.env.SHIP_TICKET_PLACEMENT;
  const { narrativeDigest } = await import('./engine-test-fixture.mjs');
  fx.appendRunState({ run_id: 'run-2', event: 'START', timestamp: '2026-11-05T00:00:00Z', approved_plan_digest: narrativeDigest(readFileSync(fx.planFile, 'utf8')) });
  const init2 = fx.cli('init', { dag: fx.dagFile }, { runId: 'run-2' });
  assert.equal(init2.status, 0, init2.stderr);
  assert.equal(readJson(durableState(fx.repo)).policy_version, 13, 'the new run is a default durable run');
  const a = fx.cli('adopt', { from: arch.out.archive }, { runId: 'run-2' });
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(a.out.outcome, 'adopted');
  assert.deepEqual(a.out.adoption.adopted, ['a']);
});

// ---------------------------------------------------------------- groupIdentity: a leader that exits mid-probe (AC4 flake)

test('groupIdentity: a group that dies between the group probe and the start-time read is gone, not unknown; nothing unproven is verified', async () => {
  const { groupIdentity } = await import('./engine-quiesce.mjs');
  const START = 'Thu Nov 26 10:00:00 2026';
  const a = { pgid: 4242, leader_start: START };
  /** isAlive answering `answers` in turn (the last one repeats); counts the probes. */
  const probes = (...answers) => { const f = () => { f.n++; return answers[Math.min(f.n - 1, answers.length - 1)]; }; f.n = 0; return f; };
  const dead = () => ({ alive: false, startTime: null });
  // the AC4 race: the group probe sees it alive, the leader exits, the start-time read finds nothing, a fresh group probe proves ESRCH
  let isAlive = probes(true, false);
  assert.equal(groupIdentity(a, isAlive, () => ({ alive: true, startTime: null })), 'gone', 'kill(0) ok, then ps empty, then the whole group is gone');
  assert.equal(isAlive.n, 2, 'gone rests on a fresh positive group probe');
  assert.equal(groupIdentity(a, probes(true, false), dead), 'gone', 'the leader is already dead at the read and the group is gone');
  // still alive (or unknowable) after an unreadable start time: unproven, stays unknown
  assert.equal(groupIdentity(a, probes(true, true), () => ({ alive: true, startTime: null })), 'unknown');
  assert.equal(groupIdentity(a, probes(true, null), () => ({ alive: true, startTime: null })), 'unknown', 'an unknowable group probe proves nothing');
  assert.equal(groupIdentity(a, probes(true, true), dead), 'unknown', 'a dead leader whose group still has members is not attributable');
  // a live leader with exactly the recorded start: verified, with no second probe
  isAlive = probes(true);
  assert.equal(groupIdentity(a, isAlive, () => ({ alive: true, startTime: START })), 'verified');
  assert.equal(isAlive.n, 1);
  // a different start time is a reused pid, never verified, never gone while the group lives
  assert.equal(groupIdentity(a, probes(true, true), () => ({ alive: true, startTime: 'Fri Nov 27 10:00:00 2026' })), 'unknown');
  // unchanged edges
  assert.equal(groupIdentity(a, probes(false), () => { throw new Error('no read when the group is gone'); }), 'gone');
  assert.equal(groupIdentity({ pgid: 4242 }, probes(true), dead), 'unknown', 'no recorded start time');
  assert.equal(groupIdentity({ pgid: 0, leader_start: START }, probes(false), dead), 'unknown', 'no valid pgid');
});
