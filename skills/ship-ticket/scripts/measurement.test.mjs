// S-04 (ASTF-42): measurement completeness. Fixture: scrum202-fixture.test-helper.mjs (synthetic, derived from the forensic timeline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRun } from './run-summary.mjs';
import { measurementOf, ownerDecisionsFromSession, INPUT_SCOPES, BOOKKEEPING, SCOPE_OF_KIND, SCOPES, resolve } from './measure.mjs';
import { REVIEW_ROLE_OF } from './review-intervals.mjs';
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
  for (const [ticket, outcome] of [['T-ok', 'complete'], ['T-fail', 'fail'], ['T-aband', 'abandoned'], ['T-open', 'open']]) {
    rows.push(...wf(ticket, `run-${ticket}`, outcome), ...mode(ticket, `run-${ticket}`),
      ...pair(`run-${ticket}`, 'activity', 'measurement_complete', day('10'), day('10'), { scopes: 'review,usage' }).map((r) => ({ ...r, ticket })));
  }
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

// ======================= repair batch 1 (review S-04 b280c79) =======================
const D = (h, m = 0, sec = 0) => `2026-11-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000Z`;
const asTicket = (rows, ticket = TICKET) => rows.map((r) => ({ ...r, ticket }));
const ev = (run, name, at, to, metrics, outcome = 'complete', detail) => asTicket(pair(run, name === 'owner_decision' || name === 'host_sleep' ? 'wait' : 'activity', name, at, to, metrics, outcome, detail));
const mode = (run, m, extra = {}) => ev(run, 'run_mode', D(10), D(10), { mode: m, ...extra });
const wf = (run, out = 'complete') => asTicket(pair(run, 'workflow', 'ship-ticket', D(10), D(20), {}, out));
// every run declares for itself (round 4): the declaration goes on r1 and r2
const done = (scopes) => [...ev('r1', 'measurement_complete', D(20), D(20), { scopes }), ...ev('r2', 'measurement_complete', D(20), D(20), { scopes })];

test('FIX1: events of different runs never collapse; a recovery run numbering from 1 adds, repeats without a round all count', () => {
  const gate = (run, n, h) => ev(run, 'gate_run', D(h), D(h, 10), { n, head_sha: `h${n}`, clean: true, t0_class: false }, 'pass');
  const round = (run, n, lane) => ev(run, 'review_round', D(11), D(12), { n, round_kind: 'original', lane, verdict: 'PASS', majors: 0, minors: 0 });
  const rows = [...wf('r1', 'abandoned'), ...mode('r1', 'engine'), ...gate('r1', 1, 10), ...gate('r1', 2, 11), ...round('r1', 1, 'opus'),
    ...wf('r2'), ...mode('r2', 'recovery', { supersedes_run_id: 'r1' }), ...gate('r2', 1, 12), ...gate('r2', 2, 13), ...round('r2', 1, 'opus'), ...round('r2', 1, 'codex'),
    ...ev('r2', 'finding', D(12), D(12), { fingerprint: 'fp', repeat: true, severity: 'Major' }), ...ev('r2', 'finding', D(13), D(13), { fingerprint: 'fp', repeat: true, severity: 'Major' }),
    ...ev('r2', 'finding', D(11), D(11), { fingerprint: 'fp', repeat: false, severity: 'Major' })];
  const m = measure([...rows, ...done('gate,findings')]);
  assert.equal(m.tickets[TICKET].counts.gate_runs, 4);
  assert.equal(m.metrics.M2.repeat_findings, 2);
  assert.equal(m.metrics.M2.value, 1);
  // one run that resumed in place: engine and recovery run_mode of the SAME run id both count
  const same = measure([...wf('r1'), ...mode('r1', 'engine'), ...ev('r1', 'run_mode', D(15), D(15), { mode: 'recovery' })]);
  assert.deepEqual(same.populations.run_modes, { engine: 1, recovery: 1 });
});

test('FIX2: an estimated round or gate prints estimated in M1, M4 and M7', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...done('review,repair,gate'),
    ...ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0, label: 'estimated' }),
    ...ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane: 'codex', verdict: 'PASS', majors: 0 }),
    ...ev('r1', 'gate_run', D(13), D(14), { n: 1, head_sha: 'h', clean: true, t0_class: false, label: 'estimated' }, 'pass')];
  const { M1, M4, M7 } = measure(rows).metrics;
  assert.deepEqual([M1.label, M4.label, M7.label], ['estimated', 'estimated', 'estimated']);
});

test('FIX3a: a ticket that only declared its run mode has unavailable rounds, not 0 within target; a declared scope makes 0 real', () => {
  const only = measure([...wf('r1'), ...mode('r1', 'engine')]);
  assert.equal(only.metrics.M4.value[TICKET].rounds, 'unavailable');
  assert.equal(only.metrics.M4.value[TICKET].batches, 'unavailable');
  assert.equal(only.metrics.M4.tickets_within_target, 'unavailable'); // attainment needs both scopes (round 3)
  assert.equal(only.metrics.M4.of, 0);
  const declared = measure([...wf('r1'), ...mode('r1', 'engine'), ...done('review,repair')]);
  assert.equal(declared.metrics.M4.value[TICKET].rounds, 0);
  assert.equal(declared.metrics.M4.of, 1);
});

test('FIX3b/c: missing waits, sleep, reconcile, holds, durations and t0 class are unavailable, never 0', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'),
    ...asTicket(pair('r1', 'phase', 'PLAN', D(10), D(11))), ...asTicket(pair('r1', 'phase', 'SHIP', D(18), D(20))),
    ...ev('r1', 'review_round', D(12), D(12), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }),
    ...ev('r1', 'gate_run', D(13), D(13), { n: 1, head_sha: 'h', clean: true }, 'fail')];
  const m = measure(rows).metrics;
  const b = m.M5.value[TICKET].M5b;
  assert.equal(b.host_sleep_ms, 'unavailable');
  assert.equal(b.human_wait_ms, 'unavailable');
  assert.equal(b.awake_ms_with_wait, 'unavailable');
  assert.equal(b.elapsed_ms, 36000000);
  const six = m.M6.value[TICKET];
  assert.deepEqual([six.review_rounds_ms, six.reconcile_ms, six.gate_hold_ms, six.critical_path_ms], ['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  const seven = m.M7.value[TICKET];
  assert.deepEqual([seven.t2_wall_ms, seven.t0_class_failures], ['unavailable', 'unavailable']);
});

test('FIX3d: M8 never reports Claude as not used or a numeric total for an undeclared population; state usage is read; predecessor cost is failed/abandoned', () => {
  const rows = [...wf('r1', 'abandoned'), ...mode('r1', 'engine'), ...wf('r2'), ...mode('r2', 'supervised', { supersedes_run_id: 'r1' })];
  const rec = (run, usd) => ({ provider: 'claude', run_id: run, role: 'builder', source_execution_id: `e-${run}`, input_tokens: 1, reported_cost_usd: usd, cost_basis: 'list' });
  assert.equal(measure(rows).metrics.M8.value.claude.usd, 'unavailable');
  const partial = measure(rows, [rec('r1', 4), rec('r2', 6)]).metrics.M8.value;
  assert.match(String(partial.total_usd), /^unavailable: usage population not declared complete/);
  // undeclared usage: costs are not monotone (a record can replace another, round 4), so no bound is printed
  assert.deepEqual([partial.delivered_claude_usd, partial.failed_or_abandoned_claude_usd, partial.claude.measured_usd], ['unavailable', 'unavailable', 'unavailable']);
  // "Codex not used" needs the review lanes recorded too (round 4)
  const full = measure([...rows, ...done('usage,review')], [rec('r1', 4), rec('r2', 6)]).metrics.M8.value;
  assert.equal(full.total_usd, 10);
  assert.deepEqual([full.delivered_claude_usd, full.failed_or_abandoned_claude_usd], [6, 4]);
  assert.equal(full.codex.usd, 'not_used');
  // eval joins the engine state's own usage records
  const runs = runsOf([...rows, ...done('usage,review')]);
  const out = evaluate({ runs, states: { [TICKET]: { run_id: 'r2', usage: [rec('r2', 6)] } }, records: [] });
  assert.equal(out.measurement.metrics.M8.value.claude.usd, 6);
});

