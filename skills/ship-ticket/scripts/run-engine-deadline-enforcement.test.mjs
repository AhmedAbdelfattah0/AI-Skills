/**
 * PR-1b (P1 invariant "a deadline is enforced by a process other than its launcher"): the lock-free verified sweep, the
 * locked settlement that derives the timeout from persisted facts (FU-1, FU-2), the monotonic kill grace, and the explicit
 * UNQUALIFIED opt-in (SHIP_TICKET_UNQUALIFIED_DEADLINE_ENFORCEMENT=1). Everything here runs the REAL engine CLI and real
 * process groups (a SIGSTOPped driver really holds the run lock; the sweep is a separate process with the real clock),
 * except where a test name says SIMULATED: a wall-clock step is simulated by patching Date.now in-process, and an
 * envelope's monotonic position is injected by writing its `mono_ns`. No physical clock step, host sleep or reboot is run
 * here (those are the deferred H1 host tests, NOT_RUN). Temp repos only; no Docker, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, POSIX, waitUntil, codes, STAGED, STAGED_BEHAVIOUR } from './engine-test-fixture.mjs';
import { processInfo } from './engine-quiesce.mjs';

const SKIP = POSIX ? false : 'POSIX process groups (Windows quiescence is unknown, known limit D4)';
const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const OPT_IN = { SHIP_TICKET_UNQUALIFIED_DEADLINE_ENFORCEMENT: '1' };
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** Whether any member of process group `pgid` still RUNS (a zombie, e.g. a killed leader its stopped parent has not reaped, does not). */
const groupRunning = (pgid) => {
  const r = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8', timeout: 5000 });
  return r.stdout.split('\n').map(l => l.trim().split(/\s+/)).some(([g, st]) => Number(g) === pgid && st && !st.startsWith('Z'));
};
const killQuietly = (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
const sweepFile = (fx) => join(fx.attemptsDir(), 'deadline-sweep.jsonl');
const sweepLines = (fx) => { try { return readFileSync(sweepFile(fx), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const attemptOf = (fx, id) => fx.readState().attempts.find(x => x.attempt_id === id);

/** The engine CLI for `fx` with `extraEnv` (e.g. the opt-in) on top of the fixture environment. */
function cli(fx, cmd, flags = {}, extraEnv = {}) {
  const r = spawnSync(process.execPath, [ENGINE_CLI, ...cmd.split(' '), '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1',
    ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { encoding: 'utf8', env: { ...fx.env, ...extraEnv }, timeout: 60000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, out, stderr: r.stderr };
}
const sweepCli = (fx, extraEnv = {}) => cli(fx, 'reconcile', { deadlines: 'true' }, extraEnv);

/** Start `drive` (env `extraEnv`) and wait until node `id`'s worker really runs; returns { driver, a, exited }. */
async function driveUntilRunning(t, fx, extraEnv = {}, id = 'a') {
  const driver = spawn(process.execPath, [ENGINE_CLI, 'drive', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'],
    { env: { ...fx.env, ...extraEnv }, stdio: 'ignore' });
  const exited = new Promise(r => driver.on('exit', (code, signal) => r({ code, signal })));
  const launched = () => { try { return fx.readState().attempts.find(x => x.node === id && x.status === 'launched' && x.pgid); } catch { return undefined; } };
  assert.ok(await waitUntil(() => launched() && fx.runs(id).length > 0, 30000), 'the driver launched and released the worker');
  const a = launched();
  t.after(() => { try { driver.kill('SIGCONT'); driver.kill('SIGKILL'); } catch { /* gone */ } killQuietly(a.pgid); });
  return { driver, a, exited };
}

/** A run whose node `a` hangs, its driver SIGKILLed (the worker group outlives it). `driverEnv` arms the attempt. */
async function orphanedHang(t, { timeoutMs, driverEnv = {}, resources = [] } = {}) {
  const fx = fixture(t, { config: { timeoutMs }, nodes: [{ id: 'a', writes: ['src/a.txt'], resources }], behaviour: { a: { hang: true } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const { driver, a, exited } = await driveUntilRunning(t, fx, driverEnv);
  driver.kill('SIGKILL');
  await exited;
  assert.ok(groupAlive(a.pgid), 'the worker group outlives its SIGKILLed driver');
  return { fx, a };
}

/** Sweep (CLI, opt-in, real clock) until the attempt's row reaches `action` or `ms` pass; returns the last output. */
async function sweepUntil(fx, attemptId, action, ms = 30000) {
  let last;
  await waitUntil(() => {
    last = sweepCli(fx, OPT_IN);
    return last.out?.swept?.find(r => r.attempt_id === attemptId)?.action === action;
  }, ms);
  return last;
}

/** ps state of `pid` ('T' = stopped), or null. */
const psState = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : null; };

// ---------------------------------------------------------------- N1/N2 on production paths (real CLI, real clock, real processes)

test('P1: a SIGSTOPped driver holding the run lock does not block the sweep: a separate opt-in sweep kills the verified expired worker group, writes nothing to the driver state; without the opt-in nothing is signalled', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: { timeoutMs: 4000 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }], behaviour: { a: { hang: true } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  // the driver itself has NO opt-in: only the operator's sweep process does (settlement still derives the timeout)
  const { driver, a, exited } = await driveUntilRunning(t, fx);
  driver.kill('SIGSTOP');
  assert.ok(await waitUntil(() => psState(driver.pid)?.startsWith('T'), 5000), 'the driver is stopped (its in-process timer cannot act)');
  assert.ok(existsSync(fx.lockFile()), 'the stopped driver still holds the run lock');
  const before = readFileSync(fx.stateFile());

  const frozen = sweepCli(fx);
  assert.equal(frozen.status, 0, `the sweep never waits on the held lock: ${frozen.stderr}`);
  assert.equal(frozen.out.measurement, 'unqualified');
  assert.deepEqual(frozen.out.swept.map(r => r.action), ['none']);
  assert.equal(existsSync(sweepFile(fx)), false, 'without the opt-in the sweep writes nothing at all');

  const out = await sweepUntil(fx, a.attempt_id, 'killed');
  assert.equal(out.out?.swept?.[0]?.action, 'killed', `HAZARD: a stopped driver holding the lock blocked the independent sweep (${out.stderr})`);
  assert.equal(out.out.measurement, 'unqualified_opt_in');
  assert.equal(out.out.settlement, 'deferred', 'the live driver holds the lock: settlement is left to it');
  // the killed leader stays a zombie until its (stopped) parent reaps it: nothing of the group RUNS any more
  assert.ok(await waitUntil(() => !groupRunning(a.pgid), 10000), 'the expired worker group was killed by a process other than its launcher');
  assert.ok(psState(driver.pid)?.startsWith('T'), 'the driver was still stopped when its worker was bounded');
  assert.deepEqual(readFileSync(fx.stateFile()), before, 'the lock-free sweep wrote nothing to the driver state');
  const receipt = sweepLines(fx).find(l => l.type === 'signal');
  assert.equal(receipt?.attempt_id, a.attempt_id);
  assert.ok(receipt.charged_ms >= 4000);

  driver.kill('SIGCONT');
  const end = await exited;
  assert.equal(end.signal, null, 'the resumed driver exits by itself');
  const b = attemptOf(fx, a.attempt_id);
  assert.equal(b.status, 'timed_out', 'the resumed driver settles it as a timeout, never a crash/re-queue');
  assert.equal(b.quiesced, true);
  assert.equal(fx.readState().nodes.a.state, 'failed');
  assert.equal(fx.runs('a').length, 1, 'never re-dispatched');
});

test('P1 N1: kill -9 driver + hung worker: the opt-in CLI sweep (real clock) kills it after its persisted deadline and settles it timed_out; resume never re-dispatches it', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { timeoutMs: 2000 });
  const out = await sweepUntil(fx, a.attempt_id, 'killed');
  assert.equal(out.out?.swept?.[0]?.action, 'killed', 'HAZARD: nothing bounded the hung worker after kill -9 of its driver');
  assert.equal(out.out.settlement, 'settled', 'no live driver: the sweep settles under the lock itself');
  assert.equal(groupAlive(a.pgid), false);
  const b = attemptOf(fx, a.attempt_id);
  assert.equal(b.status, 'timed_out');
  assert.equal(b.deadline.timed_out.signalled, true);
  cli(fx, 'resume');
  assert.equal(fx.readState().nodes.a.state, 'failed');
  assert.equal(fx.runs('a').length, 1, 'never re-dispatched');
});

// ---------------------------------------------------------------- no signal to an unverified identity (N3 on production paths)

test('P1 N3: an expired attempt with an unknown identity (null leader_start) is never signalled by the opt-in sweep: unknown, lock kept, no receipt', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { timeoutMs: 1000, resources: ['db:main'] });
  fx.editState((s) => { s.attempts.find(x => x.attempt_id === a.attempt_id).leader_start = null; });
  const out = await sweepUntil(fx, a.attempt_id, 'no_signal');
  assert.equal(out.out?.swept?.[0]?.action, 'no_signal');
  assert.ok(groupAlive(a.pgid), 'no signal reached the unverified group');
  assert.equal(sweepLines(fx).some(l => l.type === 'signal'), false, 'no signal receipt');
  const s = fx.readState(), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
  assert.equal(b.status, 'unknown');
  assert.equal(s.locks['db:main'], a.attempt_id, 'capacity stays charged');
  assert.ok(codes(s).includes('quiescence_unknown'));
});

test('P1 PID reuse: the recorded pgid now names an unrelated live process group (another start time): the opt-in sweep never signals it', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { timeoutMs: 1000 });
  killQuietly(a.pgid);
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 5000));
  // an unrelated process that leads its own group: the "reused" pgid. `ps lstart` has one-second resolution, so it must start
  // in a later second than the recorded leader (a reuse within the same second is indistinguishable: an S1 limit)
  assert.ok(await waitUntil(() => processInfo(process.pid).startTime !== null && new Date().getSeconds() !== new Date(a.started_at).getSeconds()
    && Date.now() - Date.parse(a.started_at) > 1500, 10000));
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => killQuietly(other.pid));
  assert.ok(await waitUntil(() => processInfo(other.pid).startTime !== null, 5000));
  assert.notEqual(processInfo(other.pid).startTime, a.leader_start);
  fx.editState((s) => { Object.assign(s.attempts.find(x => x.attempt_id === a.attempt_id), { pid: other.pid, pgid: other.pid }); });
  const out = await sweepUntil(fx, a.attempt_id, 'no_signal');
  assert.equal(out.out?.swept?.[0]?.identity, 'unknown');
  assert.ok(groupAlive(other.pid), 'the unrelated group was never signalled');
  assert.equal(sweepLines(fx).some(l => l.type === 'signal'), false);
});

