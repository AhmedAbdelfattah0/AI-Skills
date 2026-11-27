/**
 * S1 (P1 durable substrate): the five §8 P1 negatives plus their guards.
 *
 *   N1 kill -9 of the driving engine while a fake worker hangs: the deadline sweep (`reconcile --deadlines`, an enforcer
 *      that is not the attempt's launcher) kills the group after its persisted deadline and records `timed_out`.
 *   N2 90% of the deadline consumed across repeated enforcer outages, restarts and a host sleep (all on an injected
 *      monotonic clock), with the wall clock stepped -1 h and +1 h in between: the charge never decreases, never drops an
 *      outage, ignores the wall clock, and the deadline fires at the first observation past it.
 *   N3 a null or mismatched `leader_start`: the sweep sends NO signal, records `unknown` and keeps the attempt's locks.
 *   N4 a recoverer killed (-9) inside the recovery-marker window, leaving a stale lock and its marker: the next acquire
 *      recovers. Plus: of N processes racing over that stale lock and marker, exactly one wins.
 *   N5 `git worktree remove` of the worktree a durable run was started in: the engine state is intact (common dir).
 *
 * Measurement is UNQUALIFIED (lib/deadline.mjs MEASUREMENT_QUALIFIED false): N1-N3 inject the clock in-process
 * (`ctx.deadlineClock`); the CLI sweep measures nothing and signals nothing (pinned below). Timing never depends on sleeps:
 * the clock is injected and process handshakes are polled with waitUntil. Temp repos only; no Docker, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, POSIX, waitUntil, codes } from './engine-test-fixture.mjs';
import { acquireLock } from './lib/durable-io.mjs';
import { processInfo } from './engine-quiesce.mjs';

const SKIP = POSIX ? false : 'POSIX process groups (Windows quiescence is unknown, known limit D4)';
const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const DURABLE_IO = fileURLToPath(new URL('./lib/durable-io.mjs', import.meta.url));
const DURABLE = { durableRun: { version: 1 } };
const LIMIT_MS = 600000; // the run timeout: the driver's own in-process timer never fires inside a test

const durableState = (repo) => join(repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'state.json');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killQuietly = (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
/** The engine module, loaded dynamically so this file also runs (RED) against an engine without the S1 exports. */
const engine = () => import('./run-engine.mjs');

/** An injected clock on the attempt's boot: `at(ms)` sets the monotonic reading to the attempt's start plus `ms`. */
function clockFor(a) {
  let off = 0n;
  const start = BigInt(a.deadline?.start_ns ?? '0');
  return { bootId: a.deadline?.boot_id ?? 'boot', nowNs: () => start + off, at(ms) { off = BigInt(ms) * 1000000n; return this; },
    raw(ns) { off = ns - start; return this; } };
}

/**
 * A durable run whose node `a` hangs, driven by a real `run-engine.mjs drive` child that is then killed with SIGKILL once
 * the attempt is launched: the worker group outlives its driver. Returns { fx, a } (the launched attempt on disk).
 */
async function orphanedHang(t, { resources = [] } = {}) {
  const fx = fixture(t, { config: { ...DURABLE, timeoutMs: LIMIT_MS }, nodes: [{ id: 'a', writes: ['src/a.txt'], resources }], behaviour: { a: { hang: true } } });
  const init = fx.cli('init', { dag: fx.dagFile });
  assert.equal(init.status, 0, `init of a durable run: ${init.stderr}`);
  const driver = spawn(process.execPath, [ENGINE_CLI, 'drive', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'], { env: fx.env, stdio: 'ignore' });
  const gone = new Promise(r => driver.on('exit', r));
  const launched = () => { try { return readJson(durableState(fx.repo)).attempts.find(x => x.status === 'launched' && x.pgid && x.leader_start); } catch { return undefined; } };
  // 'launched' is committed BEFORE the release byte: wait until the worker really runs (it logs its node), so killing the
  // driver cannot close the launcher's stdin before the release and end the group by itself.
  assert.ok(await waitUntil(() => launched() && fx.runs('a').length > 0, 30000), 'the driver launched and released the hanging worker');
  const a = launched();
  t.after(() => killQuietly(a.pgid));
  driver.kill('SIGKILL');
  await gone;
  assert.ok(groupAlive(a.pgid), 'the worker group outlives its SIGKILLed driver');
  return { fx, a };
}

test('N1 kill -9 driver + hung worker: the deadline sweep kills the group after its persisted deadline and records timed_out', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  assert.ok(a.deadline && a.deadline.limit_ms === LIMIT_MS, 'the launched attempt carries a persisted deadline');
  const { reconcileDeadlines } = await engine();
  const clock = clockFor(a);
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: clock.at(LIMIT_MS - 1) }));
  assert.ok(groupAlive(a.pgid), 'before its deadline the worker is not signalled');
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: clock.at(LIMIT_MS + 1) }));
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 10000), 'the sweep killed the worker group after the deadline');
  const s = readJson(durableState(fx.repo)), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
  assert.equal(b.status, 'timed_out');
  assert.equal(b.quiesced, true);
  assert.equal(b.deadline.timed_out.signalled, true);
  assert.equal(s.nodes.a.state, 'failed');
});

