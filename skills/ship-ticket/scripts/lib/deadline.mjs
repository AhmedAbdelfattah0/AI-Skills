/**
 * Persisted attempt deadlines and the D5 consumed-execution measurement (S1, P1). Node built-ins only, no local imports.
 *
 * STATUS: the measurement mechanism below is UNQUALIFIED. Its design and the G0 falsification fixtures (§8 P1-M a-f) are in
 * lib/deadline-g0.test-helper.mjs and the S1 report; not every fixture can run on a host in-session (a real wall-clock
 * step, host sleep and reboot cannot), so G0 has NOT passed and `MEASUREMENT_QUALIFIED` is false. While it is false the
 * engine by default never derives a signal from a measurement: the real clock is bound for ARMING only (the persisted
 * origin), never for enforcement; the lock-free sweep (`run-engine.mjs reconcile --deadlines`) classifies identity, reports,
 * and writes nothing, and the launcher's in-process timers stay the only enforcer. `resolveSweepClock` is the gate: the real
 * clock when MEASUREMENT_QUALIFIED or under the explicit operator opt-in ENFORCEMENT_ENV=1 (PR-1b: still UNQUALIFIED), else
 * only a clock created by `testClock()` (in-process tests; the CLI never passes one); any other injected clock is refused
 * (`deadline_clock_refused`).
 *
 * Mechanism (as designed, for falsification):
 * - Clock: `process.hrtime.bigint()`, libuv `uv_hrtime`. On darwin with libuv 1.51 (Node 22) it was MEASURED on the S1 host
 *   to equal `mach_continuous_time` (it counts host sleep) and NOT `mach_absolute_time`; on Linux it is CLOCK_MONOTONIC
 *   (suspend excluded). It is system-wide and boot-relative, so a reading taken by one process is comparable with one taken
 *   by another on the same boot (a G0 assertion, not a Node guarantee). It never reads the wall clock, so a wall-clock
 *   step can neither reduce nor invent a charge.
 * - Scope: a reading is only meaningful within one boot. The boot identity is `kern.bootsessionuuid` (darwin) or
 *   `/proc/sys/kernel/random/boot_id` (Linux): a random id made at boot, not derived from the wall clock (`kern.boottime`
 *   is, and moves when the clock is stepped, so it is not used).
 * - Charge: no ticks. `charged_ms = max(charged_ms, (now_ns - start_ns) / 1e6)` at every observation on the start boot.
 *   Execution consumed while no enforcer runs is therefore charged in full at the next observation (never dropped, never
 *   capped: `min(now - last_tick, TICK_CAP)` is rejected); the max() keeps a recorded charge from ever decreasing.
 * - Sleep: on darwin the clock counts host sleep, so sleep is CHARGED as execution. Justification (conservative): a
 *   deadline bounds how long a slot can stay held; charging sleep can only end an attempt earlier (timed_out, the
 *   existing failure route, re-run), never let one run past its bound. On Linux sleep is not charged (the worker is
 *   suspended with the host, so no execution is invented either way).
 * - Reboot: a different boot id proves every process of the start boot gone (settled by identity, no signal). The
 *   interval from the last observation to the reboot cannot be measured: it is recorded EXPLICITLY in `unmeasured`
 *   ({ reason: 'boot_changed', after_ms }), never as zero; `charged_ms` keeps the last measured value as a lower bound.
 * - Unknown boot id (neither source readable): nothing is measured; the observation is recorded as unmeasured.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export const DEADLINE_SCHEMA = 'ship-ticket-deadline-v0';
export const CLOCK_ID = 'uv_hrtime+boot_id';
/** G0 (§8 P1-M) has not passed: see the header. Never flip this without six passing fixtures on the real host. */
export const MEASUREMENT_QUALIFIED = false;

/** The boot identity of this host (a random per-boot id), or null when it cannot be read. */
export function bootId(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const r = spawnSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5000 });
      const id = r.status === 0 ? r.stdout.trim() : '';
      return /^[0-9A-Fa-f-]{36}$/.test(id) ? id : null;
    }
    if (platform === 'linux') {
      const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^[0-9a-f-]{36}$/.test(id) ? id : null;
    }
  } catch { /* unreadable */ }
  return null;
}

let memoBoot;
/** The real clock: `{ nowNs(): bigint, bootId: string|null }`. */
export function realClock() {
  memoBoot ??= { id: bootId() };
  return { nowNs: () => process.hrtime.bigint(), bootId: memoBoot.id };
}

/**
 * PR-1b: the ONE explicit operator opt-in to the still UNQUALIFIED enforcement: this environment variable set to exactly '1'
 * in the process that sweeps (it binds the real clock for that sweep) and/or the process that drives (its attempts are armed
 * with `enforcement: 'unqualified_opt_in'`, so their settlement applies the deadline-precedence rule). Nothing sets it by
 * default; MEASUREMENT_QUALIFIED stays false. Enabling it is an operator decision to run an UNQUALIFIED mechanism (G0 c, d and
 * the reboot half of e have not passed on a physical host).
 */
