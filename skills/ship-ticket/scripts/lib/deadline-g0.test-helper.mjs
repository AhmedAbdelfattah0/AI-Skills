#!/usr/bin/env node
/**
 * G0 (§8 P1-M): falsification fixtures for the D5 consumed-execution measurement mechanism of lib/deadline.mjs. NOT a CI
 * test: it needs the real host, real minutes and, for c/d/e, an owner host act. Run it alone on a quiet machine. The owner
 * runbook is HOST-WINDOW-RUNBOOK.md (consolidation-2026-11 assessment directory).
 *
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs a | b | f        in-session fixtures, run live
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs c|d|e arm        phase 1: arm and persist
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs c|d|e observe    phase 2 (after the owner's host act)
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs c|d|e status     print the persisted record, no observation
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs c|d|e abort      stop the fixture worker, record NOT_RUN
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs report           the persisted c/d/e verdicts only
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs all              a, b, f live + the persisted c, d, e
 *
 * It prints one JSON line per fixture { fixture, result: PASS|FAIL|PARTIAL|NOT_RUN|ARMED|REFUSED, ... } and a final
 * { fixture: 'summary', g0 } line. EXIT CODE: 0 only when this invocation established that ALL SIX fixtures PASS (only
 * `all` can); 1 when any FAILED or was REFUSED; 2 otherwise (ARMED, NOT_RUN, PARTIAL, or a subset that passed: G0 is
 * then not established). NOT_RUN, PARTIAL and SIMULATED are never PASS: the mechanism stays UNQUALIFIED
 * (MEASUREMENT_QUALIFIED false) until `all` exits 0 on the real host; flipping it is PR-1b's job, not this file's.
 *
 * Ground truth is the fixture worker's OWN progress log: the worker (a detached process group, leader = the worker)
 * appends `{ hr: process.hrtime.bigint(), wall: Date.now() }` every TICK_MS; true execution is last - first.
 * The enforcer is a separate short-lived process (`enforce` mode of this file), so "enforcer absent" means no process
 * of it exists; it persists the deadline record in a JSON file between invocations, exactly as the engine state would.
 *
 * Two-phase fixtures (c, d, e) persist everything under `~/.ai-skills-state/g0/<fixture>/` (G0_STATE_DIR overrides; never
 * the OS temp dir, which a reboot may clear): state.json (fsynced atomic write), the worker's progress.jsonl and a `stop`
 * sentinel. Phase 2 refuses without a valid phase-1 record; it never re-arms or resets completed work, so a failed step is
 * resumed by re-running `observe`. The fixtures never change the clock, sleep or reboot the host: the owner does, at the
 * prompts. The only host state they create is their own worker process and files: cleanup stops the worker through the
 * sentinel, then SIGKILLs it only when its group identity is verified on the same boot, each wait bounded on a monotonic
 * clock (performance.now), never on the wall clock the owner is stepping.
 *   (c) observations at a cumulative wall-clock displacement of about -1 h and about +1 h, then one after restoration:
 *       every charge within TOLERANCE_MS of the worker's hr ground truth, the hr log never jumping with the wall clock.
 *   (d) a real host sleep (kern.sleeptime/kern.waketime moved, pmset sleep count up, the wake inside the log gap): the
 *       charge equals the documented darwin semantics (sleep CHARGED, conservatively) or Linux's (not charged).
 *   (e) phase 1 runs the in-session supervisor kill -9/restart half and arms a worker; after a real reboot the attempt is
 *       settled by boot identity (no probe, no signal on the old pgid), the unmeasured interval recorded explicitly.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { armRecord, observe, realClock, bootId } from './deadline.mjs';
import { writeStateAtomic } from './durable-io.mjs';
import { groupIdentity, killGroup, processInfo, retire } from '../engine-quiesce.mjs';

const SELF = fileURLToPath(import.meta.url);
const TICK_MS = 100;
const TOLERANCE_MS = 1500; // a process start, a ps probe and one tick, on a loaded host
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// ---- two-phase constants (exported for the unit tests) ------------------------------------------------------------
export const G0_SCHEMA = 'ship-ticket-g0-fixture-v1';
export const TWO_PHASE = ['c', 'd', 'e'];
export const ALL = ['a', 'b', 'c', 'd', 'e', 'f'];
export const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2 };
export const LIMITS = {
  tolerance_ms: TOLERANCE_MS,
  hour_ms: 3600000,
  displacement_band_ms: 10 * 60000, // an observation counts as "at -1 h" when the displacement is within 1 h +- 10 min
  restored_ms: 10000, // restored: within 10 s of the arm-time wall/hr relation (network time re-enabled)
  gap_ms: 5000, // a log gap: consecutive ticks more than 5 s apart (hr or wall)
  min_sleep_ms: 60000, // fixture d needs at least 60 s of host sleep in total
  wake_slack_ms: 5000,
  ticking_ms: 3000, // the worker is "ticking" when its last tick is within 3 s (hr) of the observation
  deadline_limit_ms: 24 * 3600000, // the two-phase deadlines never expire: they measure, they do not fire
  worker_max_ms: 4 * 3600000, // the worker exits by itself after 4 h of hr time (bounded host resource)
  stop_wait_ms: 3000,
  kill_wait_ms: 2000,
  e_settle_ms: 3000,
  reboot_window_ms: 10 * 60000, // fixture e: the worker's last tick must be within 10 min before the new boot (alive until the reboot) // fixture e phase 1 observes once after 3 s, so a non-zero charge exists before the reboot
};
const DEADLINE_SRC = new URL('./deadline.mjs', import.meta.url);
/** The mechanism's own documentation of the darwin sleep semantics (static evidence for fixture d). */
export const sleepChargeDocumented = (src = readFileSync(DEADLINE_SRC, 'utf8')) => /sleep is CHARGED as execution/.test(src) && /conservative/i.test(src);

