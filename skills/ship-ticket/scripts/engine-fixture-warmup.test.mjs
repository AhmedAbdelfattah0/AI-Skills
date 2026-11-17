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
import { readFileSync, readdirSync, rmSync, existsSync, appendFileSync } from 'node:fs';
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

// ---- Invariant (stranded worker processes, PR #86): the fixture's teardown, not an engine-delivered pid, guarantees that
// no process a fixture test started outlives it. Each failure injection point below runs against a stub test context, so
// the test can run the fixture's real teardown itself and then assert on what is left.
import { spawn } from 'node:child_process';
import { init, drive } from './run-engine.mjs';
import { waitFor, groupGone, processGone, WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';

const REG_SKIP = !POSIX && 'POSIX process groups: Windows quiescence is unknown (known limit D4)';
const injected = () => Object.assign(new Error('injected'), { code: 'injected' });

/**
 * A fixture on a stub context: `teardown()` runs the hooks the fixture registered (its real teardown). A last-resort
 * kill on the real `t` (the asserted groups, then the tree) keeps a broken teardown from stranding processes: it then
 * fails by assertion, never by a hang.
 */
async function stubFixture(t, opts) {
  const hooks = [], watched = new Set();
  const fx = fixture({ after: (fn) => hooks.push(fn) }, opts);
  await init(fx.ctx());
  t.after(async () => {
    for (const g of watched) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
    rmSync(fx.root, { recursive: true, force: true });
  });
  return { fx, watch: (g) => { watched.add(g); return g; }, teardown: async () => { for (const h of hooks) await h(); } };
}

/** The registered group leaders (launchers), each asserted alive: a positive signal that teardown has something to reap. */
function liveLeaders(fx, watch, what) {
  const leaders = fx.processes.entries().filter(e => e.leader).map(e => watch(e.pid));
  assert.ok(leaders.length > 0, `${what}: a launcher group was registered`);
  for (const g of leaders) assert.equal(groupGone(g), false, `${what}: group ${g} is alive before teardown`);
  return leaders;
}

const allGone = (fx, leaders, what) => {
  for (const g of leaders) assert.equal(groupGone(g), true, `${what}: group ${g} is gone after teardown`);
  for (const e of fx.processes.entries()) assert.equal(processGone(e.pid), true, `${what}: registered pid ${e.pid} is gone after teardown`);
};

test('registry: a commit that throws before after-pid leaves a waiting launcher the engine never reported; teardown reaps it', { skip: REG_SKIP }, async (t) => {
  const { fx, watch, teardown } = await stubFixture(t, { behaviour: { a: { hang: true } } });
  let armed = false, seenPid = false;
  // Arm at 'after-spawn' (the launcher exists, waiting for its release byte); throw at the next state write, the commit
  // that would record its pid. 'after-pid' is then never delivered.
  const hooks = { boundary: (name) => {
    if (name === 'after-pid') seenPid = true;
    if (name === 'after-spawn') armed = true;
    else if (armed && name === 'temp-write') { armed = false; throw injected(); }
  } };
  await assert.rejects(drive(fx.ctx({ hooks })), { code: 'injected' });
  assert.equal(seenPid, false, 'after-pid was never delivered');
  // The spawn seam recorded the launcher synchronously, before the throwing commit: no race with its own preload.
  const raw = readFileSync(fx.processes.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(raw.some(e => e.via === 'spawn' && e.leader === true), 'the launcher was recorded at spawn as a group leader');
  const [g] = liveLeaders(fx, watch, 'commit throw');
  assert.equal(fx.runs('a').length, 0, 'the launcher is still waiting for its release: the provider never started');
  await teardown();
  allGone(fx, [g], 'commit throw');
});

// Spawn error: the launcher executable does not exist, so no process ever exists; the engine settles it and the
// registry records nothing (an undefined pid is tolerated).
test('registry: a spawn error registers nothing and teardown is clean', { skip: REG_SKIP }, async (t) => {
  const { fx, teardown } = await stubFixture(t);
  const r = await drive(fx.ctx({ spawn: (cmd, args, o) => spawn(join(fx.root, 'no-such-node'), args, o) }));
  assert.equal(r.nodes.a.state, 'failed', JSON.stringify(r.nodes.a));
  assert.ok(fx.readState().attempts.some(a => a.status === 'spawn_failed'), 'the spawn failed');
  assert.deepEqual(fx.processes.entries().filter(e => e.leader), [], 'no launcher was ever registered');
  await teardown();
  allGone(fx, [], 'spawn error');
});

test('registry: a spawn that throws after the launcher exists (the engine never gets its handle) is reaped', { skip: REG_SKIP }, async (t) => {
  const { fx, watch, teardown } = await stubFixture(t, { behaviour: { a: { hang: true } } });
  await assert.rejects(drive(fx.ctx({ spawn: (...a) => { spawn(...a); throw injected(); } })), { code: 'injected' });
  await waitFor(() => fx.processes.entries().some(e => e.leader), 'the orphaned launcher registered itself (preload)');
  const leaders = liveLeaders(fx, watch, 'spawn throw');
  await teardown();
  allGone(fx, leaders, 'spawn throw');
});

// The after-release wait fails WITHOUT killing anything: the worker (hanging, with a sleeper in its group) runs with no
// attempt timer, so only the registry can reap it.
test('registry: a handshake that never completes leaves a timerless worker and its sleeper; teardown reaps both', { skip: REG_SKIP }, async (t) => {
  const { fx, watch, teardown } = await stubFixture(t);
  const pidFile = join(fx.root, 'sleeper.pid');
  fx.behave({ a: { hang: true, sleeper: pidFile } });
  const hooks = { boundary: async (name) => {
    if (name !== 'after-release') return;
    await waitFor(() => existsSync(pidFile), 'the worker started its sleeper');
    throw injected();
  } };
  await assert.rejects(drive(fx.ctx({ hooks })), { code: 'injected' });
  const leaders = liveLeaders(fx, watch, 'handshake');
  const sleeper = await waitFor(() => Number(readFileSync(pidFile, 'utf8')) || false, 'the sleeper pid was written');
  assert.equal(processGone(sleeper), false, 'the sleeper is alive before teardown');
  await teardown();
  allGone(fx, leaders, 'handshake');
  assert.equal(processGone(sleeper), true, 'the sleeper is gone after teardown');
});

test('registry: a test body that throws while a drive runs its hanging worker is reaped', { skip: REG_SKIP }, async (t) => {
  // The failure bound: the engine's own attempt timer must not end the worker before teardown is what reaps it.
  const { fx, watch, teardown } = await stubFixture(t, { config: { timeoutMs: WORKER_FAILURE_BOUND_MS }, behaviour: { a: { hang: true } } });
  const running = drive(fx.ctx()).catch(() => {});
  let leaders = [];
  await assert.rejects(async () => {
    await waitFor(() => fx.runs('a').length > 0, 'the worker started');
    leaders = liveLeaders(fx, watch, 'body throw');
    throw injected();
  }, { code: 'injected' });
  await teardown();
  allGone(fx, leaders, 'body throw');
  await running; // the drive ends once its worker is gone
});

test('registry: teardown fails loudly, naming it, when a registered process survives the kill', { skip: REG_SKIP }, async (t) => {
  const { fx, watch } = await stubFixture(t);
  const child = fx.processes.spawnFn()(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  watch(child.pid);
  await assert.rejects(fx.processes.reap({ kill: () => {}, boundMs: 300 }),
    new RegExp(`registered process\\(es\\) survived SIGKILL after 300 ms: group ${child.pid}`));
  await fx.processes.reap();
  assert.equal(groupGone(child.pid), true);
});

test('registry: a registered pid now naming another process is never signalled', { skip: REG_SKIP }, async (t) => {
  const { fx } = await stubFixture(t);
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await waitFor(() => !processGone(other.pid), 'the other process runs');
  // An entry registered 60 s ago for that pid: a registered process that died, its pid since reused by `other`, which
  // started after the registration.
  appendFileSync(fx.processes.file, JSON.stringify({ pid: other.pid, leader: false, at: Date.now() - 60000 }) + '\n');
  await fx.processes.reap();
  assert.equal(processGone(other.pid), false, 'the unrelated process is still running');
  // Control (a fresh registry): the same pid registered after it started is the registered process, and is reaped.
  const { fx: fresh } = await stubFixture(t);
  appendFileSync(fresh.processes.file, JSON.stringify({ pid: other.pid, leader: false, at: Date.now() }) + '\n');
  await fresh.processes.reap();
  assert.equal(processGone(other.pid), true, 'a pid registered after its start is reaped');
});
