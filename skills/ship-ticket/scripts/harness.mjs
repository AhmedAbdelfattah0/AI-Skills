#!/usr/bin/env node
/**
 * Portable, advisory execution harness. Node >= 22, no dependencies.
 * Never executes model calls, starts containers, or deletes resources.
 * PLAN is intentionally excluded from model routing and scheduling.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { cpus, freemem, totalmem, loadavg as loadavgOs } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const PHASES = Object.freeze(['UNDERSTAND', 'BUILD', 'PROVE', 'REVIEW', 'SHIP', 'REPAIR']);
const VALID_MODELS = new Set(['economy', 'balanced', 'strong', 'inherit']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HIGH_RISK = new Set(['security', 'auth', 'tenancy', 'payments', 'migration', 'schema', 'shared-contract', 'concurrency']);
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
    assert(!path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.' || !p),
      label + ' paths must be repository-relative and normalized');
    return path.replace(/\/$/, '');
  });
}

// Case-folded: on a case-insensitive filesystem Src/x and src/x are one file, so
// treat them as colliding (conservative: may serialize two distinct paths).
// Symlink aliases are not resolved here; this helper is pure and repo-unaware.
function pathCollision(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
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
  assert(PHASES.includes(input.phase), 'PLAN is protected: harness supports UNDERSTAND, BUILD, PROVE, REVIEW, SHIP, REPAIR only');
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
    assert(risk.every(x => HIGH_RISK.has(x)), 'unknown risk label (allowed: ' + [...HIGH_RISK].join(', ') + ')');
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
  const risk = node.risk ?? [];
  assert(Array.isArray(risk) && risk.every(r => HIGH_RISK.has(r)), 'unknown risk label (allowed: ' + [...HIGH_RISK].join(', ') + ')');
  if (risk.length) return 'strong';
  if (node.complexity === 'high') return 'strong';
  if (node.model) {
    assert(VALID_MODELS.has(node.model), 'invalid model tier');
    return node.model;
  }
  return node.complexity === 'low' ? 'economy' : 'inherit';
}

/**
 * Risk label -> evidence kinds `gate ship-ready` requires (plan P1-5). Additive
 * only: labels add kinds and never remove a gate. Kinds ending in `-spec` also
 * need accepted RED. `shared-contract` is a known routing label with no evidence
 * kind in the plan table yet; `ui` is an evidence-only label (not a routing one).
 */
export const RISK_EVIDENCE = Object.freeze({
  concurrency: Object.freeze(['interleaving-spec']),
  auth: Object.freeze(['authorization-spec', 'negative-spec']),
  security: Object.freeze(['authorization-spec', 'negative-spec']),
  tenancy: Object.freeze(['cross-tenant-spec']),
  payments: Object.freeze(['failure-path-spec', 'idempotency-spec']),
  migration: Object.freeze(['replay-check', 'rollback-compat-check']),
  schema: Object.freeze(['replay-check', 'rollback-compat-check']),
  ui: Object.freeze(['parity-measurements']),
  'shared-contract': Object.freeze([]),
});

/**
 * A catalog control id (skills/vapt/controls.json) and the evidence kind of one (boundary, control)
 * pair under security policy 2. Pair kinds are derived by the engine from config.controlCoverage and
 * never pass through requiredEvidence (which throws on a label outside RISK_EVIDENCE).
 */
export const CONTROL_ID = /^VAPT-(API|WEB|CFG|ABUSE)-\d{2}$/;
export const controlKind = (boundary, control) => `${boundary}:${control}-spec`;