// ---- child modes ----------------------------------------------------------------------------------------------
async function child() {
if (process.argv[2] === 'worker') {
  // stop/maxMs (two-phase workers only): exit when the stop sentinel exists or after maxMs of hr time
  const log = process.argv[3], runMs = Number(process.argv[4]), stop = process.argv[5] || null, maxMs = Number(process.argv[6] || 0);
  const t0 = Date.now(), h0 = process.hrtime.bigint();
  const tick = () => {
    appendFileSync(log, JSON.stringify({ hr: String(process.hrtime.bigint()), wall: Date.now() }) + '\n');
    if (runMs > 0 && Date.now() - t0 >= runMs) process.exit(0);
    if (stop && existsSync(stop)) process.exit(0);
    if (maxMs > 0 && process.hrtime.bigint() - h0 >= BigInt(maxMs) * 1000000n) process.exit(0);
  };
  tick(); setInterval(tick, TICK_MS);
} else if (process.argv[2] === 'enforce') {
  // One enforcer invocation: arm (first time) or observe the persisted record; kill only a verified, expired group.
  const [, , , recFile, pgidS, limitS, leaderMode] = process.argv;
  const pgid = Number(pgidS);
  let a = existsSync(recFile) ? JSON.parse(readFileSync(recFile, 'utf8')) : null;
  if (!a) {
    a = { pgid, leader_start: leaderMode === 'null' ? null : leaderMode === 'reused' ? 'Thu Jan  1 00:00:00 1970' : processInfo(pgid).startTime,
      deadline: armRecord(Number(limitS)) };
    writeFileSync(recFile, JSON.stringify(a));
    process.stdout.write(JSON.stringify({ armed: true }));
    process.exit(0);
  }
  const m = observe(a.deadline, realClock());
  if (process.env.G0_HOLD_MS) { writeFileSync(recFile, JSON.stringify(a)); await delay(Number(process.env.G0_HOLD_MS)); } // killed -9 here in fixture e
  const identity = groupIdentity(a, groupAlive);
  let action = 'none';
  if (m.measured && m.expired) {
    if (identity === 'verified') { await killGroup(pgid, groupAlive); action = 'killed'; } else action = identity === 'gone' ? 'settled' : 'no_signal';
  }
  a.last = { ...m, identity, action };
  writeFileSync(recFile, JSON.stringify(a));
  process.stdout.write(JSON.stringify(a.last));
  process.exit(0);
} else {
  process.exitCode = await main(process.argv.slice(2));
}
}

// ---- harness ----------------------------------------------------------------------------------------------------
let workers = 0;
function startWorker(dir, runMs) {
  const log = join(dir, `progress-${++workers}.jsonl`); // one ground-truth log per worker
  const w = spawn(process.execPath, [SELF, 'worker', log, String(runMs)], { detached: true, stdio: 'ignore' });
  w.unref();
  return { pgid: w.pid, log, exited: new Promise(r => w.on('exit', r)) };
}
const progress = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const trueMs = (log) => { const p = progress(log); return p.length < 2 ? 0 : Number((BigInt(p.at(-1).hr) - BigInt(p[0].hr)) / 1000000n); };
function enforce(rec, pgid, limitMs, leader = 'real', env = {}) {
  const r = spawnSync(process.execPath, [SELF, 'enforce', rec, String(pgid), String(limitMs), leader], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || r.stdout, status: r.status, signal: r.signal }; }
}
async function waitFor(pred, ms) { const until = Date.now() + ms; while (Date.now() < until) { if (pred()) return true; await delay(20); } return pred(); }

/** Preconditions every fixture relies on: the clock is comparable across processes and the boot id is stable. */
function clockFacts() {
  const p1 = process.hrtime.bigint();
  const c = BigInt(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.hrtime.bigint()))'], { encoding: 'utf8', timeout: 15000 }).stdout);
  const p2 = process.hrtime.bigint();
  const b1 = bootId(), b2 = bootId();
  return { cross_process_ordered: p1 <= c && c <= p2, boot_id_stable: b1 !== null && b1 === b2, boot_id: b1, node: process.versions.node, uv: process.versions.uv, platform: process.platform };
}

/** (a) the worker runs 60 s while the enforcer is absent for 55 s: charged >= true execution, within the tolerance. */
async function fixtureA(dir) {
  const w = startWorker(dir, 60000), rec = join(dir, 'a.json');
  await waitFor(() => progress(w.log).length > 0, 10000);
  enforce(rec, w.pgid, 3600000); // armed, then absent
  await delay(55000);
  await waitFor(() => !groupAlive(w.pgid), 30000); // the worker finishes at ~60 s
  const r = enforce(rec, w.pgid, 3600000); // the first observation after the 55+ s outage
  const truth = trueMs(w.log), charged = r.charged_ms;
  // control: the REJECTED capped tick (min(now - last_tick, 1000)) over the same outage would charge ~1 s
  const capped = Math.min(charged, 1000);
  const pass = charged >= truth && charged - truth <= TOLERANCE_MS;
  return { fixture: 'a', result: pass ? 'PASS' : 'FAIL', true_execution_ms: truth, charged_ms: charged, tolerance_ms: TOLERANCE_MS,
    control_capped_tick_ms: capped, control_capped_would_fail: capped < truth };
}