// ---------------------------------------------------------------- FU-2: the deadline wins over a late envelope (positions SIMULATED)

for (const [name, driverEnv, offsetMs, expect] of [
  ['opt-in, envelope positioned past the deadline: the timeout wins (late_envelope kept as evidence)', OPT_IN, 600001, 'timed_out'],
  ['opt-in, envelope positioned before the deadline: it is the result', OPT_IN, 1000, 'done'],
  ['no opt-in (frozen): a late envelope is recorded as before', {}, 600001, 'done'],
]) {
  test(`FU-2 (SIMULATED envelope position via mono_ns) ${name}`, { skip: SKIP }, async (t) => {
    const { fx, a } = await orphanedHang(t, { timeoutMs: 600000, driverEnv });
    assert.equal(a.deadline.enforcement, driverEnv === OPT_IN ? 'unqualified_opt_in' : undefined);
    killQuietly(a.pgid);
    assert.ok(await waitUntil(() => !groupAlive(a.pgid), 5000));
    writeFileSync(a.out_file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file, mono_ns: String(BigInt(a.deadline.start_ns) + BigInt(offsetMs) * 1000000n) }));
    cli(fx, 'resume');
    const b = attemptOf(fx, a.attempt_id), node = fx.readState().nodes.a;
    if (expect === 'timed_out') {
      assert.equal(b.status, 'timed_out');
      assert.equal(node.state, 'failed');
      assert.equal(b.late_envelope?.position_ms, offsetMs);
      assert.equal(b.envelope, undefined, 'never recorded as the result');
    } else {
      assert.equal(node.state, 'done');
      assert.equal(b.envelope?.exit_code, 0);
    }
  });
}

