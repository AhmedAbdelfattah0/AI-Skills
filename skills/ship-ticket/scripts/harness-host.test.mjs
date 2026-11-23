import test from 'node:test';
import assert from 'node:assert/strict';
import { admitHost, hostSnapshot, countHeavyRoots, HOST_POLICY, HOST_HOLD_REASONS } from './harness.mjs';

// Injected clock: samples are 20 s apart (inside the accepted 15..30 s window); now_ms is 1 s after the latest.
const T0 = 1_000_000;
const S = (o = {}) => ({ t_ms: T0, pressure_level: 1, swapouts: 100, load1: 1, load5: 1, load15: 1, ...o });
const snap = (o = {}) => ({ platform: 'darwin', cores: 10, now_ms: T0 + 21000, samples: [S(), S({ t_ms: T0 + 20000 })], heavy_processes: 0, provider_errors: [], ...o });
const withLatest = (o) => snap({ samples: [S(), S({ t_ms: T0 + 20000, ...o })] });
// The n-th later snapshot (distinct, strictly increasing timestamps).
const NEXT = (n, o = {}) => snap({ now_ms: T0 + 21000 + n * 20000, samples: [S({ t_ms: T0 + n * 20000 }), S({ t_ms: T0 + 20000 + n * 20000, ...o })] });
const LIGHT = (s, running, history) => admitHost(s, 'LIGHT', running, history);
const HEAVY = (s, running, history) => admitHost(s, 'HEAVY', running, history);
const R = (total, heavy = 0) => ({ total, heavy });

test('healthy host admits one LIGHT task with reason admitted', () => {
  const r = LIGHT(snap(), R(0));
  assert.equal(r.admit, true);
  assert.equal(r.reason, 'admitted');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.signals.healthy, true);
  assert.deepEqual(r.history, { state: 'open', clean_streak: 1, last_admit_t_ms: T0 + 20000, last_sample_t_ms: T0 + 20000 });
  assert.deepEqual(r.terminate, []);
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
  const neg = LIGHT(snap({ samples: [S({ swapouts: -5 }), S({ t_ms: T0 + 20000, swapouts: -5 })] }), R(1));
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
    const r = LIGHT(snap({ provider_errors: bad }), R(1));
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
  // An OLDER snapshot is a replay too.
  assert.deepEqual(LIGHT(NEXT(0), R(0), clean1.history).reasons, ['held_resample']);
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
  const rec = HEAVY(snap(), R(1, 1), { state: 'held', clean_streak: 0 });
  assert.equal(rec.signals.heavy_slots, 1);
  assert.deepEqual(rec.reasons, ['held_hysteresis', 'held_heavy']);
  const bad = HEAVY(withLatest({ pressure_level: 2 }), R(1, 1));
  assert.equal(bad.signals.heavy_slots, 1);
  assert.deepEqual(bad.reasons, ['held_pressure', 'held_heavy']);
});

test('heavy count: external processes count, LIGHT is not held; an UNKNOWN count (null/NaN/negative) holds HEAVY and is never treated as 0', () => {
  assert.deepEqual(HEAVY(snap({ heavy_processes: 2 }), R(0)).reasons, ['held_heavy']);
  assert.equal(LIGHT(snap({ heavy_processes: 2 }), R(0)).admit, true);
  for (const unknown of [null, undefined, NaN, -1, 1.5, '0']) {
    const r = HEAVY(snap({ heavy_processes: unknown }), R(0));
    assert.deepEqual(r.reasons, ['held_heavy'], String(unknown));
    assert.equal(LIGHT(snap({ heavy_processes: unknown }), R(0)).admit, true, 'LIGHT ' + String(unknown));
  }
});

test('countHeavyRoots counts suite roots, not processes: one suite with children = 1; two suites = 2', () => {
  const ps = [' 10 1 node --test a.test.mjs', ' 11 10 node b.test.mjs', ' 12 11 node c.test.mjs', ' 20 1 /usr/bin/vim', ' 30 1 stryker run', ' 31 30 node x.test.mjs'].join('\n');
  assert.equal(countHeavyRoots(ps), 2);
  assert.equal(countHeavyRoots(' 20 1 /usr/bin/vim\n'), 0);
});

