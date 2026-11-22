import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRun } from './run-summary.mjs';
import { verifyReviewExecution } from './carrier.mjs';
import { REVIEW_ROLE_OF, IDENTITY_ACTIVITIES, GAP_REASONS, CEILING_METRICS, STRING_METRICS } from './review-intervals.mjs';
import { readFileSync as readText, readdirSync, realpathSync, existsSync, chmodSync } from 'node:fs';
const readdirSyncSafe = (d) => { try { return readdirSync(d).sort(); } catch { return []; } };
const realpathSyncSafe = (p) => realpathSync.native(p);
const existsSyncSafe = existsSync;
const chmodSyncSafe = (p, m) => { try { chmodSync(p, m); } catch { /* gone */ } };

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
const eventArgs = ['--run-id', 'run-1', '--kind', 'activity', '--name', 'contract_review', '--event-id', 'review-1'];

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

test('end imports provider usage from a carrier result without shell word-splitting (--metrics-from)', (t) => {
  const f = fixture(t);
  const args = ['--run-id', 'run-1', '--kind', 'activity', '--name', 'frontend_build', '--event-id', 'build-1'];
  assert.equal(f.cli('start', ...args).status, 0);
  const result = join(f.repo, '..', `carrier-${Date.now()}.json`);
  t.after(() => rmSync(result, { force: true }));
  writeFileSync(result, JSON.stringify({ run_log_metrics: ['input_tokens=6', 'output_tokens=2003', 'reported_cost_usd=0.419237'] }));
  const ended = f.cli('end', ...args, '--outcome', 'pass', '--metrics-from', result);
  assert.equal(ended.status, 0, ended.stderr);
  const last = readFileSync(f.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(last.metrics, { input_tokens: 6, output_tokens: 2003, reported_cost_usd: 0.419237 });
  writeFileSync(result, JSON.stringify({ usage: {} }));
  assert.equal(f.cli('start', '--run-id', 'run-1', '--kind', 'activity', '--name', 'x', '--event-id', 'x-1', '--metrics-from', result).status, 1);
});

test('summary --all skips the engine event file <ticket>.engine.jsonl', (t) => {
  const f = fixture(t, pair('wf', 'workflow', 'ticket', 0, 100));
  // The run engine's own event rows are not run-log rows and must not become a ticket "T1.engine".
  writeFileSync(join(dirname(f.path), 'T1.engine.jsonl'),
    JSON.stringify({ run_id: 'run-1', event: 'MARK', event_id: 'mark-1', node: 'a' }) + '\n');
  const result = spawnSync(process.execPath, [script, 'summary', '--all', '--repo', f.repo], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const s = JSON.parse(result.stdout);
  assert.deepEqual(s.runs.map((r) => r.ticket), ['T1']);
  assert.deepEqual(s.integrity_warnings, []);
});

// ---- A0.1: review-pipeline timing --------------------------------------------------------
const rid = (...rest) => ['--run-id', 'run-1', ...rest];
const ident = ['--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-1'];
const reviewPhase = ['--metric', 'skill_revision=abc1234', '--metric', 'primary_ceiling_ms=720000', '--metric', 'recovery_ceiling_ms=180000',
  '--metric', 'optional_ceiling_ms=600000', '--metric', 'confirmation_ceiling_ms=360000'];

test('review activity start refuses missing candidate_id or review_execution and writes nothing', (t) => {
  const f = fixture(t);
  for (const name of ['primary_review', 'optional_review', 'review_repair', 'review_confirmation', 'review_reconcile']) {
    const args = rid('--kind', 'activity', '--name', name, '--event-id', `${name}-1`);
    for (const partial of [[], ['--metric', 'candidate_id=sha-1'], ['--metric', 'review_execution=review-1']]) {
      const r = f.cli('start', ...args, ...partial);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, /requires a (candidate_id|review_execution)/);
    }
    assert.equal(f.cli('start', ...args, ...ident).status, 0, name);
  }
  assert.equal(readFileSync(f.path, 'utf8').trim().split('\n').length, 5);
});

test('REVIEW phase start: identity is refused when missing, telemetry is recorded unknown and never refused', (t) => {
  const f = fixture(t);
  const args = rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', 'phase-review');
  for (const partial of [[], ['--metric', 'candidate_id=sha-1'], ['--metric', 'review_execution=review-1']]) {
    const r = f.cli('start', ...args, ...partial, ...reviewPhase);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires a (candidate_id|review_execution)/);
  }
  assert.equal(readFileSync(f.path, 'utf8'), '');
  const bad = f.cli('start', ...args, ...ident, '--metric', 'primary_ceiling_ms=720000', '--metric', 'recovery_ceiling_ms=-1', '--metric', 'optional_ceiling_ms=soon');
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stderr, /recorded as unknown/);
  const m = JSON.parse(bad.stdout).metrics;
  assert.equal(m.skill_revision, 'unknown');
  assert.equal(m.primary_ceiling_ms, 720000);
  for (const key of ['recovery_ceiling_ms', 'optional_ceiling_ms', 'confirmation_ceiling_ms']) assert.equal(Object.hasOwn(m, key), false, key);
});