test('a durable worker launched under the opt-in stamps its envelope with the monotonic clock (mono_ns past the deadline origin); without it (durable or legacy) the envelope is unchanged', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: {} });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(cli(fx, 'drive', {}, OPT_IN).status, 0);
  const a = fx.readState().attempts[0];
  assert.equal(a.deadline.enforcement, 'unqualified_opt_in');
  assert.match(a.envelope.mono_ns, /^\d+$/);
  assert.ok(BigInt(a.envelope.mono_ns) > BigInt(a.deadline.start_ns));
  for (const config of [{}, { durableRun: false }]) {
    const plain = fixture(t, { config });
    assert.equal(plain.cli('init', { dag: plain.dagFile }).status, 0);
    assert.equal(plain.cli('drive').status, 0);
    assert.equal(Object.hasOwn(plain.readState().attempts[0].envelope, 'mono_ns'), false, `no stamp without the opt-in (${JSON.stringify(config)})`);
  }
});

test('P1 owned path: a live driver (no opt-in, its own timer far away) whose worker a separate sweep killed settles it timed_out from the receipt', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: { timeoutMs: 600000 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }], behaviour: { a: { hang: true } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const { a, exited } = await driveUntilRunning(t, fx);
  const { testClock } = await import('./lib/deadline.mjs');
  const { reconcileDeadlines } = await import('./run-engine.mjs');
  const r = await reconcileDeadlines(fx.ctx({ deadlineClock: testClock({ bootId: a.deadline.boot_id, nowNs: () => BigInt(a.deadline.start_ns) + 600001n * 1000000n }) }));
  assert.equal(r.swept[0].action, 'killed');
  // the driver holds the lock for its whole command (deferred), or has already settled and exited by the time the one lock
  // attempt is made (then the sweep finds the attempt settled by the driver and changes nothing)
  assert.ok(['deferred', 'settled'].includes(r.settlement), r.settlement);
  const end = await exited;
  assert.equal(end.code, 2, 'the driver ends on the failed node (judgment point)');
  const b = attemptOf(fx, a.attempt_id);
  assert.equal(b.status, 'timed_out', 'the launcher\'s own settle derived the timeout from the receipt (its timer never fired)');
  assert.equal(b.deadline.timed_out.signalled, true);
  assert.equal(fx.runs('a').length, 1);
});

