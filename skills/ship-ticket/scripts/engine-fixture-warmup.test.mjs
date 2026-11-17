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
/**
 * Each allowed short timeoutMs, matched EXACTLY: [file, the whole trimmed source line, how many times that line
 * occurs as a hit, why nothing that should finish races it]. A copy of an allowed line elsewhere in the file changes
 * the count and fails; an entry whose line or count no longer matches fails as stale.
 */
const SHORT_TIMEOUT_ALLOWED = [
  ["gate-security.test.mjs", "config: { provider: 'claude', timeoutMs: 1000, testCommands: { unit: TAP_CMD }, securityPolicy: 2, catalogDigest: DIGEST,", 1, "secDag: validated only, never driven"],
  ["gate-security.test.mjs", "baselineCandidate: 'sha256:base', timeoutMs: 1000, resources: [], ...over });", 1, "redIn: gateRed function input with a fake spawnRunner"],
  ["gate.test.mjs", "timeoutMs: 60_000,", 1, "gateRed function input; spawnRunner is a fake, no real process races it"],
  ["run-engine-cr38.test.mjs", "const DAG = (node = {}, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, ...config },", 1, "validated only, never driven"],
  ["run-engine-cr38.test.mjs", "const redInput = (specs) => ({ state: { nodes: {} }, node: 'r', command: { cmd: 'x', args: [] }, format: 'tap', specs, baselineCandidate: 'sha256:base', timeoutMs: 1000 });", 1, "gateRed function input, never spawned"],
  ["run-engine-cr38.test.mjs", "const fx = fixture(t, { config: { timeoutMs: 1000, budget: { ticket_tokens: 1000000 } }, behaviour: { a: { hang: true } } });", 1, "hang-only (4505924504): the run's one worker hangs, no proof or check runs"],
  ["run-engine-record.test.mjs", "const dag = (config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, ...config }, nodes: [{ id: 'a', promptFile: '/p' }] });", 1, "validated only, never driven"],
  ["run-engine-record.test.mjs", "const DAG = JSON.stringify({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }, nodes: [{ id: 'a', promptFile: '/p' }] });", 1, "digest literal only, never driven"],
  ["run-engine-repair.test.mjs", "const fx = fixture(t, { config: { timeoutMs: 1 }, behaviour: { a: { waitFor: '/nonexistent-never' } } });", 1, "hang-only: the clamp test's one worker never finishes"],
  ["run-engine-unit-review.test.mjs", "const dagOf = (nodes, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },", 1, "validated only, never driven"],
  ["run-engine-unit-review.test.mjs", "writeFileSync(f, J({ phase: 'REPAIR', provider: 'claude', nodeId: `repair-${rx}`, workdir: fx.repo, ownership: { writes: [rx === 'urx-1' ? 'src/a.txt' : 'src/b.txt'] }, timeoutMs: 10000,", 1, "carrier inspect input: validated, nothing is dispatched"],
  ["run-engine-units.test.mjs", "config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },", 1, "dagOf: validated only, never driven"],
  ["run-engine.test.mjs", "const fx = fixture(t, { config: { timeoutMs: HANG_TIMEOUT_MS }, behaviour: { a: { hang: true } } });", 2, "hang-only: in each of the two tests the run's one worker hangs"],
  ["run-engine.test.mjs", "const base = { schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }, nodes: [{ id: 'a', promptFile: 'p.txt' }] };", 1, "validated only, never driven"],
];

test('no engine test sets a short run-wide timeoutMs over work that should finish by itself (every short one is allowlisted exactly, with a reason)', () => {
  const files = readdirSync(HERE).filter(f => /\.test\.mjs$|\.test-helper\.mjs$/.test(f) && f !== 'engine-fixture-warmup.test.mjs'); // not this guard's own allowlist and control
  const hits = shortRunTimeouts(files.map(file => ({ file, text: readFileSync(join(HERE, file), 'utf8') })));
  assert.ok(files.length > 20, 'the scan read the engine test files');
  const key = (f, text) => JSON.stringify([f, text]);
  const counts = new Map();
  for (const h of hits) counts.set(key(h.file, h.text), (counts.get(key(h.file, h.text)) ?? 0) + 1);
  const allowed = new Map(SHORT_TIMEOUT_ALLOWED.map(([f, line, n]) => [key(f, line), n]));
  const bad = hits.filter(h => !allowed.has(key(h.file, h.text)));
  assert.deepEqual(bad, [], 'a short timeoutMs bounds builders, proofs and checks too: use WORKER_FAILURE_BOUND_MS and fx.setRunTimeout around the one hanging step (restored after), or allowlist the exact line with a reason');
  const mismatched = SHORT_TIMEOUT_ALLOWED.filter(([f, line, n]) => (counts.get(key(f, line)) ?? 0) !== n).map(([f, line, n]) => ({ f, line, want: n, got: counts.get(key(f, line)) ?? 0 }));
  assert.deepEqual(mismatched, [], 'allowlist entries that are stale or whose occurrence count changed');
});

test('the short-timeout scan flags a planted short budget and passes the failure bound (positive control)', () => {
  const hits = shortRunTimeouts([{ file: 'x.test.mjs', text: [
    "fixture(t, { config: { timeoutMs: 1000 } });", "fixture(t, { config: { timeoutMs: 2_000 } });", "fixture(t, { config: { timeoutMs: SHORT } });",
    "fixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS } });", "fixture(t, { config: { timeoutMs: 120000 } });",
    "const BUDGET_MS = 500;", "fixture(t, { config: { timeoutMs: BUDGET_MS } });", "const ROOM = 120000;", "fixture(t, { config: { timeoutMs: ROOM } });"].join('\n') }]);
  assert.deepEqual(hits.map(h => h.line), [1, 2, 3, 7], 'a name resolves per file: BUDGET_MS = 500 is short, ROOM = 120000 is a bound');
  const pairing = (calls) => shortRunTimeouts([{ file: 'y.test.mjs', text: calls.join('\n') }]).map(h => h.text);
  assert.deepEqual(pairing(['fx.setRunTimeout(1000);', 'fx.setRunTimeout(WORKER_FAILURE_BOUND_MS);']), []);
  assert.deepEqual(pairing(['fx.setRunTimeout(1000);']), ['unpaired setRunTimeout'], 'a short budget never restored is flagged');
});
