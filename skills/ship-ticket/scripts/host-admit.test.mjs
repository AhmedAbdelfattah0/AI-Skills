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
    const s = (extra = {}) => ({ t_ms: t, pressure_level: 1, swap_used_kb100: 10240000, load1: 1, load5: 1, load15: 1, ...extra });
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
test('TICKET-C shape: level 2 (warn) with flat swap admits heavy and reports pressure_warn (exit 0)', async () => {
  const m = mk({ latest: { pressure_level: 2 } });
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot });
  assert.equal(r.code, 0); assert.equal(r.line.reason, 'admitted'); assert.equal(r.line.signals.pressure_warn, true); assert.equal(m.calls(), 2);
});
test('pressure level 4 holds without a second window', async () => {
  const m = mk({ latest: { pressure_level: 4 } });
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
