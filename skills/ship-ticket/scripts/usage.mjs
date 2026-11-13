#!/usr/bin/env node
/**
 * Provider-reported usage: extraction from real CLI output and aggregation.
 * Only numeric counters leave this module — never prompts, responses, auth
 * tokens or raw events. Unknown is never converted into zero.
 *
 * Extraction shapes (verified against the installed CLIs, 2026-11-04):
 * - Claude Code 2.1.x `-p --output-format json`: one object with `usage`
 *   {input_tokens, output_tokens, cache_read_input_tokens,
 *   cache_creation_input_tokens} and `total_cost_usd`. Under a subscription the
 *   cost is a list-price estimate (`modelUsage.*.costBasis: "list"`), not a bill.
 * - Codex CLI 0.166 `exec --json`: JSONL; each `turn.completed` carries `usage`
 *   {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
 *   reasoning_output_tokens}. Codex reports no cost.
 * - Claude also reports `duration_api_ms` and `num_turns` (read as optional `api_ms`, `num_turns`; not in
 *   a repo fixture, so parsed defensively). Codex `turn.completed` carries no time: no codex api_ms.
 * Gemini and Antigravity output was not available to verify; they are not parsed.
 */
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isEntrypoint } from './harness.mjs';

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const COUNTERS = Object.freeze(['input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'reasoning_tokens', 'reported_cost_usd']);

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
/** Optional non-counter telemetry (`api_ms`, `num_turns`): the key is present only when the provider reported a valid value. */
const optional = (key, value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { [key]: Math.round(value) } : {});

function sumInto(target, key, value) {
  if (value === null) return;
  target[key] = (target[key] ?? 0) + value;
}

/** Returns usage counters for one carrier run, or null when the output carries none. */
export function extractUsage(provider, stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  if (provider === 'claude') {
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { return null; }
    const u = parsed?.usage;
    if (!u || typeof u !== 'object') return null;
    const cost = parsed.total_cost_usd;
    const bases = Object.values(parsed.modelUsage ?? {}).map(m => m?.costBasis).filter(b => typeof b === 'string');
    return {
      input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens),
      cache_read_tokens: count(u.cache_read_input_tokens), cache_write_tokens: count(u.cache_creation_input_tokens),
      reasoning_tokens: count(u.output_tokens_details?.thinking_tokens),
      reported_cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      cost_basis: bases.length && bases.every(b => b === bases[0]) && /^[a-z_]{1,32}$/.test(bases[0]) ? bases[0] : null,
      // Non-counters, absent (reported `unknown`, never 0) unless the CLI carried them; never summed into a budget.
      ...optional('api_ms', parsed.duration_api_ms), ...(count(parsed.num_turns) === null ? {} : { num_turns: parsed.num_turns }),
    };
  }
  if (provider === 'codex') {
    const totals = { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, reasoning_tokens: null, reported_cost_usd: null, cost_basis: null };
    let turns = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== 'turn.completed' || !event.usage) continue;
      turns += 1;
      sumInto(totals, 'input_tokens', count(event.usage.input_tokens));
      sumInto(totals, 'output_tokens', count(event.usage.output_tokens));
      sumInto(totals, 'cache_read_tokens', count(event.usage.cached_input_tokens));
      sumInto(totals, 'cache_write_tokens', count(event.usage.cache_write_input_tokens));
      sumInto(totals, 'reasoning_tokens', count(event.usage.reasoning_output_tokens));
    }
    return turns ? totals : null;
  }
  return null;
}