test('REVIEW phase start with every field keeps strings as strings, including digit-only and sha256 revisions', (t) => {
  const f = fixture(t);
  const sha = `sha256:${'a1'.repeat(32)}`;
  const withRevision = (id, rev, cand) => f.cli('start', ...rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', id), '--metric', `candidate_id=${cand}`,
    '--metric', `review_execution=review-${id}`, '--metric', `skill_revision=${rev}`, ...reviewPhase.slice(2));
  const a = withRevision('a', sha, '1234567');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stderr, '');
  assert.deepEqual([JSON.parse(a.stdout).metrics.skill_revision, JSON.parse(a.stdout).metrics.candidate_id], [sha, '1234567']);
  assert.equal(JSON.parse(withRevision('b', '1234567', 'sha-1').stdout).metrics.skill_revision, '1234567');
  assert.equal(JSON.parse(withRevision('c', 'x'.repeat(81), 'sha-1').stdout).metrics.skill_revision, 'unknown');
});

test('a REVIEW start lacking skill_revision and ceilings still authorizes carrier REPAIR', (t) => {
  const f = fixture(t);
  const started = f.cli('start', ...rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', 'phase-review'), ...ident);
  assert.equal(started.status, 0, started.stderr);
  const approval = { ticket: 'T1', run_id: 'run-1' };
  assert.equal(verifyReviewExecution(f.repo, approval, 'review-1', []), 'run-log');
  assert.throws(() => verifyReviewExecution(f.repo, approval, 'review-2', []), /no REVIEW phase start/);
});

test('optional_review with --carrier-result imports relay timing, the positive second-opinion path', (t) => {
  const f = fixture(t);
  const resultPath = join(f.repo, 'optional.json');
  const args = rid('--kind', 'activity', '--name', 'optional_review', '--event-id', 'optional-1');
  const startedRow = f.cli('start', ...args, ...ident, '--carrier-result', resultPath);
  assert.equal(startedRow.status, 0, startedRow.stderr);
  const stamp = JSON.parse(startedRow.stdout).timestamp;
  writeFileSync(resultPath, JSON.stringify({ schema: 'delegate-relay.result.v1', codexVersion: 'test', sandbox: 'read-only', workdir: f.repo,
    status: 'completed', startedAt: stamp, finishedAt: stamp }));
  const ended = f.cli('end', ...args, '--carrier-result', resultPath, '--outcome', 'pass');
  assert.equal(ended.status, 0, ended.stderr);
  const timing = JSON.parse(ended.stdout).carrier_timing;
  assert.deepEqual([timing.tool, timing.source, timing.review_execution], ['codex', 'relay_result', 'review-1']);
  assert.ok(timing.collection_delay_ms >= 0);
});

test('gap_reason: a start accepts only the enum, an end records anything else as unknown', (t) => {
  const f = fixture(t);
  const start = rid('--kind', 'activity', '--name', 'frontend_build', '--event-id', 'build-1');
  assert.equal(f.cli('start', ...start).status, 0);
  // A0.1 follow-up: an END with a bad value is written as `unknown` (a refused end would leave the interval open); a START still refuses it.
  const bad = f.cli('end', ...start, '--metric', 'gap_reason=forgot');
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).metrics.gap_reason, 'unknown');
  assert.match(bad.stderr, /gap_reason recorded as unknown/);
  assert.equal(f.cli('start', ...rid('--kind', 'activity', '--name', 'frontend_build', '--event-id', 'bad-start'), '--metric', 'gap_reason=forgot').status, 1);
  for (const reason of ['no_start_stamp', 'wait', 'host_sleep', 'unknown']) {
    const args = rid('--kind', 'activity', '--name', 'frontend_build', '--event-id', `gap-${reason}`);
    assert.equal(f.cli('start', ...args).status, 0);
    const ended = f.cli('end', ...args, '--metric', `gap_reason=${reason}`);
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(JSON.parse(ended.stdout).metrics.gap_reason, reason);
  }
});

