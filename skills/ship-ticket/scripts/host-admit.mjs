#!/usr/bin/env node
/**
 * Thin CLI over the merged admitHost/hostSnapshot (harness.mjs). Run it before HEAVY work:
 *   node scripts/host-admit.mjs --class heavy|light [--running N]
 * Takes the samples itself (up to two hostSnapshot reads, history carried in memory, nothing persisted),
 * prints ONE JSON line and exits 0 admit, 1 hold, 2 usage error or unsupported platform.
 * Non-macOS is NOT an allow: it prints admit:false, reason platform_unsupported (use the manual rule).
 * --running N = tasks already running (default 0); for class heavy it is the heavy-slot count passed to admitHost.
 */
import { admitHost, hostSnapshot, isEntrypoint } from './harness.mjs';

const USAGE = 'Usage: host-admit.mjs --class heavy|light [--running N]';

export function parseArgs(argv) {
  const out = { cls: null, running: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--class' && (v === 'heavy' || v === 'light') && out.cls === null) out.cls = v;
    else if (k === '--running' && /^\d{1,6}$/.test(v ?? '') && !out.seenRunning) { out.running = Number(v); out.seenRunning = true; }
    else return null;
  }
  return out.cls ? { cls: out.cls, running: out.running } : null;
}

/** deps: { platform, snapshot(probe) } are injectable so tests need no sleeps or sysctl. Returns { line, code }. */
export async function run(argv, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const args = parseArgs(argv);
  if (!args) return { line: { admit: false, reason: 'usage', usage: USAGE }, code: 2 };
  const cls = args.cls.toUpperCase();
  const base = { class: args.cls, running: args.running };
  if (platform !== 'darwin') return { line: { admit: false, reason: 'platform_unsupported', ...base, platform, note: 'not an allow: apply the manual rule' }, code: 2 };
  const sample = deps.snapshot ?? hostSnapshot;
  const running = { total: args.running, heavy: cls === 'HEAVY' ? args.running : 0 };
  let history; let r;
  // A cold start is held (held_hysteresis) until two clean samples: take a second window only for that case.
  for (let round = 1; round <= 2; round++) {
    r = admitHost(await sample({ platform }), cls, running, history);
    history = r.history;
    if (r.admit || r.reasons.some(x => x !== 'held_hysteresis')) break;
  }
  return { line: { admit: r.admit, reason: r.reason, reasons: r.reasons, ...base, signals: r.signals }, code: r.admit ? 0 : 1 };
}

if (isEntrypoint(import.meta.url)) {
  run(process.argv.slice(2)).then(({ line, code }) => { process.stdout.write(JSON.stringify(line) + '\n'); process.exitCode = code; },
    (e) => { process.stdout.write(JSON.stringify({ admit: false, reason: 'error', message: String(e.message) }) + '\n'); process.exitCode = 2; });
}
