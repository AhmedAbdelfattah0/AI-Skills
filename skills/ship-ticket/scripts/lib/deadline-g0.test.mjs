/**
 * PR-1a: the two-phase G0 fixtures c (wall clock -1 h / +1 h), d (host sleep) and e (supervisor kill/restart + reboot) of
 * lib/deadline-g0.test-helper.mjs, run phase 1 + phase 2 against a SIMULATED host seam: an injected clock (hr, wall,
 * monotonic), boot identity, host-sleep evidence and a fake worker that writes the ground-truth progress log. No real
 * process, signal, clock step, sleep or reboot happens here (CI-safe on every OS); the real host run is the owner's host
 * window (HOST-WINDOW-RUNBOOK.md). What these tests prove is the fixtures' decision logic: arm persists, phase 2 refuses
 * without phase 1, a skipped host act is NOT_RUN (never PASS), PASS needs the measured ground truth within tolerance, the
 * exit code is non-zero unless all six PASS, and cleanup is bounded and never signals an unverified group.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as G0 from './deadline-g0.test-helper.mjs';

const H = G0.LIMITS.hour_ms;
const TOL = G0.LIMITS.tolerance_ms;

/** A simulated host. `ctl` drives it: run (worker ticks), stepWall, sleepHost, reboot. */
function world(t, { platform = 'darwin', hrFollowsWall = false, sleepCharged = true, immortal = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'g0-unit-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const s = { hr: 5000000000000n, wall: 1795000000000, mono: 0, boot: 'BOOT-1', bootTime: 1794000000000, nextPid: 4000,
    sleep: { sleeptime_s: 1000, waketime_s: 1001, sleep_count: 10 }, workers: new Map(), reused: new Set(), signals: [], probes: 0, killRestart: null };
  const nowNs = () => (hrFollowsWall ? BigInt(s.wall) * 1000000n : s.hr);
  const tickAll = () => {
    for (const w of s.workers.values()) {
      if (!w.alive || w.boot !== s.boot) continue;
      if (existsSync(w.stop) && !immortal) { w.alive = false; continue; }
      appendFileSync(w.log, JSON.stringify({ hr: String(nowNs()), wall: s.wall }) + '\n');
    }
  };
  const advance = (ms) => { for (let left = ms; left > 0; left -= 100) { const d = Math.min(100, left); s.hr += BigInt(d) * 1000000n; s.wall += d; s.mono += d; tickAll(); } };
  const live = (pid) => { const w = s.workers.get(pid); return Boolean(w?.alive && w.boot === s.boot); };
  const host = {
    platform,
    nowNs, wallMs: () => s.wall, monoMs: () => s.mono, wait: async (ms) => advance(ms), bootId: () => s.boot,
    sleepEvidence: () => ({ ...s.sleep }), bootTimeMs: () => s.bootTime,
    async startWorker(dir) {
      const pgid = s.nextPid++;
      const w = { pgid, log: join(dir, 'progress.jsonl'), stop: join(dir, 'stop'), alive: true, boot: s.boot, start: `START-${pgid}` };
      s.workers.set(pgid, w); tickAll();
      return { pgid, log: w.log, stop: w.stop, leader_start: w.start };
    },
    alive: (pid) => { s.probes++; return live(pid) || s.reused.has(pid); },
    info: (pid) => (live(pid) ? { alive: true, startTime: s.workers.get(pid).start } : s.reused.has(pid) ? { alive: true, startTime: 'SOMEONE-ELSE' } : { alive: false, startTime: null }),
    signal: (pgid, sig) => { s.signals.push({ pgid, sig }); const w = s.workers.get(pgid); if (sig === 'SIGKILL' && w && !immortal) w.alive = false; },
    killRestartHalf: async () => s.killRestart ?? { fixture: 'e', half: 'kill_restart', result: 'PASS', true_execution_at_kill_ms: 20200, charged_at_kill_ms: 20180 },
  };
  const ctl = {
    run: advance,
    stall(ms) { s.hr += BigInt(ms) * 1000000n; s.wall += ms; s.mono += ms; }, // no tick, no host sleep evidence

    stepWall: (ms) => { s.wall += ms; },
    sleepHost(ms) { // the whole host is suspended: no tick; wall moves; hr moves only when the clock counts sleep (darwin)
      s.sleep.sleeptime_s = s.wall / 1000;
      if (sleepCharged) s.hr += BigInt(ms) * 1000000n;
      s.wall += ms;
      s.sleep.waketime_s = s.wall / 1000; s.sleep.sleep_count++;
    },
    reboot({ reuse = false } = {}) {
      for (const w of s.workers.values()) w.alive = false;
      s.boot = 'BOOT-2'; s.hr = 7000000000n; s.wall += 90000; s.bootTime = s.wall - 30000;
      if (reuse) for (const pid of s.workers.keys()) s.reused.add(pid);
    },
  };
  return { env: { host, stateDir }, s, ctl };
}
const stateOf = (env, fx) => JSON.parse(readFileSync(join(env.stateDir, fx, 'state.json'), 'utf8'));
/** main() prints JSON lines; capture them so the test output stays readable. */
async function quietMain(args, env) {
  const write = process.stdout.write;
  const lines = [];
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { code: await G0.main(args, env), lines: lines.join('').trim().split('\n').map(l => JSON.parse(l)) }; } finally { process.stdout.write = write; }
}

