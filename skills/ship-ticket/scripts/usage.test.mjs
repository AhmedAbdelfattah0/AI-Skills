import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as U from './usage.mjs';

const USAGE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'usage.mjs');

/*
 * RED tests for P1-4. New API in usage.mjs (the `carrier` builder implements exactly this):
 *
 * totalsByBasis(records, runId = null) -> { schema, run_id, bases: { [basis]: { events, events_without_usage,
 *     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, reported_cost_usd } } }
 *   - basis key is record.cost_basis, or 'unknown' when null/absent. NEVER a cross-basis total
 *     (no `total`/`totals` key anywhere on the result). Counters are null when no event in the basis reported them.
 *
 * importSessionUsage(sessionJsonl, { runId, role = 'orchestrator', subagentRole = 'reviewer', since, until })
 *     -> record[]   (since/until: ISO strings, inclusive window on line `timestamp`)
 *   - session file `<dir>/<sid>.jsonl`; in-process subagents `<dir>/<sid>/subagents/*.jsonl`.
 *   - lines `{type:'assistant', timestamp, message:{id, model, usage:{input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens}}}`; the same message.id may repeat (streaming
 *     revisions): keep the LAST revision only. Non-assistant lines and lines without usage are ignored.
 *   - record: { provider:'claude', run_id, role, source:'session', source_execution_id:`<file basename sans .jsonl>:<message.id>`,
 *     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_basis:null, timestamp }.
 *     Main file => `role`; subagent files => `subagentRole`.
 *
 * importCodexRelay(resultJson, { runId, role = 'reviewer' }) -> record
 *   - relay file `{execution_id, usage?:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}`.
 *   - record { provider:'codex', run_id, role, source:'codex', source_execution_id: execution_id, ...counters }.
 *   - no `usage` => counters all null and `usage_status:'unknown'`; never a number invented, never 0.
 *
 * addUsageRecords(existing, incoming) -> { records, refused: [source_execution_id] }
 *   - a record whose source_execution_id is already present (from ANY source) is refused; the existing
 *     record (the aggregate) wins. Duplicates inside `incoming` are also refused after the first.
 *
 * evaluateBudget(records, budget:{ticket_tokens?, phase_tokens?}, { metric = 'processed_tokens', phase } = {}) ->
 *   { metric, used, ticket:{limit, used, state}, phase:{limit, used, state}|null, dispatch_allowed, flags:[], overshoot }
 *   - metric 'processed_tokens' = input+output+cache_read+cache_write; 'output_tokens' = output only.
 *     (null counters count 0 inside a record that reports at least one counter.)
 *   - state: 'ok' (<80%), 'warn' (>=80% and <100%), 'stop_dispatch' (>=100%), 'unknown'.
 *   - dispatch_allowed false when any applicable state is 'stop_dispatch'.
 *   - phase budget counts only records with record.phase === opts.phase.
 *   - records with `in_flight: true` were dispatched before the stop: overshoot = { tokens: max(0, used-limit) of the
 *     ticket budget, in_flight_tokens: metric tokens of in_flight records }.
 *   - if ANY record has no known counter (usage unknown), flags includes 'budget_unenforceable' and the
 *     affected budget state is 'unknown' (never 'ok') unless it is already 'stop_dispatch'.
 *
 * CLI: usage.mjs import-session <jsonl> --run-id <id> --out <usage.jsonl> [--since iso] [--until iso] [--role orchestrator|reviewer]
 *      usage.mjs import-codex <result.json> --run-id <id> --out <usage.jsonl> [--role reviewer]
 *   - appends only non-refused records (JSONL) to --out, prints JSON {added:n, refused:[ids]}; exit 1 on bad args/role.
 */

function tmp(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'usage-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const fn = (name) => { assert.equal(typeof U[name], 'function', `usage.mjs must export ${name}()`); return U[name]; };
const rec = (o) => ({ provider: 'claude', run_id: 'run-1', ...o });
const line = (id, ts, u, type = 'assistant') => JSON.stringify({ type, timestamp: ts,
  message: { id, model: 'claude-x', usage: u } });
const U1 = (i, o, r = 0, w = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w });

