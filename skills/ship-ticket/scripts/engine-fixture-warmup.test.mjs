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

// ---- Guard (FLAKE-root-cause-report.md, lesson L9): a short run-wide timeoutMs must not bound what should finish by itself.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortRunTimeouts } from './test-wait.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Each allowed short timeoutMs: the file, a snippet of its line, and why nothing that should finish races it. */
const SHORT_TIMEOUT_ALLOWED = [
  ['gate.test.mjs', 'timeoutMs: 60_000,', 'gateRed function input; spawnRunner is a fake, no real process races it'],
  ['gate-security.test.mjs', "config: { provider: 'claude', timeoutMs: 1000, testCommands: { unit: TAP_CMD }", 'secDag: validated only, never driven'],
  ['gate-security.test.mjs', "baselineCandidate: 'sha256:base', timeoutMs: 1000, resources: []", 'gateRed function input with a fake spawnRunner'],
  ['run-engine-cr38.test.mjs', "const DAG = (node = {}, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000", 'validated only, never driven'],
  ['run-engine-cr38.test.mjs', "const redInput = (specs) =>", 'gateRed function input, never spawned'],
  ['run-engine-cr38.test.mjs', "config: { timeoutMs: 1000, budget: { ticket_tokens: 1000000 } }, behaviour: { a: { hang: true } }", 'hang-only: the run\'s one worker hangs, no proof or check runs'],
  ['run-engine-repair.test.mjs', "config: { timeoutMs: 1 }, behaviour: { a: { waitFor: '/nonexistent-never' } }", 'hang-only: the clamp test\'s one worker never finishes'],
  ['run-engine-record.test.mjs', "const dag = (config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000", 'validated only, never driven'],
  ['run-engine-record.test.mjs', "const DAG = JSON.stringify({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }", 'digest literal only, never driven'],
  ['run-engine-units.test.mjs', "config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },", 'dagOf: validated only, never driven'],
  ['run-engine-unit-review.test.mjs', "const dagOf = (nodes, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000", 'validated only, never driven'],
  ['run-engine-unit-review.test.mjs', "workdir: fx.repo, ownership: { writes: [rx === 'urx-1'", 'carrier inspect input: validated, nothing is dispatched'],
  ['run-engine.test.mjs', "config: { timeoutMs: HANG_TIMEOUT_MS }, behaviour: { a: { hang: true } }", 'hang-only: the run\'s one worker hangs (two tests)'],
  ['run-engine.test.mjs', "const base = { schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }", 'validated only, never driven'],
];

test('no engine test sets a short run-wide timeoutMs over work that should finish by itself (every short one is allowlisted with a reason)', () => {
  const files = readdirSync(HERE).filter(f => /\.test\.mjs$|\.test-helper\.mjs$/.test(f) && f !== 'engine-fixture-warmup.test.mjs'); // not this guard's own allowlist and control
  const hits = shortRunTimeouts(files.map(file => ({ file, text: readFileSync(join(HERE, file), 'utf8') })));
  assert.ok(files.length > 20, 'the scan read the engine test files');
  const allowed = (h) => SHORT_TIMEOUT_ALLOWED.some(([f, snippet]) => f === h.file && h.text.includes(snippet));
  const bad = hits.filter(h => !allowed(h));
  assert.deepEqual(bad, [], 'a short timeoutMs bounds builders, proofs and checks too: use WORKER_FAILURE_BOUND_MS and fx.setRunTimeout around the one hanging step, or allowlist it with a reason');
  const stale = SHORT_TIMEOUT_ALLOWED.filter(([f, snippet]) => !hits.some(h => h.file === f && h.text.includes(snippet)));
  assert.deepEqual(stale, [], 'allowlist entries that no longer match a short timeout');
});

test('the short-timeout scan flags a planted short budget and passes the failure bound (positive control)', () => {
  const hits = shortRunTimeouts([{ file: 'x.test.mjs', text: [
    "fixture(t, { config: { timeoutMs: 1000 } });", "fixture(t, { config: { timeoutMs: 2_000 } });", "fixture(t, { config: { timeoutMs: SHORT } });",
    "fixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS } });", "fixture(t, { config: { timeoutMs: 120000 } });"].join('\n') }]);
  assert.deepEqual(hits.map(h => h.line), [1, 2, 3]);
});