test('arm persists every phase-2 input under the state dir (default ~/.ai-skills-state/g0, not tmp) and refuses a second arm', async (t) => {
  const saved = process.env.G0_STATE_DIR;
  delete process.env.G0_STATE_DIR;
  try { assert.ok(G0.defaultStateDir().endsWith(join('.ai-skills-state', 'g0')), G0.defaultStateDir()); } finally { if (saved !== undefined) process.env.G0_STATE_DIR = saved; }
  assert.ok(!G0.defaultStateDir().startsWith(tmpdir() + sep) || saved !== undefined, 'the default is not the OS temp dir');
  const { env } = world(t);
  for (const fx of G0.TWO_PHASE) {
    const r = await G0.armFixture(fx, env);
    assert.equal(r.result, 'ARMED', JSON.stringify(r));
    const st = stateOf(env, fx);
    assert.equal(st.schema, G0.G0_SCHEMA);
    assert.equal(st.phase, 'armed');
    assert.equal(st.deadline.boot_id, 'BOOT-1');
    assert.ok(st.worker.pgid && st.worker.leader_start && st.worker.log.startsWith(env.stateDir), 'the worker identity and ground-truth log are persisted');
    assert.ok(st.ref.wall_ms && st.ref.hr_ns, 'the arm-time wall/hr relation is persisted');
    if (fx === 'd') assert.ok(st.sleep_evidence_at_arm.waketime_s, 'the host sleep evidence at arm is persisted');
    if (fx === 'e') { assert.equal(st.kill_restart.result, 'PASS'); assert.ok(st.deadline.charged_ms > 0, 'e observes once before the reboot'); }
    const again = await G0.armFixture(fx, env);
    assert.equal(again.result, 'REFUSED');
    assert.match(again.reason, /already_armed/);
  }
  const { code } = await quietMain(['c', 'status'], env);
  assert.equal(code, G0.EXIT.INCOMPLETE, 'an armed fixture never exits 0');
});

test('phase 2 refuses without a valid phase-1 record (missing, corrupt, wrong schema) and creates nothing', async (t) => {
  const { env } = world(t);
  for (const fx of G0.TWO_PHASE) {
    const r = await G0.observeFixture(fx, env);
    assert.equal(r.result, 'REFUSED');
    assert.match(r.reason, /not_armed/);
    assert.equal(existsSync(join(env.stateDir, fx)), false, 'no record was created by a refused phase 2');
  }
  mkdirSync(join(env.stateDir, 'c'), { recursive: true });
  writeFileSync(join(env.stateDir, 'c', 'state.json'), '{"schema":');
  assert.match((await G0.observeFixture('c', env)).reason, /corrupt_record/);
  writeFileSync(join(env.stateDir, 'c', 'state.json'), JSON.stringify({ schema: 'other', fixture: 'c' }));
  assert.match((await G0.observeFixture('c', env)).reason, /wrong_schema/);
  const { code } = await quietMain(['d', 'observe'], env);
  assert.equal(code, G0.EXIT.FAIL, 'a refused phase 2 exits non-zero');
});

test('c: a skipped clock step is NOT_RUN (never PASS) and the record stays armed so phase 2 can resume', async (t) => {
  const { env, ctl } = world(t);
  await G0.armFixture('c', env);
  ctl.run(2000);
  const r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'NOT_RUN', JSON.stringify(r));
  assert.equal(stateOf(env, 'c').phase, 'armed');
  const { code, lines } = await quietMain(['c', 'observe'], env);
  assert.equal(code, G0.EXIT.INCOMPLETE);
  assert.equal(lines.at(-1).g0, 'NOT_ESTABLISHED');
});

