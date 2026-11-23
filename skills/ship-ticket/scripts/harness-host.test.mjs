import test from 'node:test';
import assert from 'node:assert/strict';
import { admitHost, hostSnapshot, HOST_POLICY, HOST_HOLD_REASONS } from './harness.mjs';

// Injected clock: samples are 20 s apart by default (inside the 15-30 s window).
const T0 = 1_000_000;
const S = (o = {}) => ({ t_ms: T0, pressure_level: 1, swapouts: 100, load1: 1, load5: 1, load15: 1, ...o });
const snap = (o = {}) => ({ platform: 'darwin', cores: 10, samples: [S(), S({ t_ms: T0 + 20000 })], heavy_processes: 0, provider_errors: [], ...o });
const withLatest = (o) => snap({ samples: [S(), S({ t_ms: T0 + 20000, ...o })] });

test('healthy host admits one LIGHT task with reason admitted and a history that requires a re-sample', () => {
  const r = admitHost(snap(), { cls: 'LIGHT' });
  assert.equal(r.admit, true);
  assert.equal(r.reason, 'admitted');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.signals.healthy, true);
  assert.equal(r.history.last_admit_t_ms, T0 + 20000);
  assert.deepEqual(r.terminate, []);
});

test('admit ONE then re-sample: the same sample cannot admit twice; a newer sample can', () => {
  const first = admitHost(snap(), { cls: 'LIGHT' });
  const again = admitHost(snap(), { cls: 'LIGHT', history: first.history });
  assert.equal(again.admit, false);
  assert.deepEqual(again.reasons, ['held_resample']);
  const later = snap({ samples: [S({ t_ms: T0 + 20000 }), S({ t_ms: T0 + 40000 })] });
  assert.equal(admitHost(later, { cls: 'LIGHT', history: first.history }).admit, true);
});

test('pressure 2 and 4 hold with held_pressure; pressure 1 is healthy', () => {
  for (const level of [2, 4]) {
    const r = admitHost(withLatest({ pressure_level: level }), { cls: 'LIGHT' });
    assert.equal(r.admit, false);
    assert.deepEqual(r.reasons, ['held_pressure']);
    assert.equal(r.reason, 'held_pressure');
  }
  assert.equal(admitHost(withLatest({ pressure_level: 1 }), { cls: 'LIGHT' }).admit, true);
});

test('swapouts growth across the 20 s window holds with held_swap; flat swap admits (high absolute swap is fine)', () => {
  const grow = admitHost(withLatest({ swapouts: 101 }), { cls: 'LIGHT' });
  assert.deepEqual(grow.reasons, ['held_swap']);
  assert.equal(grow.signals.swap, 'growing');
  const flat = admitHost(snap({ samples: [S({ swapouts: 9_000_000 }), S({ t_ms: T0 + 20000, swapouts: 9_000_000 })] }), { cls: 'LIGHT' });
  assert.equal(flat.admit, true);
  assert.equal(flat.signals.swap, 'flat');
});

test('swap growth in a MIDDLE pair is still growth (not only first vs last)', () => {
  const s = snap({ samples: [S({ swapouts: 5 }), S({ t_ms: T0 + 10000, swapouts: 9 }), S({ t_ms: T0 + 20000, swapouts: 9 })] });
  assert.deepEqual(admitHost(s, { cls: 'LIGHT' }).reasons, ['held_swap']);
});

test('a single sample, or samples closer than 15 s, cannot show swap is flat: hold with swap unknown', () => {
  const one = admitHost(snap({ samples: [S()] }), { cls: 'LIGHT' });
  assert.deepEqual(one.reasons, ['held_swap']);
  assert.equal(one.signals.swap, 'unknown');
  const close = admitHost(snap({ samples: [S(), S({ t_ms: T0 + 14999 })] }), { cls: 'LIGHT' });
  assert.deepEqual(close.reasons, ['held_swap']);
  assert.equal(admitHost(snap({ samples: [S(), S({ t_ms: T0 + 15000 })] }), { cls: 'LIGHT' }).admit, true);
});

test('load: each of load1/load5/load15 at 60% of cores (6 of 10) holds; just under admits', () => {
  for (const k of ['load1', 'load5', 'load15']) {
    const r = admitHost(withLatest({ [k]: 6 }), { cls: 'LIGHT' });
    assert.deepEqual(r.reasons, ['held_load'], k);
    assert.equal(admitHost(withLatest({ [k]: 5.99 }), { cls: 'LIGHT' }).admit, true, k);
  }
});

