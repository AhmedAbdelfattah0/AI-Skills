/**
 * The launchers of ship-ticket. LAUNCHER is shared by carrier.mjs (dispatch) and the run engine's
 * workers (engine-io.mjs); SEALED_LAUNCHER runs the engine's runner attempts (RED, proof, unit
 * checks) and returns their result over the engine's own pipe. Node built-ins only.
 */

/** Byte the carrier (and the run engine) writes to the launcher's stdin to let the provider CLI start. */
export const RELEASE_BYTE = Buffer.from([0x06]);
/** Durable mode: how long the launcher drains stdout after the provider exits before it completes. */
const DRAIN_MS = 1000;
/** Resource sampler cadence (see the launcher). */
const SAMPLE_MS = 1000, FIRST_SAMPLE_MS = 100;
/** Durable mode keeps at most this much stdout; beyond it the envelope carries `truncated` (B12: flagged, never a failure). */
export const STDOUT_CAP = 32 * 1024 * 1024;

/** The durable launchers' resource sampler (source text, shared by LAUNCHER and SEALED_LAUNCHER). */
const SAMPLER = `  // Resource sampler (durable mode, POSIX): every ${SAMPLE_MS} ms (first sample after ${FIRST_SAMPLE_MS} ms) one async \`ps\` of the
  // launcher's own process group, minus the launcher and the ps itself. Keeps the max summed RSS (KiB) and the max summed
  // ps %cpu (a per-process lifetime average, so an estimate). Observation only: timers are unref'd, any failure
  // leaves n = 0 (reported as 'unknown', never 0), and stopSampler() kills an in-flight ps before the envelope.
  const sm = { n: 0, rss: 0, cpu: 0, ps: null, timers: [] };
  const sampling = durable && spec.sample !== false && process.platform !== 'win32';
  const sample = () => {
    if (sm.ps || done) return;
    try {
      const ps = require('node:child_process').execFile('ps', ['-A', '-o', 'pid=,pgid=,rss=,pcpu='], { timeout: 2000, maxBuffer: 8388608, env: Object.assign({}, process.env, { LC_ALL: 'C' }) }, (err, so) => {
        sm.ps = null;
        if (err || done) return;
        try {
          const rows = String(so).split('\\n').map((l) => l.trim().split(/\\s+/).map(Number)).filter((r) => r.length === 4 && r.every(Number.isFinite));
          const me = rows.find((r) => r[0] === process.pid);
          if (!me) return;
          let rss = 0, cpu = 0, any = false;
          for (const r of rows) if (r[1] === me[1] && r[0] !== process.pid && r[0] !== ps.pid) { rss += r[2]; cpu += r[3]; any = true; }
          if (!any) return;
          sm.n++; sm.rss = Math.max(sm.rss, rss); sm.cpu = Math.max(sm.cpu, cpu);
        } catch {}
      });
      sm.ps = ps;
      ps.on('error', () => {});
    } catch {}
  };
  const stopSampler = () => {
    for (const t of sm.timers) { clearTimeout(t); clearInterval(t); }
    try { if (sm.ps) sm.ps.kill('SIGKILL'); } catch {}
  };
`;

/**
 * Launcher (CommonJS, run with `node -e`), shared by the carrier and the run engine. argv[1] is
 * JSON `{file, args, shell}` plus, in durable mode, `{promptFile, outFile, envelopeFile, attemptId}`.
 * It waits for the release byte; stdin closing first, or a wrong first byte, exits 125 without
 * running the worker. Then it spawns the provider in its own process group (inherited).
 * - Carrier mode: forwards the rest of stdin, inherits stdout/stderr and mirrors the provider's
 *   exit code or signal; a provider spawn failure exits 127.
 * - Durable mode (engine): the prompt comes from promptFile, stdout is captured to outFile (the
 *   chunks that fit in STDOUT_CAP bytes; past it the envelope adds `truncated: true` and the full
 *   `stdout_bytes`, and the attempt outcome is decided exactly as without the flag), and
 *   once the provider exits (after its stdout closes, or a DRAIN_MS drain when a descendant keeps
 *   stdout open) the completion envelope is written atomically (fsync + rename), so an orphaned
 *   worker's outcome survives the engine. The engine then retires the whole group, killing any
 *   descendant that is still alive (engine-quiesce.mjs).
 */
