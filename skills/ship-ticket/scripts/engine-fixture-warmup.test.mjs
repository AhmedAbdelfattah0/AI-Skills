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

// ---- Guard (load-sensitive engine tests, PR #84): a short run-wide timeoutMs must not bound work that should finish by itself.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortRunTimeouts, allowlistDiff } from './test-wait.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Each allowed short timeoutMs, matched EXACTLY: [file, the whole trimmed line, how many times that line occurs as a
 * hit, why nothing that should finish by itself races it]. A copy of an allowlisted line used elsewhere changes the
 * count and fails; an edited line no longer matches and fails (unlisted, plus a stale entry).
 */
const SHORT_TIMEOUT_ALLOWED = [
  ['gate.test.mjs', 'timeoutMs: 60_000,', 1, 'gateRed function input; spawnRunner is a fake, no real process races it'],
  ['gate-security.test.mjs', "config: { provider: 'claude', timeoutMs: 1000, testCommands: { unit: TAP_CMD }, securityPolicy: 2, catalogDigest: DIGEST,", 1, 'secDag: validated only, never driven'],
  ['gate-security.test.mjs', "baselineCandidate: 'sha256:base', timeoutMs: 1000, resources: [], ...over });", 1, 'redIn: gateRed function input with a fake spawnRunner'],
  ['run-engine-cr38.test.mjs', "const DAG = (node = {}, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, ...config },", 1, 'validated only, never driven'],
  ['run-engine-cr38.test.mjs', "const redInput = (specs) => ({ state: { nodes: {} }, node: 'r', command: { cmd: 'x', args: [] }, format: 'tap', specs, baselineCandidate: 'sha256:base', timeoutMs: 1000 });", 1, 'gateRed function input, never spawned'],
  ['run-engine-cr38.test.mjs', "const fx = fixture(t, { config: { timeoutMs: 1000, budget: { ticket_tokens: 1000000 } }, behaviour: { a: { hang: true } } });", 1, "4505924504 hang-only: the run's one worker hangs, no proof or check runs"],
  ['run-engine-repair.test.mjs', "const fx = fixture(t, { config: { timeoutMs: 1 }, behaviour: { a: { waitFor: '/nonexistent-never' } } });", 1, "hang-only: the clamp test's one worker never finishes"],
  ['run-engine-record.test.mjs', "const dag = (config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, ...config }, nodes: [{ id: 'a', promptFile: '/p' }] });", 1, 'validated only, never driven'],
  ['run-engine-record.test.mjs', "const DAG = JSON.stringify({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }, nodes: [{ id: 'a', promptFile: '/p' }] });", 1, 'digest literal only, never driven'],
  ['run-engine-unit-review.test.mjs', "const dagOf = (nodes, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },", 1, 'validated only, never driven'],
  ['run-engine-unit-review.test.mjs', "writeFileSync(f, J({ phase: 'REPAIR', provider: 'claude', nodeId: `repair-${rx}`, workdir: fx.repo, ownership: { writes: [rx === 'urx-1' ? 'src/a.txt' : 'src/b.txt'] }, timeoutMs: 10000,", 1, 'carrier inspect input: validated, nothing is dispatched'],
  ['run-engine-units.test.mjs', "config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },", 1, 'dagOf: validated only, never driven'],
  ['run-engine-prove.test.mjs', "slow: entry(holder.root, 'slow', hang, { timeoutMs: 1500, resource: 'db', role: 'consumer', after: ['seed'] }),", 1, 'S5 per-entry deadline of the one hanging proof entry only; the run-wide bound stays 120 s'],
  ['run-engine-prove.test.mjs', "const withField = fixture(t, { commit: true, config: { testCommands: { unit: { cmd: process.execPath, args: ['-e', ''], timeoutMs: 5000 } } } });", 1, 'init is refused (dag_invalid), never driven'],
  ['run-engine.test.mjs', "const fx = fixture(t, { config: { timeoutMs: HANG_TIMEOUT_MS }, behaviour: { a: { hang: true } } });", 2, "hang-only: AC1 and AC4, the run's one worker hangs on every attempt"],
  ['run-engine.test.mjs', "const base = { schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 }, nodes: [{ id: 'a', promptFile: 'p.txt' }] };", 1, 'validated only, never driven'],
];