test('FIX4: M3 counts every severity; one unclassified finding keeps it partial', () => {
  const f = (fp, sev, catchable) => ev('r1', 'finding', D(11), D(11), { fingerprint: fp, repeat: false, severity: sev, ...(catchable === undefined ? {} : { builder_catchable: catchable }) });
  const all = measure([...wf('r1'), ...mode('r1', 'engine'), ...done('findings'), ...f('a', 'Major', true), ...f('b', 'Minor', true), ...f('c', 'Minor', false)]).metrics.M3;
  assert.equal(all.value, 2);
  const partial = measure([...wf('r1'), ...mode('r1', 'engine'), ...done('findings'), ...f('a', 'Major', true), ...f('b', 'Minor')]).metrics.M3;
  assert.equal(partial.value, 'partial');
  assert.equal(partial.unclassified, 1);
  assert.equal(partial.catchable_known, 1);
});

test('FIX5: M5 names its endpoint substitutions and is estimated; a missing endpoint is unavailable and named', () => {
  const full = measure(scrum202Rows(), scrum202Usage()).metrics.M5.value[TICKET];
  assert.equal(full.M5a.label, 'estimated');
  assert.match(full.M5a.substitutions.join(' '), /SHIP_READY/);
  assert.match(full.M5b.substitutions.join(' '), /merge/);
  const none = measure([...wf('r1'), ...mode('r1', 'engine')]).metrics.M5.value[TICKET];
  assert.equal(none.M5a.value, 'unavailable');
  assert.match(none.M5a.missing.join(' '), /plan approval/);
});

test('FIX6: M6 starts at the earliest dispatch of ALL lanes and ends at the last REQUIRED result', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...ev('r1', 'measurement_complete', D(20), D(20), { scopes: 'review' }),
    ...ev('r1', 'review_round', D(11), D(11, 30), { n: 1, round_kind: 'original', lane: 'optional', verdict: 'PASS', majors: 0, required: false }),
    ...ev('r1', 'review_round', D(11, 10), D(11, 20), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 })];
  assert.equal(measure(rows).metrics.M6.value[TICKET].review_rounds_ms, 20 * 60000);
});

test('FIX8: AskUserQuestion and ExitPlanMode answers are owner decisions; handbacks and other tool results are not', () => {
  const ts = (min) => `2026-11-16T10:${String(min).padStart(2, '0')}:00.000Z`;
  const L = [
    { type: 'assistant', timestamp: ts(1), message: { id: 'a1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-ask', name: 'AskUserQuestion', input: {} }] } },
    { type: 'user', uuid: 'u1', timestamp: ts(4), toolUseResult: { answers: {} }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-ask', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(5), message: { id: 'a2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-plan', name: 'ExitPlanMode', input: {} }] } },
    { type: 'user', uuid: 'u2', timestamp: ts(9), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-plan', content: 'approved' }] } },
    { type: 'assistant', timestamp: ts(10), message: { id: 'a3', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'u3', timestamp: ts(11), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'x' }] } },
    { type: 'assistant', timestamp: ts(12), message: { id: 'a4', stop_reason: 'end_turn', content: [] } },
    { type: 'user', uuid: 'u4', timestamp: ts(13), message: { role: 'user', content: 'Another Claude session sent a message: handback' } }];
  const w = ownerDecisionsFromSession(L.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(w.map((x) => [x.decision_class, x.wait_ms]), [['ask_user_question', 180000], ['plan_approval', 240000]]);
});

test('FIX9: a round whose REVIEW phase is still open (no open activity) stays out of the percentiles', () => {
  const mk = (n, openPhase) => {
    const base = { candidate_id: 'c', review_execution: `review-${n}` };
    const day = `2026-11-16T${String(10 + n).padStart(2, '0')}`;
    const rows = [...pair(`r${n}`, 'activity', 'primary_review', `${day}:00:00.000Z`, `${day}:10:00.000Z`, base), ...pair(`r${n}`, 'activity', 'optional_review', `${day}:00:00.000Z`, `${day}:10:00.000Z`, base),
      ...pair(`r${n}`, 'activity', 'review_reconcile', `${day}:10:00.000Z`, `${day}:11:00.000Z`, base)];
    if (openPhase) rows.push({ ...pair(`r${n}`, 'phase', 'REVIEW', `${day}:00:00.000Z`, `${day}:30:00.000Z`, base)[0] });
    return buildRun(TICKET, `r${n}`, asTicket(rows));
  };
  const out = evaluate({ runs: [1, 2, 3, 4, 5].map((n) => mk(n, n === 5)) });
  assert.equal(out.cross_run.review_round_wall_ms.n, 4);
  assert.equal(out.cross_run.review_round_wall_ms.excluded_unknown, 1);
});

test('FIX7: run-engine resume appends a run_mode recovery event; a telemetry failure never fails resume', async (t) => {
  const { fixture } = await import('./engine-test-fixture.mjs');
  const fx = fixture(t, { commit: true });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const r = fx.cli('resume');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = readFileSync(fx.runLog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.event, x.name, x.metrics.mode ?? null]), [['start', 'run_mode', 'recovery'], ['end', 'run_mode', null]]);
  // telemetry failure: the run log path is a directory, so the helper cannot append
  const fx2 = fixture(t, { commit: true });
  assert.equal(fx2.cli('init', { dag: fx2.dagFile }).status, 0);
  mkdirSync(fx2.runLog(), { recursive: true });
  const r2 = fx2.cli('resume');
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stderr, /telemetry/);
  assert.ok(JSON.parse(readFileSync(fx2.stateFile(), 'utf8')).events.some((e) => e.type === 'RESUME'));
});

// ======================= repair batch 2 (confirmation review of 2c196a3) =======================
test('FIX1b: an identical repeat re-emitted under a new event id collapses; distinct repeats stay distinct', () => {
  const rep = (id, at) => asTicket(pair('r1', 'activity', 'finding', at, at, { fingerprint: 'fp', repeat: true, severity: 'Major' }).map((r) => ({ ...r, event_id: id })));
  const base = [...wf('r1'), ...mode('r1', 'engine'), ...done('findings')].map((r) => ({ ...r }));
  const same = measure([...base, ...rep('a', D(11)), ...rep('b', D(11))]);
  assert.equal(same.metrics.M2.repeat_findings, 1);
  assert.equal(measure([...base, ...rep('a', D(11)), ...rep('b', D(12))]).metrics.M2.repeat_findings, 2);
});

test('FIX2b: an estimated confirmation or finding makes M4 estimated', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...done('review,repair'),
    ...ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }),
    ...ev('r1', 'confirmation', D(13), D(13), { n: 2, label: 'estimated' })];
  assert.equal(measure(rows).metrics.M4.label, 'estimated');
});