const LAUNCHER = `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const spec = JSON.parse(process.argv[1]);
const durable = typeof spec.envelopeFile === 'string';
let started = false, done = false;
process.stdin.on('end', () => { if (!started) process.exit(125); });
process.stdin.on('error', () => { if (!started) process.exit(125); });
process.stdin.once('data', (chunk) => {
  if (chunk[0] !== ${RELEASE_BYTE[0]}) process.exit(125);
  started = true;
  process.stdin.pause();
  const out = [];
  let size = 0;
${SAMPLER}  const envelope = (code, signal, error) => {
    stopSampler();
    fs.writeFileSync(spec.outFile, Buffer.concat(out), { mode: 0o600 });
    const tmp = spec.envelopeFile + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, JSON.stringify({ schema: 'ship-ticket-engine-envelope-v1', attempt_id: spec.attemptId,
      exit_code: code, signal: signal || null, spawn_error: error || null, stdout_file: spec.outFile, ended_at: new Date().toISOString(),
      peak_rss_mb: sm.n ? Math.round(sm.rss / 1024 * 10) / 10 : 'unknown', peak_cpu_pct: sm.n ? Math.round(sm.cpu * 10) / 10 : 'unknown', resource_samples: sm.n,
      ...(size > ${STDOUT_CAP} ? { truncated: true, stdout_bytes: size } : {}) }));
    fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, spec.envelopeFile);
    process.exit(code === 0 ? 0 : 1);
  };
  const finish = (code, signal, error) => {
    if (done) return; done = true;
    if (durable) return envelope(code, signal, error);
    if (error) { process.stderr.write('launcher: ' + error + '\\n'); process.exit(127); }
    if (signal) {
      process.removeAllListeners(signal);
      try { process.kill(process.pid, signal); setTimeout(() => process.exit(1), 1000); return; } catch {}
    }
    process.exit(code === null ? 1 : code);
  };
  let cli;
  try { cli = spawn(spec.file, spec.args, { shell: spec.shell, windowsHide: true, stdio: ['pipe', durable ? 'pipe' : 'inherit', durable ? 'ignore' : 'inherit'] }); }
  catch (e) { return finish(null, null, e.code || 'spawn_error'); }
  cli.on('error', (e) => finish(null, null, e.code || 'spawn_error'));
  cli.stdin.on('error', () => {});
  if (sampling) {
    const first = setTimeout(sample, ${FIRST_SAMPLE_MS}), every = setInterval(sample, ${SAMPLE_MS});
    first.unref(); every.unref(); sm.timers.push(first, every);
  }
  if (durable) {
    cli.stdout.on('data', (c) => { size += c.length; if (size <= ${STDOUT_CAP}) out.push(c); });
    let exited = null;
    cli.on('exit', (code, signal) => { exited = [code, signal]; setTimeout(() => finish(code, signal, null), ${DRAIN_MS}); });
    cli.on('close', (code, signal) => finish(exited ? exited[0] : code, exited ? exited[1] : signal, null));
    cli.stdin.end(fs.readFileSync(spec.promptFile));
    return;
  }
  cli.on('exit', (code, signal) => finish(code, signal, null));
  if (chunk.length > 1) cli.stdin.write(chunk.subarray(1));
  process.stdin.pipe(cli.stdin);
});
`;

/** Schema of the sealed launcher's result frame (engine-io.mjs decodeSealedFrame). */
export const SEALED_SCHEMA = 'ship-ticket-sealed-result-v1';

