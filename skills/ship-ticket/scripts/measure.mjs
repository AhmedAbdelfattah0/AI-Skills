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
    need(metrics.occurrence === undefined || (Number.isInteger(metrics.occurrence) && metrics.occurrence > 0) || str('occurrence'), 'occurrence must be a positive integer or a short id');
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

// ---- the one completeness rule -------------------------------------------------------------------

const rank = { measured: 0, estimated: 1, unavailable: 2 };
const worst = (labels) => labels.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'measured');
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const spanLen = (spans) => union(spans).reduce((n, [a, b]) => n + b - a, 0);
const clip = (spans, [a, b]) => spans.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s);
const MAJOR = new Set(['major', 'blocker', 'critical']);

/**
 * The scope whose `measurement_complete` declaration says an input kind was recorded in full. `run` (the run log's own workflow,
 * phase and activity intervals) has no scope: every run carries it, and a missing endpoint makes the value unavailable by itself.
 * `reconcile` is the review_reconcile activity; `usage` is a usage record joined by run_id.
 */
export const SCOPE_OF_KIND = Object.freeze({ review_round: 'review', reconcile: 'review', confirmation: 'repair', repair_batch: 'repair', gate_run: 'gate',
  owner_decision: 'owner', host_sleep: 'sleep', finding: 'findings', usage: 'usage', run: null });

/** Polarity of an undeclared scope: `lower` = an unrecorded event can only raise the value, so what was seen is `{at_least}`; `none` = it could move either way (a subtraction, a ratio, an attainment), so the value is unavailable. */
const LOWER = 'lower', NONE = 'none';
const def = (path, label, kinds, scopes = {}, more = {}) => Object.freeze({ path, label, kinds: Object.freeze(kinds), scopes: Object.freeze(scopes), ceiling: 'measured', ...more });
const PT = (m, f) => `metrics.${m}.value.{ticket}.${f}`;
const COUNT = (f) => `tickets.{ticket}.counts.${f}`;
const W = (f) => `metrics.M5.value.{ticket}.*.${f}`;
const M5_LABEL = 'metrics.M5.value.{ticket}.*.label';
const M8_USAGE = { kinds: ['usage', 'review_round'], degrade_only: ['review_round'] };

/**
 * INPUT_SCOPES: every number the measurement prints, with the scopes it needs, their polarity, the event kinds it reads, where it is
 * printed (`path`; `{ticket}` is a ticket id, `*` any key) and where its label is printed. `ceiling` is the best label the value can
 * have (M5 is always derived from substitutions; M9/M10 have no source yet). `degrade_only` kinds are read only to make a value
 * unavailable (M8 reads review lanes to know Codex was used), so they add no label and need no scope.
 * `resolve` is the only function that turns a computed number into a printed value; it throws for a key that is not here.
 */