test('no engine test sets a short run-wide timeoutMs over work that should finish by itself (every short one is allowlisted exactly, with a reason)', () => {
  const files = readdirSync(HERE).filter(f => /\.test\.mjs$|\.test-helper\.mjs$/.test(f) && f !== 'engine-fixture-warmup.test.mjs'); // not this guard's own allowlist and controls
  assert.ok(files.length > 20, 'the scan read the engine test files');
  const hits = shortRunTimeouts(files.map(file => ({ file, text: readFileSync(join(HERE, file), 'utf8') })));
  assert.deepEqual(hits.filter(h => h.kind === 'unrestored'), [], 'a short fx.setRunTimeout must be followed by setRunTimeout(WORKER_FAILURE_BOUND_MS)');
  const d = allowlistDiff(hits.filter(h => h.kind === 'timeoutMs'), SHORT_TIMEOUT_ALLOWED);
  assert.deepEqual(d.unlisted, [], 'a short timeoutMs bounds builders, proofs and checks too: keep WORKER_FAILURE_BOUND_MS and use fx.setRunTimeout around the one hanging step, or allowlist the exact line with a reason');
  assert.deepEqual(d.miscounted, [], 'an allowlisted line occurs a different number of times: a copy is a new site that needs its own reason');
  assert.deepEqual(d.stale, [], 'allowlist entries that no longer match a short timeout');
});

test('the short-timeout scan: planted short budgets, bound names resolved per file, CRLF lines and unrestored setRunTimeout (positive control)', () => {
  const IMPORT = "import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';";
  const lines = (hits) => hits.map(h => [h.line, h.kind]);
  assert.deepEqual(lines(shortRunTimeouts([{ file: 'x.test.mjs', text: [IMPORT,
    "fixture(t, { config: { timeoutMs: 1000 } });", "fixture(t, { config: { timeoutMs: 2_000 } });", "fixture(t, { config: { timeoutMs: SHORT } });",
    "fixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS } });", "fixture(t, { config: { timeoutMs: 120000 } });"].join('\r\n') }])),
  [[2, 'timeoutMs'], [3, 'timeoutMs'], [4, 'timeoutMs']]);
  // A name is a bound only where this file resolves it: imported from the helper, or a local literal at the bound.
  assert.deepEqual(lines(shortRunTimeouts([{ file: 'y.test.mjs', text: "const BUDGET_MS = 500;\nfixture(t, { config: { timeoutMs: BUDGET_MS } });" }])), [[2, 'timeoutMs']]);
  assert.deepEqual(lines(shortRunTimeouts([{ file: 'y.test.mjs', text: "const BUDGET_MS = 120000;\nfixture(t, { config: { timeoutMs: BUDGET_MS } });" }])), []);
  assert.deepEqual(lines(shortRunTimeouts([{ file: 'z.test.mjs', text: "fixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS } });" }])), [[1, 'timeoutMs']], 'not imported: unresolved');
  // A short setRunTimeout must be restored by the next one.
  assert.deepEqual(lines(shortRunTimeouts([{ file: 'w.test.mjs', text: [IMPORT, 'fx.setRunTimeout(1000);', "fx.cli('drive');", 'fx.setRunTimeout(WORKER_FAILURE_BOUND_MS);',
    'fx.setRunTimeout(1000);', "fx.cli('drive');"].join('\n') }])), [[5, 'unrestored']]);
});

test('the allowlist matches exactly: a duplicated allowlisted line, a superstring line and a stale entry each fail (positive control)', () => {
  const row = "const fx = fixture(t, { config: { timeoutMs: 1000 } });";
  const allowed = [['a.test.mjs', row, 1, 'hang-only'], ['a.test.mjs', 'gone();', 1, 'stale']];
  const hit = (text) => ({ file: 'a.test.mjs', line: 1, text, kind: 'timeoutMs' });
  const d = allowlistDiff([hit(row), hit(row), hit(row + ' // and a builder')], allowed);
  assert.deepEqual(d.miscounted, [{ file: 'a.test.mjs', text: row, found: 2, allowed: 1 }], 'a copy of an allowlisted line');
  assert.deepEqual(d.unlisted, [{ file: 'a.test.mjs', text: row + ' // and a builder', count: 1 }], 'a line that only contains an allowlisted one');
  assert.deepEqual(d.stale, [{ file: 'a.test.mjs', text: 'gone();' }]);
  assert.deepEqual(allowlistDiff([hit(row)], [allowed[0]]), { unlisted: [], miscounted: [], stale: [] });
});
