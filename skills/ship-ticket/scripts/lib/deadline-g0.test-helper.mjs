#!/usr/bin/env node
/**
 * G0 (§8 P1-M): falsification fixtures for the D5 consumed-execution measurement mechanism of lib/deadline.mjs. NOT a CI
 * test: it needs the real host and real minutes (fixture a alone runs 60 s). Run it alone on a quiet machine:
 *
 *   node skills/ship-ticket/scripts/lib/deadline-g0.test-helper.mjs all      (or a b c d e f, any subset)
 *
 * It prints one JSON line per fixture { fixture, result: PASS|FAIL|NOT_RUN|SIMULATED, ... } and exits 1 if any fixture
 * FAILs. NOT_RUN and SIMULATED are never PASS: the mechanism stays UNQUALIFIED (MEASUREMENT_QUALIFIED false) until all six
 * PASS on the real host.
 *
 * Ground truth is the fixture worker's OWN progress log: the worker (a detached process group, leader = the worker)
 * appends `{ hr: process.hrtime.bigint(), wall: Date.now() }` every TICK_MS; true execution is last - first.
 * The enforcer is a separate short-lived process (`enforce` mode of this file), so "enforcer absent" means no process
 * of it exists; it persists the deadline record in a JSON file between invocations, exactly as the engine state would.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armRecord, observe, realClock, bootId } from './deadline.mjs';
import { groupIdentity, killGroup, processInfo } from '../engine-quiesce.mjs';

const SELF = fileURLToPath(import.meta.url);
const TICK_MS = 100;
const TOLERANCE_MS = 1500; // a process start, a ps probe and one tick, on a loaded host
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// ---- child modes ----------------------------------------------------------------------------------------------
async function child() {
if (process.argv[2] === 'worker') {
  const log = process.argv[3], runMs = Number(process.argv[4]);
  const t0 = Date.now();
  const tick = () => {
    appendFileSync(log, JSON.stringify({ hr: String(process.hrtime.bigint()), wall: Date.now() }) + '\n');
    if (runMs > 0 && Date.now() - t0 >= runMs) process.exit(0);
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
  await main(process.argv.slice(2));
}
}

// ---- harness ----------------------------------------------------------------------------------------------------
function startWorker(dir, runMs) {
  const log = join(dir, 'progress.jsonl');
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
  return { fixture: killMidway ? 'e' : 'b', result: pass ? 'PASS' : 'FAIL', limit_ms: LIMIT, sweep_interval_ms: SWEEP, outages_ms: outages,
    true_execution_at_kill_ms: truth, charged_at_kill_ms: fired?.charged_ms ?? null, bound_ms: LIMIT + SWEEP + TOLERANCE_MS,
    ...(killMidway ? { enforcer_killed_minus_9_and_restarted: true, reboot: 'NOT_RUN (a reboot cannot be exercised in-session; the boot-id path is SIMULATED in run-engine-substrate.test.mjs)' } : {}) };
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

async function main(args) {
  const want = new Set(args.includes('all') || !args.length ? ['a', 'b', 'c', 'd', 'e', 'f'] : args);
  const dir = mkdtempSync(join(tmpdir(), 'deadline-g0-'));
  let failed = false;
  try {
    const facts = clockFacts();
    out({ fixture: 'facts', ...facts });
    if (!facts.cross_process_ordered || !facts.boot_id_stable) { out({ fixture: 'facts', result: 'FAIL', reason: 'clock preconditions do not hold' }); failed = true; }
    const run = async (k, f) => { if (!want.has(k)) return; const r = await f(); out(r); if (r.result === 'FAIL') failed = true; };
    await run('a', () => fixtureA(dir));
    await run('b', () => fixtureB(dir));
    await run('c', async () => ({ fixture: 'c', result: 'NOT_RUN',
      reason: 'stepping the real wall clock by -1 h and +1 h needs root (date/sntp) and disrupts every process on this shared host; not exercised in-session',
      static_evidence: { mechanism_reads_wall_clock: /Date\.|new Date/.test(readFileSync(new URL('./deadline.mjs', import.meta.url), 'utf8').replace(/\/\*[^]*?\*\/|\/\/.*$/gm, '')) },
      simulated: 'run-engine-substrate.test.mjs N2 steps Date.now by -1 h / +1 h between sweeps (SIMULATED, not a real step)' }));
    await run('d', async () => ({ fixture: 'd', result: 'NOT_RUN',
      reason: 'host sleep cannot be triggered from an unattended session on a shared host',
      design: 'darwin uv_hrtime counts sleep (measured: it equals mach_continuous_time), so a sleep of N minutes would be CHARGED as execution; justified as conservative (it can only end an attempt early, never extend one). Linux CLOCK_MONOTONIC excludes suspend.' }));
    await run('e', () => fixtureB(dir, { killMidway: true }));
    await run('f', () => fixtureF(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  process.exitCode = failed ? 1 : 0;
}

await child();
