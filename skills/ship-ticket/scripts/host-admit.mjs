#!/usr/bin/env node
/**
 * Thin CLI over the merged admitHost/hostSnapshot (harness.mjs) and, since PR-2 (S2-min), the host claim store (host-claims.mjs).
 *
 *   node scripts/host-admit.mjs --class heavy|light
 *     ADVISORY check (takes no claim): samples (up to two hostSnapshot windows, history in memory), reads the occupancy
 *     from the claim store, prints ONE JSON line on stdout and exits 0 admit, 1 hold, 2 usage error or unsupported platform.
 *     Non-macOS is NOT an allow: it prints admit:false, reason platform_unsupported (use the manual rule).
 *   node scripts/host-admit.mjs run [--class heavy|light [--weight N]] [--op-id <id>] [--resource <path|name>:R|W]...
 *                              [--container-owner <o> --container-run <r>] -- <command> [args...]
 *     The CLAIMING path: claims BEFORE spawn (exit 1 on a hold, nothing spawned), starts the command through the launcher in
 *     its own process group, binds the claim to that pgid BEFORE the release byte, waits, and releases the claim once the
 *     group is gone (and no container with the given labels remains, and, for an engine run, every attempt in the run's
 *     existing attempt records is settled or its detached group gone), persisting the post-admission peak. A release the
 *     store refuses leaves the claim charged (`release_deferred`): any later claim reclaims it on proof. JSON lines go to
 *     stderr; the command's stdout/stderr are inherited and its exit code is mirrored.
 *     ENGINE COMMANDS (`node .../run-engine.mjs <cmd> ...`): class, weight and run binding are DERIVED
 *     (engine-host-claim.mjs: drive = min(config.width, DAG nodes), gate red|prove|ship-ready = 1, the rest light), so
 *     --class/--weight are refused for them; the command finds its claim through AI_SKILLS_HOST_CLAIM_OP and the run-engine
 *     CLI entry refuses a heavy command of a config.hostClaimRequired run without one (host_claim_required).
 *     A standalone heavy suite: `run --class heavy -- npm test`.
 *
 * PR-2 replaces `--running N` (caller-supplied occupancy, default 0: frozen host-admit.mjs:14-16,34-42): occupancy is the
 * Σ weights of the live and unknown claims in ~/.ai-skills-state/host-resources/ (env AI_SKILLS_HOST_RESOURCES_DIR).
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { admitHost, hostSnapshot, isEntrypoint, HOST_POLICY } from './harness.mjs';
import { claim, bindClaim, releaseClaim, inspectClaims, storeDir, groupAlive, peakSampler, boundedOpId, STORE_ENV } from './host-claims.mjs';
import { engineClaimSpec, CLAIM_OP_ENV } from './engine-host-claim.mjs';
import { launcherArgs, RELEASE_BYTE } from './launcher.mjs';
import { leaderStart } from './engine-quiesce.mjs';

const USAGE = 'Usage: host-admit.mjs --class heavy|light | host-admit.mjs run [--class heavy|light [--weight N]] [--op-id <id>] [--resource <path|name>:R|W]... [--container-owner <o> --container-run <r>] -- <command> [args...]';
const RUNNING_REMOVED = 'occupancy comes from the claim store (host-claims.mjs); --running was removed';

/** Check-mode arguments: exactly `--class heavy|light`. `--running` is refused (`removed: true`). */
export function parseArgs(argv) {
  if (argv.includes('--running')) return { removed: true };
  if (argv.length !== 2 || argv[0] !== '--class' || !['heavy', 'light'].includes(argv[1])) return null;
  return { cls: argv[1] };
}

/** `run` arguments: { cls, weight, opId, resources, containerLabel, command: [file, ...args] } or null (cls/weight/opId may be null). */
export function parseRunArgs(argv) {
  const dash = argv.indexOf('--');
  if (dash < 0 || dash === argv.length - 1) return null;
  const flags = argv.slice(0, dash), command = argv.slice(dash + 1);
  const out = { cls: null, weight: null, opId: null, resources: [], owner: null, run: null, command };
  for (let i = 0; i < flags.length; i += 2) {
    const [k, v] = [flags[i], flags[i + 1]];
    if (v === undefined) return null;
    if (k === '--class' && out.cls === null && ['heavy', 'light'].includes(v)) out.cls = v;
    else if (k === '--weight' && out.weight === null && /^[1-9]\d?$/.test(v)) out.weight = Number(v);
    else if (k === '--op-id' && out.opId === null) out.opId = v;
    else if (k === '--resource') { const m = /^(.+):(R|W)$/.exec(v); if (!m) return null; out.resources.push({ resource: m[1], mode: m[2] }); }
    else if (k === '--container-owner' && out.owner === null) out.owner = v;
    else if (k === '--container-run' && out.run === null) out.run = v;
    else return null;
  }
  if ((out.owner === null) !== (out.run === null)) return null;
  return { cls: out.cls, weight: out.weight, opId: out.opId, resources: out.resources, containerLabel: out.owner ? { owner: out.owner, run: out.run } : null, command };
}