test('FIX3: a partial history is a lower bound, never target attainment or a full deduction', () => {
  const rows = [...asTicket(pair('r1', 'phase', 'PLAN', D(10), D(11))), ...asTicket(pair('r1', 'phase', 'SHIP', D(18), D(20))), ...wf('r1'), ...mode('r1', 'engine'),
    ...ev('r1', 'review_round', D(12), D(13), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }),
    ...ev('r1', 'repair_batch', D(13), D(14), { n: 1 }), ...ev('r1', 'owner_decision', D(15), D(16), { n: 1 }), ...ev('r1', 'host_sleep', D(16), D(17), {}),
    ...ev('r1', 'finding', D(12), D(12), { fingerprint: 'a', repeat: false, severity: 'Major', builder_catchable: true })];
  const m = measure(rows).metrics;
  assert.deepEqual(m.M4.value[TICKET].rounds, { at_least: 1 });
  assert.equal(m.M4.tickets_within_target, 'unavailable');
  assert.equal(m.M4.of, 0);
  assert.equal(m.M4.label, 'estimated');
  const b = m.M5.value[TICKET].M5b;
  // human wait needs the sleep scope too: an unrecorded overlapping sleep could make it 0 (round 3, Codex-3)
  assert.deepEqual([b.human_wait_ms, b.host_sleep_ms], ['unavailable', { at_least: 3600000 }]);
  assert.deepEqual([b.awake_ms_with_wait, b.awake_ms_excluding_wait], ['unavailable', 'unavailable']);
  assert.deepEqual(m.M2.value, { at_least: 1 });
  assert.equal(m.M2.label, 'estimated');
  // the same history with the scopes declared is exact and measured
  const full = measure([...rows, ...ev('r1', 'measurement_complete', D(20), D(20), { scopes: 'review,repair,owner,sleep,findings' })]).metrics;
  assert.equal(full.M4.value[TICKET].rounds, 1);
  assert.deepEqual([full.M4.tickets_within_target, full.M4.of], [1, 1]);
  assert.equal(full.M5.value[TICKET].M5b.human_wait_ms, 3600000);
  assert.equal(full.M2.value, 1);
});

test('FIX4b: a ticket with no recorded review is unavailable for M1, not a measured failure', () => {
  const m = measure([...wf('r1', 'fail'), ...mode('r1', 'engine')]).metrics.M1;
  assert.equal(m.value, 'unavailable');
  assert.equal(m.label, 'unavailable');
  assert.equal(m.unrecorded_reviews, 1);
  assert.equal(m.denominator, 1); // H: the denominator is every started ticket, failed ones included (round 3)
});

// ======================= repair batch 3 (round-3 review of b517eba): one completeness rule =======================
const measureAll = (rows, records = []) => measurementOf([...new Set(rows.map((r) => r.run_id))].map((id) => buildRun(rows.find((r) => r.run_id === id).ticket, id, rows.filter((r) => r.run_id === id))), { records, now: NOW });
const declare = (run, scopes, ticket = TICKET) => asTicket(pair(run, 'activity', 'measurement_complete', D(20), D(20), { scopes }), ticket);
const lanePass = (run, ticket, n = 1) => ['opus', 'codex'].flatMap((lane) => asTicket(pair(run, 'activity', 'review_round', D(11), D(12), { n, round_kind: 'original', lane, verdict: 'PASS', majors: 0 }), ticket));

test('R3-MAJ1: M1 keeps failed-before-review tickets in the denominator; an undeclared review population is never measured', () => {
  const base = [...asTicket(pair('a1', 'workflow', 'ship-ticket', D(10), D(20), {}, 'complete'), 'T-ok'), ...asTicket(pair('a1', 'activity', 'run_mode', D(10), D(10), { mode: 'engine' }), 'T-ok'), ...lanePass('a1', 'T-ok'),
    ...asTicket(pair('b1', 'workflow', 'ship-ticket', D(10), D(20), {}, 'fail'), 'T-fail'), ...asTicket(pair('b1', 'activity', 'run_mode', D(10), D(10), { mode: 'engine' }), 'T-fail')];
  const m1 = measureAll(base).metrics.M1;
  assert.notEqual(m1.label, 'measured');
  assert.equal(m1.value, 'unavailable');
  assert.deepEqual([m1.denominator, m1.unrecorded_reviews, m1.undeclared_review_tickets], [2, 1, 1]);
  assert.deepEqual(m1.started_by_status, { delivered: 1, failed: 1, abandoned: 0, censored: 0 });
  const full = measureAll([...base, ...declare('a1', 'review', 'T-ok'), ...declare('b1', 'review', 'T-fail')]).metrics.M1;
  assert.deepEqual([full.value, full.numerator, full.denominator, full.label], [0.5, 1, 2, 'measured']);
});

test('R3-MAJ2: one logged gate run of three, or an observed reconcile/hold, is a lower bound, never measured zero failures', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'),
    ...ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }),
    ...ev('r1', 'review_reconcile', D(12), D(12, 10), { candidate_id: 'c', review_execution: 'review-1' }),
    ...ev('r1', 'gate_run', D(13), D(13, 10), { n: 1, head_sha: 'h', clean: true, holds_review: true, hold_ms: 60000 }, 'pass')];
  const m = measure(rows).metrics;
  const g = m.M7.value[TICKET];
  assert.deepEqual(g.t2_runs, { at_least: 1 });
  assert.deepEqual(g.t2_wall_ms, { at_least: 600000 });
  assert.equal(g.failed_runs, 'unavailable');
  assert.notEqual(m.M7.label, 'measured');
  const six = m.M6.value[TICKET];
  assert.deepEqual([six.reconcile_ms, six.gate_hold_ms], [{ at_least: 600000 }, { at_least: 60000 }]);
  assert.notEqual(six.label, 'measured');
});

test('R3-MAJ3: M4 repeat findings follow the findings scope; a standalone confirmation lower bound makes M4 estimated', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'review,repair'),
    ...ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }),
    ...ev('r1', 'finding', D(12), D(12), { fingerprint: 'fp', repeat: true, severity: 'Major', round: 1 })];
  const m4 = measure(rows).metrics.M4;
  assert.deepEqual(m4.value[TICKET].repeat_findings, { at_least: 1 });
  assert.equal(m4.label, 'estimated');
  const conf = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'review'),
    ...ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }), ...ev('r1', 'confirmation', D(13), D(13), { n: 2 })]).metrics.M4;
  assert.deepEqual(conf.value[TICKET].confirmations, { at_least: 1 });
  assert.equal(conf.label, 'estimated');
});

test('R3-Codex3: human wait needs the sleep scope too: unrecorded overlapping sleep could make it zero', () => {
  const rows = [...asTicket(pair('r1', 'phase', 'PLAN', D(10), D(11))), ...asTicket(pair('r1', 'phase', 'SHIP', D(18), D(20))), ...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'owner'),
    ...ev('r1', 'owner_decision', D(15), D(16), { n: 1 })];
  const b = measure(rows).metrics.M5.value[TICKET].M5b;
  assert.equal(b.human_wait_ms, 'unavailable');
  const withSleep = measure([...rows, ...declare('r1', 'sleep')]).metrics.M5.value[TICKET].M5b;
  assert.equal(withSleep.human_wait_ms, 3600000);
});

test('R3-minors: findings declared with none recorded is 0; occurrence tells repeats apart; owner waits of two sessions both count', () => {
  const none = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'findings')]).metrics.M2;
  assert.deepEqual([none.value, none.label], [0, 'measured']);
  const rep = (id, occurrence) => asTicket(pair('r1', 'activity', 'finding', D(11), D(11), { fingerprint: 'fp', repeat: true, severity: 'Major', ...(occurrence === undefined ? {} : { occurrence }) }).map((r) => ({ ...r, event_id: id })));
  const base = [...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'findings')];
  assert.equal(measure([...base, ...rep('a', 1), ...rep('b', 2)]).metrics.M2.repeat_findings, 2);
  assert.equal(measure([...base, ...rep('a', 1), ...rep('b', 1)]).metrics.M2.repeat_findings, 1);
  const waits = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'owner'), ...ev('r1', 'owner_decision', D(11), D(12), { n: 1 }), ...ev('r1', 'owner_decision', D(14), D(15), { n: 1 })]);
  assert.equal(waits.tickets[TICKET].counts.owner_waits, 2);
});