test('P1 mixed opt-in: a sweep kill deferred to a driver that then dies; resume WITHOUT the opt-in still settles timed_out, never re-queues', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: { timeoutMs: 600000 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }], behaviour: { a: { hang: true } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const { driver, a, exited } = await driveUntilRunning(t, fx);
  driver.kill('SIGSTOP');
  const { testClock } = await import('./lib/deadline.mjs');
  const { reconcileDeadlines } = await import('./run-engine.mjs');
  const r = await reconcileDeadlines(fx.ctx({ deadlineClock: testClock({ bootId: a.deadline.boot_id, nowNs: () => BigInt(a.deadline.start_ns) + 600001n * 1000000n }) }));
  assert.equal(r.settlement, 'deferred');
  driver.kill('SIGKILL');
  await exited;
  cli(fx, 'resume'); // no opt-in in this process
  const b = attemptOf(fx, a.attempt_id);
  assert.equal(b.status, 'timed_out');
  assert.equal(fx.readState().nodes.a.state, 'failed');
  assert.equal(fx.runs('a').length, 1, 'never re-dispatched');
});

// ---------------------------------------------------------------- FU-1: a boot-ended attempt never waits on a live pgid number

test('FU-1 (SIMULATED reboot: another boot id) a boot-ended worker with no envelope whose pgid number is alive is settled, not left live', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { timeoutMs: 600000 });
  const { testClock } = await import('./lib/deadline.mjs');
  const { reconcileDeadlines } = await import('./run-engine.mjs');
  const r = await reconcileDeadlines(fx.ctx({ deadlineClock: testClock({ bootId: 'another-boot', nowNs: () => 5n }) }));
  assert.equal(r.swept[0].identity, 'gone_by_boot');
  assert.ok(groupAlive(a.pgid), 'the pgid number (alive "after the reboot") was neither probed nor signalled');
  const b = attemptOf(fx, a.attempt_id);
  assert.equal(b.quiesced, true, 'settled by boot identity, not left live');
  assert.notEqual(b.status, 'launched');
});

// ---------------------------------------------------------------- monotonic grace (wall-clock steps SIMULATED by patching Date.now)