/** (b) >= 3 outages at 90% of a deadline: it fires no later than deadline + one sweep interval of true execution. */
async function fixtureB(dir, { killMidway = false } = {}) {
  const LIMIT = 20000, SWEEP = 1000;
  const w = startWorker(dir, 0), rec = join(dir, killMidway ? 'e.json' : 'b.json');
  await waitFor(() => progress(w.log).length > 0, 10000);
  enforce(rec, w.pgid, LIMIT);
  const outages = [];
  // outages: 0 -> 6 s, 6 -> 12 s, 12 -> 18 s (90%) with one observation between each; then a sweep every SWEEP ms
  for (const at of [6000, 12000, 18000]) {
    const t = Date.now();
    await delay(Math.max(0, at - trueMs(w.log)));
    outages.push(Date.now() - t);
    if (killMidway && at === 12000) {
      // (e) an enforcer killed -9 while it holds an observation (after its persist, before its decision), then restarted
      const c = spawn(process.execPath, [SELF, 'enforce', rec, String(w.pgid), String(LIMIT), 'real'], { stdio: 'ignore', env: { ...process.env, G0_HOLD_MS: '5000' } });
      await delay(500); c.kill('SIGKILL'); await new Promise(r => c.on('exit', r));
    }
    const r = enforce(rec, w.pgid, LIMIT);
    if (r.action === 'killed') return { fixture: killMidway ? 'e' : 'b', result: 'FAIL', reason: 'fired before the deadline', at_ms: trueMs(w.log) };
  }
  let fired = null;
  for (let i = 0; i < 20 && !fired; i++) { await delay(SWEEP); const r = enforce(rec, w.pgid, LIMIT); if (r.action === 'killed') fired = r; }
  await waitFor(() => !groupAlive(w.pgid), 5000);
  const truth = trueMs(w.log);
  const pass = fired !== null && truth >= LIMIT - TOLERANCE_MS && truth <= LIMIT + SWEEP + TOLERANCE_MS && !groupAlive(w.pgid);
  if (groupAlive(w.pgid)) try { process.kill(-w.pgid, 'SIGKILL'); } catch { /* gone */ }
  // (e) the kill/restart half only (phase 1 of `e arm`): fixture e is PASS only when its reboot half (`e observe`) also passes
  return { fixture: killMidway ? 'e' : 'b', ...(killMidway ? { half: 'kill_restart' } : {}), result: pass ? 'PASS' : 'FAIL', limit_ms: LIMIT, sweep_interval_ms: SWEEP, outages_ms: outages,
    true_execution_at_kill_ms: truth, charged_at_kill_ms: fired?.charged_ms ?? null, bound_ms: LIMIT + SWEEP + TOLERANCE_MS,
    ...(killMidway ? { enforcer_killed_minus_9_and_restarted: true } : {}) };
}

/** (f) null or reused leader_start: an expired deadline sends no signal and releases nothing. */
async function fixtureF(dir) {
  const rows = [];
  for (const mode of ['null', 'reused']) {
    const w = startWorker(join(dir), 0), rec = join(dir, `f-${mode}.json`);
    await waitFor(() => progress(w.log).length > 0, 10000);
    enforce(rec, w.pgid, 1000, mode);
    await delay(1500);
    const r = enforce(rec, w.pgid, 1000, mode);
    const alive = groupAlive(w.pgid);
    rows.push({ mode, expired: r.expired, identity: r.identity, action: r.action, group_alive_after: alive });
    try { process.kill(-w.pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  const pass = rows.every(x => x.expired === true && x.identity === 'unknown' && x.action === 'no_signal' && x.group_alive_after === true);
  return { fixture: 'f', result: pass ? 'PASS' : 'FAIL', rows };
}

// ---- two-phase fixtures (c, d, e): the host seam ------------------------------------------------------------------
const sysctlSec = (name) => {
  const r = spawnSync('sysctl', ['-n', name], { encoding: 'utf8', timeout: 5000 });
  const m = r.status === 0 ? /sec = (\d+), usec = (\d+)/.exec(r.stdout) : null;
  return m ? Number(m[1]) + Number(m[2]) / 1e6 : null;
};
/** The real host. Every two-phase fixture reads time, identity and host evidence ONLY through this object. */
export function realHost() {
  return {
    platform: process.platform,
    nowNs: () => process.hrtime.bigint(),
    wallMs: () => Date.now(),
    monoMs: () => performance.now(),
    wait: delay,
    bootId: () => bootId(),
    /** darwin: last sleep/wake (wall seconds) and the pmset sleep count; null where no source exists. */
    sleepEvidence() {
      if (process.platform !== 'darwin') return null;
      const sleeptime_s = sysctlSec('kern.sleeptime'), waketime_s = sysctlSec('kern.waketime');
      const p = spawnSync('pmset', ['-g', 'stats'], { encoding: 'utf8', timeout: 5000 });
      const count = p.status === 0 ? /^Sleep Count:\s*(\d+)/m.exec(p.stdout) : null;
      return sleeptime_s === null || waketime_s === null ? null : { sleeptime_s, waketime_s, sleep_count: count ? Number(count[1]) : null };
    },
    /** The wall time this boot started (evidence only; kern.boottime moves with clock steps, so it is not an identity). */
    bootTimeMs: () => {
      if (process.platform !== 'darwin') return null;
      const s = sysctlSec('kern.boottime');
      return s === null ? null : Math.round(s * 1000);
    },
    async startWorker(dir) {
      const log = join(dir, 'progress.jsonl'), stop = join(dir, 'stop');
      const w = spawn(process.execPath, [SELF, 'worker', log, '0', stop, String(LIMITS.worker_max_ms)], { detached: true, stdio: 'ignore' });
      w.unref();
      const until = performance.now() + 10000;
      while (performance.now() < until && !(existsSync(log) && readFileSync(log, 'utf8').length)) await delay(20);
      return { pgid: w.pid, log, stop, leader_start: processInfo(w.pid).startTime };
    },
    alive: groupAlive,
    info: processInfo,
    signal: (pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* gone */ } },
    async killRestartHalf() {
      const d = mkdtempSync(join(tmpdir(), 'deadline-g0-e-'));
      try { return await fixtureB(d, { killMidway: true }); } finally { rmSync(d, { recursive: true, force: true }); }
    },
  };
}
export const defaultStateDir = () => process.env.G0_STATE_DIR || join(homedir(), '.ai-skills-state', 'g0');
const fxDir = (env, fx) => join(env.stateDir, fx);
const stateFile = (env, fx) => join(fxDir(env, fx), 'state.json');
const clockOf = (host) => ({ nowNs: host.nowNs, bootId: host.bootId() });
const ms = (ns) => Number(ns / 1000000n);

/** Load a phase-1 record: { st } or { refused: reason }. Never creates anything. */
export function loadState(env, fx) {
  const f = stateFile(env, fx);
  if (!existsSync(f)) return { refused: `not_armed: no phase-1 record at ${f}; run \`${fx} arm\` first` };
  let st;
  try { st = JSON.parse(readFileSync(f, 'utf8')); } catch { return { refused: `corrupt_record: ${f} is not valid JSON; move it aside by hand to re-arm` }; }
  if (st?.schema !== G0_SCHEMA || st.fixture !== fx || !st.deadline?.start_ns || !('worker' in st)) return { refused: `wrong_schema: ${f} is not a ${G0_SCHEMA} record of fixture ${fx}; move it aside by hand to re-arm` };
  return { st };
}
const save = (env, st) => writeStateAtomic(stateFile(env, st.fixture), st);

/**
 * The worker's ground-truth ticks from the first one at or after the attempt origin, in log order (positional, not
 * filtered by value, so an hr clock that jumps backward later still shows as a negative delta). A line cut short by a
 * reboot is skipped and counted.
 */
export function readTicks(log, startNs) {
  let text = '';
  try { text = readFileSync(log, 'utf8'); } catch { /* none yet */ }
  const all = []; let malformed = 0;
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const t = JSON.parse(l); all.push({ hr: BigInt(t.hr), wall: Number(t.wall) }); } catch { malformed++; }
  }
  const from = all.findIndex(t => t.hr >= startNs);
  return { ticks: from < 0 ? [] : all.slice(from), malformed, lastAny: all.at(-1) ?? null };
}
/** Consecutive-tick deltas: { pairs: [{ dhr, dwall, fromWall, toWall }], negative_hr }. */
function deltas(ticks) {
  const pairs = []; let negative = false;
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].hr < ticks[i - 1].hr) negative = true;
    pairs.push({ dhr: ms(ticks[i].hr - ticks[i - 1].hr), dwall: ticks[i].wall - ticks[i - 1].wall, fromWall: ticks[i - 1].wall, toWall: ticks[i].wall });
  }
  return { pairs, negative_hr: negative };
}
const span = (ticks) => (ticks.length < 2 ? 0 : ms(ticks.at(-1).hr - ticks[0].hr));

