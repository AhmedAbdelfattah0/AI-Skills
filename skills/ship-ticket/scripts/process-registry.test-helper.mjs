/**
 * The engine test fixture's process registry (engine-test-fixture.mjs). Not a test file.
 *
 * Invariant: no process a fixture test started outlives the test, whatever failed and wherever (a spawn, a commit before
 * the engine reports the pid, a handshake, the test body). Cleanup depends only on fixture-owned knowledge, never on a
 * pid the engine delivers at a boundary, and process identity is decided by ownership, never by a clock or `ps`:
 *
 * - Spawn seam (`spawnFn`, the fixture's `ctx.spawn`): the fixture holds the ChildProcess HANDLE of every child it
 *   spawns, recorded synchronously when spawn returns. A handle that has not exited is ours by construction (its pid
 *   cannot be reused before it is reaped). A detached child leads its own group, so killing -pid reaches its descendants.
 *   When the leader's 'exit' is observed and its group is then already gone, the group is closed (never signalled again).
 * - Preload (`node --require`, via the fixture env's NODE_OPTIONS on POSIX): the FIRST thing every node process started
 *   under that env does (an engine CLI's launchers, the provider, its sleepers) is listen on a Unix socket of its own in
 *   this registry's directory and then record `{ token, pid, leader, sock }`. The listening socket lives exactly as long
 *   as that process (its fds close when it dies, and node children do not inherit it), so a connect that is accepted
 *   proves the registered process itself is alive, and ECONNREFUSED or ENOENT (see probe) proves it is gone, whatever process now holds its pid.
 * - Groups: a group is signalled only when a registered process leads it (never the test runner's group). While any
 *   member lives a pgid is not reused. Remaining window, documented: a leader that exited while its group still had
 *   members (not closed), whose members then all died and whose pgid was recycled as another group, before teardown.
 * - Anything teardown cannot decide (a probe that fails other than refused, a missing socket, a foreign token, a group
 *   probe that is not ESRCH) is a teardown ERROR naming the entry: never a silent skip.
 *
 * `reap()` (the fixture's teardown, idempotent) kills every owned live process and group with SIGKILL, awaits them all
 * within `boundMs` (a failure bound only), and throws naming survivors and undecidable entries. Windows (no groups,
 * known limit D4): it records and kills only unexited handles.
 */
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HANDSHAKE_BOUND_MS, waitFor } from './test-wait.test-helper.mjs';

/** Longest Unix socket path both macOS (104) and Linux (108) accept, with the terminator. */
const SOCK_MAX = 103;

const PRELOAD = (file, dir, token) => `'use strict';
try {
  const fs = require('node:fs');
  const sock = ${JSON.stringify(dir)} + '/' + process.pid + '.sock';
  let bound = false;
  if (sock.length <= ${SOCK_MAX}) {
    try { fs.unlinkSync(sock); } catch {}
    try { const s = require('node:net').createServer((c) => c.destroy()); s.on('error', () => {}); s.listen({ path: sock }); s.unref(); bound = fs.existsSync(sock); } catch {}
  }
  let leader = false;
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 0); leader = true; } catch {} }
  fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({ token: ${JSON.stringify(token)}, pid: process.pid, leader, sock: bound ? sock : null, via: 'preload' }) + '\\n');
} catch {}
`;

/**
 * 'alive' (accepted), 'gone' or the error code that leaves it undecided; bounded by `ms` (a failure bound). Gone is
 * ECONNREFUSED (the process died without closing it: its listener fd is closed, the file stays) or ENOENT (it exited
 * and node closed the socket, unlinking it). The preload records a socket only once it is bound (the file exists when
 * listen returns), and nothing else removes it before teardown, so ENOENT never means "not bound yet".
 */
function probe(sock, ms) {
  return new Promise((resolve) => {
    const c = connect({ path: sock });
    const timer = setTimeout(() => { c.destroy(); resolve('probe-unanswered'); }, ms);
    c.once('connect', () => { clearTimeout(timer); c.destroy(); resolve('alive'); });
    c.once('error', (e) => { clearTimeout(timer); resolve(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'gone' : (e.code ?? 'probe-error')); });
  });
}

/** POSIX group state: 'present', 'gone' (ESRCH) or the error code that leaves it undecided. */
function groupState(pgid) {
  try { process.kill(-pgid, 0); return 'present'; } catch (e) { return e.code === 'ESRCH' ? 'gone' : (e.code ?? 'group-probe-error'); }
}

/**
 * A registry in a directory of its own (never inside the fixture tree, which tests snapshot and restore: a restore must
 * not roll back registrations, and a socket cannot be copied). `dispose()` removes it, after `reap()`.
 */
