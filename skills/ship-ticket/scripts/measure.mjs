#!/usr/bin/env node
/**
 * S-04 measurement completeness: the event vocabulary, its validation, the owner-decision import from a host
 * session transcript, and the metric computation M1-M10 (roadmap cons:H section 0.1) over run-log runs.
 *
 * Events are ordinary ship-ticket-run-log-v1 rows (an optional `detail` object beside `metrics`), so old
 * readers parse them and dropping the emitters removes the feature. Every printed value carries a label:
 * `measured` (read from a recorded event or provider counter), `estimated` (derived or priced by the
 * caller), or `unavailable` (the source did not carry it). Unavailable is never printed as 0.
 *
 *   measure.mjs owner-waits --session <session.jsonl> [--since <iso>] [--until <iso>]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { union } from './run-summary.mjs';
import { REVIEW_ROLE_OF } from './review-intervals.mjs';

export const MEASURE_SCHEMA = 'ship-ticket-measurement-v1';
export const LABELS = Object.freeze(['measured', 'estimated', 'unavailable']);
export const RUN_MODES = Object.freeze(['engine', 'supervised', 'recovery', 'fallback']);
const ROUND_KINDS = ['original', 'confirmation', 'final'];
const VERDICTS = ['PASS', 'FAIL', 'unavailable'];
/** Event name -> run-log kind. Point events are a zero-length interval. */
export const EVENT_KIND = Object.freeze({ run_mode: 'activity', review_round: 'activity', repair_batch: 'activity', confirmation: 'activity',
  gate_run: 'activity', finding: 'activity', owner_decision: 'wait', host_sleep: 'wait' });
/** Event metrics kept as strings (a numeric-looking sha must not become a number). */
export const EVENT_STRING_METRICS = Object.freeze(['mode', 'supersedes_run_id', 'reason', 'round_kind', 'lane', 'candidate_sha', 'packet_sha256',
  'verdict', 'head_sha', 'manifest_sha256', 'fingerprint', 'severity', 'decision_class', 'authority_event_id', 'label']);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POINT_NAMES = new Set(Object.keys(EVENT_KIND));
const known = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const UNAVAILABLE = 'unavailable';
const M9_PENDING = 'unavailable until the 30-day window matures';
const DAY_MS = 86400000;

/** Throws a short message when an event's metrics or detail do not match its vocabulary. Unknown extra metrics are allowed. */
export function validateEvent(name, metrics, detail) {
  const need = (cond, text) => { if (!cond) throw new Error(`${name}: ${text}`); };
  const str = (k) => typeof metrics[k] === 'string' && SAFE.test(metrics[k]);
  need(EVENT_KIND[name] !== undefined, 'unknown event');
  need(metrics.label === undefined || LABELS.includes(metrics.label), `label must be one of ${LABELS.join('|')}`);
  need(detail === undefined || (detail && typeof detail === 'object' && !Array.isArray(detail)), 'detail must be a JSON object');
  const optionalStrings = (...keys) => keys.forEach((k) => need(metrics[k] === undefined || str(k), `${k} must be a short id`));
  if (name === 'run_mode') {
    need(RUN_MODES.includes(metrics.mode), `mode must be one of ${RUN_MODES.join('|')}`);
    optionalStrings('supersedes_run_id', 'reason');
  } else if (name === 'review_round') {
    need(Number.isInteger(metrics.n) && metrics.n > 0, 'n must be a positive integer');
    need(ROUND_KINDS.includes(metrics.round_kind), `round_kind must be one of ${ROUND_KINDS.join('|')}`);
    need(str('lane'), 'lane is required');
    need(VERDICTS.includes(metrics.verdict), `verdict must be one of ${VERDICTS.join('|')}`);
    need([metrics.majors, metrics.minors].every((v) => v === undefined || isCount(v)), 'majors and minors must be counts');
    optionalStrings('candidate_sha', 'packet_sha256');
  } else if (name === 'repair_batch' || name === 'confirmation' || name === 'owner_decision') {
    need(Number.isInteger(metrics.n) && metrics.n > 0, 'n must be a positive integer');
    if (name === 'repair_batch') {
      optionalStrings('authority_event_id');
      need(detail?.finding_ids === undefined || (Array.isArray(detail.finding_ids) && detail.finding_ids.every((i) => typeof i === 'string')), 'detail.finding_ids must be strings');
    }
    if (name === 'owner_decision') {
      need(metrics.retries_granted === undefined || isCount(metrics.retries_granted), 'retries_granted must be a count');
      optionalStrings('decision_class');
    }
  } else if (name === 'gate_run') {
    need(Number.isInteger(metrics.n) && metrics.n > 0, 'n must be a positive integer');
    need(str('head_sha'), 'head_sha is required');
    need(typeof metrics.clean === 'boolean', 'clean must be true or false');
    optionalStrings('manifest_sha256');
    const gates = detail?.per_gate;
    need(gates === undefined || (Array.isArray(gates) && gates.every((g) => g && typeof g.name === 'string' && isCount(g.ms) && Number.isInteger(g.exit) && typeof g.key === 'string')),
      'detail.per_gate must be [{name, ms, exit, key}]');
  } else if (name === 'finding') {
    need(str('fingerprint'), 'fingerprint is required');
    need(typeof metrics.repeat === 'boolean', 'repeat must be true or false');
    need(typeof metrics.severity === 'string' && metrics.severity.length > 0, 'severity is required');
  }
}