/** Sorted unique evidence kinds for `labels`; throws TypeError for a label outside RISK_EVIDENCE. */
export function requiredEvidence(labels) {
  if (!Array.isArray(labels)) throw new TypeError('risk labels must be an array');
  const kinds = new Set();
  for (const label of labels) {
    if (!Object.hasOwn(RISK_EVIDENCE, label)) throw new TypeError(`unknown risk label: ${String(label)}`);
    for (const kind of RISK_EVIDENCE[label]) kinds.add(kind);
  }
  return [...kinds].sort();
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
  assert(prefix === null || (typeof prefix === 'string' && SAFE_ID.test(prefix) && prefix.length <= 128),
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
  assert(input.scheduleId === undefined, 'scheduleId is generated per call and cannot be supplied');
  const scheduleId = randomBytes(4).toString('hex');
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
  assert(PHASES.includes(input.phase), 'PLAN is protected: harness supports UNDERSTAND, BUILD, PROVE, REVIEW, SHIP, REPAIR only');
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

// ---------------------------------------------------------------------------------------------
// FR-2b host admission. admitHost is PURE and FAIL-SAFE: it decides from an injected snapshot and
// an injected history, performs no I/O and never terminates running work. Anything unknown,
// invalid or malformed HOLDS. hostSnapshot() is the only reader.
// Thresholds are the recorded TEMPORARY operating policy (STAB-followups-register FR-2).
// ---------------------------------------------------------------------------------------------
export const HOST_POLICY = Object.freeze({
  pressure_levels: Object.freeze([1, 2, 4]), // documented kern.memorystatus_vm_pressure_level values
  pressure_hold_level: 2,        // any sample in the window >= 2 is held_pressure, except stable pressure (STAB-410, below)
  load_num: 3,                   // any of load1/5/15 >= 60% of cores (= 3/5, compared as 5*load >= 3*cores, no float fraction) holds
  load_den: 5,
  sample_gap_min_ms: 15000,      // consecutive samples must be 15..30 s apart; closer cannot show swap is flat
  sample_gap_max_ms: 30000,      // a larger gap is stale (held_resample)
  max_snapshot_age_ms: 30000,    // snapshot.now_ms - latest.t_ms must be 0..30 s (freshness bound)
  swap_growth_tolerance_kb100: 204800, // 2 MB = 2*1024 KB = 204800 hundredths-of-KB; swap USED growth STRICTLY above this (exact integers) holds (held_swap); flat/falling is fine
  open_stale_ms: 180000,         // an 'open' history whose last counted sample is older than 3 min is a COLD START (held, two clean samples)
  max_samples: 16,
  max_cores: 4096,
  clean_samples_to_resume: 2,    // hysteresis: two clean samples with distinct, strictly increasing t_ms
  heavy_slots_healthy: 2,
  heavy_slots_default: 1,
  // STAB-410 stable pressure (owner-approved temporary policy): level 2 with swap flat, load fine and no provider errors admits
  // LIGHT, and HEAVY only while no HEAVY runs, when EVERY sample also shows swap FREE headroom of at least this floor:
  // 1 GB = 1024*1024 KB = 104857600 hundredths of KB (exact integer, inclusive). Below it, or unknown, the host holds as for unsafe.
  stable_pressure_swap_free_min_kb100: 104857600,
});
export const HOST_SNAPSHOT_SCHEMA = 'ship-ticket-host-snapshot-v2';
export const HOST_HOLD_REASONS = Object.freeze(['held_pressure', 'held_swap', 'held_load', 'held_provider', 'held_heavy', 'held_hysteresis', 'held_resample', 'snapshot_unavailable', 'invalid_args']);
const PROVIDER_KINDS = ['429', 'quota', 'timeout'];
const HISTORY_KEYS = ['state', 'clean_streak', 'last_admit_t_ms', 'last_sample_t_ms'];
const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const HELD_HISTORY = Object.freeze({ state: 'held', clean_streak: 0, last_admit_t_ms: null, last_sample_t_ms: null });

function providerCount(pe) {
  if (isInt(pe)) return pe;
  if (Array.isArray(pe) && pe.every(e => isPlain(e) && PROVIDER_KINDS.includes(e.kind) && Number.isFinite(e.t_ms))) return pe.length;
  return null;
}
// Provider stop signal from the VALID part of the field only (a quota row beside a malformed row still counts).
function partialProviders(pe) {
  if (isInt(pe)) return pe;
  return Array.isArray(pe) ? pe.filter(e => isPlain(e) && PROVIDER_KINDS.includes(e.kind) && Number.isFinite(e.t_ms)).length : 0;
}
function knownStops(samples, pe) {
  const stop = [];
  if (samples.some(x => isPlain(x) && HOST_POLICY.pressure_levels.includes(x.pressure_level) && x.pressure_level >= HOST_POLICY.pressure_hold_level)) stop.push('held_pressure');
  if (partialProviders(pe) > 0) stop.push('held_provider');
  return stop;
}
function validHistory(h) {
  // Missing history is a conservative COLD START: held, so admission needs two clean samples.
  if (h === undefined || h === null) return { ...HELD_HISTORY };
  if (!isPlain(h) || Object.keys(h).some(k => !HISTORY_KEYS.includes(k))) return null;
  // Machine-issued history: nothing is defaulted (a missing key is undefined and fails the exact checks below).
  const x = { state: h.state, clean_streak: h.clean_streak, last_admit_t_ms: h.last_admit_t_ms, last_sample_t_ms: h.last_sample_t_ms };
  if (x.state !== 'open' && x.state !== 'held') return null;
  if (!isInt(x.clean_streak) || (x.state === 'held' && x.clean_streak >= HOST_POLICY.clean_samples_to_resume)) return null;
  for (const k of ['last_admit_t_ms', 'last_sample_t_ms']) if (x[k] !== null && !isInt(x[k])) return null;
  // Consistency with how the history can have been issued: a streak or an open state exists only after a counted sample,
  // and an admit can only be at or before the last counted sample.
  if ((x.clean_streak >= 1 || x.state === 'open') && x.last_sample_t_ms === null) return null;
  if (x.state === 'open' && x.clean_streak < 1) return null;
  if (x.last_admit_t_ms !== null && (x.last_sample_t_ms === null || x.last_admit_t_ms > x.last_sample_t_ms)) return null;
  return x;
}
const SNAPSHOT_KEYS = ['schema', 'platform', 'cores', 'now_ms', 'samples', 'provider_errors'];
// swap_free_kb100 is OPTIONAL (STAB-410): older injected v2 snapshots omit it; it is read only for stable-pressure admission.
const SAMPLE_KEYS = ['t_ms', 'pressure_level', 'swap_used_kb100', 'swap_free_kb100', 'load1', 'load5', 'load15'];
// Unknown properties are rejected (stricter): an unrecognised field could be a signal this version does not understand.
const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));
function validSample(x) {
  return isPlain(x) && onlyKeys(x, SAMPLE_KEYS) && isInt(x.t_ms) && HOST_POLICY.pressure_levels.includes(x.pressure_level) && isInt(x.swap_used_kb100)
    && (!Object.hasOwn(x, 'swap_free_kb100') || isInt(x.swap_free_kb100))
    && ['load1', 'load5', 'load15'].every(k => typeof x[k] === 'number' && Number.isFinite(x[k]) && x[k] >= 0);
}