export const ENFORCEMENT_ENV = 'SHIP_TICKET_UNQUALIFIED_DEADLINE_ENFORCEMENT';
export const OPT_IN = 'unqualified_opt_in';
export const enforcementOptIn = (env = process.env) => env?.[ENFORCEMENT_ENV] === '1';

const TEST_CLOCK = Symbol('ship-ticket unqualified test clock');
/** A clock for in-process tests of the persisted-deadline logic: `{ bootId, nowNs }` tagged as a test clock. */
export const testClock = (clock) => Object.assign(clock, { [TEST_CLOCK]: true });
/** Whether `clock` was made by testClock(). */
export const isTestClock = (clock) => clock?.[TEST_CLOCK] === true;
/**
 * S1 (L5): the clock the deadline sweep may enforce with. MEASUREMENT_QUALIFIED -> the real clock (an injected one only when
 * it is a testClock); otherwise a testClock, the real clock under the explicit opt-in (`env` ENFORCEMENT_ENV=1, PR-1b), or
 * null (nothing measured, nothing signalled). Throws `deadline_clock_refused` for any other injected clock, so no caller can
 * enable unqualified enforcement by passing one.
 */
export function resolveSweepClock(injected, env = process.env) {
  if (injected !== undefined && injected !== null && injected[TEST_CLOCK] !== true)
    throw Object.assign(new Error('deadline_clock_refused: the D5 measurement is unqualified; only a testClock() may be injected'), { code: 'deadline_clock_refused' });
  if (injected) return injected;
  return MEASUREMENT_QUALIFIED || enforcementOptIn(env) ? realClock() : null;
}

/**
 * The persisted deadline of a just-launched attempt (its group is the attempt's pgid): limit and clock origin. PR-1b: armed
 * under the opt-in (`env`), it also carries `enforcement: 'unqualified_opt_in'` (absent otherwise: default bytes unchanged).
 */
export function armRecord(limitMs, clock = realClock(), env = process.env) {
  const start = clock.nowNs();
  return { schema: DEADLINE_SCHEMA, limit_ms: limitMs, clock: CLOCK_ID, boot_id: clock.bootId, start_ns: String(start),
    observed_ns: String(start), charged_ms: 0, unmeasured: [], measurement: MEASUREMENT_QUALIFIED ? 'qualified' : 'unqualified',
    ...(!MEASUREMENT_QUALIFIED && enforcementOptIn(env) ? { enforcement: OPT_IN } : {}) };
}

/**
 * Arm attempt `a` of state `S` right after its pid is recorded (before the release byte is sent), in a durable run only
 * (S.durable; a legacy run records nothing, byte for byte). `clock` is the in-process test clock, else the real one.
 */
export function armAttempt(S, a, limitMs, clock = null) {
  if (!S?.durable || !a?.pid) return;
  a.deadline = armRecord(limitMs, clock ?? realClock());
}

/**
 * Charge `rec` at `clock` (mutates and returns it): { charged_ms, expired, boot_ended, measured }. `measured` false means
 * this observation measured nothing (unknown or changed boot); an unmeasured interval is appended once per cause.
 */
export function observe(rec, clock) {
  const note = (reason, extra = {}) => { if (!rec.unmeasured.some(u => u.reason === reason)) rec.unmeasured.push({ reason, ...extra }); };
  if (!rec.boot_id || !clock.bootId) { note('boot_unknown'); return { charged_ms: rec.charged_ms, expired: rec.charged_ms >= rec.limit_ms, boot_ended: false, measured: false }; }
  if (clock.bootId !== rec.boot_id) {
    note('boot_changed', { after_ms: rec.charged_ms, to_boot: clock.bootId });
    return { charged_ms: rec.charged_ms, expired: rec.charged_ms >= rec.limit_ms, boot_ended: true, measured: false };
  }
  const now = clock.nowNs(), start = BigInt(rec.start_ns);
  const elapsed = Number((now > start ? now - start : 0n) / 1000000n);
  rec.charged_ms = Math.max(rec.charged_ms, elapsed);
  if (now > BigInt(rec.observed_ns)) rec.observed_ns = String(now);
  return { charged_ms: rec.charged_ms, expired: rec.charged_ms >= rec.limit_ms, boot_ended: false, measured: true };
}

// ---- PR-1b: the sweep's own file, and the deadline precedence a locked settlement derives from persisted facts -----------

/**
 * The sweep's own append-only file in the run's attempts directory (archived and retired with it). The lock-free sweep writes
 * ONLY here, never the driver's state: one JSON line per observation (`observe`: the charge it measured) and, BEFORE any
 * signal, one `signal` receipt: "this attempt's deadline expired while its group was positively verified alive" (attempt id,
 * pgid, leader_start, deadline origin, charge). Each line is a single append + fsync, so concurrent sweeps never lose each
 * other's lines; a reader skips a torn or foreign line.
 */
