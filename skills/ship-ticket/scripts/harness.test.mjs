import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, routeModel, validateNodes, resourceSnapshot, admit, autoMemoryBudgetMb, availableMemoryBytes } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const node = (id, extras = {}) => ({ id, ...extras });
const run = (phase, nodes, maxConcurrency = 4) => schedule({ phase, nodes, maxConcurrency });

test('PLAN is protected and cannot be scheduled or routed', () => {
  assert.throws(() => run('PLAN', []), /PLAN is protected/);
  assert.throws(() => routeModel('PLAN', node('a')), /PLAN model selection/);
});
test('dispatches disjoint ready nodes in same wave', () => {
  const result = run('BUILD', [node('a', { writes: ['frontend'] }), node('b', { writes: ['backend'] }), node('c', { deps: ['a', 'b'] })]);
  assert.deepEqual(result.waves.map(w => w.nodes.map(n => n.id)), [['a', 'b'], ['c']]);
});
test('serializes write/write and write/read collisions', () => {
  const result = run('BUILD', [node('a', { writes: ['src'] }), node('b', { writes: ['src/app'] }),
    node('c', { reads: ['src/file.ts'] })]);
  assert.deepEqual(result.waves.map(w => w.nodes.map(n => n.id)), [['a'], ['b', 'c']]);
});
test('serializes exclusive runtime resources and honors width', () => {
  const result = run('PROVE', [node('a', { resources: ['db:integration'] }), node('b', { resources: ['db:integration'] }),
    node('c'), node('d')], 2);
  assert.deepEqual(result.waves.map(w => w.nodes.map(n => n.id)), [['a', 'c'], ['b', 'd']]);
});
test('rejects cycles, unknown deps and unsafe paths', () => {
  assert.throws(() => run('BUILD', [node('a', { deps: ['b'] }), node('b', { deps: ['a'] })]), /cycle/);
  assert.throws(() => run('BUILD', [node('a', { deps: ['missing'] })]), /unknown dependency/);
  assert.throws(() => run('BUILD', [node('a', { writes: ['../escape'] })]), /repository-relative/);
  assert.throws(() => run('BUILD', [node('a', { writes: ['/tmp/escape'] })]), /repository-relative/);
  assert.throws(() => run('BUILD', [node('a', { resources: ['docker'] })]), /resources must use/);
});
test('preserves strong review and security-sensitive tiers', () => {
  assert.equal(routeModel('REVIEW', node('review', { complexity: 'low', model: 'economy', risk: [] })), 'strong');
  assert.equal(routeModel('BUILD', node('auth', { complexity: 'low', risk: ['auth'], model: 'economy' })), 'strong');
  assert.equal(routeModel('BUILD', node('simple', { complexity: 'low', risk: [] })), 'economy');
  assert.equal(routeModel('BUILD', node('complex', { complexity: 'high', risk: [] })), 'strong');
  assert.equal(routeModel('BUILD', node('medium', { risk: [] })), 'inherit', 'no implicit downgrade');
  assert.equal(routeModel('PROVE', node('prove', { risk: [] })), 'inherit', 'PROVE is not silently economy');
});
test('resource probe emits numeric host snapshot without secrets', () => {
  const snap = resourceSnapshot();
  assert.ok(snap.total_memory_bytes > 0);
  assert.ok(snap.cpu_count >= 1);
  assert.equal(snap.schema, 'ship-ticket-harness-resources-v1');
  assert.equal(JSON.stringify(snap).includes('token'), false);
});
test('input is not mutated', () => {
  const input = { phase: 'BUILD', nodes: [node('a', { writes: ['src'] })] };
  validateNodes(input);
  schedule(input);
  assert.deepEqual(input, { phase: 'BUILD', nodes: [node('a', { writes: ['src'] })] });
});

