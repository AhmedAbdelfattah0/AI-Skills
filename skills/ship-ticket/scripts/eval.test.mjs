import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRun, attachUsage, aggregateUsage } from './run-summary.mjs';
import { evaluateRun, suggest, evaluate } from './eval.mjs';

const script = fileURLToPath(new URL('./eval.mjs', import.meta.url));
const schema = 'ship-ticket-run-log-v1';
const iso = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const SEC = 1000;

function pair(ticket, runId, id, kind, name, start, end, metrics = {}, outcome = 'pass') {
  const base = { schema, ticket, run_id: runId, event_id: id, kind, name, metrics };
  return [{ ...base, event: 'start', timestamp: iso(start) },
    { ...base, event: 'end', timestamp: iso(end), duration_ms: end - start, outcome }];
}
/** A run with BUILD of `build` s, REVIEW of `review` s, `repairs` review_repair activities. */
function runRows(ticket, runId, { build = 100, review = 50, repairs = 0, ui = false, outcome = 'complete' } = {}) {
  const uiMetric = ui ? { ui_ticket: true } : {};
  return [
    ...pair(ticket, runId, `${runId}-wf`, 'workflow', 'ticket', 0, (build + review + 10) * SEC, uiMetric, outcome),
    ...pair(ticket, runId, `${runId}-plan`, 'phase', 'PLAN', 0, 10 * SEC),
    ...pair(ticket, runId, `${runId}-build`, 'phase', 'BUILD', 10 * SEC, (10 + build) * SEC),
    ...pair(ticket, runId, `${runId}-review`, 'phase', 'REVIEW', (10 + build) * SEC, (10 + build + review) * SEC,
      { repair_batches: repairs, confirmation_count: repairs }),
    ...Array.from({ length: repairs }, (_, i) =>
      pair(ticket, runId, `${runId}-rep-${i}`, 'activity', 'review_repair', (10 + build) * SEC + i, (10 + build) * SEC + i + 5)).flat(),
  ];
}
const rec = (runId, role, input, output, extra = {}) => ({
  provider: 'claude', run_id: runId, role, source: 'session', source_execution_id: `${runId}-${role}-${input}`,
  input_tokens: input, output_tokens: output, cache_read_tokens: null, cache_write_tokens: null,
  reasoning_tokens: null, reported_cost_usd: null, cost_basis: null, ...extra });

function fixture(t, { rows = {}, states = {}, usage = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ship-ticket-eval-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', repo], { encoding: 'utf8' }).status, 0);
  const dir = join(repo, '.git', 'ai-skills', 'ship-ticket');
  mkdirSync(dir, { recursive: true });
  for (const [ticket, list] of Object.entries(rows)) writeFileSync(join(dir, `${ticket}.jsonl`), list.map((r) => JSON.stringify(r) + '\n').join(''));
  for (const [ticket, state] of Object.entries(states)) writeFileSync(join(dir, `${ticket}.state.json`), JSON.stringify(state));
  const usagePath = join(repo, 'usage.jsonl');
  writeFileSync(usagePath, usage.map((r) => JSON.stringify(r) + '\n').join(''));
  return { repo, dir, usagePath, snapshot: () => Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), 'utf8')])) };
}
const build = (ticket, runId, opts) => buildRun(ticket, runId, runRows(ticket, runId, opts));

// ---- run-summary: usage join --------------------------------------------------

test('attachUsage joins usage by run_id: tokens by role and orchestrator share', () => {
  const run = attachUsage(build('T1', 'run-1'), [
    rec('run-1', 'orchestrator', 600, 200), rec('run-1', 'builder', 100, 100), rec('run-1', 'reviewer', 0, 0),
    rec('run-other', 'orchestrator', 9999, 9999)]);
  assert.equal(run.usage.tokens_by_role.orchestrator.processed_tokens, 800);
  assert.equal(run.usage.tokens_by_role.builder.processed_tokens, 200);
  assert.equal(run.usage.processed_tokens_total, 1000);
  assert.equal(run.usage.orchestrator_share_pct, 80);
});