test('N2 90% consumed across repeated enforcer outages, restarts, a sleep and wall-clock steps: consumed execution never disappears, the deadline fires once past it', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const { reconcileDeadlines } = await engine();
  const clock = clockFor(a);
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const charged = () => readJson(durableState(fx.repo)).attempts.find(x => x.attempt_id === a.attempt_id).deadline?.charged_ms;
  // Each sweep is a fresh enforcer invocation (a restart); the gaps between them are outages; 0.40 -> 0.55 is a host sleep
  // on a clock that counts sleep (darwin uv_hrtime): it is charged, conservatively. The wall clock is stepped -1 h / +1 h.
  const marks = [0.10, 0.25, 0.40, 0.55, 0.70, 0.90];
  const steps = [0, -3600000, 3600000, -3600000, 3600000, 0];
  let last = -1;
  for (const [i, f] of marks.entries()) {
    Date.now = () => realNow() + steps[i];
    await reconcileDeadlines?.(fx.ctx({ deadlineClock: clock.at(Math.round(LIMIT_MS * f)) }));
    const c = charged();
    assert.equal(c, Math.round(LIMIT_MS * f), `the charge at ${f} is the full monotonic elapsed time (no outage dropped or capped, wall clock ignored)`);
    assert.ok(c > last, 'the charge never decreases');
    last = c;
    assert.ok(groupAlive(a.pgid), `below the deadline (${f}) the worker is not signalled`);
  }
  // A reading that went backwards (a misbehaving source) can never reduce a recorded charge.
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: clock.at(Math.round(LIMIT_MS * 0.5)) }));
  assert.equal(charged(), Math.round(LIMIT_MS * 0.9), 'consumed execution never disappears');
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: clock.at(LIMIT_MS) }));
  assert.ok(await waitUntil(() => !groupAlive(a.pgid), 10000), 'the first observation at the deadline kills the group');
  assert.equal(readJson(durableState(fx.repo)).attempts.find(x => x.attempt_id === a.attempt_id).status, 'timed_out');
});

for (const [name, edit] of [['null', (b) => { b.leader_start = null; }], ['mismatched (a reused pid)', (b) => { b.leader_start = 'Thu Jan  1 00:00:00 1970'; }]]) {
  test(`N3 ${name} leader_start: the expired deadline sends no signal, the attempt is unknown and its slot stays charged`, { skip: SKIP }, async (t) => {
    const { fx, a } = await orphanedHang(t, { resources: ['db:main'] });
    const file = durableState(fx.repo);
    const s0 = readJson(file);
    edit(s0.attempts.find(x => x.attempt_id === a.attempt_id));
    writeFileSync(file, JSON.stringify(s0));
    const { reconcileDeadlines } = await engine();
    await reconcileDeadlines?.(fx.ctx({ deadlineClock: clockFor(a).at(LIMIT_MS * 2) }));
    assert.ok(groupAlive(a.pgid), 'no signal reached the unverified group');
    const s = readJson(file), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
    assert.equal(b.status, 'unknown');
    assert.notEqual(b.quiesced, true);
    assert.equal(s.locks['db:main'], a.attempt_id, 'the attempt keeps its resource lock (capacity stays charged)');
    assert.ok(codes(s).includes('quiescence_unknown'));
  });
}