test('declared memory budget limits each concurrent wave without blocking independent tasks', () => {
  const result = schedule({ phase: 'BUILD', memoryBudgetMb: 1000, maxConcurrency: 3,
    nodes: [node('a', { estimatedMemoryMb: 700 }), node('b', { estimatedMemoryMb: 600 }),
      node('c', { estimatedMemoryMb: 200 })] });
  assert.deepEqual(result.waves.map(w => w.nodes.map(n => n.id)), [['a', 'c'], ['b']]);
  assert.throws(() => schedule({ phase: 'BUILD', memoryBudgetMb: 100,
    nodes: [node('a', { estimatedMemoryMb: 200 })] }), /exceeds memory budget/);
});

const GB = 1024 * 1024 * 1024;
const probe = (free, total = 16 * GB, extra = {}) => ({ freemem: () => free, totalmem: () => total,
  availableMemory: () => NaN, constrainedMemory: () => 0, cpus: () => new Array(4).fill({}), ...extra });

test('auto budget reserves headroom and respects a cgroup limit', () => {
  assert.equal(autoMemoryBudgetMb(probe(8 * GB)), Math.floor((8 * GB - 0.15 * 16 * GB) / 1048576));
  assert.equal(autoMemoryBudgetMb(probe(512 * 1048576)), 0, 'never negative');
  assert.equal(availableMemoryBytes(probe(8 * GB, 16 * GB, { constrainedMemory: () => 2 * GB })), 2 * GB);
  const r = schedule({ phase: 'BUILD', memoryBudgetMb: 'auto', probe: probe(8 * GB), maxConcurrency: 3,
    nodes: [node('a', { estimatedMemoryMb: 3000 }), node('b', { estimatedMemoryMb: 3000 })] });
  assert.equal(r.memory_budget_source, 'auto');
  assert.equal(r.memory_safety, 'estimated');
  assert.deepEqual(r.waves.map(w => w.nodes.map(n => n.id)), [['a'], ['b']]);
});

test('memory safety is unverified unless every node carries an estimate', () => {
  const r = schedule({ phase: 'BUILD', memoryBudgetMb: 4000, nodes: [node('a', { estimatedMemoryMb: 100 }), node('b')] });
  assert.equal(r.memory_safety, 'unverified');
});

test('admission re-checks live memory and CPU at dispatch time', () => {
  assert.equal(admit({ phase: 'BUILD', estimatedMemoryMb: 1000, members: 2 }, probe(8 * GB)).admitted, true);
  const denied = admit({ phase: 'BUILD', estimatedMemoryMb: 9000, members: 8 }, probe(8 * GB));
  assert.equal(denied.admitted, false);
  assert.deepEqual(denied.reasons, ['memory', 'cpu']);
  assert.throws(() => admit({ phase: 'PLAN', estimatedMemoryMb: 1 }), /PLAN is protected/);
});

test('group prefix makes wave IDs unique across phases of one run', () => {
  const b = schedule({ phase: 'BUILD', groupPrefix: 'run-1', nodes: [node('a')] });
  const p = schedule({ phase: 'PROVE', groupPrefix: 'run-1', nodes: [node('a')] });
  assert.notEqual(b.waves[0].parallel_group, p.waves[0].parallel_group);
  assert.equal(b.group_ids_unique, true);
  assert.throws(() => schedule({ phase: 'BUILD', groupPrefix: 'bad prefix', nodes: [] }), /groupPrefix/);
});

test('CLI entrypoint actually runs (portable detection, real subprocess)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'in.json');
  writeFileSync(input, JSON.stringify({ phase: 'BUILD', groupPrefix: 'r1', nodes: [node('a')] }));
  const script = fileURLToPath(new URL('./harness.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'schedule', input], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).waves[0].parallel_group, 'r1-build-wave-1');
  const planInput = join(dir, 'plan.json');
  writeFileSync(planInput, JSON.stringify({ phase: 'PLAN', nodes: [node('a')] }));
  const plan = spawnSync(process.execPath, [script, 'schedule', planInput], { encoding: 'utf8' });
  assert.equal(plan.status, 1);
  assert.match(plan.stderr, /PLAN is protected/);
});
