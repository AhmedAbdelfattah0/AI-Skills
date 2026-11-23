import test from 'node:test';
import assert from 'node:assert/strict';
import { admitHost, hostSnapshot, HOST_POLICY, HOST_HOLD_REASONS } from './harness.mjs';

// Injected clock: samples are 20 s apart (inside the accepted 15..30 s window); now_ms is 1 s after the latest.
const T0 = 1_000_000;
const S = (o = {}) => ({ t_ms: T0, pressure_level: 1, swapouts: 100, load1: 1, load5: 1, load15: 1, ...o });
const snap = (o = {}) => ({ platform: 'darwin', cores: 10, now_ms: T0 + 21000, samples: [S(), S({ t_ms: T0 + 20000 })], provider_errors: [], ...o });
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

test('pressure 2 and 4 hold with held_pressure; pressure 1 is healthy; an EARLIER sample at 4 is not ignored', () => {
  for (const level of [2, 4]) {
    const r = LIGHT(withLatest({ pressure_level: level }), R(0));
    assert.deepEqual(r.reasons, ['held_pressure']);
    assert.equal(r.reason, 'held_pressure');
  }
  assert.equal(LIGHT(withLatest({ pressure_level: 1 }), R(0)).admit, true);
  const early = LIGHT(snap({ samples: [S({ pressure_level: 4 }), S({ t_ms: T0 + 20000 })] }), R(0));
  assert.deepEqual(early.reasons, ['held_pressure']);
});

test('swapouts growth holds with held_swap; flat swap admits even when the absolute value is huge', () => {
  const grow = LIGHT(withLatest({ swapouts: 101 }), R(0));
  assert.deepEqual(grow.reasons, ['held_swap']);
  assert.equal(grow.signals.swap, 'growing');
  const flat = LIGHT(snap({ samples: [S({ swapouts: 9_000_000 }), S({ t_ms: T0 + 20000, swapouts: 9_000_000 })] }), R(0));
  assert.equal(flat.admit, true);
  assert.equal(flat.signals.swap, 'flat');
});

test('swap growth in a MIDDLE pair is still growth', () => {
  const s = snap({ samples: [S({ swapouts: 5 }), S({ t_ms: T0 + 20000, swapouts: 9 }), S({ t_ms: T0 + 40000, swapouts: 9 })], now_ms: T0 + 41000 });
  assert.deepEqual(LIGHT(s, R(0)).reasons, ['held_swap']);
});

test('a falling, wrapped or reset swap counter is never flat: held_swap (regressed); negatives are unavailable', () => {
  const fall = LIGHT(snap({ samples: [S({ swapouts: 500 }), S({ t_ms: T0 + 20000, swapouts: 100 })] }), R(0));
  assert.deepEqual(fall.reasons, ['held_swap']);
  assert.equal(fall.signals.swap, 'regressed');
  const neg = LIGHT(snap({ samples: [S({ swapouts: -5 }), S({ t_ms: T0 + 20000, swapouts: -5 })] }), R(0));
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
  const sigs = { held_pressure: { pressure_level: 2 }, held_swap: { swapouts: 999 }, held_load: { load5: 9 } };
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
  const bad = LIGHT(withLatest({ pressure_level: 2 }), R(0));
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
  const bad = LIGHT(withLatest({ pressure_level: 2 }), R(0));
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
  const bad = LIGHT(withLatest({ swapouts: 500 }), R(0));
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
  const bad = HEAVY(withLatest({ pressure_level: 2 }), R(1, 1));
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
  const bads = [{ pressure_level: 4 }, { load5: 50 }, { swapouts: 101 }];
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
  // state 'open': a long gap is NOT a restart: a healthy poller at 31 s, 60 s or much slower still admits (both sides of 30 s)
  const open = LIGHT(snap(), R(0));                             // open history, last_sample T0 + 20000
  for (const g of [30000, 30001, 60000, 3_600_000]) {
    const r = admitHost(snap({ now_ms: T0 + 20000 + g + 1000, samples: [S({ t_ms: T0 + g }), S({ t_ms: T0 + 20000 + g })] }), 'LIGHT', R(0), open.history);
    assert.equal(r.admit, true, 'gap ' + g);
    assert.equal(r.history.state, 'open');
  }
  // ... but a stop signal after a long gap still blocks and resets, and recovery then needs two consecutive samples again
  const hit = admitHost(snap({ now_ms: T0 + 80000 + 1000, samples: [S({ t_ms: T0 + 60000 }), S({ t_ms: T0 + 80000, pressure_level: 2 })] }), 'LIGHT', R(0), open.history);
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
  assert.equal(LIGHT({ ...snap(), schema: 'ship-ticket-host-snapshot-v1' }, R(0)).admit, true);
});