for (const [dir, step] of [['forward', 3600000], ['backward', -3600000]]) {
  test(`killGroup (SIMULATED ${dir} wall-clock step of 1 h during the grace): SIGKILL follows SIGTERM after the monotonic grace, neither cut short nor delayed`, { skip: SKIP }, async (t) => {
    const { killGroup } = await import('./engine-quiesce.mjs');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    t.after(() => killQuietly(child.pid));
    await new Promise(r => child.stdout.once('data', r));
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => realNow() + (++calls > 1 ? step : 0); // the wall clock steps right after the first reading
    t.after(() => { Date.now = realNow; });
    const t0 = performance.now();
    const res = await Promise.race([killGroup(child.pid, groupAlive), new Promise(r => setTimeout(() => r('stuck'), 12000))]);
    const took = performance.now() - t0;
    Date.now = realNow;
    assert.notEqual(res, 'stuck', 'a backward wall-clock step delayed the SIGKILL');
    assert.equal(res, false, 'the group is gone');
    assert.ok(took >= 2900, `the SIGTERM grace was cut short by a forward step (${Math.round(took)} ms)`);
  });
}

// ---------------------------------------------------------------- runner settlement after a sweep kill

test('a sealed runner killed by the sweep (SIMULATED: its receipt is appended by the test, not a sweep) is a timeout, never runner_output_tampered', { skip: SKIP }, async (t) => {
  const io = await import('./engine-io.mjs');
  const { appendSweep } = await import('./lib/deadline.mjs');
  const fx = fixture(t, { config: {} });
  const dir = join(fx.root, 'attempts');
  const run = io.gateRunner({ repoRoot: fx.repo, dir, platform: process.platform, env: process.env,
    toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: (g) => io.groupAlive(g) });
  const launch = await run({ attempt_id: 'att-r1', command: { cmd: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, timeoutMs: 600000 });
  t.after(() => killQuietly(launch.pgid));
  launch.release();
  appendSweep(dir, { type: 'signal', attempt_id: 'att-r1', pgid: launch.pgid, leader_start: null, start_ns: '0', limit_ms: 1, charged_ms: 2 });
  killQuietly(launch.pgid);
  const result = await launch.done;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

// ---------------------------------------------------------------- the sweep concurrent with a settling driver

test('sweeps running concurrently with a live driver that settles the SAME EXPIRED attempt (and two normal nodes) never lose a driver update: the hung node ends timed_out once, the others done', { skip: SKIP }, async (t) => {
  const behaviour = { a: { ...STAGED_BEHAVIOUR.a, delayMs: 300 }, b: { ...STAGED_BEHAVIOUR.b, delayMs: 300 }, c: { hang: true } };
  const fx = fixture(t, { config: { timeoutMs: 4000 }, nodes: STAGED, behaviour });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const driver = spawn(process.execPath, [ENGINE_CLI, 'drive', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'], { env: { ...fx.env, ...OPT_IN }, stdio: 'ignore' });
  t.after(() => { try { driver.kill('SIGKILL'); } catch { /* gone */ } });
  let done = false, sweeps = 0;
  const exited = new Promise(r => driver.on('exit', (code) => { done = true; r(code); }));
  while (!done) {
    await new Promise(r => setTimeout(r, 20)); // yield, so the driver's exit event can be seen
    if (done) break;
    const r = sweepCli(fx, OPT_IN);
    assert.equal(r.status, 0, `the lock-free sweep reads the atomically published state at any moment: ${r.stderr}`);
    sweeps++;
  }
  await exited;
  assert.ok(sweeps > 0, 'sweeps ran while the driver was live');
  const s = fx.readState();
  assert.deepEqual(Object.fromEntries(Object.entries(s.nodes).map(([id, n]) => [id, n.state])), { a: 'done', b: 'done', c: 'failed' });
  const c = s.attempts.filter(x => x.node === 'c');
  assert.equal(c.length, 1, 'the expired attempt was dispatched once');
  assert.equal(c[0].status, 'timed_out');
  assert.equal(c[0].quiesced, true);
  assert.ok(s.attempts.filter(x => x.node !== 'c').every(x => x.status === 'exited' && x.quiesced === true), 'no driver update was lost');
  assert.equal(fx.runs('c').length, 1);
});

// ---------------------------------------------------------------- review round 1 (REVIEW-PR1b-OPUS M1, Codex MAJOR 1-4, m1/m4/m7)

/** A sweep receipt for attempt `a` as phase A writes it (SIMULATED when a test appends it by hand). */
const receiptFor = (a, extra = {}) => ({ type: 'signal', attempt_id: a.attempt_id, pgid: a.pgid, leader_start: a.leader_start ?? null,
  start_ns: a.deadline.start_ns, limit_ms: a.deadline.limit_ms, charged_ms: a.deadline.limit_ms + 1, ...extra });
const okOut = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });

for (const [name, driverEnv, sweepEnv] of [
  ['mixed opt-in (sweep only)', {}, OPT_IN], ['full opt-in (driver and sweep)', OPT_IN, OPT_IN], ['control: no opt-in anywhere', {}, {}]]) {
  test(`M1 ${name}: a worker that finished BEFORE its deadline while its stopped driver leaves the launcher a zombie ends done, never timed_out; no receipt, no signal`, { skip: SKIP }, async (t) => {
    const fx = fixture(t, { config: { timeoutMs: 5000 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }], behaviour: { a: { ...STAGED_BEHAVIOUR.a, delayMs: 1000 } } });
    assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
    const { driver, a, exited } = await driveUntilRunning(t, fx, driverEnv);
    driver.kill('SIGSTOP');
    assert.ok(await waitUntil(() => existsSync(a.envelope_file), 15000), 'the worker finished and its launcher wrote the envelope');
    assert.ok(await waitUntil(() => psState(a.pgid)?.startsWith('Z'), 10000), 'precondition: the finished launcher is a zombie of the stopped driver');
    // sweep until well past the deadline (real clock)
    await waitUntil(() => { const r = sweepCli(fx, sweepEnv); return (r.out?.swept?.[0]?.charged_ms ?? 0) > 5200 || (sweepEnv !== OPT_IN && Date.now() - Date.parse(a.started_at) > 5500); }, 30000);
    assert.equal(sweepLines(fx).some(l => l.type === 'signal'), false, 'no receipt for an attempt whose envelope already exists');
    driver.kill('SIGCONT');
    await exited;
    const b = attemptOf(fx, a.attempt_id);
    assert.equal(fx.readState().nodes.a.state, 'done', `HAZARD: a completed on-time worker was settled ${b.status}`);
    assert.equal(b.status, 'exited');
  });
}

for (const [name, extra, expect] of [
  ['receipt recorded the envelope ABSENT past the limit (envelope_present:false), then an unstamped success envelope appears: late, timed_out', { envelope_present: false }, 'timed_out'],
  ['receipt WITHOUT the absence field (envelope not proven absent), unstamped envelope: frozen rule, recorded', {}, 'done'],
]) {
  test(`M1 mirror (SIMULATED receipt) ${name}`, { skip: SKIP }, async (t) => {
    const { fx, a } = await orphanedHang(t, { timeoutMs: 600000 });
    const { appendSweep } = await import('./lib/deadline.mjs');
    appendSweep(fx.attemptsDir(), receiptFor(a, extra));
    killQuietly(a.pgid);
    assert.ok(await waitUntil(() => !groupAlive(a.pgid), 5000));
    writeFileSync(a.out_file, okOut);
    writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file }));
    cli(fx, 'resume');
    const b = attemptOf(fx, a.attempt_id);
    if (expect === 'timed_out') { assert.equal(b.status, 'timed_out'); assert.equal(b.late_envelope?.exit_code, 0); assert.equal(fx.readState().nodes.a.state, 'failed'); }
    else { assert.equal(fx.readState().nodes.a.state, 'done'); assert.equal(b.status, 'exited'); }
  });
}

