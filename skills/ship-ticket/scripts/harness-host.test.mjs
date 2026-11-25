import test from 'node:test';
import assert from 'node:assert/strict';
import { admitHost, hostSnapshot, parsePressure, parseSwapUsedKb100, HOST_SNAPSHOT_SCHEMA, HOST_POLICY, HOST_HOLD_REASONS } from './harness.mjs';

// Injected clock: samples are 20 s apart (inside the accepted 15..30 s window); now_ms is 1 s after the latest.
const T0 = 1_000_000;
const S = (o = {}) => ({ t_ms: T0, pressure_level: 1, swap_used_kb100: 100 * 102400, load1: 1, load5: 1, load15: 1, ...o });
const snap = (o = {}) => ({ schema: HOST_SNAPSHOT_SCHEMA, platform: 'darwin', cores: 10, now_ms: T0 + 21000, samples: [S(), S({ t_ms: T0 + 20000 })], provider_errors: [], ...o });
const withLatest = (o) => snap({ samples: [S(), S({ t_ms: T0 + 20000, ...o })] });
// The n-th later snapshot (distinct, strictly increasing timestamps).
const NEXT = (n, o = {}) => snap({ now_ms: T0 + 21000 + n * 20000, samples: [S({ t_ms: T0 + n * 20000 }), S({ t_ms: T0 + 20000 + n * 20000, ...o })] });
// H0: a host that has already resumed (open) at an earlier counted sample. history `null`/omitted-to-admitHost = cold start (held).
const H0 = { state: 'open', clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: T0 };
const LIGHT = (s, running, history = H0) => admitHost(s, 'LIGHT', running, history);
const HEAVY = (s, running, history = H0) => admitHost(s, 'HEAVY', running, history);
const R = (total, heavy = 0) => ({ total, heavy });

test('healthy host admits one LIGHT task with reason admitted', () => {
  const r = LIGHT(snap(), R(0));
  assert.equal(r.admit, true);
  assert.equal(r.reason, 'admitted');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.signals.healthy, true);
  assert.deepEqual(r.history, { state: 'open', clean_streak: 2, last_admit_t_ms: T0 + 20000, last_sample_t_ms: T0 + 20000 });
  assert.deepEqual(r.terminate, []);
});

test('cold start (missing history) is HELD: admit only after two clean, >= 15 s apart samples', () => {
  for (const h of [null, undefined]) {
    const c1 = admitHost(snap(), 'LIGHT', R(0), h);
    assert.equal(c1.admit, false);
    assert.deepEqual(c1.reasons, ['held_hysteresis']);
    const near = LIGHT(snap({ now_ms: T0 + 21001, samples: [S({ t_ms: T0 + 1 }), S({ t_ms: T0 + 20001 })] }), R(0), c1.history);
    assert.deepEqual(near.reasons, ['held_resample']);
    assert.deepEqual(near.history, c1.history);
    const c2 = LIGHT(NEXT(1), R(0), c1.history);
    assert.equal(c2.admit, true);
  }
});

test('admit ONE then re-sample: the same sample cannot admit twice; a newer sample can', () => {
  const first = LIGHT(snap(), R(0));
  const again = LIGHT(snap(), R(1), first.history);
  assert.equal(again.admit, false);
  assert.deepEqual(again.reasons, ['held_resample']);
  assert.equal(LIGHT(NEXT(1), R(1), first.history).admit, true);
});

test('pressure boundary: level 4 holds with held_pressure; levels 1 and 2 admit; an EARLIER sample at 4 is not ignored', () => {
  const r4 = LIGHT(withLatest({ pressure_level: 4 }), R(0));
  assert.deepEqual(r4.reasons, ['held_pressure']);
  assert.equal(r4.reason, 'held_pressure');
  for (const level of [1, 2]) {
    const r = LIGHT(withLatest({ pressure_level: level }), R(0));
    assert.equal(r.admit, true, 'level ' + level);
    assert.deepEqual(r.reasons, [], 'level ' + level);
  }
  const early = LIGHT(snap({ samples: [S({ pressure_level: 4 }), S({ t_ms: T0 + 20000 })] }), R(0));
  assert.deepEqual(early.reasons, ['held_pressure']);
  assert.equal(HOST_POLICY.pressure_hold_level, 4);
});

test('pressure window: a level-4 sample anywhere holds; level 2 anywhere (first, middle, last) alone admits', () => {
  const three = (a, b, c) => snap({ now_ms: T0 + 41000, samples: [S({ pressure_level: a }), S({ t_ms: T0 + 20000, pressure_level: b }), S({ t_ms: T0 + 40000, pressure_level: c })] });
  for (const [a, b, c] of [[4, 1, 1], [1, 4, 1], [1, 1, 4], [2, 4, 2], [4, 2, 2]]) assert.deepEqual(LIGHT(three(a, b, c), R(0)).reasons, ['held_pressure'], [a, b, c].join());
  for (const [a, b, c] of [[2, 1, 1], [1, 2, 1], [1, 1, 2], [2, 2, 2]]) { const r = LIGHT(three(a, b, c), R(0)); assert.equal(r.admit, true, [a, b, c].join()); }
});

test('pressure_warn is a boolean signal: true for a level-2 latest sample, false for level 1, and not a hold reason', () => {
  assert.equal(LIGHT(withLatest({ pressure_level: 2 }), R(0)).signals.pressure_warn, true);
  assert.equal(LIGHT(withLatest({ pressure_level: 1 }), R(0)).signals.pressure_warn, false);
  assert.equal(LIGHT(withLatest({ pressure_level: 4 }), R(0)).signals.pressure_warn, false);
  assert.equal(LIGHT(withLatest({ pressure_level: 2 }), R(0)).signals.pressure_level, 2);
  assert.ok(!HOST_HOLD_REASONS.includes('pressure_warn'));
});

test('TICKET-C-shaped host (level 2, swap flat, load fine, no provider errors) admits LIGHT and HEAVY', () => {
  const s = () => snap({ samples: [S({ pressure_level: 2 }), S({ t_ms: T0 + 20000, pressure_level: 2 })] });
  const l = LIGHT(s(), R(0));
  assert.equal(l.admit, true); assert.equal(l.reason, 'admitted'); assert.equal(l.signals.pressure_warn, true);
  const h = HEAVY(s(), R(0));
  assert.equal(h.admit, true); assert.equal(h.signals.heavy_slots, 1);
  assert.deepEqual(HEAVY(s(), R(1, 1)).reasons, ['held_heavy']);
  assert.deepEqual(HEAVY(s(), R(2, 2)).reasons, ['held_heavy']);
});

test('heavy slots: second slot opens only when level 1 throughout the window; any level-2 sample keeps 1 slot; pressure_warn is window-wide', () => {
  const win = (a, b) => snap({ samples: [S({ pressure_level: a }), S({ t_ms: T0 + 20000, pressure_level: b })] });
  const exp = { '1,1': [2, false], '1,2': [1, true], '2,1': [1, true], '2,2': [1, true] };
  for (const [k, [slots, warn]] of Object.entries(exp)) {
    const [a, b] = k.split(',').map(Number);
    const r = HEAVY(win(a, b), R(1, 1));
    assert.equal(r.signals.heavy_slots, slots, k); assert.equal(r.signals.pressure_warn, warn, k);
    assert.equal(r.admit, slots === 2, k);
    assert.equal(HEAVY(win(a, b), R(0)).admit, true, k);
  }
});

