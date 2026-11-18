/**
 * S-04a2 measurement event contract (S-04c-design §1.2): the closed event vocabulary, its validator (on lib/shape.mjs),
 * the ONE encoder of S-04 rows, and the R11 torn-record reader rule. No I/O; run-log-io.mjs appends, run-log.mjs is the CLI.
 *
 * Rows stay ship-ticket-run-log-v1. One event = a start row (`metrics: {}`, no payload) and an end row carrying
 * `metrics: {label, ...}` and the optional `detail`, encoded together and appended in ONE write. A schema below is DATA:
 * the shape spec, the string policy, CLI value typing and the event_id derivation all come from it (no second list).
 * Every string in metrics/detail is SAFE_ID (some fields stricter), except `ts` fields. Unknown keys are refused.
 *
 * R11 (torn tail; rule adopted from deepseek-harness session-persistence-jsonl `SessionLogScanner`, no code copied): bytes
 * after the last LF are a torn tail, and a final complete line that is an S-04 START row is a torn record (its end row was
 * part of the same write). Both are ignored by readers and truncated before the next append. Lines are split on the LF
 * byte first, then each is decoded strictly (fatal UTF-8): an undecodable line is reported, never replaced.
 */
import { isTimestamp, validate } from '../lib/shape.mjs';

/** The run-log row schema literal: held here only (the encoder's module); run-log.mjs imports it. */
export const RUN_LOG_SCHEMA = 'ship-ticket-run-log-v1';
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX = /^[a-f0-9]{7,64}$/, SHA256 = /^[a-f0-9]{64}$/, REVIEW_EXEC = /^review-[A-Za-z0-9._-]{1,120}$/;
export const ROW_BYTES_MAX = 65536;
const LIMITS = { maxDepth: 6, maxItems: 1000, maxNodes: 20000, maxProblems: 20 };

const E = (values, opt) => ({ enum: values, ...(opt ? { optional: true } : {}) });
const LABEL = { label: E(['measured', 'estimated']) };
export const CLOSABLE = Object.freeze(['review_lane', 'repair_batch', 'gate_run', 'owner_decision', 'host_sleep', 'milestone', 'usage']);
export const CLOSURE_PAIRS = Object.freeze(['engine/engine_state', 'orchestrator/orchestrator_tally', 'orchestrator/posthoc']);
/** Usage providers a closure may count: the usage.mjs PROVIDERS set. */
export const USAGE_PROVIDERS = Object.freeze(['claude', 'codex', 'gemini', 'antigravity']);
const opt = (spec) => ({ ...spec, optional: true });
const counts = { object: { ...Object.fromEntries(CLOSABLE.filter((k) => k !== 'usage').map((k) => [k, '?uint'])),
  usage: opt({ object: Object.fromEntries(USAGE_PROVIDERS.map((p) => [p, '?uint'])) }) } };

/**
 * name -> { kind, point (start == end), metrics, detail?, pattern (stricter per-field string rules), id (canonical event_id) }.
 * `id: null` = the caller names the event (identity is the event_id itself).
 */