test('Codex 3 (SIMULATED interleave: the receipt is appended by an injected liveness probe DURING retirement): settle re-reads the evidence before deciding; a late unstamped success envelope of a worker launched without the opt-in is a timeout, not accepted', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { timeoutMs: 600000 });
  const { appendSweep } = await import('./lib/deadline.mjs');
  killQuietly(a.pgid);
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 5000));
  writeFileSync(a.out_file, okOut);
  writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file }));
  let appended = false;
  const { resume } = await import('./run-engine.mjs');
  await resume(fx.ctx({ groupAlive: (pgid) => {
    if (!appended && pgid === a.pgid) { appended = true; appendSweep(fx.attemptsDir(), receiptFor(a, { envelope_present: false })); }
    return groupAlive(pgid);
  } }));
  assert.ok(appended, 'the probe ran during settlement');
  const b = attemptOf(fx, a.attempt_id);
  assert.equal(b.status, 'timed_out', 'the receipt appended during retirement was not re-read');
});

test('Codex 1: killGroup re-verifies the identity immediately before EACH signal: an identity that flips after SIGTERM gets no SIGKILL', { skip: SKIP }, async (t) => {
  const { killGroup } = await import('./engine-quiesce.mjs');
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => killQuietly(child.pid));
  await new Promise(r => child.stdout.once('data', r));
  let checks = 0;
  const res = await killGroup(child.pid, groupAlive, { verify: () => ++checks === 1, graceMs: 300 });
  assert.ok(checks >= 2, 'the identity was re-checked before the second signal');
  assert.equal(res, null, 'unverified, still alive: unknown, nothing proven');
  assert.ok(groupAlive(child.pid), 'HAZARD: SIGKILL reached a group whose identity was no longer verified');
});