/**
 * Sealed launcher (CommonJS, `node -e`): the run engine's RUNNER attempts only (RED, proof, unit
 * checks; design S-01b2 rev 6 §2.3). Workers and the carrier never use it. argv[1] is JSON
 * `{file, args, shell, outFile, envelopeFile, attemptId}` plus optional `report: true` / `sample: false`.
 * Same release protocol and process group as LAUNCHER; the runner's stdin is empty. Its own fd 1
 * is a pipe the engine holds (its absence from the runner and descendants is probed on darwin and
 * Linux, reasoned on win32). The boundary is the launcher's observed child `exit` (POSIX;
 * `boundary: 'exit'`): in that callback it reads each channel in turn, synchronously and
 * non-blocking. One read of up to STDOUT_CAP + 1 bytes (more than any socket queue holds) empties
 * the channel's queue and is its latch point (a full read is refused); the channel is at EOF only
 * when the next read returns EOF (EAGAIN or any further byte: not at EOF, and that byte is not
 * kept). No drain follows. Claim (exact): runner stdout (POSIX; plus the report channel on darwin)
 * is refused if any process still holds the channel at the channel's latching read in the exit
 * callback. A process that wrote and closed just before that read, including one handed the
 * descriptor by an in-run holder, is accepted; such bytes are the in-run injection risk R-T2, not
 * a new route. This is not an atomic snapshot and writers are not authenticated. (The report
 * channel's latching read comes after the read of stdout.)
 * On win32, which exposes no descriptor to read, it waits up to DRAIN_MS for
 * EOF instead (`boundary: 'drain'`, weaker). It then writes ONE length-framed result to fd 1,
 * before any file: a JSON header line (SEALED_SCHEMA, attempt_id, exit_code and signal from its own
 * child `exit`, spawn_error, boundary, out_len, truncated, stdout_bytes, out_eof, report,
 * report_len, report_truncated, report_bytes, report_eof), then the stdout bytes, then the report
 * bytes. The write loops over EAGAIN; fd 1 is then closed and the launcher exits 0 iff exit_code is 0.
 * - `out_eof` / `report_eof` are true only when that channel reached EOF right after its latch
 *   point, i.e. no process other than the dead runner held it then. The engine refuses either
 *   being false. `testHooks` (tests only) instruments these reads; the engine never sets it.
 * - `report: true`: the runner gets a pathless pipe at fd 3 (reached as /dev/fd/3), collected up to
 *   STDOUT_CAP.
 * - `.out` and the envelope are forensic copies, written after the frame and never read for a
 *   decision: each goes to a fresh `<file>.tmp` (O_EXCL, no-follow) renamed over the name, so a
 *   planted FIFO, symlink or file there is skipped and can never block the launcher.
 */