/**
 * Stop the fixture worker, bounded: the stop sentinel, a monotonic wait, then SIGKILL only a group verified on the start
 * boot. After a reboot the recorded pgid may name an unrelated process: nothing is probed or signalled.
 */
export async function cleanupWorker(st, env) {
  const { host } = env, w = st.worker;
  try { writeFileSync(w.stop, ''); } catch { /* the directory is gone */ }
  if (host.bootId() !== st.deadline.boot_id) return { worker: 'gone_by_boot', signalled: false };
  const waitGone = async (bound) => { const until = host.monoMs() + bound; while (host.monoMs() < until && host.alive(w.pgid) === true) await host.wait(50); return host.alive(w.pgid) !== true; };
  if (await waitGone(LIMITS.stop_wait_ms)) return { worker: 'stopped', signalled: false };
  const identity = groupIdentity({ pgid: w.pgid, leader_start: w.leader_start }, host.alive, host.info);
  if (identity !== 'verified') return { worker: 'left_running_unverified', identity, signalled: false, warning: `group ${w.pgid} did not stop and its identity is not verified: not signalled; check it by hand` };
  host.signal(w.pgid, 'SIGKILL');
  return (await waitGone(LIMITS.kill_wait_ms)) ? { worker: 'killed', signalled: true } : { worker: 'survived_sigkill', signalled: true, warning: `group ${w.pgid} survived SIGKILL` };
}

/**
 * What a verdict was measured against (evidence, not a gate): the digests of the mechanism files and of this helper.
 * A later change to them does not invalidate a persisted verdict automatically: compare these fields before reusing one.
 */
export function provenance() {
  const sha = (u) => { try { return createHash('sha256').update(readFileSync(u)).digest('hex'); } catch { return null; } };
  return { deadline_mjs_sha256: sha(DEADLINE_SRC), engine_quiesce_mjs_sha256: sha(new URL('../engine-quiesce.mjs', import.meta.url)),
    helper_sha256: sha(SELF) };
}

async function finalize(env, st, result) {
  st.phase = 'final';
  delete st.pending;
  st.result = { ...result, finished_wall_ms: env.host.wallMs(), provenance: provenance() };
  if (st.worker && result.cleanup === undefined) st.result.cleanup = await cleanupWorker(st, env);
  await save(env, st);
  return verdictOf(st);
}
const verdictOf = (st) => ({ fixture: st.fixture, ...st.result, phase: st.phase, observation_count: st.observations?.length ?? 0 });
const pending = async (env, st, result) => { st.pending = result; await save(env, st); return { fixture: st.fixture, phase: 'armed', ...result }; };

const NEXT = {
  c: 'step the wall clock to about -1 h (runbook step C3), then run `c observe`',
  d: 'sleep the host for at least 2 minutes (runbook step D2), wake it, then run `d observe`',
  e: 'reboot the host (runbook step E3), log in, then run `e observe`',
};

