/**
 * I/O primitives for the durable run engine (run-engine.mjs): the lock protocol and atomic state
 * persistence (re-exported from lib/durable-io.mjs), content fingerprints and work-tree snapshots,
 * idempotent event sinks, process-group liveness and termination, the launcher start shared with
 * carrier.mjs (one launcher implementation), the gate runner and candidate identity.
 * Node built-ins only. Pure helpers live in engine-dag.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync,
  renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { launcherArgs, RELEASE_BYTE, SEALED_SCHEMA, STDOUT_CAP } from './launcher.mjs';
import { sha, coded } from './engine-dag.mjs';
import { END, parseRunState, malformedReason, eventLine } from './run-state.mjs';
import { killGroup, quiesce, processInfo } from './engine-quiesce.mjs';

export { sha, killGroup, quiesce, processInfo };
// The lock protocol and the atomic state write live in lib/durable-io.mjs (S-30a); re-exported unchanged.
export { delay, boundary, gitPath, writeStateAtomic, acquireLock } from './lib/durable-io.mjs';

/** Absolute git common dir of the work tree at `repoRoot`: shared by every linked work tree, so removing one leaves it intact. */
export function commonGitDir(repoRoot) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw coded('not_a_repo', `${repoRoot} is not a git work tree`);
  return resolve(repoRoot, r.stdout.trim());
}

/** POSIX: whether any process of group `pgid` exists (`kill(-pgid, 0)`); null (unknown) on Windows. */
export function groupAlive(pgid, platform = process.platform) {
  if (platform === 'win32' || !pgid) return null;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}


/** Content fingerprint of a repo-relative path: existence, type, mode and content hash (never mtime). */
export function fingerprint(root, rel) {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing'; throw e; }
  const mode = (st.mode & 0o777).toString(8);
  // A symlink is its link text plus what it resolves to now (a file by its bytes): a declared read
  // whose target changes is stale. A directory target is not walked (no cycles): link text and type only.
  if (st.isSymbolicLink()) {
    let to = 'missing';
    try { const t = statSync(abs); to = t.isFile() ? `f:${sha(readFileSync(abs))}` : t.isDirectory() ? 'd' : 'o'; } catch { /* dangling */ }
    return `l:${readlinkSync(abs)}:${to}`;
  }
  if (st.isDirectory()) {
    const kids = readdirSync(abs).sort().map(k => `${k}=${fingerprint(root, rel + '/' + k)}`);
    return `d:${mode}:${sha(kids.join('\n'))}`;
  }
  return `f:${mode}:${sha(readFileSync(abs))}`;
}

/**
 * Per-entry fingerprints of everything under `rel` (repo-relative): each directory as `d:<mode>`,
 * every other entry as its fingerprint(); a missing path adds nothing. Used to tell which files
 * inside a declared directory changed.
 */
export function treeFingerprints(root, rel, out = {}) {
  let st;
  try { st = lstatSync(join(root, rel)); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return out; throw e; }
  if (!st.isDirectory()) { out[rel] = fingerprint(root, rel); return out; }
  out[rel] = `d:${(st.mode & 0o777).toString(8)}`;
  for (const k of readdirSync(join(root, rel)).sort()) treeFingerprints(root, `${rel}/${k}`, out);
  return out;
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
    // A rename or copy in either column (index, or work tree: e.g. after `git add -N`) is followed by its source:
    // a rename's source is gone, a copy's is unchanged.
    const rc = [e[0], e[1]].find((c) => c === 'R' || c === 'C');
    if (rc) { i++; if (rc === 'R') paths.push(entries[i]); }
    for (const p of paths) if (!exclude.includes(p)) out[p] = fingerprint(root, p);
  }
  return out;
}

/** Paths whose fingerprint differs between two snapshots. */
export const diffSnapshots = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => a[p] !== b[p]).sort();


/**
 * Append `event` to the JSONL log unless a row with its event_id is already there. `line` serializes
 * the row (default JSON.stringify; run-engine.mjs passes run-state.mjs eventLine for switch-on GATE
 * rows, whose untrusted text may hold U+0085/U+2028/U+2029, line breaks to splitLines).
 */
export function appendLogOnce(file, event, line = JSON.stringify) {
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').some(l => { try { return JSON.parse(l).event_id === event.event_id; } catch { return false; } })) return;
  appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line(event) + '\n', { mode: 0o600 });
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
 * `sealed` (runner attempts only: `{ report }`) starts the sealed launcher instead, with its stdout
 * a pipe that carries the result frame; without it (workers) the launch is unchanged.
 */