export const EVENTS = Object.freeze({
  run_mode: { kind: 'activity', point: true, id: null,
    metrics: { ...LABEL, mode: E(['engine', 'supervised', 'recovery', 'fallback']), supersedes_run_id: '?string', parent: '?string', reason: '?string' } },
  review_lane: { kind: 'activity', id: (m) => `rv-${m.review_execution}-${m.lane_role}-${m.attempt}`,
    pattern: { review_execution: REVIEW_EXEC, candidate_sha: HEX, packet_sha256: SHA256 },
    metrics: { ...LABEL, review_execution: 'string', exec_event_id: 'string', n: 'posint', round_kind: E(['original', 'confirmation']),
      lane_role: E(['primary', 'second_opinion']), provider: E(['claude', 'codex', 'coderabbit']), attempt: 'posint',
      result: E(['verdict', 'timeout', 'cancelled', 'infra_failed', 'no_result']), verdict: E(['PASS', 'FAIL'], true),
      majors: '?uint', minors: '?uint', candidate_sha: 'string', packet_sha256: '?string' } },
  repair_batch: { kind: 'activity', id: (m) => `repair_batch-${m.n}`,
    metrics: { ...LABEL, n: 'posint', authority_event_id: '?string' }, detail: { finding_ids: { arrayOf: 'string' } } },
  gate_run: { kind: 'activity', id: (m) => `gate_run-${m.n}`, pattern: { head_sha: HEX, manifest_sha256: SHA256 },
    metrics: { ...LABEL, n: 'posint', head_sha: 'string', clean: 'boolean', hold_ms: '?uint' },
    detail: { per_gate: { arrayOf: { object: { name: 'string', ms: 'uint', exit: 'int', key: 'string', t0_class: 'string' } } }, manifest_sha256: '?string' } },
  owner_decision: { kind: 'wait', id: (m) => `owner_decision-${m.n}`,
    metrics: { ...LABEL, n: 'posint', class: E(['plan_approval', 'retry_grant', 'scope', 'merge', 'other']), retries_granted: '?uint' } },
  host_sleep: { kind: 'wait', id: null, metrics: { ...LABEL } },
  milestone: { kind: 'activity', point: true, id: (m) => `milestone-${m.at}`,
    metrics: { ...LABEL, at: E(['plan_approved', 'ship_ready', 'merged', 'failed', 'abandoned']) } },
  finding: { kind: 'activity', point: true, id: (m) => `finding-${m.fingerprint}-${m.occurrence}`,
    metrics: { ...LABEL, fingerprint: 'string', severity: E(['Blocker', 'Major', 'Minor', 'Info']), repeat: 'boolean', occurrence: 'posint' } },
  closure: { kind: 'activity', point: true, id: (m) => `closure-${m.through.replace(/[-:.]/g, '')}-${m.final ? 'final' : 'interim'}`,
    pattern: { state_sha256: SHA256 },
    metrics: { ...LABEL, through: 'ts', final: 'boolean', emitter: E(['engine', 'orchestrator']),
      count_source: E(['engine_state', 'orchestrator_tally', 'posthoc']), state_sha256: '?string', state_seq: '?uint' },
    detail: { counts } },
});
export const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));
export const isEventName = (name) => typeof name === 'string' && Object.hasOwn(EVENTS, name);
/** The legacy row set (V §4.2 rule 2): every row whose name is an S-04 event name removed. */
export const legacyRows = (rows) => rows.filter((row) => !isEventName(row?.name));

/** How the CLI types a raw `--metric` value of `name`'s `key`: 'string' (kept verbatim), 'int' or 'boolean'. */
export function fieldType(name, key) {
  const spec = isEventName(name) && Object.hasOwn(EVENTS[name].metrics, key) ? EVENTS[name].metrics[key] : 'string';
  const tok = typeof spec === 'string' ? spec.replace(/^\?/, '') : 'string';
  return ['posint', 'uint', 'int'].includes(tok) ? 'int' : tok === 'boolean' ? 'boolean' : 'string';
}

const own = (o, k) => Reflect.getOwnPropertyDescriptor(o, k)?.value;
/** SAFE_ID (or the field's stricter pattern) for every string leaf; data already passed shape validation, so it is plain and bounded. */
function stringProblems(input, def, problems) {
  const stack = [];
  for (const part of ['metrics', 'detail']) {
    const obj = own(input, part), specs = (part === 'metrics' ? def.metrics : def.detail) ?? {};
    if (obj !== undefined) for (const k of Reflect.ownKeys(obj)) if (specs[k] !== 'ts') stack.push([own(obj, k), `/${part}/${String(k)}`, def.pattern?.[k] ?? SAFE_ID]);
  }
  while (stack.length) {
    const [v, path, pattern] = stack.pop();
    if (typeof v === 'string') { if (!pattern.test(v)) problems.push({ code: 'bad_string', path }); continue; }
    if (v && typeof v === 'object') for (const k of Reflect.ownKeys(v)) stack.push([own(v, k), `${path}/${String(k)}`, SAFE_ID]);
  }
}

/** Closed-schema validation of one event's metrics and detail. Never throws; `{ ok, problems: [{code, path}] }`. */
export function validateEvent(name, metrics, detail) {
  if (!isEventName(name)) return { ok: false, problems: [{ code: 'unknown_event', path: '' }] };
  const def = EVENTS[name];
  const shape = { object: { metrics: { object: def.metrics }, ...(def.detail ? { detail: { object: def.detail } } : {}) } };
  const input = detail === undefined ? { metrics } : { metrics, detail };
  const r = validate(input, shape, LIMITS);
  if (!r.ok) return { ok: false, problems: r.problems };
  const problems = [];
  try { return crossChecked(name, def, input, metrics, detail, problems); } catch { return { ok: false, problems: [{ code: 'unreadable', path: '' }] }; }
}