/** Phase 1: start a worker, arm its deadline on the real (or injected) clock and persist everything phase 2 needs. */
async function armUnlocked(fx, env) {
  const { host } = env, dir = fxDir(env, fx);
  if (!TWO_PHASE.includes(fx)) return { fixture: fx, result: 'REFUSED', reason: `${fx} is not a two-phase fixture` };
  if (existsSync(stateFile(env, fx))) {
    const prev = loadState(env, fx);
    if (prev.st?.phase !== 'final') return { fixture: fx, result: 'REFUSED', reason: prev.refused ?? `already_armed: ${stateFile(env, fx)} holds a live record; run \`${fx} observe\` to resume or \`${fx} abort\` to abandon it` };
    renameSync(stateFile(env, fx), join(dir, `state.final-${prev.st.result?.finished_wall_ms ?? host.wallMs()}.json`)); // evidence kept, not deleted
  }
  const boot = host.bootId();
  if (!boot) return { fixture: fx, result: 'REFUSED', reason: 'boot_id_unknown: the boot identity cannot be read, nothing can be measured' };
  const evidence = fx === 'd' ? host.sleepEvidence() : null;
  if (fx === 'd' && !evidence) return { fixture: fx, result: 'REFUSED', reason: 'no_sleep_evidence: kern.sleeptime/kern.waketime cannot be read on this host, a real sleep cannot be proven' };
  mkdirSync(dir, { recursive: true });
  let killRestart = null;
  if (fx === 'e') {
    killRestart = await host.killRestartHalf();
    if (killRestart?.result !== 'PASS') {
      const st = { schema: G0_SCHEMA, fixture: fx, phase: 'final', worker: null, deadline: { start_ns: '0', boot_id: boot }, kill_restart: killRestart, observations: [],
        result: { result: 'FAIL', reason: 'the supervisor kill -9/restart half failed; the reboot half was not armed', kill_restart: killRestart, finished_wall_ms: host.wallMs(), provenance: provenance() } };
      await save(env, st);
      return verdictOf(st);
    }
  }
  for (const f of ['progress.jsonl', 'stop']) rmSync(join(dir, f), { force: true });
  const worker = await host.startWorker(dir);
  let st;
  try { // until the record is saved, nothing else can reach this worker: any failure stops it here (the stop sentinel)
    if (!worker?.pgid || !worker.leader_start || !readTicks(worker.log, 0n).ticks.length)
      throw new Error(`worker_not_started: pid ${worker?.pgid ?? '?'} has no recorded start time or wrote no tick within 10 s`);
    const deadline = armRecord(LIMITS.deadline_limit_ms, clockOf(host));
    st = { schema: G0_SCHEMA, fixture: fx, phase: 'armed', platform: host.platform, armed_wall_ms: host.wallMs(),
      ref: { wall_ms: host.wallMs(), hr_ns: String(host.nowNs()) }, worker, deadline, sleep_evidence_at_arm: evidence, kill_restart: killRestart, observations: [] };
    await save(env, st);
  } catch (e) {
    try { if (worker?.stop) writeFileSync(worker.stop, ''); } catch { /* the directory is gone */ }
    try { rmSync(stateFile(env, fx), { force: true }); } catch { /* not a file: leave it for the owner */ }
    return { fixture: fx, result: 'REFUSED', reason: `arm_failed: ${e.message}; the worker was told to stop and nothing is armed` };
  }
  if (fx === 'e') { // one measured observation before the reboot, so the charge the reboot must keep is non-zero
    await host.wait(LIMITS.e_settle_ms);
    const m = observe(st.deadline, clockOf(host));
    st.observations.push({ n: 1, boot_id: boot, charged_ms: m.charged_ms, measured: m.measured, wall_ms: host.wallMs() });
    await save(env, st);
  }
  return { fixture: fx, result: 'ARMED', state: stateFile(env, fx), worker_pgid: worker.pgid, boot_id: boot, ...(killRestart ? { kill_restart: killRestart } : {}), next: NEXT[fx] };
}

/** Phase 2 (repeatable): observe the persisted attempt after the owner's host act and record the verdict. */
export async function observeFixture(fx, env) {
  if (!TWO_PHASE.includes(fx)) return { fixture: fx, result: 'REFUSED', reason: `${fx} is not a two-phase fixture` };
  const first = loadState(env, fx);
  if (first.refused) return { fixture: fx, result: 'REFUSED', reason: first.refused };
  return locked(env, fx, () => observeUnlocked(fx, env));
}
async function observeUnlocked(fx, env) {
  const loaded = loadState(env, fx); // re-read under the lock: a verdict another run recorded is never overwritten
  if (loaded.refused) return { fixture: fx, result: 'REFUSED', reason: loaded.refused };
  const st = loaded.st;
  if (st.phase === 'final') return verdictOf(st);
  if (fx === 'c') return observeC(env, st);
  if (fx === 'd') return observeD(env, st);
  return observeE(env, st);
}

/** One measured observation on the start boot, with its ground truth from the worker's log. */
function measure(env, st) {
  const { host } = env;
  const wall = host.wallMs(), hr = host.nowNs();
  const m = observe(st.deadline, clockOf(host));
  const { ticks, malformed, lastAny } = readTicks(st.worker.log, BigInt(st.deadline.start_ns));
  const truth = span(ticks), last = ticks.at(-1);
  const offset = (wall - st.ref.wall_ms) - ms(hr - BigInt(st.ref.hr_ns));
  return { m, ticks, malformed, truth, wall, hr, offset_ms: offset,
    worker_ticking: Boolean(lastAny) && ms(hr - lastAny.hr) <= LIMITS.ticking_ms, // any tick: an observe right after arm has none since the origin yet
    worker_offset_ms: last ? (last.wall - st.ref.wall_ms) - ms(last.hr - BigInt(st.ref.hr_ns)) : null };
}
/** 'moved' (another boot), 'unknown' (unreadable now: a transient sysctl failure is not a reboot) or 'same'. */
const bootState = (env, st) => { const b = env.host.bootId(); return b === null ? 'unknown' : b !== st.deadline.boot_id ? 'moved' : 'same'; };
const bootUnknown = (env, st, fx) => pending(env, st, { result: 'NOT_RUN', reason: 'the boot identity cannot be read now; nothing observed', next: `check \`sysctl -n kern.bootsessionuuid\`, then run \`${fx} observe\` again` });

const classifyOffset = (o) => (Math.abs(o + LIMITS.hour_ms) <= LIMITS.displacement_band_ms ? 'minus_1h'
  : Math.abs(o - LIMITS.hour_ms) <= LIMITS.displacement_band_ms ? 'plus_1h' : Math.abs(o) <= LIMITS.restored_ms ? 'restored' : 'other');

