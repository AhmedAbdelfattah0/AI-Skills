#!/usr/bin/env node
/**
 * Portable, advisory execution harness. Node >=18, no dependencies.
 * Never executes model calls, starts containers, or deletes resources.
 * PLAN is intentionally excluded from model routing and scheduling.
 */
import { readFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';

export const PHASES = Object.freeze(['UNDERSTAND', 'BUILD', 'PROVE', 'REVIEW', 'SHIP']);
const VALID_MODELS = new Set(['economy', 'balanced', 'strong', 'inherit']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HIGH_RISK = new Set(['security', 'auth', 'tenancy', 'payments', 'migration', 'schema', 'shared-contract']);
const RESOURCE_PREFIXES = ['port:', 'db:', 'cache:', 'docker:', 'fixture:', 'generator:', 'lock:'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonemptyString(value, label) {
  assert(typeof value === 'string' && value.length > 0, label + ' must be a nonempty string');
  return value;
}

function normalizedPaths(paths, label) {
  assert(Array.isArray(paths), label + ' must be an array');
  return paths.map(path => {
    nonemptyString(path, label + ' path');
    assert(!path.startsWith('/') && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.' || !p),
      label + ' paths must be repository-relative and normalized');
    return path.replace(/\/$/, '');
  });
}

function pathCollision(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function conflicts(a, b) {
  if (a.resources.some(r => b.resources.includes(r))) return true;
  if (a.writes.some(p => b.writes.some(q => pathCollision(p, q)))) return true;
  if (a.writes.some(p => b.reads.some(q => pathCollision(p, q)))) return true;
  if (b.writes.some(p => a.reads.some(q => pathCollision(p, q)))) return true;
  return false;
}

export function validateNodes(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'input must be an object');
  assert(PHASES.includes(input.phase), 'PLAN is protected: harness supports UNDERSTAND, BUILD, PROVE, REVIEW, SHIP only');
  assert(Array.isArray(input.nodes) && input.nodes.length <= 100, 'nodes must be an array of at most 100');
  const ids = new Set();
  const nodes = input.nodes.map(node => {
    assert(node && typeof node === 'object' && !Array.isArray(node), 'node must be an object');
    assert(typeof node.id === 'string' && SAFE_ID.test(node.id), 'invalid node id');
    assert(!ids.has(node.id), 'duplicate node id: ' + node.id);
    ids.add(node.id);
    const deps = node.deps ?? [];
    assert(Array.isArray(deps) && deps.every(x => typeof x === 'string'), 'deps must be an array of ids');
    const resources = node.resources ?? [];
    assert(Array.isArray(resources) && resources.every(x => typeof x === 'string'
      && RESOURCE_PREFIXES.some(prefix => x.startsWith(prefix)) && !/[\r\n]/.test(x)),
      'resources must use explicit port:/db:/cache:/docker:/fixture:/generator:/lock: names');
    assert(new Set(resources).size === resources.length, 'duplicate resource');
    const risk = node.risk ?? [];
    assert(Array.isArray(risk) && risk.every(x => typeof x === 'string'), 'risk must be an array');
    if (node.model !== undefined) assert(VALID_MODELS.has(node.model), 'invalid model tier');
    return { id: node.id, deps, resources, reads: normalizedPaths(node.reads ?? [], 'reads'),
      writes: normalizedPaths(node.writes ?? [], 'writes'), risk, complexity: node.complexity ?? 'medium',
      model: node.model };
  });
  for (const n of nodes) {
    assert(!n.deps.includes(n.id), 'self dependency: ' + n.id);
    assert(new Set(n.deps).size === n.deps.length, 'duplicate dependency: ' + n.id);
    for (const d of n.deps) assert(ids.has(d), 'unknown dependency: ' + d);
    assert(['low', 'medium', 'high'].includes(n.complexity), 'invalid complexity: ' + n.id);
  }
  return nodes;
}

/** Safe tier advice only; host/carrier selects an actual available model. */
export function routeModel(phase, node) {
  assert(PHASES.includes(phase), 'PLAN model selection is immutable and unsupported');
  if (phase === 'REVIEW') return 'strong'; // preserve independent review quality
  if (node.risk.some(r => HIGH_RISK.has(r))) return 'strong';
  if (node.complexity === 'high') return 'strong';
  if (node.model) return node.model;
  if (phase === 'PROVE' || phase === 'SHIP') return 'economy';
  return node.complexity === 'low' ? 'economy' : 'balanced';
}

/**
 * Returns deterministic dispatch waves. A wave is advisory: the caller must
 * still verify carrier isolation, worker limits, runtime pressure and approvals.
 */
export function schedule(input) {
  const nodes = validateNodes(input);
  const width = input.maxConcurrency ?? 3;
  assert(Number.isInteger(width) && width >= 1 && width <= 32, 'maxConcurrency must be 1..32');
  const completed = new Set();
  const pending = new Map(nodes.map(n => [n.id, n]));
  const waves = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(n => n.deps.every(d => completed.has(d)));
    assert(ready.length > 0, 'dependency cycle detected');
    const selected = [];
    for (const n of ready) {
      if (selected.length >= width) break;
      if (selected.every(other => !conflicts(n, other))) selected.push(n);
    }
    assert(selected.length > 0, 'no schedulable nodes');
    waves.push({ parallel_group: 'harness-wave-' + (waves.length + 1),
      nodes: selected.map(n => ({ id: n.id, model_tier: routeModel(input.phase, n) })) });
    for (const n of selected) { pending.delete(n.id); completed.add(n.id); }
  }
  return { schema: 'ship-ticket-harness-schedule-v1', phase: input.phase, advisory: true,
    max_concurrency: width, waves };
}

export function resourceSnapshot() {
  return { schema: 'ship-ticket-harness-resources-v1', observed_at: new Date().toISOString(),
    platform: process.platform, cpu_count: cpus().length, free_memory_bytes: freemem(),
    total_memory_bytes: totalmem(), process_rss_bytes: process.memoryUsage().rss,
    note: 'Host-wide memory is not a container limit; verify actual capacity before dispatch.' };
}

function main(argv) {
  const command = argv[0];
  if (command === 'resources') return resourceSnapshot();
  if (command === 'schedule') {
    assert(argv.length === 2, 'Usage: harness.mjs schedule <input.json>');
    return schedule(JSON.parse(readFileSync(argv[1], 'utf8')));
  }
  throw new Error('Usage: harness.mjs resources | schedule <input.json>');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write('harness: ' + error.message + '\n'); process.exitCode = 1; }
}
