// Capture of every legacy eval / run-summary / run-log summary figure for old logs (ASTF-42 S-04a1, T-C1).
// `capture(scriptsDir)` imports the scripts from the GIVEN directory, so the same capture runs against origin/main and the candidate.
// Fixtures use only Z stamps, no models, and no unfinished review round: the permitted deltas (offset stamps, models_used, open rounds) never apply.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const schema = 'ship-ticket-run-log-v1';
const SEC = 1000;
const iso = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();

function pair(ticket, runId, id, kind, name, start, end, metrics = {}, outcome = 'pass', extra = {}) {
  const base = { schema, ticket, run_id: runId, event_id: id, kind, name, metrics };
  return [{ ...base, event: 'start', timestamp: iso(start) }, { ...base, event: 'end', timestamp: iso(end), duration_ms: end - start, outcome, ...extra }];
}
const roundRows = (ticket, runId, id, t0, activities, phaseMetrics = {}, wall = 300) => {
  const m = { review_execution: `review-${id}`, candidate_id: 'sha-1' };
  return [...pair(ticket, runId, `${runId}-${id}-ph`, 'phase', 'REVIEW', t0 * SEC, (t0 + wall) * SEC, { ...m, skill_revision: 'rev-1', primary_ceiling_ms: 600000, ...phaseMetrics }),
    ...activities.flatMap(([name, a, b, extra = {}, outcome = 'pass', carrier]) =>
      pair(ticket, runId, `${runId}-${id}-${name}`, 'activity', name, (t0 + a) * SEC, (t0 + b) * SEC, { ...m, ...extra }, outcome, carrier ? { carrier_timing: carrier } : {}))];
};
const carrier = (a, b, delay) => ({ source: 'relay_result', tool: 'claude', status: 'completed', result_sha256: 'a'.repeat(64), candidate_id: 'sha-1',
  review_execution: 'review-x', started_at: iso(a * SEC), ended_at: iso(b * SEC), duration_ms: (b - a) * SEC, collection_delay_ms: delay });

function logs() {
  const out = {};
  const T1 = [];
  // A full run: workflow, phases, activities, a parallel group on carrier timing, an open non-review activity, waits, 3 review rounds.
  T1.push(...pair('T1', 'run-1', 'wf', 'workflow', 'ticket', 0, 2000 * SEC, { ui_ticket: true }, 'complete'),
    ...pair('T1', 'run-1', 'plan', 'phase', 'PLAN', 0, 100 * SEC), ...pair('T1', 'run-1', 'build', 'phase', 'BUILD', 100 * SEC, 700 * SEC),
    ...pair('T1', 'run-1', 'fe', 'activity', 'frontend_build', 110 * SEC, 400 * SEC, { parallel_group: 'wave-1' }),
    ...pair('T1', 'run-1', 'be', 'activity', 'backend_build', 110 * SEC, 380 * SEC, { parallel_group: 'wave-1' }),
    ...pair('T1', 'run-1', 'w1', 'wait', 'user_approval', 500 * SEC, 560 * SEC));
  T1.push(...roundRows('T1', 'run-1', 'a', 700, [['primary_review', 0, 100, {}, 'pass', carrier(700, 800, 5)], ['optional_review', 10, 120], ['review_reconcile', 130, 160],
    ['review_repair', 170, 220], ['review_confirmation', 230, 280]], { repair_batches: 1, confirmation_count: 1, gap_reason: 'wait' }, 300));
  T1.push(...roundRows('T1', 'run-1', 'b', 1100, [['primary_review', 0, 90], ['optional_review', 5, 95], ['review_reconcile', 100, 130], ['review_repair', 140, 170]],
    { repair_batches: 2, confirmation_count: 0 }, 250));
  T1.push(...roundRows('T1', 'run-1', 'c', 1500, [['primary_review', 0, 60], ['optional_review', 0, 70], ['review_reconcile', 80, 100]],
    { repair_batches: 0, confirmation_count: 0, gap_reason: 'no_start_stamp' }, 200));
  T1.push({ schema, ticket: 'T1', run_id: 'run-1', event_id: 'open-1', kind: 'activity', name: 'frontend_build', event: 'start', timestamp: iso(1900 * SEC), metrics: {} });
  out.T1 = T1;
  // 21 single-round runs of one ticket: P50 (n>=5) and P95 (n>=20) are computed.
  out.P = Array.from({ length: 21 }, (_, i) => roundRows('P', `run-p${i}`, 'a', 0, [['primary_review', 0, (i + 1) * 10], ['optional_review', 0, (i + 1) * 9], ['review_reconcile', (i + 1) * 10, (i + 1) * 10 + 5]],
    { repair_batches: 0, confirmation_count: 0 }, (i + 1) * 10 + 5)).flat();
  // a legacy raw log without review_execution ids
  out.L = [...pair('L', 'run-l', 'ph', 'phase', 'REVIEW', 0, 100 * SEC, { repair_batches: 1, confirmation_count: 1 }), ...pair('L', 'run-l', 'c', 'activity', 'review_confirmation', 110 * SEC, 120 * SEC),
    ...pair('L', 'run-l', 'wf', 'workflow', 'ticket', 0, 130 * SEC, {}, 'complete')];
  return out;
}