/** Per-provider totals over carrier usage events (legacy summary; mixes cost bases — prefer {@link totalsByBasis}). */
export function summarizeUsage(events, runId = null) {
  if (!Array.isArray(events) || events.length > 100000) throw new Error('usage events must be an array of <=100000');
  if (runId !== null && (typeof runId !== 'string' || !SAFE.test(runId))) throw new Error('invalid run_id filter');
  const byProvider = {};
  for (const e of events) {
    if (!e || !PROVIDERS.has(e.provider) || typeof e.run_id !== 'string' || !SAFE.test(e.run_id))
      throw new Error('invalid provider or run_id');
    if (runId !== null && e.run_id !== runId) continue;
    const current = byProvider[e.provider] ??= { events: 0, events_without_usage: 0,
      ...Object.fromEntries(COUNTERS.map(k => [k, null])),
      counter_events: Object.fromEntries(COUNTERS.map(k => [k, 0])), cost_bases: [] };
    current.events++;
    let any = false;
    for (const key of COUNTERS) {
      if (e[key] === undefined || e[key] === null) continue;
      if (typeof e[key] !== 'number' || !Number.isFinite(e[key]) || e[key] < 0
        || (key !== 'reported_cost_usd' && !Number.isSafeInteger(e[key]))) throw new Error('invalid usage counter: ' + key);
      current[key] = (current[key] ?? 0) + e[key];
      current.counter_events[key]++;
      any = true;
    }
    if (!any) current.events_without_usage++;
    if (typeof e.cost_basis === 'string' && /^[a-z_]{1,32}$/.test(e.cost_basis) && !current.cost_bases.includes(e.cost_basis))
      current.cost_bases.push(e.cost_basis);
  }
  for (const p of Object.values(byProvider)) {
    // Share of prompt tokens served from cache: the measurable token-optimization signal.
    const prompt = [p.input_tokens, p.cache_read_tokens, p.cache_write_tokens];
    p.cache_hit_ratio = prompt.every(v => v !== null) && prompt.reduce((a, b) => a + b, 0) > 0
      ? Number((p.cache_read_tokens / prompt.reduce((a, b) => a + b, 0)).toFixed(4)) : null;
  }
  return { schema: 'ship-ticket-harness-usage-v2', run_id: runId, providers: byProvider,
    note: 'Only provider-reported counters are summed; null means unavailable. counter_events[k] is how many of '
      + '`events` reported counter k; a total over fewer events than `events` is partial. reported_cost_usd is what the CLI '
      + 'reported; with cost_basis "list" under a subscription it is a list-price estimate, not a charge.' };
}