/**
 * admitHost(snapshot, cls, running, history)  -- the approved positional contract.
 *   snapshot: { platform, cores, now_ms, samples: [{t_ms, pressure_level, swap_used_kb100, load1, load5, load15}] (oldest first),
 *               provider_errors (count or [{kind,t_ms}]) }   (no process counting: unknown properties such as heavy_processes are rejected)
 *   cls: 'HEAVY'|'LIGHT'   running: {total, heavy} nonneg safe ints, heavy <= total
 *   history: undefined | {state:'open'|'held', clean_streak, last_admit_t_ms, last_sample_t_ms} as returned last time
 * Returns { admit, reason, reasons, signals, history, terminate: [] }. A wrong-shaped call HOLDS with `invalid_args`.
 * Swap signal: swap USED growth (MB) from the single-record `sysctl -n vm.swapusage`; see POLICY NOTE in the code below.
 * There is NO fallback admit: any invalid snapshot field, history or argument holds. Non-darwin holds unless a valid snapshot is injected
 * (E0/CI inject one). Missing history = cold start (held; two clean samples needed). A sample counts only if >= 15 s after
 * history.last_sample_t_ms; closer or older samples are held_resample with history unchanged.
 */
export function admitHost(snapshot, cls, running, history) {
  const result = (admit, reasons, signals, h, how = 'admitted') => ({ admit, reason: admit ? how : reasons[0], reasons, signals, history: h, terminate: [] });
  const hist = validHistory(history);
  const run = running;
  if ((cls !== 'HEAVY' && cls !== 'LIGHT') || !isPlain(run) || !isInt(run.total) || !isInt(run.heavy) || run.heavy > run.total
    || hist === null || !isPlain(snapshot)) return result(false, ['invalid_args'], { available: false }, { ...HELD_HISTORY });
  const samples = Array.isArray(snapshot.samples) ? snapshot.samples : [];
  const providers = providerCount(snapshot.provider_errors);
  const cores = snapshot.cores;
  const recovering = { ...hist, state: 'held', clean_streak: 0 };
  // Unusable timestamps are a hard hold: samples cannot be ordered or aged.
  if (samples.some(x => !isPlain(x) || !isInt(x.t_ms)) || (samples.length > 0 && !isInt(snapshot.now_ms)))
    return result(false, [...knownStops(samples.filter(isPlain), snapshot.provider_errors), 'held_resample'], { available: false, timestamps_ok: false }, recovering);
  // ONE admit path. Any invalid field holds the whole call; valid stop signals still get their specific reason first.
  const fieldsOk = onlyKeys(snapshot, SNAPSHOT_KEYS) && snapshot.schema === HOST_SNAPSHOT_SCHEMA && snapshot.platform === 'darwin' && Number.isInteger(cores) && cores >= 1 && cores <= HOST_POLICY.max_cores
    && samples.length >= 1 && samples.length <= HOST_POLICY.max_samples && samples.every(validSample) && providers !== null;
  if (!fieldsOk) {
    const stop = knownStops(samples, snapshot.provider_errors);
    return result(false, [...stop, 'snapshot_unavailable'], { platform: snapshot.platform ?? null, available: false, heavy_slots: 1 }, recovering);
  }
  const latest = samples[samples.length - 1];
  // History timestamps must not be in the future relative to the snapshot clock.
  if ((hist.last_sample_t_ms !== null && hist.last_sample_t_ms > snapshot.now_ms) || (hist.last_admit_t_ms !== null && hist.last_admit_t_ms > snapshot.now_ms))
    return result(false, ['invalid_args'], { available: false }, { ...HELD_HISTORY });
  const holds = [];
  if (samples.some(x => x.pressure_level >= HOST_POLICY.pressure_hold_level)) holds.push('held_pressure');
  let swap = 'flat';
  if (samples.length < 2) swap = 'unknown';
  else {
    // Swap USED growth (MB) above the tolerance between ANY earlier and later sample of the window. Falling or flat is fine; high
    // absolute swap alone never blocks (recorded policy). POLICY NOTE: the recorded policy says 'no swapout growth'; swap-used growth
    // is the same intent from a single-record numeric source (vm.swapusage) instead of multi-line vm_stat text.
    let min = samples[0].swap_used_kb100;
    for (const x of samples.slice(1)) { if (x.swap_used_kb100 - min > HOST_POLICY.swap_growth_tolerance_kb100) swap = 'growing'; min = Math.min(min, x.swap_used_kb100); }   // exact safe integers
  }
  if (swap !== 'flat') holds.push('held_swap');
  // Exact: load >= (3/5)*cores  <=>  5*load >= 3*cores. Kernel loadavg is fixed-point (multiples of 1/2048), so 5*load is exact.
  const loadLimit = cores * HOST_POLICY.load_num / HOST_POLICY.load_den;   // display only
  // The WHOLE window counts: an earlier high reading is not forgotten because the latest one dipped under the limit.
  const loadHigh = samples.some(x => ['load1', 'load5', 'load15'].some(k => x[k] * HOST_POLICY.load_den >= cores * HOST_POLICY.load_num));
  if (loadHigh) holds.push('held_load');
  if (providers > 0) holds.push('held_provider');
  // A sample counts only if it is >= 15 s after the last counted one; replays and near-duplicates are ONE sample.
  // But a real stop signal in such a snapshot is never hidden: it resets the clean streak (stop signals are evaluated first).
  const sinceLast = hist.last_sample_t_ms === null ? null : latest.t_ms - hist.last_sample_t_ms;
  if (sinceLast !== null && sinceLast < HOST_POLICY.sample_gap_min_ms) {
    const stops = holds.filter(h => !(h === 'held_swap' && swap === 'unknown'));
    if (stops.length > 0) return result(false, [...stops, 'held_resample'], { available: true, replay: true }, { ...hist, state: 'held', clean_streak: 0 });
    return result(false, ['held_resample'], { available: true, replay: true }, hist);
  }
  const gapsOk = samples.every((x, i) => i === 0 || (x.t_ms - samples[i - 1].t_ms >= HOST_POLICY.sample_gap_min_ms && x.t_ms - samples[i - 1].t_ms <= HOST_POLICY.sample_gap_max_ms));
  const age = snapshot.now_ms - latest.t_ms;
  const fresh = age >= 0 && age <= HOST_POLICY.max_snapshot_age_ms;
  if (!fresh || (samples.length > 1 && !gapsOk)) return result(false, [...holds.filter(h => h !== 'held_swap'), 'held_resample'], { available: true, fresh, gaps_ok: gapsOk }, recovering);
  // RECOVERY: while 'held', more than 30 s since the last counted sample means the clean samples are not consecutive: restart.
  // An 'open' history is trusted across gaps up to open_stale_ms (3 min; the snapshot is itself a fresh validated window and
  // every stop signal resets the streak); older than that it is an unobserved gap and counts as a COLD START (held, two clean
  // samples). Caller contract for a RECOVERING host: re-sample within 30 s after a held_hysteresis.
  const gap = sinceLast;
  const restart = gap !== null && ((hist.state === 'held' && gap > HOST_POLICY.sample_gap_max_ms) || (hist.state === 'open' && gap > HOST_POLICY.open_stale_ms));
  const base = restart ? { ...hist, state: 'held', clean_streak: 0 } : hist;
  const clean = holds.length === 0;
  const clean_streak = clean ? base.clean_streak + 1 : 0;
  const resumed = base.state !== 'held' || clean_streak >= HOST_POLICY.clean_samples_to_resume;
  const healthy = clean && resumed;
  const heavy_slots = healthy ? HOST_POLICY.heavy_slots_healthy : HOST_POLICY.heavy_slots_default;
  // STAB-410 stable pressure: the ONLY hold is level-2 pressure (no level 4 in the window; swap flat, load fine and no provider
  // errors, which are separate holds) and every sample shows swap FREE headroom >= the floor. It is never 'clean' (the streak and
  // hysteresis are untouched) and has one heavy slot, so HEAVY is admitted only while running.heavy == 0 (held_heavy otherwise).
  const swapFree = samples.every(x => isInt(x.swap_free_kb100)) ? (samples.every(x => x.swap_free_kb100 >= HOST_POLICY.stable_pressure_swap_free_min_kb100) ? 'ok' : 'low') : 'unknown';
  const pressureStable = holds.length === 1 && holds[0] === 'held_pressure' && samples.every(x => x.pressure_level <= HOST_POLICY.pressure_hold_level) && swapFree === 'ok';
  const reasons = pressureStable ? [] : [...holds];
  if (clean && !resumed) reasons.push('held_hysteresis');
  // HEAVY occupancy comes only from the caller's `running.heavy` (wave journal); real suites are serialized at execution time by heavy.sh.
  if (cls === 'HEAVY' && run.heavy >= heavy_slots) reasons.push('held_heavy');
  const admit = reasons.length === 0;
  return result(admit, reasons, { platform: 'darwin', available: true, pressure_level: latest.pressure_level, swap, load_high: loadHigh, load_limit: loadLimit, provider_errors: providers,
    clean, clean_streak, healthy, heavy_slots, heavy_running: run.heavy, pressure_stable: pressureStable, swap_free: swapFree },
  { state: clean && resumed ? 'open' : 'held', clean_streak, last_admit_t_ms: admit ? latest.t_ms : hist.last_admit_t_ms, last_sample_t_ms: latest.t_ms },
  pressureStable ? 'admitted_stable_pressure' : 'admitted');
}