function engineState() {
  const at = (s) => iso(s * SEC);
  const attempt = (id, kind, node, s, e, rss, cpu, extra = {}) => ({ attempt_id: id, kind, node, started_at: at(s), ...(kind === 'proof' ? { status: 'exited', ended_at: at(e) } : { envelope: { ended_at: at(e), peak_rss_mb: rss, peak_cpu_pct: cpu } }), ...extra });
  const node = (id, unit, deps, reads, writes) => ({ id, unit, deps, checks: [`chk-${id}`], acceptance: [`AC-${id}`], resources: [], reads, writes });
  return { schema: 'ship-ticket-engine-state-v1', ticket: 'T1', run_id: 'run-1', config: { width: 2 },
    nodes: { a: node('a', 'u-1', [], ['docs/in.txt'], ['src/a.txt']), b: node('b', 'u-2', ['a'], ['src/a.txt'], ['src/b.txt']) },
    unit_checks: { 'u-1': { evidence: { id: 'ev-1', state: 'verified', candidate_id: 'c'.repeat(64), binding: { base_commit: 'abc123', fps: { 'docs/in.txt': 'f:1', 'src/a.txt': 'f:2' } },
      results: [{ name: 'chk-a', result: 'pass', exit_code: 0 }] }, invalidations: 1, causes: [{ changed: ['docs/in.txt'] }] },
      'u-2': { stale: true, evidence: { id: 'ev-2', state: 'verified', candidate_id: 'd'.repeat(64), binding: { base_commit: 'abc123', fps: { 'src/b.txt': 'f:3' } }, results: [] } } },
    attempts: [attempt('att-1', 'node', 'a', 100, 260, 512, 80), attempt('att-2', 'node', 'b', 110, 200, 640, 95), attempt('att-3', 'node', 'c', 120, 130, 100, 10),
      attempt('att-4', 'proof', 'p', 300, 340), attempt('att-5', 'proof', 'q', 350, 360, undefined, undefined, { status: 'exited' })],
    events: [{ seq: 0, type: 'GATE' }, { seq: 1, type: 'GATE' }, { seq: 2, type: 'RESUME', outcome: 'continued' }, { seq: 3, type: 'RESUME' }, { seq: 4, type: 'INFRA_RETRY' },
      { seq: 5, type: 'LOCAL_PROOF' }, { seq: 6, type: 'LOCAL_PROOF' }, { seq: 7, type: 'LOCAL_PROOF' }, { seq: 8, type: 'ADMISSION_REFUSED' }],
    authority: { trusted: [JSON.stringify({ event: 'RETRY', run_id: 'run-1' }), JSON.stringify({ event: 'RETRY', run_id: 'other' }), 'not json'] },
    review_chain: [{ kind: 'original', review_execution: 'review-a', overflow: false, findings: [{ severity: 'major' }, { severity: 'minor' }, {}] },
      { kind: 'repair', review_execution: 'review-a' }, { kind: 'confirmation', review_execution: 'review-a', findings: [{ severity: 'minor' }] },
      { kind: 'original', review_execution: 'review-b', overflow: true }, { kind: 'retry', review_execution: 'review-b' }, { kind: 'repair', review_execution: 'review-c' }],
    repairs: [{ kind: 'review', state: 'done', review_execution: 'review-a' }, { kind: 'review', state: 'done', review_execution: 'review-zz' }],
    usage: [{ attempt_id: 'att-1', api_ms: 60000, run_id: 'run-1', role: 'builder', input_tokens: 10, output_tokens: 5, source_execution_id: 'att-1' },
      { attempt_id: 'att-3', api_ms: 4000, run_id: 'run-1', role: 'builder', input_tokens: 1, output_tokens: 1, source_execution_id: 'att-3' }] };
}