test('a REVIEW phase ended with an invalid gap_reason is closed, not left open', (t) => {
  const f = fixture(t);
  const m = ['--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-1'];
  const args = rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', 'ph-1');
  assert.equal(f.cli('start', ...args, ...m).status, 0);
  assert.equal(f.cli('end', ...args, '--metric', 'gap_reason=because').status, 0);
  const run = f.summary().runs[0];
  assert.equal(run.open_intervals.length, 0);
  assert.equal(run.intervals.find((i) => i.name === 'REVIEW').metrics.gap_reason, 'unknown');
});

test('gap_reason on END: an over-long, multi-line or repeated value still closes the REVIEW phase as unknown, with a diagnostic', (t) => {
  const m = ['--metric', 'candidate_id=sha-1', '--metric', 'review_execution=review-1'];
  const cases = { long: ['gap_reason=' + 'x'.repeat(600)], newline: ['gap_reason=a\nb'], repeated: ['gap_reason=wait', 'gap_reason=sleep'], numeric: ['gap_reason=7'] };
  for (const [label, metrics] of Object.entries(cases)) {
    const f = fixture(t);
    const args = rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', `ph-${label}`);
    assert.equal(f.cli('start', ...args, ...m).status, 0);
    const ended = f.cli('end', ...args, ...metrics.flatMap((v) => ['--metric', v]));
    assert.equal(ended.status, 0, `${label}: ${ended.stderr}`);
    assert.match(ended.stderr, /recorded as unknown/);
    const run = f.summary().runs[0];
    assert.equal(run.open_intervals.length, 0, label);
    assert.equal(run.intervals.find((i) => i.name === 'REVIEW').metrics.gap_reason, 'unknown', label);
  }
  // Sibling END-path field: an invalid skill_revision on a REVIEW end is recorded as unknown, not a refusal that leaves the phase open.
  const f = fixture(t);
  const args = rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', 'ph-sk');
  assert.equal(f.cli('start', ...args, ...m, '--metric', 'skill_revision=r1').status, 0);
  assert.equal(f.cli('end', ...args, '--metric', 'skill_revision=bad value with spaces').status, 0);
  assert.equal(f.summary().runs[0].intervals[0].metrics.skill_revision, 'unknown');
  // Identity stays strict on END: a changed review_execution is still refused (the identity binding is not telemetry).
  const g = fixture(t);
  const gargs = rid('--kind', 'phase', '--name', 'REVIEW', '--event-id', 'ph-id');
  assert.equal(g.cli('start', ...gargs, ...m).status, 0);
  assert.equal(g.cli('end', ...gargs, '--metric', 'review_execution=review-2').status, 1);
});

const roundRows = (id, { drop = [], open = [], extra = [], phaseMetrics = { repair_batches: 1, confirmation_count: 1 } } = {}) => {
  const m = { review_execution: `review-${id}`, candidate_id: 'sha-1' };
  const roles = [['primary_review', 10, 100], ['optional_review', 20, 120], ['review_reconcile', 130, 150], ['review_repair', 160, 200], ['review_confirmation', 210, 300]];
  return [...pair(`ph-${id}`, 'phase', 'REVIEW', 0, 500, { ...m, ...phaseMetrics }),
    ...extra.flatMap((name) => pair(`${name}-${id}`, 'activity', name, 10, 100, m)),
    ...roles.filter(([name]) => !drop.includes(name)).flatMap(([name, a, b]) => {
      const rows = pair(`${name}-${id}`, 'activity', name, a, b, m);
      return open.includes(name) ? rows.slice(0, 1) : rows;
    })];
};

