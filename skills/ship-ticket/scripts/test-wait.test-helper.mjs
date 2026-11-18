/**
 * Handshake waits for tests that drive real child processes (issue #49). Not a test file.
 *
 * A test that needs a child to have done something waits for the child's own observable marker
 * (a file it wrote, a log line, a dead pid) instead of sleeping for a fixed time. Each wait keeps
 * one generous upper bound, and that bound is only a failure timeout: on a quiet machine the
 * handshake is seen in milliseconds, and under CPU starvation the test still passes, or fails with
 * a message naming the handshake it never saw instead of an ENOENT or a bare assertion.
 *
 * Two more rules from the same class (load-sensitive engine tests, PR #84): a DAG `timeoutMs` bounds
 * every worker AND the proof and check runners, so a run keeps WORKER_FAILURE_BOUND_MS and a test whose
 * subject is a timeout sets a short budget only around the one command whose attempt must time out
 * (fixture `setRunTimeout`, then restore; `writeBeforeTimer` when that attempt must write first; the
 * engine-fixture-warmup guard enforces it); and a test that pins exact seq numbers or candidate ids,
 * or needs two workers running at once (a handshake between them), must pin admission too
 * (`ctx.admissionProbe: ROOMY_HOST`), since the live probe reads host memory and CPU count and a
 * refusal serializes dispatch.
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

/** POSIX: true when no process of group `pgid` is left (kill(-pgid, 0) reports ESRCH). */
export function groupGone(pgid) {
  try { process.kill(-pgid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/**
 * `ctx.hooks` for an in-process drive whose one dispatched worker writes something and then hangs under a short
 * run timeout. The engine arms an attempt's timer only after its 'after-release' boundary returns
 * (engine-attempts.mjs runAttempt), so waiting there for the worker's own write (`pred`) makes "the write, then
 * the timeout" a handshake: a worker that starts slowly is never killed before it wrote.
 *
 * Failure-safe: while the hook waits, the engine has no timer on that attempt, so nothing but this helper would
 * kill it. The worker's process group is recorded at 'after-pid' (before the handshake) and, if the handshake is
 * not seen within `ms` (a failure bound), the group is SIGKILLed and its termination awaited before the hook throws
 * an error naming the handshake. `t.after` also kills a group still alive when the test ends, whatever failed.
 * `.pgid` is the recorded group (null until 'after-pid').
 */
export function writeBeforeTimer(t, pred, what, { ms = HANDSHAKE_BOUND_MS } = {}) {
  let pgid = null;
  const kill = () => { if (pgid) try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
  t.after(async () => { if (pgid && !groupGone(pgid)) { kill(); await waitFor(() => groupGone(pgid), `worker group ${pgid} gone at teardown`); } });
  return {
    get pgid() { return pgid; },
    boundary: async (name, info) => {
      if (name === 'after-pid') pgid = info.pgid;
      if (name !== 'after-release') return;
      try { await waitFor(pred, what, { ms }); } catch (e) {
        kill();
        await waitFor(() => !pgid || groupGone(pgid), `worker group ${pgid} gone after the failed handshake`);
        throw new Error(`${e.message}; the worker's process group ${pgid} was killed and is gone`);
      }
    },
  };
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

const BOUND_IMPORT = /import\s*\{[^}]*\bWORKER_FAILURE_BOUND_MS\b[^}]*\}\s*from\s*'\.\/test-wait\.test-helper\.mjs'/;
const numberOf = (v) => Number(v.replace(/_/g, ''));

/**
 * Whether a `timeoutMs` / `setRunTimeout` value in `text` is at least WORKER_FAILURE_BOUND_MS. A name counts only when
 * this file resolves it: WORKER_FAILURE_BOUND_MS imported from this helper, or `const NAME = <number>` in the file.
 * Anything else (an unresolved name, a local redefinition below the bound) is short.
 */
function isBound(v, text) {
  if (/^\d/.test(v)) return numberOf(v) >= WORKER_FAILURE_BOUND_MS;
  if (v === 'WORKER_FAILURE_BOUND_MS' && BOUND_IMPORT.test(text) && !/\bconst\s+WORKER_FAILURE_BOUND_MS\b/.test(text)) return true;
  const c = new RegExp(`\\bconst\\s+${v.replace(/\$/g, '\\$')}\\s*=\\s*(\\d[\\d_]*)\\s*[;,]`).exec(text);
  return c !== null && numberOf(c[1]) >= WORKER_FAILURE_BOUND_MS;
}

/**
 * The short run timeouts in the given test sources (`[{ file, text }]`, CRLF or LF), as `{ file, line, text, kind }`:
 * - kind 'timeoutMs': a `timeoutMs: <value>` below WORKER_FAILURE_BOUND_MS. A run-wide timeoutMs bounds every worker
 *   and the proof and check runners, so a short one is only for a DAG that is validated and never driven, a
 *   function-level input with a fake runner, or a run whose every attempt hangs (each allowlisted with its reason);
 * - kind 'unrestored': a short `setRunTimeout(<value>)` whose next `setRunTimeout(` in the file does not restore the
 *   failure bound, so the short budget would leak into later commands.
 * `text` is the trimmed line. Not seen: shorthand `{ timeoutMs }`, assignments, a value on the next line.
 */
export function shortRunTimeouts(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const lines = text.split(/\r?\n/);
    const sets = [];
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\btimeoutMs:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/g)) {
        if (!isBound(m[1], text)) out.push({ file, line: i + 1, text: line.trim(), kind: 'timeoutMs' });
      }
      for (const m of line.matchAll(/\bsetRunTimeout\(\s*([A-Za-z_$][\w$]*|\d[\d_]*)\s*\)/g)) sets.push({ i, bound: isBound(m[1], text) });
    });
    sets.forEach((s, k) => {
      if (!s.bound && sets[k + 1]?.bound !== true) out.push({ file, line: s.i + 1, text: lines[s.i].trim(), kind: 'unrestored' });
    });
  }
  return out;
}

/**
 * Exact allowlist check: `hits` (from shortRunTimeouts) grouped by (file, trimmed line) with their counts, against
 * `allowed` rows `[file, line, count, reason]`. Returns `{ unlisted, miscounted, stale }`; all empty means they agree.
 * A line matches only by equality (never a substring), and a count, so a copy of an allowlisted line elsewhere fails.
 */
export function allowlistDiff(hits, allowed) {
  const key = (f, l) => `${f}\u0000${l}`;
  const seen = new Map();
  for (const h of hits) seen.set(key(h.file, h.text), (seen.get(key(h.file, h.text)) ?? 0) + 1);
  const listed = new Map(allowed.map(([f, l, n]) => [key(f, l), n]));
  const rows = (m) => [...m.keys()].map(k => k.split('\u0000'));
  return {
    unlisted: rows(seen).filter(([f, l]) => !listed.has(key(f, l))).map(([f, l]) => ({ file: f, text: l, count: seen.get(key(f, l)) })),
    miscounted: rows(seen).filter(([f, l]) => listed.has(key(f, l)) && listed.get(key(f, l)) !== seen.get(key(f, l)))
      .map(([f, l]) => ({ file: f, text: l, found: seen.get(key(f, l)), allowed: listed.get(key(f, l)) })),
    stale: rows(listed).filter(([f, l]) => !seen.has(key(f, l))).map(([f, l]) => ({ file: f, text: l })),
  };
}