test('c: observations at -1 h, at +1 h and after restoration, each within tolerance of the hr ground truth -> PASS; the worker is stopped without a signal', async (t) => {
  const { env, ctl, s } = world(t);
  await G0.armFixture('c', env);
  ctl.run(2000);
  ctl.stepWall(-H); ctl.run(1500);
  let r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'PARTIAL', JSON.stringify(r));
  ctl.stepWall(2 * H); ctl.run(1500); // +1 h from true time
  r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'PARTIAL');
  assert.match(r.reason, /not restored/);
  ctl.stepWall(-H); ctl.run(1500); // network time restores it
  r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'PASS', JSON.stringify(r));
  const kinds = r.observations.map(o => o.kind);
  assert.deepEqual(kinds, ['minus_1h', 'plus_1h', 'restored']);
  for (const o of r.observations) {
    assert.ok(Math.abs(o.diff_ms) <= TOL, `charge ${o.charged_ms} vs truth ${o.true_execution_ms}`);
    assert.ok(o.true_execution_ms > 0, 'the ground truth was measured, not assumed');
  }
  assert.equal(r.cleanup.worker, 'stopped');
  assert.deepEqual(s.signals, [], 'a worker that obeys the stop sentinel is never signalled');
  assert.equal((await G0.observeFixture('c', env)).result, 'PASS', 'a final verdict is stable: phase 2 never redoes completed work');
});

test('c: PASS needs the measured charge within tolerance; an overcharge beyond it FAILS', async (t) => {
  const { env, ctl } = world(t);
  await G0.armFixture('c', env);
  const f = join(env.stateDir, 'c', 'state.json');
  const st = JSON.parse(readFileSync(f, 'utf8'));
  st.deadline.start_ns = String(BigInt(st.deadline.start_ns) - BigInt(TOL + 500) * 1000000n); // the mechanism charges 2 s too much
  writeFileSync(f, JSON.stringify(st));
  ctl.run(2000); ctl.stepWall(-H); ctl.run(1000);
  const r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'FAIL', JSON.stringify(r));
  assert.match(r.reason, /outside 1500 ms/);
});

test('c: a measurement clock that moves with the wall clock is caught: FAIL, not PASS (backward and forward)', async (t) => {
  const back = world(t, { hrFollowsWall: true });
  await G0.armFixture('c', back.env);
  back.ctl.run(2000); back.ctl.stepWall(-H); back.ctl.run(1000);
  const r = await G0.observeFixture('c', back.env);
  assert.equal(r.result, 'FAIL', JSON.stringify(r));
  // forward: the charge equals the (equally jumped) hr span, so only the tick-gap check can see it
  const fwd = world(t, { hrFollowsWall: true });
  await G0.armFixture('c', fwd.env);
  fwd.ctl.run(2000); fwd.ctl.stepWall(H); fwd.ctl.run(1000);
  const f = await G0.observeFixture('c', fwd.env);
  assert.equal(f.result, 'FAIL', JSON.stringify(f));
  assert.match(f.reason, /hr clock jumped/);
});

test('c: -1 h observed, then restored without the +1 h step, is PARTIAL, never PASS', async (t) => {
  const { env, ctl } = world(t);
  await G0.armFixture('c', env);
  ctl.run(2000); ctl.stepWall(-H); ctl.run(1000);
  assert.equal((await G0.observeFixture('c', env)).result, 'PARTIAL');
  ctl.stepWall(H); ctl.run(1000);
  const r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'PARTIAL', JSON.stringify(r));
  assert.equal(stateOf(env, 'c').phase, 'armed', 'still resumable: the +1 h step can follow');
});