function session(t) {
  const root = tmp(t);
  mkdirSync(join(root, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(join(root, 'sess-1.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-11-05T10:00:00Z', message: { content: 'hi' } }),
    line('msg_a', '2026-11-05T10:00:01Z', U1(5, 1)),
    line('msg_a', '2026-11-05T10:00:02Z', U1(5, 10, 100, 20)), // last revision wins
    line('msg_b', '2026-11-05T10:05:00Z', U1(7, 3)),
    line('msg_old', '2026-11-05T08:00:00Z', U1(999, 999)), // outside window
  ].join('\n') + '\n');
  writeFileSync(join(root, 'sess-1', 'subagents', 'agent-x.jsonl'), [
    line('msg_c', '2026-11-05T10:06:00Z', U1(2, 2, 4, 6)),
    line('msg_c', '2026-11-05T10:06:01Z', U1(2, 4, 4, 6)),
  ].join('\n') + '\n');
  return root;
}
const WINDOW = { since: '2026-11-05T09:00:00Z', until: '2026-11-05T11:00:00Z' };
const byId = (records) => Object.fromEntries(records.map(r => [r.source_execution_id, r]));

test('RED usage: totals are partitioned by cost_basis and never summed across bases', () => {
  const totalsByBasis = fn('totalsByBasis');
  const events = [
    rec({ node_id: 'a', cost_basis: 'list', input_tokens: 10, output_tokens: 1, reported_cost_usd: 0.5 }),
    rec({ node_id: 'b', cost_basis: 'list', input_tokens: 20, output_tokens: 2, reported_cost_usd: 0.25 }),
    rec({ node_id: 'c', cost_basis: 'billed', input_tokens: 100, output_tokens: 9, reported_cost_usd: 3 }),
    rec({ node_id: 'd', cost_basis: null, input_tokens: 1000, output_tokens: 90 }),
    rec({ node_id: 'e', provider: 'codex', input_tokens: null, output_tokens: null }),
  ];
  const r = totalsByBasis(events);
  assert.deepEqual(Object.keys(r.bases).sort(), ['billed', 'list', 'unknown']);
  assert.equal(r.bases.list.input_tokens, 30);
  assert.equal(r.bases.list.reported_cost_usd, 0.75);
  assert.equal(r.bases.billed.reported_cost_usd, 3);
  assert.equal(r.bases.billed.input_tokens, 100);
  assert.equal(r.bases.unknown.input_tokens, 1000);
  assert.equal(r.bases.unknown.events, 2);
  assert.equal(r.bases.unknown.events_without_usage, 1);
  assert.equal(r.bases.unknown.reported_cost_usd, null, 'no cost reported => null, not 0');
  assert.ok(!JSON.stringify(r).match(/"totals?"/), 'no cross-basis total key');
  assert.equal(totalsByBasis(events, 'other-run').bases.list, undefined, 'runId filter applies');
});

test('RED usage: import-session keeps the last revision per message id, assigns role by file, honours the window', (t) => {
  const importSessionUsage = fn('importSessionUsage');
  const root = session(t);
  const records = importSessionUsage(join(root, 'sess-1.jsonl'), { runId: 'run-1', ...WINDOW });
  const m = byId(records);
  assert.deepEqual(Object.keys(m).sort(), ['agent-x:msg_c', 'sess-1:msg_a', 'sess-1:msg_b']);
  assert.equal(m['sess-1:msg_a'].output_tokens, 10, 'last revision wins, no double count');
  assert.equal(m['sess-1:msg_a'].cache_read_tokens, 100);
  assert.equal(m['sess-1:msg_a'].cache_write_tokens, 20);
  assert.equal(m['agent-x:msg_c'].output_tokens, 4);
  assert.equal(m['sess-1:msg_a'].role, 'orchestrator');
  assert.equal(m['agent-x:msg_c'].role, 'reviewer');
  for (const r of records) {
    assert.equal(r.source, 'session');
    assert.equal(r.provider, 'claude');
    assert.equal(r.run_id, 'run-1');
    assert.equal(r.cost_basis, null);
    assert.equal(typeof r.source_execution_id, 'string');
  }
  const custom = byId(importSessionUsage(join(root, 'sess-1.jsonl'), { runId: 'run-1', role: 'reviewer', subagentRole: 'orchestrator', ...WINDOW }));
  assert.equal(custom['sess-1:msg_a'].role, 'reviewer');
  assert.equal(custom['agent-x:msg_c'].role, 'orchestrator');
  assert.equal(importSessionUsage(join(root, 'sess-1.jsonl'), { runId: 'run-1' }).length, 4, 'no window => msg_old included');
});