/** Accepts a JSON array or JSONL (the carrier appends one event per line). */
export function readEvents(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const TOKEN_COUNTERS = Object.freeze(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']);
const IMPORT_ROLES = new Set(['orchestrator', 'reviewer', 'unattributed']);
/** Phases an imported record may name (`--phase`); without one its phase is unknown: ticket budget only. */
export const IMPORT_PHASES = Object.freeze(['PLAN', 'BUILD', 'PROVE', 'REVIEW', 'REPAIR', 'SHIP']);
const METRICS = Object.freeze({
  processed_tokens: ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'],
  output_tokens: ['output_tokens'],
});

/** Validates one usage record's provider, run_id and counters (throws); unknown fields are ignored. */
function checkRecord(e) {
  if (!e || !PROVIDERS.has(e.provider) || typeof e.run_id !== 'string' || !SAFE.test(e.run_id))
    throw new Error('invalid provider or run_id');
  for (const key of COUNTERS) {
    const v = e[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (key !== 'reported_cost_usd' && !Number.isSafeInteger(v)))
      throw new Error('invalid usage counter: ' + key);
  }
}

/** True when the record reports at least one token counter; false means its usage is unknown. */
const hasKnownUsage = (e) => TOKEN_COUNTERS.some(k => typeof e[k] === 'number');

/**
 * Totals partitioned by `cost_basis` ('unknown' when absent). Different bases
 * are never summed together, so no cross-basis figure exists on the result.
 * Counters stay null when no event in the basis reported them.
 */
export function totalsByBasis(records, runId = null) {
  if (!Array.isArray(records) || records.length > 100000) throw new Error('usage records must be an array of <=100000');
  if (runId !== null && (typeof runId !== 'string' || !SAFE.test(runId))) throw new Error('invalid run_id filter');
  const bases = {};
  for (const e of records) {
    checkRecord(e);
    if (runId !== null && e.run_id !== runId) continue;
    const basis = typeof e.cost_basis === 'string' && /^[a-z_]{1,32}$/.test(e.cost_basis) ? e.cost_basis : 'unknown';
    const b = bases[basis] ??= { events: 0, events_without_usage: 0, ...Object.fromEntries(COUNTERS.map(k => [k, null])) };
    b.events++;
    let any = false;
    for (const k of COUNTERS) if (typeof e[k] === 'number') { b[k] = (b[k] ?? 0) + e[k]; any = true; }
    if (!any) b.events_without_usage++;
  }
  return { schema: 'ship-ticket-usage-by-basis-v1', run_id: runId, bases,
    note: 'Partitioned by cost_basis; bases are never added together. null means no event in the basis reported the counter.' };
}

/** Throws unless `role` is a host-session role (orchestrator|reviewer|unattributed). */
function checkRole(role, label) {
  if (!IMPORT_ROLES.has(role)) throw new Error(label + ' must be orchestrator, reviewer or unattributed');
}

/** `{ phase }` for an imported record when `phase` is given (one of IMPORT_PHASES), else `{}` (phase unknown); throws otherwise. */
function phaseField(phase) {
  if (phase === undefined || phase === null) return {};
  if (!IMPORT_PHASES.includes(phase)) throw new Error('phase must be ' + IMPORT_PHASES.join('|'));
  return { phase };
}

/** Optional ISO window bound to epoch ms; null when absent, throws when unparseable. */
function parseWindow(value, label) {
  if (value === undefined || value === null) return null;
  const t = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(t)) throw new Error(label + ' must be an ISO timestamp');
  return t;
}

/**
 * Import host-session usage: the main `<dir>/<sid>.jsonl` (role `role`) and its
 * in-process subagents `<dir>/<sid>/subagents/*.jsonl` (role `subagentRole`, default `unattributed`:
 * a subagent file does not say whether it reviewed, so the role is never guessed).
 * Assistant lines inside the inclusive [since, until] window are kept; a
 * message id that repeats (streaming revisions) keeps only its last revision.
 * Returns one record per message with `source:'session'`, carrying `phase` only when given.
 */
export function importSessionUsage(sessionJsonl, { runId, role = 'orchestrator', subagentRole = 'unattributed', since, until, phase } = {}) {
  if (typeof runId !== 'string' || !SAFE.test(runId)) throw new Error('import-session needs a safe run_id');
  const tag = phaseField(phase);
  checkRole(role, 'role');
  checkRole(subagentRole, 'subagentRole');
  const from = parseWindow(since, 'since');
  const to = parseWindow(until, 'until');
  const sid = basename(sessionJsonl).replace(/\.jsonl$/, '');
  const subDir = join(dirname(sessionJsonl), sid, 'subagents');
  let subs = [];
  try { subs = readdirSync(subDir).filter(f => f.endsWith('.jsonl')).sort(); } catch { /* no subagents */ }
  const files = [[sessionJsonl, role], ...subs.map(f => [join(subDir, f), subagentRole])];
  const records = [];
  for (const [file, fileRole] of files) {
    const name = basename(file).replace(/\.jsonl$/, '');
    const last = new Map();
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!raw.trim()) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      const u = ev?.message?.usage;
      if (ev?.type !== 'assistant' || !u || typeof u !== 'object' || typeof ev.message.id !== 'string' || !ev.message.id) continue;
      const ts = Date.parse(ev.timestamp);
      if ((from !== null || to !== null) && Number.isNaN(ts)) continue;
      if ((from !== null && ts < from) || (to !== null && ts > to)) continue;
      const counters = { input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens),
        cache_read_tokens: count(u.cache_read_input_tokens), cache_write_tokens: count(u.cache_creation_input_tokens) };
      if (Object.values(counters).every(v => v === null)) continue;
      last.delete(ev.message.id); // re-insert so order follows the last revision
      last.set(ev.message.id, { provider: 'claude', run_id: runId, role: fileRole, ...tag, source: 'session',
        source_execution_id: `${name}:${ev.message.id}`, ...counters, reasoning_tokens: null, reported_cost_usd: null,
        cost_basis: null, timestamp: typeof ev.timestamp === 'string' ? ev.timestamp : null });
    }
    records.push(...last.values());
  }
  return records;
}

/**
 * Import a Codex relay result `{execution_id, usage?}`. Without reported usage
 * every counter is null and `usage_status` is 'unknown' — never an invented number. `phase` is
 * carried only when given.
 */
export function importCodexRelay(resultJson, { runId, role = 'reviewer', phase } = {}) {
  if (typeof runId !== 'string' || !SAFE.test(runId)) throw new Error('import-codex needs a safe run_id');
  const tag = phaseField(phase);
  checkRole(role, 'role');
  const r = JSON.parse(readFileSync(resultJson, 'utf8'));
  if (typeof r?.execution_id !== 'string' || !SAFE.test(r.execution_id)) throw new Error('relay result needs a safe execution_id');
  const u = r.usage && typeof r.usage === 'object' ? r.usage : null;
  const counters = {
    input_tokens: u ? count(u.input_tokens) : null, output_tokens: u ? count(u.output_tokens) : null,
    cache_read_tokens: u ? count(u.cached_input_tokens) : null, cache_write_tokens: u ? count(u.cache_write_input_tokens) : null,
    reasoning_tokens: u ? count(u.reasoning_output_tokens) : null, reported_cost_usd: null,
  };
  const known = Object.values(counters).some(v => v !== null);
  return { provider: 'codex', run_id: runId, role, ...tag, source: 'codex', source_execution_id: r.execution_id, ...counters,
    cost_basis: null, usage_status: known ? 'reported' : 'unknown' };
}