const SEALED_LAUNCHER = `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const spec = JSON.parse(process.argv[1]);
const durable = true;
let started = false, done = false;
process.stdin.on('end', () => { if (!started) process.exit(125); });
process.stdin.on('error', () => { if (!started) process.exit(125); });
process.stdin.once('data', (chunk) => {
  if (chunk[0] !== ${RELEASE_BYTE[0]}) process.exit(125);
  started = true;
  process.stdin.pause();
  const out = [], rep = [];
  let size = 0, rsize = 0, outEof = false, repEof = false, latched = false, boundary = null;
${SAMPLER}  const nap = new Int32Array(new SharedArrayBuffer(4));
  const writeAll = (fd, buf) => {
    for (let off = 0; off < buf.length;) {
      try { off += fs.writeSync(fd, buf, off, buf.length - off); } catch (e) { if (e.code !== 'EAGAIN') throw e; Atomics.wait(nap, 0, 0, 1); }
    }
  };
  const CREATE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const forensic = (file, bytes) => {
    try {
      const tmp = file + '.tmp', fd = fs.openSync(tmp, CREATE, 0o600);
      try { writeAll(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } catch {}
  };
  const finish = (code, signal, error) => {
    if (done) return; done = true;
    stopSampler();
    const stdout = Buffer.concat(out), report = Buffer.concat(rep);
    const head = { schema: '${SEALED_SCHEMA}', attempt_id: spec.attemptId, exit_code: code, signal: signal || null, spawn_error: error || null,
      boundary, out_len: stdout.length, truncated: size > ${STDOUT_CAP}, stdout_bytes: size, out_eof: outEof,
      report: spec.report === true, report_len: report.length, report_truncated: rsize > ${STDOUT_CAP}, report_bytes: rsize, report_eof: repEof };
    try { writeAll(1, Buffer.concat([Buffer.from(JSON.stringify(head) + '\\n'), stdout, report])); } catch {}
    try { fs.closeSync(1); } catch {}
    forensic(spec.outFile, stdout);
    forensic(spec.envelopeFile, Buffer.from(JSON.stringify({ schema: 'ship-ticket-engine-envelope-v1', attempt_id: spec.attemptId,
      exit_code: code, signal: signal || null, spawn_error: error || null, stdout_file: spec.outFile, ended_at: new Date().toISOString(),
      peak_rss_mb: sm.n ? Math.round(sm.rss / 1024 * 10) / 10 : 'unknown', peak_cpu_pct: sm.n ? Math.round(sm.cpu * 10) / 10 : 'unknown', resource_samples: sm.n,
      ...(size > ${STDOUT_CAP} ? { truncated: true, stdout_bytes: size } : {}) })));
    process.exit(code === 0 ? 0 : 1);
  };
  let cli;
  try { cli = spawn(spec.file, spec.args, { shell: spec.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', ...(spec.report === true ? ['pipe'] : [])] }); }
  catch (e) { return finish(null, null, e.code || 'spawn_error'); }
  cli.on('error', (e) => finish(null, null, e.code || 'spawn_error'));
  cli.stdin.on('error', () => {});
  if (sampling) {
    const first = setTimeout(sample, ${FIRST_SAMPLE_MS}), every = setInterval(sample, ${SAMPLE_MS});
    first.unref(); every.unref(); sm.timers.push(first, every);
  }
  // Decision bytes are only those read by each channel's latching read in the exit callback (the
  // boundary): each channel's EOF state is latched there and nothing read later is kept.
  const takeOut = (c) => { if (latched) return; size += c.length; if (size <= ${STDOUT_CAP}) out.push(c); };
  const takeRep = (c) => { if (latched) return; rsize += c.length; if (rsize <= ${STDOUT_CAP}) rep.push(c); };
  cli.stdout.on('data', takeOut);
  cli.stdout.on('end', () => { if (!latched) outEof = true; });
  cli.stdout.on('error', () => {});
  // Test instrumentation only (engine-runner-sealed.test.mjs; gateRunner never sets testHooks):
  // stopReads leaves stdout unread until the exit callback; pauseFile/resumeFile pause after the
  // first synchronous read of a channel until the test lets it continue (at most 10 s);
  // destroyStdout drops the stdout handle (no descriptor left to read at the exit: must refuse).
  const hooks = spec.testHooks || {};
  if (hooks.stopReads === true) { try { cli.stdout._handle.readStop(); } catch {} }
  if (hooks.destroyStdout === true) cli.stdout.destroy();
  let paused = false;
  const pause = () => {
    if (paused || typeof hooks.pauseFile !== 'string') return;
    paused = true;
    try { fs.writeFileSync(hooks.pauseFile, ''); } catch {}
    for (const end = Date.now() + 10000; Date.now() < end && !fs.existsSync(hooks.resumeFile);) Atomics.wait(nap, 0, 0, 5);
  };
  const r = spec.report === true ? cli.stdio[3] : null;
  if (r) {
    r.on('data', takeRep);
    r.on('end', () => { if (!latched) repEof = true; });
    r.on('error', () => {});
  }
  // The runner is dead: its own descriptors closed before its exit was reported, so whatever it wrote
  // is already in the socket. Read each channel in turn, synchronously (non-blocking): one read
  // larger than any queue empties it and latches it. Then EOF means no process holds it; EAGAIN or
  // any further byte means one does (a survivor): not at EOF, refused. Not an atomic snapshot and
  // writers are not authenticated: bytes a process wrote and closed before the latch point are kept
  // (the in-run injection risk R-T2; RECOMMENDED for temporary risk acceptance, the owner's decision
  // is PENDING: HANDOVER OD-D4 reverted on 2026-11-18; remediation item FX-R1).
  const fdOf = (s) => (s && !s.destroyed && s._handle && Number.isInteger(s._handle.fd) && s._handle.fd >= 0 ? s._handle.fd : -1);
  const drain = (s, take) => {
    const fd = fdOf(s);
    if (fd < 0) return false;
    // One read larger than any socket queue (STDOUT_CAP + 1) empties the queue: that instant latches
    // the channel. A full read (the queue was not emptied) or any byte read after the latch (written
    // after it) refuses the channel (not at EOF); such bytes are not kept.
    const b = Buffer.allocUnsafe(${STDOUT_CAP} + 1);
    let emptied = false;
    for (;;) {
      let n;
      try { n = fs.readSync(fd, b, 0, b.length, null); } catch (e) { if (e.code === 'EINTR') continue; return false; }
      if (n === 0) return true;
      if (emptied || n === b.length) return false;
      take(Buffer.from(b.subarray(0, n)));
      emptied = true;
      pause();
    }
  };
  const latch = () => {
    if (!outEof) outEof = drain(cli.stdout, takeOut);
    if (r && !repEof) repEof = drain(r, takeRep);
    latched = true;
  };
  cli.on('exit', (code, signal) => {
    if (process.platform !== 'win32') { boundary = 'exit'; latch(); return finish(code, signal, null); }
    // win32 has no descriptor to read synchronously: the weaker 'drain' boundary (EOF within DRAIN_MS of the exit).
    boundary = 'drain';
    const settle = () => { latched = true; finish(code, signal, null); };
    const t = setTimeout(settle, ${DRAIN_MS});
    cli.on('close', () => { clearTimeout(t); settle(); });
  });
  cli.stdin.end();
});
`;

