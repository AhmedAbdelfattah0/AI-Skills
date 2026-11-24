import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST_SNAPSHOT_SCHEMA, hostSnapshot } from './harness.mjs';
import { run, parseArgs } from './host-admit.mjs';

// Fake clock: each snapshot window is two samples 20 s apart; the next window starts where the previous ended.
const mk = (o = {}) => {
  let t = 1_000_000; let calls = 0;
  const snapshot = async () => {
    calls++;
    const s = (extra = {}) => ({ t_ms: t, pressure_level: 1, swap_used_kb100: 10240000, load1: 1, load5: 1, load15: 1, ...(o.both ?? {}), ...extra });
    const a = s(); t += 20000; const b = s({ ...(o.latest ?? {}), swap_used_kb100: 10240000 + (o.swapGrowth ?? 0) }); const now = t + 1000;
    return { schema: HOST_SNAPSHOT_SCHEMA, platform: 'darwin', cores: 10, now_ms: now, samples: [a, b], provider_errors: o.providers ?? [], ...(o.snap ?? {}) };
  };
  return { snapshot, calls: () => calls };
};
const go = (argv, deps) => run(argv, { platform: 'darwin', ...deps });

test('healthy host: cold start needs two windows, then admits (exit 0, one object)', async () => {
  const m = mk();
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot });
  assert.equal(r.code, 0); assert.equal(r.line.admit, true); assert.equal(r.line.reason, 'admitted');
  assert.equal(r.line.class, 'heavy'); assert.equal(m.calls(), 2); assert.equal(r.line.signals.heavy_slots, 2);
});
test('light class admits with --running', async () => {
  const r = await go(['--class', 'light', '--running', '3'], { snapshot: mk().snapshot });
  assert.equal(r.code, 0); assert.equal(r.line.running, 3);
});
test('heavy slots: --running 2 heavy holds (held_heavy), exit 1', async () => {
  const r = await go(['--class', 'heavy', '--running', '2'], { snapshot: mk().snapshot });
  assert.equal(r.code, 1); assert.equal(r.line.admit, false); assert.ok(r.line.reasons.includes('held_heavy'));
});
test('heavy --running 1 admits after the second window (headline never held_hysteresis)', async () => {
  const m = mk();
  const r = await go(['--class', 'heavy', '--running', '1'], { snapshot: m.snapshot });
  assert.equal(r.code, 0); assert.equal(r.line.reason, 'admitted'); assert.equal(m.calls(), 2);
});
test('heavy --running 2 holds with held_heavy as the headline after both windows', async () => {
  const m = mk();
  const r = await go(['--class', 'heavy', '--running', '2'], { snapshot: m.snapshot });
  assert.equal(r.code, 1); assert.equal(r.line.reason, 'held_heavy'); assert.equal(m.calls(), 2);
});
test('pressure without swap-free headroom in the snapshot holds without a second window', async () => {
  const m = mk({ latest: { pressure_level: 2 } });
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot });
  assert.equal(r.code, 1); assert.equal(r.line.reason, 'held_pressure'); assert.equal(m.calls(), 1);
});
test('swap growth holds', async () => {
  const r = await go(['--class', 'heavy'], { snapshot: mk({ swapGrowth: 50_000_000 }).snapshot });
  assert.equal(r.code, 1); assert.equal(r.line.reason, 'held_swap');
});
test('snapshot_unavailable fails closed (null pressure)', async () => {
  const r = await go(['--class', 'heavy'], { snapshot: mk({ latest: { pressure_level: null } }).snapshot });
  assert.equal(r.code, 1); assert.equal(r.line.admit, false); assert.ok(r.line.reasons.includes('snapshot_unavailable'));
});
test('unsupported platform is not an allow', async () => {
  const m = mk();
  const r = await run(['--class', 'heavy'], { platform: 'linux', snapshot: m.snapshot });
  assert.equal(r.code, 2); assert.equal(r.line.admit, false); assert.equal(r.line.reason, 'platform_unsupported'); assert.equal(m.calls(), 0);
});
test('bad args exit 2 with usage', async () => {
  for (const a of [[], ['--class'], ['--class', 'x'], ['--class', 'heavy', '--running', '-1'], ['--class', 'heavy', '--bogus', '1'], ['--class', 'heavy', '--class', 'light'], ['--class', 'heavy', '--running', '1', '--running', '2']]) {
    const r = await go(a, { snapshot: mk().snapshot });
    assert.equal(r.code, 2, JSON.stringify(a)); assert.equal(r.line.admit, false); assert.equal(r.line.reason, 'usage');
  }
  assert.equal(parseArgs(['--class', 'light']).running, 0);
});
test('real hostSnapshot with injected clock/sysctl/sleep: two windows admit, no real sleep', async () => {
  let t = 5_000_000; const slept = [];
  const probe = { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, cpus: () => new Array(10).fill({}), loadavg: () => [1, 1, 1],
    exec: (cmd, args) => args[1] === 'kern.memorystatus_vm_pressure_level' ? '1\n' : 'total = 1024.00M  used = 100.00M  free = 924.00M  (encrypted)\n' };
  const r = await go(['--class', 'heavy'], { snapshot: (p) => hostSnapshot({ ...probe, ...p }) });
  assert.equal(r.code, 0); assert.equal(r.line.admit, true); assert.deepEqual(slept, [20000, 20000]);
});
test('CLI: exactly one JSON line on stdout, usage error exits 2 (real process, no sampling)', () => {
  const p = spawnSync(process.execPath, [fileURLToPath(new URL('./host-admit.mjs', import.meta.url)), '--class', 'nope'], { encoding: 'utf8' });
  assert.equal(p.status, 2);
  const lines = p.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).reason, 'usage'); assert.ok(p.stdout.endsWith('\n'));
});

