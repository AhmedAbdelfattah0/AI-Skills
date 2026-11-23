// FR-4b: the read-only review-cycles view of eval.mjs (existing records only: review_chain, state.repairs/judgments, run-log intervals).
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildRun } from './run-summary.mjs';
import { evaluateRun, evaluate } from './eval.mjs';

const SEC = 1000;
const iso = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const schema = 'ship-ticket-run-log-v1';
function pair(runId, id, kind, name, start, end, metrics = {}) {
  const base = { schema, ticket: 'T', run_id: runId, event_id: id, kind, name, metrics };
  return [{ ...base, event: 'start', timestamp: iso(start * SEC) }, { ...base, event: 'end', timestamp: iso(end * SEC), duration_ms: (end - start) * SEC, outcome: 'pass' }];
}
/** One review round of run-1: REVIEW phase plus [name, start s, end s] activities, all bound to `rx`. */
function round(rx, acts, phase = [0, 900], phaseMetrics = {}) {
  const m = { review_execution: rx, candidate_id: 'sha-1' };
  return [...pair('run-1', `${rx}-ph`, 'phase', 'REVIEW', phase[0], phase[1], { ...m, ...phaseMetrics }),
    ...acts.flatMap(([n, a, b]) => pair('run-1', `${rx}-${n}-${a}`, 'activity', n, a, b, m))];
}
const original = (rx, outcome, findings = [], extra = {}) => ({ review_execution: rx, kind: 'original', outcome, candidate_id: 'h1', findings, fix_findings: findings.map((f) => f.id), overflow: false, ...extra });
const repair = (rx) => ({ review_execution: rx, kind: 'repair', old_candidate: 'h1', new_candidate: 'h2', write_set: ['a'] });
const confirmation = (rx, outcome) => ({ review_execution: rx, kind: 'confirmation', outcome, candidate_id: 'h2' });
const retry = (rx, predecessor, by = 'owner') => ({ review_execution: rx, kind: 'retry', predecessor, authorized_by: by });
const f = (id, severity, ...paths) => ({ id, severity, paths });
const cyclesOf = (chain, { state = {}, rows = [] } = {}) =>
  evaluateRun(buildRun('T', 'run-1', rows), { cycles: true, state: { run_id: 'run-1', review_chain: chain, ...state } }).review_cycles;

test('normal pass: one cycle, no repair, terminal pass', () => {
  const c = cyclesOf([original('rx-1', 'PASS')]);
  assert.equal(c.source, 'review_chain');
  assert.equal(c.attempt_count, 1);
  const [a] = c.attempts;
  assert.deepEqual([a.cycle_count, a.repair_batches, a.confirmations, a.terminal, a.retry], [1, 0, 0, 'pass', 'none']);
  assert.equal(a.flag, undefined);
  assert.deepEqual(c.flagged_attempts, []);
});

test('two cycles: original FAIL, one repair batch, confirmation PASS', () => {
  const [a] = cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x.js')]), repair('rx-1'), confirmation('rx-1', 'PASS')]).attempts;
  assert.deepEqual([a.cycle_count, a.repair_batches, a.confirmations, a.terminal], [2, 1, 1, 'pass']);
  assert.deepEqual(a.cycles.map((x) => [x.cycle, x.kind, x.outcome]), [[1, 'original', 'FAIL'], [2, 'confirmation', 'PASS']]);
  assert.equal(a.flag, undefined);
});

test('a third cycle is flagged cycle_limit_exceeded', () => {
  const c = cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x.js')]), repair('rx-1'), confirmation('rx-1', 'FAIL'), repair('rx-1'), confirmation('rx-1', 'PASS')]);
  assert.equal(c.attempts[0].cycle_count, 3);
  assert.equal(c.attempts[0].flag, 'cycle_limit_exceeded');
  assert.deepEqual(c.flagged_attempts, [1]);
});

test('confirmation FAIL, then an authorized RETRY starts attempt 2 (the count is not reset by the retry record alone)', () => {
  const c = cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x.js')]), repair('rx-1'), confirmation('rx-1', 'FAIL'),
    retry('rx-2', 'rx-1', 'ahmed'), original('rx-2', 'PASS')]);
  assert.equal(c.attempt_count, 2);
  assert.equal(c.attempts[0].terminal, 'confirmation_fail');
  assert.deepEqual(c.attempts[1].retry, { authorized_by: 'ahmed', predecessor: 'rx-1' });
  assert.deepEqual([c.attempts[1].cycle_count, c.attempts[1].terminal], [1, 'pass']);
  assert.deepEqual(c.attempts[1].review_executions, ['rx-2']);
});

test('RETRY-reset attempts: repeated finding classes (same severity and path set) across attempts', () => {
  const c = cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x.js', 'y.js'), f('b', 'minor', 'z.js')]), repair('rx-1'), confirmation('rx-1', 'FAIL'),
    retry('rx-2', 'rx-1'), original('rx-2', 'FAIL', [f('c', 'major', 'y.js', 'x.js'), f('d', 'major', 'z.js')])]);
  assert.deepEqual(c.repeated_findings, [{ severity: 'major', paths: ['x.js', 'y.js'], attempts: [1, 2] }]);
  assert.deepEqual(c.attempts_without_findings, []);
});