test('N3 (E8) resume of a durable run never signals a live leader whose start time was not recorded', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const file = durableState(fx.repo);
  const s0 = readJson(file);
  s0.attempts.find(x => x.attempt_id === a.attempt_id).leader_start = null;
  writeFileSync(file, JSON.stringify(s0));
  writeFileSync(a.envelope_file, JSON.stringify({ exit_code: 0, stdout_file: a.out_file })); // settle would now retire it
  const r = fx.cli('resume');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(groupAlive(a.pgid), 'no signal reached the unverified group');
  assert.equal(readJson(file).attempts.find(x => x.attempt_id === a.attempt_id).status, 'unknown');
});

test('the CLI sweep is unqualified: it measures nothing, signals nothing, and records the attempt as unmeasured', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const r = fx.cli('reconcile', { deadlines: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.measurement, 'unqualified');
  assert.deepEqual(r.out.swept.map(x => [x.attempt_id, x.action, x.reason]), [[a.attempt_id, 'none', 'measurement_unqualified']]);
  assert.ok(groupAlive(a.pgid));
  const b = readJson(durableState(fx.repo)).attempts.find(x => x.attempt_id === a.attempt_id);
  assert.equal(b.status, 'launched');
  assert.deepEqual(b.deadline.last_sweep, { measured: false, reason: 'measurement_unqualified', identity: 'verified' });
  assert.equal(b.deadline.measurement, 'unqualified');
});

test('a reboot (another boot id) settles the attempt by boot identity without probing or signalling its pgid, and records the unmeasured interval', { skip: SKIP }, async (t) => {
  const { fx, a } = await orphanedHang(t);
  const { reconcileDeadlines } = await engine();
  const clock = clockFor(a);
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: clock.at(1000) }));
  await reconcileDeadlines?.(fx.ctx({ deadlineClock: { bootId: 'another-boot', nowNs: () => 5n } }));
  assert.ok(groupAlive(a.pgid), 'the (here still running) group was not signalled: after a reboot its pgid may be anyone');
  const s = readJson(durableState(fx.repo)), b = s.attempts.find(x => x.attempt_id === a.attempt_id);
  assert.equal(b.status, 'crashed');
  assert.equal(b.quiesced, true);
  assert.equal(b.deadline.charged_ms, 1000, 'the last measured charge is kept as a lower bound');
  assert.deepEqual(b.deadline.unmeasured, [{ reason: 'boot_changed', after_ms: 1000, to_boot: 'another-boot' }]);
});

test('a legacy run (no config.durableRun) keeps its per-worktree placement, records no deadline, and the sweep refuses it', { skip: SKIP }, async (t) => {
  const fx = fixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.ok(existsSync(fx.stateFile()), 'legacy state at git-path ai-skills/ship-ticket/T-1.state.json');
  assert.equal(existsSync(durableState(fx.repo)), false);
  assert.equal(fx.readState().attempts[0].deadline, undefined);
  const r = fx.cli('reconcile', { deadlines: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deadlines_unsupported/);
});

test('both placements present for one ticket: every command refuses (state_placement_ambiguous)', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: DURABLE });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  mkdirSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket'), { recursive: true });
  copyFileSync(durableState(fx.repo), fx.stateFile());
  const r = fx.cli('status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /state_placement_ambiguous/);
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

test('N4 race: of 6 processes recovering one stale lock under one stale marker at once, exactly one holds the lock', { skip: SKIP }, async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'lock'), go = join(dir, 'go');
  const dead = await deadProcess();
  writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), run_id: 'old', nonce: 'held' }));
  writeFileSync(lockFile + '.recovery', JSON.stringify({ pid: dead.pid, process_start_time: dead.startTime, host: hostname(), nonce: 'stale' }));
  const src = `import { acquireLock } from ${JSON.stringify(DURABLE_IO)};
import { existsSync } from 'node:fs';
while (!existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 1));
try { await acquireLock({ lockFile: ${JSON.stringify(lockFile)}, runId: 'race' }); process.stdout.write('won'); }
catch (e) { process.stdout.write('lost:' + e.code); }
setTimeout(() => {}, 1500); // hold, without releasing, until every contender has decided`;
  const kids = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] }));
  const outs = kids.map(k => new Promise(r => { let o = ''; k.stdout.on('data', d => { o += d; }); k.on('exit', () => r(o)); }));
  writeFileSync(go, '');
  const results = await Promise.all(outs);
  assert.equal(results.filter(o => o === 'won').length, 1, `exactly one winner: ${results.join(' ')}`);
  assert.ok(results.filter(o => o !== 'won').every(o => o === 'lost:lock_held'), results.join(' '));
  assert.ok(!existsSync(lockFile + '.recovery'), 'no marker is left once the recovery is done');
});