test('provider errors (429, quota, timeout) hold with held_provider', () => {
  for (const kind of ['429', 'quota', 'timeout']) {
    const r = admitHost(snap({ provider_errors: [{ kind, t_ms: T0 }] }), { cls: 'LIGHT' });
    assert.deepEqual(r.reasons, ['held_provider'], kind);
  }
});

test('every signal combination reports all its reasons in a fixed order, first one is `reason`', () => {
  const sigs = {
    held_pressure: { pressure_level: 2 }, held_swap: { swapouts: 999 }, held_load: { load5: 9 },
  };
  const names = Object.keys(sigs);
  for (let mask = 0; mask < 16; mask++) {
    const latest = {}; const expected = [];
    names.forEach((n, i) => { if (mask & (1 << i)) { Object.assign(latest, sigs[n]); expected.push(n); } });
    const provider = mask & 8 ? [{ kind: '429', t_ms: T0 }] : [];
    if (mask & 8) expected.push('held_provider');
    const r = admitHost(snap({ samples: [S(), S({ t_ms: T0 + 20000, ...latest })], provider_errors: provider }), { cls: 'LIGHT' });
    assert.deepEqual(r.reasons, expected, 'mask ' + mask);
    assert.equal(r.admit, expected.length === 0);
    assert.equal(r.reason, expected[0] ?? 'admitted');
  }
});

test('hysteresis: after a hold, ONE clean sample is not enough; the second consecutive clean sample resumes', () => {
  const bad = admitHost(withLatest({ pressure_level: 2 }), { cls: 'LIGHT' });
  assert.equal(bad.history.state, 'held');
  assert.equal(bad.history.clean_streak, 0);
  const clean1 = admitHost(snap(), { cls: 'LIGHT', history: bad.history });
  assert.equal(clean1.admit, false);
  assert.deepEqual(clean1.reasons, ['held_hysteresis']);
  assert.equal(clean1.signals.clean, true);
  assert.equal(clean1.signals.healthy, false);
  assert.equal(clean1.history.clean_streak, 1);
  const clean2 = admitHost(snap(), { cls: 'LIGHT', history: clean1.history });
  assert.equal(clean2.admit, true);
  assert.equal(clean2.history.state, 'open');
});

test('hysteresis: a bad sample between two clean ones resets the streak', () => {
  const bad = admitHost(withLatest({ swapouts: 500 }), { cls: 'LIGHT' });
  const c1 = admitHost(snap(), { cls: 'LIGHT', history: bad.history });
  const bad2 = admitHost(withLatest({ load1: 9 }), { cls: 'LIGHT', history: c1.history });
  assert.equal(bad2.history.clean_streak, 0);
  const c2 = admitHost(snap(), { cls: 'LIGHT', history: bad2.history });
  assert.equal(c2.admit, false);
  assert.deepEqual(c2.reasons, ['held_hysteresis']);
});

test('heavy: 2 concurrent only when healthy; the third is held_heavy', () => {
  const r0 = admitHost(snap(), { cls: 'HEAVY', running: { total: 1, heavy: 1 } });
  assert.equal(r0.admit, true);
  assert.equal(r0.signals.heavy_slots, 2);
  const r2 = admitHost(snap(), { cls: 'HEAVY', running: { total: 2, heavy: 2 } });
  assert.deepEqual(r2.reasons, ['held_heavy']);
});

test('heavy: while recovering (clean but not yet resumed) the cap is 1 and unhealthy hosts report cap 1 plus held_heavy', () => {
  const rec = admitHost(snap(), { cls: 'HEAVY', running: { total: 1, heavy: 1 }, history: { state: 'held', clean_streak: 0 } });
  assert.equal(rec.signals.heavy_slots, 1);
  assert.deepEqual(rec.reasons, ['held_hysteresis', 'held_heavy']);
  const bad = admitHost(withLatest({ pressure_level: 2 }), { cls: 'HEAVY', running: { total: 1, heavy: 1 } });
  assert.equal(bad.signals.heavy_slots, 1);
  assert.deepEqual(bad.reasons, ['held_pressure', 'held_heavy']);
});

test('heavy count also reads external heavy processes from the snapshot, and LIGHT is never held by heavy', () => {
  assert.deepEqual(admitHost(snap({ heavy_processes: 2 }), { cls: 'HEAVY' }).reasons, ['held_heavy']);
  assert.equal(admitHost(snap({ heavy_processes: 2 }), { cls: 'LIGHT' }).admit, true);
});