const usageRecords = () => {
  const r = (runId, role, i, o, extra = {}) => ({ provider: 'claude', run_id: runId, role, source: 'session', source_execution_id: `${runId}-${role}-${i}`,
    input_tokens: i, output_tokens: o, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: null, reported_cost_usd: null, cost_basis: null, ...extra });
  return [r('run-1', 'orchestrator', 800, 200, { reported_cost_usd: 1.25, cost_basis: 'list' }), r('run-1', 'reviewer', 300, 100, { reported_cost_usd: 0.5, cost_basis: 'list' }),
    r('run-1', 'unattributed', 50, 10), r('run-1', 'builder', 100, 20, { attempt_id: 'att-2', api_ms: 7000 }), r('run-p0', 'orchestrator', 90, 10), r('run-l', 'builder', 5, 5, { reported_cost_usd: 2, cost_basis: 'billed' })];
};

export async function capture(scriptsDir) {
  const load = (name) => import(pathToFileURL(join(scriptsDir, name)).href);
  const [{ evaluate }, { aggregate, buildRun }] = await Promise.all([load('eval.mjs'), load('run-summary.mjs')]);
  const all = logs();
  const state = engineState();
  const golden = JSON.parse(readFileSync(join(scriptsDir, 'run-engine-units.golden.json'), 'utf8')).state; // the existing S-27-min legacy engine state
  const records = usageRecords();
  const runsOf = (ticket, rows) => [...new Set(rows.map((r) => r.run_id))].map((id) => buildRun(ticket, id, rows.filter((r) => r.run_id === id)));
  const runs = Object.entries(all).flatMap(([ticket, rows]) => runsOf(ticket, rows));
  const goldenRun = buildRun(golden.ticket, golden.run_id, pair(golden.ticket, golden.run_id, 'g-wf', 'workflow', 'ticket', 0, 500 * SEC, {}, 'complete').flat());
  const result = { library: evaluate({ runs: [...runs, goldenRun], states: { T1: state, [golden.ticket]: golden }, records }), aggregate: aggregate(runs) };
  // CLI paths over a real repo directory: eval report --all and run-log summary --all.
  const repo = mkdtempSync(join(tmpdir(), 'legacy-golden-'));
  try {
    if (spawnSync('git', ['init', '-q', repo]).status !== 0) throw new Error('git init failed');
    const dir = join(repo, '.git', 'ai-skills', 'ship-ticket');
    mkdirSync(dir, { recursive: true });
    for (const [ticket, rows] of Object.entries(all)) writeFileSync(join(dir, `${ticket}.jsonl`), rows.map((r) => JSON.stringify(r) + '\n').join(''));
    // The CLI passes a real repoRoot, which makes unit states depend on the work tree: units are covered by the library capture (repoRoot null).
    writeFileSync(join(dir, 'T1.state.json'), JSON.stringify({ ...state, unit_checks: undefined }));
    const usagePath = join(repo, 'usage.jsonl');
    writeFileSync(usagePath, records.map((r) => JSON.stringify(r) + '\n').join(''));
    const cli = (script, ...args) => { const r = spawnSync(process.execPath, [join(scriptsDir, script), ...args, '--repo', repo], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${script}: ${r.stderr}`); return JSON.parse(r.stdout); };
    result.eval_cli = cli('eval.mjs', 'report', '--all', '--usage', usagePath);
    result.summary_cli = cli('run-log.mjs', 'summary', '--all');
    // The only wall-clock-dependent figure (age of the oldest open interval vs now), per run and aggregate: kept as a presence marker.
    const mask = (v) => { for (const [k, x] of Object.entries(v ?? {})) { if (k === 'oldest_open_age_ms' && typeof x === 'number') v[k] = 'now-dependent'; else if (x && typeof x === 'object') mask(x); } };
    mask(result.summary_cli);
  } finally { rmSync(repo, { recursive: true, force: true }); }
  return result;
}