test('d: no host sleep is NOT_RUN; a real sleep the darwin clock charges in full (documented, conservative) -> PASS with overcharge = sleep', async (t) => {
  assert.equal(G0.sleepChargeDocumented(), true, 'lib/deadline.mjs documents and justifies charging sleep');
  const { env, ctl } = world(t);
  await G0.armFixture('d', env);
  ctl.run(2000);
  assert.equal((await G0.observeFixture('d', env)).result, 'NOT_RUN');
  ctl.stall(90000); ctl.run(1000); // a 90 s gap in the log with no host sleep evidence is not a sleep
  const stalled = await G0.observeFixture('d', env);
  assert.equal(stalled.result, 'NOT_RUN');
  assert.match(stalled.reason, /no host sleep since arm/);
  await G0.abortFixture('d', env);
  await G0.armFixture('d', env); // re-arm after an abort (the aborted record is kept as evidence)
  ctl.run(2000);
  ctl.sleepHost(30000); ctl.run(1000);
  const short = await G0.observeFixture('d', env);
  assert.equal(short.result, 'NOT_RUN', 'a sleep under 60 s does not qualify');
  ctl.sleepHost(120000); ctl.run(2000);
  const r = await G0.observeFixture('d', env);
  assert.equal(r.result, 'PASS', JSON.stringify(r));
  assert.equal(r.mode, 'sleep_charged_conservatively');
  assert.ok(Math.abs(r.overcharge_ms - 150000) <= TOL, `overcharge ${r.overcharge_ms} equals the two sleeps`);
  assert.ok(r.observation.true_execution_ms > 0 && r.observation.wake_in_gap);
});

test('d: a sleep the darwin clock does NOT charge contradicts the documented semantics -> FAIL; on Linux the same is PASS', async (t) => {
  const mac = world(t, { sleepCharged: false });
  await G0.armFixture('d', mac.env);
  mac.ctl.run(2000); mac.ctl.sleepHost(120000); mac.ctl.run(2000);
  const r = await G0.observeFixture('d', mac.env);
  assert.equal(r.result, 'FAIL', JSON.stringify(r));
  const lin = world(t, { platform: 'linux', sleepCharged: false });
  await G0.armFixture('d', lin.env);
  lin.ctl.run(2000); lin.ctl.sleepHost(120000); lin.ctl.run(2000);
  const l = await G0.observeFixture('d', lin.env);
  assert.equal(l.result, 'PASS', JSON.stringify(l));
  assert.equal(l.mode, 'sleep_not_charged');
});

test('e: before the reboot phase 2 is NOT_RUN; after it the attempt is settled by boot identity with no probe or signal and an explicit unmeasured interval', async (t) => {
  for (const reuse of [false, true]) {
    const { env, ctl, s } = world(t);
    await G0.armFixture('e', env);
    ctl.run(4000);
    const before = await G0.observeFixture('e', env);
    assert.equal(before.result, 'NOT_RUN', JSON.stringify(before));
    ctl.run(5000); // the last interval before the reboot is never observed
    const charged = stateOf(env, 'e').deadline.charged_ms;
    ctl.reboot({ reuse });
    const probes = s.probes;
    const r = await G0.observeFixture('e', env);
    assert.equal(r.result, 'PASS', JSON.stringify(r));
    assert.equal(s.probes, probes, 'the old pgid is never probed after the reboot');
    assert.deepEqual(s.signals, [], `no signal (pgid reused by another process: ${reuse})`);
    assert.equal(r.unmeasured_record.reason, 'boot_changed');
    assert.equal(r.unmeasured_record.after_ms, charged);
    assert.ok(r.unmeasured_true_ms >= 5000 - TOL, `the unmeasured interval (${r.unmeasured_true_ms} ms) is quantified by the ground truth, not zero`);
    assert.equal(r.charged_before_reboot_ms, charged);
  }
});

test('e: an unmeasured interval recorded as zero, or a reboot that never happened, never PASSES', async (t) => {
  const { env, ctl } = world(t);
  await G0.armFixture('e', env);
  ctl.run(2000);
  const f = join(env.stateDir, 'e', 'state.json');
  const st = JSON.parse(readFileSync(f, 'utf8'));
  st.deadline.unmeasured = [{ reason: 'boot_changed', after_ms: 0, to_boot: 'BOOT-2' }]; // a mechanism that records the gap as zero
  writeFileSync(f, JSON.stringify(st));
  ctl.reboot();
  const r = await G0.observeFixture('e', env);
  assert.equal(r.result, 'FAIL', JSON.stringify(r));
  assert.match(r.reason, /unmeasured_explicit/);
});

test('e: a failed supervisor kill/restart half fails e at arm and arms nothing', async (t) => {
  const { env, s } = world(t);
  s.killRestart = { fixture: 'e', half: 'kill_restart', result: 'FAIL', reason: 'fired before the deadline' };
  const r = await G0.armFixture('e', env);
  assert.equal(r.result, 'FAIL');
  assert.equal(s.workers.size, 0);
  const { code } = await quietMain(['report'], env);
  assert.equal(code, G0.EXIT.FAIL);
});

