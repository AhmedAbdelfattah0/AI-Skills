// Synthetic S-04 fixture: the SCRUM-202 timeline reduced to counts, kinds, durations and clock formats (ASTF-42).
// No transcript text, no tokens, no sink telemetry: every identifier below is invented. Gate and engine stamps
// use +02:00 on purpose (the forensic report found local-time stamps next to Z stamps).
const SCHEMA = 'ship-ticket-run-log-v1';
export const TICKET = 'SCRUM-202';
export const DAY = '2026-11-16';
const z = (hms) => `${DAY}T${hms}.000Z`;
/** The same instant as the Z time `hms`, written in local +02:00 form. */
const local = (hms) => {
  const [h, m, s] = hms.split(':').map(Number);
  return `${DAY}T${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000+02:00`;
};
const secs = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + s; };

let seq = 0;
/** start+end row pair; `at` and `to` are stamps (Z or +02:00 strings). */
export function pair(run, kind, name, at, to, metrics = {}, outcome = 'complete', detail) {
  const id = `${name}-${++seq}`;
  const ms = Date.parse(to) - Date.parse(at);
  const base = { schema: SCHEMA, ticket: TICKET, run_id: run, event_id: id, kind, name };
  return [{ ...base, event: 'start', timestamp: at, metrics },
    { ...base, event: 'end', timestamp: to, duration_ms: ms, outcome, metrics: {}, ...(detail ? { detail } : {}) }];
}

const OWNER_WAITS = [ // [run, start (Z), seconds, class, retries_granted]
  ['run-A', '15:04:49', 169, 'plan_rework', 0], ['run-A', '16:52:43', 88, 'resume', 0], ['run-A', '16:54:18', 43, 'plan_approval', 0],
  ['run-A', '16:56:53', 102, 'catalog_option', 0], ['run-A', '17:05:00', 102, 'reapproval', 0], ['run-A', '17:12:00', 200, 'supervised_completion', 0],
  ['run-A', '17:22:00', 57, 'scope', 0], ['run-B', '17:59:59', 859, 'bounded_round', 1], ['run-B', '18:28:29', 955, 'waiver_question', 0],
  ['run-B', '19:14:01', 332, 'final_repair', 1], ['run-B', '19:32:37', 824, 'supervised_completion', 0], ['run-B', '21:20:04', 392, 'ship_approval', 0],
];
// [n, round kind, lane, start, end, verdict, majors, minors] (Z); per-round hull = 196, 459, 437, 578, 581, 437 s = 2,688 s.
const LANES = [
  [1, 'original', 'codex', '17:28:03', '17:31:19', 'FAIL', 3, 1], [1, 'original', 'opus', '17:28:12', '17:30:42', 'FAIL', 1, 3],
  [2, 'confirmation', 'opus', '17:51:57', '17:54:12', 'PASS', 0, 5], [2, 'confirmation', 'codex', '17:51:56', '17:59:35', 'FAIL', 3, 2],
  [3, 'confirmation', 'opus', '19:06:26', '19:13:43', 'FAIL', 2, 2], [3, 'confirmation', 'codex', '19:06:26', '19:12:53', 'FAIL', 3, 1],
  [4, 'confirmation', 'opus', '19:22:39', '19:32:17', 'FAIL', 1, 3], [4, 'confirmation', 'codex', '19:22:39', '19:27:54', 'FAIL', 3, 2],
  [5, 'confirmation', 'opus', '20:21:19', '20:31:00', 'PASS', 0, 5], [5, 'confirmation', 'codex', '20:21:19', '20:27:14', 'FAIL', 1, 1],
  [6, 'final', 'opus', '20:59:58', '21:07:15', 'PASS', 0, 4], [6, 'final', 'codex', '20:59:58', '21:07:14', 'PASS', 0, 3],
];
const BATCHES = [[1, '17:33:42', '17:37:09'], [2, '18:45:37', '18:50:33'], [3, '19:19:58', '19:21:20'], [4, '19:47:00', '19:51:30'], [5, '20:28:00', '20:32:22']];
// [n, start, seconds, clean, outcome, t0 class failure, hold_ms]
const GATES = [[1, '17:38:03', 812, false, 'pass', false], [2, '18:52:11', 823, false, 'pass', false], [3, '19:22:13', 822, true, 'fail', true],
  [4, '19:51:47', 888, true, 'fail', true], [5, '20:06:58', 832, true, 'pass', false, 860000], [6, '20:32:25', 825, true, 'fail', true],
  [7, '20:47:04', 756, true, 'pass', false, 773000], [8, '21:07:26', 744, true, 'pass', false]];

const add = (s, n) => { const t = secs(s) + n; return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((v) => String(v).padStart(2, '0')).join(':'); };

/** Majors F01-F14 (3 re-reported as repeats = 17 labels) plus the two knowingly deferred findings of the ticket. */
function findingRows() {
  const rows = [];
  for (let i = 1; i <= 14; i += 1) {
    const fp = `fp-${String(i).padStart(2, '0')}`;
    rows.push(...pair('run-B', 'activity', 'finding', z(add('17:30:00', i)), z(add('17:30:00', i)),
      { fingerprint: fp, repeat: false, severity: 'Major', round: Math.min(6, 1 + Math.floor(i / 3)), builder_catchable: i <= 8 }));
  }
  for (const i of [3, 7, 11]) {
    rows.push(...pair('run-B', 'activity', 'finding', z(add('19:00:00', i)), z(add('19:00:00', i)),
      { fingerprint: `fp-${String(i).padStart(2, '0')}`, repeat: true, severity: 'Major', round: 4 }));
  }
  rows.push(...pair('run-B', 'activity', 'finding', z('21:27:36'), z('21:27:36'), { fingerprint: 'deferred-418', repeat: false, severity: 'High', round: 6, deferred: true }));
  rows.push(...pair('run-B', 'activity', 'finding', z('21:27:37'), z('21:27:37'), { fingerprint: 'deferred-419', repeat: false, severity: 'Low', round: 6, deferred: true }));
  return rows;
}

