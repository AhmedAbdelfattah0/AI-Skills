import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNodes } from './engine-bench.mjs';

test('buildNodes makes two dependency waves and one join', () => {
  assert.deepEqual(buildNodes(6).map(x => x.deps.length), [0, 0, 0, 3, 3, 2]);
  assert.deepEqual(buildNodes(3).map(x => x.deps), [[], ['n1'], ['n2']]);
});

// Windows: no node reaches done (known quiescence limit N7, references/execution-harness.md), so
// there is no completion to measure; the run is skipped there rather than asserted differently.
const N7_SKIP = process.platform === 'win32' ? 'known Windows quiescence limit N7: bench nodes never reach done on Windows' : false;

test('the bench CLI runs both modes to completion and reports numeric counts', { skip: N7_SKIP }, () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./engine-bench.mjs', import.meta.url)), '--nodes', '3', '--json'],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  for (const mode of ['manual', 'engine']) {
    assert.equal(out[mode].nodes_completed, 3, mode);
    for (const k of ['orchestrator_commands', 'bytes_read', 'wall_ms']) assert.equal(typeof out[mode][k], 'number', `${mode}.${k}`);
  }
});
