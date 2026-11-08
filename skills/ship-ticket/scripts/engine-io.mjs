/**
 * I/O primitives for the durable run engine (run-engine.mjs): the lock protocol, atomic state
 * persistence with fault-injection boundaries, content fingerprints and work-tree snapshots,
 * idempotent event sinks, process-group liveness and termination, the launcher start shared with
 * carrier.mjs (one launcher implementation), the gate runner and candidate identity.
 * Node built-ins only. Pure helpers live in engine-dag.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  renameSync, unlinkSync, writeFileSync, writeSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { launcherArgs, RELEASE_BYTE } from './launcher.mjs';
import { sha, coded } from './engine-dag.mjs';
import { END, parseRunState, malformedReason, eventLine } from './run-state.mjs';
import { killGroup, quiesce, processInfo } from './engine-quiesce.mjs';

export { sha, killGroup, quiesce, processInfo };

export const delay = (ms) => new Promise(r => setTimeout(r, ms));
/** Await the `boundary` hook, if any; a throw there aborts the caller at exactly that point. */
export const boundary = async (hooks, name, info) => { if (hooks?.boundary) await hooks.boundary(name, info); };

/** Absolute `git rev-parse --git-path <rel>` for the work tree at `repoRoot`. */
export function gitPath(repoRoot, rel) {
  const r = spawnSync('git', ['rev-parse', '--git-path', rel], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw coded('not_a_repo', `${repoRoot} is not a git work tree`);
  return resolve(repoRoot, r.stdout.trim());
}

/**
 * Atomically persist `state` as JSON: temp write, fsync, rename, directory fsync,
 * each preceded by its hook boundary. On win32 a rename EPERM/EBUSY is retried
 * up to 10 attempts; elsewhere it is thrown at once. A short write, or any failure before the
 * rename, removes the temp file, so the old state stays complete.
 */
export async function writeStateAtomic(file, state, { hooks, fs = {}, platform = process.platform } = {}) {
  const rename = fs.renameSync ?? renameSync, write = fs.writeSync ?? writeSync;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let renamed = false, fd = null;
  try {
    await boundary(hooks, 'temp-write', { file });
    fd = openSync(tmp, 'wx', 0o600);
    const data = Buffer.from(JSON.stringify(state, null, 1) + '\n');
    if (write(fd, data) !== data.length) throw new Error(`short write of ${file}`);
    await boundary(hooks, 'temp-fsync', { file });
    fsyncSync(fd);
    closeSync(fd); fd = null;
    await boundary(hooks, 'rename', { file });
    for (let attempt = 1; ; attempt++) {
      try { rename(tmp, file); break; } catch (e) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(e.code) || attempt >= 10) throw e;
        await delay(10 * attempt);
      }
    }
    renamed = true;
    await boundary(hooks, 'dir-fsync', { file });
    if (platform !== 'win32') {
      const dfd = openSync(dir, 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (!renamed) try { unlinkSync(tmp); } catch { /* never created */ }
  }
}

/** POSIX: whether any process of group `pgid` exists (`kill(-pgid, 0)`); null (unknown) on Windows. */
export function groupAlive(pgid, platform = process.platform) {
  if (platform === 'win32' || !pgid) return null;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}


const RECOVER = 'stop every engine command for this ticket, confirm no engine process is running, then remove';

/**
 * Take the per-ticket engine lock (`O_EXCL` file holding {pid, process_start_time,
 * host, run_id, nonce}). A same-host lock whose PID is dead, or alive with a
 * different start time, is recovered; concurrent recoverers race on an `O_EXCL`
 * recovery marker and re-check the observed nonce, so exactly one wins.
 */
export async function acquireLock(ctx) {
  const lockFile = gitPath(ctx.repoRoot, `ai-skills/ship-ticket/${ctx.ticket}.lock`);
  const info = ctx.processInfo ?? processInfo;
  const pid = ctx.pid ?? process.pid;
  const host = ctx.host ?? hostname();
  const mine = { pid, process_start_time: info(pid)?.startTime ?? null, host, run_id: ctx.runId, nonce: randomUUID() };
  mkdirSync(dirname(lockFile), { recursive: true });
  const create = () => {
    try { writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx', mode: 0o600 }); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  };
  const handle = { lockFile, release: async () => {
    try { if (JSON.parse(readFileSync(lockFile, 'utf8')).nonce === mine.nonce) unlinkSync(lockFile); } catch { /* already gone */ }
  } };
  if (create()) return handle;
  const raw = readFileSync(lockFile, 'utf8');
  let held;
  try { held = JSON.parse(raw); if (!held || typeof held.pid !== 'number' || typeof held.host !== 'string') throw new Error(); }
  catch { throw coded('lock_malformed', `${lockFile} is unreadable; ${RECOVER} it by hand`); }
  if (held.host !== host) throw coded('lock_foreign_host', `${lockFile} is held by host ${held.host}; on that host ${RECOVER} it`);
  const other = info(held.pid) ?? { alive: false, startTime: null };
  // Recovery needs proof: a dead PID, or a live PID whose known start time differs (reuse). A live
  // holder whose start time is unknown on either side is treated as the holder, never broken.
  const reused = other.startTime !== null && (held.process_start_time ?? null) !== null && other.startTime !== held.process_start_time;
  if (other.alive && !reused) throw coded('lock_held', `pid ${held.pid} holds ${lockFile}`);
  await boundary(ctx.hooks, 'lock-stale-observed', { lockFile, held });
  const marker = lockFile + '.recovery';
  try { writeFileSync(marker, JSON.stringify({ pid, nonce: mine.nonce }), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') throw coded('lock_held', `another recovery is in progress (${marker}); if none is, ${RECOVER} the marker`); throw e; }
  try {
    let current = null;
    try { current = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* removed or rewritten */ }
    if (current?.nonce !== held.nonce) throw coded('lock_held', `${lockFile} was recovered by another process`);
    unlinkSync(lockFile);
    if (!create()) throw coded('lock_held', `${lockFile} was taken during recovery`);
    return handle;
  } finally { try { unlinkSync(marker); } catch { /* gone */ } }
}

/** Content fingerprint of a repo-relative path: existence, type, mode and content hash (never mtime). */
export function fingerprint(root, rel) {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing'; throw e; }
  const mode = (st.mode & 0o777).toString(8);
  if (st.isSymbolicLink()) return `l:${readlinkSync(abs)}`;
  if (st.isDirectory()) {
    const kids = readdirSync(abs).sort().map(k => `${k}=${fingerprint(root, rel + '/' + k)}`);
    return `d:${mode}:${sha(kids.join('\n'))}`;
  }
  return `f:${mode}:${sha(readFileSync(abs))}`;
}

/** Fingerprints of `paths` keyed by path. */
export const fingerprints = (root, paths) => Object.fromEntries([...new Set(paths)].map(p => [p, fingerprint(root, p)]));

/** Map of every dirty or untracked path (minus `exclude`) to its fingerprint; null without git. A rename records both paths. */
export function snapshot(root, exclude = []) {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const out = {};
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const paths = [e.slice(3)];
    if (e[0] === 'R' || e[0] === 'C') { i++; if (e[0] === 'R') paths.push(entries[i]); } // a rename's source is gone; a copy's is unchanged
    for (const p of paths) if (!exclude.includes(p)) out[p] = fingerprint(root, p);
  }
  return out;
}

/** Paths whose fingerprint differs between two snapshots. */
export const diffSnapshots = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => a[p] !== b[p]).sort();


/** Append `event` to the JSONL log unless a row with its event_id is already there. */
export function appendLogOnce(file, event) {
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').some(l => { try { return JSON.parse(l).event_id === event.event_id; } catch { return false; } })) return;
  appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(event) + '\n', { mode: 0o600 });
}

/**
 * Insert `event` just before the RUN-STATE END marker (atomic replace) unless its event_id is
 * already recorded. A malformed block is never written into (the owner repairs it first).
 */
export function appendRunStateOnce(planFile, event) {
  const text = readFileSync(planFile, 'utf8');
  const R = parseRunState(text);
  if (!R) throw coded('plan_invalid', 'plan has no RUN-STATE block');
  if (R.events.some(e => e.event_id === event.event_id)) return;
  const bad = malformedReason(R);
  if (bad) throw coded('run_state_malformed', bad);
  const i = text.indexOf(END);
  const tmp = `${planFile}.${process.pid}.tmp`;
  writeFileSync(tmp, text.slice(0, i) + (text[i - 1] === '\n' ? '' : '\n') + eventLine(event) + '\n' + text.slice(i));
  renameSync(tmp, planFile);
}

export const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Read a file's bytes, or null when it does not exist; any other error propagates. */
function readIfExistsBytes(file) {
  try { return readFileSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}

/** Read a text file, or null when it does not exist; any other error propagates. */
export function readIfExists(file) {
  try { return readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/**
 * Start the carrier's launcher in durable mode (own process group on POSIX, blocked on the release
 * byte, envelope written atomically on exit). `files`: { promptFile, outFile, envelopeFile, attemptId }.
 */
export function startLauncher({ spawnFn = spawn, spec, cwd, env, platform, files }) {
  return spawnFn(process.execPath, launcherArgs({ ...spec, ...files }),
    { cwd, env, detached: platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
}
export const RELEASE = RELEASE_BYTE;

/** Commit hash `ref` resolves to in `repoRoot`, or null when it does not resolve. */
export function resolveCommit(repoRoot, ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));

/** Candidate id of the work tree via candidate-id.mjs: `{ candidate_id }` or `{ reason }`; never throws. */
export function candidateId(repoRoot, base, excludes) {
  const args = [CANDIDATE_CLI, '--repo', repoRoot, '--base', base, ...[...new Set(excludes)].flatMap(e => ['--exclude', e])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  try { if (r.status === 0) return { candidate_id: JSON.parse(r.stdout).candidate_id }; } catch { /* reported below */ }
  return { reason: (r.stderr || r.error?.message || 'candidate-id failed').trim() };
}

/** Digest of a repo-relative file ('missing' when absent); paths escaping the repo are refused. */
export function repoFileDigest(repoRoot, rel) {
  const n = normalize(rel);
  if (isAbsolute(n) || n === '..' || n.startsWith('..' + '/') || n.startsWith('..\\')) throw coded('bad_input', `path escapes the repository: ${rel}`);
  const text = readIfExistsBytes(join(repoRoot, n));
  return text === null ? 'missing' : sha(text);
}

/** Probe for risk evidence: whether `rel` names an existing file inside `repoRoot` (an escaping path never does). */
export const evidenceExists = (repoRoot) => (rel) => { try { return repoFileDigest(repoRoot, rel) !== 'missing'; } catch { return false; } };

/** `gateRed` deps for the engine: durable commits, repo file digests, group liveness, the binding re-check and the RED runner. */
export function gateRedDeps({ commit, alive, platform, repoRoot, verifyBinding, ...runner }) {
  return { newAttemptId: () => 'att-' + randomUUID(), commit, digestFile: async (f) => repoFileDigest(repoRoot, f), isGroupAlive: alive,
    platform, verifyBinding, spawnRunner: gateRunner({ repoRoot, platform, alive, ...runner }) };
}

/** Current digests of the named repo-relative artifacts (the gate compares them to the graded ones). */
export const artifactDigests = (repoRoot, artifacts = {}) =>
  Object.fromEntries(Object.entries(artifacts).map(([k, p]) => [k, repoFileDigest(repoRoot, p)]));

/**
 * `gateRed` deps.spawnRunner (also the ship-ready proof runner): the command through the carrier's
 * launcher (own process group, blocked on the release byte, envelope written atomically); `done`
 * reads the envelope and output after the whole group was killed and awaited, and reports
 * `quiescent: true` only when the group is proven gone (false: survived or unknowable).
 */
export function gateRunner({ repoRoot, dir, platform, env, toSpec, alive, spawnFn }) {
  return async ({ attempt_id: id, command, timeoutMs }) => {
    mkdirSync(dir, { recursive: true });
    const promptFile = join(dir, id + '.stdin'), outFile = join(dir, id + '.out'), envelopeFile = join(dir, id + '.envelope.json');
    writeFileSync(promptFile, '', { mode: 0o600 });
    const child = startLauncher({ spawnFn, spec: toSpec(command.cmd, command.args ?? []), cwd: repoRoot, env, platform,
      files: { promptFile, outFile, envelopeFile, attemptId: id } });
    const exited = new Promise(r => { child.on('exit', r); child.on('error', r); });
    child.stdin.on('error', () => {});
    if (!child.pid) { await exited; throw new Error('runner launcher failed to spawn'); }
    const pgid = platform === 'win32' ? null : child.pid;
    let timedOut = false, killing = null;
    const done = (async () => {
      const timer = setTimeout(() => {
        timedOut = true;
        killing = platform === 'win32' ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : killGroup(pgid, alive);
      }, timeoutMs);
      await exited;
      clearTimeout(timer);
      await killing;
      // Whole-group quiescence, checked: true only when the group is proven gone (Windows/no pgid: unknown).
      const quiescent = (pgid ? await quiesce(pgid, alive) : null) === false;
      const envelope = readJson(envelopeFile);
      if (quiescent && envelope?.spawn_error) throw Object.assign(new Error(`command failed to start (${envelope.spawn_error})`), { quiescent });
      return { exitCode: envelope?.exit_code ?? null, stdout: readIfExists(outFile) ?? '', stderr: '', timedOut, quiescent };
    })();
    done.catch(() => {});
    return { pid: child.pid, pgid, release: () => child.stdin.end(RELEASE), done };
  };
}