test('never kills: input is not mutated, terminate is always empty, even when unhealthy', () => {
  const s = withLatest({ pressure_level: 4, swapouts: 9999 });
  const running = { total: 5, heavy: 3 };
  const history = { state: 'held', clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: T0 };
  const before = JSON.stringify([s, running, history]);
  const r = admitHost(s, 'HEAVY', running, history);
  assert.equal(JSON.stringify([s, running, history]), before);
  assert.deepEqual(r.terminate, []);
  assert.deepEqual(Object.keys(r).sort(), ['admit', 'history', 'reason', 'reasons', 'signals', 'terminate']);
});

test('no fallback: non-darwin or any invalid snapshot HOLDS, even LIGHT with nothing running; HEAVY too', () => {
  const linux = { platform: 'linux', cores: 64, samples: [], provider_errors: [] };
  for (const h of [null, H0]) {
    for (const call of [LIGHT, HEAVY]) {
      const r = call(linux, R(0), h);
      assert.equal(r.admit, false);
      assert.deepEqual(r.reasons, ['snapshot_unavailable']);
    }
  }
});

test('stop signals still get their specific reason first: Linux + 429, darwin pressure 4 with load1 null', () => {
  const l429 = LIGHT({ platform: 'linux', cores: 4, samples: [], provider_errors: [{ kind: '429', t_ms: 1 }] }, R(0));
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
    swap_neg: withLatest({ swapouts: -1 }), platform_linux: snap({ platform: 'linux' }), load_string: withLatest({ load1: '1' }),
    swap_growth_load_50_and_bad_cores: withLatest({ swapouts: 999, load1: 50 }),
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
  for (const swapouts of [-1, 1.5, '3', NaN, Infinity]) assert.equal(LIGHT(withLatest({ swapouts }), R(0)).reason, 'snapshot_unavailable', 's' + swapouts);
});

test('reason codes are the documented set', () => {
  assert.deepEqual([...HOST_HOLD_REASONS], ['held_pressure', 'held_swap', 'held_load', 'held_provider', 'held_heavy', 'held_hysteresis', 'held_resample', 'snapshot_unavailable', 'invalid_args']);
  assert.equal(HOST_POLICY.clean_samples_to_resume, 2);
});

function fakeExec(log, { pressure = '1\n', vm = n => 'Pages free: 1.\nSwapouts:   ' + n + '.\n' } = {}) {
  let swap = 10;
  return (cmd) => {
    log.push(cmd);
    if (cmd === '/usr/sbin/sysctl') return pressure;
    if (cmd === '/usr/bin/vm_stat') return vm(swap++);
    return null;
  };
}

test('hostSnapshot uses ABSOLUTE tool paths, injected clock/sleep, reads no process table, and feeds admitHost', async () => {
  const calls = []; const sleeps = []; let t = 5000;
  const s = await hostSnapshot({ platform: 'darwin', exec: fakeExec(calls), now: () => (t += 20000), sleep: async ms => { sleeps.push(ms); }, loadavg: () => [1, 2, 3], cpus: () => new Array(8), providerErrors: [{ kind: '429', t_ms: 1 }] });
  assert.ok(calls.every(c => c.startsWith('/')), calls.join());
  assert.deepEqual([...new Set(calls)].sort(), ['/usr/bin/vm_stat', '/usr/sbin/sysctl']);
  assert.deepEqual(sleeps, [20000]);
  assert.equal(s.cores, 8);
  assert.deepEqual(s.samples.map(x => [x.t_ms, x.pressure_level, x.swapouts, x.load1, x.load5, x.load15]), [[25000, 1, 10, 1, 2, 3], [45000, 1, 11, 1, 2, 3]]);
  assert.equal(Object.hasOwn(s, 'heavy_processes'), false);
  assert.equal(s.now_ms, 65000);
  assert.deepEqual(LIGHT(s, R(0), null).reasons, ['held_swap', 'held_provider']);
});

test('hostSnapshot parses strictly: garbled sysctl or vm_stat output becomes null fields, which hold', async () => {
  const mk = (o) => hostSnapshot({ platform: 'darwin', exec: fakeExec([], o), now: (() => { let t = 0; return () => (t += 20000); })(), sleep: async () => {}, loadavg: () => [1, 1, 1], cpus: () => new Array(4) });
  const g1 = await mk({ pressure: '1garbage\n' });
  assert.equal(g1.samples[0].pressure_level, null);
  assert.equal(LIGHT(g1, R(0)).reason, 'snapshot_unavailable');
  const g2 = await mk({ vm: () => 'Swapouts:   100garbage.\n' });
  assert.equal(g2.samples[0].swapouts, null);
  assert.equal(LIGHT(g2, R(0)).reason, 'snapshot_unavailable');
  const g3 = await mk({ vm: () => 'xSwapouts: 5.\n' });
  assert.equal(g3.samples[0].swapouts, null);
});

test('hostSnapshot on non-darwin does no reading and the result is the fail-safe fallback', async () => {
  const none = await hostSnapshot({ platform: 'linux', exec: () => { throw new Error('must not read'); }, cpus: () => new Array(2) });
  assert.deepEqual(none.samples, []);
  assert.equal(LIGHT(none, R(0)).reason, 'snapshot_unavailable');
});