/**
 * Kernel-output parsers: ONE whole-output anchored grammar each. No splitting, no filtering, no line selection: the regex must
 * consume the ENTIRE output string (including one optional trailing newline), so a second line, a trailing record, an embedded
 * CR/NUL or any extra byte makes it null (= snapshot_unavailable).
 * AUDIT (everything hostSnapshot/admitHost reads from outside):
 *   1. sysctl -n kern.memorystatus_vm_pressure_level  -> parsePressure, grammar /^[124]\n?$/
 *   2. sysctl -n vm.swapusage                        -> parseSwapUsedKb100, grammar below (one record)
 *   3. os.loadavg()                                  -> array of exactly 3, finite >= 0 (range-checked in admitHost)
 *   4. injected now()/cpus()/providerErrors/platform -> range/type validated in admitHost
 *   5. caller-supplied snapshot, cls, running, history -> validated in admitHost
 *   No other external text is read or parsed (vm_stat and ps are NOT used by the host path).
 */
export function parsePressure(out) {
  if (typeof out !== 'string') return null;   // the grammar itself is length-bounded (max 2 chars)
  const m = /^([124])\n?$/.exec(out);
  return m ? Number(m[1]) : null;
}
const SWAP_NUM = '(0|[1-9]\\d{0,8})\\.(\\d{2})';
const SWAP_RE = new RegExp('^total = ' + SWAP_NUM + '([KMG])  used = ' + SWAP_NUM + '([KMG])  free = ' + SWAP_NUM + '([KMG])(  \\(encrypted\\))?\\n?$');
const UNIT_KB100 = { K: 1n, M: 1024n, G: 1048576n };   // hundredths-of-KB per hundredth of the unit (1 MB = 1024 KB, 1 GB = 1024 MB)
/**
 * Accepts exactly `total = N.NNu  used = N.NNu  free = N.NNu` with optional `  (encrypted)`, u in K|M|G, up to 9 integer digits.
 * EXACT arithmetic, no float and no tolerance: each N.NN is the integer count of hundredths (BigInt), converted to a common exact
 * integer unit (hundredths of KB). Requires total === used + free EXACTLY (which implies used <= total) (live macOS output satisfies this
 * exactly; any rounding mismatch is rejected = fail-closed). Returns used in hundredths of KB as a safe integer, or null.
 */
