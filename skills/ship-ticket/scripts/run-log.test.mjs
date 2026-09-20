import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRun } from './run-summary.mjs';

const script = fileURLToPath(new URL('./run-log.mjs', import.meta.url));
const schema = 'ship-ticket-run-log-v1';
const iso = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
function pair(id, kind, name, start, end, metrics = {}, outcome = 'pass') {
  const base = { schema, ticket: 'T1', run_id: 'run-1', event_id: id, kind, name, metrics };
  return [{ ...base, event: 'start', timestamp: iso(start) },
    { ...base, event: 'end', timestamp: iso(end), duration_ms: end - start, outcome }];
}
function fixture(t, rows = []) {
  const repo = mkdtempSync(join(tmpdir(), 'ship-ticket-log-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', repo], { encoding: 'utf8' }).status, 0);
  const path = join(repo, '.git', 'ai-skills', 'ship-ticket', 'T1.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  const cli = (...args) => spawnSync(process.execPath, [script, ...args, '--repo', repo, '--ticket', 'T1'], { encoding: 'utf8' });
  const summary = () => {
    const result = cli('summary');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { repo, path, cli, summary };
}
const eventArgs = ['--run-id', 'run-1', '--kind', 'activity', '--name', 'primary_review', '--event-id', 'review-1'];

test('legacy raw v1: repeated phases summed, observed counts do not overwrite declarations', (t) => {
  const f = fixture(t, [
    ...pair('review-a', 'phase', 'REVIEW', 0, 100, { repair_batches: 1, confirmation_count: 1 }),
    ...pair('review-b', 'phase', 'REVIEW', 200, 300, { repair_batches: 0, confirmation_count: 1 }),
    ...pair('confirm', 'activity', 'review_confirmation', 210, 220),
  ]);
  const s = f.summary();
  assert.equal(s.schema, 'ship-ticket-run-summary-v2');
  assert.equal(s.event_schema, schema);
  const r = s.runs[0];
  assert.equal(r.durations.review_ms, 200);
  assert.equal(r.durations.build_ms, null);
  assert.equal(r.durations.workflow_ms, null);
  assert.deepEqual(r.counters.repair_batches, { observed: 0, declared: 1, declaration_complete: true, mismatch: true });
  assert.equal(r.counters.confirmations.declared, 2);
  assert.equal(r.counters.confirmations.observed, 1);
  assert.equal(r.review_execution_coverage, 'legacy_unknown');
});

test('missing declaration is unknown, explicit zero remains zero; primary degradations counted', () => {
  const r = buildRun('T1', 'run-1', [
    ...pair('r', 'phase', 'REVIEW', 0, 100, { repair_batches: 0 }),
    ...pair('p', 'activity', 'primary_review', 0, 10, {}, 'degraded'),
  ]);
  assert.equal(r.counters.repair_batches.declared, 0);
  assert.equal(r.counters.confirmations.declared, null);
  assert.equal(r.counters.confirmations.mismatch, null);
  assert.equal(r.counters.primary_degradations_observed, 1);
});

test('authorized executions retain separate counters and predecessor in same run', () => {
  const r = buildRun('T1', 'run-1', [
    ...pair('p1', 'phase', 'REVIEW', 0, 100, { review_execution: 'review-a', confirmation_count: 1 }),
    ...pair('c1', 'activity', 'review_confirmation', 10, 20, { review_execution: 'review-a' }, 'fail'),
    ...pair('p2', 'phase', 'REVIEW', 200, 300, { review_execution: 'review-b', previous_review_execution: 'review-a', confirmation_count: 1 }),
    ...pair('c2', 'activity', 'review_confirmation', 210, 220, { review_execution: 'review-b' }),
  ]);
  assert.equal(r.review_executions.length, 2);
  assert.equal(r.review_executions[1].metadata.previous_review_execution, 'review-a');
  assert.equal(r.review_executions[0].counters.confirmations.observed, 1);
  assert.equal(r.review_executions[1].counters.confirmations.observed, 1);
});

test('explicit waves retain sequential/single members and union every FE/BE interval', () => {
  const r = buildRun('T1', 'run-1', [
    ...pair('fe1', 'activity', 'frontend_build', 0, 100, { parallel_group: 'wave-1' }),
    ...pair('be1', 'activity', 'backend_build', 0, 20, { parallel_group: 'wave-1' }),
    ...pair('be2', 'activity', 'backend_build', 10, 40, { parallel_group: 'wave-1' }),
    ...pair('be3', 'activity', 'backend_build', 110, 120, { parallel_group: 'wave-1' }),
    ...pair('single', 'activity', 'test', 0, 10, { parallel_group: 'wave-2' }),
    ...pair('s1', 'activity', 'test', 0, 10, { parallel_group: 'wave-3' }),
    ...pair('s2', 'activity', 'test', 10, 20, { parallel_group: 'wave-3' }),
  ]);
  const [g, single, sequential] = r.parallel_groups;
  assert.equal(r.parallel_groups.length, 3);
  assert.equal(g.member_count, 4);
  assert.equal(g.peak_concurrency, 3);
  assert.equal(g.concurrent_wall_overlap_ms, 40);
  assert.equal(g.frontend_overlap_pct, 40);
  assert.equal(g.backend_overlap_pct, 80);
  assert.equal(g.frontend_backend_union_overlap_pct, 36.4);
  assert.deepEqual(single.flags, ['single_member']);
  assert.deepEqual(sequential.flags, ['no_recorded_concurrency']);
  assert.ok(!Object.hasOwn(g, 'estimated_savings_ms'));
});

test('wait subtraction unions, clips and excludes native-mode switch; unexplained gaps are uninstrumented', () => {
  const r = buildRun('T1', 'run-1', [
    ...pair('phase', 'phase', 'BUILD', 100, 200),
    ...pair('wait1', 'wait', 'scope', 80, 140),
    ...pair('wait2', 'wait', 'scope', 120, 160),
    ...pair('mode', 'wait', 'plan_mode_switch', 160, 190, { includes_native_plan_mode: true }),
    ...pair('build', 'activity', 'backend_build', 170, 180),
  ]);
  assert.equal(r.durations.build_wall_excluding_recorded_waits_ms, 40);
  assert.equal(r.phase_coverage[0].recorded_wait_overlap_ms, 60);
  assert.equal(r.phase_coverage[0].uninstrumented_ms, 30);
});

test('malformed, unsupported and truncated records produce partial summary; writer leaves bytes intact', (t) => {
  const f = fixture(t, pair('phase', 'phase', 'PLAN', 0, 100).slice(0, 1));
  const contents = readFileSync(f.path, 'utf8') + '{bad}\n' + JSON.stringify({ schema: 'future-v9' }) + '\n{"schema":';
  writeFileSync(f.path, contents);
  const s = f.summary();
  assert.equal(s.runs[0].open_state, 'unknown_due_to_integrity');
  assert.equal(s.aggregate.open_without_wait, 0);
  assert.ok(s.integrity_warnings.some((w) => w.code === 'incomplete_tail'));
  assert.ok(s.integrity_warnings.some((w) => w.code === 'unsupported_schema'));
  assert.equal(f.cli('start', ...eventArgs).status, 1);
  assert.equal(readFileSync(f.path, 'utf8'), contents);
});

test('invalid pairs and invalid records cannot crash summaries or permit unsafe writes', (t) => {
  const f = fixture(t, [null, { schema }, ...pair('orphan', 'phase', 'PLAN', 0, 10).slice(1)]);
  assert.ok(f.summary().integrity_warnings.length >= 3);
  assert.equal(f.cli('start', ...eventArgs).status, 1);
});

test('native planning is not an accidental stop; empty files produce no invented run', (t) => {
  const f = fixture(t);
  assert.equal(f.summary().runs.length, 0);
  writeFileSync(f.path, JSON.stringify(pair('native', 'activity', 'native_plan_mode', 0, 1)[0]) + '\n');
  assert.equal(f.summary().runs[0].open_state, 'planning_or_approval');
});

for (const tool of ['claude', 'codex']) test(`${tool} result timing is bound, whitelisted, separate, and idempotent`, (t) => {
  const f = fixture(t);
  const resultPath = join(f.repo, 'result.json');
  const start = f.cli('start', ...eventArgs, '--carrier-result', resultPath,
    '--metric', 'candidate_id=sha-123', '--metric', 'review_execution=review-abc', '--metric', 'parallel_group=wave-1');
  assert.equal(start.status, 0, start.stderr);
  const timestamp = JSON.parse(start.stdout).timestamp;
  writeFileSync(resultPath, JSON.stringify({ schema: 'delegate-relay.result.v1',
    ...(tool === 'claude' ? { tool, readOnly: true } : { codexVersion: 'test', sandbox: 'read-only' }),
    workdir: f.repo, status: 'timeout', startedAt: timestamp, finishedAt: timestamp,
    finalMessage: 'SECRET-REVIEW-TEXT', stderrTail: 'SECRET-TOKEN' }));
  const ended = f.cli('end', ...eventArgs, '--carrier-result', resultPath, '--outcome', 'degraded');
  assert.equal(ended.status, 0, ended.stderr);
  const row = JSON.parse(ended.stdout);
  assert.equal(row.carrier_timing.duration_ms, 0);
  assert.ok(row.carrier_timing.collection_delay_ms > 0);
  assert.ok(row.duration_ms > 0);
  const bytes = readFileSync(f.path, 'utf8');
  assert.ok(!bytes.includes('SECRET'));
  assert.equal(f.cli('end', ...eventArgs, '--carrier-result', resultPath).status, 0);
  assert.equal(readFileSync(f.path, 'utf8'), bytes);
  assert.equal(f.summary().runs[0].parallel_groups[0].timing_basis, 'carrier');
});

test('carrier stale path, wrong root, identity mutation, and unbound import are rejected', (t) => {
  const f = fixture(t);
  const resultPath = join(f.repo, 'result.json');
  writeFileSync(resultPath, '{}');
  assert.equal(f.cli('start', ...eventArgs, '--carrier-result', resultPath, '--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-1').status, 1);
  rmSync(resultPath);
  assert.equal(f.cli('start', ...eventArgs, '--carrier-result', resultPath, '--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-1').status, 0);
  writeFileSync(resultPath, JSON.stringify({ schema: 'delegate-relay.result.v1', tool: 'claude', readOnly: true, status: 'completed', workdir: '/wrong' }));
  assert.equal(f.cli('end', ...eventArgs, '--carrier-result', resultPath).status, 1);
  assert.equal(f.cli('end', ...eventArgs, '--carrier-result', join(f.repo, 'other.json')).status, 1);
  assert.equal(f.cli('end', ...eventArgs, '--metric', 'candidate_id=sha-2').status, 1);
  // Best-effort fallback closes the logger without fabricating carrier timing.
  assert.equal(f.cli('end', ...eventArgs, '--outcome', 'degraded').status, 0);
  assert.equal(f.summary().runs[0].intervals[0].carrier_timing, undefined);
});

test('delayed batch collection does not manufacture carrier concurrency', () => {
  const metrics = { parallel_group: 'wave-1', candidate_id: 'sha-1', review_execution: 'review-1' };
  const timing = { source: 'relay_result', status: 'completed', result_sha256: 'a'.repeat(64),
    candidate_id: 'sha-1', review_execution: 'review-1' };
  const rows = [
    ...pair('fe', 'activity', 'frontend_build', 0, 100, metrics),
    ...pair('be', 'activity', 'backend_build', 0, 100, metrics),
  ];
  rows[1].carrier_timing = { ...timing, started_at: iso(0), ended_at: iso(20), duration_ms: 20, collection_delay_ms: 80, tool: 'claude' };
  rows[3].carrier_timing = { ...timing, started_at: iso(20), ended_at: iso(30), duration_ms: 10, collection_delay_ms: 70, tool: 'codex' };
  const r = buildRun('T1', 'run-1', rows);
  assert.equal(r.parallel_groups[0].concurrent_wall_overlap_ms, 0);
  assert.equal(r.parallel_groups[0].wall_ms, 30);
  assert.equal(r.parallel_groups[0].timing_basis, 'carrier');
  assert.equal(r.durations.activity_ms, 200);
});

test('duplicate starts and complete-but-unterminated tail are preserved and flagged', (t) => {
  const start = pair('phase', 'phase', 'REVIEW', 0, 10)[0];
  const f = fixture(t, [start, start]);
  assert.ok(f.summary().integrity_warnings.some((w) => w.code === 'duplicate_start'));
  assert.equal(f.cli('start', ...eventArgs).status, 1);
  writeFileSync(f.path, JSON.stringify(start));
  assert.equal(f.summary().runs[0].open_state, 'unknown_due_to_integrity');
  assert.equal(f.cli('end', '--run-id', 'run-1', '--kind', 'phase', '--name', 'REVIEW', '--event-id', 'phase').status, 1);
});

test('numeric execution IDs and mismatched ticket histories are refused', (t) => {
  const f = fixture(t);
  assert.equal(f.cli('start', ...eventArgs, '--metric', 'review_execution=123').status, 1);
  const row = { ...pair('phase', 'phase', 'REVIEW', 0, 10)[0], ticket: 'OTHER' };
  writeFileSync(f.path, JSON.stringify(row) + '\n');
  assert.ok(f.summary().integrity_warnings.some((w) => w.code === 'ticket_mismatch'));
  assert.equal(f.cli('start', ...eventArgs).status, 1);
});

test('import refuses times outside the dispatch and collection interval', (t) => {
  const f = fixture(t);
  const resultPath = join(f.repo, 'result.json');
  const started = f.cli('start', ...eventArgs, '--carrier-result', resultPath,
    '--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-1');
  assert.equal(started.status, 0, started.stderr);
  const startTime = JSON.parse(started.stdout).timestamp;
  const base = { schema: 'delegate-relay.result.v1', tool: 'claude', readOnly: true, workdir: f.repo, status: 'completed' };
  for (const times of [
    { startedAt: iso(0), finishedAt: startTime },
    { startedAt: startTime, finishedAt: iso(0) },
    { startedAt: startTime, finishedAt: new Date(Date.now() + 60000).toISOString() },
    { startedAt: 'invalid', finishedAt: startTime },
  ]) {
    writeFileSync(resultPath, JSON.stringify({ ...base, ...times }));
    assert.equal(f.cli('end', ...eventArgs, '--carrier-result', resultPath).status, 1);
  }
  assert.equal(f.summary().runs[0].open_intervals.length, 1);
});

test('pairing warnings affect only their run; file corruption still affects every run', (t) => {
  const good = pair('workflow', 'workflow', 'ship_ticket', 0, 100, {}, 'complete');
  const bad = pair('orphan', 'phase', 'REVIEW', 0, 10).slice(1).map((r) => ({ ...r, run_id: 'run-2' }));
  const f = fixture(t, [...good, ...bad]);
  const s = f.summary();
  assert.equal(s.aggregate.integrity_affected_runs, 1);
  assert.equal(s.runs[0].open_state, 'closed');
  assert.deepEqual(s.runs[0].integrity_warnings, []);
  assert.equal(s.runs[1].open_state, 'unknown_due_to_integrity');
  assert.equal(s.runs[1].integrity_warnings.length, 1);
  assert.equal(s.integrity_warnings[0].run_id, 'run-2');
  writeFileSync(f.path, readFileSync(f.path, 'utf8') + '{broken}\n');
  assert.equal(f.summary().aggregate.integrity_affected_runs, 2);
});

test('incomplete or invalid carrier timing is rejected, absent legacy timing remains valid', (t) => {
  const metrics = { candidate_id: 'sha-1', review_execution: 'review-1', parallel_group: 'wave-1' };
  const rows = pair('review', 'activity', 'primary_review', 0, 100, metrics);
  const valid = { source: 'relay_result', tool: 'claude', status: 'completed',
    result_sha256: 'a'.repeat(64), candidate_id: 'sha-1', review_execution: 'review-1',
    started_at: iso(10), ended_at: iso(50), duration_ms: 40, collection_delay_ms: 50 };
  const f = fixture(t);
  const writeTiming = (timing) => writeFileSync(f.path,
    [rows[0], { ...rows[1], carrier_timing: timing }].map((r) => JSON.stringify(r) + '\n').join(''));
  writeTiming(valid);
  assert.equal(f.summary().runs[0].parallel_groups[0].timing_basis, 'carrier');
  const invalid = [null, false, {}, { ...valid, status: 'pending' },
    { ...valid, result_sha256: 'A'.repeat(64) }, { ...valid, candidate_id: 'bad/path' },
    { ...valid, review_execution: '123' }];
  for (const key of ['status', 'result_sha256', 'candidate_id', 'review_execution']) {
    const missing = { ...valid };
    delete missing[key];
    invalid.push(missing);
  }
  for (const timing of invalid) {
    writeTiming(timing);
    const before = readFileSync(f.path, 'utf8');
    const s = f.summary();
    assert.ok(s.integrity_warnings.some((w) => w.code === 'invalid_carrier_timing'));
    assert.equal(s.runs[0].parallel_groups.length, 0);
    assert.equal(f.cli('start', ...eventArgs).status, 1);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
  writeFileSync(f.path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  assert.deepEqual(f.summary().integrity_warnings, []);
  assert.equal(f.summary().runs[0].parallel_groups[0].timing_basis, 'logger_intervals');
});

test('end cannot introduce identity; matching identities and ordinary end metrics remain valid', (t) => {
  const f = fixture(t);
  assert.equal(f.cli('start', ...eventArgs).status, 0);
  const before = readFileSync(f.path, 'utf8');
  for (const metric of ['candidate_id=sha-1', 'review_execution=review-late']) {
    assert.equal(f.cli('end', ...eventArgs, '--metric', metric).status, 1);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
  assert.equal(f.cli('end', ...eventArgs, '--metric', 'finding_count=0').status, 0);
  const next = [...eventArgs.slice(0, -1), 'review-2'];
  assert.equal(f.cli('start', ...next, '--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-2').status, 0);
  assert.equal(f.cli('end', ...next, '--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-2').status, 0);
});

test('summary flags historical late or changed identities and never groups by them', (t) => {
  const late = pair('late', 'activity', 'primary_review', 0, 100);
  late[1] = { ...late[1], metrics: { candidate_id: 'sha-late', review_execution: 'review-late' } };
  const changed = pair('changed', 'activity', 'primary_review', 0, 100,
    { candidate_id: 'sha-original', review_execution: 'review-original' });
  changed[1] = { ...changed[1], metrics: { candidate_id: 'sha-new', review_execution: 'review-new' } };
  const f = fixture(t, [...late, ...changed]);
  const r = f.summary().runs[0];
  assert.equal(r.open_state, 'unknown_due_to_integrity');
  assert.equal(r.intervals[0].metrics.review_execution, undefined);
  assert.equal(r.intervals[0].metrics.candidate_id, undefined);
  assert.equal(r.intervals[1].metrics.candidate_id, 'sha-original');
  assert.deepEqual(r.review_executions.map((e) => e.review_execution), ['review-original']);
  assert.equal(f.cli('start', ...eventArgs).status, 1);
});