export const INPUT_SCOPES = Object.freeze({
  'counts.review_rounds': def(COUNT('review_rounds'), 'tickets.{ticket}.counts.label', ['review_round'], { review: LOWER }),
  'counts.repair_batches': def(COUNT('repair_batches'), 'tickets.{ticket}.counts.label', ['repair_batch'], { repair: LOWER }),
  'counts.confirmations': def(COUNT('confirmations'), 'tickets.{ticket}.counts.label', ['confirmation', 'review_round'], { repair: LOWER, review: LOWER }),
  'counts.gate_runs': def(COUNT('gate_runs'), 'tickets.{ticket}.counts.label', ['gate_run'], { gate: LOWER }),
  'counts.owner_waits': def(COUNT('owner_waits'), 'tickets.{ticket}.counts.label', ['owner_decision'], { owner: LOWER }),
  'counts.findings': def(COUNT('findings'), 'tickets.{ticket}.counts.label', ['finding'], { findings: LOWER }),
  // M1 is a share of a "first" round: an unrecorded earlier round can flip a pass, so no bound exists without the review scope.
  'M1.value': def('metrics.M1.value', 'metrics.M1.label', ['review_round'], { review: NONE }),
  'M1.numerator': def('metrics.M1.numerator', 'metrics.M1.label', ['review_round'], { review: NONE }),
  'M1.by_status': def('metrics.M1.by_status.*', 'metrics.M1.label', ['review_round'], { review: NONE }),
  'M1.incomplete_first_rounds': def('metrics.M1.incomplete_first_rounds', 'metrics.M1.label', ['review_round'], { review: NONE }),
  'M2.value': def('metrics.M2.value', 'metrics.M2.label', ['finding'], { findings: LOWER }),
  'M2.repeat_findings': def('metrics.M2.repeat_findings', 'metrics.M2.label', ['finding'], { findings: LOWER }),
  'M2.per_ticket': def('metrics.M2.per_ticket.{ticket}', 'metrics.M2.label', ['finding'], { findings: LOWER }),
  'M3.value': def('metrics.M3.value', 'metrics.M3.label', ['finding'], { findings: LOWER }),
  'M3.catchable_known': def('metrics.M3.catchable_known', 'metrics.M3.label', ['finding'], { findings: LOWER }),
  // an unrecorded re-emission of a seen fingerprint can classify it, so the unclassified count can fall: no bound.
  'M3.unclassified': def('metrics.M3.unclassified', 'metrics.M3.label', ['finding'], { findings: NONE }),
  'M3.of_distinct_findings': def('metrics.M3.of_distinct_findings', 'metrics.M3.label', ['finding'], { findings: LOWER }),
  'M4.rounds': def(PT('M4', 'rounds'), 'metrics.M4.label', ['review_round'], { review: LOWER }),
  'M4.batches': def(PT('M4', 'batches'), 'metrics.M4.label', ['repair_batch'], { repair: LOWER }),
  'M4.confirmations': def(PT('M4', 'confirmations'), 'metrics.M4.label', ['confirmation', 'review_round'], { repair: LOWER, review: LOWER }),
  'M4.repeat_findings': def(PT('M4', 'repeat_findings'), 'metrics.M4.label', ['finding'], { findings: LOWER }),
  'M4.tickets_within_target': def('metrics.M4.tickets_within_target', 'metrics.M4.label', ['review_round', 'repair_batch'], { review: NONE, repair: NONE }),
  'M5.elapsed_ms': def(W('elapsed_ms'), M5_LABEL, ['run'], {}, { ceiling: 'estimated' }),
  'M5.host_sleep_ms': def(W('host_sleep_ms'), M5_LABEL, ['host_sleep', 'run'], { sleep: LOWER }, { ceiling: 'estimated' }),
  // human wait = owner-wait time not covered by sleep: an unrecorded sleep can only lower it.
  'M5.human_wait_ms': def(W('human_wait_ms'), M5_LABEL, ['owner_decision', 'host_sleep', 'run'], { owner: LOWER, sleep: NONE }, { ceiling: 'estimated' }),
  'M5.awake_ms_with_wait': def(W('awake_ms_with_wait'), M5_LABEL, ['host_sleep', 'run'], { sleep: NONE }, { ceiling: 'estimated' }),
  'M5.awake_ms_excluding_wait': def(W('awake_ms_excluding_wait'), M5_LABEL, ['owner_decision', 'host_sleep', 'run'], { owner: NONE, sleep: NONE }, { ceiling: 'estimated' }),
  'M6.review_rounds_ms': def(PT('M6', 'review_rounds_ms'), 'metrics.M6.value.{ticket}.label', ['review_round'], { review: LOWER }),
  'M6.reconcile_ms': def(PT('M6', 'reconcile_ms'), 'metrics.M6.value.{ticket}.label', ['reconcile'], { review: LOWER }),
  'M6.gate_hold_ms': def(PT('M6', 'gate_hold_ms'), 'metrics.M6.value.{ticket}.label', ['gate_run'], { gate: LOWER }),
  'M6.critical_path_ms': def(PT('M6', 'critical_path_ms'), 'metrics.M6.value.{ticket}.label', ['review_round', 'reconcile', 'gate_run'], { review: LOWER, gate: LOWER }),
  'M7.t2_runs': def(PT('M7', 't2_runs'), 'metrics.M7.label', ['gate_run'], { gate: LOWER }),
  'M7.t2_wall_ms': def(PT('M7', 't2_wall_ms'), 'metrics.M7.label', ['gate_run'], { gate: LOWER }),
  'M7.t0_class_failures': def(PT('M7', 't0_class_failures'), 'metrics.M7.label', ['gate_run'], { gate: LOWER }),
  'M7.failed_runs': def(PT('M7', 'failed_runs'), 'metrics.M7.label', ['gate_run'], { gate: LOWER }),
  'M7.dirty_runs': def(PT('M7', 'dirty_runs'), 'metrics.M7.label', ['gate_run'], { gate: LOWER }),
  'M7.redundant_gate_executions': def(PT('M7', 'redundant_gate_executions'), 'metrics.M7.label', ['gate_run'], { gate: LOWER }),
  'M8.provider_usd': def('metrics.M8.value.*.usd', 'metrics.M8.value.*.label', M8_USAGE.kinds, { usage: LOWER }, { degrade_only: M8_USAGE.degrade_only }),
  'M8.provider_measured_usd': def('metrics.M8.value.*.measured_usd', 'metrics.M8.value.*.label', M8_USAGE.kinds, { usage: LOWER }, { degrade_only: M8_USAGE.degrade_only }),
  'M8.provider_estimated_usd': def('metrics.M8.value.*.estimated_usd', 'metrics.M8.value.*.label', M8_USAGE.kinds, { usage: LOWER }, { degrade_only: M8_USAGE.degrade_only }),
  'M8.total_usd': def('metrics.M8.value.total_usd', 'metrics.M8.label', M8_USAGE.kinds, { usage: NONE }, { degrade_only: M8_USAGE.degrade_only }),
  'M8.per_delivered_ticket_usd': def('metrics.M8.value.per_delivered_ticket_usd', 'metrics.M8.label', M8_USAGE.kinds, { usage: NONE }, { degrade_only: M8_USAGE.degrade_only }),
  'M8.delivered_claude_usd': def('metrics.M8.value.delivered_claude_usd', 'metrics.M8.label', ['usage'], { usage: LOWER }),
  'M8.failed_or_abandoned_claude_usd': def('metrics.M8.value.failed_or_abandoned_claude_usd', 'metrics.M8.label', ['usage'], { usage: LOWER }),
  'M8.failed_or_abandoned_codex_usd': def('metrics.M8.value.failed_or_abandoned_codex_usd', 'metrics.M8.label', ['usage'], { usage: LOWER }),
  'M8.censored_claude_usd': def('metrics.M8.value.censored_claude_usd', 'metrics.M8.label', ['usage'], { usage: LOWER }),
  'M9.value': def('metrics.M9.value', 'metrics.M9.label', ['run'], {}, { ceiling: 'unavailable' }),
  'M9.deferred_findings': def('metrics.M9.deferred_findings.*', 'metrics.M9.deferred_findings_label', ['finding'], { findings: LOWER }),
  'M10.value': def('metrics.M10.value', 'metrics.M10.label', [], {}, { ceiling: 'unavailable' }),
});