test('never kills: input is not mutated, terminate is always empty, even when unhealthy', () => {
  const s = withLatest({ pressure_level: 4, swapouts: 9999 });
  const running = { total: 5, heavy: 3 };
  const history = { state: 'held', clean_streak: 1, last_admit_t_ms: null, last_sample_t_ms: null };
  const before = JSON.stringify([s, running, history]);
  const r = admitHost(s, 'HEAVY', running, history);
  assert.equal(JSON.stringify([s, running, history]), before);
  assert.deepEqual(r.terminate, []);
  assert.deepEqual(Object.keys(r).sort(), ['admit', 'history', 'reason', 'reasons', 'signals', 'terminate']);
});

test('fallback (non-darwin): admits ONE LIGHT task only when no stop signal; never HEAVY, never while anything runs', () => {
  const linux = { platform: 'linux', cores: 64, samples: [], heavy_processes: null, provider_errors: [] };
  const first = LIGHT(linux, R(0));
  assert.equal(first.admit, true);
  assert.equal(first.reason, 'snapshot_unavailable');
  assert.equal(first.signals.heavy_slots, 1);
  assert.equal(LIGHT(linux, R(1)).admit, false);
  assert.equal(HEAVY(linux, R(0)).admit, false);
  assert.equal(HEAVY(linux, R(0)).reason, 'snapshot_unavailable');
});

test('fallback never ignores a known stop signal: Linux + 429, darwin pressure 4 with load1 null, HEAVY with heavy > total', () => {
  const l429 = LIGHT({ platform: 'linux', cores: 4, samples: [], provider_errors: [{ kind: '429', t_ms: 1 }] }, R(0));
  assert.equal(l429.admit, false);
  assert.deepEqual(l429.reasons, ['held_provider', 'snapshot_unavailable']);
  const p4 = LIGHT(withLatest({ pressure_level: 4, load1: null }), R(0));
  assert.equal(p4.admit, false);
  assert.deepEqual(p4.reasons, ['held_pressure', 'snapshot_unavailable']);
  assert.equal(admitHost(snap(), 'HEAVY', { total: 0, heavy: 3 }).reason, 'invalid_args');
});

test('darwin with unreadable pressure/load/empty samples is snapshot_unavailable, not healthy', () => {
  assert.equal(LIGHT(withLatest({ pressure_level: null }), R(1)).reason, 'snapshot_unavailable');
  assert.equal(LIGHT(withLatest({ load5: undefined }), R(1)).reason, 'snapshot_unavailable');
  assert.equal(LIGHT(snap({ samples: [] }), R(1)).reason, 'snapshot_unavailable');
});

test('history validation: every malformed history HOLDS with invalid_args and never admits', () => {
  const ok = { state: 'open', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: null };
  const bad = [
    { ...ok, clean_streak: Infinity }, { ...ok, clean_streak: '1' }, { ...ok, clean_streak: 1.5 }, { ...ok, clean_streak: -1 }, { ...ok, clean_streak: NaN },
    { ...ok, state: 'HELD' }, { ...ok, state: 'resumed' }, { state: 'held', clean_streak: 5, last_admit_t_ms: null, last_sample_t_ms: null },
    { ...ok, last_admit_t_ms: NaN }, { ...ok, last_admit_t_ms: 'x' }, { ...ok, last_sample_t_ms: Infinity }, { ...ok, extra: 1 }, 'open', 7, [],
  ];
  for (const h of bad) {
    const r = LIGHT(snap(), R(0), h);
    assert.equal(r.admit, false, JSON.stringify(h));
    assert.equal(r.reason, 'invalid_args', JSON.stringify(h));
  }
  assert.equal(LIGHT(snap(), R(0), undefined).admit, true);
  assert.equal(LIGHT(snap(), R(0), null).admit, true);
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
  for (const level of [0, -3, 3, 5, 1.5, '1']) assert.equal(LIGHT(withLatest({ pressure_level: level }), R(1)).reason, 'snapshot_unavailable', 'p' + level);
  for (const v of [-1, NaN, Infinity, '1']) for (const k of ['load1', 'load5', 'load15']) assert.equal(LIGHT(withLatest({ [k]: v }), R(1)).reason, 'snapshot_unavailable', k + v);
  for (const cores of [0, -2, 1e9, 4.5, '8', NaN, undefined]) assert.equal(LIGHT(snap({ cores }), R(1)).reason, 'snapshot_unavailable', 'c' + cores);
  for (const swapouts of [-1, 1.5, '3', NaN, Infinity]) assert.equal(LIGHT(withLatest({ swapouts }), R(1)).reason, 'snapshot_unavailable', 's' + swapouts);
});

