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
  gate_run: 'activity', finding: 'activity', measurement_complete: 'activity', owner_decision: 'wait', host_sleep: 'wait' });
/** What a `measurement_complete` event may declare as recorded in full: absent events of that kind then mean "none occurred", not "not recorded". */
export const SCOPES = Object.freeze(['review', 'repair', 'gate', 'owner', 'sleep', 'findings', 'usage']);
/** Event metrics kept as strings (a numeric-looking sha must not become a number). */
export const EVENT_STRING_METRICS = Object.freeze(['mode', 'supersedes_run_id', 'reason', 'round_kind', 'lane', 'candidate_sha', 'packet_sha256',
  'verdict', 'head_sha', 'manifest_sha256', 'fingerprint', 'severity', 'decision_class', 'authority_event_id', 'label', 'scopes']);
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
  } else if (name === 'measurement_complete') {
    need(typeof metrics.scopes === 'string' && metrics.scopes.split(',').every((x) => SCOPES.includes(x)), `scopes must be a comma list of ${SCOPES.join('|')}`);
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

/** Tools whose answer is an owner decision, with the class recorded for it. */
const ASKS = { AskUserQuestion: 'ask_user_question', ExitPlanMode: 'plan_approval' };

/**
 * Owner decisions of a Claude session transcript (text of the JSONL). Three shapes count: an AskUserQuestion or ExitPlanMode answer
 * (a `tool_result` user record for that tool_use; the wait runs from the asking assistant record), and a human text message after an
 * assistant turn that ended awaiting the owner (`end_turn`). `wait_ms` is a timestamp gap, so the label is `estimated`. Subagent
 * handbacks, other tool results, meta and sidechain records are not human; a repeated (streamed) record counts once. A human message
 * that interrupts a running turn is not a wait and is not returned.
 */
export function ownerDecisionsFromSession(text, { since, until } = {}) {
  const from = since ? Date.parse(since) : null, to = until ? Date.parse(until) : null;
  const seen = new Set(), out = [], pending = new Map();
  let last = null;
  const push = (key, ts, wait, decision_class) => {
    if (seen.has(key)) return;
    seen.add(key);
    if (wait === null || wait < 0 || (from !== null && ts < from) || (to !== null && ts > to)) return;
    out.push({ n: out.length + 1, decision_class, started_at: new Date(ts - wait).toISOString(), ended_at: new Date(ts).toISOString(), wait_ms: wait, label: 'estimated' });
  };
  for (const raw of String(text).split(/\r?\n/)) {
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    const ts = Date.parse(ev?.timestamp);
    if (!Number.isFinite(ts) || ev.isSidechain === true) continue;
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    if (ev.type === 'assistant') {
      for (const b of blocks) if (b?.type === 'tool_use' && ASKS[b.name] && typeof b.id === 'string') pending.set(b.id, { ts, cls: ASKS[b.name] });
      last = { ts, awaits: ev.message?.stop_reason === 'end_turn' };
    } else if (ev.type === 'user') {
      const answered = blocks.find((b) => b?.type === 'tool_result' && pending.has(b.tool_use_id));
      if (answered) {
        const ask = pending.get(answered.tool_use_id);
        pending.delete(answered.tool_use_id);
        last = null;
        push(typeof ev.uuid === 'string' ? ev.uuid : `${ts}|${answered.tool_use_id}`, ts, ts - ask.ts, ask.cls);
        continue;
      }
      const body = humanText(ev);
      if (body === null) continue;
      const wait = last?.awaits ? ts - last.ts : null;
      last = null;
      push(typeof ev.uuid === 'string' ? ev.uuid : `${ts}|${body}`, ts, wait, 'owner_message');
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
const MAJOR = new Set(['major', 'blocker', 'critical']);

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

/**
 * One logical event, whatever stream it came from: a re-emitted record under a new event_id is the same event. The run is part of
 * the identity (a recovery run numbers from 1 again), and so is the candidate/packet of a lane. A repeated finding without a round
 * is told apart by its own event id, so repeats are never merged away.
 */
function logicalKey(e) {
  const m = e.metrics, r = e.run_id;
  switch (e.name) {
    case 'review_round': return `${r}|${m.n}|${m.lane}|${m.candidate_sha ?? ''}|${m.packet_sha256 ?? ''}`;
    case 'repair_batch': case 'confirmation': case 'gate_run': case 'owner_decision': return `${r}|${m.n}`;
    case 'finding': return `${r}|${m.fingerprint}|${m.repeat}|${m.round ?? ''}|${m.repeat && m.round === undefined ? `${m.occurrence ?? ''}|${e.start}|${e.end}` : ''}`;
    case 'run_mode': return `${r}|${m.mode}`;
    case 'measurement_complete': return `${r}|${m.scopes}`;
    default: return `${r}|${e.start}|${e.end}`;
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
    const scopes = new Set(by('measurement_complete').flatMap((e) => e.metrics.scopes.split(',')));
    const declared = (scope) => scopes.has(scope);
    // A count is exact only when its scope was declared complete. Observed events without the declaration are a lower bound
    // ({ at_least }); nothing observed and nothing declared is not recorded (unavailable). Never inferred from count > 0.
    const count = (n, scope) => (declared(scope) ? n : n > 0 ? { at_least: n } : UNAVAILABLE);
    const roundNs = new Set(by('review_round').map((e) => `${e.run_id}|${e.metrics.n}`));
    const confirmNs = new Set([...by('confirmation').map((e) => `${e.run_id}|${e.metrics.n}`), ...by('review_round').filter((e) => e.metrics.round_kind === 'confirmation').map((e) => `${e.run_id}|${e.metrics.n}`)]);
    tickets[ticket] = { instrumented: events.length > 0, status: STATUS[head.outcome] ?? 'unknown', head_run_id: head.run_id, declared,
      runs: list.map((r) => r.run_id), events, by,
      counts: { review_rounds: count(roundNs.size, 'review'), repair_batches: count(new Set(by('repair_batch').map((e) => `${e.run_id}|${e.metrics.n}`)).size, 'repair'),
        confirmations: count(confirmNs.size, 'repair'), gate_runs: count(by('gate_run').length, 'gate'), owner_waits: count(by('owner_decision').length, 'owner'),
        findings: count(by('finding').length, 'findings') } };
  }
  return tickets;
}

function m1(started) {
  const by_status = { delivered: 0, failed: 0, abandoned: 0, censored: 0 };
  const started_by_status = { ...by_status };
  let numerator = 0, incomplete = 0, unrecorded = 0, denominator = 0;
  const labels = [];
  for (const t of started) {
    const originals = t.by('review_round').filter((e) => e.metrics.round_kind === 'original');
    // No review recorded and none declared: whether it happened is unknown, so the ticket is unavailable for M1 (not a failure).
    if (!originals.length && !t.declared('review') && !t.by('review_round').length) { unrecorded += 1; continue; }
    denominator += 1;
    if (t.status in started_by_status) started_by_status[t.status] += 1;
    if (!originals.length) continue;
    const n = Math.min(...originals.map((e) => e.metrics.n));
    const lanes = t.by('review_round').filter((e) => e.metrics.n === n && e.run_id === originals.find((o) => o.metrics.n === n).run_id);
    labels.push(...lanes.map((e) => e.label));
    const ok = lanes.length >= 2 && lanes.every((e) => e.metrics.verdict === 'PASS' && e.metrics.majors === 0);
    if (lanes.length < 2 || lanes.some((e) => e.metrics.verdict === UNAVAILABLE || !isCount(e.metrics.majors))) incomplete += 1;
    if (ok) { numerator += 1; if (t.status in by_status) by_status[t.status] += 1; }
  }
  return { value: denominator ? Math.round(numerator / denominator * 1000) / 1000 : UNAVAILABLE, numerator, denominator, by_status, started_by_status,
    unrecorded_reviews: unrecorded, incomplete_first_rounds: incomplete, label: denominator ? worst(labels) : UNAVAILABLE };
}

const SEVERE = (e) => MAJOR.has(String(e.metrics.severity).toLowerCase());
function m2m3(started) {
  const findings = started.flatMap((t) => t.by('finding').map((e) => ({ id: t.id, e })));
  if (!findings.length) return [{ value: UNAVAILABLE, label: UNAVAILABLE }, { value: UNAVAILABLE, label: UNAVAILABLE }];
  const labels = worst(findings.map(({ e }) => e.label));
  const majors = new Set(), per = {};
  for (const { id, e } of findings.filter(({ e }) => SEVERE(e))) {
    const key = `${id}|${e.metrics.fingerprint}`;
    if (!majors.has(key)) { majors.add(key); per[id] = (per[id] ?? 0) + 1; }
  }
  // M3: every distinct finding that reached review or a gate, whatever its severity, classified by builder_catchable.
  const distinct = new Map();
  for (const { id, e } of findings) {
    const key = `${id}|${e.metrics.fingerprint}`;
    const c = typeof e.metrics.builder_catchable === 'boolean' ? e.metrics.builder_catchable : undefined;
    const prev = distinct.get(key);
    distinct.set(key, prev === undefined || prev === false ? (c ?? prev) : prev);
  }
  const classified = [...distinct.values()].filter((v) => typeof v === 'boolean');
  const catchable = classified.filter(Boolean).length, unclassified = distinct.size - classified.length;
  const M3 = !classified.length ? { value: UNAVAILABLE, label: UNAVAILABLE, unclassified, of_distinct_findings: distinct.size }
    : { value: unclassified ? 'partial' : catchable, catchable_known: catchable, unclassified, of_distinct_findings: distinct.size, label: unclassified ? 'estimated' : labels };
  const exact = started.every((t) => t.declared('findings'));
  const lower = (v) => (exact ? v : { at_least: v });
  return [{ value: lower(majors.size), per_ticket: per, repeat_findings: findings.filter(({ e }) => e.metrics.repeat === true).length, label: exact ? labels : worst([labels, 'estimated']) },
    { ...M3, ...(known(M3.value) ? { value: lower(M3.value), label: exact ? M3.label : worst([M3.label, 'estimated']) } : {}) }];
}

function m4(started) {
  const value = Object.fromEntries(started.map((t) => [t.id, { rounds: t.counts.review_rounds, batches: t.counts.repair_batches, confirmations: t.counts.confirmations,
    repeat_findings: t.by('finding').filter((e) => e.metrics.repeat === true).length, status: t.status }]));
  const known4 = started.filter((t) => isCount(t.counts.review_rounds) && isCount(t.counts.repair_batches));
  const within = known4.filter((t) => t.counts.review_rounds <= 2 && t.counts.repair_batches <= 1).length;
  const inputs = (t) => ['review_round', 'repair_batch', 'confirmation', 'finding'].flatMap((n) => t.by(n)).map((e) => e.label);
  const partial = started.some((t) => [t.counts.review_rounds, t.counts.repair_batches].some((c) => c?.at_least !== undefined));
  const labels = started.flatMap(inputs).concat(partial ? ['estimated'] : []);
  return { value, tickets_within_target: within, of: known4.length, unrecorded_tickets: started.length - known4.length,
    label: known4.length || partial ? worst(labels) : UNAVAILABLE };
}

const NA = (missing) => ({ value: UNAVAILABLE, label: UNAVAILABLE, missing });

function m5(started, runsOf) {
  const value = {};
  for (const t of started) {
    const runs = runsOf(t.id);
    const all = runs.flatMap((r) => r.intervals);
    const phase = (name) => all.filter((i) => i.kind === 'phase' && i.name === name);
    const sleeps = t.by('host_sleep'), waits = t.by('owner_decision');
    const sleepKnown = t.declared('sleep'), ownerKnown = t.declared('owner');
    const bound = (known_, v, seen) => (known_ ? v : seen ? { at_least: v } : UNAVAILABLE);
    const window = (a, b, substitutions) => {
      const sleep = spanLen(clip(sleeps.map((e) => [e.start, e.end]), [a, b]));
      const human = spanLen(clip([...sleeps, ...waits].map((e) => [e.start, e.end]), [a, b])) - sleep;
      const used = [...sleeps, ...waits].filter((e) => e.end > a && e.start < b);
      const withWait = sleepKnown ? b - a - sleep : UNAVAILABLE;
      return { elapsed_ms: b - a, host_sleep_ms: bound(sleepKnown, sleep, sleeps.length > 0), human_wait_ms: bound(ownerKnown, human, waits.length > 0), awake_ms_with_wait: withWait,
        awake_ms_excluding_wait: sleepKnown && ownerKnown ? withWait - human : UNAVAILABLE, substitutions,
        label: worst(['estimated', ...used.map((e) => e.label), ...(sleepKnown && ownerKnown ? [] : ['estimated'])]) };
    };
    const headWorkflow = runs.find((r) => r.run_id === t.head_run_id)?.intervals.filter((i) => i.kind === 'workflow').at(-1);
    const begin = Math.min(...all.map((i) => Date.parse(i.started_at)), Infinity);
    const planEnd = phase('PLAN').length ? Math.max(...phase('PLAN').map((i) => Date.parse(i.ended_at))) : NaN;
    const shipStart = phase('SHIP').length ? Math.min(...phase('SHIP').map((i) => Date.parse(i.started_at))) : NaN;
    const a = [!known(planEnd) && 'plan approval (PLAN phase end)', !known(shipStart) && 'SHIP_READY (SHIP phase start)'].filter(Boolean);
    const b = [t.status !== 'delivered' && 'merge (the head run is not delivered)', !headWorkflow && 'merge (head run workflow end)', !known(begin) && 'first skill invocation (no interval)'].filter(Boolean);
    value[t.id] = {
      M5a: a.length || shipStart <= planEnd ? NA(a.length ? a : ['SHIP_READY after plan approval']) : window(planEnd, shipStart, ['approval = PLAN phase end', 'SHIP_READY = SHIP phase start (no SHIP_READY event is recorded)']),
      M5b: b.length ? NA(b) : window(begin, Date.parse(headWorkflow.ended_at), ['first skill invocation = first recorded interval start', 'merge = head run workflow end (no merge event is recorded)']) };
  }
  const parts = Object.values(value).flatMap((v) => [v.M5a, v.M5b]).filter((v) => v.label !== UNAVAILABLE);
  return { value, label: parts.length ? worst(parts.map((p) => p.label)) : UNAVAILABLE,
    note: 'M5a = approval to SHIP_READY, M5b = first invocation to merge; both use the named substitutions and are therefore estimated. Host sleep is excluded; an unrecorded sleep or wait is unavailable, never 0.' };
}

function m6(started, runsOf) {
  const value = {};
  for (const t of started) {
    const rounds = new Map();
    for (const e of t.by('review_round')) {
      const key = `${e.run_id}|${e.metrics.n}`;
      const r = rounds.get(key) ?? { start: Infinity, end: -Infinity, ok: true, required: false };
      r.start = Math.min(r.start, e.start); // every lane's dispatch counts toward the start (dispatch skew)
      if (e.metrics.required !== false) { r.required = true; r.end = Math.max(r.end, e.end); r.ok &&= e.end > e.start; }
      rounds.set(key, r);
    }
    if (!rounds.size) continue;
    const hulls = [...rounds.values()];
    const wallOk = hulls.every((r) => r.required && r.ok && r.end > r.start);
    const reconcile = runsOf(t.id).flatMap((r) => r.intervals).filter((i) => i.kind === 'activity' && REVIEW_ROLE_OF[i.name] === 'reconcile')
      .map((i) => [Date.parse(i.carrier_timing?.started_at ?? i.started_at), Date.parse(i.carrier_timing?.ended_at ?? i.ended_at)]);
    const holdEvents = t.by('gate_run').filter((e) => e.metrics.holds_review === true && known(e.metrics.hold_ms));
    const holds = holdEvents.map((e) => [e.start, e.start + e.metrics.hold_ms]);
    const parts = {
      review_rounds_ms: wallOk ? spanLen(hulls.map((r) => [r.start, r.end])) : UNAVAILABLE,
      reconcile_ms: reconcile.length || t.declared('review') ? spanLen(reconcile) : UNAVAILABLE,
      gate_hold_ms: holds.length || t.declared('gate') ? spanLen(holds) : UNAVAILABLE };
    const all = Object.values(parts).every(known);
    value[t.id] = { ...parts, critical_path_ms: all ? spanLen([...hulls.map((r) => [r.start, r.end]), ...reconcile, ...holds]) : UNAVAILABLE,
      label: worst([...t.by('review_round'), ...holdEvents].map((e) => e.label).concat(all ? [] : ['unavailable'])) };
  }
  const ids = Object.keys(value);
  return { value, label: ids.length ? worst(ids.map((i) => value[i].label)) : UNAVAILABLE, note: 'earliest dispatch of any lane to the last required result, plus reconciliation and gate holds, overlap counted once' };
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
    const failed = gates.filter((g) => g.outcome === 'fail');
    value[t.id] = { t2_runs: gates.length, t2_wall_ms: gates.every((g) => g.end > g.start) ? gates.reduce((n, g) => n + g.end - g.start, 0) : UNAVAILABLE,
      t0_class_failures: failed.every((g) => typeof g.metrics.t0_class === 'boolean') ? failed.filter((g) => g.metrics.t0_class === true).length : UNAVAILABLE,
      failed_runs: failed.length, dirty_runs: gates.filter((g) => g.metrics.clean === false).length, redundant_gate_executions: redundant };
  }
  const labels = started.flatMap((t) => t.by('gate_run').map((e) => e.label));
  return { value, label: Object.keys(value).length ? worst(labels) : UNAVAILABLE };
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
  const declared = started.length > 0 && started.every((t) => t.declared('usage'));
  const codexLane = started.some((t) => t.by('review_round').some((e) => /^codex/i.test(e.metrics.lane)));
  const claude = providerCost(ofProvider(mine, 'claude'));
  const codexUsed = ofProvider(mine, 'codex').length > 0 || codexLane;
  const codex = codexUsed ? providerCost(ofProvider(mine, 'codex')) : declared ? { usd: 'not_used', label: 'measured', records: 0 } : { usd: UNAVAILABLE, label: UNAVAILABLE, records: 0 };
  const providers = [['claude', claude], ['codex', codex]];
  const missing = providers.filter(([, c]) => c.usd === UNAVAILABLE).map(([n]) => n);
  const delivered = started.filter((t) => t.status === 'delivered').length;
  const numeric = declared && !missing.length;
  const total = numeric ? round6(providers.reduce((n, [, c]) => n + (known(c.usd) ? c.usd : 0), 0))
    : declared ? unavailableText(missing) : `unavailable: usage population not declared complete (measurement_complete scopes=usage)${missing.length ? `; ${unavailableText(missing)}` : ''}`;
  // A predecessor (superseded) run never delivered, whatever the ticket's final status.
  const bucket = (r) => { const t = ticketOfRun.get(r.run_id); return r.run_id !== t.head_run_id ? 'failed_or_abandoned' : t.status === 'delivered' ? 'delivered' : ['failed', 'abandoned'].includes(t.status) ? 'failed_or_abandoned' : t.status; };
  const bucketCost = (p, b) => { const list = ofProvider(mine, p).filter((r) => bucket(r) === b); return list.length ? providerCost(list).usd : UNAVAILABLE; };
  return { value: { claude, codex, total_usd: total,
    per_delivered_ticket_usd: typeof total === 'number' ? (delivered ? round6(total / delivered) : UNAVAILABLE) : total,
    delivered_tickets: delivered, delivered_claude_usd: bucketCost('claude', 'delivered'), failed_or_abandoned_claude_usd: bucketCost('claude', 'failed_or_abandoned'),
    failed_or_abandoned_codex_usd: bucketCost('codex', 'failed_or_abandoned'), censored_claude_usd: bucketCost('claude', 'censored'),
    models_used: [...new Set(mine.flatMap((r) => (Array.isArray(r.models_used) ? r.models_used : [])))].sort() },
  label: started.length ? worst(providers.filter(([, c]) => c.usd !== 'not_used').map(([, c]) => c.label).concat(numeric ? [] : ['unavailable'])) : UNAVAILABLE,
  note: 'List-equivalent cost of all attempts. The total is a number only when every actor population is declared complete and every provider record is priced; unknown is never 0.' };
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
  const [M2, M3] = m2m3(started);
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