// ---- generic: every registered value obeys the one completeness rule ----
const ALL_SCOPES = 'review,repair,gate,owner,sleep,findings,usage';
/** Three tickets with every kind recorded, every event measured, every scope declared: T-A delivered after a superseded run, T-B censored, T-C delivered. */
function fullHistory() {
  const at = (ticket, run, kind, name, from, to, metrics = {}, outcome = 'complete', detail) => asTicket(pair(run, kind, name, from, to, metrics, outcome, detail), ticket);
  const act = (ticket, run, name, from, to, metrics, outcome, detail) => at(ticket, run, 'activity', name, from, to, metrics, outcome, detail);
  const round = (ticket, run, n, kind, lane, from, to, verdict = 'PASS', majors = 0) => act(ticket, run, 'review_round', from, to, { n, round_kind: kind, lane, verdict, majors, minors: 0 });
  const decl = (ticket, run, at = D(20)) => act(ticket, run, 'measurement_complete', at, at, { scopes: ALL_SCOPES });
  const finding = (from, metrics) => act('T-A', 'a1', 'finding', from, from, { severity: 'Major', repeat: false, builder_catchable: true, ...metrics });
  const rows = [
    ...at('T-A', 'a0', 'workflow', 'ship-ticket', D(9), D(10), {}, 'abandoned'), ...act('T-A', 'a0', 'run_mode', D(9), D(9), { mode: 'engine' }), ...decl('T-A', 'a0', D(10)),
    ...at('T-A', 'a1', 'workflow', 'ship-ticket', D(10), D(20), {}, 'complete'), ...act('T-A', 'a1', 'run_mode', D(10), D(10), { mode: 'supervised', supersedes_run_id: 'a0' }),
    ...at('T-A', 'a1', 'phase', 'PLAN', D(10), D(11)), ...at('T-A', 'a1', 'phase', 'SHIP', D(18), D(20)), ...decl('T-A', 'a1'),
    ...round('T-A', 'a1', 1, 'original', 'opus', D(11), D(12)), ...round('T-A', 'a1', 1, 'original', 'codex', D(11, 5), D(12, 10)),
    ...round('T-A', 'a1', 3, 'confirmation', 'opus', D(14), D(14, 20)), ...round('T-A', 'a1', 4, 'final', 'opus', D(14, 30), D(14, 40)),
    ...act('T-A', 'a1', 'review_reconcile', D(12, 30), D(12, 40), { candidate_id: 'c1', review_execution: 'review-1' }),
    ...act('T-A', 'a1', 'repair_batch', D(13), D(13, 30), { n: 1 }), ...act('T-A', 'a1', 'confirmation', D(13, 40), D(13, 40), { n: 2 }),
    ...act('T-A', 'a1', 'gate_run', D(15), D(15, 10), { n: 1, head_sha: 'h1', clean: false, t0_class: true, holds_review: true, hold_ms: 300000 }, 'fail',
      { per_gate: [{ name: 'lint', ms: 1000, exit: 1, key: 'k1' }, { name: 'test', ms: 2000, exit: 0, key: 'k2' }] }),
    ...act('T-A', 'a1', 'gate_run', D(15, 20), D(15, 30), { n: 2, head_sha: 'h2', clean: true }, 'pass', { per_gate: [{ name: 'test', ms: 2000, exit: 0, key: 'k2' }] }),
    ...at('T-A', 'a1', 'wait', 'owner_decision', D(16), D(17), { n: 1 }), ...at('T-A', 'a1', 'wait', 'host_sleep', D(16, 30), D(17, 30), { gap_reason: 'host_sleep' }),
    ...finding(D(12), { fingerprint: 'fp1', round: 1 }), ...finding(D(14, 20), { fingerprint: 'fp1', repeat: true, round: 3 }),
    ...finding(D(14, 40), { fingerprint: 'fp2', severity: 'Low', deferred: true, builder_catchable: false, round: 4 }),
    pair('b1', 'workflow', 'ship-ticket', D(10), D(20))[0], ...act('T-B', 'b1', 'run_mode', D(10), D(10), { mode: 'engine' }), ...decl('T-B', 'b1'),
    ...round('T-B', 'b1', 1, 'original', 'opus', D(11), D(12), 'FAIL', 1), ...act('T-B', 'b1', 'repair_batch', D(13), D(13, 10), { n: 1 }), ...act('T-B', 'b1', 'repair_batch', D(13, 20), D(13, 30), { n: 2 }),
    ...at('T-C', 'c1', 'workflow', 'ship-ticket', D(10), D(20), {}, 'complete'), ...act('T-C', 'c1', 'run_mode', D(10), D(10), { mode: 'engine' }), ...decl('T-C', 'c1'),
    ...round('T-C', 'c1', 1, 'original', 'opus', D(11), D(12)), ...round('T-C', 'c1', 1, 'original', 'codex', D(11), D(12))];
  rows.filter((r) => r.run_id === 'b1').forEach((r) => { r.ticket = 'T-B'; });
  const rec = (provider, run_id, usd) => ({ provider, run_id, role: 'builder', source_execution_id: `${provider}-${run_id}`, input_tokens: 1, reported_cost_usd: usd, cost_basis: 'list' });
  return { rows, records: [rec('claude', 'a1', 5), rec('claude', 'a0', 2), rec('claude', 'b1', 1), rec('claude', 'c1', 3), rec('codex', 'a1', 1), rec('codex', 'a0', 1)] };
}
const MAIN = 'T-A';
const isBound = (v) => v !== null && typeof v === 'object' && typeof v.at_least === 'number';
const isUnavailable = (v) => typeof v === 'string' && /unavailable/.test(v);
const get = (o, segs) => segs.reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);
/** Leaves of `out` at a registered path template (`{ticket}` bound to `ticket`, `*` any key), with the label printed for each. */
function leavesAt(out, key, ticket = MAIN) {
  const { path, label } = INPUT_SCOPES[key];
  const found = [];
  const walk = (node, segs, i, binds) => {
    if (i === segs.length) { if (node !== undefined) found.push({ value: node, binds }); return; }
    if (node === null || typeof node !== 'object') return;
    const s = segs[i];
    const keys = s === '*' ? Object.keys(node) : [s === '{ticket}' ? ticket : s];
    for (const k of keys) walk(node[k], segs, i + 1, s === '*' || s === '{ticket}' ? [...binds, k] : binds);
  };
  walk(out, path.split('.'), 0, []);
  return found.map(({ value, binds }) => { let n = 0; return { value, label: get(out, label.split('.').map((s) => (s === '*' || s === '{ticket}' ? binds[n++] : s))) }; });
}
const measureFull = ({ rows, records }) => measureAll(rows, records);
const dropScope = (h, scope, tickets) => ({ ...h, rows: h.rows.flatMap((r) => {
  if (r.name !== 'measurement_complete' || (tickets && !tickets.includes(r.ticket)) || r.event !== 'start') return [r];
  const left = r.metrics.scopes.split(',').filter((x) => x !== scope).join(',');
  return [{ ...r, metrics: { ...r.metrics, scopes: left } }];
}).filter((r) => r.name !== 'measurement_complete' || r.event !== 'start' || r.metrics.scopes !== '') });
const dropKind = (h, kind) => (kind === 'usage' ? { ...h, records: [] }
  : { ...h, rows: h.rows.filter((r) => (kind === 'reconcile' ? REVIEW_ROLE_OF[r.name] !== 'reconcile' : r.name !== kind)) });
const requiredScopes = (s) => [...new Set([...Object.keys(s.scopes), ...s.kinds.filter((k) => !(s.degrade_only ?? []).includes(k)).map((k) => SCOPE_OF_KIND[k]).filter(Boolean)])];
// 0 by construction in an all-measured, all-classified history: every finding is classified; every usage record is list-priced (measured)
const ZERO_IN_FULL = new Set(['M3.unclassified', 'M8.provider_estimated_usd']);

test('PROP: the input table is consistent: each kind it reads is covered by a declared scope', () => {
  assert.deepEqual([...new Set(Object.values(SCOPE_OF_KIND).filter(Boolean))].sort(), [...SCOPES].sort());
  for (const [key, s] of Object.entries(INPUT_SCOPES)) {
    if (key !== 'M10.value') assert.ok(s.kinds.length > 0, `${key} reads nothing`);
    for (const k of s.kinds) assert.ok(Object.hasOwn(SCOPE_OF_KIND, k), `${key}: unknown kind ${k}`);
    for (const k of s.kinds.filter((x) => !(s.degrade_only ?? []).includes(x))) {
      if (SCOPE_OF_KIND[k]) assert.ok(Object.hasOwn(s.scopes, SCOPE_OF_KIND[k]), `${key} reads ${k} but does not require scope ${SCOPE_OF_KIND[k]}`);
    }
    for (const p of Object.values(s.scopes)) assert.ok(['lower', 'none'].includes(p), `${key}: polarity ${p}`);
  }
  assert.throws(() => resolve('M99.value', [], 1), /not registered/);
});