async function observeC(env, st) {
  const bs = bootState(env, st);
  if (bs === 'unknown') return bootUnknown(env, st, 'c');
  if (bs === 'moved') return finalize(env, st, { result: 'NOT_RUN', reason: 'the host rebooted during fixture c: the attempt cannot be observed on its start boot; re-arm c' });
  const x = measure(env, st);
  const { pairs, negative_hr } = deltas(x.ticks);
  const maxDhr = pairs.reduce((a, p) => Math.max(a, p.dhr), 0);
  const prev = st.observations.at(-1);
  const obs = { n: st.observations.length + 1, kind: classifyOffset(x.offset_ms), offset_ms: x.offset_ms, worker_offset_ms: x.worker_offset_ms,
    charged_ms: x.m.charged_ms, true_execution_ms: x.truth, diff_ms: x.m.charged_ms - x.truth, measured: x.m.measured,
    worker_ticking: x.worker_ticking, max_tick_gap_hr_ms: maxDhr, negative_hr, malformed_lines: x.malformed,
    // evidence for PR-1b (an identity probe while the clock is displaced), not a PASS gate
    identity: groupIdentity({ pgid: st.worker.pgid, leader_start: st.worker.leader_start }, env.host.alive, env.host.info), wall_ms: x.wall };
  obs.charge_ok = x.m.measured && Math.abs(obs.diff_ms) <= LIMITS.tolerance_ms && (!prev || obs.charged_ms >= prev.charged_ms);
  st.observations.push(obs);
  const evidence = { tolerance_ms: LIMITS.tolerance_ms, observations: st.observations };
  if (!x.worker_ticking) return finalize(env, st, { ...evidence, result: 'NOT_RUN', reason: 'the worker stopped ticking (exited or its 4 h self-bound was reached): the ground truth is incomplete; re-arm c' });
  if (negative_hr || maxDhr > LIMITS.gap_ms) return finalize(env, st, { ...evidence, result: 'FAIL', reason: `the worker's hr clock jumped (max tick gap ${maxDhr} ms, negative ${negative_hr}): the measurement clock moved with the wall clock or the worker stalled` });
  if (!obs.charge_ok) return finalize(env, st, { ...evidence, result: 'FAIL', reason: `charge ${obs.charged_ms} ms vs true execution ${obs.true_execution_ms} ms at displacement ${obs.offset_ms} ms: outside ${LIMITS.tolerance_ms} ms or decreased` });
  const seen = (k) => st.observations.some(o => o.kind === k && o.charge_ok);
  const minus = seen('minus_1h'), plus = seen('plus_1h');
  if (minus && plus && obs.kind === 'restored') return finalize(env, st, { ...evidence, result: 'PASS', reason: 'charged within tolerance of true execution at -1 h, at +1 h and after restoration' });
  const restore = 'restore the clock (runbook step C5: re-enable network time, check `date` against a reliable source), then run `c observe` again';
  if (minus && plus) return pending(env, st, { result: 'PARTIAL', reason: `both displacements observed; the clock is not restored (displacement ${obs.offset_ms} ms)`, next: restore });
  // the step still needed is derived from the CURRENT displacement, so the hint stays right after an emergency restoration
  const stepTo = (target, label) => {
    const min = Math.round((target - obs.offset_ms) / 60000);
    const command = `sudo date -u "$(date -u -v${min >= 0 ? '+' : ''}${min}M +%m%d%H%M%Y.%S)"`;
    return { step_min: min, command, next: `step the wall clock by ${min >= 0 ? '+' : ''}${min} min to about ${label} from true time: ${command}; then run \`c observe\`` };
  };
  if (minus || plus) return pending(env, st, { result: 'PARTIAL', reason: `observed at ${minus ? '-1 h' : '+1 h'} only (current displacement ${obs.offset_ms} ms)`,
    ...(minus ? stepTo(LIMITS.hour_ms, '+1 h') : stepTo(-LIMITS.hour_ms, '-1 h')) });
  return pending(env, st, { result: 'NOT_RUN', reason: `no wall-clock displacement observed yet (displacement ${obs.offset_ms} ms)`, ...stepTo(-LIMITS.hour_ms, '-1 h') });
}

