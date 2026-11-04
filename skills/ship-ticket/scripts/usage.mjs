#!/usr/bin/env node
/**
 * Minimal usage aggregation: no prompts, responses, auth tokens, or raw events.
 * Provider-supplied counters only; unknown is never converted into zero.
 */
import { readFileSync } from 'node:fs';
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export function summarizeUsage(events) {
  if (!Array.isArray(events) || events.length > 100000) throw new Error('usage events must be an array of <=100000');
  const byProvider = {};
  for (const e of events) {
    if (!e || !PROVIDERS.has(e.provider) || typeof e.run_id !== 'string' || !SAFE.test(e.run_id))
      throw new Error('invalid provider or run_id');
    const key = e.provider;
    const current = byProvider[key] ??= { events: 0, input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, reported_cost_usd: null };
    current.events++;
    for (const [src, dest] of [['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
      ['cache_read_tokens', 'cache_read_tokens'], ['cache_write_tokens', 'cache_write_tokens'],
      ['reported_cost_usd', 'reported_cost_usd']]) {
      if (e[src] === undefined || e[src] === null) continue;
      if (typeof e[src] !== 'number' || !Number.isFinite(e[src]) || e[src] < 0
        || (src !== 'reported_cost_usd' && !Number.isSafeInteger(e[src]))) throw new Error('invalid usage counter: ' + src);
      current[dest] = (current[dest] ?? 0) + e[src];
    }
  }
  return { schema: 'ship-ticket-harness-usage-v1', providers: byProvider,
    note: 'Only explicitly supplied provider counters are summed; null means unavailable. Cost is provider-reported, not estimated.' };
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try {
    if (process.argv[2] !== 'summary' || process.argv.length !== 4) throw new Error('Usage: usage.mjs summary <events.json>');
    process.stdout.write(JSON.stringify(summarizeUsage(JSON.parse(readFileSync(process.argv[3], 'utf8')))) + '\n');
  } catch (e) { process.stderr.write('usage: ' + e.message + '\n'); process.exitCode = 1; }
}