/** Numbers that describe the recorded data itself (who is in the population, how many records were read), not a claim about the work; printed exactly. */
export const BOOKKEEPING = Object.freeze({
  'populations.tickets.*': 'tickets by head-run status: the population, from run outcomes',
  'populations.run_modes.*': 'run_mode events as recorded (modes, not runs)',
  'populations.invalid_events': 'malformed events skipped',
  'metrics.M1.denominator': 'started tickets (H: failed, abandoned and censored included)',
  'metrics.M1.started_by_status.*': 'started tickets by status',
  'metrics.M1.unrecorded_reviews': 'started tickets with no review recorded and no review scope',
  'metrics.M1.undeclared_review_tickets': 'started tickets with recorded review events but no review scope',
  'metrics.M4.of': 'tickets whose review and repair scopes are both declared',
  'metrics.M4.unrecorded_tickets': 'started tickets without both scopes',
  'metrics.M8.value.*.records': 'usage records read for the provider',
  'metrics.M8.value.*.unknown_records': 'usage records without a cost',
  'metrics.M8.value.delivered_tickets': 'delivered tickets (the M8 divisor)',
});

function spec(key) {
  const s = INPUT_SCOPES[key];
  if (!s) throw new Error(`measure: ${key} is not registered in INPUT_SCOPES`);
  return s;
}

/** The inputs `key` may read, from the tickets of `pop`; reading a kind the table does not register throws. */
function read(key, pop, kind) {
  const s = spec(key);
  const kinds = kind === undefined ? s.kinds : [kind];
  for (const k of kinds) if (!s.kinds.includes(k)) throw new Error(`measure: ${key} reads ${k}, which INPUT_SCOPES does not register`);
  return pop.flatMap((t) => kinds.flatMap((k) => t.inputs[k] ?? []));
}

/**
 * The one completeness decision. `raw` is the number computed from `used`, the inputs actually read (default: every registered kind of
 * the population). Every scope declared by every ticket of `pop` -> the number, labelled the worst of its inputs and the ceiling.
 * A missing scope -> `{at_least}` labelled at best `estimated` when every missing scope is `lower` and something was seen (raw > 0),
 * else `unavailable`. An uncomputable raw is `unavailable`.
 */
export function resolve(key, pop, raw, used = read(key, pop)) {
  const s = spec(key);
  for (const e of used) if (!s.kinds.includes(e.name)) throw new Error(`measure: ${key} used ${e.name}, which INPUT_SCOPES does not register`);
  if (!known(raw) || !pop.length) return { value: UNAVAILABLE, label: UNAVAILABLE };
  const labels = [s.ceiling, ...used.filter((e) => !(s.degrade_only ?? []).includes(e.name)).map((e) => e.label)];
  const missing = Object.keys(s.scopes).filter((scope) => !pop.every((t) => t.scopes.has(scope)));
  if (!missing.length) return { value: raw, label: worst(labels) };
  if (raw > 0 && missing.every((scope) => s.scopes[scope] === LOWER)) return { value: { at_least: raw }, label: worst([...labels, 'estimated']) };
  return { value: UNAVAILABLE, label: UNAVAILABLE };
}

/** A printer for one labelled object: each value goes through `resolve`; the object's label is the worst label of the values it printed. */
function printer() {
  const labels = [];
  const put = (key, pop, raw, used) => {
    const r = resolve(key, pop, raw, used);
    if (r.value !== UNAVAILABLE) labels.push(r.label);
    return r.value;
  };
  put.label = (extra = []) => (labels.length ? worst([...labels, ...extra]) : UNAVAILABLE);
  return put;
}

