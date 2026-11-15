/** The fixture warms its fake `claude` once so the engine's 15 s subscription check never pays the first-exec stall (#49). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fixture, POSIX } from './engine-test-fixture.mjs';

test('fixture warms the fake claude, leaving no run log line and an auth exec that exits 0', { skip: !POSIX && 'POSIX wrapper only' }, (t) => {
  const fx = fixture(t);
  assert.equal(fx.warmedUp, true);
  assert.deepEqual(fx.runs(), []);
  const r = spawnSync(join(fx.root, 'bin', 'claude'), ['auth', 'status', '--json'], { env: fx.env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).authMethod, 'claude.ai');
  assert.deepEqual(fx.runs(), []);
});