test('RED usage: addUsageRecords refuses an execution already present from any source; aggregate wins; totals unchanged', () => {
  const addUsageRecords = fn('addUsageRecords');
  const totalsByBasis = fn('totalsByBasis');
  const aggregate = rec({ source: 'carrier', source_execution_id: 'att-1', cost_basis: 'list', input_tokens: 50, output_tokens: 5, role: 'builder' });
  const detail = rec({ source: 'session', source_execution_id: 'att-1', cost_basis: null, input_tokens: 40, output_tokens: 4, role: 'reviewer' });
  const fresh = rec({ source: 'session', source_execution_id: 'sess:msg_z', cost_basis: null, input_tokens: 1, output_tokens: 1, role: 'orchestrator' });
  const before = totalsByBasis([aggregate]);
  const r = addUsageRecords([aggregate], [detail]);
  assert.deepEqual(r.refused, ['att-1']);
  assert.deepEqual(r.records, [aggregate]);
  assert.deepEqual(totalsByBasis(r.records), before, 'two sources, one execution: totals unchanged');
  const again = addUsageRecords(r.records, [fresh, fresh]);
  assert.equal(again.records.length, 2);
  assert.deepEqual(again.refused, ['sess:msg_z']);
});

test('RED usage: importing the same session twice via the CLI leaves the log and totals unchanged', (t) => {
  const root = session(t);
  const out = join(root, 'usage.jsonl');
  const run = () => spawnSync(process.execPath, [USAGE_CLI, 'import-session', join(root, 'sess-1.jsonl'), '--run-id', 'run-1',
    '--out', out, '--since', WINDOW.since, '--until', WINDOW.until], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).added, 3);
  const logged = readFileSync(out, 'utf8');
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).added, 0);
  assert.deepEqual(JSON.parse(second.stdout).refused.sort(), ['agent-x:msg_c', 'sess-1:msg_a', 'sess-1:msg_b']);
  assert.equal(readFileSync(out, 'utf8'), logged, 'log byte-identical after re-import');
  const totals = fn('totalsByBasis')(logged.trim().split('\n').map(JSON.parse));
  assert.equal(totals.bases.unknown.output_tokens, 10 + 3 + 4);
  const bad = spawnSync(process.execPath, [USAGE_CLI, 'import-session', join(root, 'sess-1.jsonl'), '--run-id', 'run-1', '--out', out, '--role', 'builder'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'role must be orchestrator|reviewer');
});

test('RED usage: import-codex records counters when reported and unknown (never invented) when not', (t) => {
  const importCodexRelay = fn('importCodexRelay');
  const root = tmp(t);
  writeFileSync(join(root, 'with.json'), JSON.stringify({ execution_id: 'cx-1',
    usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 } }));
  writeFileSync(join(root, 'without.json'), JSON.stringify({ execution_id: 'cx-2', final_message: 'ok' }));
  const a = importCodexRelay(join(root, 'with.json'), { runId: 'run-1' });
  assert.equal(a.provider, 'codex');
  assert.equal(a.source, 'codex');
  assert.equal(a.source_execution_id, 'cx-1');
  assert.equal(a.role, 'reviewer');
  assert.equal(a.input_tokens, 100);
  assert.equal(a.cache_read_tokens, 40);
  assert.equal(a.output_tokens, 7);
  const b = importCodexRelay(join(root, 'without.json'), { runId: 'run-1' });
  assert.equal(b.usage_status, 'unknown');
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']) assert.equal(b[k], null, k);
  assert.equal(b.source_execution_id, 'cx-2');
  const out = join(root, 'u.jsonl');
  const cli = spawnSync(process.execPath, [USAGE_CLI, 'import-codex', join(root, 'without.json'), '--run-id', 'run-1', '--out', out], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).added, 1);
  assert.equal(JSON.parse(readFileSync(out, 'utf8').trim()).usage_status, 'unknown');
});