async function observeD(env, st) {
  const bs = bootState(env, st);
  if (bs === 'unknown') return bootUnknown(env, st, 'd');
  if (bs === 'moved') return finalize(env, st, { result: 'NOT_RUN', reason: 'the host rebooted during fixture d (a shutdown, not a sleep); re-arm d' });
  const { host } = env;
  const ev = host.sleepEvidence(), at = st.sleep_evidence_at_arm;
  const slept = Boolean(ev && ev.sleeptime_s > at.sleeptime_s && ev.waketime_s > at.waketime_s && ev.waketime_s * 1000 > st.armed_wall_ms
    && (ev.sleep_count === null || at.sleep_count === null || ev.sleep_count > at.sleep_count));
  const x = measure(env, st);
  const { pairs } = deltas(x.ticks);
  const gaps = pairs.filter(p => Math.max(p.dhr, p.dwall) > LIMITS.gap_ms);
  const sleepWall = gaps.reduce((a, p) => a + p.dwall, 0), sleepHr = gaps.reduce((a, p) => a + p.dhr, 0);
  const execution = pairs.filter(p => !gaps.includes(p)).reduce((a, p) => a + p.dhr, 0); // true execution, suspension excluded
  const wakeMs = ev ? Math.round(ev.waketime_s * 1000) : null;
  const wakeInGap = wakeMs !== null && gaps.some(p => wakeMs >= p.fromWall - LIMITS.wake_slack_ms && wakeMs <= p.toWall + LIMITS.wake_slack_ms);
  const obs = { n: st.observations.length + 1, slept, sleep_evidence: ev, gaps: gaps.map(p => ({ hr_ms: p.dhr, wall_ms: p.dwall, from_wall: p.fromWall, to_wall: p.toWall })),
    sleep_wall_ms: sleepWall, sleep_hr_ms: sleepHr, true_execution_ms: execution, charged_ms: x.m.charged_ms, measured: x.m.measured,
    worker_ticking: x.worker_ticking, wake_in_gap: wakeInGap, wall_ms: x.wall };
  st.observations.push(obs);
  if (!slept) return pending(env, st, { result: 'NOT_RUN', reason: 'no host sleep since arm (kern.sleeptime/kern.waketime/pmset sleep count unchanged)', next: NEXT.d });
  const kernelSleepMs = Math.round((ev.waketime_s - ev.sleeptime_s) * 1000); // the kernel's own last sleep -> wake span
  obs.kernel_sleep_ms = kernelSleepMs;
  if (kernelSleepMs < LIMITS.min_sleep_ms) return pending(env, st, { result: 'NOT_RUN', reason: `the kernel's last sleep span (kern.sleeptime -> kern.waketime) is ${kernelSleepMs} ms, under ${LIMITS.min_sleep_ms} ms (a dark wake can shorten it: sleep again, longer)`, next: NEXT.d });
  if (sleepWall < LIMITS.min_sleep_ms) return pending(env, st, { result: 'NOT_RUN', reason: `host sleep in the worker's log totals ${sleepWall} ms, under ${LIMITS.min_sleep_ms} ms`, next: NEXT.d });
  if (!wakeInGap) return pending(env, st, { result: 'NOT_RUN', reason: 'the host wake time does not fall inside a gap of the worker log: the gap is not proven to be the sleep', next: NEXT.d });
  if (!x.worker_ticking) return finalize(env, st, { result: 'NOT_RUN', reason: 'the worker stopped ticking after the wake: the ground truth is incomplete; re-arm d', observation: obs });
  // charged = everything the hr clock counted since the origin; the overcharge is what it counted for the suspension
  const tol = LIMITS.tolerance_ms;
  const notCharged = Math.abs(x.m.charged_ms - execution) <= tol;
  const chargedInFull = Math.abs(sleepHr - sleepWall) <= tol && Math.abs(x.m.charged_ms - (execution + sleepHr)) <= tol && x.m.charged_ms >= execution;
  const expected = host.platform === 'darwin' ? 'sleep_charged_conservatively' : 'sleep_not_charged';
  const mode = notCharged ? 'sleep_not_charged' : chargedInFull ? 'sleep_charged_conservatively' : 'neither';
  const documented = (env.sleepChargeDocumented ?? sleepChargeDocumented)(); // a seam only for the unit tests' negative case
  const evidence = { tolerance_ms: tol, mode, expected_mode: expected, sleep_charge_documented: documented, observation: obs,
    overcharge_ms: x.m.charged_ms - execution };
  if (x.m.measured && mode === expected && (mode === 'sleep_not_charged' || documented))
    return finalize(env, st, { ...evidence, result: 'PASS', reason: mode === 'sleep_not_charged' ? 'no execution charged for the sleep' : 'the sleep is charged in full, as the mechanism documents and justifies (conservative: an attempt can only end earlier)' });
  return finalize(env, st, { ...evidence, result: 'FAIL', reason: `charge ${x.m.charged_ms} ms vs execution ${execution} ms and sleep ${sleepWall} ms (hr ${sleepHr} ms): ${mode} contradicts the documented ${expected} semantics` });
}

async function observeE(env, st) {
  const { host } = env;
  const now = host.bootId();
  if (now === st.deadline.boot_id) { // before the reboot: one more measured observation, nothing settled
    const m = observe(st.deadline, clockOf(host));
    st.observations.push({ n: st.observations.length + 1, boot_id: now, charged_ms: m.charged_ms, measured: m.measured, wall_ms: host.wallMs() });
    return pending(env, st, { result: 'NOT_RUN', reason: 'the boot id is unchanged: the reboot has not happened yet', charged_ms: m.charged_ms, next: NEXT.e });
  }
  if (!now) return pending(env, st, { result: 'NOT_RUN', reason: 'the boot identity cannot be read now; nothing is settled', next: 'check `sysctl -n kern.bootsessionuuid`, then run `e observe` again' });
  const preCharged = st.deadline.charged_ms;
  const m = observe(st.deadline, clockOf(host));
  const { ticks, malformed } = readTicks(st.worker.log, BigInt(st.deadline.start_ns)); // all on the start boot (hr comparable)
  const truthPre = span(ticks), lastWall = ticks.at(-1)?.wall ?? null;
  const bootTime = host.bootTimeMs();
  // settle by identity exactly as the sweep's runner path does: retire(..., { bootEnded }); count every probe and signal
  const a = { attempt_id: 'g0-e', kind: 'g0', pid: st.worker.pgid, pgid: st.worker.pgid, leader_start: st.worker.leader_start, status: 'running' };
  const S = { durable: true, locks: { 'g0-slot': 'g0-e' }, attempts: [a] };
  let probes = 0; const signals = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => { if (sig === 0) probes++; else signals.push({ pid, sig }); return realKill.call(process, pid, sig); };
  let settled;
  try { settled = await retire(S, a, (p) => { probes++; return host.alive(p); }, 'abandoned', { bootEnded: m.boot_ended }); } finally { process.kill = realKill; }
  const unm = st.deadline.unmeasured.find(u => u.reason === 'boot_changed');
  const checks = {
    boot_ended: m.boot_ended === true, measured_false: m.measured === false,
    unmeasured_explicit: Boolean(unm) && unm.after_ms === preCharged && unm.to_boot === now,
    charge_kept_nonzero: m.charged_ms === preCharged && preCharged > 0,
    charge_is_lower_bound: preCharged <= truthPre + LIMITS.tolerance_ms,
    settled_by_identity: settled === true && a.quiesced === true && a.status === 'abandoned',
    lock_released: S.locks['g0-slot'] === undefined,
    no_probe_of_old_pgid: probes === 0, no_signal: signals.length === 0,
    worker_log_ended_before_boot: lastWall !== null && bootTime !== null && lastWall <= bootTime + LIMITS.tolerance_ms,
    // the worker was alive until the reboot: ticking at the last pre-reboot observation and within 10 min of the new boot
    worker_alive_until_reboot: lastWall !== null && bootTime !== null && lastWall >= bootTime - LIMITS.reboot_window_ms
      && lastWall >= (st.observations.at(-1)?.wall_ms ?? Infinity) - LIMITS.ticking_ms,
    kill_restart_half_pass: st.kill_restart?.result === 'PASS',
  };
  const evidence = { tolerance_ms: LIMITS.tolerance_ms, from_boot: st.deadline.boot_id, to_boot: now, charged_before_reboot_ms: preCharged,
    true_execution_before_reboot_ms: truthPre, unmeasured_true_ms: truthPre - preCharged, unmeasured_record: unm ?? null,
    worker_last_tick_wall_ms: lastWall, boot_time_ms: bootTime, malformed_lines: malformed, kill_restart: st.kill_restart, checks };
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return finalize(env, st, { ...evidence, cleanup: { worker: 'gone_by_boot', signalled: false },
    result: failed.length ? 'FAIL' : 'PASS', reason: failed.length ? `failed checks: ${failed.join(', ')}` : 'after the reboot the attempt is settled by boot identity (no probe, no signal), its unmeasured interval recorded explicitly' });
}