/** The string policy and the cross-field rules, on data the shape pass accepted (a Proxy can still turn hostile: the caller catches). */
function crossChecked(name, def, input, metrics, detail, problems) {
  stringProblems(input, def, problems);
  const m = (k) => own(metrics, k);
  const rule = (cond, code, path) => { if (!cond) problems.push({ code, path }); };
  if (name === 'review_lane') {
    rule((m('result') === 'verdict') === (m('verdict') !== undefined), 'verdict_iff_result_verdict', '/metrics/verdict');
    rule(m('verdict') !== undefined || (m('majors') === undefined && m('minors') === undefined), 'counts_need_verdict', '/metrics/majors');
  }
  if (name === 'closure') {
    const engine = m('count_source') === 'engine_state';
    rule(CLOSURE_PAIRS.includes(`${m('emitter')}/${m('count_source')}`), 'closure_pair', '/metrics/count_source');
    rule(engine === (m('state_sha256') !== undefined) && engine === (m('state_seq') !== undefined), 'closure_state_ref', '/metrics/state_sha256');
    rule(m('label') === (engine ? 'measured' : 'estimated'), 'closure_label', '/metrics/label');
    const c = own(detail, 'counts'), u = own(c, 'usage');
    rule(Reflect.ownKeys(c).length > 0 && (u === undefined || Reflect.ownKeys(u).length > 0), 'closure_empty', '/detail/counts');
  }
  return { ok: problems.length === 0, problems };
}

const coded = (code, message, problems) => Object.assign(new Error(`${code}: ${message}`), { code, problems });
const ROW = (event) => ({ object: { schema: { enum: [RUN_LOG_SCHEMA] }, ticket: 'string', run_id: 'string', event: { enum: [event] }, event_id: 'string',
  kind: { enum: ['activity', 'wait'] }, name: 'string', timestamp: 'ts', metrics: event === 'start' ? { object: {} } : { open: true, object: {} },
  ...(event === 'end' ? { duration_ms: 'uint', outcome: { enum: ['complete'] }, detail: { optional: true, open: true, object: {} } } : {}) } });

/**
 * Reader-side check of one S-04 start/end pair (the same rules the writer applies to what it writes). Never throws.
 * Envelope, ids, kind, timestamps (strict UTC, end >= start, point events zero-length, duration exact), the canonical
 * event_id, the event's own metrics/detail, and a closure's `through` <= its own timestamp.
 */
export function checkEventPair(start, end) {
  const fail = (code, path = '') => ({ ok: false, problems: [{ code, path }] });
  for (const [row, ev] of [[start, 'start'], [end, 'end']]) { const r = validate(row, ROW(ev), LIMITS); if (!r.ok) return r; }
  const name = own(end, 'name');
  if (!isEventName(name)) return fail('unknown_event', '/name');
  const def = EVENTS[name];
  for (const k of ['schema', 'ticket', 'run_id', 'event_id', 'kind', 'name']) if (own(start, k) !== own(end, k)) return fail('pair_mismatch', `/${k}`);
  if (![own(end, 'ticket'), own(end, 'run_id'), own(end, 'event_id')].every((v) => SAFE_ID.test(v))) return fail('bad_string', '/event_id');
  if (own(end, 'kind') !== def.kind) return fail('wrong_kind', '/kind');
  const t0 = Date.parse(own(start, 'timestamp')), t1 = Date.parse(own(end, 'timestamp'));
  if (!(t1 >= t0) || own(end, 'duration_ms') !== t1 - t0 || (def.point && t1 !== t0)) return fail('bad_interval', '/timestamp');
  const metrics = own(end, 'metrics'), detail = own(end, 'detail');
  if (def.detail && detail === undefined) return fail('missing', '/detail');
  const v = validateEvent(name, metrics, detail);
  if (!v.ok) return v;
  if (def.id && own(end, 'event_id') !== def.id(metrics)) return fail('event_id_not_canonical', '/event_id');
  if (name === 'closure' && !(Date.parse(own(metrics, 'through')) <= t1)) return fail('through_after_timestamp', '/metrics/through');
  return { ok: true, problems: [] };
}

const ENCODED = new WeakSet();
/**
 * THE encoder of S-04 rows: validates the input, serialises the start/end pair, re-parses those exact bytes and checks them
 * with the reader's checkEventPair (what is written is what is validated), then returns a frozen, branded `{ text }`.
 * Throws `invalid_event` (with `problems`) and writes nothing. `closure` is encodable here; the CLI exposes it only via `close`.
 */