test('attachUsage reports unknown, not zero, when a run has no usage records', () => {
  const run = attachUsage(build('T1', 'run-1'), [rec('run-other', 'orchestrator', 5, 5)]);
  assert.equal(run.usage.tokens_by_role, 'unknown');
  assert.equal(run.usage.orchestrator_share_pct, 'unknown');
  assert.equal(run.usage.processed_tokens_total, 'unknown');
});

test('attachUsage treats records with null counters as unknown rather than zero tokens', () => {
  const run = attachUsage(build('T1', 'run-1'), [rec('run-1', 'orchestrator', null, null), rec('run-1', 'builder', 50, 50)]);
  assert.equal(run.usage.tokens_by_role.orchestrator.processed_tokens, 'unknown');
  assert.equal(run.usage.processed_tokens_total, 100);
  assert.equal(run.usage.orchestrator_share_pct, 'unknown');
});

test('aggregateUsage partitions cost per accepted ticket by basis and never sums across bases', () => {
  const t1 = attachUsage(build('T1', 'run-1'), [rec('run-1', 'orchestrator', 1, 1, { reported_cost_usd: 2, cost_basis: 'list' }),
    rec('run-1', 'reviewer', 1, 1, { reported_cost_usd: 4, cost_basis: 'list' }), rec('run-1', 'reviewer', 1, 1, { reported_cost_usd: 1, cost_basis: 'api' })]);
  const t2 = attachUsage(build('T2', 'run-2'), [rec('run-2', 'orchestrator', 1, 1, { reported_cost_usd: 6, cost_basis: 'list' })]);
  const failed = attachUsage(build('T3', 'run-3', { outcome: 'fail' }), [rec('run-3', 'orchestrator', 1, 1, { reported_cost_usd: 100, cost_basis: 'list' })]);
  const agg = aggregateUsage([t1, t2, failed]);
  assert.equal(agg.accepted_tickets, 2);
  assert.equal(agg.cost_per_accepted_ticket_by_basis.list.per_accepted_ticket, 6); // (2+4+6)/2
  assert.equal(agg.cost_per_accepted_ticket_by_basis.api.per_accepted_ticket, 1);
  assert.deepEqual(Object.keys(agg.cost_per_accepted_ticket_by_basis).sort(), ['api', 'list']);
  assert.equal(JSON.stringify(agg).includes('"total"'), false, 'no cross-basis total exists');
});

test('aggregateUsage per-ticket cost is unknown when no accepted ticket reported cost', () => {
  const t1 = attachUsage(build('T1', 'run-1'), [rec('run-1', 'orchestrator', 1, 1)]);
  const agg = aggregateUsage([t1]);
  assert.equal(agg.accepted_tickets, 1);
  assert.deepEqual(agg.cost_per_accepted_ticket_by_basis, {});
});

// ---- eval: per-run metrics ----------------------------------------------------

const events = (...list) => list.map((type, seq) => (typeof type === 'string' ? { seq, type } : { seq, ...type }));

test('evaluateRun reports roles, phases, rounds, findings, resumes, retries and refusals', () => {
  const state = { run_id: 'run-1',
    review_chain: [
      { review_execution: 'rx-1', kind: 'original', outcome: 'FAIL', findings: [{ id: 'a', severity: 'major' }, { id: 'b', severity: 'minor' }, { id: 'c', severity: 'major' }] },
      { review_execution: 'rx-1', kind: 'repair', old_candidate: 'c1', new_candidate: 'c2', write_set: ['x'] },
      { review_execution: 'rx-1', kind: 'confirmation', outcome: 'PASS' }],
    events: events('RESUME', { type: 'RESUME', outcome: 'recorded' }, 'INFRA_RETRY', 'ADMISSION_REFUSED', 'ADMISSION_REFUSED') };
  const m = evaluateRun(attachUsage(build('T1', 'run-1', { repairs: 1 }), [rec('run-1', 'orchestrator', 30, 10), rec('run-1', 'builder', 50, 10)]), { state });
  assert.equal(m.tokens_by_role.orchestrator.processed_tokens, 40);
  assert.equal(m.orchestrator_share_pct, 40);
  assert.deepEqual(m.wall_ms_by_phase, { PLAN: 10 * SEC, BUILD: 100 * SEC, REVIEW: 50 * SEC });
  assert.equal(m.review_repairs, 1);
  assert.equal(m.confirmations, 1);
  assert.deepEqual(m.findings_by_severity, { major: 2, minor: 1 });
  assert.deepEqual(m.resumes, { attempts: 2, outcomes: { recorded: 1, unknown: 1 } });
  assert.equal(m.infra_retries, 1);
  assert.equal(m.admission_refusals, 2);
});