test('reason codes are the documented set', () => {
  assert.deepEqual([...HOST_HOLD_REASONS], ['held_pressure', 'held_swap', 'held_load', 'held_provider', 'held_heavy', 'held_hysteresis', 'held_resample', 'snapshot_unavailable', 'invalid_args']);
  assert.equal(HOST_POLICY.clean_samples_to_resume, 2);
});

function fakeExec(log, { pressure = '1\n', vm = n => 'Pages free: 1.\nSwapouts:   ' + n + '.\n', ps = ' 10 1 node --test a.test.mjs\n 11 10 node b.test.mjs\n 20 1 /usr/bin/vim\n 30 1 stryker run\n' } = {}) {
  let swap = 10;
  return (cmd) => {
    log.push(cmd);
    if (cmd === '/usr/sbin/sysctl') return pressure;
    if (cmd === '/usr/bin/vm_stat') return vm(swap++);
    if (cmd === '/bin/ps') return ps;
    return null;
  };
}

test('hostSnapshot uses ABSOLUTE tool paths, injected clock/sleep, counts suite roots, and feeds admitHost', async () => {
  const calls = []; const sleeps = []; let t = 5000;
  const s = await hostSnapshot({ platform: 'darwin', exec: fakeExec(calls), now: () => (t += 20000), sleep: async ms => { sleeps.push(ms); }, loadavg: () => [1, 2, 3], cpus: () => new Array(8), providerErrors: [{ kind: '429', t_ms: 1 }] });
  assert.ok(calls.every(c => c.startsWith('/')), calls.join());
  assert.deepEqual([...new Set(calls)].sort(), ['/bin/ps', '/usr/bin/vm_stat', '/usr/sbin/sysctl']);
  assert.deepEqual(sleeps, [20000]);
  assert.equal(s.cores, 8);
  assert.deepEqual(s.samples.map(x => [x.t_ms, x.pressure_level, x.swapouts, x.load1, x.load5, x.load15]), [[25000, 1, 10, 1, 2, 3], [45000, 1, 11, 1, 2, 3]]);
  assert.equal(s.heavy_processes, 2);
  assert.equal(s.now_ms, 65000);
  assert.deepEqual(LIGHT(s, R(0)).reasons, ['held_swap', 'held_provider']);
});

test('hostSnapshot parses strictly: garbled sysctl, vm_stat or ps output becomes null fields, which hold', async () => {
  const mk = (o) => hostSnapshot({ platform: 'darwin', exec: fakeExec([], o), now: (() => { let t = 0; return () => (t += 20000); })(), sleep: async () => {}, loadavg: () => [1, 1, 1], cpus: () => new Array(4) });
  const g1 = await mk({ pressure: '1garbage\n' });
  assert.equal(g1.samples[0].pressure_level, null);
  assert.equal(LIGHT(g1, R(1)).reason, 'snapshot_unavailable');
  const g2 = await mk({ vm: () => 'Swapouts:   100garbage.\n' });
  assert.equal(g2.samples[0].swapouts, null);
  assert.equal(LIGHT(g2, R(1)).reason, 'snapshot_unavailable');
  const g3 = await mk({ vm: () => 'xSwapouts: 5.\n' });
  assert.equal(g3.samples[0].swapouts, null);
  const none = await mk({ ps: null });
  assert.equal(none.heavy_processes, null);
  assert.deepEqual(HEAVY(none, R(0)).reasons.slice(-1), ['held_heavy']);
});

test('hostSnapshot on non-darwin does no reading and the result is the fail-safe fallback', async () => {
  const none = await hostSnapshot({ platform: 'linux', exec: () => { throw new Error('must not read'); }, cpus: () => new Array(2) });
  assert.deepEqual(none.samples, []);
  assert.equal(LIGHT(none, R(1)).reason, 'snapshot_unavailable');
});