export function processRegistry({ platform = process.platform } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'procs-')));
  const token = randomUUID();
  const file = join(root, 'processes.jsonl');
  const dir = join(root, 'p');
  mkdirSync(dir, { recursive: true });
  const preload = join(root, 'register-process.cjs');
  writeFileSync(preload, PRELOAD(file, dir, token));
  const handles = new Map(); // pid -> { child, leader, closed }
  const record = (child, leader) => {
    if (!child?.pid) return child;
    const h = { child, leader, closed: false };
    handles.set(child.pid, h);
    // Close the group when its leader's exit is observed and nothing of it is left: it is never signalled again.
    if (leader) child.once('exit', () => { if (groupState(child.pid) === 'gone') h.closed = true; });
    appendFileSync(file, JSON.stringify({ token, pid: child.pid, leader, via: 'spawn' }) + '\n');
    return child;
  };
  const unexited = (h) => h.child.exitCode === null && h.child.signalCode === null;
  /** This registry's preload entries (one per registration; a foreign token is reported, never trusted). */
  const entries = () => {
    let lines = [];
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { /* nothing registered */ }
    return lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  };

  async function reap({ kill = (target, sig) => process.kill(target, sig), boundMs = HANDSHAKE_BOUND_MS } = {}) {
    if (platform === 'win32') { for (const h of handles.values()) if (unexited(h)) try { h.child.kill('SIGKILL'); } catch { /* gone */ } return; }
    const groups = new Set(), handlePids = new Set(), socks = new Map(), undecided = [];
    const leadGroup = (pgid, what) => {
      const g = groupState(pgid);
      if (g === 'present') groups.add(pgid); else if (g !== 'gone') undecided.push(`${what} ${pgid}: group probe ${g}`);
    };
    // (a) handles: ownership by construction.
    for (const [pid, h] of handles) {
      if (h.leader) { if (!h.closed) leadGroup(pid, 'spawned group'); }
      else if (unexited(h)) handlePids.add(pid);
    }
    // (c) preload entries: ownership by the registered process's own live socket.
    for (const e of entries()) {
      if (e.via !== 'preload') continue;
      if (e.token !== token) { undecided.push(`pid ${e.pid}: foreign token`); continue; }
      if (handles.has(e.pid)) continue; // decided by its handle
      if (typeof e.sock !== 'string') { undecided.push(`pid ${e.pid}: registered without a socket`); continue; }
      const s = await probe(e.sock, boundMs);
      if (s === 'alive') { if (e.leader) leadGroup(e.pid, 'registered group'); else socks.set(e.pid, e.sock); }
      else if (s === 'gone') { if (e.leader) leadGroup(e.pid, 'registered group'); } // members may outlive the leader
      else undecided.push(`pid ${e.pid}: socket probe ${s}`);
    }
    for (const g of groups) try { kill(-g, 'SIGKILL'); } catch { /* already gone */ }
    for (const p of [...handlePids, ...socks.keys()]) try { kill(p, 'SIGKILL'); } catch { /* already gone */ }
    const left = async () => {
      const out = [...groups].filter(g => groupState(g) !== 'gone').map(g => `group ${g}`);
      for (const p of handlePids) if (unexited(handles.get(p))) out.push(`pid ${p}`);
      for (const [p, s] of socks) if ((await probe(s, boundMs)) !== 'gone') out.push(`pid ${p}`);
      return out;
    };
    let survivors = [];
    try { await waitFor(async () => (survivors = await left()).length === 0, 'registered processes gone', { ms: boundMs }); } catch { /* reported below */ }
    if (survivors.length || undecided.length) {
      throw new Error(`fixture teardown: ${survivors.length ? `registered process(es) survived SIGKILL after ${boundMs} ms: ${survivors.join(', ')}` : ''}`
        + `${survivors.length && undecided.length ? '; ' : ''}${undecided.length ? `ownership undecidable: ${undecided.join(', ')}` : ''}`);
    }
  }

  return {
    root, file, dir, preload, token, entries, record, reap,
    dispose: () => rmSync(root, { recursive: true, force: true }),
    /** NODE_OPTIONS that makes every node process under it register itself first (POSIX only). */
    nodeOptions: (base) => (platform === 'win32' ? base : `${base ? base + ' ' : ''}--require "${preload}"`),
    /** Spawn seam: `inner` (default child_process.spawn) with each child's handle recorded the moment it exists. */
    spawnFn: (inner = spawn) => (cmd, args, opts) => record(inner(cmd, args, opts), platform !== 'win32' && opts?.detached === true),
  };
}
