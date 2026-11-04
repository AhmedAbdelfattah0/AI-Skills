#!/usr/bin/env node
/**
 * Portable, advisory execution harness. Node >=18, no dependencies.
 * Never executes model calls, starts containers, or deletes resources.
 * PLAN is intentionally excluded from model routing and scheduling.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const PHASES = Object.freeze(['UNDERSTAND', 'BUILD', 'PROVE', 'REVIEW', 'SHIP']);
const VALID_MODELS = new Set(['economy', 'balanced', 'strong', 'inherit']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HIGH_RISK = new Set(['security', 'auth', 'tenancy', 'payments', 'migration', 'schema', 'shared-contract']);
const RESOURCE_PREFIXES = ['port:', 'db:', 'cache:', 'docker:', 'fixture:', 'generator:', 'lock:'];

/** True when `moduleUrl` is the script Node was asked to run (POSIX and Windows). */
export function isEntrypoint(moduleUrl) {
  const script = process.argv[1];
  if (!script) return false;
  let resolved = script;
  try { resolved = realpathSync(script); } catch { /* fall back to the given path */ }
  return pathToFileURL(resolved).href === moduleUrl || pathToFileURL(script).href === moduleUrl;
}

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
    assert(node.estimatedMemoryMb === undefined || (Number.isSafeInteger(node.estimatedMemoryMb) && node.estimatedMemoryMb >= 0),
      'estimatedMemoryMb must be a nonnegative integer');
    return { id: node.id, deps, resources, reads: normalizedPaths(node.reads ?? [], 'reads'),
      writes: normalizedPaths(node.writes ?? [], 'writes'), risk, complexity: node.complexity ?? 'medium',
      model: node.model, estimatedMemoryMb: node.estimatedMemoryMb ?? 0 };
  });
  for (const n of nodes) {
    assert(!n.deps.includes(n.id), 'self dependency: ' + n.id);
    assert(new Set(n.deps).size === n.deps.length, 'duplicate dependency: ' + n.id);
    for (const d of n.deps) assert(ids.has(d), 'unknown dependency: ' + d);
    assert(['low', 'medium', 'high'].includes(n.complexity), 'invalid complexity: ' + n.id);
  }
  return nodes;
}

/**
 * Safe tier advice only; the host maps a tier to a real model ID. Escalation
 * (REVIEW, high risk, high complexity) always wins over a requested tier. A
 * cheaper tier is advised only when the caller explicitly asks for it or marks
 * the node low-complexity; otherwise the answer is `inherit` (the host's own
 * model), so the harness never introduces an implicit downgrade.
 */
export function routeModel(phase, node) {
  assert(PHASES.includes(phase), 'PLAN model selection is immutable and unsupported');
  if (phase === 'REVIEW') return 'strong'; // preserve independent review quality
  if ((node.risk ?? []).some(r => HIGH_RISK.has(r))) return 'strong';
  if (node.complexity === 'high') return 'strong';
  if (node.model) return node.model;
  return node.complexity === 'low' ? 'economy' : 'inherit';
}

const MB = 1024 * 1024;

/**
 * macOS reclaimable memory from vm_stat: free + inactive + speculative +
 * purgeable pages. os.freemem() counts only "free" pages, which on macOS
 * excludes the file cache and reports a fraction of what can be allocated.
 */
export function darwinAvailableBytes(vmStatText) {
  const page = Number(/page size of (\d+) bytes/.exec(vmStatText)?.[1]);
  if (!Number.isSafeInteger(page) || page <= 0) return null;
  let pages = 0;
  for (const name of ['free', 'inactive', 'speculative', 'purgeable']) {
    const m = new RegExp('Pages ' + name + ':\\s+(\\d+)\\.').exec(vmStatText);
    if (!m) return null;
    pages += Number(m[1]);
  }
  return pages * page;
}

function osFreeBytes() {
  if (process.platform === 'darwin') {
    const r = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 5000 });
    const bytes = r.status === 0 ? darwinAvailableBytes(r.stdout) : null;
    if (bytes !== null) return bytes;
  }
  return freemem();
}

/** Linux cgroup memory currently in use (v2, then v1), or null when not readable. */
function cgroupUsageBytes() {
  for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try { const v = Number(readFileSync(file, 'utf8').trim()); if (Number.isSafeInteger(v) && v >= 0) return v; } catch { /* absent */ }
  }
  return null;
}