test('terminal reasons: overflow, repair_failed, round_limit, fail_no_repair', () => {
  assert.equal(cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x')], { overflow: true })]).attempts[0].terminal, 'overflow');
  assert.equal(cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x')])], { state: { repairs: [{ kind: 'review', review_execution: 'rx-1', state: 'failed' }] } }).attempts[0].terminal, 'repair_failed');
  assert.equal(cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x')])], { state: { judgments: [{ code: 'round_limit', node: 'repair-rx-1' }] } }).attempts[0].terminal, 'round_limit');
  assert.equal(cyclesOf([original('rx-1', 'FAIL', [])]).attempts[0].terminal, 'fail_no_repair');
  assert.equal(cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x')]), repair('rx-1')]).attempts[0].terminal, 'awaiting_confirmation');
});

test('torn or missing records print unknown, never zero, and are counted', () => {
  const c = cyclesOf([null, 7, { kind: 'mystery' }, { kind: 'original', review_execution: 'rx-1' }, { kind: 'confirmation' }]);
  assert.equal(c.unreadable_records, 3);
  const [a] = c.attempts;
  assert.equal(a.cycles[0].outcome, 'unknown');
  assert.equal(a.cycles[0].head, 'unknown');
  assert.equal(a.cycles[0].findings, 'unknown');
  assert.equal(a.terminal, 'unknown');
  assert.deepEqual(c.attempts_without_findings, [1]);
  // A repair record with no original before it opens a flagged attempt; an original after an original without a RETRY is flagged missing.
  const odd = cyclesOf([original('rx-1', 'PASS'), original('rx-2', 'PASS')]);
  assert.equal(odd.attempts[1].retry.record, 'missing');
  assert.equal(odd.attempts[1].retry.authorized_by, 'unknown');
});

test('legacy run (no engine state, or another run state): unknown, not zero', () => {
  const run = buildRun('T', 'run-1', []);
  assert.equal(evaluateRun(run, { cycles: true }).review_cycles.attempts, 'unknown');
  assert.equal(evaluateRun(run, { cycles: true, state: { run_id: 'run-OTHER', review_chain: [original('rx-1', 'PASS')] } }).review_cycles.source, 'unknown');
  assert.equal(evaluateRun(run, { cycles: true, state: { run_id: 'run-1' } }).review_cycles.source, 'unknown');
});

test('time between cycles and attempts comes from run-log intervals only', () => {
  const rows = [...round('rx-1', [['primary_review', 10, 100], ['optional_review', 20, 120], ['review_repair', 130, 200], ['review_confirmation', 260, 300]], [0, 310], { repair_batches: 1, confirmation_count: 1 }),
    ...round('rx-2', [['primary_review', 1000, 1100]], [990, 1110])];
  const c = cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x')]), repair('rx-1'), confirmation('rx-1', 'FAIL'), retry('rx-2', 'rx-1'), original('rx-2', 'PASS')], { rows });
  assert.deepEqual(c.attempts[0].between_cycles_ms, [140 * SEC]); // reviewers ended 120, confirmation started 260
  assert.equal(c.attempts[0].since_previous_attempt_ms, 'none');
  assert.equal(c.attempts[1].since_previous_attempt_ms, 700 * SEC); // 1000 - 300 (last interval end of attempt 1; the phase end is not an interval)
  // Without run-log intervals the gaps are unknown, not zero.
  const bare = cyclesOf([original('rx-1', 'FAIL', [f('a', 'major', 'x')]), repair('rx-1'), confirmation('rx-1', 'PASS')]);
  assert.deepEqual(bare.attempts[0].between_cycles_ms, ['unknown']);
});

test('evaluate() carries review_cycles per run and never reads the engine events file name as a ticket', () => {
  const m = evaluate({ runs: [buildRun('T', 'run-1', [])], cycles: true, states: { T: { run_id: 'run-1', review_chain: [original('rx-1', 'PASS')] } } });
  assert.equal(m.runs[0].review_cycles.attempt_count, 1);
});

test('default report is unchanged: no review_cycles key without the opt-in', () => {
  const state = { run_id: 'run-1', review_chain: [original('rx-1', 'PASS')] };
  assert.equal('review_cycles' in evaluateRun(buildRun('T', 'run-1', []), { state }), false);
  assert.equal('review_cycles' in evaluate({ runs: [buildRun('T', 'run-1', [])], states: { T: state } }).runs[0], false);
});

test('CLI: report --cycles prints review_cycles, the default report does not', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmpdir(), 'fr4b-'));
  try {
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
    const dir = join(repo, git('rev-parse', '--git-path', 'ai-skills/ship-ticket').stdout.trim());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'T-1.state.json'), JSON.stringify({ run_id: 'run-1', review_chain: [original('rx-1', 'PASS')] }));
    const script = fileURLToPath(new URL('./eval.mjs', import.meta.url));
    const run = (...extra) => spawnSync('node', [script, 'report', '--repo', repo, '--ticket', 'T-1', ...extra], { encoding: 'utf8' });
    const withCycles = JSON.parse(run('--cycles').stdout);
    assert.equal(withCycles.runs[0].review_cycles.attempt_count, 1);
    assert.equal('review_cycles' in JSON.parse(run().stdout).runs[0], false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
