/**
 * S-04a2 measurement event contract (S-04c-design §1.2): the closed event vocabulary, its validator (on lib/shape.mjs),
 * the ONE encoder of S-04 rows, and the R11 torn-record reader rule. No I/O; run-log-io.mjs appends, run-log.mjs is the CLI.
 *
 * Rows stay ship-ticket-run-log-v1. One event = a start row (`metrics: {}`, no payload) and an end row carrying
 * `metrics: {label, ...}` and the optional `detail`, encoded together and appended in ONE write. A schema below is DATA:
 * the shape spec, the string policy, CLI value typing and the event_id derivation all come from it (no second list).
 * Every string in metrics/detail is SAFE_ID (some fields stricter), except `ts` fields. Unknown keys are refused.
 *
 * Invariants (each has a named test in events.test.mjs):
 * I1 only validated bytes are written: every record is serialised by ONE data-only encoder (`canonicalJson`: own data
 *    properties of plain objects/arrays only; no toJSON, getter, Proxy `get` or prototype is ever consulted), those exact bytes
 *    are parsed back and validated, and run-log validates the whole resulting file before writing.
 * I2 bytes are never deleted silently: bytes leaving the log go first to a durable sidecar, and a `log_loss` record in the
 *    same write makes the loss visible to every later reader (`readEvents().lost`).
 * I3 R11 (rule adopted from deepseek-harness session-persistence-jsonl `SessionLogScanner`, no code copied): ONLY the bytes
 *    after the last LF are torn. Every complete line stays visible: an undecodable, malformed or invalid one fails closed.
 *    Lines are split on the LF byte first, then decoded strictly (fatal UTF-8), never replaced.
 * I4 recovery is explicit: `run-log quarantine` moves the lines `readEvents().bad` names to the sidecar, with a `log_loss`.
 */
import { isTimestamp, validate } from '../lib/shape.mjs';

/** The run-log row schema literal: held here only (the encoder's module); run-log.mjs imports it. */
export const RUN_LOG_SCHEMA = 'ship-ticket-run-log-v1';
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX = /^[a-f0-9]{7,64}$/, SHA256 = /^[a-f0-9]{64}$/, REVIEW_EXEC = /^review-[A-Za-z0-9._-]{1,80}$/;
// Fields a canonical event_id embeds are capped so every derived id fits SAFE_ID's 128 characters (a test proves it at the maxima).
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
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
  finding: { kind: 'activity', point: true, id: (m) => `finding-${m.fingerprint}-${m.occurrence}`, pattern: { fingerprint: FINGERPRINT },
    metrics: { ...LABEL, fingerprint: 'string', severity: E(['Blocker', 'Major', 'Minor', 'Info']), repeat: 'boolean', occurrence: 'posint' } },
  // The id is per INSTANT (millisecond): `...:00Z` and `...:00.000Z` are one fact. Written only by `run-log close` (cli: false).
  closure: { kind: 'activity', point: true, cli: false, id: (m) => `closure-${new Date(m.through).toISOString().replace(/[-:.]/g, '')}-${m.final ? 'final' : 'interim'}`,
    pattern: { state_sha256: SHA256 },
    metrics: { ...LABEL, through: 'ts', final: 'boolean', emitter: E(['engine', 'orchestrator']),
      count_source: E(['engine_state', 'orchestrator_tally', 'posthoc']), state_sha256: '?string', state_seq: '?uint' },
    detail: { counts } },
  // I2: bytes moved out of the log (to `<log>.lost-<offset>-<sha12>.json`); written only by run-log's writer (cli: false).
  log_loss: { kind: 'activity', point: true, cli: false, id: (m) => `log_loss-${m.offset}-${m.sha256.slice(0, 12)}`, pattern: { sha256: SHA256 },
    metrics: { label: E(['measured']), cause: E(['torn_tail', 'quarantine']), offset: 'uint', bytes: 'posint', sha256: 'string' } },
});
export const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));
export const isEventName = (name) => typeof name === 'string' && Object.hasOwn(EVENTS, name);
/** The names `run-log event` writes; `closure` comes only from `close`, `log_loss` only from the writer. */
export const CLI_EVENT_NAMES = Object.freeze(EVENT_NAMES.filter((n) => EVENTS[n].cli !== false));
/** Run id of `log_loss` records (a loss belongs to the log, not to a run). */
export const LOSS_RUN_ID = 'log';
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

/**
 * I1: the ONE serialiser of run-log rows. Reads only own data properties of plain objects and arrays (no toJSON, getter,
 * Proxy `get`, inherited or non-enumerable property is ever consulted: any of them is refused), finite numbers, strings,
 * booleans and null; bounded work. Same bytes as JSON.stringify for plain data. Throws `not_plain_data`.
 */