/**
 * Memory available to this process. process.availableMemory() (Node >= 22) is
 * already cgroup-aware remaining capacity. constrainedMemory() is a LIMIT, not
 * remaining capacity, so it only counts after subtracting measured cgroup
 * usage; if usage cannot be read, the estimate is marked unverified.
 */
export function memoryEstimate(probe = {}) {
  const free = (probe.freemem ?? osFreeBytes)();
  // availableMemory()/constrainedMemory() are cgroup-aware only on Linux; elsewhere availableMemory()
  // is plain free pages (on macOS a fraction of what is allocatable), so it is not consulted.
  const linux = (probe.platform ?? process.platform) === 'linux';
  const available = probe.availableMemory ?? (linux && typeof process.availableMemory === 'function' ? () => process.availableMemory() : null);
  const constrained = probe.constrainedMemory ?? (linux && typeof process.constrainedMemory === 'function' ? () => process.constrainedMemory() : null);
  const usage = probe.cgroupUsage ?? cgroupUsageBytes;
  const candidates = [free];
  let verified = true;
  const a = available?.();
  if (Number.isFinite(a) && a > 0) candidates.push(a);
  else {
    const c = constrained?.();
    // constrainedMemory() returns 0 or a huge sentinel when unconstrained.
    if (Number.isFinite(c) && c > 0 && c < Number.MAX_SAFE_INTEGER) {
      const used = usage();
      if (used === null) verified = false;
      else candidates.push(Math.max(0, c - used));
    }
  }
  return { bytes: Math.min(...candidates), verified };
}

export function availableMemoryBytes(probe = {}) {
  return memoryEstimate(probe).bytes;
}

/**
 * Conservative automatic budget: the smaller of free/cgroup-available memory
 * minus a reserve (max of 1 GiB and 15% of total) for the host and the
 * orchestrator itself. Never negative.
 */
export function autoMemoryBudgetMb(probe = {}) {
  const total = (probe.totalmem ?? totalmem)();
  const reserve = Math.max(1024 * MB, Math.floor(total * 0.15));
  return Math.max(0, Math.floor((availableMemoryBytes(probe) - reserve) / MB));
}

function memoryVerified(probe = {}) {
  return memoryEstimate(probe).verified;
}

/**
 * Returns deterministic dispatch waves. A wave is advisory: the caller must
 * still verify carrier isolation, worker limits, runtime pressure and approvals.
 */
export function schedule(input) {
  const nodes = validateNodes(input);
  const width = input.maxConcurrency ?? Math.max(1, Math.min(3, cpus().length));
  assert(Number.isInteger(width) && width >= 1 && width <= 32, 'maxConcurrency must be 1..32');
  const prefix = input.groupPrefix ?? null;
  assert(prefix === null || (typeof prefix === 'string' && SAFE_ID.test(prefix) && prefix.length <= 96),
    'groupPrefix must be a safe run-scoped ID');
  const auto = input.memoryBudgetMb === 'auto';
  const budget = auto ? autoMemoryBudgetMb(input.probe) : (input.memoryBudgetMb ?? null);
  assert(auto || budget === null || (Number.isSafeInteger(budget) && budget > 0), 'memoryBudgetMb must be a positive integer or "auto"');
  // A caller budget is an assertion: an oversized node is an error. An auto budget is only a
  // snapshot of memory *now*; an oversized node runs alone and must pass admission at dispatch.
  if (budget !== null && !auto) for (const n of nodes) assert(n.estimatedMemoryMb <= budget, 'node exceeds memory budget: ' + n.id);
  const oversized = (n) => auto && n.estimatedMemoryMb > budget;
  const estimated = input.nodes.every(n => n.estimatedMemoryMb !== undefined);
  // Fresh per call: repeated scheduling within one phase never reuses a parallel_group.
  const scheduleId = input.scheduleId ?? randomBytes(4).toString('hex');
  assert(typeof scheduleId === 'string' && /^[A-Za-z0-9]{1,16}$/.test(scheduleId), 'scheduleId must be 1..16 alphanumerics');
  const completed = new Set();
  const pending = new Map(nodes.map(n => [n.id, n]));
  const waves = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(n => n.deps.every(d => completed.has(d)));
    assert(ready.length > 0, 'dependency cycle detected');
    const selected = [];
    for (const n of ready) {
      if (selected.length >= width) break;
      if (oversized(n)) { if (selected.length === 0) { selected.push(n); break; } continue; }
      if (selected.some(oversized)) break;
      if (selected.every(other => !conflicts(n, other))
        && (budget === null || selected.reduce((sum, item) => sum + item.estimatedMemoryMb, n.estimatedMemoryMb) <= budget)) selected.push(n);
    }
    assert(selected.length > 0, 'no schedulable nodes');
    waves.push({ parallel_group: (prefix ? prefix + '-' + input.phase.toLowerCase() + '-' + scheduleId : 'harness') + '-wave-' + (waves.length + 1),
      estimated_memory_mb: selected.reduce((sum, item) => sum + item.estimatedMemoryMb, 0),
      requires_admission: selected.some(oversized),
      nodes: selected.map(n => ({ id: n.id, model_tier: routeModel(input.phase, n) })) });
    for (const n of selected) { pending.delete(n.id); completed.add(n.id); }
  }
  return { schema: 'ship-ticket-harness-schedule-v1', phase: input.phase, advisory: true,
    max_concurrency: width, memory_budget_mb: budget, memory_budget_source: auto ? 'auto' : budget === null ? 'none' : 'caller',
    // Memory safety can be claimed only when every node carries an estimate and a budget applied.
    memory_safety: budget !== null && estimated && !nodes.some(oversized) && (!auto || memoryVerified(input.probe)) ? 'estimated' : 'unverified',
    schedule_id: scheduleId, group_ids_unique: prefix !== null, waves };
}