/**
 * Whether `next` is a later reading of the same execution as `prev`: same source, every token counter
 * `prev` reported is reported by `next` and not smaller, and at least one is larger or newly reported
 * (a session imported mid-stream and imported again).
 */
const grew = (prev, next) => prev?.source === next.source
  && TOKEN_COUNTERS.every(k => typeof prev[k] !== 'number' || (typeof next[k] === 'number' && next[k] >= prev[k]))
  && TOKEN_COUNTERS.some(k => typeof next[k] === 'number' && (typeof prev[k] !== 'number' || next[k] > prev[k]));

/**
 * Merge `incoming` into `existing`. A record whose `source_execution_id` is already present is
 * refused (the existing aggregate wins), unless it is a later reading of the same execution from
 * the same source with strictly larger counters (grew): then it replaces that record in place
 * (`replaced`), so a re-import never keeps the lower counters. Incoming records must carry
 * `source` and `source_execution_id`; existing legacy records without an id are kept as-is.
 */
export function addUsageRecords(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new Error('usage records must be arrays');
  const records = [...existing];
  const at = new Map(records.map((e, i) => [e?.source_execution_id, i]).filter(([id]) => typeof id === 'string'));
  const refused = [], replaced = [];
  for (const r of incoming) {
    checkRecord(r);
    if (typeof r.source !== 'string' || typeof r.source_execution_id !== 'string' || !r.source_execution_id)
      throw new Error('usage records need source and source_execution_id');
    const i = at.get(r.source_execution_id);
    if (i === undefined) { at.set(r.source_execution_id, records.length); records.push(r); continue; }
    if (grew(records[i], r)) { records[i] = r; replaced.push(r.source_execution_id); } else refused.push(r.source_execution_id);
  }
  return { records, refused, replaced };
}

/** Budget state for `used` against `limit`; null when no limit is set. A known overage stops even when some usage is unknown. */
function budgetState(used, limit, unknown) {
  if (limit === null) return null;
  if (used >= limit) return 'stop_dispatch';
  if (unknown) return 'unknown';
  return used >= 0.8 * limit ? 'warn' : 'ok';
}

/** Optional positive-integer budget limit; null when absent. */
function checkLimit(v, label) {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(label + ' must be a positive integer');
  return v;
}

/**
 * Evaluate dispatch budgets `{ticket_tokens?, phase_tokens?}` against usage
 * records. States: ok (<80%), warn (>=80%), stop_dispatch (>=100%: no new
 * dispatch), unknown (some usage unreported — flagged `budget_unenforceable`,
 * never treated as within budget). In-flight records count toward `used`;
 * `overshoot` reports how far the ticket budget was exceeded and by how much
 * in-flight work. A budget that is not set has state null; `phase` is null
 * unless both `phase_tokens` and `opts.phase` are given. Records without a `phase` count against the
 * ticket budget only and are summed in `phase_unknown` ({ records, tokens }).
 */
export function evaluateBudget(records, budget = {}, { metric = 'processed_tokens', phase } = {}) {
  if (!Object.hasOwn(METRICS, metric)) throw new Error('unsupported budget metric: ' + metric);
  if (!Array.isArray(records)) throw new Error('usage records must be an array');
  const keys = METRICS[metric];
  const tokens = (e) => keys.reduce((a, k) => a + (typeof e[k] === 'number' ? e[k] : 0), 0);
  const ticketLimit = checkLimit(budget?.ticket_tokens, 'ticket_tokens');
  const phaseLimit = checkLimit(budget?.phase_tokens, 'phase_tokens');
  let used = 0, inFlight = 0, unknown = false, phaseUsed = 0, phaseUnknown = false, noPhase = 0, noPhaseTokens = 0;
  for (const e of records) {
    checkRecord(e);
    const known = hasKnownUsage(e);
    const n = known ? tokens(e) : 0;
    if (!known) unknown = true;
    used += n;
    if (e.in_flight === true) inFlight += n;
    if (phase !== undefined && e.phase === phase) { phaseUsed += n; if (!known) phaseUnknown = true; }
    if (typeof e.phase !== 'string') { noPhase++; noPhaseTokens += n; }
  }
  const ticket = { limit: ticketLimit, used, state: budgetState(used, ticketLimit, unknown) };
  const phaseResult = phaseLimit !== null && phase !== undefined
    ? { name: phase, limit: phaseLimit, used: phaseUsed, state: budgetState(phaseUsed, phaseLimit, phaseUnknown) } : null;
  return {
    schema: 'ship-ticket-budget-v1', metric, used, ticket, phase: phaseResult,
    dispatch_allowed: ticket.state !== 'stop_dispatch' && phaseResult?.state !== 'stop_dispatch',
    flags: unknown ? ['budget_unenforceable'] : [],
    overshoot: { tokens: ticketLimit === null ? 0 : Math.max(0, used - ticketLimit), in_flight_tokens: inFlight },
    phase_unknown: { records: noPhase, tokens: noPhaseTokens },
  };
}