// ---- owner decisions from a host session transcript ----------------------------------------------

/** Text that a `user` record carries when it is not the human: a subagent handback, a task notification, a system reminder. */
const NOT_HUMAN = /^\s*(Another Claude session sent a message|<task-notification|<system-reminder|<local-command|\[Request interrupted|Caveat:)/;

function humanText(ev) {
  if (ev.isSidechain === true || ev.isMeta === true || ev.toolUseResult !== undefined) return null;
  const c = ev.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  if (!blocks.length || !blocks.every((b) => b?.type === 'text' && typeof b.text === 'string')) return null;
  const text = blocks.map((b) => b.text).join('\n');
  return text.trim() && !NOT_HUMAN.test(text) ? text : null;
}

/**
 * Owner decisions of a Claude session transcript (text of the JSONL): a human `user` message that follows an assistant turn that
 * ended awaiting the owner (`end_turn`, or an AskUserQuestion/ExitPlanMode call). `wait_ms` is the gap between those two timestamps,
 * so it is `estimated`, not measured. Subagent handbacks, tool results, meta and sidechain records are not human; a repeated
 * (streamed) record counts once. A human message that interrupts a running turn is not a wait and is not returned.
 */
export function ownerDecisionsFromSession(text, { since, until } = {}) {
  const from = since ? Date.parse(since) : null, to = until ? Date.parse(until) : null;
  const seen = new Set(), out = [];
  let last = null;
  for (const raw of String(text).split(/\r?\n/)) {
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    const ts = Date.parse(ev?.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ev.type === 'assistant') {
      if (ev.isSidechain === true) continue;
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const asks = blocks.some((b) => b?.type === 'tool_use' && ['AskUserQuestion', 'ExitPlanMode'].includes(b.name));
      last = { ts, awaits: ev.message?.stop_reason === 'end_turn' || asks };
    } else if (ev.type === 'user') {
      const body = humanText(ev);
      if (body === null) continue;
      const key = typeof ev.uuid === 'string' ? ev.uuid : `${ts}|${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const wait = last?.awaits ? ts - last.ts : null;
      last = null;
      if (wait === null || wait < 0 || (from !== null && ts < from) || (to !== null && ts > to)) continue;
      out.push({ n: out.length + 1, started_at: new Date(ts - wait).toISOString(), ended_at: new Date(ts).toISOString(), wait_ms: wait, label: 'estimated' });
    }
  }
  return out;
}

// ---- metrics ------------------------------------------------------------------------------------

const rank = { measured: 0, estimated: 1, unavailable: 2 };
const worst = (labels) => labels.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'measured');
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const spanLen = (spans) => union(spans).reduce((n, [a, b]) => n + b - a, 0);
const clip = (spans, [a, b]) => spans.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s);

/** The measurement events of one run, with carrier times preferred and a label each; malformed events are counted, not read. */
function eventsOf(run, bad) {
  const out = [];
  for (const i of run.intervals) {
    if (EVENT_KIND[i.name] !== i.kind || !POINT_NAMES.has(i.name)) continue;
    try { validateEvent(i.name, i.metrics, i.detail); } catch { bad.count += 1; continue; }
    const c = i.carrier_timing;
    const s = Date.parse(c ? c.started_at : i.started_at), e = Date.parse(c ? c.ended_at : i.ended_at);
    out.push({ name: i.name, run_id: run.run_id, event_id: i.event_id, start: s, end: e, metrics: i.metrics, detail: i.detail, outcome: i.outcome,
      label: LABELS.includes(i.metrics.label) ? i.metrics.label : 'measured' });
  }
  return out;
}

/** One logical event, whatever stream it came from: a re-emitted record under a new event_id is the same event. */
function logicalKey(e) {
  const m = e.metrics;
  switch (e.name) {
    case 'review_round': return `${m.n}|${m.lane}`;
    case 'repair_batch': case 'confirmation': case 'gate_run': case 'owner_decision': return `${m.n}`;
    case 'finding': return `${m.fingerprint}|${m.repeat}|${m.round ?? ''}`;
    case 'run_mode': return e.run_id;
    default: return `${e.start}|${e.end}`;
  }
}
function dedupe(events) {
  const seen = new Set();
  return [...events].sort((a, b) => a.start - b.start || a.end - b.end).filter((e) => {
    const key = `${e.name}|${logicalKey(e)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const STATUS = { complete: 'delivered', fail: 'failed', abandoned: 'abandoned', open: 'censored' };

/** Tickets of `runs` with their deduped events, head run (the one no run supersedes) and status. */
function assemble(runs, bad) {
  const byTicket = new Map();
  for (const run of runs) byTicket.set(run.ticket, [...(byTicket.get(run.ticket) ?? []), run]);
  const tickets = {};
  for (const [ticket, list] of byTicket) {
    const events = dedupe(list.flatMap((r) => eventsOf(r, bad)));
    const superseded = new Set(events.filter((e) => e.name === 'run_mode' && e.metrics.supersedes_run_id).map((e) => e.metrics.supersedes_run_id));
    const first = (r) => Math.min(...r.intervals.map((i) => Date.parse(i.started_at)).concat(r.open_intervals.map((i) => Date.parse(i.started_at))), Infinity);
    const heads = list.filter((r) => !superseded.has(r.run_id)).sort((a, b) => first(a) - first(b));
    const head = heads.at(-1) ?? list.at(-1);
    const by = (name) => events.filter((e) => e.name === name);
    const roundNs = new Set(by('review_round').map((e) => e.metrics.n));
    const confirmNs = new Set([...by('confirmation').map((e) => e.metrics.n), ...by('review_round').filter((e) => e.metrics.round_kind === 'confirmation').map((e) => e.metrics.n)]);
    tickets[ticket] = { instrumented: events.length > 0, status: STATUS[head.outcome] ?? 'unknown', head_run_id: head.run_id,
      runs: list.map((r) => r.run_id), events, by,
      counts: { review_rounds: roundNs.size, repair_batches: new Set(by('repair_batch').map((e) => e.metrics.n)).size, confirmations: confirmNs.size,
        gate_runs: by('gate_run').length, owner_waits: by('owner_decision').length, findings: by('finding').length } };
  }
  return tickets;
}

function m1(started) {
  const by_status = { delivered: 0, failed: 0, abandoned: 0, censored: 0 };
  const started_by_status = { ...by_status };
  let numerator = 0, incomplete = 0;
  for (const t of started) {
    if (t.status in started_by_status) started_by_status[t.status] += 1;
    const originals = t.by('review_round').filter((e) => e.metrics.round_kind === 'original');
    if (!originals.length) continue;
    const n = Math.min(...originals.map((e) => e.metrics.n));
    const lanes = t.by('review_round').filter((e) => e.metrics.n === n);
    const ok = lanes.length >= 2 && lanes.every((e) => e.metrics.verdict === 'PASS' && e.metrics.majors === 0);
    if (lanes.length < 2 || lanes.some((e) => e.metrics.verdict === UNAVAILABLE || !isCount(e.metrics.majors))) incomplete += 1;
    if (ok) { numerator += 1; if (t.status in by_status) by_status[t.status] += 1; }
  }
  const denominator = started.length;
  return { value: denominator ? Math.round(numerator / denominator * 1000) / 1000 : UNAVAILABLE, numerator, denominator, by_status, started_by_status,
    incomplete_first_rounds: incomplete, label: denominator ? 'measured' : UNAVAILABLE };
}

function m2m3(tickets) {
  const findings = Object.entries(tickets).flatMap(([id, t]) => t.by('finding').map((e) => ({ id, e })));
  if (!findings.length) return [{ value: UNAVAILABLE, label: UNAVAILABLE }, { value: UNAVAILABLE, label: UNAVAILABLE }];
  const majors = new Map();
  for (const { id, e } of findings) if (String(e.metrics.severity).toLowerCase() === 'major') majors.set(`${id}|${e.metrics.fingerprint}`, { ...majors.get(`${id}|${e.metrics.fingerprint}`), catchable: majors.get(`${id}|${e.metrics.fingerprint}`)?.catchable || e.metrics.builder_catchable === true });
  const per = {};
  for (const key of majors.keys()) { const id = key.split('|')[0]; per[id] = (per[id] ?? 0) + 1; }
  const labels = worst(findings.map(({ e }) => e.label));
  const hasCatchable = findings.some(({ e }) => typeof e.metrics.builder_catchable === 'boolean');
  return [{ value: majors.size, per_ticket: per, repeat_findings: findings.filter(({ e }) => e.metrics.repeat === true).length, label: labels },
    hasCatchable ? { value: [...majors.values()].filter((m) => m.catchable).length, of_distinct_majors: majors.size, label: labels } : { value: UNAVAILABLE, label: UNAVAILABLE }];
}

function m4(started) {
  const value = Object.fromEntries(started.map((t) => [t.id, { rounds: t.counts.review_rounds, batches: t.counts.repair_batches, confirmations: t.counts.confirmations,
    repeat_findings: t.by('finding').filter((e) => e.metrics.repeat === true).length, status: t.status }]));
  const within = started.filter((t) => t.counts.review_rounds <= 2 && t.counts.repair_batches <= 1).length;
  return { value, tickets_within_target: within, of: started.length, label: started.length ? 'measured' : UNAVAILABLE };
}

function m5(started, runsOf) {
  const value = {};
  for (const t of started) {
    const runs = runsOf(t.id);
    const all = runs.flatMap((r) => r.intervals);
    const phase = (name) => all.filter((i) => i.kind === 'phase' && i.name === name);
    const sleeps = t.by('host_sleep'), waits = t.by('owner_decision');
    const window = (a, b) => {
      if (!known(a) || !known(b) || b <= a) return UNAVAILABLE;
      const sleep = spanLen(clip(sleeps.map((e) => [e.start, e.end]), [a, b]));
      const human = spanLen(clip([...sleeps, ...waits].map((e) => [e.start, e.end]), [a, b])) - sleep;
      const used = [...sleeps, ...waits].filter((e) => e.end > a && e.start < b);
      return { awake_ms_with_wait: b - a - sleep, awake_ms_excluding_wait: b - a - sleep - human, host_sleep_ms: sleep, human_wait_ms: human,
        label: worst(used.map((e) => e.label)) };
    };
    const headWorkflow = runs.find((r) => r.run_id === t.head_run_id)?.intervals.filter((i) => i.kind === 'workflow').at(-1);
    const begin = Math.min(...all.map((i) => Date.parse(i.started_at)), Infinity);
    const planEnd = phase('PLAN').length ? Math.max(...phase('PLAN').map((i) => Date.parse(i.ended_at))) : NaN;
    const shipStart = phase('SHIP').length ? Math.min(...phase('SHIP').map((i) => Date.parse(i.started_at))) : NaN;
    value[t.id] = { M5a: window(planEnd, shipStart), M5b: t.status === 'delivered' && headWorkflow ? window(begin, Date.parse(headWorkflow.ended_at)) : UNAVAILABLE };
  }
  const parts = Object.values(value).flatMap((v) => [v.M5a, v.M5b]).filter((v) => v !== UNAVAILABLE);
  return { value, label: parts.length ? worst(parts.map((p) => p.label)) : UNAVAILABLE,
    note: 'M5a = plan approval (PLAN end) to SHIP start; M5b = first interval to the head run workflow end (delivered only). Host sleep excluded; human wait reported with and without.' };
}

function m6(started, runsOf) {
  const value = {};
  for (const t of started) {
    const rounds = new Map();
    for (const e of t.by('review_round').filter((x) => x.metrics.required !== false)) {
      const r = rounds.get(e.metrics.n) ?? [Infinity, -Infinity];
      rounds.set(e.metrics.n, [Math.min(r[0], e.start), Math.max(r[1], e.end)]);
    }
    if (!rounds.size) continue;
    const reconcile = runsOf(t.id).flatMap((r) => r.intervals).filter((i) => i.kind === 'activity' && REVIEW_ROLE_OF[i.name] === 'reconcile')
      .map((i) => [Date.parse(i.carrier_timing?.started_at ?? i.started_at), Date.parse(i.carrier_timing?.ended_at ?? i.ended_at)]);
    const holds = t.by('gate_run').filter((e) => e.metrics.holds_review === true && known(e.metrics.hold_ms)).map((e) => [e.start, e.start + e.metrics.hold_ms]);
    const hulls = [...rounds.values()];
    value[t.id] = { review_rounds_ms: spanLen(hulls), reconcile_ms: spanLen(reconcile), gate_hold_ms: spanLen(holds), critical_path_ms: spanLen([...hulls, ...reconcile, ...holds]),
      label: worst([...t.by('review_round'), ...t.by('gate_run')].map((e) => e.label)) };
  }
  const ids = Object.keys(value);
  return { value, label: ids.length ? worst(ids.map((i) => value[i].label)) : UNAVAILABLE, note: 'rounds + reconciliation + gate holds, overlap counted once' };
}

function m7(started) {
  const value = {};
  for (const t of started) {
    const gates = t.by('gate_run');
    if (!gates.length) continue;
    const perGate = gates.map((g) => g.detail?.per_gate);
    let redundant = UNAVAILABLE;
    if (perGate.every(Array.isArray)) {
      const passed = new Set();
      redundant = 0;
      for (const list of perGate) {
        for (const g of list) if (passed.has(`${g.name}|${g.key}`)) redundant += 1;
        for (const g of list) if (g.exit === 0) passed.add(`${g.name}|${g.key}`);
      }
    }
    value[t.id] = { t2_runs: gates.length, t2_wall_ms: gates.reduce((n, g) => n + g.end - g.start, 0),
      t0_class_failures: gates.filter((g) => g.outcome === 'fail' && g.metrics.t0_class === true).length, failed_runs: gates.filter((g) => g.outcome === 'fail').length,
      dirty_runs: gates.filter((g) => g.metrics.clean === false).length, redundant_gate_executions: redundant };
  }
  return { value, label: Object.keys(value).length ? 'measured' : UNAVAILABLE };
}

const costOf = (r) => (known(r.reported_cost_usd) && r.cost_basis === 'list' ? { usd: r.reported_cost_usd, label: 'measured' }
  : known(r.estimated_cost_usd) ? { usd: r.estimated_cost_usd, label: 'estimated' } : null);

/** Cost of one provider's records: a number only when every record has one (never a partial sum presented as the total). */
function providerCost(records) {
  if (!records.length) return { usd: UNAVAILABLE, label: UNAVAILABLE, records: 0 };
  const priced = records.map(costOf);
  const unknownRecords = priced.filter((p) => p === null).length;
  const sum = (label) => round6(priced.filter((p) => p?.label === label).reduce((n, p) => n + p.usd, 0));
  const measured = sum('measured'), estimated = sum('estimated');
  if (unknownRecords) return { usd: UNAVAILABLE, label: UNAVAILABLE, records: records.length, unknown_records: unknownRecords, known_part_usd: round6(measured + estimated) };
  return { usd: round6(measured + estimated), measured_usd: measured, estimated_usd: estimated, label: estimated > 0 ? 'estimated' : 'measured', records: records.length };
}
const unavailableText = (names) => (names.length ? `${names.map((n) => n[0].toUpperCase() + n.slice(1)).join(' and ')} unavailable` : UNAVAILABLE);

function m8(started, records) {
  const ticketOfRun = new Map(started.flatMap((t) => t.runs.map((r) => [r, t])));
  const mine = (Array.isArray(records) ? records : []).filter((r) => r && ticketOfRun.has(r.run_id));
  const ofProvider = (list, p) => list.filter((r) => r.provider === p);
  const codexLane = started.some((t) => t.by('review_round').some((e) => /^codex/i.test(e.metrics.lane)));
  const used = ['claude', 'codex'].filter((p) => ofProvider(mine, p).length || (p === 'codex' && codexLane));
  const cost = Object.fromEntries(['claude', 'codex'].map((p) => [p, used.includes(p) ? providerCost(ofProvider(mine, p)) : { usd: 'not_used', label: 'measured', records: 0 }]));
  const missing = used.filter((p) => cost[p].usd === UNAVAILABLE);
  const delivered = started.filter((t) => t.status === 'delivered').length;
  const total = used.length && !missing.length ? round6(used.reduce((n, p) => n + cost[p].usd, 0)) : unavailableText(missing);
  const claudeBy = (statuses) => providerCost(ofProvider(mine, 'claude').filter((r) => statuses.includes(ticketOfRun.get(r.run_id).status))).usd;
  const status = (s) => (ofProvider(mine, 'claude').some((r) => s.includes(ticketOfRun.get(r.run_id).status)) ? claudeBy(s) : UNAVAILABLE);
  return { value: { claude: cost.claude, codex: cost.codex, total_usd: total,
    per_delivered_ticket_usd: typeof total === 'number' ? (delivered ? round6(total / delivered) : UNAVAILABLE) : total,
    delivered_tickets: delivered, delivered_claude_usd: status(['delivered']), failed_or_abandoned_claude_usd: status(['failed', 'abandoned']), censored_claude_usd: status(['censored']),
    models_used: [...new Set(mine.flatMap((r) => (Array.isArray(r.models_used) ? r.models_used : [])))].sort() },
  label: used.length ? worst(used.map((p) => cost[p].label)) : UNAVAILABLE,
  note: 'List-equivalent cost of all attempts. A provider with any record lacking a cost is unavailable, and so is the total; unknown is never 0.' };
}

function m9(started, now) {
  const deferred = {};
  for (const e of started.flatMap((t) => t.by('finding')).filter((x) => x.metrics.deferred === true)) deferred[e.metrics.severity] = (deferred[e.metrics.severity] ?? 0) + 1;
  const windows = started.filter((t) => t.status === 'delivered').map((t) => {
    const merged = t.mergedAt;
    return { ticket: t.id, merged_at: known(merged) ? new Date(merged).toISOString() : UNAVAILABLE,
      matures_at: known(merged) ? new Date(merged + 30 * DAY_MS).toISOString() : UNAVAILABLE, matured: known(merged) ? now >= merged + 30 * DAY_MS : false };
  });
  const pending = !windows.length || windows.some((w) => !w.matured);
  return { value: pending ? M9_PENDING : 'unavailable: no tracker defect links are recorded (S-04 has no source for escapes)', label: UNAVAILABLE, windows, deferred_findings: deferred };
}

/**
 * M1-M10 over `runs` (buildRun results; several tickets allowed). Only tickets with at least one S-04 event are measured; the rest are
 * counted as `uninstrumented` and left out of every denominator.
 * @param {object[]} runs
 * @param {{records?: object[], now?: number}} [sources] usage records (joined by run_id) and the clock for the M9 window
 */
export function measurementOf(runs, { records = [], now = Date.now() } = {}) {
  const bad = { count: 0 };
  const tickets = assemble(runs, bad);
  const runsOf = (id) => runs.filter((r) => r.ticket === id);
  const started = Object.entries(tickets).filter(([, t]) => t.instrumented).map(([id, t]) => {
    const wf = runsOf(id).find((r) => r.run_id === t.head_run_id)?.intervals.filter((i) => i.kind === 'workflow').at(-1);
    return { ...t, id, mergedAt: wf ? Date.parse(wf.ended_at) : NaN };
  });
  const populations = { tickets: { started: started.length, delivered: 0, failed: 0, abandoned: 0, censored: 0, unknown: 0,
    uninstrumented: Object.keys(tickets).length - started.length }, run_modes: {}, invalid_events: bad.count };
  for (const t of started) {
    populations.tickets[t.status] += 1;
    for (const e of t.by('run_mode')) populations.run_modes[e.metrics.mode] = (populations.run_modes[e.metrics.mode] ?? 0) + 1;
  }
  const [M2, M3] = m2m3(Object.fromEntries(started.map((t) => [t.id, t])));
  return { schema: MEASURE_SCHEMA, labels: { measured: 'read from a recorded event or provider counter', estimated: 'derived or priced; never a recorded fact', unavailable: 'the source did not carry it; never 0' },
    populations,
    tickets: Object.fromEntries(started.map((t) => [t.id, { status: t.status, head_run_id: t.head_run_id, instrumented: true, runs: t.runs, counts: t.counts }])),
    metrics: { M1: m1(started), M2, M3, M4: m4(started), M5: m5(started, runsOf), M6: m6(started, runsOf), M7: m7(started), M8: m8(started, records), M9: m9(started, now),
      M10: { value: UNAVAILABLE, label: UNAVAILABLE, reason: 'needs the S-24 eligibility record and S-16 replays; S-04 does not produce them' } } };
}

/** True when any run carries an S-04 event (decides whether eval adds a `measurement` block). */
export const hasMeasurementEvents = (runs) => runs.some((r) => r.intervals.some((i) => EVENT_KIND[i.name] === i.kind));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] !== 'owner-waits' || !opt('session')) { process.stderr.write('usage: measure.mjs owner-waits --session <session.jsonl> [--since <iso>] [--until <iso>]\n'); process.exit(1); }
  process.stdout.write(`${JSON.stringify(ownerDecisionsFromSession(readFileSync(opt('session'), 'utf8'), { since: opt('since'), until: opt('until') }), null, 2)}\n`);
}