test('PROP: every number the measurement prints is registered (a new metric cannot bypass the table)', () => {
  const outputs = [measureFull(fullHistory()), measure(scrum202Rows(), scrum202Usage()), measureFull(dropScope(fullHistory(), 'gate')), measureFull(dropScope(fullHistory(), 'usage'))];
  const templates = [...Object.values(INPUT_SCOPES).map((s) => s.path), ...Object.keys(BOOKKEEPING)].map((t) => t.split('.'));
  let checked = 0;
  for (const out of outputs) {
    const ids = new Set(Object.keys(out.tickets));
    const match = (segs) => templates.some((t) => t.length === segs.length && t.every((s, i) => s === '*' || (s === '{ticket}' ? ids.has(segs[i]) : s === segs[i])));
    const walk = (node, segs) => {
      if (typeof node === 'number' || isBound(node)) { checked += 1; assert.ok(match(segs), `unregistered number at ${segs.join('.')}`); return; }
      if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...segs, k]);
    };
    for (const part of ['populations', 'tickets', 'metrics']) walk(out[part], [part]);
  }
  assert.ok(checked > 100, `walked ${checked} numbers`);
});

test('PROP: per registered value: full history is exact at its ceiling label; a dropped scope is never a bare or measured number; dropped events change it', () => {
  const h = fullHistory();
  const full = measureFull(h);
  const pct = { exact: 0, dropped: 0, kinds: 0 };
  for (const [key, s] of Object.entries(INPUT_SCOPES)) {
    const base = leavesAt(full, key);
    // (a) full history, every scope declared
    if (s.ceiling === 'unavailable') { assert.ok(base.every((l) => isUnavailable(l.value)), key); continue; }
    assert.ok(base.length > 0, `${key}: nothing printed for the full history`);
    for (const l of base) {
      assert.equal(typeof l.value, 'number', `${key}: full history is not exact (${JSON.stringify(l.value)})`);
      assert.equal(l.label, s.ceiling, `${key}: label`);
    }
    if (!ZERO_IN_FULL.has(key)) assert.ok(base.some((l) => l.value > 0), `${key}: full-history value is 0, so dropped events could not show`);
    pct.exact += 1;
    // (b) each required scope dropped, on every ticket and on the measured ticket alone
    for (const scope of requiredScopes(s)) {
      for (const only of [undefined, [MAIN]]) {
        for (const l of leavesAt(measureFull(dropScope(h, scope, only)), key)) {
          assert.notEqual(typeof l.value, 'number', `${key} without ${scope}${only ? ' (one ticket)' : ''} printed a bare number ${l.value}`);
          assert.ok(isBound(l.value) || isUnavailable(l.value), `${key} without ${scope}: ${JSON.stringify(l.value)}`);
          if (isBound(l.value)) assert.notEqual(l.label, 'measured', `${key} without ${scope}: lower bound labelled measured`);
          if (s.scopes[scope] === 'none') assert.ok(isUnavailable(l.value), `${key} without ${scope} (no bound exists): ${JSON.stringify(l.value)}`);
        }
        pct.dropped += 1;
      }
    }
    // (c) each scoped kind's events removed while the scopes stay declared
    for (const kind of s.kinds.filter((k) => SCOPE_OF_KIND[k] && !(s.degrade_only ?? []).includes(k))) {
      const after = leavesAt(measureFull(dropKind(h, kind)), key);
      const same = JSON.stringify(after.map((l) => l.value)) === JSON.stringify(base.map((l) => l.value));
      assert.ok(!same || after.every((l) => isUnavailable(l.value)) || ZERO_IN_FULL.has(key), `${key}: removing every ${kind} left ${JSON.stringify(after.map((l) => l.value))}`);
      pct.kinds += 1;
    }
  }
  assert.ok(pct.exact >= 45 && pct.dropped >= 90 && pct.kinds >= 45, JSON.stringify(pct));
});

test('R3: only the head run declares completeness; a superseded run cannot vouch for its successor', () => {
  const rows = [...wf('r1', 'abandoned'), ...mode('r1', 'engine'), ...declare('r1', 'gate'), ...wf('r2'), ...mode('r2', 'recovery', { supersedes_run_id: 'r1' }),
    ...ev('r2', 'gate_run', D(13), D(13, 10), { n: 1, head_sha: 'h', clean: true }, 'pass')];
  assert.deepEqual(measure(rows).metrics.M7.value[TICKET].t2_runs, { at_least: 1 });
  assert.equal(measure([...rows, ...declare('r2', 'gate')]).metrics.M7.value[TICKET].t2_runs, 1);
});

test('R3: the event command accepts occurrence as a positive integer or a short id, and refuses anything else', (t) => {
  const f = repo(t);
  const finding = (id, occ) => f.cli(runLog, 'event', '--repo', f.root, '--ticket', TICKET, '--run-id', 'r1', '--name', 'finding', '--event-id', id,
    '--metric', 'fingerprint=fp', '--metric', 'repeat=true', '--metric', 'severity=Major', '--metric', `occurrence=${occ}`);
  assert.equal(finding('f1', '2').status, 0);
  assert.equal(finding('f2', 'session-b.3').status, 0);
  assert.equal(finding('f3', 'bad id').status, 1);
  assert.equal(finding('f4', '0').status, 1);
  const rows = readFileSync(f.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.event === 'start');
  assert.deepEqual(rows.map((r) => r.metrics.occurrence), [2, 'session-b.3']);
});

// ======================= repair batch 4 (round-4 review of f795093): inputs carry their own truth =======================
const openStart = (run, kind, name, at, metrics, ticket = TICKET) => asTicket([pair(run, kind, name, at, at, metrics)[0]], ticket);
const evalOf = (rows, records = []) => evaluate({ runs: runsOf(rows), records, now: NOW });

test('R4-C1: a reconciliation keeps its own label (estimated stays estimated)', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'review,gate'),
    ...ev('r1', 'review_reconcile', D(12), D(12, 10), { candidate_id: 'c', review_execution: 'review-1', label: 'estimated' })];
  const six = measure(rows).metrics.M6.value[TICKET];
  assert.equal(six.reconcile_ms, 600000);
  assert.equal(six.label, 'estimated');
});

test('R4-C2: an unfinished (open) round, gate or wait is unknown, never a measured 0', () => {
  const rows = [asTicket(pair('r1', 'workflow', 'ship-ticket', D(10), D(20)))[0], ...mode('r1', 'engine'), ...declare('r1', 'review,repair,gate,owner,sleep,findings'),
    ...openStart('r1', 'activity', 'review_round', D(11), { n: 1, round_kind: 'original', lane: 'opus', verdict: 'PASS', majors: 0 }),
    ...openStart('r1', 'activity', 'gate_run', D(12), { n: 1, head_sha: 'h', clean: true }),
    ...openStart('r1', 'wait', 'owner_decision', D(13), { n: 1 })];
  const m = measure(rows);
  const c = m.tickets[TICKET].counts;
  assert.deepEqual([c.review_rounds, c.gate_runs, c.owner_waits], ['unavailable', 'unavailable', 'unavailable']);
  assert.equal(m.metrics.M4.value[TICKET].rounds, 'unavailable');
  assert.equal(m.metrics.M4.tickets_within_target, 'unavailable');
  assert.deepEqual([m.metrics.M6.value[TICKET].review_rounds_ms, m.metrics.M6.value[TICKET].critical_path_ms], ['unavailable', 'unavailable']);
  assert.deepEqual([m.metrics.M7.value[TICKET].t2_runs, m.metrics.M7.value[TICKET].t2_wall_ms], ['unavailable', 'unavailable']);
});