test('heavy slots: level-4 recovery needs two clean windows, then still 1 slot while level 2 persists', () => {
  const bad = LIGHT(withLatest({ pressure_level: 4 }), R(0));
  const c1 = HEAVY(NEXT(1, { pressure_level: 2 }), R(0), bad.history);
  assert.deepEqual(c1.reasons, ['held_hysteresis']);
  const c2 = HEAVY(NEXT(2, { pressure_level: 2 }), R(0), c1.history);
  assert.equal(c2.admit, true); assert.equal(c2.signals.heavy_slots, 1);
  assert.deepEqual(HEAVY(NEXT(3, { pressure_level: 2 }), R(1, 1), c2.history).reasons, ['held_heavy']);
});

test('level 2 does not mask the other holds: swap growth, high load and provider errors still hold', () => {
  const sw = LIGHT(snap({ samples: [S({ pressure_level: 2 }), S({ t_ms: T0 + 20000, pressure_level: 2, swap_used_kb100: 100 * 102400 + 204801 })] }), R(0));
  assert.deepEqual(sw.reasons, ['held_swap']);
  const ld = LIGHT(withLatest({ pressure_level: 2, load5: 9 }), R(0));
  assert.deepEqual(ld.reasons, ['held_load']);
  const pv = LIGHT(snap({ samples: [S({ pressure_level: 2 }), S({ t_ms: T0 + 20000, pressure_level: 2 })], provider_errors: [{ kind: '429', t_ms: T0 }] }), R(0));
  assert.deepEqual(pv.reasons, ['held_provider']);
});

test('hysteresis: level-2 samples count as clean; from a held history two level-2 samples resume, a level-4 one resets', () => {
  const held = { state: 'held', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: T0 };
  const c1 = LIGHT(NEXT(1, { pressure_level: 2 }), R(0), held);
  assert.deepEqual(c1.reasons, ['held_hysteresis']);
  assert.equal(c1.signals.clean, true);
  assert.equal(c1.history.clean_streak, 1);
  const c2 = LIGHT(NEXT(2, { pressure_level: 2 }), R(0), c1.history);
  assert.equal(c2.admit, true);
  assert.equal(c2.history.state, 'open');
  const hit = LIGHT(NEXT(2, { pressure_level: 4 }), R(0), c1.history);
  assert.deepEqual(hit.reasons, ['held_pressure']);
  assert.equal(hit.history.clean_streak, 0);
});

const MB = 102400;                      // hundredths of KB per MB (1 MB = 1024 KB = 102400 hundredths of KB)
const TOL = HOST_POLICY.swap_growth_tolerance_kb100;
test('swap tolerance is exactly 2 MB in integer hundredths of KB: strictly greater holds, exactly equal does not, +1 unit holds', () => {
  assert.equal(TOL, 2 * MB);
  const at = (delta) => LIGHT(withLatest({ swap_used_kb100: 100 * MB + delta }), R(0));
  assert.equal(at(TOL).admit, true);                            // exactly the tolerance: NOT growth
  assert.equal(at(TOL).signals.swap, 'flat');
  assert.deepEqual(at(TOL + 1).reasons, ['held_swap']);         // one hundredth of a KB above
  assert.deepEqual(at(TOL + 1024).reasons, ['held_swap']);      // 2.01 MB (the 'tolerance + 0.01 MB' row)
  assert.equal(at(TOL - 1).admit, true);
  assert.equal(at(0).signals.swap, 'flat');
  assert.deepEqual(at(10 * MB).reasons, ['held_swap']);
  const grow = at(10 * MB);
  assert.equal(grow.signals.swap, 'growing');
  // huge values near float precision stay exact (beyond 2^53 a Number could not tell these apart)
  const big = (u, d) => LIGHT(snap({ samples: [S({ swap_used_kb100: u }), S({ t_ms: T0 + 20000, swap_used_kb100: u + d })] }), R(0));
  const nearMax = Number.MAX_SAFE_INTEGER - TOL - 5;
  assert.equal(big(nearMax, TOL).admit, true);
  assert.deepEqual(big(nearMax, TOL + 1).reasons, ['held_swap']);
  assert.equal(LIGHT(withLatest({ swap_used_kb100: Number.MAX_SAFE_INTEGER + 1 }), R(0)).reason, 'snapshot_unavailable');   // not a safe integer
  const flat = LIGHT(snap({ samples: [S({ swap_used_kb100: 9_000_000 * MB }), S({ t_ms: T0 + 20000, swap_used_kb100: 9_000_000 * MB })] }), R(0));
  assert.equal(flat.admit, true);                               // huge absolute swap alone never blocks
  const fall = LIGHT(snap({ samples: [S({ swap_used_kb100: 500 * MB }), S({ t_ms: T0 + 20000, swap_used_kb100: 100 * MB })] }), R(0));
  assert.equal(fall.admit, true);
  assert.equal(fall.signals.swap, 'flat');
});

test('swap growth LATER in a 3-sample window, after an earlier dip, or creeping, still holds (not the latest pair only)', () => {
  const w = (a, b, c) => snap({ samples: [S({ swap_used_kb100: a }), S({ t_ms: T0 + 20000, swap_used_kb100: b }), S({ t_ms: T0 + 40000, swap_used_kb100: c })], now_ms: T0 + 41000 });
  assert.deepEqual(LIGHT(w(5 * MB, 5 * MB, 20 * MB), R(0)).reasons, ['held_swap']);
  assert.deepEqual(LIGHT(w(5 * MB, 50 * MB, 50 * MB), R(0)).reasons, ['held_swap']);
  assert.deepEqual(LIGHT(w(50 * MB, 10 * MB, 30 * MB), R(0)).reasons, ['held_swap']);                    // growth after the dip
  assert.deepEqual(LIGHT(w(10 * MB, 10 * MB + MB * 1.5, 10 * MB + MB * 3), R(0)).reasons, ['held_swap']); // creeping growth accumulates
  assert.equal(LIGHT(w(10 * MB, 10 * MB + MB, 10 * MB + 2 * MB), R(0)).admit, true);                   // exactly 2 MB in total: not growth
  const neg = LIGHT(snap({ samples: [S({ swap_used_kb100: -5 }), S({ t_ms: T0 + 20000, swap_used_kb100: -5 })] }), R(0));
  assert.equal(neg.admit, false);
  assert.equal(neg.reason, 'snapshot_unavailable');
});

test('a single sample cannot show swap is flat (held_swap unknown); gaps outside 15..30 s are held_resample', () => {
  const one = LIGHT(snap({ samples: [S({ t_ms: T0 + 20000 })] }), R(0));
  assert.deepEqual(one.reasons, ['held_swap']);
  assert.equal(one.signals.swap, 'unknown');
  assert.deepEqual(LIGHT(snap({ samples: [S(), S({ t_ms: T0 + 14999 })], now_ms: T0 + 15000 }), R(0)).reasons, ['held_resample']);
  assert.deepEqual(LIGHT(snap({ samples: [S(), S({ t_ms: T0 + 30001 })], now_ms: T0 + 31000 }), R(0)).reasons, ['held_resample']);
  assert.equal(LIGHT(snap({ samples: [S(), S({ t_ms: T0 + 15000 })], now_ms: T0 + 16000 }), R(0)).admit, true);
  assert.equal(LIGHT(snap({ samples: [S(), S({ t_ms: T0 + 30000 })], now_ms: T0 + 31000 }), R(0)).admit, true);
});