/** Parse `--flag value` pairs; unknown or repeated flags and missing values are errors. */
function parseFlags(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!allowed.includes(flag) || Object.hasOwn(out, flag) || value === undefined || value.startsWith('--'))
      throw new Error('bad or repeated flag: ' + flag);
    out[flag] = value;
  }
  return out;
}

/**
 * Append only non-refused records to `out` (JSONL, 0600 on creation); an all-refused import leaves
 * the file untouched. An existing JSON array, or JSONL without a final newline, is first rewritten
 * as JSONL (temp file + rename), so the appended records never join an earlier line.
 */
function importInto(out, incoming) {
  const raw = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const existing = raw.trim() ? readEvents(out) : [];
  const { records, refused, replaced } = addUsageRecords(existing, incoming);
  const added = records.slice(existing.length);
  if (!added.length && !replaced.length) return { added: 0, refused };
  const lines = (rs) => rs.map(r => JSON.stringify(r)).join('\n') + '\n';
  if (replaced.length || (raw.trim() && (raw.trimStart().startsWith('[') || !raw.endsWith('\n')))) {
    const tmp = `${out}.${process.pid}.tmp`;
    writeFileSync(tmp, lines(records), { mode: 0o600 });
    renameSync(tmp, out);
  } else appendFileSync(out, lines(added), { mode: 0o600 });
  return { added: added.length, refused, ...(replaced.length ? { replaced } : {}) };
}

const USAGE_TEXT = 'Usage: usage.mjs summary <events.json|events.jsonl> [--run-id <id>]\n'
  + '       usage.mjs import-session <session.jsonl> --run-id <id> --out <usage.jsonl> [--since iso] [--until iso] [--role orchestrator|reviewer|unattributed] [--subagent-role orchestrator|reviewer|unattributed] [--phase <PHASE>]\n'
  + '       usage.mjs import-codex <relay-result.json> --run-id <id> --out <usage.jsonl> [--role reviewer] [--phase <PHASE>]';

/** CLI entry: summary, import-session, import-codex. */
function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!file) throw new Error(USAGE_TEXT);
  if (cmd === 'summary') {
    const f = parseFlags(rest, ['--run-id']);
    return summarizeUsage(readEvents(file), f['--run-id'] ?? null);
  }
  if (cmd === 'import-session' || cmd === 'import-codex') {
    const f = parseFlags(rest, cmd === 'import-session'
      ? ['--run-id', '--out', '--since', '--until', '--role', '--subagent-role', '--phase'] : ['--run-id', '--out', '--role', '--phase']);
    if (!f['--run-id'] || !f['--out']) throw new Error(USAGE_TEXT);
    if (cmd === 'import-codex' && f['--role'] !== undefined && f['--role'] !== 'reviewer') throw new Error('import-codex role must be reviewer');
    const opts = { runId: f['--run-id'], ...(f['--role'] ? { role: f['--role'] } : {}), ...(f['--subagent-role'] ? { subagentRole: f['--subagent-role'] } : {}), ...(f['--phase'] ? { phase: f['--phase'] } : {}) };
    const incoming = cmd === 'import-session'
      ? importSessionUsage(file, { ...opts, since: f['--since'], until: f['--until'] })
      : [importCodexRelay(file, opts)];
    return importInto(f['--out'], incoming);
  }
  throw new Error(USAGE_TEXT);
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n');
  } catch (e) { process.stderr.write('usage: ' + e.message + '\n'); process.exitCode = 1; }
}