// ---- events -------------------------------------------------------------------------------------

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
 * the identity (a recovery run numbers from 1 again), and so is the candidate/packet of a lane. A repeat finding without a round is
 * told apart by its timestamps and an emitter-supplied `occurrence`; an owner decision by its times (two sessions may both number from 1).
 */
function logicalKey(e) {
  const m = e.metrics, r = e.run_id;
  switch (e.name) {
    case 'review_round': return `${r}|${m.n}|${m.lane}|${m.candidate_sha ?? ''}|${m.packet_sha256 ?? ''}`;
    case 'repair_batch': case 'confirmation': case 'gate_run': return `${r}|${m.n}`;
    case 'owner_decision': return `${r}|${m.n}|${e.start}|${e.end}`;
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
const costOf = (r) => (known(r.reported_cost_usd) && r.cost_basis === 'list' ? { usd: r.reported_cost_usd, label: 'measured' }
  : known(r.estimated_cost_usd) ? { usd: r.estimated_cost_usd, label: 'estimated' } : null);

/** Tickets of `runs`: status, head run (the one no run supersedes), declared scopes, and the inputs by kind that only `read` hands out. */
function assemble(runs, bad, records) {
  const byTicket = new Map();
  for (const run of runs) byTicket.set(run.ticket, [...(byTicket.get(run.ticket) ?? []), run]);
  const tickets = [];
  for (const [id, list] of byTicket) {
    const events = dedupe(list.flatMap((r) => eventsOf(r, bad)));
    const superseded = new Set(events.filter((e) => e.name === 'run_mode' && e.metrics.supersedes_run_id).map((e) => e.metrics.supersedes_run_id));
    const first = (r) => Math.min(...r.intervals.map((i) => Date.parse(i.started_at)).concat(r.open_intervals.map((i) => Date.parse(i.started_at))), Infinity);
    const heads = list.filter((r) => !superseded.has(r.run_id)).sort((a, b) => first(a) - first(b));
    const head = heads.at(-1) ?? list.at(-1);
    const inputs = {};
    for (const e of events) (inputs[e.name] ??= []).push(e);
    const intervals = list.flatMap((r) => r.intervals.map((i) => ({ i, run_id: r.run_id })));
    inputs.run = intervals.map(({ i, run_id }) => ({ name: 'run', kind: i.kind, interval: i.name, run_id, start: Date.parse(i.started_at), end: Date.parse(i.ended_at), label: 'measured' }));
    inputs.reconcile = intervals.filter(({ i }) => i.kind === 'activity' && REVIEW_ROLE_OF[i.name] === 'reconcile').map(({ i, run_id }) => ({ name: 'reconcile', run_id,
      start: Date.parse(i.carrier_timing?.started_at ?? i.started_at), end: Date.parse(i.carrier_timing?.ended_at ?? i.ended_at), label: 'measured' }));
    const runIds = new Set(list.map((r) => r.run_id));
    inputs.usage = records.filter((r) => r && runIds.has(r.run_id)).map((record) => ({ name: 'usage', run_id: record.run_id, record, label: costOf(record)?.label ?? UNAVAILABLE }));
    const t = { id, instrumented: events.length > 0, status: STATUS[head.outcome] ?? 'unknown', head_run_id: head.run_id, runs: list.map((r) => r.run_id), inputs,
      // Only the head run's declaration counts: it covers the whole ticket (predecessor runs included); a superseded run cannot vouch for its successor.
      scopes: new Set((inputs.measurement_complete ?? []).filter((e) => e.run_id === head.run_id).flatMap((e) => e.metrics.scopes.split(','))) };
    const put = printer();
    t.counts = { review_rounds: put('counts.review_rounds', [t], nDistinct(read('counts.review_rounds', [t]))),
      repair_batches: put('counts.repair_batches', [t], nDistinct(read('counts.repair_batches', [t]))),
      confirmations: put('counts.confirmations', [t], confirmationsOf('counts.confirmations', t)),
      gate_runs: put('counts.gate_runs', [t], read('counts.gate_runs', [t]).length), owner_waits: put('counts.owner_waits', [t], read('counts.owner_waits', [t]).length),
      findings: put('counts.findings', [t], read('counts.findings', [t]).length) };
    t.counts.label = put.label();
    tickets.push(t);
  }
  return tickets;
}
const nDistinct = (events) => new Set(events.map((e) => `${e.run_id}|${e.metrics.n}`)).size;
/** Confirmation rounds: `confirmation` events and `review_round` rows of kind confirmation, one per run and n. */
const confirmationsOf = (key, t) => nDistinct([...read(key, [t], 'confirmation'), ...read(key, [t], 'review_round').filter((e) => e.metrics.round_kind === 'confirmation')]);

// ---- metrics ------------------------------------------------------------------------------------

function m1(started) {
  const put = printer();
  const by = { delivered: 0, failed: 0, abandoned: 0, censored: 0 };
  const startedBy = { ...by };
  let numerator = 0, incomplete = 0, unrecorded = 0, undeclared = 0;
  for (const t of started) {
    if (t.status in startedBy) startedBy[t.status] += 1;
    const rounds = read('M1.value', [t]);
    if (!t.scopes.has('review')) { if (rounds.length) undeclared += 1; else unrecorded += 1; }
    const originals = rounds.filter((e) => e.metrics.round_kind === 'original');
    if (!originals.length) continue; // with the review scope declared: no first review, so not accepted on first pass
    const n = Math.min(...originals.map((e) => e.metrics.n));
    const lanes = rounds.filter((e) => e.metrics.n === n && e.run_id === originals.find((o) => o.metrics.n === n).run_id);
    if (lanes.length < 2 || lanes.some((e) => e.metrics.verdict === UNAVAILABLE || !isCount(e.metrics.majors))) incomplete += 1;
    if (lanes.length >= 2 && lanes.every((e) => e.metrics.verdict === 'PASS' && e.metrics.majors === 0)) { numerator += 1; if (t.status in by) by[t.status] += 1; }
  }
  const value = put('M1.value', started, started.length ? Math.round(numerator / started.length * 1000) / 1000 : UNAVAILABLE);
  return { value, numerator: put('M1.numerator', started, numerator), denominator: started.length,
    by_status: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, put('M1.by_status', started, v)])), started_by_status: startedBy,
    unrecorded_reviews: unrecorded, undeclared_review_tickets: undeclared, incomplete_first_rounds: put('M1.incomplete_first_rounds', started, incomplete), label: put.label() };
}