test('timestamps: missing/NaN/duplicate/unsorted t_ms hold; a 1-hour-old or future snapshot holds (freshness 0..30 s)', () => {
  for (const samples of [
    [S(), S({ t_ms: undefined })], [S(), S({ t_ms: NaN })], [S(), S({ t_ms: T0 })], [S({ t_ms: T0 + 20000 }), S()],
  ]) {
    const r = LIGHT(snap({ samples }), R(0));
    assert.equal(r.admit, false);
    assert.ok(['held_resample', 'snapshot_unavailable'].includes(r.reason), JSON.stringify(samples));
  }
  assert.deepEqual(LIGHT(snap({ now_ms: T0 + 20000 + 3_600_000 }), R(0)).reasons, ['held_resample']);
  assert.deepEqual(LIGHT(snap({ now_ms: T0 + 20000 + 30001 }), R(0)).reasons, ['held_resample']);
  assert.equal(LIGHT(snap({ now_ms: T0 + 20000 + 30000 }), R(0)).admit, true);
  assert.deepEqual(LIGHT(snap({ now_ms: T0 + 19999 }), R(0)).reasons, ['held_resample']);
  assert.deepEqual(LIGHT(snap({ now_ms: undefined }), R(0)).reasons, ['held_resample']);
});

test('load: each of load1/5/15 at 60% of cores holds; just under admits', () => {
  for (const k of ['load1', 'load5', 'load15']) {
    assert.deepEqual(LIGHT(withLatest({ [k]: 6 }), R(0)).reasons, ['held_load'], k);
    assert.equal(LIGHT(withLatest({ [k]: 5.99 }), R(0)).admit, true, k);
  }
});

test('provider errors (429, quota, timeout) hold with held_provider; a numeric count works; wrong types are NOT healthy', () => {
  for (const kind of ['429', 'quota', 'timeout']) assert.deepEqual(LIGHT(snap({ provider_errors: [{ kind, t_ms: T0 }] }), R(0)).reasons, ['held_provider'], kind);
  assert.deepEqual(LIGHT(snap({ provider_errors: 3 }), R(0)).reasons, ['held_provider']);
  assert.equal(LIGHT(snap({ provider_errors: 0 }), R(0)).admit, true);
  for (const bad of ['429', -1, 1.5, [{ kind: 'weird', t_ms: 1 }], ['x'], null, {}, undefined]) {
    const r = LIGHT(snap({ provider_errors: bad }), R(0));
    assert.equal(r.admit, false, JSON.stringify(bad));
    assert.equal(r.reason, 'snapshot_unavailable', JSON.stringify(bad));
  }
});

test('every signal combination reports all its reasons in a fixed order', () => {
  const sigs = { held_pressure: { pressure_level: 4 }, held_swap: { swap_used_kb100: 999 * 102400 }, held_load: { load5: 9 } };
  const names = Object.keys(sigs);
  for (let mask = 0; mask < 16; mask++) {
    const latest = {}; const expected = [];
    names.forEach((n, i) => { if (mask & (1 << i)) { Object.assign(latest, sigs[n]); expected.push(n); } });
    if (mask & 8) expected.push('held_provider');
    const r = LIGHT(snap({ samples: [S(), S({ t_ms: T0 + 20000, ...latest })], provider_errors: mask & 8 ? [{ kind: '429', t_ms: T0 }] : [] }), R(0));
    assert.deepEqual(r.reasons, expected, 'mask ' + mask);
    assert.equal(r.admit, expected.length === 0);
    assert.equal(r.reason, expected[0] ?? 'admitted');
  }
});

test('hysteresis: after a hold ONE clean sample is not enough; the second DISTINCT clean sample resumes', () => {
  const bad = LIGHT(withLatest({ pressure_level: 4 }), R(0));
  assert.equal(bad.history.state, 'held');
  const clean1 = LIGHT(NEXT(1), R(0), bad.history);
  assert.deepEqual(clean1.reasons, ['held_hysteresis']);
  assert.equal(clean1.signals.healthy, false);
  assert.equal(clean1.history.clean_streak, 1);
  const clean2 = LIGHT(NEXT(2), R(0), clean1.history);
  assert.equal(clean2.admit, true);
  assert.equal(clean2.history.state, 'open');
});

test('hysteresis: REPLAYING the same clean snapshot never counts as a second clean sample', () => {
  const bad = LIGHT(withLatest({ pressure_level: 4 }), R(0));
  const clean1 = LIGHT(NEXT(1), R(0), bad.history);
  for (let i = 0; i < 3; i++) {
    const replay = LIGHT(NEXT(1), R(0), clean1.history);
    assert.equal(replay.admit, false);
    assert.deepEqual(replay.reasons, ['held_resample']);
    assert.deepEqual(replay.history, clean1.history);
  }
  // An OLDER snapshot never counts: its history is in that snapshot's future, so it is refused.
  const older = LIGHT(NEXT(0), R(0), clean1.history);
  assert.equal(older.admit, false);
  assert.equal(older.reason, 'invalid_args');
});

test('hysteresis: a bad sample between two clean ones resets the streak', () => {
  const bad = LIGHT(withLatest({ swap_used_kb100: 500 * 102400 }), R(0));
  const c1 = LIGHT(NEXT(1), R(0), bad.history);
  const bad2 = LIGHT(NEXT(2, { load1: 9 }), R(0), c1.history);
  assert.equal(bad2.history.clean_streak, 0);
  const c2 = LIGHT(NEXT(3), R(0), bad2.history);
  assert.deepEqual(c2.reasons, ['held_hysteresis']);
});

test('a timestamp glitch after an open state puts the host back into recovery (two clean samples again)', () => {
  const open = LIGHT(snap(), R(0));
  const stale = LIGHT({ ...NEXT(1), now_ms: T0 + 3_600_000 }, R(0), open.history);
  assert.equal(stale.admit, false);
  assert.equal(stale.history.state, 'held');
  assert.equal(stale.history.clean_streak, 0);
  assert.deepEqual(LIGHT(NEXT(2), R(0), stale.history).reasons, ['held_hysteresis']);
  assert.equal(LIGHT(NEXT(3), R(0), LIGHT(NEXT(2), R(0), stale.history).history).admit, true);
});

test('heavy: 2 concurrent only when healthy; the third is held_heavy', () => {
  const r0 = HEAVY(snap(), R(1, 1));
  assert.equal(r0.admit, true);
  assert.equal(r0.signals.heavy_slots, 2);
  assert.deepEqual(HEAVY(snap(), R(2, 2)).reasons, ['held_heavy']);
});

test('heavy: recovering hosts and unhealthy hosts have cap 1 and report held_heavy', () => {
  const rec = HEAVY(snap(), R(1, 1), { state: 'held', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: null });
  assert.equal(rec.signals.heavy_slots, 1);
  assert.deepEqual(rec.reasons, ['held_hysteresis', 'held_heavy']);
  const bad = HEAVY(withLatest({ pressure_level: 4 }), R(1, 1));
  assert.equal(bad.signals.heavy_slots, 1);
  assert.deepEqual(bad.reasons, ['held_pressure', 'held_heavy']);
});

test('HEAVY admission depends ONLY on running.heavy and host health: the snapshot carries no process count and heavy_processes is REJECTED as an unknown key', () => {
  for (const v of [0, 2, null, 'x']) for (const call of [LIGHT, HEAVY]) {
    const r = call({ ...snap(), heavy_processes: v }, R(0));
    assert.equal(r.admit, false, String(v));
    assert.deepEqual(r.reasons, ['snapshot_unavailable'], String(v));
  }
  assert.equal(HEAVY(snap(), R(0)).admit, true);                 // healthy, nothing running: admitted
  assert.equal(HEAVY(snap(), R(1, 1)).admit, true);              // healthy: second HEAVY ok
  assert.equal(HEAVY(snap(), R(5, 1)).admit, true);              // occupancy is running.heavy, not running.total
  assert.deepEqual(HEAVY(snap(), R(2, 2)).reasons, ['held_heavy']);
  assert.deepEqual(HEAVY(snap(), R(3, 1), { state: 'held', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: null }).reasons, ['held_hysteresis', 'held_heavy']);
  assert.equal(LIGHT(snap(), R(5, 5)).admit, true);              // LIGHT is never held by HEAVY occupancy
  const r = HEAVY(snap(), R(1, 1));
  assert.equal(Object.hasOwn(r.signals, 'heavy_known'), false);
  assert.equal(r.signals.heavy_running, 1);
});

