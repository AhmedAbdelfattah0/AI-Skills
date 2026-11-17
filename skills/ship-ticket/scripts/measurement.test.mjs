// S-04 (ASTF-42): measurement completeness. Fixture: scrum202-fixture.test-helper.mjs (synthetic, derived from the forensic timeline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRun } from './run-summary.mjs';
import { measurementOf, ownerDecisionsFromSession } from './measure.mjs';
import { evaluateRun, evaluate } from './eval.mjs';
import { extractUsage, importSessionUsage } from './usage.mjs';
import { TICKET, scrum202Rows, scrum202Usage, pair } from './scrum202-fixture.test-helper.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const runLog = join(dir, 'run-log.mjs');
const evalCli = join(dir, 'eval.mjs');
const NOW = Date.parse('2026-11-17T00:00:00Z');
const runsOf = (rows) => [...new Set(rows.map((r) => r.run_id))].map((id) => buildRun(rows[0].ticket, id, rows.filter((r) => r.run_id === id)));
const measure = (rows, records = [], extra = {}) => measurementOf(runsOf(rows), { records, now: NOW, ...extra });
const LABELS = ['measured', 'estimated', 'unavailable'];

function repo(t, rows = []) {
  const root = mkdtempSync(join(tmpdir(), 'ship-ticket-s04-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', root], { encoding: 'utf8' }).status, 0);
  const logDir = join(root, '.git', 'ai-skills', 'ship-ticket');
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${TICKET}.jsonl`);
  writeFileSync(log, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const cli = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { root, log, logDir, cli };
}

test('AC1: the SCRUM-202 fixture reproduces 6 rounds, 5 repair batches, 8 gate runs, 12 owner waits', () => {
  const m = measure(scrum202Rows(), scrum202Usage());
  assert.equal(m.tickets[TICKET].counts.review_rounds, 6);
  assert.equal(m.tickets[TICKET].counts.repair_batches, 5);
  assert.equal(m.tickets[TICKET].counts.gate_runs, 8);
  assert.equal(m.tickets[TICKET].counts.owner_waits, 12);
  assert.equal(m.metrics.M4.value[TICKET].rounds, 6);
  assert.equal(m.metrics.M4.value[TICKET].batches, 5);
});

test('AC7: eval report prints M1-M10 for the fixture, each labelled; M9 says unavailable until the window matures', (t) => {
  const f = repo(t, scrum202Rows());
  const usage = join(f.root, 'usage.jsonl');
  writeFileSync(usage, scrum202Usage().map((r) => `${JSON.stringify(r)}\n`).join(''));
  const r = f.cli(evalCli, 'report', '--repo', f.root, '--ticket', TICKET, '--usage', usage);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout).measurement;
  for (let i = 1; i <= 10; i += 1) assert.ok(LABELS.includes(m.metrics[`M${i}`]?.label), `M${i} label`);
  assert.equal(m.metrics.M9.label, 'unavailable');
  assert.equal(m.metrics.M9.value, 'unavailable until the 30-day window matures');
  assert.deepEqual([m.metrics.M1.numerator, m.metrics.M1.denominator, m.metrics.M1.value], [0, 1, 0]);
  // M5b: 15:03:22 -> 21:29:00 = 23,138 s; asleep 5,812 s; owner waits 4,123 s (forensic report 3a).
  const b = m.metrics.M5.value[TICKET].M5b;
  assert.equal(b.awake_ms_with_wait, 17326000);
  assert.equal(b.awake_ms_excluding_wait, 13203000);
  assert.equal(b.host_sleep_ms, 5812000);
  assert.equal(b.human_wait_ms, 4123000);
  // M6: reviewer wall 2,688 s + gate holds 27m13s = 1,633 s.
  assert.equal(m.metrics.M6.value[TICKET].review_rounds_ms, 2688000);
  assert.equal(m.metrics.M6.value[TICKET].gate_hold_ms, 1633000);
  assert.equal(m.metrics.M6.value[TICKET].critical_path_ms, 4321000);
  // M7: 8 runs, 6,502 s, 3 T0-class failures; no per-gate keys, so redundancy is unavailable (never 0).
  const g = m.metrics.M7.value[TICKET];
  assert.deepEqual([g.t2_runs, g.t2_wall_ms, g.t0_class_failures, g.redundant_gate_executions], [8, 6502000, 3, 'unavailable']);
  // M2: 14 distinct Majors from 17 labels; deferred findings stay separate (M9).
  assert.equal(m.metrics.M2.value, 14);
  assert.equal(m.metrics.M2.repeat_findings, 3);
  assert.deepEqual(m.metrics.M9.deferred_findings, { High: 1, Low: 1 });
});

test('AC2: missing Codex usage is unavailable, never 0; M8 says "Codex unavailable" instead of a total', () => {
  const m8 = measure(scrum202Rows(), scrum202Usage()).metrics.M8;
  assert.equal(m8.value.codex.usd, 'unavailable');
  assert.equal(m8.value.codex.label, 'unavailable');
  assert.equal(m8.value.total_usd, 'Codex unavailable');
  assert.equal(m8.value.per_delivered_ticket_usd, 'Codex unavailable');
  assert.equal(m8.value.claude.measured_usd, 10.05);
  assert.equal(m8.value.claude.estimated_usd, 48.6);
  assert.equal(m8.value.claude.label, 'estimated');
  assert.ok(!JSON.stringify(m8).match(/"codex":\{[^}]*"usd":0[,}]/));
  // Codex fully absent from the ticket: no lane, no records: not used, and the total is a number again.
  const rows = scrum202Rows();
  const codexIds = new Set(rows.filter((r) => r.metrics?.lane === 'codex').map((r) => r.event_id));
  const m = measure(rows.filter((r) => !codexIds.has(r.event_id)), scrum202Usage().filter((r) => r.provider !== 'codex'));
  assert.equal(m.metrics.M8.value.total_usd, 58.65);
});

test('AC3: an attempt with two models lists both; usage extraction keeps the model list', () => {
  const state = { run_id: 'run-A', attempts: [{ attempt_id: 'att-web-state', kind: 'worker', node: 'web-state',
    started_at: '2026-11-16T17:01:20.000Z', envelope: { ended_at: '2026-11-16T17:02:20.000Z' } }] };
  const [run] = runsOf(scrum202Rows());
  const t = evaluateRun(run, { state, records: scrum202Usage() }).attempt_timing;
  assert.deepEqual(t[0].models_used, ['claude-fable-5-2', 'claude-opus-5-5']);
  const u = extractUsage('claude', JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 1,
    modelUsage: { 'claude-opus-5-5': { costBasis: 'list' }, 'claude-fable-5-2': { costBasis: 'list' } } }));
  assert.deepEqual(u.models_used, ['claude-fable-5-2', 'claude-opus-5-5']);
  assert.equal(extractUsage('claude', JSON.stringify({ usage: { input_tokens: 1 } })).models_used, undefined);
});

test('AC4: mixed +02:00 and Z stamps normalise to UTC', () => {
  const [, b] = runsOf(scrum202Rows());
  const gate = b.intervals.find((i) => i.name === 'gate_run' && i.metrics.n === 1);
  assert.equal(gate.started_at, '2026-11-16T17:38:03.000Z');
  assert.ok(b.intervals.every((i) => /Z$/.test(i.started_at) && /Z$/.test(i.ended_at)));
  // an identical Z-only log gives identical metrics
  const asZ = scrum202Rows().map((r) => ({ ...r, timestamp: new Date(r.timestamp).toISOString() }));
  assert.deepEqual(measure(asZ, scrum202Usage()).metrics, measure(scrum202Rows(), scrum202Usage()).metrics);
});

test('AC5: A0.1 follow-up 1: an unfinished repair reads as a missing interval, not 0', (t) => {
  const rows = [...pair('r1', 'phase', 'REVIEW', '2026-11-16T10:00:00.000Z', '2026-11-16T10:30:00.000Z', { candidate_id: 'c1', review_execution: 'review-1' }),
    ...pair('r1', 'activity', 'primary_review', '2026-11-16T10:00:00.000Z', '2026-11-16T10:05:00.000Z', { candidate_id: 'c1', review_execution: 'review-1' }),
    ...pair('r1', 'activity', 'optional_review', '2026-11-16T10:00:00.000Z', '2026-11-16T10:06:00.000Z', { candidate_id: 'c1', review_execution: 'review-1' }),
    ...pair('r1', 'activity', 'review_reconcile', '2026-11-16T10:06:00.000Z', '2026-11-16T10:08:00.000Z', { candidate_id: 'c1', review_execution: 'review-1' })]
    .map((r) => ({ ...r, ticket: TICKET }));
  const open = { ...rows[0], event: 'start', event_id: 'repair-open', kind: 'activity', name: 'review_repair', timestamp: '2026-11-16T10:09:00.000Z',
    metrics: { candidate_id: 'c1', review_execution: 'review-1' } };
  const g = repo(t, [...rows, open]);
  const s = JSON.parse(g.cli(runLog, 'summary', '--repo', g.root, '--ticket', TICKET).stdout);
  assert.deepEqual(s.runs[0].missing_review_intervals.items, [{ review_execution: 'review-1', role: 'repair', reason: 'open_without_end' }]);
});

test('AC5: A0.1 follow-up 2: a round with an open interval feeds no truncated duration into the percentiles', () => {
  const mk = (n, withOpen) => {
    const base = { candidate_id: 'c', review_execution: `review-${n}` };
    const day = `2026-11-16T${String(10 + n).padStart(2, '0')}`;
    const rows = [...pair(`r${n}`, 'activity', 'primary_review', `${day}:00:00.000Z`, `${day}:10:00.000Z`, base),
      ...pair(`r${n}`, 'activity', 'optional_review', `${day}:00:00.000Z`, `${day}:10:00.000Z`, base)];
    if (withOpen) rows.push({ ...rows[0], event: 'start', event_id: 'open-repair', name: 'review_repair', timestamp: `${day}:11:00.000Z`, metrics: base });
    return buildRun(TICKET, `r${n}`, rows.map((r) => ({ ...r, ticket: TICKET })));
  };
  const runs = [1, 2, 3, 4, 5].map((n) => mk(n, n === 5));
  const out = evaluate({ runs });
  assert.equal(out.cross_run.review_round_wall_ms.n, 4);
  assert.equal(out.cross_run.review_round_wall_ms.excluded_unknown, 1);
});

test('AC5: A0.1 follow-up 3: an invalid gap_reason on a REVIEW end still closes the phase (recorded as unknown)', (t) => {
  const f = repo(t);
  const args = ['--repo', f.root, '--ticket', TICKET, '--run-id', 'r1', '--kind', 'phase', '--name', 'REVIEW', '--event-id', 'review-phase'];
  assert.equal(f.cli(runLog, 'start', ...args, '--metric', 'candidate_id=c1', '--metric', 'review_execution=review-1').status, 0);
  const end = f.cli(runLog, 'end', ...args, '--metric', 'gap_reason=not_a_reason');
  assert.equal(end.status, 0, end.stderr);
  assert.equal(JSON.parse(end.stdout).metrics.gap_reason, 'unknown');
  assert.match(end.stderr, /gap_reason/);
  const s = JSON.parse(f.cli(runLog, 'summary', '--repo', f.root, '--ticket', TICKET).stdout);
  assert.equal(s.runs[0].open_intervals.length, 0);
  // start keeps refusing an invalid value (a typo there loses nothing that cannot be re-run)
  assert.equal(f.cli(runLog, 'start', ...args.slice(0, -1), 'other', '--metric', 'gap_reason=bad').status, 1);
});

test('gap reason host_sleep is accepted by run-log', (t) => {
  const f = repo(t);
  const r = f.cli(runLog, 'start', '--repo', f.root, '--ticket', TICKET, '--run-id', 'r1', '--kind', 'wait', '--name', 'host_sleep', '--event-id', 'sleep-1', '--metric', 'gap_reason=host_sleep');
  assert.equal(r.status, 0, r.stderr);
});

test('AC6: recovery and fallback runs emit run_mode events and are counted in the metrics', (t) => {
  const f = repo(t);
  const ev = (name, run, id, ...metrics) => f.cli(runLog, 'event', '--repo', f.root, '--ticket', TICKET, '--run-id', run, '--name', name, '--event-id', id, ...metrics.flatMap((m) => ['--metric', m]));
  assert.equal(ev('run_mode', 'r1', 'mode-1', 'mode=engine').status, 0);
  const rec = ev('run_mode', 'r2', 'mode-2', 'mode=recovery', 'supersedes_run_id=r1');
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(ev('run_mode', 'r3', 'mode-3', 'mode=fallback', 'reason=execution_lane_unavailable', 'supersedes_run_id=r2').status, 0);
  assert.equal(ev('run_mode', 'r4', 'mode-4', 'mode=bogus').status, 1);
  assert.equal(ev('run_mode', 'r4', 'mode-5', 'mode=recovery', 'supersedes_run_id=bad id').status, 1);
  const m = JSON.parse(f.cli(evalCli, 'report', '--repo', f.root, '--ticket', TICKET).stdout).measurement;
  assert.deepEqual(m.populations.run_modes, { engine: 1, recovery: 1, fallback: 1 });
  assert.equal(m.tickets[TICKET].head_run_id, 'r3');
  assert.equal(m.tickets[TICKET].instrumented, true);
  // old readers still parse the new rows
  const s = f.cli(runLog, 'summary', '--repo', f.root, '--ticket', TICKET);
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(JSON.parse(s.stdout).integrity_warnings, []);
});

test('AC8: failed, abandoned and censored runs count in M1, M4 and M8 populations and are reported separately', () => {
  const day = (h) => `2026-11-16T${h}:00:00.000Z`;
  const wf = (ticket, run, outcome, open) => (outcome === 'open' ? [{ ...pair(run, 'workflow', 'ship-ticket', day('10'), day('11'))[0], ticket }] : pair(run, 'workflow', 'ship-ticket', day('10'), day('11'), {}, outcome).map((r) => ({ ...r, ticket })));
  const mode = (ticket, run) => pair(run, 'activity', 'run_mode', day('10'), day('10'), { mode: 'engine' }).map((r) => ({ ...r, ticket }));
  const rows = [];
  for (const [ticket, outcome] of [['T-ok', 'complete'], ['T-fail', 'fail'], ['T-aband', 'abandoned'], ['T-open', 'open']]) rows.push(...wf(ticket, `run-${ticket}`, outcome), ...mode(ticket, `run-${ticket}`));
  // only T-ok has a first review round, and it passes both lanes
  for (const lane of ['opus', 'codex']) rows.push(...pair('run-T-ok', 'activity', 'review_round', day('10'), day('10'), { n: 1, round_kind: 'original', lane, verdict: 'PASS', majors: 0, minors: 0 }).map((r) => ({ ...r, ticket: 'T-ok' })));
  const runs = [...new Set(rows.map((r) => r.run_id))].map((id) => buildRun(rows.find((r) => r.run_id === id).ticket, id, rows.filter((r) => r.run_id === id)));
  const m = measurementOf(runs, { records: [{ provider: 'claude', run_id: 'run-T-fail', role: 'builder', source_execution_id: 'x', reported_cost_usd: 2, cost_basis: 'list', input_tokens: 1 },
    { provider: 'claude', run_id: 'run-T-ok', role: 'builder', source_execution_id: 'y', reported_cost_usd: 3, cost_basis: 'list', input_tokens: 1 }], now: NOW });
  assert.deepEqual(m.populations.tickets, { started: 4, delivered: 1, failed: 1, abandoned: 1, censored: 1, unknown: 0, uninstrumented: 0 });
  assert.deepEqual([m.metrics.M1.numerator, m.metrics.M1.denominator], [1, 4]);
  assert.deepEqual(m.metrics.M1.by_status, { delivered: 1, failed: 0, abandoned: 0, censored: 0 });
  assert.equal(Object.keys(m.metrics.M4.value).length, 4);
  assert.equal(m.metrics.M8.value.claude.measured_usd, 5);
  assert.equal(m.metrics.M8.value.failed_or_abandoned_claude_usd, 2);
  assert.equal(m.metrics.M8.value.delivered_tickets, 1);
});

test('NEG: duplicate streamed records count once (identical rows, and a re-emitted logical event under a new event_id)', () => {
  const rows = scrum202Rows();
  const copies = rows.filter((r) => ['review_round', 'gate_run', 'repair_batch', 'owner_decision', 'finding'].includes(r.name))
    .map((r) => ({ ...r }));
  const base = measure(rows, scrum202Usage());
  const dup = measure([...rows, ...copies], scrum202Usage());
  assert.deepEqual(dup.tickets[TICKET].counts, base.tickets[TICKET].counts);
  assert.deepEqual(dup.metrics.M2, base.metrics.M2);
  // same logical round/lane re-emitted by a second stream under a fresh event_id
  const reemit = rows.filter((r) => r.name === 'review_round' || r.name === 'gate_run').map((r) => ({ ...r, event_id: `${r.event_id}-again` }));
  const again = measure([...rows, ...reemit], scrum202Usage());
  assert.deepEqual(again.tickets[TICKET].counts, base.tickets[TICKET].counts);
  assert.equal(again.metrics.M7.value[TICKET].t2_wall_ms, 6502000);
  assert.equal(again.metrics.M6.value[TICKET].review_rounds_ms, 2688000);
  // usage: a message streamed three times is one record
  const d = mkdtempSync(join(tmpdir(), 'ship-ticket-s04-usage-'));
  const line = (id, out) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-16T10:00:00.000Z', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(d, 's1.jsonl'), [line('m1', 1), line('m1', 5), line('m1', 9), line('m2', 2)].join('\n'));
  const recs = importSessionUsage(join(d, 's1.jsonl'), { runId: 'run-B' });
  rmSync(d, { recursive: true, force: true });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].output_tokens, 9);
  assert.deepEqual(recs[0].models_used, ['claude-opus-5-5']);
});

test('NEG: a subagent handback recorded as a user message is not a human decision', () => {
  const lines = [];
  let ts = Date.parse('2026-11-16T10:00:00Z');
  const at = () => new Date((ts += 60000)).toISOString();
  const asst = (stop = 'end_turn') => lines.push({ type: 'assistant', timestamp: at(), message: { id: `a${lines.length}`, stop_reason: stop, content: [{ type: 'text', text: 'x' }] } });
  const user = (content, extra = {}) => lines.push({ type: 'user', uuid: `u${lines.length}`, timestamp: at(), message: { role: 'user', content }, ...extra });
  for (let i = 0; i < 12; i += 1) { asst(); user([{ type: 'text', text: `decision ${i}` }]); }
  for (let i = 0; i < 31; i += 1) {
    asst(); // the orchestrator ended its turn waiting on background agents; the handback then arrives as a `user` record
    user('Another Claude session sent a message: <subagent handback>', {});
  }
  asst('tool_use'); user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]);
  asst(); user('hi', { isSidechain: true });
  lines.push({ ...lines.at(-1) }); // a duplicated streamed record
  const text = lines.map((l) => JSON.stringify(l)).join('\n');
  const waits = ownerDecisionsFromSession(text);
  assert.equal(waits.length, 12);
  assert.ok(waits.every((w) => w.wait_ms === 60000 && w.label === 'estimated'));
});

test('NEG: an estimate is never printed without its label', () => {
  const m = measure(scrum202Rows(), scrum202Usage());
  assert.equal(m.metrics.M8.value.claude.label, 'estimated');
  assert.equal(m.metrics.M5.value[TICKET].M5b.label, 'estimated'); // owner waits come from message timestamps
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    if (Object.hasOwn(o, 'label')) assert.ok(LABELS.includes(o.label), `${path}.label`);
    if (Object.keys(o).some((k) => k.startsWith('estimated_')) && typeof o.estimated_usd === 'number') assert.notEqual(o.label, 'measured', path);
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(m, 'm');
  // measured-only inputs stay measured
  const onlyMeasured = measure(scrum202Rows(), [scrum202Usage()[0]]);
  assert.equal(onlyMeasured.metrics.M8.value.claude.label, 'measured');
});

test('REG: old engine runs: eval output has no measurement key and attempt_timing has no models_used', () => {
  const rows = pair('run-old', 'workflow', 'ship-ticket', '2026-11-16T10:00:00.000Z', '2026-11-16T11:00:00.000Z', {}, 'complete').map((r) => ({ ...r, ticket: 'OLD-1' }));
  const out = evaluate({ runs: [buildRun('OLD-1', 'run-old', rows)], records: [{ provider: 'claude', run_id: 'run-old', role: 'orchestrator', input_tokens: 5 }] });
  assert.equal(Object.hasOwn(out, 'measurement'), false);
  assert.equal(Object.hasOwn(out.runs[0], 'measurement'), false);
  const state = { run_id: 'run-old', attempts: [{ attempt_id: 'a1', kind: 'worker', node: 'n', started_at: '2026-11-16T10:00:00.000Z', envelope: { ended_at: '2026-11-16T10:01:00.000Z' } }] };
  const t = evaluateRun(buildRun('OLD-1', 'run-old', rows), { state, records: [{ run_id: 'run-old', attempt_id: 'a1', api_ms: 5 }] }).attempt_timing;
  assert.deepEqual(Object.keys(t[0]), ['attempt_id', 'kind', 'node', 'wall_ms', 'api_ms', 'other_ms']);
});

test('REG: old run-log readers parse a file with the new events (optional fields only)', (t) => {
  const f = repo(t, scrum202Rows());
  const s = f.cli(runLog, 'summary', '--repo', f.root, '--ticket', TICKET);
  assert.equal(s.status, 0, s.stderr);
  const out = JSON.parse(s.stdout);
  assert.deepEqual(out.integrity_warnings, []);
  assert.equal(out.runs.length, 2);
  assert.equal(out.schema, 'ship-ticket-run-summary-v2');
});

test('the event command validates reserved names and writes a droppable start/end pair', (t) => {
  const f = repo(t);
  const base = ['event', '--repo', f.root, '--ticket', TICKET, '--run-id', 'r1'];
  assert.equal(f.cli(runLog, ...base, '--name', 'not_an_event', '--event-id', 'e1').status, 1);
  const ok = f.cli(runLog, ...base, '--name', 'gate_run', '--event-id', 'g1', '--metric', 'n=1', '--metric', 'head_sha=abc', '--metric', 'clean=true',
    '--detail', JSON.stringify({ per_gate: [{ name: 'lint', ms: 10, exit: 0, key: 'k1' }] }), '--started-at', '2026-11-16T19:00:00+02:00', '--ended-at', '2026-11-16T17:00:30Z');
  assert.equal(ok.status, 0, ok.stderr);
  const rows = readFileSync(f.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].duration_ms, 30000);
  assert.deepEqual(rows[1].detail.per_gate[0].key, 'k1');
  assert.equal(f.cli(runLog, ...base, '--name', 'gate_run', '--event-id', 'g2', '--detail', '{"per_gate":"x"}').status, 1);
});

test('relay import carries exit and token usage only when the result has them (absent stays absent)', (t) => {
  for (const [withExtras, label] of [[true, 'present'], [false, 'absent']]) {
    const f = repo(t);
    const args = ['--repo', f.root, '--ticket', TICKET, '--run-id', 'r1', '--kind', 'activity', '--name', 'contract_review', '--event-id', `rv-${label}`];
    const resultPath = join(f.root, 'result.json');
    const start = f.cli(runLog, 'start', ...args, '--carrier-result', resultPath, '--metric', 'candidate_id=c1', '--metric', 'review_execution=review-1');
    assert.equal(start.status, 0, start.stderr);
    const stamp = JSON.parse(start.stdout).timestamp;
    writeFileSync(resultPath, JSON.stringify({ schema: 'delegate-relay.result.v1', tool: 'claude', readOnly: true, workdir: f.root, status: 'completed', startedAt: stamp, finishedAt: stamp,
      ...(withExtras ? { exitCode: 0, usage: { input_tokens: 10, output_tokens: 5, secret_field: 'x' } } : {}) }));
    const end = f.cli(runLog, 'end', ...args, '--carrier-result', resultPath);
    assert.equal(end.status, 0, end.stderr);
    const timing = JSON.parse(end.stdout).carrier_timing;
    if (withExtras) assert.deepEqual([timing.exit, timing.usage], [0, { input_tokens: 10, output_tokens: 5 }]);
    else assert.deepEqual([Object.hasOwn(timing, 'exit'), Object.hasOwn(timing, 'usage')], [false, false]);
  }
});
