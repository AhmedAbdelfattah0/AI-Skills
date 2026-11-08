/**
 * The one worker launcher of ship-ticket, shared by carrier.mjs (dispatch) and the run engine
 * (engine-io.mjs: workers, RED runners and proof runners). Node built-ins only.
 */

/** Byte the carrier (and the run engine) writes to the launcher's stdin to let the provider CLI start. */
export const RELEASE_BYTE = Buffer.from([0x06]);
/** Durable mode: how long the launcher drains stdout after the provider exits before it completes. */
const DRAIN_MS = 1000;
/** Resource sampler cadence (see the launcher). */
const SAMPLE_MS = 1000, FIRST_SAMPLE_MS = 100;
/** Durable mode keeps at most this much stdout; beyond it the envelope carries `truncated` (B12: flagged, never a failure). */
export const STDOUT_CAP = 32 * 1024 * 1024;

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
  // Resource sampler (durable mode, POSIX): every ${SAMPLE_MS} ms (first sample after ${FIRST_SAMPLE_MS} ms) one async \`ps\` of the
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
  const envelope = (code, signal, error) => {
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

const DURABLE_KEYS = ['promptFile', 'outFile', 'envelopeFile', 'attemptId'];
const SAMPLER_OFF = 'SHIP_TICKET_SAMPLER_OFF';

/** Arguments that run the launcher for a resolved provider spawn spec (durable mode when `spec.envelopeFile` is set). */
export function launcherArgs(spec) {
  const durable = typeof spec.envelopeFile === 'string' ? Object.fromEntries(DURABLE_KEYS.map(k => [k, spec[k]])) : {};
  return ['-e', LAUNCHER, JSON.stringify({ file: spec.file, args: spec.args, shell: spec.shell, ...durable,
    ...(spec.sample === false || process.env[SAMPLER_OFF] === '1' ? { sample: false } : {}) })];
}