test('summary: a complete round reports 0 missing intervals (positive, with ids recorded)', (t) => {
  const f = fixture(t, roundRows('a'));
  const s = f.summary();
  assert.deepEqual(s.runs[0].missing_review_intervals, { count: 0, items: [] });
  assert.equal(s.aggregate.missing_review_intervals, 0);
  assert.equal(s.aggregate.missing_review_intervals_unknown_runs, 0);
});

test('summary: an absent pair and an unended start are each flagged with their role and reason', (t) => {
  const f = fixture(t, roundRows('a', { drop: ['review_reconcile', 'optional_review'], open: ['review_repair'] }));
  const run = f.summary().runs[0];
  assert.equal(run.missing_review_intervals.count, 3);
  assert.deepEqual(run.missing_review_intervals.items.map((i) => `${i.role}:${i.reason}`).sort(),
    ['reconcile:no_start_end_pair', 'repair:open_without_end', 'second_opinion:no_start_end_pair']);
  assert.equal(f.summary().aggregate.missing_review_intervals, 3);
});

test('summary: repair and confirmation are expected only when the REVIEW phase declares them', (t) => {
  const f = fixture(t, roundRows('a', { drop: ['review_repair', 'review_confirmation'], phaseMetrics: { repair_batches: 0, confirmation_count: 0 } }));
  assert.equal(f.summary().runs[0].missing_review_intervals.count, 0);
  writeFileSync(f.path, roundRows('a', { drop: ['review_repair', 'review_confirmation'], phaseMetrics: { repair_batches: 1, confirmation_count: 1 } }).map((r) => JSON.stringify(r) + '\n').join(''));
  assert.deepEqual(f.summary().runs[0].missing_review_intervals.items.map((i) => i.role).sort(), ['confirmation', 'repair']);
});

test('summary: no recorded review_execution is unknown, never 0', (t) => {
  const f = fixture(t, [...pair('ph', 'phase', 'REVIEW', 0, 100, { repair_batches: 0 }), ...pair('p', 'activity', 'primary_review', 0, 10)]);
  const s = f.summary();
  assert.equal(s.runs[0].missing_review_intervals.count, 'unknown');
  assert.equal(s.aggregate.missing_review_intervals, 'unknown');
  assert.equal(s.aggregate.missing_review_intervals_unknown_runs, 1);
});

test('summary: BUILD-phase unit_review activities never create or affect a review round', (t) => {
  const u = { review_execution: 'review-u1', candidate_id: 'sha-u' };
  const f = fixture(t, [...roundRows('a'), ...pair('u1', 'activity', 'unit_review', 20, 40, u), ...pair('u2', 'activity', 'unit_review_repair', 40, 50, u)]);
  const s = f.summary();
  assert.deepEqual(s.runs[0].missing_review_intervals, { count: 0, items: [] });
  // Alone, they leave the run unknown instead of inventing a round that is missing everything.
  const g = fixture(t, pair('u1', 'activity', 'unit_review', 20, 40, u));
  assert.equal(g.summary().runs[0].missing_review_intervals.count, 'unknown');
});

test('summary: partition reviewers satisfy the primary role', (t) => {
  const f = fixture(t, roundRows('a', { drop: ['primary_review'], extra: ['frontend_review', 'backend_review'] }));
  assert.deepEqual(f.summary().runs[0].missing_review_intervals, { count: 0, items: [] });
});

test('summary aggregate: unknown runs make the sum a lower bound, never a bare number; no known run is unknown', (t) => {
  const rowsFor = (run, rows) => rows.map((r) => ({ ...r, run_id: run, event_id: `${run}-${r.event_id}` }));
  const f = fixture(t, [...rowsFor('run-1', roundRows('a', { drop: ['review_reconcile'] })),
    ...rowsFor('run-2', [...pair('ph', 'phase', 'REVIEW', 0, 100, { repair_batches: 0 })])]);
  const a = f.summary().aggregate;
  assert.deepEqual([a.missing_review_intervals, a.missing_review_intervals_known_sum, a.missing_review_intervals_unknown_runs], ['at_least', 1, 1]);
  const g = fixture(t, rowsFor('run-1', roundRows('a')));
  assert.deepEqual([g.summary().aggregate.missing_review_intervals, g.summary().aggregate.missing_review_intervals_unknown_runs], [0, 0]);
});