test('R4-C3: a gate hold without hold_ms is unknown, not a measured 0', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'review,gate'),
    ...ev('r1', 'gate_run', D(13), D(13, 10), { n: 1, head_sha: 'h', clean: true, holds_review: true }, 'pass')];
  const six = measure(rows).metrics.M6.value[TICKET];
  assert.deepEqual([six.gate_hold_ms, six.critical_path_ms], ['unavailable', 'unavailable']);
});

test('R4-C4: an unavailable verdict or a PASS without majors makes M1 unavailable, not a measured 0', () => {
  const lanes = (extra) => ['opus', 'codex'].flatMap((lane) => ev('r1', 'review_round', D(11), D(12), { n: 1, round_kind: 'original', lane, ...extra }));
  for (const extra of [{ verdict: 'unavailable' }, { verdict: 'PASS' }]) {
    const m1 = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'review'), ...lanes(extra)]).metrics.M1;
    assert.deepEqual([m1.value, m1.numerator, m1.label], ['unavailable', 'unavailable', 'unavailable'], JSON.stringify(extra));
  }
});

test('R4-C5: provider costs are not monotone (a usage record can replace another), so undeclared usage is unavailable', () => {
  const rows = [...wf('r1'), ...mode('r1', 'engine')];
  const est = { provider: 'claude', run_id: 'r1', role: 'builder', source_execution_id: 'x', input_tokens: 1, estimated_cost_usd: 10 };
  const fuller = { provider: 'claude', run_id: 'r1', role: 'builder', source_execution_id: 'x', input_tokens: 2, reported_cost_usd: 5, cost_basis: 'list' };
  // the counterexample: adding a record lowers the provider cost from 10 to 5
  const one = evaluate({ runs: runsOf(rows), states: { [TICKET]: { run_id: 'r1', usage: [est] } }, now: NOW }).measurement.metrics.M8.value.claude;
  const two = evaluate({ runs: runsOf(rows), states: { [TICKET]: { run_id: 'r1', usage: [est, fuller] } }, now: NOW }).measurement.metrics.M8.value.claude;
  for (const c of [one, two]) assert.deepEqual([c.usd, c.measured_usd, c.estimated_usd], ['unavailable', 'unavailable', 'unavailable']);
  assert.deepEqual(measure(rows, [est]).metrics.M8.value.delivered_claude_usd, 'unavailable');
});

test('R4-C6: an instrumented eval report prints no legacy numbers outside the measurement registry', () => {
  const rows = [...asTicket(pair('r1', 'phase', 'REVIEW', D(11), D(12))), ...wf('r1'), ...mode('r1', 'engine')];
  const out = evalOf(rows, [{ provider: 'claude', run_id: 'r1', role: 'builder', source_execution_id: 'b', input_tokens: 1, reported_cost_usd: 3, cost_basis: 'list' }]);
  assert.ok(out.measurement);
  assert.deepEqual(Object.keys(out.runs[0]).sort(), ['outcome', 'run_id', 'ticket']);
  assert.equal(out.cross_run, undefined);
});

test('R4-C7: re-importing owner waits with an overlapping --since window counts each decision once', () => {
  const at = (m) => `2026-11-16T10:${String(m).padStart(2, '0')}:00.000Z`;
  const L = [{ type: 'assistant', timestamp: at(1), message: { id: 'a1', stop_reason: 'end_turn', content: [] } }, { type: 'user', uuid: 'u1', timestamp: at(3), message: { role: 'user', content: 'yes' } },
    { type: 'assistant', timestamp: at(5), message: { id: 'a2', stop_reason: 'end_turn', content: [] } }, { type: 'user', uuid: 'u2', timestamp: at(9), message: { role: 'user', content: 'go' } }];
  const text = L.map((l) => JSON.stringify(l)).join('\n');
  const first = ownerDecisionsFromSession(text), second = ownerDecisionsFromSession(text, { since: at(4) });
  assert.deepEqual([first.length, second.length, second[0].n], [2, 1, 1]);
  const asEvents = (list, tag) => list.flatMap((w) => ev('r1', 'owner_decision', w.started_at, w.ended_at, { n: w.n, decision_class: w.decision_class, label: w.label }).map((r) => ({ ...r, event_id: `${tag}-${w.n}` })));
  const m = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'owner'), ...asEvents(first, 'a'), ...asEvents(second, 'b')]);
  assert.equal(m.tickets[TICKET].counts.owner_waits, 2);
});

test('R4-O1: Codex is "not used" only when the review lanes were recorded in full too', () => {
  const rec = (usd) => ({ provider: 'claude', run_id: 'r1', role: 'builder', source_execution_id: `c-${usd}`, input_tokens: 1, reported_cost_usd: usd, cost_basis: 'list' });
  const v = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'usage')], [rec(4), rec(6)]).metrics.M8;
  assert.equal(v.value.codex.usd, 'unavailable');
  assert.match(String(v.value.total_usd), /unavailable/);
  assert.notEqual(v.label, 'measured');
  const full = measure([...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'usage,review')], [rec(4), rec(6)]).metrics.M8.value;
  assert.deepEqual([full.codex.usd, full.total_usd], ['not_used', 10]);
});

test('R4-O2: the head run cannot declare a predecessor complete; each run declares for itself', () => {
  const gate = (run, n) => ev(run, 'gate_run', D(13), D(13, 10), { n, head_sha: `h${n}`, clean: true }, 'pass');
  const rows = [...wf('r1', 'abandoned'), ...mode('r1', 'engine'), ...gate('r1', 1), ...wf('r2'), ...mode('r2', 'recovery', { supersedes_run_id: 'r1' }), ...gate('r2', 1), ...declare('r2', 'gate')];
  assert.deepEqual(measure(rows).metrics.M7.value[TICKET].t2_runs, { at_least: 2 });
  assert.equal(measure([...rows, ...declare('r1', 'gate')]).metrics.M7.value[TICKET].t2_runs, 2);
});

test('R4-I: dropped, malformed or conflicting inputs degrade the value; a weak or early declaration declares nothing', () => {
  const base = [...wf('r1'), ...mode('r1', 'engine'), ...declare('r1', 'gate')];
  const gate = (n, extra = {}) => ev('r1', 'gate_run', D(13), D(13, 10), { n, head_sha: `h${n}`, clean: true, ...extra }, 'pass');
  // an invalid gate event (no head_sha) is an unknown gate, not a missing one
  assert.equal(measure([...base, ...gate(1), ...ev('r1', 'gate_run', D(14), D(14, 10), { n: 2, clean: true }, 'pass')]).metrics.M7.value[TICKET].t2_runs, 'unavailable');
  // two copies of one logical gate that disagree are unknown
  const copy = gate(1, { clean: false }).map((r) => ({ ...r, event_id: 'copy' }));
  assert.equal(measure([...base, ...gate(1), ...copy]).metrics.M7.value[TICKET].t2_runs, 'unavailable');
  // the worse label of two identical copies wins
  const est = gate(1, { label: 'estimated' }).map((r) => ({ ...r, event_id: 'copy2' }));
  assert.equal(measure([...base, ...gate(1), ...est]).metrics.M7.label, 'estimated');
  // a declaration labelled estimated, or emitted before later events of its run, declares nothing
  const weak = [...wf('r1'), ...mode('r1', 'engine'), ...ev('r1', 'measurement_complete', D(20), D(20), { scopes: 'gate', label: 'estimated' }), ...gate(1)];
  assert.deepEqual(measure(weak).metrics.M7.value[TICKET].t2_runs, { at_least: 1 });
  const early = [...wf('r1'), ...mode('r1', 'engine'), ...ev('r1', 'measurement_complete', D(10), D(10), { scopes: 'gate' }), ...gate(1)];
  assert.deepEqual(measure(early).metrics.M7.value[TICKET].t2_runs, { at_least: 1 });
});