/**
 * deps: { platform, snapshot(probe), dir, env, now, log(line), spawn, stdio } are injectable so tests need no sleeps, no
 * sysctl and never touch the real store. Returns { line, code }.
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
    const running = { total: Math.max(held.live.length + held.unknown.length, held.occupancy), heavy: cls === 'HEAVY' ? held.occupancy : 0 }; // F3
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
  // Engine commands: class, weight and run binding come from the command and the run, never from the caller.
  const spec = engineClaimSpec(a.command);
  if (spec && (a.cls !== null || a.weight !== null)) return usage({ note: 'an engine command derives its class and weight; drop --class/--weight' });
  if (spec?.error) return usage({ note: spec.error });
  if (!spec && a.cls === null) return usage({ note: '--class is required for a command that is not an engine command' });
  if (!spec && a.weight !== null && a.cls !== 'heavy') return usage({ note: '--weight is for --class heavy' });
  const cls = spec ? spec.cls : a.cls, weight = spec ? spec.weight : (a.weight ?? (cls === 'heavy' ? 1 : 0));
  const opId = a.opId ?? spec?.opId ?? boundedOpId(['op', basename(a.command[0]), randomUUID().slice(0, 8)]);
  if (platform === 'win32' || (cls === 'heavy' && platform !== 'darwin')) {
    const line = { admit: false, reason: 'platform_unsupported', class: cls, platform, note: 'not an allow: apply the manual rule' };
    log(line); return { line, code: 2 };
  }
  // A weight above the host maximum could never be admitted: a permanent refusal, not an endless hold.
  if (cls === 'heavy' && weight > HOST_POLICY.heavy_slots_healthy) {
    const line = { admit: false, reason: 'weight_exceeds_host_capacity', op_id: opId, weight, heavy_slots_max: HOST_POLICY.heavy_slots_healthy };
    log(line); return { line, code: 2 };
  }
  const env = deps.env ?? process.env;
  const dir = deps.dir ?? storeDir(env);
  const c = await claim({ dir, opId, cls, weight, resources: a.resources, containerLabel: a.containerLabel, runState: spec?.runState ?? null,
    snapshot: deps.snapshot ?? hostSnapshot, now: deps.now ?? Date.now, platform });
  const head = { admit: c.admit, reason: c.reason, reasons: c.reasons, op_id: opId, class: cls, weight, occupancy: c.occupancy, heavy_slots: c.heavy_slots,
    conflicts: c.conflicts, unknown: c.unknown, blocked: c.blocked ? { raised: c.blocked.raised, op_ids: c.blocked.op_ids } : null, claimed: c.admit,
    run_state: spec?.runState ?? null };
  log(head);
  if (!c.admit) return { line: head, code: 1 };
  const childEnv = { ...env, [CLAIM_OP_ENV]: opId, [STORE_ENV]: dir };
  const child = (deps.spawn ?? spawn)(process.execPath, launcherArgs({ file: a.command[0], args: a.command.slice(1), shell: false }),
    { detached: true, stdio: deps.stdio ?? ['pipe', 'inherit', 'inherit'], env: childEnv });
  const exited = new Promise(r => { child.on('exit', (code, signal) => r({ code, signal })); child.on('error', () => r({ code: null, signal: null })); });
  child.stdin?.on('error', () => {});
  if (!child.pid) { await exited; await releaseClaim({ dir, opId }); const line = { op_id: opId, reason: 'spawn_failed' }; log(line); return { line, code: 127 }; }
  try { await bindClaim({ dir, opId, pgid: child.pid, leaderStart: leaderStart(child.pid) }); } catch (e) {
    child.stdin.end(); // no release byte: the launcher exits 125 and nothing runs
    await exited;
    const rel = await releaseClaim({ dir, opId });
    const line = { op_id: opId, reason: 'bind_failed', message: String(e.message), released: rel.released };
    log(line); return { line, code: 2 };
  }
  const peak = peakSampler();
  child.stdin.end(RELEASE_BYTE);
  const st = await exited;
  // The release needs the whole group gone: give lingering descendants a bounded moment, then let the store decide.
  for (const end = Date.now() + 10000; groupAlive(child.pid) === true && Date.now() < end;) await new Promise(r => setTimeout(r, 50));
  const rel = await releaseClaim({ dir, opId, peak: peak.stop() });
  const line = { op_id: opId, exit_code: st.code, signal: st.signal, released: rel.released, release_reason: rel.reason,
    ...(rel.released ? {} : { release_deferred: true, note: 'the claim stays charged; a later claim reclaims it on proof (group and every run attempt gone)' }) };
  log(line);
  return { line, code: st.code ?? 1 };
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const toStderr = argv[0] === 'run';
  run(argv).then(({ line, code }) => { if (!toStderr) process.stdout.write(JSON.stringify(line) + '\n'); process.exitCode = code; },
    (e) => { (toStderr ? process.stderr : process.stdout).write(JSON.stringify({ admit: false, reason: 'error', message: String(e.message) }) + '\n'); process.exitCode = 2; });
}
