import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, routeModel, validateNodes, resourceSnapshot } from './harness.mjs';

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
