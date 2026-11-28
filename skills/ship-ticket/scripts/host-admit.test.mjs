import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST_SNAPSHOT_SCHEMA, hostSnapshot } from './harness.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs } from './host-admit.mjs';

// Fake clock: each snapshot window is two samples 20 s apart; the next window starts where the previous ended.
const mk = (o = {}) => {
  let t = 1_000_000; let calls = 0; let last = t;
  const snapshot = async () => {
    calls++;
    const s = (extra = {}) => ({ t_ms: t, pressure_level: 1, swap_used_kb100: 10240000, load1: 1, load5: 1, load15: 1, ...extra });
    const a = s(); t += 20000; const b = s({ ...(o.latest ?? {}), swap_used_kb100: 10240000 + (o.swapGrowth ?? 0) }); const now = t + 1000; last = now;
    return { schema: HOST_SNAPSHOT_SCHEMA, platform: 'darwin', cores: 10, now_ms: now, samples: [a, b], provider_errors: o.providers ?? [], ...(o.snap ?? {}) };
  };
  return { snapshot, calls: () => calls, now: () => last };
};
// S2: occupancy comes from the claim store (host-claims.mjs), never from the caller: every test gets its own temp store.
const stores = [];
process.on('exit', () => { for (const d of stores) rmSync(d, { recursive: true, force: true }); });
const tmpStore = () => { const d = mkdtempSync(join(tmpdir(), 'host-admit-')); stores.push(d); return d; };
const go = (argv, deps) => run(argv, { platform: 'darwin', dir: tmpStore(), ...deps });
/** A store holding `n` live heavy claims (claimer: this test process), each admitted on a healthy fake host. */
async function storeWith(n) {
  const { claim } = await import('./host-claims.mjs'); // dynamic: this file still loads (RED) on a tree without the store
  const dir = tmpStore();
  for (let i = 0; i < n; i++) {
    const m = mk();
    const r = await claim({ dir, opId: `held-${i}`, cls: 'heavy', snapshot: m.snapshot, now: m.now });
    assert.equal(r.admit, true, `setup claim ${i}: ${r.reasons}`);
  }
  return dir;
}