// STAB-410 stable pressure (level 2, swap flat, load fine, no provider errors, swap free >= 1 GB): one window decides; exit codes unchanged.
const GB100 = 1024 * 1024 * 100;
const STABLE = (free = 2 * GB100, extra = {}) => ({ both: { pressure_level: 2, swap_free_kb100: free }, ...extra });
test('[stable] stable pressure admits heavy with no heavy running (exit 0, reason admitted_stable_pressure, one window)', async () => {
  const m = mk(STABLE());
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot });
  assert.equal(r.code, 0); assert.equal(r.line.admit, true); assert.equal(r.line.reason, 'admitted_stable_pressure');
  assert.equal(r.line.signals.pressure_stable, true); assert.equal(m.calls(), 1);
  const l = await go(['--class', 'light', '--running', '3'], { snapshot: mk(STABLE()).snapshot });
  assert.equal(l.code, 0); assert.equal(l.line.reason, 'admitted_stable_pressure');
});
test('[stable] stable pressure with a heavy running holds (exit 1, held_heavy); below the swap-free floor holds (exit 1, held_pressure)', async () => {
  const h = await go(['--class', 'heavy', '--running', '1'], { snapshot: mk(STABLE()).snapshot });
  assert.equal(h.code, 1); assert.equal(h.line.admit, false); assert.equal(h.line.reason, 'held_heavy');
  const m = mk(STABLE(GB100 - 1));
  const f = await go(['--class', 'light'], { snapshot: m.snapshot });
  assert.equal(f.code, 1); assert.equal(f.line.reason, 'held_pressure'); assert.equal(f.line.signals.swap_free, 'low'); assert.equal(m.calls(), 1);
  const g = await go(['--class', 'heavy'], { snapshot: mk(STABLE(2 * GB100, { swapGrowth: 50_000_000 })).snapshot });
  assert.equal(g.code, 1); assert.deepEqual(g.line.reasons, ['held_pressure', 'held_swap']);
});