test('never kills: input is not mutated, running work is untouched, terminate is always empty, even when unhealthy', () => {
  const s = withLatest({ pressure_level: 4, swapouts: 9999 });
  const running = { total: 5, heavy: 3 };
  const before = JSON.stringify([s, running]);
  const r = admitHost(s, { cls: 'HEAVY', running });
  assert.equal(JSON.stringify([s, running]), before);
  assert.deepEqual(r.terminate, []);
  assert.equal(Object.keys(r).some(k => /kill|stop|cancel/i.test(k)), false);
  assert.deepEqual(Object.keys(r).sort(), ['admit', 'history', 'reason', 'reasons', 'signals', 'terminate']);
});

test('non-darwin is fail-safe: admits only ONE task, reason snapshot_unavailable, never permissive', () => {
  const linux = { platform: 'linux', cores: 64, samples: [], heavy_processes: null, provider_errors: [] };
  const first = admitHost(linux, { cls: 'LIGHT', running: { total: 0, heavy: 0 } });
  assert.equal(first.admit, true);
  assert.equal(first.reason, 'snapshot_unavailable');
  assert.equal(first.signals.heavy_slots, 1);
  const second = admitHost(linux, { cls: 'LIGHT', running: { total: 1, heavy: 0 } });
  assert.equal(second.admit, false);
  assert.equal(second.reason, 'snapshot_unavailable');
  assert.equal(admitHost(linux, { cls: 'HEAVY', running: { total: 1, heavy: 1 } }).admit, false);
});

test('darwin with an unreadable pressure level or missing load is also snapshot_unavailable, not healthy', () => {
  const r = admitHost(withLatest({ pressure_level: null }), { cls: 'LIGHT', running: { total: 1, heavy: 0 } });
  assert.equal(r.admit, false);
  assert.equal(r.reason, 'snapshot_unavailable');
  assert.equal(admitHost(withLatest({ load5: undefined }), { cls: 'LIGHT', running: { total: 1, heavy: 0 } }).reason, 'snapshot_unavailable');
  assert.equal(admitHost(snap({ samples: [] }), { cls: 'LIGHT', running: { total: 1, heavy: 0 } }).reason, 'snapshot_unavailable');
});

test('reason codes are the documented set and invalid inputs throw', () => {
  assert.deepEqual([...HOST_HOLD_REASONS], ['held_pressure', 'held_swap', 'held_load', 'held_provider', 'held_heavy', 'held_hysteresis', 'held_resample', 'snapshot_unavailable']);
  assert.equal(HOST_POLICY.clean_samples_to_resume, 2);
  assert.throws(() => admitHost(snap(), { cls: 'MEDIUM' }), /cls must be/);
  assert.throws(() => admitHost(null), /snapshot must be/);
});

test('hostSnapshot reads injected sources with an injected clock and sleep; non-darwin does no reading', async () => {
  const calls = []; const sleeps = []; let t = 5000; let swap = 10;
  const exec = (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'sysctl') return '1\n';
    if (cmd === 'vm_stat') return 'Pages free: 1.\nSwapouts:   ' + (swap++) + '.\n';
    if (cmd === 'ps') return 'node --test a.test.mjs\n/usr/bin/vim\nnode x.mjs --test\nstryker run\n';
  };
  const s = await hostSnapshot({ platform: 'darwin', exec, now: () => (t += 20000), sleep: async ms => { sleeps.push(ms); }, loadavg: () => [1, 2, 3], cpus: () => new Array(8), providerErrors: [{ kind: '429', t_ms: 1 }] });
  assert.equal(s.cores, 8);
  assert.deepEqual(sleeps, [15000]);
  assert.deepEqual(s.samples.map(x => [x.t_ms, x.pressure_level, x.swapouts, x.load1, x.load5, x.load15]), [[25000, 1, 10, 1, 2, 3], [45000, 1, 11, 1, 2, 3]]);
  assert.equal(s.heavy_processes, 3);
  assert.equal(s.provider_errors.length, 1);
  const verdict = admitHost(s, { cls: 'LIGHT' });
  assert.deepEqual(verdict.reasons, ['held_swap', 'held_provider']);
  const none = await hostSnapshot({ platform: 'linux', exec: () => { throw new Error('must not read'); }, cpus: () => new Array(2) });
  assert.deepEqual(none.samples, []);
  assert.equal(admitHost(none, { cls: 'LIGHT', running: { total: 1, heavy: 0 } }).reason, 'snapshot_unavailable');
});