const SEVERE = (e) => MAJOR.has(String(e.metrics.severity).toLowerCase());
function m2m3(started) {
  const p2 = printer(), p3 = printer();
  const findings = started.flatMap((t) => read('M2.value', [t]).map((e) => ({ t, e })));
  const majors = new Set(), per = new Map();
  for (const { t, e } of findings.filter(({ e }) => SEVERE(e))) {
    const key = `${t.id}|${e.metrics.fingerprint}`;
    if (!majors.has(key)) { majors.add(key); per.set(t, (per.get(t) ?? 0) + 1); }
  }
  // M3: every distinct finding that reached review or a gate, whatever its severity, classified by builder_catchable.
  const distinct = new Map();
  for (const { t, e } of findings) {
    const key = `${t.id}|${e.metrics.fingerprint}`;
    const c = typeof e.metrics.builder_catchable === 'boolean' ? e.metrics.builder_catchable : undefined;
    const prev = distinct.get(key);
    distinct.set(key, prev === undefined || prev === false ? (c ?? prev) : prev);
  }
  const classified = [...distinct.values()].filter((v) => typeof v === 'boolean');
  const catchable = classified.filter(Boolean).length, unclassified = distinct.size - classified.length;
  const M2 = { value: p2('M2.value', started, majors.size), per_ticket: Object.fromEntries([...per].map(([t, n]) => [t.id, p2('M2.per_ticket', [t], n)])),
    repeat_findings: p2('M2.repeat_findings', started, findings.filter(({ e }) => e.metrics.repeat === true).length) };
  M2.label = p2.label();
  const value = p3('M3.value', started, distinct.size && !classified.length ? UNAVAILABLE : catchable);
  const M3 = { value: unclassified && value !== UNAVAILABLE ? 'partial' : value, catchable_known: p3('M3.catchable_known', started, catchable),
    unclassified: p3('M3.unclassified', started, unclassified), of_distinct_findings: p3('M3.of_distinct_findings', started, distinct.size) };
  M3.label = p3.label(unclassified ? ['estimated'] : []);
  return [M2, M3];
}

function m4(started) {
  const put = printer();
  const value = {};
  let of = 0, within = 0;
  for (const t of started) {
    const rounds = nDistinct(read('M4.rounds', [t])), batches = nDistinct(read('M4.batches', [t]));
    value[t.id] = { rounds: put('M4.rounds', [t], rounds), batches: put('M4.batches', [t], batches), confirmations: put('M4.confirmations', [t], confirmationsOf('M4.confirmations', t)),
      repeat_findings: put('M4.repeat_findings', [t], read('M4.repeat_findings', [t]).filter((e) => e.metrics.repeat === true).length), status: t.status };
    if (t.scopes.has('review') && t.scopes.has('repair')) of += 1;
    if (rounds <= 2 && batches <= 1) within += 1;
  }
  return { value, tickets_within_target: put('M4.tickets_within_target', started, within), of, unrecorded_tickets: started.length - of, label: put.label() };
}

const NA = (missing) => ({ value: UNAVAILABLE, label: UNAVAILABLE, missing });