test('a failed arm leaves no unrecorded worker: the worker is told to stop and nothing is armed', async (t) => {
  for (const fault of ['no_leader_start', 'save_throws']) {
    const { env, s } = world(t);
    const start = env.host.startWorker;
    env.host.startWorker = async (dir) => {
      const w = await start(dir);
      if (fault === 'no_leader_start') return { ...w, leader_start: null };
      mkdirSync(join(dir, 'state.json'), { recursive: true }); // the atomic rename onto a directory throws
      return w;
    };
    const r = await G0.armFixture('c', env);
    assert.equal(r.result, 'REFUSED', JSON.stringify(r));
    assert.match(r.reason, /arm_failed/);
    const w = [...s.workers.values()][0];
    assert.equal(existsSync(w.stop), true, `${fault}: the stop sentinel was written`);
    const ctl = { run: (ms) => env.host.wait(ms) };
    await ctl.run(200);
    assert.equal(w.alive, false, `${fault}: the worker stopped`);
  }
});

test('c/d: an unreadable boot id is not a reboot: the record stays armed and the worker keeps running', async (t) => {
  const { env, ctl, s } = world(t);
  await G0.armFixture('c', env);
  ctl.run(1000);
  s.boot = null;
  const r = await G0.observeFixture('c', env);
  assert.equal(r.result, 'NOT_RUN');
  assert.equal(stateOf(env, 'c').phase, 'armed');
  s.boot = 'BOOT-1';
  ctl.run(500);
  assert.equal((await G0.observeFixture('c', env)).result, 'NOT_RUN', 'resumable once the boot id reads again');
});

test('cleanup is bounded on the monotonic clock and never signals an unverified group', { timeout: 20000 }, async (t) => {
  const a = world(t, { immortal: true });
  await G0.armFixture('c', a.env);
  a.ctl.run(1000);
  const t0 = a.s.mono;
  const r = await G0.abortFixture('c', a.env);
  assert.equal(r.result, 'NOT_RUN');
  assert.equal(r.cleanup.worker, 'survived_sigkill');
  assert.deepEqual(a.s.signals.map(x => x.sig), ['SIGKILL'], 'only a verified group is signalled');
  assert.ok(a.s.mono - t0 <= G0.LIMITS.stop_wait_ms + G0.LIMITS.kill_wait_ms + 200, `bounded: ${a.s.mono - t0} ms`);
  const b = world(t, { immortal: true });
  await G0.armFixture('d', b.env);
  const f = join(b.env.stateDir, 'd', 'state.json');
  const st = JSON.parse(readFileSync(f, 'utf8'));
  st.worker.leader_start = 'NOT-THE-RECORDED-START';
  writeFileSync(f, JSON.stringify(st));
  const u = await G0.abortFixture('d', b.env);
  assert.equal(u.cleanup.worker, 'left_running_unverified');
  assert.deepEqual(b.s.signals, []);
});

test('exit code: 0 only when all six fixtures PASS; any NOT_RUN/PARTIAL/ARMED/missing is non-zero', async (t) => {
  const pass = (f) => ({ fixture: f, result: 'PASS' });
  assert.equal(G0.g0Exit(G0.ALL.map(pass)), G0.EXIT.PASS);
  assert.equal(G0.g0Exit(G0.ALL.filter(f => f !== 'd').map(pass)), G0.EXIT.INCOMPLETE, 'a missing fixture is not a pass');
  for (const bad of ['NOT_RUN', 'PARTIAL', 'ARMED', 'SIMULATED']) assert.equal(G0.g0Exit([...G0.ALL.map(pass), { fixture: 'c', result: bad }]), G0.EXIT.INCOMPLETE, bad);
  for (const bad of ['FAIL', 'REFUSED']) assert.equal(G0.g0Exit([...G0.ALL.map(pass), { fixture: 'x', result: bad }]), G0.EXIT.FAIL, bad);
  // a PASS of one two-phase fixture is reported as PASS but does not establish G0
  const { env, ctl } = world(t);
  await G0.armFixture('e', env);
  ctl.run(1000); ctl.reboot();
  const { code, lines } = await quietMain(['e', 'observe'], env);
  assert.equal(lines[0].result, 'PASS');
  assert.equal(code, G0.EXIT.INCOMPLETE);
  const rep = await quietMain(['report'], env);
  assert.deepEqual(rep.lines.slice(0, 3).map(l => [l.fixture, l.result]), [['c', 'NOT_RUN'], ['d', 'NOT_RUN'], ['e', 'PASS']]);
  assert.equal(rep.code, G0.EXIT.INCOMPLETE);
});
