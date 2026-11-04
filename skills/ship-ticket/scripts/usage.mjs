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
 * Gemini and Antigravity output was not available to verify; they are not parsed.
 */
import { readFileSync } from 'node:fs';
import { isEntrypoint } from './harness.mjs';

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const COUNTERS = Object.freeze(['input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'reasoning_tokens', 'reported_cost_usd']);

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

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

export function summarizeUsage(events) {
  if (!Array.isArray(events) || events.length > 100000) throw new Error('usage events must be an array of <=100000');
  const byProvider = {};
  for (const e of events) {
    if (!e || !PROVIDERS.has(e.provider) || typeof e.run_id !== 'string' || !SAFE.test(e.run_id))
      throw new Error('invalid provider or run_id');
    const current = byProvider[e.provider] ??= { events: 0, events_without_usage: 0,
      ...Object.fromEntries(COUNTERS.map(k => [k, null])), cost_bases: [] };
    current.events++;
    let any = false;
    for (const key of COUNTERS) {
      if (e[key] === undefined || e[key] === null) continue;
      if (typeof e[key] !== 'number' || !Number.isFinite(e[key]) || e[key] < 0
        || (key !== 'reported_cost_usd' && !Number.isSafeInteger(e[key]))) throw new Error('invalid usage counter: ' + key);
      current[key] = (current[key] ?? 0) + e[key];
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
  return { schema: 'ship-ticket-harness-usage-v2', providers: byProvider,
    note: 'Only provider-reported counters are summed; null means unavailable. reported_cost_usd is what the CLI '
      + 'reported; with cost_basis "list" under a subscription it is a list-price estimate, not a charge.' };
}

/** Accepts a JSON array or JSONL (the carrier appends one event per line). */
export function readEvents(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

if (isEntrypoint(import.meta.url)) {
  try {
    if (process.argv[2] !== 'summary' || process.argv.length !== 4) throw new Error('Usage: usage.mjs summary <events.json|events.jsonl>');
    process.stdout.write(JSON.stringify(summarizeUsage(readEvents(process.argv[3])), null, 2) + '\n');
  } catch (e) { process.stderr.write('usage: ' + e.message + '\n'); process.exitCode = 1; }
}