test('evaluateRun reports unknown for everything the sources do not carry', () => {
  const m = evaluateRun(build('T1', 'run-1'), {});
  assert.equal(m.tokens_by_role, 'unknown');
  assert.equal(m.orchestrator_share_pct, 'unknown');
  assert.equal(m.findings_by_severity, 'unknown');
  assert.equal(m.resumes, 'unknown');
  assert.equal(m.infra_retries, 'unknown');
  assert.equal(m.admission_refusals, 'unknown');
  assert.equal(m.wall_ms_by_phase.BUILD, 100 * SEC, 'run-log data is still reported');
});

test('evaluateRun ignores an engine state that belongs to another run', () => {
  const m = evaluateRun(build('T1', 'run-1'), { state: { run_id: 'run-OTHER', events: events('INFRA_RETRY') } });
  assert.equal(m.infra_retries, 'unknown');
});

test('a gate review record without severities leaves findings unknown, not empty', () => {
  const state = { run_id: 'run-1', review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', fix_findings: [] }] };
  assert.equal(evaluateRun(build('T1', 'run-1'), { state }).findings_by_severity, 'unknown');
});

// ---- eval: the three suggestion rules (both sides) -------------------------------

const rules = (metrics) => suggest(metrics).map((s) => s.rule).sort();

test('rule split-session fires only when orchestrator share is above 50%', () => {
  const at = (orch, other) => evaluateRun(attachUsage(build('T1', 'run-1'), [rec('run-1', 'orchestrator', orch, 0), rec('run-1', 'builder', other, 0)]), {});
  assert.ok(rules(at(51, 49)).includes('split_session'));
  assert.ok(!rules(at(50, 50)).includes('split_session'), 'exactly 50% does not fire');
  assert.ok(!rules(at(10, 90)).includes('split_session'));
  assert.ok(!rules(evaluateRun(build('T1', 'run-1'), {})).includes('split_session'), 'unknown share does not fire');
});

test('rule parity-probe fires only for review/build above 1.2 on a UI ticket', () => {
  const m = (opts) => evaluateRun(build('T1', 'run-1', opts), {});
  assert.ok(rules(m({ build: 100, review: 130, ui: true })).includes('parity_probe_first'));
  assert.ok(!rules(m({ build: 100, review: 120, ui: true })).includes('parity_probe_first'), 'exactly 1.2 does not fire');
  assert.ok(!rules(m({ build: 100, review: 130, ui: false })).includes('parity_probe_first'), 'not a UI ticket');
  assert.ok(!rules(m({ build: 100, review: 110, ui: true })).includes('parity_probe_first'));
});

test('rule weak-brief fires only for more than one REVIEW repair', () => {
  const m = (repairs) => evaluateRun(build('T1', 'run-1', { repairs }), {});
  assert.ok(rules(m(2)).includes('brief_too_weak'));
  assert.ok(!rules(m(1)).includes('brief_too_weak'), 'one repair is within policy');
  assert.ok(!rules(m(0)).includes('brief_too_weak'));
});

test('suggestions are text only and name their evidence', () => {
  const [s] = suggest(evaluateRun(build('T1', 'run-1', { repairs: 2 }), {}));
  assert.equal(typeof s.message, 'string');
  assert.ok(s.evidence && typeof s.evidence === 'object');
  assert.equal(rules(evaluateRun(build('T1', 'run-1'), {})).length, 0, 'no rule fires on a healthy run');
});

// ---- eval: cross-run + CLI ---------------------------------------------------------

test('evaluate joins runs, usage and per-ticket state across tickets', () => {
  const runs = [build('T1', 'run-1', { repairs: 2 }), build('T2', 'run-2')];
  const out = evaluate({ runs, states: { T1: { run_id: 'run-1', events: events('INFRA_RETRY') } },
    records: [rec('run-1', 'orchestrator', 90, 0), rec('run-1', 'builder', 10, 0)] });
  assert.equal(out.runs.length, 2);
  assert.equal(out.runs[0].orchestrator_share_pct, 90);
  assert.equal(out.runs[0].infra_retries, 1);
  assert.equal(out.runs[1].orchestrator_share_pct, 'unknown');
  assert.equal(out.cross_run.runs, 2);
});

test('CLI report --ticket prints metrics and suggestions and modifies nothing', (t) => {
  const f = fixture(t, { rows: { T1: runRows('T1', 'run-1', { repairs: 2 }) },
    states: { T1: { run_id: 'run-1', events: events('ADMISSION_REFUSED') } },
    usage: [rec('run-1', 'orchestrator', 90, 0), rec('run-1', 'builder', 10, 0)] });
  const before = f.snapshot();
  const r = spawnSync(process.execPath, [script, 'report', '--repo', f.repo, '--ticket', 'T1', '--usage', f.usagePath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.runs[0].orchestrator_share_pct, 90);
  assert.equal(out.runs[0].admission_refusals, 1);
  assert.deepEqual(out.runs[0].suggestions.map((s) => s.rule).sort(), ['brief_too_weak', 'split_session']);
  assert.deepEqual(f.snapshot(), before, 'read-only: the repo log dir is untouched');
});

test('CLI report --all covers every ticket and works without usage or state', (t) => {
  const f = fixture(t, { rows: { T1: runRows('T1', 'run-1'), T2: runRows('T2', 'run-2', { ui: true, review: 200 }) } });
  const r = spawnSync(process.execPath, [script, 'report', '--repo', f.repo, '--all'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.runs.map((x) => x.ticket).sort(), ['T1', 'T2']);
  assert.equal(out.runs[0].tokens_by_role, 'unknown');
  assert.ok(out.runs.find((x) => x.ticket === 'T2').suggestions.some((s) => s.rule === 'parity_probe_first'));
});

test('CLI refuses a missing selector, both selectors, and unknown commands', (t) => {
  const f = fixture(t);
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });
  const neither = run('report', '--repo', f.repo);
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /exactly one of --ticket or --all/);
  const both = run('report', '--repo', f.repo, '--all', '--ticket', 'T1');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /exactly one of --ticket or --all/);
  const unknown = run('nope', '--repo', f.repo, '--all');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command: nope/);
});