export function startLauncher({ spawnFn = spawn, spec, cwd, env, platform, files, sealed }) {
  return spawnFn(process.execPath, launcherArgs({ ...spec, ...files, ...(sealed ? { sealed: true, report: sealed.report === true } : {}) }),
    { cwd, env, detached: platform !== 'win32', stdio: ['pipe', sealed ? 'pipe' : 'ignore', 'ignore'], windowsHide: true });
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
  try { if (r.status === 0) { const j = JSON.parse(r.stdout); return { candidate_id: j.candidate_id, paths: (j.paths ?? []).map(p => p.path) }; } } catch { /* reported below */ }
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

/** The typed refusals gateRunner rejects with: callers keep the code and never retry them automatically. */
export const RUNNER_REFUSALS = new Set(['runner_output_tampered', 'runner_survivor', 'channel_unsupported']);

/** Upper bound on a sealed result frame: its header plus the capped stdout and the capped report. */
const FRAME_CAP = 2 * STDOUT_CAP + 1024 * 1024;
/** How long the result pipe may stay open after the launcher exited (it closes it right after the frame). */
export const FRAME_CLOSE_MS = 5000;

/**
 * Decode the sealed launcher's result: exactly one frame (SEALED_SCHEMA header line, then
 * `out_len` stdout bytes, then `report_len` report bytes, nothing after) for `attemptId`.
 * Returns `{ head, stdout, report }` or `{ reason }`.
 */
export function decodeSealedFrame(buf, attemptId) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0 || nl > 65536) return { reason: 'no result frame header' };
  let h;
  try { h = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { return { reason: 'result frame header is not JSON' }; }
  if (h === null || typeof h !== 'object' || h.schema !== SEALED_SCHEMA) return { reason: 'result frame has the wrong schema' };
  if (h.attempt_id !== attemptId) return { reason: `result frame is for attempt ${JSON.stringify(h.attempt_id)}, not ${attemptId}` };
  const len = (v) => Number.isSafeInteger(v) && v >= 0;
  const flags = ['truncated', 'out_eof', 'report', 'report_truncated', 'report_eof'].every(k => typeof h[k] === 'boolean');
  if (!(h.exit_code === null || Number.isSafeInteger(h.exit_code)) || !(h.signal === null || typeof h.signal === 'string')
    || !(h.spawn_error === null || typeof h.spawn_error === 'string') || !flags
    || ![h.out_len, h.report_len, h.stdout_bytes, h.report_bytes].every(len)) return { reason: 'result frame header is malformed' };
  if (buf.length !== nl + 1 + h.out_len + h.report_len) return { reason: `result is ${buf.length} bytes, its frame declares ${nl + 1 + h.out_len + h.report_len}` };
  return { head: h, stdout: buf.subarray(nl + 1, nl + 1 + h.out_len), report: buf.subarray(nl + 1 + h.out_len) };
}

/**
 * `gateRed` deps.spawnRunner (also the ship-ready proof runner and unit checks): the command
 * through the sealed launcher (own process group, blocked on the release byte). Every byte and
 * exit status `done` returns arrives over the launcher's stdout pipe, which only the engine and
 * the launcher hold (probed on darwin and Linux, reasoned on win32): one result frame
 * (decodeSealedFrame) whose exit_code must agree with the launcher's own exit status (0 iff 0),
 * read to EOF. No file is read: the `.out` and envelope files are forensic only.
 * `done` reports `quiescent: true` only when the group is proven gone (false: survived or
 * unknowable). It rejects with `runner_output_tampered` (no well-formed frame for this attempt,
 * a disagreeing or abnormal launcher exit, an oversized frame, a frame not latched at the
 * runner's exit (POSIX), or a result pipe still open `frameCloseMs` after the launcher exited)
 * unless the run timed out, which returns a result with `timedOut: true` and no exit code.
 * It rejects with `runner_survivor` when stdout (or, with `report`, the report channel) was not
 * at EOF at the boundary. In the exit callback the launcher reads each channel in turn with ONE
 * read of up to STDOUT_CAP + 1 bytes, larger than any socket queue, so that single read empties the
 * queue whatever is left unread at exit: it is the channel's latch point (a full read is refused).
 * It is refused when a later read returns any byte (written after the latch point; not kept) or
 * EAGAIN (another process still holds it).
 * Claim (exact): the decision predicate is the OBSERVED EOF/open/read-error state of each
 * channel at its latching read in the exit callback, per channel, platform and read cap (runner
 * stdout on POSIX; plus the report channel on darwin, whose latching read comes after stdout's).
 * A channel still open there (EAGAIN), returning bytes after that read, or failing to read is
 * refused. Writes made earlier, or during earlier reads before the latch, are accepted, including
 * those of a process handed the descriptor by an in-run holder; no additional verdict manipulation
 * has been demonstrated under the current adapters and the tested threat model (see the in-run
 * injection risk R-T2). This is not an atomic snapshot and writers are not authenticated. (R-T2: design §6.1.)
 * Measured on PR #94
 * head 4180cbc, a fast write-then-close survivor is accepted: Linux Node 18 100/100, Node 22
 * 91/100; darwin Node 18 84/100, Node 22 6/100. RECOMMENDED for temporary risk acceptance; the
 * owner's decision is PENDING (HANDOVER OD-D4 reverted on 2026-11-18). Recommended conditions:
 * macOS harness 18/22 + engine-properties green on the final head; both independent reviews on the
 * final head, no waiver; append-after-exit case in the adapter-qualification series; sandbox
 * isolation (S-03/S-18) remains the real closure, as remediation item FX-R1: runner execution
 * isolation (sandbox/pid-namespace) to close the post-exit window; Linux is stdout only.
 * `report` must be a boolean (anything else rejects `bad_input`). `report: true` adds the report
 * channel (the runner's fd 3, reached as /dev/fd/3; measured on darwin only, so any other
 * platform rejects `channel_unsupported` before anything starts): the result then carries
 * `report` (bytes) and `report_eof: true`.
 */