test('stop signals are evaluated BEFORE replay handling: clean -> bad at +1 ms -> clean never preserves the streak', () => {
  const cold = admitHost(snap(), 'LIGHT', R(0), null);          // streak 1, last_sample T0+20000
  const near = (o, n = 1) => snap({ now_ms: T0 + 21000 + n, samples: [S({ t_ms: T0 + n }), S({ t_ms: T0 + 20000 + n, ...o })] });
  const bads = [{ pressure_level: 4 }, { load5: 50 }, { swap_used_kb100: 110 * 102400 }];
  for (const bad of bads) {
    const hit = admitHost(near(bad), 'LIGHT', R(0), cold.history);
    assert.equal(hit.admit, false);
    assert.equal(hit.history.clean_streak, 0, JSON.stringify(bad));
    assert.equal(hit.history.state, 'held');
    assert.ok(hit.reasons.includes('held_resample'));
    const next = admitHost(NEXT(1), 'LIGHT', R(0), hit.history);
    assert.equal(next.admit, false, JSON.stringify(bad));
    assert.deepEqual(next.reasons, ['held_hysteresis']);
  }
  const quota = admitHost(near({}, 1), 'LIGHT', R(0), cold.history);
  assert.deepEqual(quota.history, cold.history);                // a CLEAN near-duplicate stays unchanged
  const q = admitHost({ ...near({}), provider_errors: [{ kind: 'quota', t_ms: 1 }] }, 'LIGHT', R(0), cold.history);
  assert.equal(q.history.clean_streak, 0);
  assert.deepEqual(q.reasons, ['held_provider', 'held_resample']);
});

test('a gap of more than 30 s since the last counted sample restarts the streak; exactly 30 s and 15 s still count', () => {
  const first = admitHost(snap(), 'LIGHT', R(0), null);       // last_sample T0 + 20000
  const gapped = (g) => admitHost(snap({ now_ms: T0 + 20000 + g + 1000, samples: [S({ t_ms: T0 + g }), S({ t_ms: T0 + 20000 + g })] }), 'LIGHT', R(0), first.history);
  assert.equal(gapped(0 + 30000).admit, true);                  // latest = last + 30000 -> counts, second clean sample
  assert.equal(gapped(30001).admit, false);                     // > 30 s: restart, only streak 1
  assert.equal(gapped(30001).history.clean_streak, 1);
  assert.deepEqual(gapped(30001).reasons, ['held_hysteresis']);
  // state 'open': a gap up to 3 min is trusted (a healthy poller at 31 s, 60 s, 3 min still admits), beyond it is a COLD START
  const open = LIGHT(snap(), R(0));                             // open history, last_sample T0 + 20000
  const afterGap = (g) => admitHost(snap({ now_ms: T0 + 20000 + g + 1000, samples: [S({ t_ms: T0 + g }), S({ t_ms: T0 + 20000 + g })] }), 'LIGHT', R(0), open.history);
  for (const g of [30000, 30001, 60000, 180000]) {
    assert.equal(afterGap(g).admit, true, 'gap ' + g);
    assert.equal(afterGap(g).history.state, 'open');
  }
  for (const g of [180001, 3_600_000]) {
    const r = afterGap(g);
    assert.equal(r.admit, false, 'gap ' + g);
    assert.deepEqual(r.reasons, ['held_hysteresis']);
    assert.equal(r.history.state, 'held');
    assert.equal(r.history.clean_streak, 1);
    assert.equal(admitHost(snap({ now_ms: T0 + 40000 + g + 1000, samples: [S({ t_ms: T0 + 20000 + g }), S({ t_ms: T0 + 40000 + g })] }), 'LIGHT', R(0), r.history).admit, true);   // second clean sample resumes
  }
  // ... but a stop signal after a long gap still blocks and resets
  const hit = admitHost(snap({ now_ms: T0 + 80000 + 1000, samples: [S({ t_ms: T0 + 60000 }), S({ t_ms: T0 + 80000, pressure_level: 4 })] }), 'LIGHT', R(0), open.history);
  assert.equal(hit.admit, false);
  assert.equal(hit.history.state, 'held');
});

test('liveness: a healthy host is admitted after a cold start plus one clean sample 15 s and 20 s later; 14999 ms is held', () => {
  const c1 = admitHost(snap(), 'LIGHT', R(0), null);
  const second = (g) => admitHost(snap({ now_ms: T0 + 20000 + g + 1000, samples: [S({ t_ms: T0 + g }), S({ t_ms: T0 + 20000 + g })] }), 'LIGHT', R(0), c1.history);
  assert.equal(second(15000).admit, true);
  assert.equal(second(20000).admit, true);
  assert.deepEqual(second(14999).reasons, ['held_resample']);
});

test('history must carry all four keys with an EXACT state: null/undefined/other state or missing keys is invalid_args (no defaulting)', () => {
  const full = { state: 'open', clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: T0 };
  for (const bad of [{ ...full, state: null }, { ...full, state: undefined }, { ...full, state: 'Open' }, { clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: T0 },
    { state: 'open', last_admit_t_ms: null, last_sample_t_ms: T0 }, { state: 'held' }, { state: 'held', clean_streak: 0 }, {}]) {
    const r = LIGHT(snap(), R(0), bad);
    assert.equal(r.admit, false, JSON.stringify(bad));
    assert.equal(r.reason, 'invalid_args', JSON.stringify(bad));
  }
});

test('running is REQUIRED: missing/undefined/null running is invalid_args even for HEAVY (never defaults to 0)', () => {
  for (const call of [() => admitHost(snap(), 'HEAVY'), () => admitHost(snap(), 'HEAVY', undefined, H0), () => admitHost(snap(), 'LIGHT', null, H0), () => admitHost(snap(), 'HEAVY', undefined)]) {
    const r = call();
    assert.equal(r.admit, false);
    assert.equal(r.reason, 'invalid_args');
  }
});

test('known stop signals keep precedence when other fields are malformed (bad timestamps, a quota row beside a malformed row)', () => {
  const p4 = LIGHT(snap({ samples: [S({ pressure_level: 4, t_ms: undefined }), S({ t_ms: T0 + 20000 })] }), R(0));
  assert.deepEqual(p4.reasons, ['held_pressure', 'held_resample']);
  const mixed = LIGHT(snap({ provider_errors: [{ kind: 'quota', t_ms: 1 }, { kind: 'weird', t_ms: 2 }] }), R(0));
  assert.equal(mixed.admit, false);
  assert.deepEqual(mixed.reasons, ['held_provider', 'snapshot_unavailable']);
  const badTs = LIGHT(snap({ now_ms: undefined, provider_errors: 2 }), R(0));
  assert.deepEqual(badTs.reasons, ['held_provider', 'held_resample']);
});

