#!/usr/bin/env node
/**
 * S2 (P2) test helper: fake host snapshots for the claim store, and a CLAIMER process used by host-claims.test.mjs to put a
 * real, separate process (and process group) behind a claim. Imported by tests only; never by the engine.
 *
 *   node host-claims.test-helper.mjs '<json>'   with json = { mode, dir, opId, cls, resources, containerLabel, barrier, out,
 *                                                             ranFile, leaderStart, hold, pressure }
 * Modes:
 *   race            wait for `barrier` to exist, claim, write the result to `out`; hold (stay alive) when admitted
 *   claim-then-hang claim, write `out`, stay alive without ever binding a pgid
 *   bind-then-hang  claim, spawn the carrier-mode launcher (own process group) whose command writes `ranFile`, bind the
 *                   claim to its pgid + leader start, write `out`, then hang WITHOUT ever writing the release byte
 *   bind-then-exit  claim, spawn a detached plain node process (exits at once, or lives on with `hold`), bind it (with
 *                   `leaderStart` when given, else its real start time), write `out`, exit 0
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { HOST_SNAPSHOT_SCHEMA, isEntrypoint } from './harness.mjs';

/**
 * Fake host: every snapshot is one window of two samples 20 s apart (the next window starts where the previous ended).
 * `pressure` 2 = the non-blocking warning level, which leaves ONE heavy slot (heavy_slots_default); 1 = healthy (two slots).
 * `now()` is the snapshot clock, so a claim's freshness check sees the snapshot as just taken.
 */
export function fakeHost({ pressure = 2, start = 1_000_000 } = {}) {
  let t = start, last = start;
  const snapshot = async () => {
    const s = () => ({ t_ms: t, pressure_level: pressure, swap_used_kb100: 10240000, load1: 1, load5: 1, load15: 1 });
    const a = s(); t += 20000; const b = s(); last = t + 1000;
    return { schema: HOST_SNAPSHOT_SCHEMA, platform: 'darwin', cores: 10, now_ms: last, samples: [a, b], provider_errors: [] };
  };
  return { snapshot, now: () => last };
}

const hang = () => setInterval(() => {}, 1 << 30);

async function main() {
  const o = JSON.parse(process.argv[2]);
  const { claim, bindClaim } = await import('./host-claims.mjs');
  const host = fakeHost({ pressure: o.pressure ?? 2 });
  const req = { dir: o.dir, opId: o.opId, cls: o.cls ?? 'heavy', resources: o.resources ?? [], containerLabel: o.containerLabel,
    snapshot: host.snapshot, now: host.now };
  if (o.mode === 'race') {
    while (!existsSync(o.barrier)) await sleep(5);
    const r = await claim(req);
    writeFileSync(o.out, JSON.stringify(r));
    if (r.admit) hang();
    return;
  }
  const r = await claim(req);
  if (!r.admit) { writeFileSync(o.out, JSON.stringify(r)); process.exit(3); }
  if (o.mode === 'claim-then-hang') { writeFileSync(o.out, JSON.stringify(r)); hang(); return; }
  if (o.mode === 'bind-then-hang') {
    const { launcherArgs } = await import('./launcher.mjs');
    const { leaderStart } = await import('./engine-quiesce.mjs');
    const args = launcherArgs({ file: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(o.ranFile)}, 'ran')`], shell: false });
    const child = spawn(process.execPath, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    await bindClaim({ dir: o.dir, opId: o.opId, pgid: child.pid, leaderStart: leaderStart(child.pid) });
    writeFileSync(o.out, JSON.stringify({ ...r, pgid: child.pid }));
    hang(); // the release byte is never written: killing this process closes the launcher's stdin before it
    return;
  }
  if (o.mode === 'bind-then-exit') {
    const { leaderStart } = await import('./engine-quiesce.mjs');
    const child = spawn(process.execPath, ['-e', o.hold ? 'setInterval(() => {}, 1 << 30)' : ''], { detached: true, stdio: 'ignore' });
    child.unref();
    const start = o.leaderStart ?? leaderStart(child.pid);
    await bindClaim({ dir: o.dir, opId: o.opId, pgid: child.pid, leaderStart: start });
    writeFileSync(o.out, JSON.stringify({ ...r, pgid: child.pid }));
    process.exit(0);
  }
  throw new Error(`unknown mode ${o.mode}`);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(2); });
}