for (const [name, stamped, startOffsetMs, limitMs, expect] of [
  ['unstamped frame after a receipt that recorded it absent: timeout', false, 0, 1, 'timeout'],
  ['stamped frame positioned before the receipt\'s limit: accepted', true, 0, 600000, 'accepted'],
  ['stamped frame positioned after the receipt\'s limit: timeout', true, -10000, 1, 'timeout'],
]) {
  test(`Codex 4 (SIMULATED receipt: the sweep "crashed" after its receipt, before any signal): a sealed runner whose frame AGREES and succeeds — ${name}`, { skip: SKIP }, async (t) => {
    const io = await import('./engine-io.mjs');
    const { appendSweep } = await import('./lib/deadline.mjs');
    const fx = fixture(t, { config: {} });
    const dir = join(fx.root, 'attempts');
    const run = io.gateRunner({ repoRoot: fx.repo, dir, platform: process.platform, env: { ...process.env, ...(stamped ? OPT_IN : {}) },
      toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: (g) => io.groupAlive(g) });
    const start = process.hrtime.bigint() + BigInt(startOffsetMs) * 1000000n;
    const launch = await run({ attempt_id: 'att-r2', command: { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 300)'] }, timeoutMs: 600000 });
    t.after(() => killQuietly(launch.pgid));
    appendSweep(dir, { type: 'signal', attempt_id: 'att-r2', pgid: launch.pgid, leader_start: null, start_ns: String(start), limit_ms: limitMs, charged_ms: limitMs + 1, envelope_present: false });
    launch.release();
    const result = await launch.done;
    if (expect === 'timeout') { assert.equal(result.timedOut, true, 'HAZARD: a successful frame after a recorded expiry was accepted'); assert.equal(result.exitCode, null); }
    else { assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0); }
  });
}

test('m7: a group verified at the first read and provably gone at the re-check is classified gone (nothing invented), never unknown/quiescence_unknown', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t, { timeoutMs: 600000, resources: ['db:main'] });
  const { testClock } = await import('./lib/deadline.mjs');
  const { reconcileDeadlines } = await import('./run-engine.mjs');
  let calls = 0;
  const r = await reconcileDeadlines(fx.ctx({ deadlineClock: testClock({ bootId: a.deadline.boot_id, nowNs: () => BigInt(a.deadline.start_ns) + 600001n * 1000000n }),
    groupAlive: (pgid) => { if (++calls === 2) { killQuietly(pgid); return false; } return groupAlive(pgid); } }));
  assert.equal(r.swept[0].identity, 'gone');
  const s = fx.readState();
  assert.notEqual(s.attempts.find(x => x.attempt_id === a.attempt_id).status, 'unknown');
  assert.equal(codes(s).includes('quiescence_unknown'), false);
});

test('m4: an attempt that already has a receipt for this expiry is not re-receipted or re-waited by every later sweep', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: { timeoutMs: 2000 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }], behaviour: { a: { hang: true } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const { driver, a } = await driveUntilRunning(t, fx);
  driver.kill('SIGSTOP');
  await sweepUntil(fx, a.attempt_id, 'killed');
  const receipts = () => sweepLines(fx).filter(l => l.type === 'signal').length;
  assert.equal(receipts(), 1);
  const t0 = performance.now();
  const again = sweepCli(fx, OPT_IN);
  assert.equal(again.status, 0);
  assert.equal(receipts(), 1, 'no second receipt');
  assert.ok(performance.now() - t0 < 2500, 'no second kill grace on the zombie');
});