test('unknown snapshot / sample properties are REJECTED (stricter): snapshot_unavailable', () => {
  assert.equal(LIGHT({ ...snap(), extra: 1 }, R(0)).reason, 'snapshot_unavailable');
  assert.equal(LIGHT(withLatest({ bonus: 1 }), R(0)).reason, 'snapshot_unavailable');
  assert.equal(LIGHT({ ...snap(), schema: 'ship-ticket-host-snapshot-v2' }, R(0)).admit, true);
});

test('never kills: input is not mutated, terminate is always empty, even when unhealthy', () => {
  const s = withLatest({ pressure_level: 4, swap_used_kb100: 9999 * 102400 });
  const running = { total: 5, heavy: 3 };
  const history = { state: 'held', clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: T0 };
  const before = JSON.stringify([s, running, history]);
  const r = admitHost(s, 'HEAVY', running, history);
  assert.equal(JSON.stringify([s, running, history]), before);
  assert.deepEqual(r.terminate, []);
  assert.deepEqual(Object.keys(r).sort(), ['admit', 'history', 'reason', 'reasons', 'signals', 'terminate']);
});

test('no fallback: non-darwin or any invalid snapshot HOLDS, even LIGHT with nothing running; HEAVY too', () => {
  const linux = { schema: HOST_SNAPSHOT_SCHEMA, platform: 'linux', cores: 64, samples: [], provider_errors: [] };
  for (const h of [null, H0]) {
    for (const call of [LIGHT, HEAVY]) {
      const r = call(linux, R(0), h);
      assert.equal(r.admit, false);
      assert.deepEqual(r.reasons, ['snapshot_unavailable']);
    }
  }
});

test('stop signals still get their specific reason first: Linux + 429, darwin pressure 4 with load1 null', () => {
  const l429 = LIGHT({ schema: HOST_SNAPSHOT_SCHEMA, platform: 'linux', cores: 4, samples: [], provider_errors: [{ kind: '429', t_ms: 1 }] }, R(0));
  assert.equal(l429.admit, false);
  assert.deepEqual(l429.reasons, ['held_provider', 'snapshot_unavailable']);
  const p4 = LIGHT(withLatest({ pressure_level: 4, load1: null }), R(0));
  assert.equal(p4.admit, false);
  assert.deepEqual(p4.reasons, ['held_pressure', 'snapshot_unavailable']);
  assert.equal(admitHost(snap(), 'HEAVY', { total: 0, heavy: 3 }, H0).reason, 'invalid_args');
});

test('a VALID darwin snapshot with ONE bad field holds for every bad-field class (cold and open history), never admits', () => {
  const many = Array.from({ length: 17 }, (_, i) => S({ t_ms: T0 + i * 20000 }));
  const bads = {
    provider_kind_500: snap({ provider_errors: [{ kind: '500', t_ms: 1 }] }), cores_5000: snap({ cores: 5000 }), cores_0: snap({ cores: 0 }),
    load15_neg0_01: withLatest({ load15: -0.01 }), samples_17: snap({ samples: many, now_ms: T0 + 16 * 20000 + 1000 }), pressure_3: withLatest({ pressure_level: 3 }),
    swap_neg: withLatest({ swap_used_kb100: -1 }), platform_linux: snap({ platform: 'linux' }), load_string: withLatest({ load1: '1' }),
    swap_growth_load_50_and_bad_cores: withLatest({ swap_used_kb100: 999 * 102400, load1: 50 }),
  };
  bads.swap_growth_load_50_and_bad_cores.cores = 5000;
  for (const [name, s] of Object.entries(bads)) for (const h of [null, H0]) for (const call of [LIGHT, HEAVY]) {
    const r = call(s, R(0), h);
    assert.equal(r.admit, false, name);
    assert.ok(r.reasons.includes('snapshot_unavailable') || r.reasons.includes('held_resample'), name + JSON.stringify(r.reasons));
  }
});

test('history in the future (last_admit_t_ms / last_sample_t_ms > now_ms) or inconsistent with its streak is invalid_args', () => {
  const futureAdmit = { state: 'open', clean_streak: 1, last_admit_t_ms: T0 + 10_000_000, last_sample_t_ms: T0 + 10_000_000 };
  assert.equal(LIGHT(snap(), R(0), futureAdmit).reason, 'invalid_args');
  assert.equal(LIGHT(snap(), R(0), { ...H0, last_sample_t_ms: T0 + 99_999_999 }).reason, 'invalid_args');
  assert.equal(LIGHT(snap(), R(0), { state: 'held', clean_streak: 0, last_admit_t_ms: T0 + 99_999_999, last_sample_t_ms: T0 + 99_999_999 }).reason, 'invalid_args');
});

test('history validation: every malformed history HOLDS with invalid_args and never admits', () => {
  const ok = { state: 'held', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: null };
  const bad = [
    { ...ok, clean_streak: Infinity }, { ...ok, clean_streak: '1' }, { ...ok, clean_streak: 1.5 }, { ...ok, clean_streak: -1 }, { ...ok, clean_streak: NaN },
    { ...ok, state: 'HELD' }, { ...ok, state: 'resumed' }, { state: 'held', clean_streak: 5, last_admit_t_ms: null, last_sample_t_ms: null },
    { ...ok, last_admit_t_ms: NaN }, { ...ok, last_admit_t_ms: 'x' }, { ...ok, last_sample_t_ms: Infinity }, { ...ok, extra: 1 }, 'open', 7, [],
    { state: 'open', clean_streak: 5, last_admit_t_ms: null, last_sample_t_ms: null }, { state: 'open', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: T0 },
    { state: 'held', clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: null }, { ...H0, last_admit_t_ms: T0 + 1 },
  ];
  for (const h of bad) {
    const r = LIGHT(snap(), R(0), h);
    assert.equal(r.admit, false, JSON.stringify(h));
    assert.equal(r.reason, 'invalid_args', JSON.stringify(h));
  }
  assert.deepEqual(admitHost(snap(), 'LIGHT', R(0), undefined).reasons, ['held_hysteresis']);
  assert.equal(LIGHT(snap(), R(0), ok).admit, false);
  assert.equal(LIGHT(snap(), R(0), H0).admit, true);
});

test('positional contract: wrong shapes hold with invalid_args (an options object in position 2 is NOT accepted)', () => {
  const calls = [
    () => admitHost(snap(), { cls: 'LIGHT' }), () => admitHost(snap(), 'MEDIUM', R(0)), () => admitHost(snap(), undefined, R(0)),
    () => admitHost(snap(), 'LIGHT', { total: -1, heavy: 0 }), () => admitHost(snap(), 'LIGHT', { total: 1.5, heavy: 0 }), () => admitHost(snap(), 'LIGHT', { total: '1', heavy: 0 }),
    () => admitHost(snap(), 'LIGHT', { total: 1 }), () => admitHost(snap(), 'LIGHT', null), () => admitHost(snap(), 'LIGHT', 5), () => admitHost(null, 'LIGHT', R(0)),
    () => admitHost('x', 'LIGHT', R(0)), () => admitHost(snap(), 'HEAVY', { total: 5, heavy: 5 }, { state: 'held' , clean_streak: 9 }),
  ];
  for (const [i, c] of calls.entries()) {
    const r = c();
    assert.equal(r.admit, false, 'call ' + i);
    assert.equal(r.reason, 'invalid_args', 'call ' + i);
  }
  // the previously mis-accepted shape: options in position 2, history-like in 4
  assert.equal(admitHost(snap(), 'HEAVY', { total: 5, heavy: 5 }, { state: 'held', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: null }).admit, false);
});