function m5(started) {
  const value = {};
  for (const t of started) {
    const run = read('M5.elapsed_ms', [t]);
    const phase = (name) => run.filter((i) => i.kind === 'phase' && i.interval === name);
    const sleeps = read('M5.host_sleep_ms', [t], 'host_sleep'), waits = read('M5.human_wait_ms', [t], 'owner_decision');
    const window = (a, b, substitutions) => {
      const put = printer();
      const sleep = spanLen(clip(sleeps.map((e) => [e.start, e.end]), [a, b]));
      const human = spanLen(clip([...sleeps, ...waits].map((e) => [e.start, e.end]), [a, b])) - sleep;
      const out = { elapsed_ms: put('M5.elapsed_ms', [t], b - a), host_sleep_ms: put('M5.host_sleep_ms', [t], sleep), human_wait_ms: put('M5.human_wait_ms', [t], human),
        awake_ms_with_wait: put('M5.awake_ms_with_wait', [t], b - a - sleep), awake_ms_excluding_wait: put('M5.awake_ms_excluding_wait', [t], b - a - sleep - human), substitutions };
      out.label = put.label();
      return out;
    };
    const headWorkflow = run.filter((i) => i.run_id === t.head_run_id && i.kind === 'workflow').at(-1);
    const begin = Math.min(...run.map((i) => i.start), Infinity);
    const planEnd = phase('PLAN').length ? Math.max(...phase('PLAN').map((i) => i.end)) : NaN;
    const shipStart = phase('SHIP').length ? Math.min(...phase('SHIP').map((i) => i.start)) : NaN;
    const a = [!known(planEnd) && 'plan approval (PLAN phase end)', !known(shipStart) && 'SHIP_READY (SHIP phase start)'].filter(Boolean);
    const b = [t.status !== 'delivered' && 'merge (the head run is not delivered)', !headWorkflow && 'merge (head run workflow end)', !known(begin) && 'first skill invocation (no interval)'].filter(Boolean);
    value[t.id] = {
      M5a: a.length || shipStart <= planEnd ? NA(a.length ? a : ['SHIP_READY after plan approval']) : window(planEnd, shipStart, ['approval = PLAN phase end', 'SHIP_READY = SHIP phase start (no SHIP_READY event is recorded)']),
      M5b: b.length ? NA(b) : window(begin, headWorkflow.end, ['first skill invocation = first recorded interval start', 'merge = head run workflow end (no merge event is recorded)']) };
  }
  const parts = Object.values(value).flatMap((v) => [v.M5a, v.M5b]).filter((v) => v.label !== UNAVAILABLE);
  return { value, label: parts.length ? worst(parts.map((p) => p.label)) : UNAVAILABLE,
    note: 'M5a = approval to SHIP_READY, M5b = first invocation to merge; both use the named substitutions and are therefore estimated. Host sleep is excluded; an unrecorded sleep or wait is unavailable, never 0.' };
}

function m6(started) {
  const value = {};
  for (const t of started) {
    const roundEvents = read('M6.review_rounds_ms', [t]);
    if (!roundEvents.length && !t.scopes.has('review')) continue;
    const rounds = new Map();
    for (const e of roundEvents) {
      const key = `${e.run_id}|${e.metrics.n}`;
      const r = rounds.get(key) ?? { start: Infinity, end: -Infinity, ok: true, required: false };
      r.start = Math.min(r.start, e.start); // every lane's dispatch counts toward the start (dispatch skew)
      if (e.metrics.required !== false) { r.required = true; r.end = Math.max(r.end, e.end); r.ok &&= e.end > e.start; }
      rounds.set(key, r);
    }
    const hulls = [...rounds.values()];
    const wall = hulls.every((r) => r.required && r.ok && r.end > r.start) ? spanLen(hulls.map((r) => [r.start, r.end])) : UNAVAILABLE;
    const reconcile = read('M6.reconcile_ms', [t]).map((e) => [e.start, e.end]);
    const holds = read('M6.gate_hold_ms', [t]).filter((e) => e.metrics.holds_review === true && known(e.metrics.hold_ms)).map((e) => [e.start, e.start + e.metrics.hold_ms]);
    const put = printer();
    value[t.id] = { review_rounds_ms: put('M6.review_rounds_ms', [t], wall), reconcile_ms: put('M6.reconcile_ms', [t], spanLen(reconcile)),
      gate_hold_ms: put('M6.gate_hold_ms', [t], spanLen(holds)),
      critical_path_ms: put('M6.critical_path_ms', [t], known(wall) ? spanLen([...hulls.map((r) => [r.start, r.end]), ...reconcile, ...holds]) : UNAVAILABLE) };
    value[t.id].label = put.label();
  }
  const ids = Object.keys(value);
  return { value, label: ids.length ? worst(ids.map((i) => value[i].label)) : UNAVAILABLE, note: 'earliest dispatch of any lane to the last required result, plus reconciliation and gate holds, overlap counted once' };
}