test('RED usage: budget warns at 80%, stops dispatch at 100%, reports in-flight overshoot', () => {
  const evaluateBudget = fn('evaluateBudget');
  const r = (o) => rec({ source: 'carrier', source_execution_id: 'x' + Math.random(), ...o });
  const budget = { ticket_tokens: 1000 };
  const mk = (n, extra = {}) => [r({ input_tokens: n - 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, ...extra })];
  assert.equal(evaluateBudget(mk(790), budget).ticket.state, 'ok');
  const warn = evaluateBudget(mk(800), budget);
  assert.equal(warn.ticket.state, 'warn');
  assert.equal(warn.dispatch_allowed, true);
  assert.equal(warn.ticket.used, 800);
  assert.equal(warn.ticket.limit, 1000);
  assert.equal(evaluateBudget(mk(999), budget).ticket.state, 'warn');
  const stop = evaluateBudget(mk(1000), budget);
  assert.equal(stop.ticket.state, 'stop_dispatch');
  assert.equal(stop.dispatch_allowed, false);
  const over = evaluateBudget([...mk(900), ...mk(300, { in_flight: true })], budget);
  assert.equal(over.ticket.state, 'stop_dispatch');
  assert.equal(over.overshoot.tokens, 200);
  assert.equal(over.overshoot.in_flight_tokens, 300);
  const none = evaluateBudget(mk(1500), budget);
  assert.equal(none.overshoot.in_flight_tokens, 0);
});

test('RED usage: phase budget counts only that phase', () => {
  const evaluateBudget = fn('evaluateBudget');
  const records = [
    rec({ source: 'carrier', source_execution_id: 'p1', phase: 'BUILD', input_tokens: 850, output_tokens: 0 }),
    rec({ source: 'carrier', source_execution_id: 'p2', phase: 'REPAIR', input_tokens: 100, output_tokens: 0 }),
  ];
  const r = evaluateBudget(records, { ticket_tokens: 10000, phase_tokens: 1000 }, { phase: 'BUILD' });
  assert.equal(r.phase.used, 850);
  assert.equal(r.phase.state, 'warn');
  assert.equal(r.ticket.state, 'ok');
  assert.equal(evaluateBudget(records, { ticket_tokens: 10000, phase_tokens: 1000 }, { phase: 'REPAIR' }).phase.state, 'ok');
});

test('RED usage: unknown usage is budget_unenforceable, never within budget', () => {
  const evaluateBudget = fn('evaluateBudget');
  const records = [
    rec({ source: 'carrier', source_execution_id: 'k1', input_tokens: 10, output_tokens: 1 }),
    rec({ provider: 'codex', source: 'codex', source_execution_id: 'u1', usage_status: 'unknown', input_tokens: null, output_tokens: null }),
  ];
  const r = evaluateBudget(records, { ticket_tokens: 1000 });
  assert.ok(r.flags.includes('budget_unenforceable'));
  assert.notEqual(r.ticket.state, 'ok');
  assert.equal(r.ticket.state, 'unknown');
  const known = evaluateBudget(records.slice(0, 1), { ticket_tokens: 1000 });
  assert.ok(!known.flags.includes('budget_unenforceable'));
  assert.equal(known.ticket.state, 'ok');
  const stopped = evaluateBudget([...records, rec({ source: 'carrier', source_execution_id: 'k2', input_tokens: 2000, output_tokens: 0 })], { ticket_tokens: 1000 });
  assert.equal(stopped.ticket.state, 'stop_dispatch', 'known overage still stops');
  assert.ok(stopped.flags.includes('budget_unenforceable'));
});

test('RED usage: processed_tokens is input+output+cache_read+cache_write; configurable to output_tokens', () => {
  const evaluateBudget = fn('evaluateBudget');
  const records = [rec({ source: 'carrier', source_execution_id: 'm1', input_tokens: 100, output_tokens: 10, cache_read_tokens: 1000, cache_write_tokens: 50, reasoning_tokens: 5 })];
  const dflt = evaluateBudget(records, { ticket_tokens: 100000 });
  assert.equal(dflt.metric, 'processed_tokens');
  assert.equal(dflt.used, 1160, 'reasoning tokens are not added (already inside output)');
  const out = evaluateBudget(records, { ticket_tokens: 100 }, { metric: 'output_tokens' });
  assert.equal(out.metric, 'output_tokens');
  assert.equal(out.used, 10);
  assert.equal(out.ticket.state, 'ok');
  assert.throws(() => evaluateBudget(records, { ticket_tokens: 100 }, { metric: 'bogus' }), /metric/);
});
