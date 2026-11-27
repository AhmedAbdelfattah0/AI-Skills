#!/usr/bin/env node
/**
 * Thin CLI over the merged admitHost/hostSnapshot (harness.mjs) and, since S2 (P2), the host claim store (host-claims.mjs).
 *
 *   node scripts/host-admit.mjs --class heavy|light
 *     ADVISORY check (takes no claim): samples (up to two hostSnapshot windows, history in memory), reads the occupancy
 *     from the claim store, prints ONE JSON line on stdout and exits 0 admit, 1 hold, 2 usage error or unsupported platform.
 *     Non-macOS is NOT an allow: it prints admit:false, reason platform_unsupported (use the manual rule).
 *   node scripts/host-admit.mjs run --class heavy|light --op-id <id> [--resource <path|name>:R|W]...
 *                              [--container-owner <o> --container-run <r>] -- <command> [args...]
 *     The CLAIMING path: claims BEFORE spawn (exit 1 on a hold, nothing spawned), starts the command through the launcher in
 *     its own process group, binds the claim to that pgid BEFORE the release byte, waits, and releases the claim once the
 *     group is gone (and no container with the given labels remains), persisting the post-admission peak. JSON lines go to
 *     stderr; the command's stdout/stderr are inherited and its exit code is mirrored.
 *
 * S2 replaces `--running N` (caller-supplied occupancy, default 0: frozen host-admit.mjs:14-16,34-42): occupancy is the
 * Σ weights of the live and unknown claims in ~/.ai-skills-state/host-resources/ (env AI_SKILLS_HOST_RESOURCES_DIR).
 */
import { spawn } from 'node:child_process';
import { admitHost, hostSnapshot, isEntrypoint } from './harness.mjs';
import { claim, bindClaim, releaseClaim, inspectClaims, storeDir, groupAlive, peakSampler } from './host-claims.mjs';
import { launcherArgs, RELEASE_BYTE } from './launcher.mjs';
import { leaderStart } from './engine-quiesce.mjs';

const USAGE = 'Usage: host-admit.mjs --class heavy|light | host-admit.mjs run --class heavy|light --op-id <id> [--resource <path|name>:R|W]... [--container-owner <o> --container-run <r>] -- <command> [args...]';
const RUNNING_REMOVED = 'occupancy comes from the claim store (host-claims.mjs); --running was removed';

/** Check-mode arguments: exactly `--class heavy|light`. `--running` is refused (`removed: true`). */
export function parseArgs(argv) {
  if (argv.includes('--running')) return { removed: true };
  if (argv.length !== 2 || argv[0] !== '--class' || !['heavy', 'light'].includes(argv[1])) return null;
  return { cls: argv[1] };
}

/** `run` arguments: { cls, opId, resources, containerLabel, command: [file, ...args] } or null. */
export function parseRunArgs(argv) {
  const dash = argv.indexOf('--');
  if (dash < 0 || dash === argv.length - 1) return null;
  const flags = argv.slice(0, dash), command = argv.slice(dash + 1);
  const out = { cls: null, opId: null, resources: [], owner: null, run: null, command };
  for (let i = 0; i < flags.length; i += 2) {
    const [k, v] = [flags[i], flags[i + 1]];
    if (v === undefined) return null;
    if (k === '--class' && out.cls === null && ['heavy', 'light'].includes(v)) out.cls = v;
    else if (k === '--op-id' && out.opId === null) out.opId = v;
    else if (k === '--resource') { const m = /^(.+):(R|W)$/.exec(v); if (!m) return null; out.resources.push({ resource: m[1], mode: m[2] }); }
    else if (k === '--container-owner' && out.owner === null) out.owner = v;
    else if (k === '--container-run' && out.run === null) out.run = v;
    else return null;
  }
  if (!out.cls || !out.opId || (out.owner === null) !== (out.run === null)) return null;
  return { cls: out.cls, opId: out.opId, resources: out.resources, containerLabel: out.owner ? { owner: out.owner, run: out.run } : null, command };
}

/**
 * deps: { platform, snapshot(probe), dir, env, now, log(line), spawn } are injectable so tests need no sleeps, no sysctl
 * and never touch the real store. Returns { line, code }.
 */