function m7(started) {
  const value = {};
  const put = printer();
  for (const t of started) {
    const gates = read('M7.t2_runs', [t]);
    if (!gates.length && !t.scopes.has('gate')) continue;
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
    value[t.id] = { t2_runs: put('M7.t2_runs', [t], gates.length),
      t2_wall_ms: put('M7.t2_wall_ms', [t], gates.every((g) => g.end > g.start) ? gates.reduce((n, g) => n + g.end - g.start, 0) : UNAVAILABLE),
      t0_class_failures: put('M7.t0_class_failures', [t], failed.every((g) => typeof g.metrics.t0_class === 'boolean') ? failed.filter((g) => g.metrics.t0_class === true).length : UNAVAILABLE),
      failed_runs: put('M7.failed_runs', [t], failed.length), dirty_runs: put('M7.dirty_runs', [t], gates.filter((g) => g.metrics.clean === false).length),
      redundant_gate_executions: put('M7.redundant_gate_executions', [t], redundant) };
  }
  return { value, label: put.label() };
}

/** Raw cost of usage inputs: a number only when every record has one (never a partial sum presented as the total). */
function priceOf(used) {
  const none = { usd: UNAVAILABLE, measured: UNAVAILABLE, estimated: UNAVAILABLE, unknown: 0 };
  if (!used.length) return none;
  const priced = used.map((e) => costOf(e.record));
  const unknown = priced.filter((p) => p === null).length;
  if (unknown) return { ...none, unknown };
  const sum = (label) => round6(priced.filter((p) => p.label === label).reduce((n, p) => n + p.usd, 0));
  const measured = sum('measured'), estimated = sum('estimated');
  return { usd: round6(measured + estimated), measured, estimated, unknown: 0 };
}
const unavailableText = (names) => (names.length ? `${names.map((n) => n[0].toUpperCase() + n.slice(1)).join(' and ')} unavailable` : UNAVAILABLE);

function m8(started) {
  const put = printer();
  const usage = read('M8.total_usd', started, 'usage');
  const ofProvider = (list, p) => list.filter((e) => e.record.provider === p);
  const declared = started.length > 0 && started.every((t) => t.scopes.has('usage'));
  const codexLane = read('M8.total_usd', started, 'review_round').some((e) => /^codex/i.test(String(e.metrics.lane)));
  const notUsed = (p) => p === 'codex' && !ofProvider(usage, p).length && !codexLane;
  const provider = (p) => {
    if (notUsed(p)) return declared ? { usd: 'not_used', label: 'measured', records: 0 } : { usd: UNAVAILABLE, label: UNAVAILABLE, records: 0 };
    const used = ofProvider(usage, p), raw = priceOf(used), own = printer();
    const out = { usd: own('M8.provider_usd', started, raw.usd, used), measured_usd: own('M8.provider_measured_usd', started, raw.measured, used),
      estimated_usd: own('M8.provider_estimated_usd', started, raw.estimated, used) };
    return { ...out, label: own.label(), records: used.length, ...(raw.unknown ? { unknown_records: raw.unknown } : {}) };
  };
  const claude = provider('claude'), codex = provider('codex');
  const providers = [['claude', claude], ['codex', codex]];
  const rawTotal = providers.every(([p]) => notUsed(p) || known(priceOf(ofProvider(usage, p)).usd))
    ? round6(providers.reduce((n, [p]) => n + (notUsed(p) ? 0 : priceOf(ofProvider(usage, p)).usd), 0)) : UNAVAILABLE;
  const missing = providers.filter(([, c]) => c.usd === UNAVAILABLE).map(([n]) => n);
  const resolved = put('M8.total_usd', started, rawTotal);
  const total = resolved !== UNAVAILABLE ? resolved
    : declared ? unavailableText(missing) : `unavailable: usage population not declared complete (measurement_complete scopes=usage)${missing.length ? `; ${unavailableText(missing)}` : ''}`;
  const delivered = started.filter((t) => t.status === 'delivered').length;
  const perDelivered = put('M8.per_delivered_ticket_usd', started, known(rawTotal) && delivered ? round6(rawTotal / delivered) : UNAVAILABLE);
  // A predecessor (superseded) run never delivered, whatever the ticket's final status.
  const ticketOfRun = new Map(started.flatMap((t) => t.runs.map((r) => [r, t])));
  const bucket = (e) => { const t = ticketOfRun.get(e.run_id); return e.run_id !== t.head_run_id ? 'failed_or_abandoned' : t.status === 'delivered' ? 'delivered' : ['failed', 'abandoned'].includes(t.status) ? 'failed_or_abandoned' : t.status; };
  const bucketCost = (key, p, b) => { const list = ofProvider(read(key, started), p).filter((e) => bucket(e) === b); return put(key, started, list.length ? priceOf(list).usd : UNAVAILABLE, list); };
  return { value: { claude, codex, total_usd: total, per_delivered_ticket_usd: perDelivered !== UNAVAILABLE ? perDelivered : typeof total === 'string' ? total : UNAVAILABLE,
    delivered_tickets: delivered, delivered_claude_usd: bucketCost('M8.delivered_claude_usd', 'claude', 'delivered'),
    failed_or_abandoned_claude_usd: bucketCost('M8.failed_or_abandoned_claude_usd', 'claude', 'failed_or_abandoned'),
    failed_or_abandoned_codex_usd: bucketCost('M8.failed_or_abandoned_codex_usd', 'codex', 'failed_or_abandoned'), censored_claude_usd: bucketCost('M8.censored_claude_usd', 'claude', 'censored'),
    models_used: [...new Set(usage.flatMap((e) => (Array.isArray(e.record.models_used) ? e.record.models_used : [])))].sort() },
  label: started.length ? worst(providers.filter(([, c]) => c.usd !== 'not_used').map(([, c]) => c.label).concat(put.label() === UNAVAILABLE ? [] : [put.label()], typeof total === 'number' ? [] : ['unavailable'])) : UNAVAILABLE,
  note: 'List-equivalent cost of all attempts. The total is a number only when every actor population is declared complete and every provider record is priced; unknown is never 0.' };
}