export function encodeEvent({ ticket, runId, eventId, name, metrics, detail, startedAt, endedAt }) {
  const v = validateEvent(name, metrics, detail);
  if (!v.ok) throw coded('invalid_event', `${String(name).slice(0, 40)}: ${v.problems.map((p) => `${p.path}:${p.code}`).join(', ')}`, v.problems);
  const def = EVENTS[name];
  const id = def.id ? def.id(metrics) : eventId;
  if (def.id && eventId !== undefined && eventId !== id) throw coded('invalid_event', `${name}: event_id must be ${id}`);
  if (![ticket, runId, id].every((x) => typeof x === 'string' && SAFE_ID.test(x))) throw coded('invalid_event', `${name}: ticket, run id and event id must be safe ids`);
  if (!isTimestamp(startedAt) || !isTimestamp(endedAt)) throw coded('invalid_event', `${name}: timestamps must be strict UTC ISO-8601`);
  const base = { schema: RUN_LOG_SCHEMA, ticket, run_id: runId, event_id: id, kind: def.kind, name };
  let text, s, e;
  try {
    text = `${JSON.stringify({ ...base, event: 'start', timestamp: startedAt, metrics: {} })}\n${JSON.stringify({ ...base, event: 'end', timestamp: endedAt,
      duration_ms: Date.parse(endedAt) - Date.parse(startedAt), outcome: 'complete', metrics, ...(detail === undefined ? {} : { detail }) })}\n`;
    [s, e] = text.split('\n').map((l) => (l ? JSON.parse(l) : null));
  } catch { throw coded('invalid_event', `${name}: not serialisable`); }
  if (Buffer.byteLength(text) > ROW_BYTES_MAX) throw coded('invalid_event', `${name}: record larger than ${ROW_BYTES_MAX} bytes`);
  const c = checkEventPair(s, e);
  if (!c.ok) throw coded('invalid_event', `${name}: ${c.problems.map((p) => `${p.path}:${p.code}`).join(', ')}`, c.problems);
  const out = Object.freeze({ text });
  ENCODED.add(out);
  return out;
}
export const isEncodedEvent = (x) => ENCODED.has(x);

/**
 * The run-log write choke point: records -> the bytes to append. A branded encodeEvent result passes as is; any other record is
 * a legacy row and is refused when its name is an S-04 event name (only encodeEvent may produce those). Throws; writes nothing.
 */
export function encodeRecords(records) {
  let text = '';
  for (const r of records) {
    if (ENCODED.has(r)) { text += r.text; continue; }
    if (!r || typeof r !== 'object' || isEventName(own(r, 'name'))) throw coded('unvalidated_event', 'an S-04 event row must come from encodeEvent');
    if (own(r, 'schema') !== RUN_LOG_SCHEMA) throw coded('not_a_row', `a run-log row carries schema ${RUN_LOG_SCHEMA}`);
    text += `${JSON.stringify(r)}\n`;
  }
  return text;
}

const strict = new TextDecoder('utf-8', { fatal: true });
const decode = (bytes) => { try { return strict.decode(bytes); } catch { return null; } };
/** R11: length of the committed prefix of a log (see the header). */
export function committedLength(buf) {
  let end = buf.lastIndexOf(0x0a) + 1;
  if (end > 0) {
    const from = end >= 2 ? buf.lastIndexOf(0x0a, end - 2) + 1 : 0, text = decode(buf.subarray(from, end - 1));
    let row = null;
    try { row = text === null ? null : JSON.parse(text); } catch { /* not a row: committed as is */ }
    if (row && typeof row === 'object' && row.event === 'start' && isEventName(row.name)) end = from;
  }
  return end;
}

/** The committed lines of a log buffer: `{ lines: [{ line, text }], torn_bytes }`; `text` is null for an undecodable line. */
export function readLog(buf) {
  const committed = committedLength(buf), lines = [];
  for (let from = 0, n = 1; from < committed; n++) {
    const lf = buf.indexOf(0x0a, from), to = lf < 0 || lf > committed ? committed : lf; // bounded even if `committed` is not at an LF
    lines.push({ line: n, text: decode(buf.subarray(from, to)) });
    from = to + 1;
  }
  return { lines, torn_bytes: buf.length - committed };
}

/**
 * S-04 events of a log buffer and the ticket's lost signal (read by later slices, never printed by a2):
 * `lost = { torn_bytes, undecodable_lines, malformed_lines, invalid_events }`. Legacy rows are skipped.
 */
export function readEvents(buf) {
  const { lines, torn_bytes } = readLog(buf);
  const lost = { torn_bytes, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0 };
  const starts = new Map(), events = [];
  for (const { text } of lines) {
    if (text === null) { lost.undecodable_lines++; continue; }
    if (!text.trim()) continue;
    let row;
    try { row = JSON.parse(text); } catch { lost.malformed_lines++; continue; }
    if (!row || typeof row !== 'object' || !isEventName(row.name)) continue;
    const key = JSON.stringify([row.run_id, row.event_id]);
    if (row.event === 'start') { if (starts.has(key)) lost.invalid_events++; starts.set(key, row); continue; }
    const start = starts.get(key);
    starts.delete(key);
    if (start && checkEventPair(start, row).ok) events.push({ start, end: row }); else lost.invalid_events++;
  }
  lost.invalid_events += starts.size;
  return { events, lost };
}
