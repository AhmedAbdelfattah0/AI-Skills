/**
 * Handshake waits for tests that drive real child processes (issue #49). Not a test file.
 *
 * A test that needs a child to have done something waits for the child's own observable marker
 * (a file it wrote, a log line, a dead pid) instead of sleeping for a fixed time. Each wait keeps
 * one generous upper bound, and that bound is only a failure timeout: on a quiet machine the
 * handshake is seen in milliseconds, and under CPU starvation the test still passes, or fails with
 * a message naming the handshake it never saw instead of an ENOENT or a bare assertion.
 *
 * Two more rules from the same class (FLAKE-root-cause-report.md): a DAG `timeoutMs` bounds every
 * worker AND the proof and check runners, so a short one may only be used when every attempt in the
 * run is meant to time out (fail one worker by `exit`, keep WORKER_FAILURE_BOUND_MS); and a test
 * that pins exact seq numbers or candidate ids, or needs two workers running at once (a handshake
 * between them), must pin admission too (`ctx.admissionProbe: ROOMY_HOST`), since the live probe
 * reads host memory and CPU count and a refusal serializes dispatch.
 */
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Upper bound for any handshake wait. A failure timeout, never a pass condition. */
export const HANDSHAKE_BOUND_MS = 120000;

/**
 * `timeoutMs` for a worker that is expected to finish by itself. It is the test's failure bound,
 * not the behaviour under test; the production defaults are untouched.
 */
export const WORKER_FAILURE_BOUND_MS = 120000;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * `ctx.admissionProbe` of a roomy host (8 CPUs, 64 GiB free): every concurrent member is admitted.
 * Without it admit() reads live host memory (vm_stat on macOS) and a loaded host serializes workers.
 */
export const ROOMY_HOST = { cpus: () => Array.from({ length: 8 }, () => ({})), freemem: () => 64 * 1024 ** 3,
  totalmem: () => 64 * 1024 ** 3, platform: 'darwin' };

/**
 * macOS only: put a `vm_stat` reporting about 32 MB available first on PATH for the rest of test `t`
 * (restored after it), so the live admission probe (harness.mjs osFreeBytes) sees memory pressure.
 */
export function shadowLowMemoryVmStat(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lowmem-'));
  writeFileSync(join(dir, 'vm_stat'), '#!/bin/sh\nprintf "Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free: 1000.\\n'
    + 'Pages inactive: 1000.\\nPages speculative: 0.\\nPages purgeable: 0.\\n"\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });
}

/** Skip reason for the macOS-only memory-pressure injection. */
export const LOW_MEMORY_SKIP = process.platform !== 'darwin'
  ? 'the injection shadows macOS vm_stat; the pinned probe itself runs on every POSIX host' : false;

/**
 * Poll `pred` until it returns a truthy value (returned) or `ms` passes. Throws an Error naming
 * `what` on expiry. `pred` may be async; a throw inside it counts as "not yet" (a file mid-write).
 */
export async function waitFor(pred, what, { ms = HANDSHAKE_BOUND_MS, every = 25 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= end) throw new Error(`handshake not observed within ${ms} ms: ${what}`);
    await delay(every);
  }
}

/** Wait until `path` exists (a marker the child writes). */
export const waitForFile = (path, what, opts) => waitFor(() => existsSync(path), `${what} (waiting for ${path})`, opts);

/**
 * True when `pid` no longer runs: gone (ESRCH) or a zombie (it died and only awaits reaping by
 * its new parent, which under load can take a while). POSIX only.
 */
export function processGone(pid) {
  const vanished = () => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  if (vanished()) return true;
  if (process.platform === 'win32') return false; // no zombie state to read
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  // Fail closed: an unusable ps never reports a process as dead; only ESRCH or a read 'Z' does.
  if (r.error || r.status !== 0) return vanished();
  return r.stdout.trim().startsWith('Z');
}

/** The one name trusted as a failure bound everywhere. Any other name is resolved from its `const NAME = <number>` in the same file. */
export const BOUND_NAMES = new Set(['WORKER_FAILURE_BOUND_MS']);

/**
 * Every `timeoutMs: <value>` in the given test sources whose value is a number below WORKER_FAILURE_BOUND_MS, or a
 * name that is not WORKER_FAILURE_BOUND_MS and does not resolve, in that file, to a constant at least that large:
 * { file, line, text }. Also every `setRunTimeout(<short>)` in a file with fewer restoring
 * `setRunTimeout(WORKER_FAILURE_BOUND_MS)` calls than short ones ({ file, line: 0, text: 'unpaired setRunTimeout' }).
 * A run-wide timeoutMs bounds every worker and the proof and check runners, so a short one is only for a DAG
 * that is validated and never driven, a function-level input with a fake runner, or a run whose every attempt
 * hangs; anything else sets it short only around the hanging step (fixture setRunTimeout). `sources` is [{ file, text }].
 */
export function shortRunTimeouts(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const consts = new Map([...text.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*(\d[\d_]*)\s*;/g)].map(m => [m[1], Number(m[2].replace(/_/g, ''))]));
    const short = (v) => (/^\d/.test(v) ? Number(v.replace(/_/g, '')) < WORKER_FAILURE_BOUND_MS
      : !BOUND_NAMES.has(v) && !((consts.get(v) ?? 0) >= WORKER_FAILURE_BOUND_MS));
    let shortSets = 0, restores = 0;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\btimeoutMs:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/g)) if (short(m[1])) out.push({ file, line: i + 1, text: line.trim() });
      for (const m of line.matchAll(/\bsetRunTimeout\(\s*([A-Za-z_$][\w$]*|\d[\d_]*)\s*\)/g)) { if (short(m[1])) shortSets++; else restores++; }
    });
    if (shortSets > restores) out.push({ file, line: 0, text: 'unpaired setRunTimeout' });
  }
  return out;
}
