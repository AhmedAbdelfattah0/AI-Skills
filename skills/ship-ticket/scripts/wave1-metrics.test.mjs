/** Specs for AIS-HARNESS-3 Wave 1 eval metrics: peak_rss_mb, parallel_efficiency, terminal_review_outcomes, retries_authorized, cost_per_accepted_ticket. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRun, attachUsage, aggregateUsage, engineResources } from './run-summary.mjs';
import { evaluateRun } from './eval.mjs';

const schema = 'ship-ticket-run-log-v1';
const iso = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const wf = (outcome) => {
  const base = { schema, ticket: 'T-1', run_id: 'r1', event_id: 'wf', kind: 'workflow', name: 'ticket', metrics: {} };
  return [{ ...base, event: 'start', timestamp: iso(0) }, { ...base, event: 'end', timestamp: iso(60000), duration_ms: 60000, outcome }];
};
const run = (outcome = 'complete') => buildRun('T-1', 'r1', wf(outcome));
const att = (id, startS, endS, env = {}) => ({ attempt_id: id, started_at: iso(startS * 1000), envelope: { ended_at: iso(endS * 1000), ...env } });

test('engineResources: peak is the max over attempts, parallel efficiency is busy / (wall x width)', () => {
  const state = { config: { width: 2 }, attempts: [att('a', 0, 10, { peak_rss_mb: 300, peak_cpu_pct: 40 }), att('b', 0, 10, { peak_rss_mb: 500.5, peak_cpu_pct: 'unknown' }),
    { attempt_id: 'g', started_at: iso(0) }] }; // no envelope: ignored
  assert.deepEqual(engineResources(state), { peak_rss_mb: 500.5, peak_cpu_pct: 40, parallel_efficiency: 1 });
  const serial = { config: { width: 2 }, attempts: [att('a', 0, 10), att('b', 10, 20)] };
  assert.equal(engineResources(serial).parallel_efficiency, 0.5);
});

test('engineResources: missing or unknown data is the string unknown, never 0', () => {
  const none = { peak_rss_mb: 'unknown', peak_cpu_pct: 'unknown', parallel_efficiency: 'unknown' };
  assert.deepEqual(engineResources(null), none);
  assert.deepEqual(engineResources({ attempts: [] }), none);
  const unk = engineResources({ config: { width: 1 }, attempts: [att('a', 0, 5, { peak_rss_mb: 'unknown' })] });
  assert.equal(unk.peak_rss_mb, 'unknown');
  assert.equal(unk.parallel_efficiency, 1);
});

test('evaluateRun: Wave 1 metrics print unknown when the run has no matching engine state', () => {
  const m = evaluateRun(run(), {});
  for (const k of ['peak_rss_mb', 'peak_cpu_pct', 'parallel_efficiency', 'terminal_review_outcomes', 'retries_authorized', 'cost_per_accepted_ticket']) assert.equal(m[k], 'unknown', k);
  const other = evaluateRun(run(), { state: { run_id: 'someone-else', attempts: [att('a', 0, 5, { peak_rss_mb: 9 })], review_chain: [] } });
  assert.equal(other.peak_rss_mb, 'unknown');
});

test('evaluateRun: review chain yields terminal outcomes and authorized retries; cost stays per basis', () => {
  const state = { run_id: 'r1', config: { width: 1 }, attempts: [att('a', 0, 5, { peak_rss_mb: 120 })],
    review_chain: [{ kind: 'original', overflow: true }, { kind: 'retry' }, { kind: 'original', overflow: false }, { kind: 'repair' }] };
  const joined = attachUsage(run(), [{ run_id: 'r1', role: 'builder', input_tokens: 1, output_tokens: 1, reported_cost_usd: 2, cost_basis: 'api_list' },
    { run_id: 'r1', role: 'reviewer', input_tokens: 1, output_tokens: 1, reported_cost_usd: 1, cost_basis: 'subscription_estimate' }]);
  const m = evaluateRun(joined, { state });
  assert.equal(m.peak_rss_mb, 120);
  assert.equal(m.terminal_review_outcomes, 1);
  assert.equal(m.retries_authorized, 1);
  assert.deepEqual(m.cost_per_accepted_ticket, { api_list: 2, subscription_estimate: 1 });
  assert.equal(evaluateRun(attachUsage(run('fail'), [{ run_id: 'r1', role: 'builder', input_tokens: 1, output_tokens: 1, reported_cost_usd: 2, cost_basis: 'api_list' }]), { state }).cost_per_accepted_ticket, 'unknown');
  assert.equal(aggregateUsage([joined]).accepted_tickets, 1);
});

test('attachUsage: one usage record with unknown counters makes the orchestrator share unknown', () => {
  const ok = { run_id: 'r1', role: 'orchestrator', input_tokens: 10, output_tokens: 0 };
  const known = attachUsage(run(), [ok, { run_id: 'r1', role: 'builder', input_tokens: 10, output_tokens: 0 }]);
  assert.equal(known.usage.orchestrator_share_pct, 50);
  const partial = attachUsage(run(), [ok, { run_id: 'r1', role: 'builder' }]);
  assert.equal(partial.usage.orchestrator_share_pct, 'unknown');
});

test('eval CLI: a malformed line in a usage JSONL file rejects the file', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'wave1-eval-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, '.git', 'ai-skills', 'ship-ticket'), { recursive: true });
  const usage = join(repo, 'u.jsonl');
  writeFileSync(usage, '{"run_id":"r1"}\n{not json\n');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./eval.mjs', import.meta.url)), 'report', '--repo', repo, '--all', '--usage', usage], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /malformed JSONL line/);
});