export function parseSwapUsedKb100(out) {
  return parseSwapKb100(out)?.used ?? null;
}
/** The same one-record grammar and exact arithmetic as parseSwapUsedKb100, returning { used, free } (hundredths of KB) or null. */
export function parseSwapKb100(out) {
  if (typeof out !== 'string') return null;   // the grammar itself is length-bounded (< 120 chars)
  const m = SWAP_RE.exec(out);
  if (!m) return null;
  const v = (i, u) => (BigInt(m[i]) * 100n + BigInt(m[i + 1])) * UNIT_KB100[m[u]];
  const total = v(1, 3), used = v(4, 6), free = v(7, 9);
  // used <= total is implied by the exact sum (free >= 0), so it needs no separate (tolerance-prone) comparison.
  if (total !== used + free || total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { used: Number(used), free: Number(free) };
}
const BIN = Object.freeze({ sysctl: '/usr/sbin/sysctl' });
/**
 * The only I/O reader for admitHost. Every source is injectable. Takes `samples` readings `intervalMs`
 * apart (default 2 x 20 s, inside the accepted 15..30 s window). Strict parsing: garbled output yields
 * null fields, which admitHost treats as snapshot_unavailable.
 */
export async function hostSnapshot(probe = {}) {
  const platform = probe.platform ?? process.platform;
  const cores = (probe.cpus ?? cpus)().length;
  const now = probe.now ?? Date.now;
  const sleep = probe.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const count = probe.samples ?? 2;
  const intervalMs = probe.intervalMs ?? 20000;
  const run = probe.exec ?? ((cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }); return r.status === 0 ? r.stdout : null; });
  const loadavg = probe.loadavg ?? loadavgOs;
  const base = { schema: HOST_SNAPSHOT_SCHEMA, platform, cores, now_ms: null, samples: [], provider_errors: probe.providerErrors ?? [] };
  if (platform !== 'darwin') return base;
  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep(intervalMs);
    const la = loadavg();
    const [l1, l5, l15] = Array.isArray(la) && la.length === 3 ? la : [null, null, null];
    const t = now(), pressure = parsePressure(run(BIN.sysctl, ['-n', 'kern.memorystatus_vm_pressure_level'])), sw = parseSwapKb100(run(BIN.sysctl, ['-n', 'vm.swapusage']));
    base.samples.push({ t_ms: t, pressure_level: pressure, swap_used_kb100: sw?.used ?? null, swap_free_kb100: sw?.free ?? null, load1: l1, load5: l5, load15: l15 });
  }
  base.now_ms = now();
  return base;
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