test('seam: CLI report --all never reads the engine event file <ticket>.engine.jsonl as a ticket', (t) => {
  const f = fixture(t, { rows: { T1: runRows('T1', 'run-1') } });
  writeFileSync(join(f.dir, 'T1.engine.jsonl'), JSON.stringify({ run_id: 'run-1', event: 'MARK', event_id: 'mark-1', node: 'a',
    transition: 'pending->cancelled', reason: 'scope', timestamp: iso(0) }) + '\n');
  const r = spawnSync(process.execPath, [script, 'report', '--repo', f.repo, '--all'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).runs.map((x) => x.ticket), ['T1']);
});

// ---- N4: retry count, gate calls, proof reruns, review usage share -------------------------

test('evaluateRun reports retry_count, gate_calls, proof_reruns and review_usage_share_pct', () => {
  const state = { run_id: 'run-1',
    authority: { trusted: [JSON.stringify({ event: 'RETRY', run_id: 'run-1' }), JSON.stringify({ event: 'START' }), JSON.stringify({ event: 'RETRY', run_id: 'run-1' })], untrusted: [] },
    events: events('GATE', 'GATE', 'GATE', 'LOCAL_PROOF', 'LOCAL_PROOF', 'LOCAL_PROOF') };
  const run = attachUsage(build('T1', 'run-1'), [rec('run-1', 'orchestrator', 60, 0), rec('run-1', 'reviewer', 20, 0), rec('run-1', 'builder', 20, 0)]);
  const m = evaluateRun(run, { state });
  assert.equal(m.retry_count, 2);
  assert.equal(m.gate_calls, 3);
  assert.equal(m.proof_reruns, 2);
  assert.equal(m.review_usage_share_pct, 20);
});