export function canonicalJson(value) {
  let work = 0;
  const bad = (why) => { throw coded('not_plain_data', why); };
  const enc = (v, depth) => {
    if (++work > LIMITS.maxNodes || depth > 32) bad('too large or too deep');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : bad('non-finite number');
    if (typeof v !== 'object') return bad(`a ${typeof v}`);
    const arr = Array.isArray(v), proto = Reflect.getPrototypeOf(v);
    if (proto !== (arr ? Array.prototype : Object.prototype) && !(proto === null && !arr)) bad('not a plain object or array');
    const parts = [];
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k === 'symbol') bad('a symbol key');
      const d = Reflect.getOwnPropertyDescriptor(v, k);
      if (arr && k === 'length') continue;
      if (!d || !('value' in d) || !d.enumerable) bad(`${String(k).slice(0, 40)} is not an enumerable data property`);
      if (arr && !/^(0|[1-9]\d*)$/.test(k)) bad('an array with extra keys');
      parts.push(arr ? enc(d.value, depth + 1) : `${JSON.stringify(k)}:${enc(d.value, depth + 1)}`);
    }
    if (arr) {
      const len = Reflect.getOwnPropertyDescriptor(v, 'length')?.value;
      if (len !== parts.length) bad('a sparse array');
      return `[${parts.join(',')}]`;
    }
    return `{${parts.join(',')}}`;
  };
  try { return enc(value, 0); } catch (e) { if (e?.code === 'not_plain_data') throw e; return bad('unreadable'); }
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
    text = `${canonicalJson({ ...base, event: 'start', timestamp: startedAt, metrics: {} })}\n${canonicalJson({ ...base, event: 'end', timestamp: endedAt,
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

/** I2: the branded `log_loss` record for bytes moved out of `ticket`'s log at `info.offset` (at `at`, an ISO instant). */
export const encodeLoss = (ticket, { offset, bytes, sha256, cause }, at) => encodeEvent({ ticket, runId: LOSS_RUN_ID, name: 'log_loss',
  metrics: { label: 'measured', cause, offset, bytes, sha256 }, startedAt: at, endedAt: at });

/**
 * The run-log write choke point (I1): records -> the bytes to append. A branded encodeEvent result passes as is. Any other record
 * is a legacy row: it is serialised by canonicalJson, and the PARSED BYTES must be a row of this schema whose name is not an S-04
 * event name (writer-side, in-process: only encodeEvent produces those; readers re-check every pair). Throws; writes nothing.
 */
export function encodeRecords(records) {
  let text = '';
  for (const r of records) {
    if (ENCODED.has(r)) { text += r.text; continue; }
    const line = canonicalJson(r), row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row) || isEventName(row.name)) throw coded('unvalidated_event', 'an S-04 event row must come from encodeEvent');
    if (row.schema !== RUN_LOG_SCHEMA || typeof row.name !== 'string') throw coded('not_a_row', `a run-log row carries schema ${RUN_LOG_SCHEMA} and a name`);
    text += `${line}\n`;
  }
  return text;
}

const strict = new TextDecoder('utf-8', { fatal: true });
const decode = (bytes) => { try { return strict.decode(bytes); } catch { return null; } };
/** I3 (R11): length of the committed prefix of a log: everything up to and including the last LF. Nothing else is torn. */
export const committedLength = (buf) => buf.lastIndexOf(0x0a) + 1;

/** The committed lines of a log buffer: `{ lines: [{ line, from, to, text }], torn_bytes }` (`to` excludes the LF); `text` is null when undecodable. */
export function readLog(buf) {
  const committed = committedLength(buf), lines = [];
  for (let from = 0, n = 1; from < committed; n++) {
    const to = buf.indexOf(0x0a, from);
    lines.push({ line: n, from, to, text: decode(buf.subarray(from, to)) });
    from = to + 1;
  }
  return { lines, torn_bytes: buf.length - committed };
}

/**
 * S-04 events of a log buffer and the ticket's lost signal (read by later slices, never printed by a2):
 * `lost = { torn_bytes, undecodable_lines, malformed_lines, invalid_events, loss_records, recovered_bytes }`; the last two come
 * from `log_loss` records (bytes already moved to a sidecar), so a loss stays visible after recovery. `bad` = the byte ranges
 * [from, to) a quarantine moves out: the torn tail, every undecodable or malformed line, and every S-04 line that is not part
 * of a valid pair. Legacy rows are not judged here (run-log's legacy rules do that).
 */
export function readEvents(buf) {
  const { lines, torn_bytes } = readLog(buf);
  const lost = { torn_bytes, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0, loss_records: 0, recovered_bytes: 0 };
  const starts = new Map(), events = [], bad = [];
  const reject = (l) => { lost.invalid_events++; bad.push([l.from, l.to + 1]); };
  for (const l of lines) {
    if (l.text === null) { lost.undecodable_lines++; bad.push([l.from, l.to + 1]); continue; }
    if (!l.text.trim()) continue;
    let row;
    try { row = JSON.parse(l.text); } catch { lost.malformed_lines++; bad.push([l.from, l.to + 1]); continue; }
    if (!row || typeof row !== 'object' || !isEventName(row.name)) continue;
    const key = JSON.stringify([row.run_id, row.event_id]);
    if (row.event === 'start') { if (starts.has(key)) reject(starts.get(key).l); starts.set(key, { row, l }); continue; }
    const start = starts.get(key);
    starts.delete(key);
    if (!start || !checkEventPair(start.row, row).ok) { reject(l); if (start) bad.push([start.l.from, start.l.to + 1]); continue; }
    if (row.name === 'log_loss') { lost.loss_records++; lost.recovered_bytes += row.metrics.bytes; } else events.push({ start: start.row, end: row });
  }
  for (const { l } of starts.values()) reject(l);
  if (torn_bytes) bad.push([buf.length - torn_bytes, buf.length]);
  return { events, lost, bad: bad.sort((a, b) => a[0] - b[0]) };
}
