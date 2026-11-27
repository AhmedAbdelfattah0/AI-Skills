/**
 * Persisted attempt deadlines and the D5 consumed-execution measurement (S1, P1). Node built-ins only, no local imports.
 *
 * STATUS: the measurement mechanism below is UNQUALIFIED. Its design and the G0 falsification fixtures (§8 P1-M a-f) are in
 * lib/deadline-g0.test-helper.mjs and the S1 report; not every fixture can run on a host in-session (a real wall-clock
 * step, host sleep and reboot cannot), so G0 has NOT passed and `MEASUREMENT_QUALIFIED` is false. While it is false the
 * engine never derives a signal from a measurement: the sweep (`run-engine.mjs reconcile --deadlines`) classifies identity
 * and records the attempt as unmeasured, and the launcher's in-process timers stay the only enforcer. A test injects a
 * clock (`ctx.deadlineClock`, in-process only, never set by the CLI) to exercise the persisted-deadline logic.
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
import { readFileSync } from 'node:fs';

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

/** The persisted deadline of a just-launched attempt (its group is the attempt's pgid): limit and clock origin. */
export function armRecord(limitMs, clock = realClock()) {
  const start = clock.nowNs();
  return { schema: DEADLINE_SCHEMA, limit_ms: limitMs, clock: CLOCK_ID, boot_id: clock.bootId, start_ns: String(start),
    observed_ns: String(start), charged_ms: 0, unmeasured: [], measurement: MEASUREMENT_QUALIFIED ? 'qualified' : 'unqualified' };
}

/**
 * Arm attempt `a` of state `S` right after its pid is recorded (before the release byte is sent), in a durable run only
 * (config.durableRun; a legacy run records nothing, byte for byte). `clock` is the in-process test clock, else the real one.
 */
export function armAttempt(S, a, limitMs, clock = null) {
  if (!S?.config?.durableRun || !a?.pid) return;
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