test('run-log and eval import one review-interval table', () => {
  const dir = dirname(script);
  for (const file of ['run-log.mjs', 'eval.mjs']) {
    const text = readText(join(dir, file), 'utf8');
    assert.match(text, /from '\.\/review-intervals\.mjs'/, file);
    assert.doesNotMatch(text, /primary_review|optional_review|review_reconcile|recovery_ceiling_ms/, `${file} must not repeat the table`);
  }
  assert.equal(REVIEW_ROLE_OF.contract_review, 'primary');
  assert.ok(IDENTITY_ACTIVITIES.every((n) => REVIEW_ROLE_OF[n]) && GAP_REASONS.length === 4 && GAP_REASONS.includes('host_sleep') && CEILING_METRICS.length === 4 && STRING_METRICS.includes('skill_revision'));
});

test('S-04a1 summary: an unfinished repair under a declared 0 (or no declaration) is counted by missing_review_intervals', (t) => {
  for (const declared of [{ repair_batches: 0, confirmation_count: 0 }, {}]) {
    const m = { review_execution: 'review-1', candidate_id: 'sha-1' };
    const f = fixture(t, [...pair('ph', 'phase', 'REVIEW', 0, 100, { ...m, ...declared }), pair('rep', 'activity', 'review_repair', 10, 20, m)[0]]);
    const s = f.summary();
    assert.ok(s.runs[0].missing_review_intervals.count >= 1);
    assert.ok(s.runs[0].missing_review_intervals.items.some((i) => i.role === 'repair' && i.reason === 'open_without_end'));
    assert.notEqual(s.aggregate.missing_review_intervals, 0);
  }
});

// ------------------------------------------------------------------ S5 (F05): batch, check, supplied timestamps