/** All run-log rows of the SCRUM-202 reproduction: run-A (engine, abandoned) superseded by run-B (supervised, merged). */
export function scrum202Rows() {
  seq = 0;
  const rows = [
    ...pair('run-A', 'workflow', 'ship-ticket', z('15:03:22'), z('17:27:28'), {}, 'abandoned'),
    ...pair('run-A', 'activity', 'run_mode', z('15:03:35'), z('15:03:35'), { mode: 'engine', label: 'measured' }),
    ...pair('run-A', 'phase', 'PLAN', z('15:03:35'), z('16:55:05'), {}, 'pass'),
    ...pair('run-A', 'wait', 'host_sleep', z('15:15:27'), z('16:52:19'), { gap_reason: 'host_sleep', label: 'measured' }),
    ...pair('run-A', 'phase', 'BUILD', z('17:01:20'), z('17:18:09'), {}, 'pass'),
    ...pair('run-B', 'workflow', 'ship-ticket', z('17:27:42'), z('21:29:00'), {}, 'complete'),
    ...pair('run-B', 'activity', 'run_mode', z('17:27:42'), z('17:27:42'), { mode: 'supervised', supersedes_run_id: 'run-A', label: 'measured' }),
    ...pair('run-B', 'phase', 'SHIP', z('21:07:15'), z('21:29:00'), {}, 'pass'),
  ];
  for (const [run, at, s, cls, retries] of OWNER_WAITS) {
    rows.push(...pair(run, 'wait', 'owner_decision', z(at), z(add(at, s)), { n: rows.length, decision_class: cls, retries_granted: retries, wait_ms: s * 1000, label: 'estimated' }));
  }
  // owner_decision n is its position in time order
  rows.filter((r) => r.name === 'owner_decision' && r.event === 'start').forEach((r, i) => { r.metrics.n = i + 1; });
  LANES.forEach(([n, kind, lane, at, to, verdict, majors, minors], i) => rows.push(...pair('run-B', 'activity', 'review_round', z(at), z(to),
    { n, round_kind: kind, lane, candidate_sha: `cand-${n}`, packet_sha256: `pkt-${n}-${lane}`, verdict, majors, minors, label: 'measured' }, verdict === 'PASS' ? 'pass' : 'fail')));
  for (const [n, at, to] of BATCHES) {
    rows.push(...pair('run-B', 'activity', 'repair_batch', z(at), z(to), { n, authority_event_id: `auth-${n}`, label: 'measured' }, 'complete', { finding_ids: [`fp-${String(n).padStart(2, '0')}`] }));
  }
  for (const n of [2, 3, 4, 5, 6]) rows.push(...pair('run-B', 'activity', 'confirmation', z(LANES[(n - 1) * 2][3]), z(LANES[(n - 1) * 2][3]), { n, repair_batch: n - 1, verdict: 'recorded', label: 'measured' }));
  for (const [n, at, s, clean, outcome, t0, hold] of GATES) {
    rows.push(...pair('run-B', 'activity', 'gate_run', local(at), local(add(at, s)),
      { n, head_sha: `head-${n}`, clean, manifest_sha256: `man-${n}`, t0_class: t0, ...(hold ? { holds_review: true, hold_ms: hold } : {}), label: 'measured' }, outcome));
  }
  rows.push(...findingRows());
  return rows;
}

/** Usage records: builders measured; orchestrator/reviewer/subagent cost estimated; Codex reported nothing. */
export function scrum202Usage() {
  const rec = (o) => ({ provider: 'claude', run_id: 'run-B', source: 'fixture', input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, ...o });
  return [
    rec({ run_id: 'run-A', role: 'builder', source_execution_id: 'att-1', attempt_id: 'att-web-state', reported_cost_usd: 10.05, cost_basis: 'list', models_used: ['claude-opus-5-5', 'claude-fable-5-2'] }),
    rec({ role: 'orchestrator', source_execution_id: 'orch', estimated_cost_usd: 15.7, cost_basis: 'estimate', models_used: ['claude-sonnet-5-5'] }),
    rec({ role: 'reviewer', source_execution_id: 'opus-rv', estimated_cost_usd: 21.1, cost_basis: 'estimate', models_used: ['claude-opus-5-5'] }),
    rec({ role: 'reviewer', source_execution_id: 'opus-matrix', estimated_cost_usd: 5.1, cost_basis: 'estimate', models_used: ['claude-opus-5-5'] }),
    rec({ role: 'unattributed', source_execution_id: 'sonnet-sub', estimated_cost_usd: 6.7, cost_basis: 'estimate', models_used: ['claude-sonnet-5-5'] }),
    ...Array.from({ length: 7 }, (_, i) => ({ provider: 'codex', run_id: 'run-B', role: 'reviewer', source: 'codex', source_execution_id: `codex-${i}`,
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, usage_status: 'unknown' })),
  ];
}