/**
 * Admission control immediately before dispatching one wave: re-reads live
 * memory and refuses when the wave's estimates no longer fit. Advisory, like
 * the schedule — it cannot reserve memory — but it is fresh at dispatch time.
 */
export function admit(input, probe = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'admit input must be an object');
  assert(PHASES.includes(input.phase), 'PLAN is protected: harness supports UNDERSTAND, BUILD, PROVE, REVIEW, SHIP only');
  const estimate = input.estimatedMemoryMb;
  assert(Number.isSafeInteger(estimate) && estimate >= 0, 'estimatedMemoryMb must be a nonnegative integer');
  const members = input.members ?? 1;
  assert(Number.isInteger(members) && members >= 1 && members <= 32, 'members must be 1..32');
  const cpuCount = (probe.cpus ?? cpus)().length;
  const budget = autoMemoryBudgetMb(probe);
  const reasons = [];
  if (estimate > budget) reasons.push('memory');
  if (members > cpuCount) reasons.push('cpu');
  return { schema: 'ship-ticket-harness-admission-v1', phase: input.phase, admitted: reasons.length === 0,
    reasons, memory_verified: memoryVerified(probe), estimated_memory_mb: estimate, available_budget_mb: budget, members, cpu_count: cpuCount,
    observed_at: new Date().toISOString(), advisory: true };
}

export function resourceSnapshot() {
  return { schema: 'ship-ticket-harness-resources-v1', observed_at: new Date().toISOString(),
    platform: process.platform, cpu_count: cpus().length, free_memory_bytes: freemem(), os_available_bytes: osFreeBytes(),
    available_memory_bytes: availableMemoryBytes(), total_memory_bytes: totalmem(),
    auto_memory_budget_mb: autoMemoryBudgetMb(), process_rss_bytes: process.memoryUsage().rss,
    note: 'Host-wide memory is not a container limit; verify actual capacity before dispatch.' };
}

function main(argv) {
  const command = argv[0];
  if (command === 'resources') return resourceSnapshot();
  if (command === 'schedule') {
    assert(argv.length === 2, 'Usage: harness.mjs schedule <input.json>');
    return schedule(JSON.parse(readFileSync(argv[1], 'utf8')));
  }
  if (command === 'admit') {
    assert(argv.length === 2, 'Usage: harness.mjs admit <input.json>');
    const result = admit(JSON.parse(readFileSync(argv[1], 'utf8')));
    if (!result.admitted) process.exitCode = 3;
    return result;
  }
  throw new Error('Usage: harness.mjs resources | schedule <input.json> | admit <input.json>');
}

if (isEntrypoint(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write('harness: ' + error.message + '\n'); process.exitCode = 1; }
}
