/**
 * Specs for AIS-HARNESS-3 Wave 1 (instrumentation, no behaviour change): the launcher's peak
 * resource sampler. Rows run the REAL launcher in durable mode against tiny node children.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launcherArgs, RELEASE_BYTE } from './launcher.mjs';

const WIN_SKIP = process.platform === 'win32' ? 'N7: the sampler is POSIX-only (peak is unknown on Windows)' : false;

/** Run the durable launcher on `script` (node -e); resolves { env, code, pid } after the launcher exits. */
function runLauncher(t, script, { sample, env = process.env, exitCode } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sampler-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'prompt'), 'go');
  const spec = { file: process.execPath, args: ['-e', script], shell: false, promptFile: join(dir, 'prompt'),
    outFile: join(dir, 'out'), envelopeFile: join(dir, 'env.json'), attemptId: 'att-test', ...(sample === false ? { sample } : {}) };
  const child = spawn(process.execPath, launcherArgs(spec), { env, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdin.end(RELEASE_BYTE);
  return new Promise((res) => child.on('exit', (code) => res({ env: JSON.parse(readFileSync(spec.envelopeFile, 'utf8')), code, pid: child.pid })));
}

// 120 MB held (and touched, so resident) for 1.3 s: long enough for the 1 s tick as well as the first sample.
const HOG = `const b = Buffer.alloc(120 * 1024 * 1024, 1); let s = 0; for (let i = 0; i < b.length; i += 4096) s += b[i]; setTimeout(() => process.exit(0), 1300);`;

test('sampler: a child that allocates memory yields a peak RSS reflecting it', { skip: WIN_SKIP }, async (t) => {
  const { env, code } = await runLauncher(t, HOG);
  assert.equal(code, 0);
  assert.equal(typeof env.peak_rss_mb, 'number', JSON.stringify(env));
  assert.ok(env.peak_rss_mb >= 100, `peak ${env.peak_rss_mb} MB should include the 120 MB buffer`);
  assert.ok(env.resource_samples >= 1);
  assert.ok(env.peak_cpu_pct === 'unknown' || typeof env.peak_cpu_pct === 'number');
});

test('sampler: disabled, or ps unavailable, records the string unknown and never 0', { skip: WIN_SKIP }, async (t) => {
  const off = await runLauncher(t, 'setTimeout(() => {}, 300)', { sample: false });
  assert.equal(off.env.peak_rss_mb, 'unknown');
  assert.equal(off.env.peak_cpu_pct, 'unknown');
  assert.equal(off.env.resource_samples, 0);
  const noPs = await runLauncher(t, 'setTimeout(() => {}, 300)', { env: { ...process.env, PATH: '/nonexistent-dir' } });
  assert.equal(noPs.env.peak_rss_mb, 'unknown');
  assert.equal(noPs.env.exit_code, 0);
});

test('sampler: exit codes and the rest of the envelope are unchanged by sampling', { skip: WIN_SKIP }, async (t) => {
  const run = (sample) => runLauncher(t, 'process.stdout.write("hi"); process.exit(3)', { sample });
  const [on, off] = [await run(true), await run(false)];
  assert.equal(on.code, 1); assert.equal(off.code, 1);
  for (const k of ['exit_code', 'signal', 'spawn_error', 'schema', 'attempt_id']) assert.equal(on.env[k], off.env[k], k);
  assert.equal(on.env.exit_code, 3);
});

test('sampler: nothing outlives the attempt (no process left in the launcher group)', { skip: WIN_SKIP }, async (t) => {
  const { pid } = await runLauncher(t, 'setTimeout(() => {}, 1250)');
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }, 'the launcher group is empty: no ps or timer survived');
});

test('sampler: a comma-decimal parent locale (de_DE) still yields a numeric peak', { skip: WIN_SKIP }, async (t) => {
  const de = spawnSync('ps', ['-A', '-o', 'pcpu='], { env: { ...process.env, LC_ALL: 'de_DE.UTF-8' }, encoding: 'utf8' });
  if (!/\d,\d/.test(de.stdout || '')) return t.skip('de_DE.UTF-8 is not installed or ps does not localize %cpu here');
  const { env } = await runLauncher(t, HOG, { env: { ...process.env, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' } });
  assert.equal(typeof env.peak_rss_mb, 'number', JSON.stringify(env));
});