export async function run(argv, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const usage = (extra = {}) => ({ line: { admit: false, reason: 'usage', usage: USAGE, ...extra }, code: 2 });
  if (argv[0] === 'run') return runClaimed(argv.slice(1), deps, platform, usage);
  const args = parseArgs(argv);
  if (!args || args.removed) return usage(args?.removed ? { note: RUNNING_REMOVED } : {});
  const cls = args.cls.toUpperCase();
  if (platform !== 'darwin') return { line: { admit: false, reason: 'platform_unsupported', class: args.cls, platform, note: 'not an allow: apply the manual rule' }, code: 2 };
  const dir = deps.dir ?? storeDir(deps.env ?? process.env);
  const sample = deps.snapshot ?? hostSnapshot;
  let history; let r; let held;
  // A cold start is held (held_hysteresis) until two clean samples: take a second window only for that case.
  for (let round = 1; round <= 2; round++) {
    const snap = await sample({ platform });
    held = inspectClaims(dir);
    const running = { total: held.live.length + held.unknown.length, heavy: cls === 'HEAVY' ? held.occupancy : 0 };
    r = admitHost(snap, cls, running, history);
    history = r.history;
    if (r.admit || r.reasons.some(x => x !== 'held_hysteresis' && x !== 'held_heavy')) break;
  }
  return { line: { admit: r.admit, reason: r.reason, reasons: r.reasons, class: args.cls, occupancy: held.occupancy, unknown: held.unknown.map(u => u.id),
    claimed: false, signals: r.signals }, code: r.admit ? 0 : 1 };
}

async function runClaimed(argv, deps, platform, usage) {
  const a = parseRunArgs(argv);
  if (!a) return usage();
  const log = deps.log ?? ((l) => process.stderr.write(JSON.stringify(l) + '\n'));
  if (platform === 'win32' || (a.cls === 'heavy' && platform !== 'darwin')) {
    const line = { admit: false, reason: 'platform_unsupported', class: a.cls, platform, note: 'not an allow: apply the manual rule' };
    log(line); return { line, code: 2 };
  }
  const dir = deps.dir ?? storeDir(deps.env ?? process.env);
  const c = await claim({ dir, opId: a.opId, cls: a.cls, resources: a.resources, containerLabel: a.containerLabel,
    snapshot: deps.snapshot ?? hostSnapshot, now: deps.now ?? Date.now, platform });
  const head = { admit: c.admit, reason: c.reason, reasons: c.reasons, op_id: a.opId, class: a.cls, occupancy: c.occupancy, heavy_slots: c.heavy_slots,
    conflicts: c.conflicts, unknown: c.unknown, blocked: c.blocked ? { raised: c.blocked.raised, op_ids: c.blocked.op_ids } : null, claimed: c.admit };
  log(head);
  if (!c.admit) return { line: head, code: 1 };
  const child = (deps.spawn ?? spawn)(process.execPath, launcherArgs({ file: a.command[0], args: a.command.slice(1), shell: false }),
    { detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
  const exited = new Promise(r => { child.on('exit', (code, signal) => r({ code, signal })); child.on('error', () => r({ code: null, signal: null })); });
  child.stdin?.on('error', () => {});
  if (!child.pid) { await exited; await releaseClaim({ dir, opId: a.opId }); const line = { op_id: a.opId, reason: 'spawn_failed' }; log(line); return { line, code: 127 }; }
  try { await bindClaim({ dir, opId: a.opId, pgid: child.pid, leaderStart: leaderStart(child.pid) }); } catch (e) {
    child.stdin.end(); // no release byte: the launcher exits 125 and nothing runs
    await exited;
    const rel = await releaseClaim({ dir, opId: a.opId });
    const line = { op_id: a.opId, reason: 'bind_failed', message: String(e.message), released: rel.released };
    log(line); return { line, code: 2 };
  }
  const peak = peakSampler();
  child.stdin.end(RELEASE_BYTE);
  const st = await exited;
  // The release needs the whole group gone: give lingering descendants a bounded moment, then let the store decide.
  for (const end = Date.now() + 10000; groupAlive(child.pid) === true && Date.now() < end;) await new Promise(r => setTimeout(r, 50));
  const rel = await releaseClaim({ dir, opId: a.opId, peak: peak.stop() });
  const line = { op_id: a.opId, exit_code: st.code, signal: st.signal, released: rel.released, release_reason: rel.reason };
  log(line);
  return { line, code: st.code ?? 1 };
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const toStderr = argv[0] === 'run';
  run(argv).then(({ line, code }) => { if (!toStderr) process.stdout.write(JSON.stringify(line) + '\n'); process.exitCode = code; },
    (e) => { (toStderr ? process.stderr : process.stdout).write(JSON.stringify({ admit: false, reason: 'error', message: String(e.message) }) + '\n'); process.exitCode = 2; });
}