test('N4 metrics are unknown, never 0, when the sources do not carry them', () => {
  const noReviewer = attachUsage(build('T1', 'run-1'), [rec('run-1', 'orchestrator', 60, 0), rec('run-1', 'builder', 40, 0)]);
  const m = evaluateRun(noReviewer, { state: { run_id: 'run-1', authority: {}, events: events('GATE') } });
  assert.equal(m.review_usage_share_pct, 'unknown', 'missing reviewer usage row');
  assert.equal(m.retry_count, 'unknown');
  assert.equal(m.gate_calls, 1);
  assert.equal(m.proof_reruns, 0, 'no proof event in a known events array is zero reruns');
  const bare = evaluateRun(build('T1', 'run-1'), {});
  for (const key of ['review_usage_share_pct', 'retry_count', 'gate_calls', 'proof_reruns']) assert.equal(bare[key], 'unknown', key);
  const nullCounters = attachUsage(build('T1', 'run-1'), [rec('run-1', 'reviewer', null, null), rec('run-1', 'builder', 40, 0)]);
  assert.equal(evaluateRun(nullCounters, {}).review_usage_share_pct, 'unknown', 'reviewer row without counters');
});

test('retry_count counts only RETRY lines of the matched run', () => {
  const line = (run_id) => JSON.stringify({ event: 'RETRY', run_id });
  const state = { run_id: 'run-1', authority: { trusted: [line('run-1'), line('run-OTHER'), line('run-OTHER')], untrusted: [] }, events: events('GATE') };
  assert.equal(evaluateRun(build('T1', 'run-1'), { state }).retry_count, 1);
});

test('review_usage_share_pct is unknown when a reviewer record has no counters, even beside a measured one', () => {
  const rows = runRows('T1', 'run-1');
  const out = evaluate({ runs: [buildRun('T1', 'run-1', rows)], records: [rec('run-1', 'reviewer', 20, 0),
    { ...rec('run-1', 'reviewer', null, null), source_execution_id: 'run-1-reviewer-x' }, rec('run-1', 'builder', 80, 0)] });
  assert.equal(out.runs[0].review_usage_share_pct, 'unknown');
  const ok = evaluate({ runs: [buildRun('T1', 'run-1', rows)], records: [rec('run-1', 'reviewer', 20, 0), rec('run-1', 'builder', 80, 0)] });
  assert.equal(ok.runs[0].review_usage_share_pct, 20);
});

test('attachUsage carries reviewer_share_pct: unknown when any record lacks counters, 20 when all known', () => {
  const known = attachUsage(build('T1', 'run-1'), [rec('run-1', 'reviewer', 20, 0), rec('run-1', 'builder', 80, 0)]);
  assert.equal(known.usage.reviewer_share_pct, 20);
  assert.equal(evaluateRun(known, {}).review_usage_share_pct, 20, 'evaluateRun reads the field directly');
  const builderBare = attachUsage(build('T1', 'run-1'), [rec('run-1', 'reviewer', 20, 0), rec('run-1', 'builder', null, null)]);
  assert.equal(builderBare.usage.reviewer_share_pct, 'unknown');
  assert.equal(evaluateRun(builderBare, {}).review_usage_share_pct, 'unknown');
  const noReviewer = attachUsage(build('T1', 'run-1'), [rec('run-1', 'builder', 80, 0)]);
  assert.equal(noReviewer.usage.reviewer_share_pct, 'unknown');
});