// ---------------------------------------------------------------- N5: worktree removal

test('N5 git worktree remove of the worktree a durable run ran in: engine state intact in the common dir, none under .git/worktrees', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: DURABLE, commit: true });
  const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const wt = join(fx.root, 'wt');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  mkdirSync(join(wt, '.specs', 'plans'), { recursive: true });
  copyFileSync(fx.planFile, join(wt, '.specs', 'plans', 'T-1.md'));
  const cli = (cmd, flags = {}) => spawnSync(process.execPath, [ENGINE_CLI, cmd, '--repo', wt, '--ticket', 'T-1', '--run-id', 'run-1',
    ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  assert.equal(cli('init', { dag: fx.dagFile }).status, 0);
  const drove = cli('drive');
  assert.equal(drove.status, 0, drove.stderr);
  const before = readFileSync(durableState(fx.repo), 'utf8');
  git(fx.repo, 'worktree', 'remove', '--force', wt);
  assert.equal(existsSync(wt), false);
  assert.ok(existsSync(durableState(fx.repo)), 'the state survived the removal');
  assert.equal(readFileSync(durableState(fx.repo), 'utf8'), before, 'byte for byte');
  const s = JSON.parse(before);
  assert.equal(s.nodes.a.state, 'done');
  assert.ok(s.attempts.length === 1 && s.attempts[0].deadline, 'the attempt record (with its deadline) is intact');
  assert.ok(existsSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'attempts', `${s.attempts[0].attempt_id}.out`)), 'the worker output too');
  const wts = join(fx.repo, '.git', 'worktrees');
  const under = existsSync(wts) ? readdirSync(wts, { recursive: true }).filter(p => String(p).includes('ai-skills')) : [];
  assert.deepEqual(under, [], '0 engine paths under .git/worktrees/');
  // The run can still be archived from the main checkout after its worktree is gone.
  const arch = spawnSync(process.execPath, [ENGINE_CLI, 'archive', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  assert.equal(arch.status, 0, arch.stderr);
  const out = JSON.parse(arch.stdout);
  assert.ok(existsSync(join(out.archive, 'outputs.json')) && existsSync(join(out.archive, 'outputs', 'attempts')), 'referenced outputs archived');
});

test('a durable run refuses mutating commands from another worktree of the repository (worktree_mismatch)', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: DURABLE, commit: true, behaviour: {} });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const wt = join(fx.root, 'wt2');
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', 'other', wt], { cwd: fx.repo }).status, 0);
  mkdirSync(join(wt, '.specs', 'plans'), { recursive: true });
  copyFileSync(fx.planFile, join(wt, '.specs', 'plans', 'T-1.md'));
  const r = spawnSync(process.execPath, [ENGINE_CLI, 'drive', '--repo', wt, '--ticket', 'T-1', '--run-id', 'run-1'], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(JSON.parse(r.stdout).judgments.some(j => j.code === 'worktree_mismatch'));
  assert.deepEqual(fx.runs(), [], 'nothing was dispatched from the other worktree');
});

// ---------------------------------------------------------------- lib/deadline.mjs (pure)

test('deadline record: an unknown boot id measures nothing and says so; a legacy state arms nothing; the mechanism is unqualified', async () => {
  const { armRecord, armAttempt, observe, MEASUREMENT_QUALIFIED } = await import('./lib/deadline.mjs');
  assert.equal(MEASUREMENT_QUALIFIED, false, 'G0 has not passed: the flag stays off');
  const rec = armRecord(1000, { bootId: null, nowNs: () => 0n });
  assert.deepEqual(observe(rec, { bootId: null, nowNs: () => 5000000000n }), { charged_ms: 0, expired: false, boot_ended: false, measured: false });
  assert.deepEqual(rec.unmeasured, [{ reason: 'boot_unknown' }], 'recorded explicitly as unmeasured, never as zero execution');
  const a = { pid: 7 };
  armAttempt({ config: {} }, a, 1000, { bootId: 'b', nowNs: () => 0n });
  assert.equal(a.deadline, undefined, 'a run without config.durableRun records no deadline');
  armAttempt({ config: { durableRun: { version: 1 } } }, a, 1000, { bootId: 'b', nowNs: () => 42n });
  assert.equal(a.deadline.start_ns, '42');
  assert.equal(a.deadline.measurement, 'unqualified');
});