test('range validation: pressure outside {1,2,4}, bad loads, bad cores, bad swap values never read as healthy', () => {
  for (const level of [0, -3, 3, 5, 1.5, '1']) assert.equal(LIGHT(withLatest({ pressure_level: level }), R(0)).reason, 'snapshot_unavailable', 'p' + level);
  for (const v of [-1, NaN, Infinity, '1']) for (const k of ['load1', 'load5', 'load15']) assert.equal(LIGHT(withLatest({ [k]: v }), R(0)).reason, 'snapshot_unavailable', k + v);
  for (const cores of [0, -2, 1e9, 4.5, '8', NaN, undefined]) assert.equal(LIGHT(snap({ cores }), R(0)).reason, 'snapshot_unavailable', 'c' + cores);
  for (const swap_used_kb100 of [-1, '3', NaN, Infinity, 1.5, 2 ** 60, null, undefined]) assert.equal(LIGHT(withLatest({ swap_used_kb100 }), R(0)).reason, 'snapshot_unavailable', 's' + swap_used_kb100);
  assert.equal(LIGHT(withLatest({ swapouts: 100, swap_used_kb100: undefined }), R(0)).reason, 'snapshot_unavailable');   // the old field is gone (unknown key)
});

test('EARLIER high load in the window is not forgotten: 6.01 then 5.99 (10 cores) holds even after a stale open history', () => {
  const stale = { state: 'open', clean_streak: 3, last_admit_t_ms: null, last_sample_t_ms: T0 - 900_000 };
  const s = snap({ samples: [S({ load15: 6.01 }), S({ t_ms: T0 + 20000, load15: 5.99 })] });
  for (const h of [stale, H0, null]) {
    const r = LIGHT(s, R(0), h);
    assert.equal(r.admit, false);
    assert.deepEqual(r.reasons, ['held_load']);
  }
  for (const k of ['load1', 'load5', 'load15']) assert.deepEqual(LIGHT(snap({ samples: [S({ [k]: 6 }), S({ t_ms: T0 + 20000 })] }), R(0)).reasons, ['held_load'], k);
  // after the stop, a stale-open host still needs TWO clean spaced samples (cold start), not one
  const clean = snap({ samples: [S({ t_ms: T0 }), S({ t_ms: T0 + 20000 })] });
  assert.deepEqual(LIGHT(clean, R(0), stale).reasons, ['held_hysteresis']);
});

test('schema is REQUIRED and EXACT: missing, null, {}, garbage, unknown versions and wrong types are snapshot_unavailable', () => {
  assert.equal(HOST_SNAPSHOT_SCHEMA, 'ship-ticket-host-snapshot-v2');
  for (const schema of [undefined, null, {}, [], 'garbage', 'ship-ticket-host-snapshot-v1', 'ship-ticket-host-snapshot-v3', 'SHIP-TICKET-HOST-SNAPSHOT-V2', 1, '']) for (const call of [LIGHT, HEAVY]) {
    const r = call({ ...snap(), schema }, R(0));
    assert.equal(r.admit, false, String(schema));
    assert.deepEqual(r.reasons, ['snapshot_unavailable'], String(schema));
  }
  const { schema, ...noSchema } = snap();
  assert.deepEqual(LIGHT(noSchema, R(0)).reasons, ['snapshot_unavailable']);
  assert.equal(LIGHT(snap(), R(0)).admit, true);
});

const SW = 'total = 7168.00M  used = 6743.31M  free = 424.69M  (encrypted)\n';
test('parser table (parseSwapUsedKb100): ONE whole-output grammar; every extra/duplicated/reordered/multi-line/CR/NUL/unicode/huge/negative output is null', () => {
  assert.equal(parseSwapUsedKb100(SW), 674331 * 1024);                                             // the real output on this host, exact hundredths of KB
  assert.equal(parseSwapUsedKb100(SW.slice(0, -1)), 674331 * 1024);                                // no trailing newline
  assert.equal(parseSwapUsedKb100('total = 7168.00M  used = 6743.31M  free = 424.69M\n'), 674331 * 1024);   // (encrypted) is the ONLY optional part
  assert.equal(parseSwapUsedKb100('total = 0.00M  used = 0.00M  free = 0.00M\n'), 0);
  assert.equal(parseSwapUsedKb100('total = 2.00G  used = 512.00M  free = 1536.00M\n'), 512 * 102400);
  assert.equal(parseSwapUsedKb100('total = 2048.00K  used = 1024.00K  free = 1024.00K\n'), 102400);
  assert.equal(parseSwapUsedKb100('total = 1.00G  used = 1.00G  free = 0.00M\n'), 1024 * 102400);
  assert.equal(parseSwapUsedKb100('total = 85899345.91G  used = 85899345.91G  free = 0.00G\n'), 8589934591 * 1048576);   // near 2^53, still exact
  for (const n of ['total = 85899345.92G  used = 85899345.92G  free = 0.00G\n', 'total = 99999999.99G  used = 99999999.99G  free = 0.00G\n', 'total = 999999999.99G  used = 1.00G  free = 999999998.99G\n'])
    assert.equal(parseSwapUsedKb100(n), null, n);                                                  // beyond the safe-integer range: rejected, never rounded
  // arithmetic consistency is EXACT: used <= total and total === used + free in every unit, no tolerance
  for (const u of ['K', 'M', 'G']) {
    assert.equal(parseSwapUsedKb100('total = 10.00' + u + '  used = 4.00' + u + '  free = 6.00' + u + '\n') !== null, true, u);
    for (const free of ['5.99', '6.01', '6.00'.replace('6.00', '7.00')]) assert.equal(parseSwapUsedKb100('total = 10.00' + u + '  used = 4.00' + u + '  free = ' + free + u + '\n'), null, u + free);
    assert.equal(parseSwapUsedKb100('total = 0.00' + u + '  used = 0.01' + u + '  free = 0.00' + u + '\n'), null, 'used 0.01 > total 0.00 ' + u);
    assert.equal(parseSwapUsedKb100('total = 4.00' + u + '  used = 4.01' + u + '  free = 0.00' + u + '\n'), null, 'used > total by one hundredth ' + u);
    assert.equal(parseSwapUsedKb100('total = 4.00' + u + '  used = 4.00' + u + '  free = 0.01' + u + '\n'), null, 'sum exceeds total by one hundredth ' + u);
  }
  // float-hostile sums must stay exact: 0.1 + 0.2 !== 0.3 in floating point, but these are exact hundredths
  assert.equal(parseSwapUsedKb100('total = 0.30M  used = 0.10M  free = 0.20M\n'), 10 * 1024);
  assert.equal(parseSwapUsedKb100('total = 0.30G  used = 0.10G  free = 0.20G\n'), 10 * 1048576);
  assert.equal(parseSwapUsedKb100('total = 1.15K  used = 0.57K  free = 0.58K\n'), 57);
  assert.equal(parseSwapUsedKb100('total = 4.35M  used = 1.45M  free = 2.90M\n'), 145 * 1024);
  assert.equal(parseSwapUsedKb100('total = 0.00K  used = 10.00K  free = 0.00K\n'), null);          // Codex counterexample 1
  assert.equal(parseSwapUsedKb100('total = 1.00M  used = 1.00M  free = 0.00K\n'), 102400);         // mixed units compare exactly
  assert.equal(parseSwapUsedKb100('total = 1.00M  used = 1023.99K  free = 0.01K\n'), 102399);      // 1023.99 + 0.01 = 1024.00 KB = 1.00 MB exactly
  assert.equal(parseSwapUsedKb100('total = 1.00M  used = 1023.99K  free = 0.02K\n'), null);
  const bad = {
    empty: '', newline_only: '\n', two_lines: SW + SW, trailing_record: SW + 'extra\n', leading_record: 'x\n' + SW, blank_line_after: SW + '\n', blank_line_before: '\n' + SW,
    second_valid_hidden_growth: 'total = 7168.00M  used = 100.00M  free = 7068.00M  (encrypted)\ntotal = 7168.00M  used = 900.00M  free = 6268.00M  (encrypted)\n',
    cr_inside: 'total = 7168.00M  used = 6743.31M\r  free = 424.69M  (encrypted)\n', cr_at_end: SW.slice(0, -1) + '\r\n', cr_between_records: 'total = 7168.00M  used = 6743.31M  free = 424.69M  (encrypted)\r' + SW,
    nul: 'total = 7168.00M  used = 6743.31M  free = 424.69M\0\n', nul_prefix: '\0' + SW, unicode_digit: 'total = ٧168.00M  used = 6743.31M  free = 424.69M\n', unicode_space: 'total = 7168.00M  used = 6743.31M  free = 424.69M\n',
    negative: 'total = 7168.00M  used = -6743.31M  free = 424.69M\n', huge: 'total = 99999999999.00M  used = 6743.31M  free = 424.69M\n', oversize: SW.repeat(100),
    single_spaces: 'total = 7168.00M used = 6743.31M free = 424.69M\n',
    single_space_before_used: 'total = 7168.00M used = 6743.31M  free = 424.69M\n', single_space_before_free: 'total = 7168.00M  used = 6743.31M free = 424.69M\n', three_spaces: 'total = 7168.00M   used = 6743.31M  free = 424.69M\n', single_space_before_encrypted: 'total = 7168.00M  used = 6743.31M  free = 424.69M (encrypted)\n', three_spaces_before_encrypted: 'total = 7168.00M  used = 6743.31M  free = 424.69M   (encrypted)\n', tab: 'total = 7168.00M\tused = 6743.31M  free = 424.69M\n', leading_space: ' ' + SW, trailing_space: SW.slice(0, -1) + ' \n',
    bad_unit: 'total = 7168.00T  used = 6743.31M  free = 424.69M\n', lower_unit: 'total = 7168.00m  used = 6743.31M  free = 424.69M\n', no_unit: 'total = 7168.00  used = 6743.31  free = 424.69\n',
    one_decimal: 'total = 7168.0M  used = 6743.3M  free = 424.6M\n', three_decimals: 'total = 7168.000M  used = 6743.310M  free = 424.690M\n', no_decimals: 'total = 7168M  used = 6743M  free = 424M\n',
    exponent: 'total = 7.1e3M  used = 6743.31M  free = 424.69M\n', leading_zero: 'total = 07168.00M  used = 6743.31M  free = 424.69M\n', comma_decimal: 'total = 7168,00M  used = 6743,31M  free = 424,69M\n',
    used_gt_total: 'total = 100.00M  used = 200.00M  free = 0.00M\n', reordered: 'used = 6743.31M  total = 7168.00M  free = 424.69M\n', missing_free: 'total = 7168.00M  used = 6743.31M\n',
    missing_used: 'total = 7168.00M  free = 424.69M\n', extra_field: 'total = 7168.00M  used = 6743.31M  free = 424.69M  extra = 1.00M\n', other_suffix: 'total = 7168.00M  used = 6743.31M  free = 424.69M  (decrypted)\n',
    suffix_twice: 'total = 7168.00M  used = 6743.31M  free = 424.69M  (encrypted)  (encrypted)\n', prefix_garbage: 'xtotal = 7168.00M  used = 6743.31M  free = 424.69M\n', suffix_garbage: SW.slice(0, -1) + 'x\n',
    two_newlines: SW + '\n\n', case_diff: 'Total = 7168.00M  used = 6743.31M  free = 424.69M\n', fullwidth: 'total = ７１６８.00M  used = 6743.31M  free = 424.69M\n',
  };
  for (const [name, out] of Object.entries(bad)) assert.equal(parseSwapUsedKb100(out), null, name);
  for (const nonString of [null, undefined, 5, {}, [], Buffer.from(SW)]) assert.equal(parseSwapUsedKb100(nonString), null);
});