const DURABLE_KEYS = ['promptFile', 'outFile', 'envelopeFile', 'attemptId'];
const SEALED_KEYS = ['outFile', 'envelopeFile', 'attemptId'];
const SAMPLER_OFF = 'SHIP_TICKET_SAMPLER_OFF';

/**
 * Arguments that run the launcher for a resolved provider spawn spec (durable mode when
 * `spec.envelopeFile` is set). `spec.sealed === true` (engine runner attempts only) selects
 * SEALED_LAUNCHER; without it the output is byte-identical to before the sealed launcher existed.
 */
export function launcherArgs(spec) {
  const sample = spec.sample === false || process.env[SAMPLER_OFF] === '1' ? { sample: false } : {};
  if (spec.sealed === true) {
    return ['-e', SEALED_LAUNCHER, JSON.stringify({ file: spec.file, args: spec.args, shell: spec.shell,
      ...Object.fromEntries(SEALED_KEYS.map(k => [k, spec[k]])), ...(spec.report === true ? { report: true } : {}),
      ...(spec.testHooks ? { testHooks: spec.testHooks } : {}), ...sample })];
  }
  const durable = typeof spec.envelopeFile === 'string' ? Object.fromEntries(DURABLE_KEYS.map(k => [k, spec[k]])) : {};
  return ['-e', LAUNCHER, JSON.stringify({ file: spec.file, args: spec.args, shell: spec.shell, ...durable, ...sample })];
}