export function gateRunner({ repoRoot, dir, platform, env, toSpec, alive, spawnFn, frameCloseMs = FRAME_CLOSE_MS }) {
  return async ({ attempt_id: id, command, timeoutMs, report = false }) => {
    if (typeof report !== 'boolean') throw coded('bad_input', `report must be true or false, not ${JSON.stringify(report)}`);
    if (report === true && platform !== 'darwin') {
      throw coded('channel_unsupported', `the runner report channel (/dev/fd/3) is unsupported on ${platform} (Linux: /dev/fd/N on a socketpair is ENXIO; win32: no /dev/fd)`);
    }
    mkdirSync(dir, { recursive: true });
    const outFile = join(dir, id + '.out'), envelopeFile = join(dir, id + '.envelope.json');
    const child = startLauncher({ spawnFn, spec: toSpec(command.cmd, command.args ?? []), cwd: repoRoot, env, platform,
      files: { outFile, envelopeFile, attemptId: id }, sealed: { report: report === true } });
    const chunks = [];
    let got = 0;
    // Read the result pipe from the start: a large frame must never block the launcher's write.
    const closed = new Promise(r => {
      if (!child.stdout) return r();
      child.stdout.on('data', c => { got += c.length; if (got <= FRAME_CAP) chunks.push(c); });
      child.stdout.on('error', () => r());
      child.stdout.on('close', () => r());
    });
    const exited = new Promise(r => { child.on('exit', (code, signal) => r({ code, signal })); child.on('error', () => r({ code: null, signal: null })); });
    child.stdin.on('error', () => {});
    if (!child.pid) { await exited; throw new Error('runner launcher failed to spawn'); }
    const pgid = platform === 'win32' ? null : child.pid;
    let timedOut = false, killing = null;
    const done = (async () => {
      const timer = setTimeout(() => {
        timedOut = true;
        killing = platform === 'win32' ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : killGroup(pgid, alive);
      }, timeoutMs);
      const status = await exited;
      clearTimeout(timer);
      await killing;
      let grace;
      const pipeClosed = await Promise.race([closed.then(() => true), new Promise(r => { grace = setTimeout(() => r(false), frameCloseMs); })]);
      clearTimeout(grace);
      if (!pipeClosed) child.stdout.destroy();
      // Whole-group quiescence, checked: true only when the group is proven gone (Windows/no pgid: unknown).
      const quiescent = (pgid ? await quiesce(pgid, alive) : null) === false;
      const frame = !pipeClosed ? { reason: `the result pipe was still open ${frameCloseMs} ms after the launcher exited` }
        : got > FRAME_CAP ? { reason: `the result exceeds ${FRAME_CAP} bytes` } : decodeSealedFrame(Buffer.concat(chunks), id);
      const h = frame.head;
      const agrees = h !== undefined && status.signal === null && status.code !== null && (status.code === 0) === (h.exit_code === 0);
      if (!agrees) {
        if (timedOut) return { exitCode: null, stdout: '', stderr: '', timedOut, quiescent };
        const why = frame.reason ?? `launcher exit ${status.signal ?? status.code} disagrees with the frame's exit_code ${h.exit_code}`;
        throw Object.assign(coded('runner_output_tampered', `runner result refused: ${why}`), { quiescent });
      }
      if (quiescent && h.spawn_error) throw Object.assign(new Error(`command failed to start (${h.spawn_error})`), { quiescent });
      if (!h.spawn_error) {
        // The boundary is the launcher's observed runner exit (win32: the weaker drain, see launcher.mjs).
        if (h.boundary !== 'exit' && !(platform === 'win32' && h.boundary === 'drain')) {
          throw Object.assign(coded('runner_output_tampered', `runner result refused: boundary ${JSON.stringify(h.boundary)} on ${platform}`), { quiescent });
        }
        const open = [!h.out_eof && 'stdout', report === true && !h.report_eof && 'the report channel'].filter(Boolean);
        if (open.length) {
          throw Object.assign(coded('runner_survivor', `${open.join(' and ')} still open when the runner exited: another process held it, so its bytes are not the runner's alone`), { quiescent });
        }
      }
      return { exitCode: h.exit_code, stdout: frame.stdout.toString('utf8'), stderr: '', timedOut, quiescent,
        ...(h.truncated ? { truncated: true, stdout_bytes: h.stdout_bytes } : {}),
        ...(report === true ? { report: frame.report, report_eof: true, ...(h.report_truncated ? { report_truncated: true, report_bytes: h.report_bytes } : {}) } : {}) };
    })();
    done.catch(() => {});
    return { pid: child.pid, pgid, release: () => child.stdin.end(RELEASE), done };
  };
}