test('parser table (parsePressure): ONE whole-output grammar /^[124]\\n?$/; everything else (0, 3, 5, multi-line, CR, NUL, unicode, huge, negative) is null', () => {
  for (const [out, v] of [['1\n', 1], ['2', 2], ['4\n', 4], ['1', 1]]) assert.equal(parsePressure(out), v, JSON.stringify(out));
  const bad = ['', '\n', '0\n', '3\n', '5', '8', '-1', '1\n1\n', '1\n\n', '1\n2', '2\n1\n4\n', ' 1', '1 ', '1garbage', '1\r\n', '1\r', '\r1', '01', '1.0', '١', '１', '1\0', '\0 1\n', 'x\n1', '9'.repeat(40), '99999999999999999999\n', '1\n'.repeat(1000), '12', '14\n', '1e0', '+1', '1​', 'a1', '1a', '\n1'];
  for (const out of bad) assert.equal(parsePressure(out), null, JSON.stringify(out));
  for (const nonString of [null, undefined, 1, {}, [], Buffer.from('1\n')]) assert.equal(parsePressure(nonString), null);
});

test('hostSnapshot wires the strict parsers: a second swap record or multi-line sysctl output yields null fields that hold', async () => {
  const mk = (o) => hostSnapshot({ platform: 'darwin', exec: fakeExec([], o), now: (() => { let t = 0; return () => (t += 20000); })(), sleep: async () => {}, loadavg: () => [1, 1, 1], cpus: () => new Array(4) });
  const dup = await mk({ swap: () => 'total = 7168.00M  used = 100.00M  free = 7068.00M\ntotal = 7168.00M  used = 900.00M  free = 6268.00M\n' });
  assert.deepEqual(dup.samples.map(x => x.swap_used_kb100), [null, null]);
  assert.equal(LIGHT(dup, R(0), null).reason, 'snapshot_unavailable');
  assert.equal(HEAVY(dup, R(0), null).admit, false);
  const multi = await mk({ pressure: '1\n4\n' });
  assert.equal(multi.samples[0].pressure_level, null);
  assert.equal(HEAVY(multi, R(0), null).admit, false);
  const badLoad = await hostSnapshot({ platform: 'darwin', exec: fakeExec([]), now: (() => { let t = 0; return () => (t += 20000); })(), sleep: async () => {}, loadavg: () => [1, 1], cpus: () => new Array(4) });
  assert.equal(badLoad.samples[0].load1, null);
  assert.equal(LIGHT(badLoad, R(0), null).reason, 'snapshot_unavailable');
  assert.equal((await mk({})).schema, HOST_SNAPSHOT_SCHEMA);
  assert.equal(HOST_SNAPSHOT_SCHEMA, 'ship-ticket-host-snapshot-v2');
});