// ---- generic fuzz: perturbation decides what each printed value depends on (the oracle never reads INPUT_SCOPES' scopes or polarity) ----
const buildAll = (rows) => [...new Set(rows.map((r) => r.run_id))].map((id) => buildRun(rows.find((r) => r.run_id === id).ticket, id, rows.filter((r) => r.run_id === id)));
const report = (rows, records = []) => evaluate({ runs: buildAll(rows), records, now: NOW });
/** Every registered number of a measurement block, by key and position, with the label printed for it (INPUT_SCOPES is used only to find it). */
function printed(m) {
  const out = new Map();
  for (const t of Object.keys(m.tickets)) for (const key of Object.keys(INPUT_SCOPES)) {
    leavesAt(m, key, t).forEach((l, i) => out.set(`${key}|${INPUT_SCOPES[key].path.includes('{ticket}') ? t : '-'}|${i}`, l));
  }
  return out;
}
const num = (v) => (typeof v === 'number' ? v : isBound(v) ? v.at_least : null);
const changed = (a, b) => JSON.stringify(a?.value) !== JSON.stringify(b?.value);
/** SCRUM-202 with every event and usage record measured: the fuzz baseline. */
function measuredScrum202() {
  const rows = scrum202Rows().map((r) => (r.metrics?.label ? { ...r, metrics: { ...r.metrics, label: 'measured' } } : r));
  const records = scrum202Usage().map((r) => (known(r.estimated_cost_usd) && !known(r.reported_cost_usd) ? { ...(({ estimated_cost_usd, ...x }) => x)(r), reported_cost_usd: r.estimated_cost_usd, cost_basis: 'list' } : r));
  return { rows, records };
}
function known(v) { return typeof v === 'number' && Number.isFinite(v); }
// The kinds each scope's declaration covers, as the reference states them (independent of measure.mjs).
const KINDS_OF_SCOPE = { review: ['review_round', 'review_reconcile'], repair: ['repair_batch', 'confirmation'], gate: ['gate_run'], owner: ['owner_decision'], sleep: ['host_sleep'], findings: ['finding'] };
const S04_NAMES = ['run_mode', 'review_round', 'repair_batch', 'confirmation', 'gate_run', 'finding', 'measurement_complete', 'owner_decision', 'host_sleep', 'review_reconcile'];
const VALUE_FIELDS = { review_round: ['majors'], gate_run: ['hold_ms', 't0_class'] }; // fields a value can need beyond validation
const REQUIRED_FIELDS = { review_round: ['n', 'round_kind', 'lane', 'verdict'], repair_batch: ['n'], confirmation: ['n'], gate_run: ['n', 'head_sha', 'clean'], owner_decision: ['n'],
  finding: ['fingerprint', 'repeat', 'severity'], run_mode: ['mode'], measurement_complete: ['scopes'] };

test('FUZZ: no mutation of a complete, measured history prints a dependent value as measured, bare-exact or 0', (t) => {
  const B = measuredScrum202();
  const base = report(B.rows, B.records).measurement;
  const P0 = printed(base);
  const ids = [...new Set(B.rows.filter((r) => S04_NAMES.includes(r.name)).map((r) => r.event_id))];
  const edit = (id, f) => B.rows.flatMap((r) => (r.event_id !== id ? [r] : f(r)));
  const setStart = (id, g) => edit(id, (r) => [r.event === 'start' ? { ...r, metrics: g({ ...r.metrics }) } : r]);
  const tally = { mutations: 0, assertions: 0 };
  const run = (rows, records, check) => { const P = printed(report(rows, records).measurement); tally.mutations += 1; check(P); };
  const notMeasuredExact = (P, deps, why) => { for (const k of deps) { const l = P.get(k); tally.assertions += 1;
    assert.ok(!l || typeof l.value !== 'number' || l.label !== 'measured', `${why}: ${k} printed ${JSON.stringify(l?.value)} measured`);
    if (l && isBound(l.value)) assert.notEqual(l.label, 'measured', `${why}: ${k} bound labelled measured`); } };
  const unavailableAll = (P, deps, why) => { for (const k of deps) { const l = P.get(k); tally.assertions += 1;
    assert.ok(!l || isUnavailable(l.value), `${why}: ${k} printed ${JSON.stringify(l?.value)} (expected unavailable)`); } };
  const noFalseZero = (P, why) => { for (const [k, l0] of P0) { const l = P.get(k);
    if (num(l0.value) > 0 && l && l.value === 0) assert.fail(`${why}: ${k} went from ${JSON.stringify(l0.value)} to 0`); } };
  const depsOf = (P1) => [...P0.keys()].filter((k) => changed(P0.get(k), P1.get(k)) || !P1.has(k));
  for (const id of ids) {
    const name = B.rows.find((r) => r.event_id === id).name;
    const deps = depsOf(printed(report(B.rows.filter((r) => r.event_id !== id), B.records).measurement));
    for (const label of ['estimated', 'unavailable']) run(setStart(id, (m) => ({ ...m, label })), B.records, (P) => { notMeasuredExact(P, deps, `${id} label=${label}`); noFalseZero(P, id); });
    // a value input left open or malformed poisons what reads it; a meta event (declaration, run mode) left open or malformed only declares nothing
    const meta = ['measurement_complete', 'run_mode'].includes(name);
    const expect = (P, why) => (meta ? notMeasuredExact(P, deps, why) : unavailableAll(P, deps, why));
    run(B.rows.filter((r) => !(r.event_id === id && r.event === 'end')), B.records, (P) => { expect(P, `${id} left open`); noFalseZero(P, id); });
    for (const f of REQUIRED_FIELDS[name] ?? []) run(setStart(id, (m) => { delete m[f]; return m; }), B.records, (P) => { expect(P, `${id} without ${f}`); noFalseZero(P, id); });
    for (const f of VALUE_FIELDS[name] ?? []) {
      const start = B.rows.find((r) => r.event_id === id && r.event === 'start');
      if (start.metrics[f] === undefined) continue;
      const flipped = typeof start.metrics[f] === 'boolean' ? !start.metrics[f] : start.metrics[f] + 1;
      const fdeps = depsOf(printed(report(setStart(id, (m) => ({ ...m, [f]: flipped })), B.records).measurement));
      run(setStart(id, (m) => { delete m[f]; return m; }), B.records, (P) => { unavailableAll(P, fdeps, `${id} without ${f}`); noFalseZero(P, id); });
    }
  }
  // a whole kind dropped together with its scope; each scope dropped with its events kept
  for (const [scope, kinds] of Object.entries(KINDS_OF_SCOPE)) {
    const without = (rows) => rows.map((r) => (r.name === 'measurement_complete' && r.event === 'start' ? { ...r, metrics: { ...r.metrics, scopes: r.metrics.scopes.split(',').filter((x) => x !== scope).join(',') } } : r));
    const deps = depsOf(printed(report(B.rows.filter((r) => !kinds.includes(r.name)), B.records).measurement));
    run(without(B.rows), B.records, (P) => notMeasuredExact(P, deps, `scope ${scope} dropped`));
    run(without(B.rows.filter((r) => !kinds.includes(r.name))), B.records, (P) => { notMeasuredExact(P, deps, `kind ${kinds} and scope ${scope} dropped`); });
    // replay those events into a run that declares nothing, and split them off into one
    const moved = B.rows.filter((r) => kinds.includes(r.name));
    run([...B.rows, ...moved.map((r) => ({ ...r, run_id: 'run-C', event_id: `${r.event_id}-C` }))], B.records, (P) => { notMeasuredExact(P, deps, `${scope} replayed into run-C`); noFalseZero(P, `${scope} replay`); });
    run([...B.rows.filter((r) => !kinds.includes(r.name)), ...moved.map((r) => ({ ...r, run_id: 'run-C' }))], B.records, (P) => { notMeasuredExact(P, deps, `${scope} split into run-C`); noFalseZero(P, `${scope} split`); });
  }
  { // usage records: dropped with the scope, or the scope dropped alone
    const without = B.rows.map((r) => (r.name === 'measurement_complete' && r.event === 'start' ? { ...r, metrics: { ...r.metrics, scopes: r.metrics.scopes.replace(',usage', '') } } : r));
    const deps = depsOf(printed(report(B.rows, []).measurement));
    run(without, B.records, (P) => notMeasuredExact(P, deps, 'usage scope dropped'));
    for (let i = 0; i < B.records.length; i += 1) {
      const rdeps = depsOf(printed(report(B.rows, B.records.filter((_, j) => j !== i)).measurement));
      run(B.rows, B.records.map((r, j) => (j === i ? { ...r, reported_cost_usd: undefined } : r)), (P) => { notMeasuredExact(P, rdeps, `usage record ${i} unpriced`); noFalseZero(P, `usage ${i}`); });
    }
  }
  // identical replays inside their own run change nothing
  run([...B.rows, ...B.rows.filter((r) => S04_NAMES.includes(r.name)).map((r) => ({ ...r, event_id: `${r.event_id}-again` }))], B.records, (P) => {
    for (const [k, l] of P0) { tally.assertions += 1; assert.deepEqual(P.get(k), l, `replay changed ${k}`); }
  });
  t.diagnostic(`fuzz: ${JSON.stringify(tally)}`);
  assert.ok(tally.mutations >= 400 && tally.assertions >= 1500, JSON.stringify(tally));
});