export const SWEEP_FILE = 'deadline-sweep.jsonl';
export const SWEEP_SCHEMA = 'ship-ticket-deadline-sweep-v0';

/** Append record `rec` (one line, fsynced) to the sweep file of the attempts directory `dir`. */
export function appendSweep(dir, rec) {
  // no mkdir: a released attempt's directory exists; recreating one retired meanwhile would strand a file in it (m8)
  const fd = openSync(join(dir, SWEEP_FILE), 'a', 0o600);
  try { writeSync(fd, JSON.stringify({ schema: SWEEP_SCHEMA, ...rec }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Every well-formed sweep record of attempt `a` (same attempt id, pgid and deadline origin) in `dir`. */
export function sweepRecords(dir, a) {
  let text;
  try { text = readFileSync(join(dir, SWEEP_FILE), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.schema !== SWEEP_SCHEMA || r.attempt_id !== a?.attempt_id || r.pgid !== a?.pgid) continue;
    if (a.deadline && r.start_ns !== a.deadline.start_ns) continue;
    if (a.leader_start !== undefined && r.leader_start !== undefined && r.leader_start !== a.leader_start) continue;
    out.push(r);
  }
  return out;
}

/** The signal receipt of attempt `a` (the first), or null: the persisted evidence that it overran while verified alive. */
export const signalReceipt = (dir, a) => sweepRecords(dir, a).find(r => r.type === 'signal') ?? null;

/** The largest charge any sweep recorded for `a` (0 when none): a later observation never reports less. */
export const recordedCharge = (dir, a) => sweepRecords(dir, a).reduce((m, r) => Math.max(m, Number.isFinite(r.charged_ms) ? r.charged_ms : 0), 0);

/**
 * The position of envelope `env` on the deadline `rec` (ms of consumed execution at the moment the launcher wrote it), from the
 * launcher's monotonic stamp `mono_ns` (same uv_hrtime clock as the origin, same boot: a launcher never outlives its boot);
 * null when the envelope carries no stamp. Never the wall clock (`ended_at`, mtimes): a clock step cannot move it.
 */
export function envelopePosition(env, rec) {
  if (typeof env?.mono_ns !== 'string' || !/^\d+$/.test(env.mono_ns) || typeof rec?.start_ns !== 'string') return null;
  const d = BigInt(env.mono_ns) - BigInt(rec.start_ns);
  return Number((d > 0n ? d : 0n) / 1000000n);
}

/** The envelope file of attempt `a` in the attempts directory `dir` (a worker records it; a sealed runner's is by id). */
export const envelopeFileOf = (a, dir) => a.envelope_file ?? join(dir, `${a.attempt_id}.envelope.json`);
const readEnvelope = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * PR-1b round 1: THE deadline decision, for every decider (worker settle(), the sealed runner owner gateRunner, the sweep),
 * from the persisted facts READ AT DECISION TIME (call it again after any wait or retirement, never decide from an earlier
 * snapshot): the sweep's signal receipt (sweepRecords), the envelope (its existence and its monotonic stamp, if stamped)
 * and the opt-in recorded on the attempt's deadline. `env` overrides the envelope read (a sealed runner's decoded frame
 * header, or null for "no result"); otherwise envelopeFileOf(a, dir) is read now. Returns:
 * - 'ontime'    a stamped result positioned before the limit (accepted even when a timer fired after it);
 * - 'late'      a result that must not be accepted: stamped at or past the limit (enforced attempt), or unstamped while a
 *               receipt recorded the envelope ABSENT (`envelope_present: false`) after the limit, so it provably came later;
 * - 'timed_out' no result, and a receipt proves the deadline expired while the group was verified alive;
 * - 'unknown'   nothing persisted decides it: the FROZEN rule applies (the launcher's own timer; a result is accepted).
 *   By design this includes an UNSTAMPED result already present when the sweep looked (mixed opt-in: the driver ran
 *   without it): the sweep then writes no receipt, and the result is accepted, as without the opt-in.
 * The deadline origin and limit come from the attempt (`a.deadline`) or, for a sealed runner whose owner does not hold it,
 * from the receipt itself.
 */
export function deadlineVerdict(a, dir, { env } = {}) {
  const receipt = signalReceipt(dir, a);
  const rec = a.deadline ?? (receipt ? { start_ns: receipt.start_ns, limit_ms: receipt.limit_ms } : null);
  if (!rec) return 'unknown';
  const result = env !== undefined ? env : readEnvelope(envelopeFileOf(a, dir));
  if (result) {
    const pos = envelopePosition(result, rec);
    if (pos !== null) return !(receipt || rec.enforcement === OPT_IN || rec.measurement === 'qualified') ? 'unknown' : pos >= rec.limit_ms ? 'late' : 'ontime';
    return receipt?.envelope_present === false ? 'late' : 'unknown';
  }
  return receipt ? 'timed_out' : 'unknown';
}