test('Codex counterexamples end to end: no admit through cold start for used > total, and growth just above 2 MB is never rounded to flat', async () => {
  const mk = (swapOuts) => { let n = 0; return hostSnapshot({ platform: 'darwin', exec: (cmd, args) => (args[1] === 'vm.swapusage' ? swapOuts[n++] : '1\n'), now: (() => { let t = 0; return () => (t += 20000); })(), sleep: async () => {}, loadavg: () => [1, 1, 1], cpus: () => new Array(10) }); };
  const bad = await mk(['total = 0.00K  used = 10.00K  free = 0.00K\n', 'total = 0.00K  used = 10.00K  free = 0.00K\n']);
  assert.deepEqual(bad.samples.map(x => x.swap_used_kb100), [null, null]);
  const c1 = HEAVY(bad, R(0), null); const c2 = HEAVY(bad, R(0), c1.history);
  assert.equal(c1.admit, false); assert.equal(c2.admit, false);
  const k = async (u0, u1) => admitHost(await mk([`total = 8192.00K  used = ${u0}.00K  free = ${8192 - u0}.00K\n`, `total = 8192.00K  used = ${u1}.00K  free = ${8192 - u1}.00K\n`]), 'LIGHT', R(0), null);
  assert.deepEqual((await k(0, 2052)).reasons, ['held_swap']);                                      // 2.0039 MB: was rounded to 2 MB = flat
  assert.deepEqual((await k(0, 2049)).reasons, ['held_swap']);
  assert.deepEqual((await k(0, 2048)).reasons, ['held_hysteresis']);                                // exactly 2 MB: flat (cold start still needs two samples)
  assert.deepEqual((await k(0, 2047)).reasons, ['held_hysteresis']);
});

test('swap tolerance boundary through the parser for every unit: exactly 2 MB is flat, one hundredth of the unit above holds', () => {
  const kb = (n) => parseSwapUsedKb100('total = 99999.00K  used = ' + n + 'K  free = ' + (99999 - n).toFixed(2) + 'K\n');
  assert.equal(kb('0.00'), 0);
  const w = (a, b) => snap({ samples: [S({ swap_used_kb100: a }), S({ t_ms: T0 + 20000, swap_used_kb100: b })] });
  const mUsed = (x) => parseSwapUsedKb100('total = 99999.00M  used = ' + x + 'M  free = ' + (99999 - x).toFixed(2) + 'M\n');
  const gUsed = (x) => parseSwapUsedKb100('total = 99999.00G  used = ' + x + 'G  free = ' + (99999 - x).toFixed(2) + 'G\n');
  assert.equal(LIGHT(w(mUsed('10.00'), mUsed('12.00')), R(0)).admit, true);                        // M: exactly 2.00 MB
  assert.deepEqual(LIGHT(w(mUsed('10.00'), mUsed('12.01')), R(0)).reasons, ['held_swap']);           // M: tolerance + 0.01
  assert.equal(LIGHT(w(kb('10.00'), kb('2058.00')), R(0)).admit, true);                             // K: exactly 2048 KB
  assert.deepEqual(LIGHT(w(kb('10.00'), kb('2058.01')), R(0)).reasons, ['held_swap']);               // K: tolerance + 0.01 KB
  assert.deepEqual(LIGHT(w(gUsed('1.00'), gUsed('1.01')), R(0)).reasons, ['held_swap']);             // G: one hundredth of a GB (10.24 MB) is growth
  assert.equal(LIGHT(w(gUsed('1.00'), gUsed('1.00')), R(0)).admit, true);
});

test('load threshold is exact: 5*load >= 3*cores (kernel loadavg is fixed-point 1/2048); boundaries for 3, 10 and 7 cores', () => {
  const at = (cores, load) => LIGHT(snap({ cores, samples: [S({ load1: load }), S({ t_ms: T0 + 20000, load1: load })] }), R(0));
  assert.equal(at(10, 6).admit, false);                          // 6.0 >= 6.0
  assert.equal(at(10, 6 - 1 / 2048).admit, true);
  assert.equal(at(3, 1.80078125).admit, false);                  // 3688/2048 > 1.8
  assert.equal(at(3, 1.7998046875).admit, true);                 // 3686/2048 < 1.8
  assert.equal(at(7, 4.2001953125).admit, false);                // 8602/2048 > 4.2
  assert.equal(at(7, 4.19921875).admit, true);                   // 8600/2048 < 4.2
  assert.equal(at(1, 0.6).admit, false);                         // 0.6 as a double is >= 3/5 within one ulp (documented)
});


test('reason codes are the documented set', () => {
  assert.deepEqual([...HOST_HOLD_REASONS], ['held_pressure', 'held_swap', 'held_load', 'held_provider', 'held_heavy', 'held_hysteresis', 'held_resample', 'snapshot_unavailable', 'invalid_args']);
  assert.equal(HOST_POLICY.clean_samples_to_resume, 2);
});

function fakeExec(log, { pressure = '1\n', swap = n => 'total = 7168.00M  used = ' + (10 + 5 * n).toFixed(2) + 'M  free = ' + (7168 - 10 - 5 * n).toFixed(2) + 'M  (encrypted)\n' } = {}) {
  let n = 0;
  return (cmd, args) => {
    log.push(cmd + ' ' + (args ?? []).join(' '));
    if (cmd !== '/usr/sbin/sysctl' || args?.[0] !== '-n') return null;
    if (args[1] === 'kern.memorystatus_vm_pressure_level') return pressure;
    if (args[1] === 'vm.swapusage') return swap(n++);
    return null;
  };
}

test('hostSnapshot uses ABSOLUTE tool paths, injected clock/sleep, reads no process table, and feeds admitHost', async () => {
  const calls = []; const sleeps = []; let t = 5000;
  const s = await hostSnapshot({ platform: 'darwin', exec: fakeExec(calls), now: () => (t += 20000), sleep: async ms => { sleeps.push(ms); }, loadavg: () => [1, 2, 3], cpus: () => new Array(8), providerErrors: [{ kind: '429', t_ms: 1 }] });
  assert.ok(calls.every(c => c.startsWith('/usr/sbin/sysctl -n ')), calls.join());
  assert.deepEqual([...new Set(calls)].sort(), ['/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', '/usr/sbin/sysctl -n vm.swapusage']);
  assert.deepEqual(sleeps, [20000]);
  assert.equal(s.cores, 8);
  assert.deepEqual(s.samples.map(x => [x.t_ms, x.pressure_level, x.swap_used_kb100, x.load1, x.load5, x.load15]), [[25000, 1, 10 * 102400, 1, 2, 3], [45000, 1, 15 * 102400, 1, 2, 3]]);
  assert.equal(Object.hasOwn(s, 'heavy_processes'), false);
  assert.equal(s.now_ms, 65000);
  assert.deepEqual(LIGHT(s, R(0), null).reasons, ['held_swap', 'held_provider']);
});

test('hostSnapshot parses strictly: garbled sysctl output becomes null fields, which hold', async () => {
  const mk = (o) => hostSnapshot({ platform: 'darwin', exec: fakeExec([], o), now: (() => { let t = 0; return () => (t += 20000); })(), sleep: async () => {}, loadavg: () => [1, 1, 1], cpus: () => new Array(4) });
  const g1 = await mk({ pressure: '1garbage\n' });
  assert.equal(g1.samples[0].pressure_level, null);
  assert.equal(LIGHT(g1, R(0)).reason, 'snapshot_unavailable');
  const g2 = await mk({ swap: () => 'total = 7168.00M  used = 100garbage  free = 1.00M\n' });
  assert.equal(g2.samples[0].swap_used_kb100, null);
  assert.equal(LIGHT(g2, R(0)).reason, 'snapshot_unavailable');
  const g3 = await mk({ swap: () => 'xtotal = 7168.00M  used = 1.00M  free = 1.00M\n' });
  assert.equal(g3.samples[0].swap_used_kb100, null);
});

test('hostSnapshot on non-darwin does no reading and the result is the fail-safe fallback', async () => {
  const none = await hostSnapshot({ platform: 'linux', exec: () => { throw new Error('must not read'); }, cpus: () => new Array(2) });
  assert.deepEqual(none.samples, []);
  assert.equal(LIGHT(none, R(0)).reason, 'snapshot_unavailable');
});