test('FUZZ: every number in the whole eval report is registered, and bookkeeping is all that bypasses resolve', () => {
  const B = measuredScrum202();
  for (const out of [report(B.rows, B.records), evaluate({ runs: buildAll(fullHistory().rows), records: fullHistory().records, now: NOW })]) {
    const ids = new Set(Object.keys(out.measurement.tickets));
    const templates = [...Object.values(INPUT_SCOPES).map((s) => `measurement.${s.path}`), ...Object.keys(BOOKKEEPING).map((p) => (p.startsWith('report.') ? p.slice(7) : `measurement.${p}`))].map((t) => t.split('.'));
    const match = (segs) => templates.some((t) => t.length === segs.length && t.every((s, i) => s === '*' || (s === '{ticket}' ? ids.has(segs[i]) : s === segs[i])));
    const walk = (node, segs) => {
      if (typeof node === 'number' || isBound(node)) { assert.ok(match(segs), `unregistered number at ${segs.join('.')}`); return; }
      if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...segs, k]);
    };
    walk(out, []);
    assert.deepEqual(Object.keys(out).sort(), ['measurement', 'note', 'runs', 'schema']);
  }
});

// generators: one more valid, known event of each kind (or a usage record that replaces another)
const GEN = {
  review_round: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'review_round', D(19), D(19, 10), { n: 7, round_kind: 'final', lane: 'opus', verdict: 'PASS', majors: 0 }), 'T-A')],
  review_lane: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'review_round', D(11), D(12, 30), { n: 1, round_kind: 'original', lane: 'gemini', verdict: 'FAIL', majors: 1 }), 'T-A')],
  reconcile: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'review_reconcile', D(19, 20), D(19, 30), { candidate_id: 'c1', review_execution: 'review-9' }), 'T-A')],
  repair_batch: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'repair_batch', D(19, 40), D(19, 50), { n: 7 }), 'T-A')],
  confirmation: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'confirmation', D(19, 55), D(19, 55), { n: 8 }), 'T-A')],
  gate_run: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'gate_run', D(17, 40), D(17, 50), { n: 9, head_sha: 'h9', clean: false, t0_class: true, holds_review: true, hold_ms: 60000 }, 'fail',
    { per_gate: [{ name: 'test', ms: 1, exit: 0, key: 'k2' }] }), 'T-A')],
  owner_decision: (h) => [...h.rows, ...asTicket(pair('a1', 'wait', 'owner_decision', D(18, 10), D(18, 20), { n: 5, decision_class: 'x' }), 'T-A')],
  host_sleep: (h) => [...h.rows, ...asTicket(pair('a1', 'wait', 'host_sleep', D(18, 30), D(18, 40), { gap_reason: 'host_sleep' }), 'T-A')],
  finding: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'finding', D(19), D(19), { fingerprint: 'fp9', repeat: true, severity: 'Major', builder_catchable: true, deferred: true, round: 9 }), 'T-A')],
  classify: (h) => [...h.rows, ...asTicket(pair('a1', 'activity', 'finding', D(19), D(19), { fingerprint: 'fpU', repeat: false, severity: 'Minor', builder_catchable: true, round: 9 }), 'T-A')],
};
const REPLACE = (h) => [...h.records, { ...h.records[0], input_tokens: 99, reported_cost_usd: 0.5 }]; // same execution, fuller record, lower cost

test('POLARITY (semantic): wherever a lower bound is printed, adding any event never lowers it; a usage record that replaces another is covered', () => {
  // the full history plus one unclassified finding and one estimate-priced record, so those values are not 0
  const h0 = fullHistory();
  const h = { rows: [...h0.rows, ...asTicket(pair('a1', 'activity', 'finding', D(12, 5), D(12, 5), { fingerprint: 'fpU', repeat: false, severity: 'Minor', round: 1 }), 'T-A')],
    records: [...h0.records, { provider: 'claude', run_id: 'a1', role: 'reviewer', source_execution_id: 'est-1', input_tokens: 1, estimated_cost_usd: 2 }] };
  let compared = 0;
  for (const scope of SCOPES) {
    const dropped = { ...h, rows: h.rows.map((r) => (r.name === 'measurement_complete' && r.event === 'start' ? { ...r, metrics: { ...r.metrics, scopes: r.metrics.scopes.split(',').filter((x) => x !== scope).join(',') } } : r)) };
    const before = printed(evaluate({ runs: buildAll(dropped.rows), records: dropped.records, now: NOW }).measurement);
    const variants = [...Object.values(GEN).map((g) => ({ rows: g(dropped), records: dropped.records })), { rows: dropped.rows, records: REPLACE(dropped) }];
    for (const v of variants) {
      const after = printed(evaluate({ runs: buildAll(v.rows), records: v.records, now: NOW }).measurement);
      for (const [k, l] of before) {
        if (!isBound(l.value)) continue;
        const a = after.get(k);
        compared += 1;
        assert.ok(!a || isUnavailable(a.value) || (isBound(a.value) && a.value.at_least >= l.value.at_least),
          `${k} without ${scope}: printed {at_least: ${l.value.at_least}} but one more input gives ${JSON.stringify(a?.value)}`);
      }
    }
  }
  assert.ok(compared > 300, `compared ${compared}`);
});

test('R4-L: rows the reader lost (a conflicting duplicate start, a malformed log line) void the run\'s declaration', (t) => {
  const gate = ev('r1', 'gate_run', D(13), D(13, 10), { n: 1, head_sha: 'h1', clean: true }, 'pass');
  const rows = [...wf('r1'), ...mode('r1', 'engine'), ...gate, ...declare('r1', 'gate')];
  assert.equal(measure(rows).metrics.M7.value[TICKET].t2_runs, 1);
  assert.equal(measure([...rows, ...rows.filter((r) => r.name === 'gate_run')]).metrics.M7.value[TICKET].t2_runs, 1); // a byte-identical stream copy loses nothing
  const conflicting = { ...gate[0], metrics: { ...gate[0].metrics, n: 2 } };
  assert.deepEqual(measure([...rows, conflicting]).metrics.M7.value[TICKET].t2_runs, { at_least: 1 });
  const f = repo(t, rows);
  writeFileSync(f.log, `${readFileSync(f.log, 'utf8')}{not json\n`);
  const out = JSON.parse(f.cli(evalCli, 'report', '--repo', f.root, '--ticket', TICKET).stdout);
  assert.deepEqual(out.measurement.metrics.M7.value[TICKET].t2_runs, { at_least: 1 });
});