/** Abandon an armed two-phase fixture: stop its worker (bounded) and record NOT_RUN (aborted). */
export async function abortFixture(fx, env) {
  if (loadState(env, fx).refused) return { fixture: fx, result: 'REFUSED', reason: loadState(env, fx).refused };
  return locked(env, fx, async () => {
    const loaded = loadState(env, fx);
    if (loaded.refused) return { fixture: fx, result: 'REFUSED', reason: loaded.refused };
    if (loaded.st.phase === 'final') return verdictOf(loaded.st);
    return finalize(env, loaded.st, { result: 'NOT_RUN', reason: 'aborted by the owner before a verdict' });
  });
}
/** Phase 1 under the fixture lock. */
export async function armFixture(fx, env) {
  if (!TWO_PHASE.includes(fx)) return { fixture: fx, result: 'REFUSED', reason: `${fx} is not a two-phase fixture` };
  return locked(env, fx, () => armUnlocked(fx, env));
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/**
 * One arm/observe/abort at a time per fixture: an exclusive-create lock file `<fx>/.lock` holding { pid, boot }. A holder
 * that is dead or from another boot is stale and taken over once; a live one makes this run REFUSED (nothing changed).
 */
export async function locked(env, fx, fn) {
  const dir = fxDir(env, fx), f = join(dir, '.lock');
  mkdirSync(dir, { recursive: true });
  const me = JSON.stringify({ pid: process.pid, boot: env.host.bootId() });
  for (let i = 0; ; i++) {
    try { writeFileSync(f, me, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let h = null;
      try { h = JSON.parse(readFileSync(f, 'utf8')); } catch { /* half-written by a crashed holder: stale */ }
      if ((h && h.boot === env.host.bootId() && pidAlive(h.pid)) || i > 0)
        return { fixture: fx, result: 'REFUSED', reason: `busy: ${f} is held by pid ${h?.pid ?? '?'}; wait for that run, or remove the file if no helper is running` };
      rmSync(f, { force: true });
    }
  }
  try { return await fn(); } finally { rmSync(f, { force: true }); }
}
export function statusFixture(fx, env) {
  const loaded = loadState(env, fx);
  if (loaded.refused) return { fixture: fx, result: 'NOT_RUN', reason: loaded.refused };
  const st = loaded.st;
  return st.phase === 'final' ? verdictOf(st) : { fixture: fx, phase: 'armed', result: st.pending?.result ?? 'ARMED', reason: st.pending?.reason, next: st.pending?.next ?? NEXT[fx], hint_note: 'as of the last observation; run `observe` for a hint from the current state', observation_count: st.observations.length };
}
/** The persisted verdicts of c, d, e (an armed or missing fixture is NOT_RUN, never PASS). */
export const reportTwoPhase = (env) => TWO_PHASE.map(fx => { const s = statusFixture(fx, env); return s.phase === 'final' ? s : { ...s, result: 'NOT_RUN', armed_state: s.result }; });

/** Exit code: 0 only when every one of the six fixtures is present and PASS; 1 on any FAIL/REFUSED; else 2. */
export function g0Exit(results) {
  if (results.some(r => r.result === 'FAIL' || r.result === 'REFUSED')) return EXIT.FAIL;
  const pass = new Set(results.filter(r => r.result === 'PASS').map(r => r.fixture));
  return ALL.every(f => pass.has(f)) && results.every(r => r.result === 'PASS') ? EXIT.PASS : EXIT.INCOMPLETE;
}

export async function main(args, env = { host: realHost(), stateDir: defaultStateDir() }) {
  const results = [];
  const emit = (r) => { out(r); results.push(r); };
  const [first, verb] = args;
  if (TWO_PHASE.includes(first) && verb) {
    const run = { arm: armFixture, observe: observeFixture, abort: abortFixture, status: async (f, e) => statusFixture(f, e) }[verb];
    emit(run ? await run(first, env) : { fixture: first, result: 'REFUSED', reason: `unknown verb ${verb} (arm | observe | status | abort)` });
  } else {
    const want = new Set(first === 'all' || !args.length ? ALL : first === 'report' ? TWO_PHASE : args);
    const unknown = [...want].filter(f => !ALL.includes(f));
    if (unknown.length) emit({ fixture: unknown.join(','), result: 'REFUSED', reason: 'unknown fixture' });
    const live = ['a', 'b', 'f'].filter(f => want.has(f));
    if (live.length) {
      const dir = mkdtempSync(join(tmpdir(), 'deadline-g0-'));
      try {
        const facts = clockFacts();
        out({ fixture: 'facts', ...facts });
        if (!facts.cross_process_ordered || !facts.boot_id_stable) emit({ fixture: 'facts', result: 'FAIL', reason: 'clock preconditions do not hold' });
        const fns = { a: fixtureA, b: fixtureB, f: fixtureF };
        for (const f of live) emit(await fns[f](dir));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    for (const r of reportTwoPhase(env)) if (want.has(r.fixture)) emit(r);
  }
  const code = g0Exit(results);
  out({ fixture: 'summary', g0: code === EXIT.PASS ? 'PASS' : code === EXIT.FAIL ? 'FAIL' : 'NOT_ESTABLISHED', exit: code,
    note: code === EXIT.PASS ? 'all six fixtures PASS on this host' : 'G0 is established only by `all` with every fixture PASS; MEASUREMENT_QUALIFIED stays false' });
  return code;
}

// Entry guard: importing this module (the unit tests) runs nothing; the CLI and the child modes run only as the main script.
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF); } catch { return false; } })();
if (isMain) await child();