test('healthy host: cold start needs two windows, then admits (exit 0, one object)', async () => {
  const m = mk();
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot });
  assert.equal(r.code, 0); assert.equal(r.line.admit, true); assert.equal(r.line.reason, 'admitted');
  assert.equal(r.line.class, 'heavy'); assert.equal(m.calls(), 2); assert.equal(r.line.signals.heavy_slots, 2);
});
test('light class admits beside live heavy claims (occupancy from the store)', async () => {
  const r = await go(['--class', 'light'], { snapshot: mk().snapshot, dir: await storeWith(2) });
  assert.equal(r.code, 0); assert.equal(r.line.occupancy, 2);
});
test('heavy slots: two live heavy claims in the store hold a third heavy (held_heavy), exit 1', async () => {
  const r = await go(['--class', 'heavy'], { snapshot: mk().snapshot, dir: await storeWith(2) });
  assert.equal(r.code, 1); assert.equal(r.line.admit, false); assert.ok(r.line.reasons.includes('held_heavy'));
});
test('one live heavy claim: a second heavy admits after the second window (headline never held_hysteresis)', async () => {
  const m = mk();
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot, dir: await storeWith(1) });
  assert.equal(r.code, 0); assert.equal(r.line.reason, 'admitted'); assert.equal(m.calls(), 2); assert.equal(r.line.occupancy, 1);
});
test('two live heavy claims hold with held_heavy as the headline after both windows', async () => {
  const m = mk();
  const r = await go(['--class', 'heavy'], { snapshot: m.snapshot, dir: await storeWith(2) });
  assert.equal(r.code, 1); assert.equal(r.line.reason, 'held_heavy'); assert.equal(m.calls(), 2);
});
test('S2 (RED on frozen): one live heavy claim at ONE heavy slot (pressure 2) holds a second heavy: occupancy is the store, not a caller default of 0', async () => {
  const dir = await storeWith(1);
  const r = await go(['--class', 'heavy'], { snapshot: mk({ latest: { pressure_level: 2 } }).snapshot, dir });
  assert.equal(r.code, 1); assert.equal(r.line.admit, false); assert.equal(r.line.reason, 'held_heavy');
  assert.equal(r.line.occupancy, 1); assert.equal(r.line.claimed, false, 'the advisory check takes no claim');
});
test('S2 (RED on frozen): --running is removed (caller-supplied occupancy is never trusted)', async () => {
  const r = await go(['--class', 'heavy', '--running', '0'], { snapshot: mk().snapshot });
  assert.equal(r.code, 2); assert.equal(r.line.reason, 'usage'); assert.match(r.line.note, /claim store/);
});
test('S2 (RED on frozen): `run` claims before spawn, releases after the group is gone, and mirrors the exit code', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, async () => {
  const dir = tmpStore(), mark = join(dir, 'ran.txt');
  const seen = [];
  const r = await go(['run', '--class', 'light', '--op-id', 'lint-1', '--resource', `${dir}:W`, '--', process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(mark)}, String(require('node:fs').readdirSync(${JSON.stringify(join(dir, 'claims'))}).length)); process.exit(3)`],
  { dir, log: (l) => seen.push(l) });
  assert.equal(r.code, 3, 'the command exit code is mirrored');
  assert.equal(readFileSync(mark, 'utf8'), '1', 'the claim existed while the command ran');
  assert.deepEqual(readdirSync(join(dir, 'claims')).filter(f => f.endsWith('.json')), [], 'released after the group was gone');
  assert.ok(seen.some(l => l.admit === true && l.op_id === 'lint-1'), 'one admission line');
  const m = mk();
  const held = await go(['run', '--class', 'heavy', '--op-id', 'suite-2', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'heavy')`],
    { dir: await storeWith(2), snapshot: m.snapshot, now: m.now, log: () => {} });
  assert.equal(held.code, 75, 'a hold exits ADMISSION_HELD_EXIT (75), never 1 (which a command may exit itself)');
  assert.equal(held.line.reason, 'held_heavy');
  assert.equal(readFileSync(mark, 'utf8'), '1', 'and spawns nothing');
  assert.ok(existsSync(dir));
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
  for (const a of [[], ['--class'], ['--class', 'x'], ['--class', 'heavy', '--running', '-1'], ['--class', 'heavy', '--bogus', '1'], ['--class', 'heavy', '--class', 'light'], ['--class', 'heavy', '--running', '1']]) {
    const r = await go(a, { snapshot: mk().snapshot });
    assert.equal(r.code, 2, JSON.stringify(a)); assert.equal(r.line.admit, false); assert.equal(r.line.reason, 'usage');
  }
  assert.deepEqual(parseArgs(['--class', 'light']), { cls: 'light' });
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
test('F11 (RED on frozen: the claiming `run` is absent there) two concurrent `run --class heavy` at ONE heavy slot start exactly one command', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, async () => {
  const dir = tmpStore();
  const marks = [join(dir, 'a.ran'), join(dir, 'b.ran')];
  const go1 = mk({ latest: { pressure_level: 2 } }), go2 = mk({ latest: { pressure_level: 2 } });
  const cmd = (f) => ['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(f)}, 'x'); setTimeout(() => {}, 1500)`];
  const [x, y] = await Promise.all([
    go(['run', '--class', 'heavy', '--op-id', 'suite-a', ...cmd(marks[0])], { dir, snapshot: go1.snapshot, now: go1.now, log: () => {} }),
    go(['run', '--class', 'heavy', '--op-id', 'suite-b', ...cmd(marks[1])], { dir, snapshot: go2.snapshot, now: go2.now, log: () => {} })]);
  assert.equal(marks.filter(f => existsSync(f)).length, 1, `exactly one heavy command started (codes ${x.code}, ${y.code})`);
  assert.deepEqual([x.code, y.code].sort((a, b) => a - b), [0, 75], 'one ran, one was held');
});