const rowsOf = (f) => { try { return readText(f.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const bytesOf = (f) => { try { return readText(f.path, 'latin1'); } catch { return null; } };
const phaseArgs = (cmd, id) => [cmd, '--run-id', 'run-1', '--kind', 'phase', '--name', `P${id}`, '--event-id', id];
const zsh = spawnSync('zsh', ['-f', '-c', 'exit 0']).status === 0;

test('AC3 batch: metric values with -- and spaces survive verbatim under zsh (no word-splitting), from a file and from stdin', { skip: !zsh && 'zsh not installed' }, (t) => {
  const f = fixture(t);
  const opsFile = join(f.repo, 'ops file.json');
  writeFileSync(opsFile, JSON.stringify([
    { op: 'start', kind: 'phase', name: 'BUILD', event_id: 'b1', metrics: { note: '--metric x=1  two  spaces', n: 3 } },
    { op: 'end', kind: 'phase', name: 'BUILD', event_id: 'b1', outcome: 'pass', metrics: { tail: 'a -- b' } },
  ]));
  // The unquoted variable is the F05 failure: zsh passes "$OPS" as ONE word whatever it contains.
  const zshScript = 'OPS=$1; R=$2; "$3" "$4" batch --repo $R --ticket T1 --run-id run-1 --ops-file $OPS';
  const r = spawnSync('zsh', ['-f', '-c', zshScript, 'zsh', opsFile, f.repo, process.execPath, script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), { applied: 2 });
  const rows = rowsOf(f);
  assert.equal(rows[0].metrics.note, '--metric x=1  two  spaces');
  assert.equal(rows[0].metrics.n, 3);
  assert.equal(rows[1].metrics.tail, 'a -- b');
  // The failure batch replaces: an unquoted multi-flag variable is ONE word in zsh, so the flags never reach the parser.
  const split = spawnSync('zsh', ['-f', '-c', 'M="--metric a=1 --metric b=2"; "$1" "$2" start --repo "$3" --ticket T1 --run-id run-1 --kind phase --name Q --event-id q $M',
    'zsh', process.execPath, script, f.repo], { encoding: 'utf8' });
  assert.equal(split.status, 1, 'the documented zsh failure mode');
  assert.equal(rowsOf(f).length, 2);
});

test('AC3 batch without a shell: values with -- and spaces are kept verbatim from a file and from stdin', (t) => {
  const f = fixture(t);
  const opsFile = join(f.repo, 'ops file.json');
  writeFileSync(opsFile, JSON.stringify([{ op: 'start', kind: 'phase', name: 'BUILD', event_id: 'b1', metrics: { note: '--metric x=1  two  spaces', n: 3, flag: true } }]));
  const r = spawnSync(process.execPath, [script, 'batch', '--repo', f.repo, '--ticket', 'T1', '--run-id', 'run-1', '--ops-file', opsFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rowsOf(f)[0].metrics, { note: '--metric x=1  two  spaces', n: 3, flag: true });
  const viaStdin = spawnSync(process.execPath, [script, 'batch', '--repo', f.repo, '--ticket', 'T1', '--run-id', 'run-1', '--ops-file', '-'],
    { encoding: 'utf8', input: JSON.stringify([{ op: 'start', kind: 'activity', name: 'contract_review', event_id: 'c1', metrics: { candidate_id: 'sha-1', review_execution: 'review-1', x: '-- y' } }]) });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(rowsOf(f)[1].metrics.x, '-- y');
});

test('batch: every op is validated before the first write; a later runtime failure stops with {applied, failed:{index, reason}}', (t) => {
  const f = fixture(t);
  const batch = (ops) => spawnSync(process.execPath, [script, 'batch', '--repo', f.repo, '--ticket', 'T1', '--run-id', 'run-1', '--ops-file', '-'], { encoding: 'utf8', input: JSON.stringify(ops) });
  const ok = { op: 'start', kind: 'phase', name: 'BUILD', event_id: 'b1' };
  for (const bad of [[ok, { op: 'start', kind: 'nope', name: 'X', event_id: 'x' }], [ok, { op: 'start', kind: 'phase', name: 'X', event_id: 'bad id' }],
    [ok, { op: 'drop', kind: 'phase', name: 'X', event_id: 'x' }], [ok, { op: 'start', kind: 'phase', name: 'X', event_id: 'x', metrics: { 'bad key': 1 } }],
    [ok, { op: 'start', kind: 'activity', name: IDENTITY_ACTIVITIES[0], event_id: 'x' }], [ok, { op: 'start', kind: 'phase', name: 'host_sleep', event_id: 'x' }], 'not-an-array']) {
    const r = batch(bad);
    assert.equal(r.status, 1, JSON.stringify(bad));
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.applied, 0);
    assert.equal(typeof out.failed.reason, 'string');
    assert.equal(bytesOf(f), '', `nothing written: ${JSON.stringify(bad)}`);
  }
  const r = batch([ok, { op: 'end', kind: 'phase', name: 'BUILD', event_id: 'b1' }, { op: 'end', kind: 'phase', name: 'BUILD', event_id: 'zz' }, { op: 'start', kind: 'phase', name: 'C', event_id: 'c' }]);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { applied: 2, failed: { index: 2, reason: 'event zz has no start in run run-1' } });
  assert.deepEqual(rowsOf(f).map((x) => `${x.event}:${x.event_id}`), ['start:b1', 'end:b1'], 'not atomic: applied ops stay, later ops never run');
});

test('AC5/AC6 supplied timestamps: bounded, labelled estimated, duration from the supplied pair; every refusal appends zero rows', (t) => {
  const f = fixture(t);
  const base = Date.now();
  const ago = (ms) => new Date(base - ms).toISOString();
  const H = 3600000;
  const s = f.cli(...phaseArgs('start', 'a'), '--started-at', ago(H));
  assert.equal(s.status, 0, s.stderr);
  const started = JSON.parse(s.stdout);
  assert.deepEqual([started.timestamp_source, started.label], ['supplied', 'estimated']);
  const before = bytesOf(f);
  for (const [why, args] of [['future', ['--started-at', new Date(Date.now() + H).toISOString()]], ['beyond 24 h', ['--started-at', ago(25 * H)]],
    ['earlier than a row of the run', ['--started-at', ago(2 * H)]], ['non-ISO', ['--started-at', 'yesterday']], ['offset form', ['--started-at', '2026-01-01T00:00:00+02:00']]]) {
    const r = f.cli(...phaseArgs('start', 'b'), ...args);
    assert.equal(r.status, 1, why);
    assert.equal(bytesOf(f), before, `zero rows appended: ${why}`);
  }
  const endEarly = f.cli(...phaseArgs('end', 'a'), '--ended-at', ago(H + 1000));
  assert.equal(endEarly.status, 1, 'end before its start');
  assert.match(endEarly.stderr, /ended-at/);
  assert.equal(bytesOf(f), before);
  const endAt = ago(H / 2);
  const e = f.cli(...phaseArgs('end', 'a'), '--ended-at', endAt);
  assert.equal(e.status, 0, e.stderr);
  const ended = JSON.parse(e.stdout);
  assert.deepEqual([ended.timestamp, ended.duration_ms, ended.timestamp_source, ended.label], [endAt, H / 2, 'supplied', 'estimated']);
  const d = f.cli(...phaseArgs('start', 'c'));
  assert.equal(d.status, 0, d.stderr);
  const plain = JSON.parse(d.stdout);
  assert.equal(Object.hasOwn(plain, 'timestamp_source') || Object.hasOwn(plain, 'label'), false, 'a default row is unchanged: no new key');
  assert.equal(f.summary().integrity_warnings.length, 0);
  assert.equal(f.cli(...phaseArgs('start', 'x'), '--ended-at', ago(1)).status, 1, '--ended-at is an end option');
  assert.equal(f.cli(...phaseArgs('end', 'c'), '--started-at', ago(1)).status, 1, '--started-at is a start option');
});

test('D2 event --started-at/--ended-at: the same now-window bounds; zero rows appended on refusal', (t) => {
  const f = fixture(t);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  let n = 0;
  const ev = (a, b) => f.cli('event', '--run-id', 'run-1', '--name', 'host_sleep', '--event-id', `s-${n += 1}`, '--metric', 'label=estimated', '--started-at', a, '--ended-at', b);
  assert.equal(ev(ago(3600000), ago(1800000)).status, 0);
  const before = bytesOf(f);
  for (const [a, b] of [[ago(25 * 3600000), ago(1000)], [ago(1000), new Date(Date.now() + 3600000).toISOString()]]) {
    const r = ev(a, b);
    assert.equal(r.status, 1, `${a}..${b}`);
    assert.match(r.stderr, /within/);
    assert.equal(bytesOf(f), before);
  }
});

test('AC6 property (seeded): no start/end row is ever earlier than an earlier row of its run, whatever is supplied', (t) => {
  const f = fixture(t);
  let seed = 0x5eed5;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const open = [];
  let n = 0;
  for (let i = 0; i < 24; i += 1) {
    const offset = Math.round((rand() - 0.9) * 2 * 3600000); // mostly the past, sometimes a few seconds ahead
    const stamp = new Date(Date.now() + Math.min(offset, 4000)).toISOString();
    const supply = rand() < 0.6;
    const before = bytesOf(f);
    let r;
    if (open.length && rand() < 0.5) {
      const id = open[Math.floor(rand() * open.length)];
      r = f.cli(...phaseArgs('end', id), ...(supply ? ['--ended-at', stamp] : []));
      if (r.status === 0) open.splice(open.indexOf(id), 1);
    } else {
      const id = `e${n += 1}`;
      r = f.cli(...phaseArgs('start', id), ...(supply ? ['--started-at', stamp] : []));
      if (r.status === 0) open.push(id);
    }
    if (r.status !== 0) assert.equal(bytesOf(f), before, `refused op ${i} appended nothing: ${r.stderr}`);
  }
  const rows = rowsOf(f);
  assert.ok(rows.length >= 8, `the property saw writes (${rows.length})`);
  for (let k = 1; k < rows.length; k += 1) assert.ok(Date.parse(rows[k].timestamp) >= Date.parse(rows[k - 1].timestamp), `row ${k} ${rows[k].timestamp} < ${rows[k - 1].timestamp}`);
  for (const row of rows) if (!row.timestamp_source) assert.equal(Object.hasOwn(row, 'label'), false);
});

test('AC4 check: one JSON line, exit 0 healthy and 1 with a reason (non-repo, unwritable, torn tail); it writes nothing', (t) => {
  const f = fixture(t);
  const check = (repo, ...extra) => spawnSync(process.execPath, [script, 'check', '--repo', repo, ...extra], { encoding: 'utf8' });
  const listing = () => spawnSync('git', ['-C', f.repo, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }).stdout + readdirSyncSafe(dirname(f.path)).join(',');
  const before = listing();
  const ok = check(f.repo, '--ticket', 'T1');
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(realpathSyncSafe(out.resolved_dir), realpathSyncSafe(dirname(f.path)));
  assert.equal(listing(), before, 'check created nothing (no probe file, no lock)');
  const fresh = mkdtempSync(join(tmpdir(), 'ship-ticket-check-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  const nonRepo = check(fresh);
  assert.equal(nonRepo.status, 1);
  assert.equal(JSON.parse(nonRepo.stdout.trim()).ok, false);
  assert.ok(JSON.parse(nonRepo.stdout.trim()).reason);
  spawnSync('git', ['init', '-q', fresh]);
  const unborn = check(fresh, '--ticket', 'T1');
  assert.equal(unborn.status, 0, unborn.stderr);
  assert.equal(existsSyncSafe(join(fresh, '.git', 'ai-skills')), false, 'a healthy check on a fresh repository creates no directory');
  writeFileSync(f.path, readText(f.path, 'utf8') + '{"torn":');
  const torn = check(f.repo, '--ticket', 'T1');
  assert.equal(torn.status, 1);
  assert.match(JSON.parse(torn.stdout.trim()).reason, /incomplete_tail/);
  writeFileSync(f.path, '');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSyncSafe(dirname(f.path), 0o500);
    let ro;
    try { ro = check(f.repo, '--ticket', 'T1'); } finally { chmodSyncSafe(dirname(f.path), 0o700); }
    assert.equal(ro.status, 1);
    assert.match(JSON.parse(ro.stdout.trim()).reason, /not writable/);
  }
});

test('old-reader compatibility: origin/main rowsFromText accepts rows carrying timestamp_source and label', async (t) => {
  const old = spawnSync('git', ['-C', dirname(script), 'show', 'origin/main:skills/ship-ticket/scripts/run-log.mjs'], { encoding: 'utf8' });
  if (old.status !== 0) { t.skip('origin/main is not available in this checkout'); return; }
  const src = old.stdout;
  const body = src.slice(src.indexOf('function rowsFromText'), src.indexOf('function carrierBinding'));
  assert.ok(body.includes('function validCarrierTiming'), 'extracted the unmodified old reader');
  const dir = mkdtempSync(join(tmpdir(), 'old-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = (m) => new URL(`./${m}`, import.meta.url).href;
  writeFileSync(join(dir, 'old.mjs'), `import { basename } from 'node:path';\nimport { buildRun } from '${url('run-summary.mjs')}';\n`
    + `import { RUN_LOG_SCHEMA as SCHEMA, isEventName } from '${url('measure/events.mjs')}';\n`
    + `const KINDS = new Set(['workflow', 'phase', 'activity', 'wait']);\nconst SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;\nexport ${body}`);
  const { rowsFromText } = await import(new URL(`file://${join(dir, 'old.mjs').replaceAll('\\', '/').replace(/^([A-Za-z]:)/, '/$1')}`).href);
  const f = fixture(t);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(f.cli(...phaseArgs('start', 'a'), '--started-at', ago(60000)).status, 0);
  assert.equal(f.cli(...phaseArgs('end', 'a'), '--ended-at', ago(30000)).status, 0);
  const text = readText(f.path, 'utf8');
  assert.match(text, /"timestamp_source":"supplied"/);
  const { rows, warnings } = rowsFromText(text, f.path);
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 2);
});