function m9(started, now) {
  const put = printer();
  const bySeverity = new Map();
  for (const e of read('M9.deferred_findings', started).filter((x) => x.metrics.deferred === true)) bySeverity.set(e.metrics.severity, [...(bySeverity.get(e.metrics.severity) ?? []), e]);
  const deferred = Object.fromEntries([...bySeverity].map(([sev, list]) => [sev, put('M9.deferred_findings', started, list.length, list)]));
  const windows = started.filter((t) => t.status === 'delivered').map((t) => {
    const merged = read('M9.value', [t]).filter((i) => i.run_id === t.head_run_id && i.kind === 'workflow').at(-1)?.end ?? NaN;
    return { ticket: t.id, merged_at: known(merged) ? new Date(merged).toISOString() : UNAVAILABLE,
      matures_at: known(merged) ? new Date(merged + 30 * DAY_MS).toISOString() : UNAVAILABLE, matured: known(merged) ? now >= merged + 30 * DAY_MS : false };
  });
  const pending = !windows.length || windows.some((w) => !w.matured);
  const { label } = resolve('M9.value', started, UNAVAILABLE); // no tracker defect links exist yet: always unavailable
  return { value: pending ? M9_PENDING : 'unavailable: no tracker defect links are recorded (S-04 has no source for escapes)', label, windows,
    deferred_findings: deferred, deferred_findings_label: put.label() };
}

/**
 * M1-M10 over `runs` (buildRun results; several tickets allowed). Only tickets with at least one S-04 event are measured; the rest are
 * counted as `uninstrumented` and left out of every denominator.
 * @param {object[]} runs
 * @param {{records?: object[], now?: number}} [sources] usage records (joined by run_id) and the clock for the M9 window
 */
export function measurementOf(runs, { records = [], now = Date.now() } = {}) {
  const bad = { count: 0 };
  const tickets = assemble(runs, bad, Array.isArray(records) ? records : []);
  const started = tickets.filter((t) => t.instrumented);
  const populations = { tickets: { started: started.length, delivered: 0, failed: 0, abandoned: 0, censored: 0, unknown: 0,
    uninstrumented: tickets.length - started.length }, run_modes: {}, invalid_events: bad.count };
  for (const t of started) {
    populations.tickets[t.status] += 1;
    for (const e of t.inputs.run_mode ?? []) populations.run_modes[e.metrics.mode] = (populations.run_modes[e.metrics.mode] ?? 0) + 1;
  }
  const [M2, M3] = m2m3(started);
  return { schema: MEASURE_SCHEMA, labels: { measured: 'read from a recorded event or provider counter', estimated: 'derived or priced; never a recorded fact', unavailable: 'the source did not carry it; never 0' },
    populations,
    tickets: Object.fromEntries(started.map((t) => [t.id, { status: t.status, head_run_id: t.head_run_id, instrumented: true, runs: t.runs, counts: t.counts }])),
    metrics: { M1: m1(started), M2, M3, M4: m4(started), M5: m5(started), M6: m6(started), M7: m7(started), M8: m8(started), M9: m9(started, now),
      M10: { value: resolve('M10.value', started, UNAVAILABLE).value, label: UNAVAILABLE, reason: 'needs the S-24 eligibility record and S-16 replays; S-04 does not produce them' } } };
}

/** True when any run carries an S-04 event (decides whether eval adds a `measurement` block). */
export const hasMeasurementEvents = (runs) => runs.some((r) => r.intervals.some((i) => EVENT_KIND[i.name] === i.kind));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] !== 'owner-waits' || !opt('session')) { process.stderr.write('usage: measure.mjs owner-waits --session <session.jsonl> [--since <iso>] [--until <iso>]\n'); process.exit(1); }
  process.stdout.write(`${JSON.stringify(ownerDecisionsFromSession(readFileSync(opt('session'), 'utf8'), { since: opt('since'), until: opt('until') }), null, 2)}\n`);
}
