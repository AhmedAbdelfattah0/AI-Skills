// S-04a2 measurement event contract: invariant-level tests (generic over EVERY event kind), the R11 torn-tail corpus, injected
// write faults, the single write choke point, legacy isolation (T-C2, T-C3, T-C6 against the T-C1 golden) and the mutation check.
// No sleeps and no wall-clock windows: lock waits run on an injected clock; host probes (processInfo) are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync as realWriteSync, ftruncateSync as realFtruncate } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ev from './events.mjs';
import { appendLocked } from '../run-log-io.mjs';
import { buildRun } from '../run-summary.mjs';
import { lostSignal } from '../eval.mjs';
import { classify, loadMutationSource, runMutant } from '../lib/mutation.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const RUN_LOG = join(SCRIPTS, 'run-log.mjs');
const MUTANT_CHILD = process.env.EVENTS_MUTANT_RUN === '1';
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

// ---- the test's OWN oracle: one valid example and the field types of every kind (independent of events.mjs) ----------------
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-01T00:01:00.000Z';
const POINT = new Set(['run_mode', 'milestone', 'finding', 'closure']);
const VALID = {
  run_mode: { metrics: { label: 'measured', mode: 'fallback', reason: 'lane_unavailable' }, eventId: 'mode-1' },
  review_lane: { metrics: { label: 'measured', review_execution: 'review-a', exec_event_id: 'ev-1', n: 1, round_kind: 'original', lane_role: 'primary', provider: 'codex',
    attempt: 1, result: 'verdict', verdict: 'FAIL', majors: 2, minors: 0, candidate_sha: '0123abc', packet_sha256: 'a'.repeat(64) } },
  repair_batch: { metrics: { label: 'measured', n: 1, authority_event_id: 'auth-1' }, detail: { finding_ids: ['F1', 'F2'] } },
  gate_run: { metrics: { label: 'measured', n: 1, head_sha: 'abcdef0', clean: false, hold_ms: 10 },
    detail: { per_gate: [{ name: 'lint', ms: 5, exit: 1, key: 'k1', t0_class: 'fast' }], manifest_sha256: 'b'.repeat(64) } },
  owner_decision: { metrics: { label: 'estimated', n: 1, class: 'retry_grant', retries_granted: 1 } },
  host_sleep: { metrics: { label: 'measured' }, eventId: 'sleep-1' },
  milestone: { metrics: { label: 'measured', at: 'merged' } },
  finding: { metrics: { label: 'measured', fingerprint: 'fp-1', severity: 'Major', repeat: true, occurrence: 2 } },
  closure: { metrics: { label: 'estimated', through: T0, final: true, emitter: 'orchestrator', count_source: 'posthoc' }, detail: { counts: { review_lane: 3, usage: { codex: 1 } } } },
};
const L = 'E(measured,estimated)';
const FIELDS = {
  run_mode: `label:${L} mode:E(engine,supervised,recovery,fallback) supersedes_run_id?:id parent?:id reason?:id`,
  review_lane: `label:${L} review_execution:rx exec_event_id:id n:posint round_kind:E(original,confirmation) lane_role:E(primary,second_opinion) provider:E(claude,codex,coderabbit) `
    + 'attempt:posint result:E(verdict) verdict?:E(PASS,FAIL) majors?:uint minors?:uint candidate_sha:hex packet_sha256?:sha256',
  repair_batch: `label:${L} n:posint authority_event_id?:id`,
  gate_run: `label:${L} n:posint head_sha:hex clean:bool hold_ms?:uint`,
  owner_decision: `label:${L} n:posint class:E(plan_approval,retry_grant,scope,merge,other) retries_granted?:uint`,
  host_sleep: `label:${L}`,
  milestone: `label:${L} at:E(plan_approved,ship_ready,merged,failed,abandoned)`,
  finding: `label:${L} fingerprint:id severity:E(Blocker,Major,Minor,Info) repeat:bool occurrence:posint`,
  // In this base (an orchestrator posthoc closure) the cross-field rules leave exactly these values valid.
  closure: 'label:E(estimated) through:ts final:bool emitter:E(orchestrator) count_source:E(orchestrator_tally,posthoc) state_sha256?:never state_seq?:never',
};
// Values outside a field's enum: `result` in the base must stay `verdict` (verdict is set); other results are tested by the cross-field test.
const ENUM_DECOYS = ['verdict', 'timeout', 'cancelled', 'infra_failed', 'no_result', 'engine', 'engine_state', 'measured', 'estimated', 'High', 'major', 'PASS ', 'pass'];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isTs = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) && new Date(v.replace(/\.\d+Z$/, 'Z')).toISOString().slice(0, 19) === v.slice(0, 19);
const ORACLE = {
  id: (v) => typeof v === 'string' && SAFE.test(v), rx: (v) => typeof v === 'string' && /^review-[A-Za-z0-9._-]{1,120}$/.test(v),
  hex: (v) => typeof v === 'string' && /^[a-f0-9]{7,64}$/.test(v), sha256: (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
  posint: (v) => Number.isSafeInteger(v) && v >= 1, uint: (v) => Number.isSafeInteger(v) && v >= 0, int: (v) => Number.isSafeInteger(v),
  bool: (v) => typeof v === 'boolean', ts: isTs, never: () => false,
};
const parseFields = (spec) => spec.split(' ').map((f) => {
  const [, key, optional, type] = /^([a-z_0-9]+)(\?)?:(.+)$/.exec(f);
  const en = /^E\((.*)\)$/.exec(type);
  return { key, optional: Boolean(optional), valid: en ? (v) => en[1].split(',').includes(v) : ORACLE[type], values: en ? en[1].split(',') : [] };
});
const CORPUS = [null, true, false, 0, 1, 2, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, '1', '0', 'true', '', 'x', 'X-1.b_c', 'review-a', `review-${'a'.repeat(121)}`, 'abcdef0', 'ABCDEF0', 'abcdef',
  'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(128), 'a'.repeat(129), '-x', '.x', 'a b', 'a\nb', 'a/b', '../x', 'é', 'a:b', T0, '2026-01-01T00:00:00Z', '2026-02-30T00:00:00Z',
  '2026-01-01T00:00:00+02:00', '2026-01-01T24:00:00Z', {}, [], ['x'], { a: 1 }, ...ENUM_DECOYS];
const times = (name) => (POINT.has(name) ? { startedAt: T1, endedAt: T1 } : { startedAt: T0, endedAt: T1 });
const clone = (x) => JSON.parse(JSON.stringify(x));
const encodeValid = (name, over = {}) => ev.encodeEvent({ ticket: 'T1', runId: 'run-1', eventId: VALID[name].eventId, name, metrics: VALID[name].metrics, detail: VALID[name].detail, ...times(name), ...over });

test('registration: EVENT_NAMES = the test cases = FIELDS rows; CLOSABLE is the design table; closure count keys are exactly CLOSABLE', () => {
  assert.deepEqual([...ev.EVENT_NAMES].sort(), Object.keys(VALID).sort());
  assert.deepEqual(Object.keys(FIELDS).sort(), Object.keys(VALID).sort());
  assert.deepEqual([...ev.CLOSABLE].sort(), ['gate_run', 'host_sleep', 'milestone', 'owner_decision', 'repair_batch', 'review_lane', 'usage']);
  for (const name of ev.EVENT_NAMES) {
    assert.equal(ev.isEventName(name), true);
    assert.deepEqual(Object.keys(ev.EVENTS[name].metrics).sort(), parseFields(FIELDS[name]).map((f) => f.key).sort(), `${name}: every schema field is in the oracle`);
    assert.deepEqual(Object.keys(ev.EVENTS[name].detail ?? {}).sort(), Object.keys(VALID[name].detail ?? {}).sort(), `${name}: every detail field is exercised`);
  }
  for (const k of [...ev.EVENT_NAMES, 'workflow', 'usage', 'review_round', 'confirmation', 'measurement_complete']) {
    const counts = k === 'usage' ? { usage: { claude: 1 } } : { [k]: 1 };
    const ok = ev.validateEvent('closure', VALID.closure.metrics, { counts }).ok;
    assert.equal(ok, ev.CLOSABLE.includes(k), `closure counts key ${k}`);
  }
  for (const p of ['claude', 'codex', 'gemini', 'antigravity', 'coderabbit', 'openai']) {
    assert.equal(ev.validateEvent('closure', VALID.closure.metrics, { counts: { usage: { [p]: 1 } } }).ok, ['claude', 'codex', 'gemini', 'antigravity'].includes(p), p);
  }
  for (const bad of [{}, { usage: {} }, { review_lane: -1 }, { review_lane: 1.5 }, { review_lane: '1' }, { usage: { claude: -1 } }]) {
    assert.equal(ev.validateEvent('closure', VALID.closure.metrics, { counts: bad }).ok, false, JSON.stringify(bad));
  }
});

test('every kind: the valid example validates, encodes to a start row with NO payload and an end row with all of it, and reads back unchanged', () => {
  for (const name of ev.EVENT_NAMES) {
    assert.deepEqual(ev.validateEvent(name, VALID[name].metrics, VALID[name].detail), { ok: true, problems: [] }, name);
    const enc = encodeValid(name);
    assert.ok(ev.isEncodedEvent(enc) && Object.isFrozen(enc), name);
    const [s, e, rest] = enc.text.split('\n');
    assert.equal(rest, '', `${name}: exactly two LF-terminated lines`);
    const start = JSON.parse(s), end = JSON.parse(e);
    assert.deepEqual(start.metrics, {}, name);
    assert.equal(Object.hasOwn(start, 'detail'), false, name);
    assert.deepEqual(end.metrics, VALID[name].metrics, name);
    assert.deepEqual(end.detail, VALID[name].detail, name);
    assert.equal(end.kind, ['owner_decision', 'host_sleep'].includes(name) ? 'wait' : 'activity', name);
    assert.equal(end.duration_ms, POINT.has(name) ? 0 : 60000, name);
    const read = ev.readEvents(Buffer.from(enc.text));
    assert.deepEqual(read.events, [{ start, end }], name);
    assert.deepEqual(read.lost, { torn_bytes: 0, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0 });
  }
});

test('every field of every kind: each corpus value is accepted exactly when the oracle says so; missing, unknown and accessor keys are refused', () => {
  for (const name of ev.EVENT_NAMES) {
    const base = VALID[name].metrics;
    for (const { key, optional, valid, values } of parseFields(FIELDS[name])) {
      for (const v of [...CORPUS, ...values]) {
        const metrics = { ...clone(base), [key]: v };
        const got = ev.validateEvent(name, metrics, VALID[name].detail);
        assert.equal(got.ok, Boolean(valid(v)), `${name}.${key} = ${JSON.stringify(v)}: ${JSON.stringify(got.problems)}`);
        assert.ok(Array.isArray(got.problems));
      }
      const without = clone(base); delete without[key];
      assert.equal(ev.validateEvent(name, without, VALID[name].detail).ok, optional && !(name === 'review_lane' && key === 'verdict'), `${name} without ${key}`);
      let invoked = false;
      const accessor = Object.defineProperty(clone(base), key, { get() { invoked = true; return base[key]; }, enumerable: true });
      assert.equal(ev.validateEvent(name, accessor, VALID[name].detail).ok, false, `${name}.${key} accessor`);
      assert.equal(invoked, false, `${name}.${key}: a getter is never invoked`);
    }
    for (const extra of [{ extra: 'x' }, JSON.parse('{"__proto__": "x"}'), { constructor: 'x' }, { [Symbol('s')]: 'x' }]) {
      assert.equal(ev.validateEvent(name, { ...clone(base), ...extra }, VALID[name].detail).ok, false, `${name}: unknown key ${String(Reflect.ownKeys(extra)[0])}`);
    }
    assert.equal(({}).polluted, undefined);
    for (const metrics of [null, 'x', [], new Map(), Object.create({ label: 'measured' })]) assert.equal(ev.validateEvent(name, metrics, VALID[name].detail).ok, false);
  }
  let reads = 0;
  const turncoat = new Proxy({ label: 'measured' }, { getOwnPropertyDescriptor(t, k) { if (++reads > 1) throw new Error('trap'); return Reflect.getOwnPropertyDescriptor(t, k); } });
  let turned; try { turned = ev.validateEvent('host_sleep', turncoat); } catch (e) { turned = `threw: ${e.message}`; }
  assert.deepEqual(turned, { ok: false, problems: [{ code: 'unreadable', path: '' }] }, 'a Proxy turning hostile after the shape pass never throws out');
  for (const name of [undefined, null, '', 'review_round', 'confirmation', 'workflow', '__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    assert.deepEqual(ev.validateEvent(name, { label: 'measured' }), { ok: false, problems: [{ code: 'unknown_event', path: '' }] }, String(name));
  }
});

test('detail: required exactly for the kinds that declare it; every detail field refuses wrong types, oversized and hostile values', () => {
  for (const name of ev.EVENT_NAMES) {
    const needs = VALID[name].detail !== undefined;
    assert.equal(ev.validateEvent(name, VALID[name].metrics, undefined).ok, !needs, `${name} without detail`);
    if (!needs) for (const d of [{}, { x: 1 }, null, []]) assert.equal(ev.validateEvent(name, VALID[name].metrics, d).ok, false, `${name} detail ${JSON.stringify(d)}`);
  }
  const rb = (finding_ids) => ev.validateEvent('repair_batch', VALID.repair_batch.metrics, { finding_ids }).ok;
  assert.equal(rb([]), true);
  assert.equal(rb(Array.from({ length: 1000 }, (_, i) => `F${i}`)), true);
  for (const bad of [Array.from({ length: 1001 }, (_, i) => `F${i}`), ['F1', 1], ['a'.repeat(129)], ['a b'], [null], 'F1', [['F1']], new Array(3)]) assert.equal(rb(bad), false, JSON.stringify(bad));
  let reads = 0;
  const huge = new Proxy(new Array(1e7), { getOwnPropertyDescriptor(t, k) { reads++; return Reflect.getOwnPropertyDescriptor(t, k); } });
  assert.equal(rb(huge), false);
  assert.ok(reads < 10, `a huge array is refused without walking it (${reads} reads)`);
  const gate = (item, extra = {}) => ev.validateEvent('gate_run', VALID.gate_run.metrics, { per_gate: [item], ...extra }).ok;
  const item = VALID.gate_run.detail.per_gate[0];
  for (const { key, valid } of parseFields('name:id ms:uint exit:int key:id t0_class:id')) {
    for (const v of CORPUS) assert.equal(gate({ ...item, [key]: v }), Boolean(valid(v)), `per_gate.${key} = ${JSON.stringify(v)}`);
    const without = { ...item }; delete without[key];
    assert.equal(gate(without), false, `per_gate without ${key}`);
  }
  assert.equal(gate({ ...item, extra: 1 }), false);
  for (const v of CORPUS) assert.equal(gate(item, { manifest_sha256: v }), ORACLE.sha256(v), `manifest_sha256 = ${JSON.stringify(v)}`);
  let deep = 'x'; for (let i = 0; i < 50; i++) deep = [deep];
  assert.equal(rb(deep), false);
});

test('cross-field rules: verdict iff result=verdict; majors/minors need a verdict; closure pairs, state reference and label cap', () => {
  const lane = (over) => { const m = { ...clone(VALID.review_lane.metrics), ...over }; for (const k of Object.keys(over)) if (over[k] === undefined) delete m[k]; return ev.validateEvent('review_lane', m).ok; };
  for (const result of ['timeout', 'cancelled', 'infra_failed', 'no_result']) {
    assert.equal(lane({ result, verdict: undefined, majors: undefined, minors: undefined }), true, `${result} without verdict`);
    assert.equal(lane({ result, verdict: 'FAIL', majors: undefined, minors: undefined }), false, `${result} with a verdict`);
    assert.equal(lane({ result, verdict: undefined, majors: 1, minors: undefined }), false, `${result} with majors`);
    assert.equal(lane({ result, verdict: undefined, majors: undefined, minors: 1 }), false, `${result} with minors`);
  }
  assert.equal(lane({ verdict: undefined, majors: undefined, minors: undefined }), false, 'result=verdict needs a verdict');
  const close = (m) => ev.validateEvent('closure', { ...VALID.closure.metrics, ...m }, VALID.closure.detail).ok;
  const sha = 'c'.repeat(64);
  for (const emitter of ['engine', 'orchestrator']) {
    for (const source of ['engine_state', 'orchestrator_tally', 'posthoc']) {
      const engine = source === 'engine_state', pairOk = `${emitter}/${source}` !== 'engine/orchestrator_tally' && `${emitter}/${source}` !== 'engine/posthoc' && `${emitter}/${source}` !== 'orchestrator/engine_state';
      for (const label of ['measured', 'estimated']) {
        for (const ref of [{}, { state_sha256: sha }, { state_seq: 3 }, { state_sha256: sha, state_seq: 3 }]) {
          const full = ref.state_sha256 !== undefined && ref.state_seq !== undefined, none = ref.state_sha256 === undefined && ref.state_seq === undefined;
          const expect = pairOk && (engine ? full : none) && label === (engine ? 'measured' : 'estimated');
          assert.equal(close({ emitter, count_source: source, label, ...ref }), expect, `${emitter}/${source} ${label} ${JSON.stringify(ref)}`);
        }
      }
    }
  }
});

test('encoder: canonical event ids, interval rules, through <= its own timestamp, size cap, and what is written is what is validated', () => {
  const refuse = (fn, why) => assert.throws(fn, (e) => e.code === 'invalid_event', why);
  for (const name of ev.EVENT_NAMES) {
    const end = JSON.parse(encodeValid(name).text.split('\n')[1]);
    if (VALID[name].eventId === undefined) {
      assert.equal(encodeValid(name, { eventId: end.event_id }).text, encodeValid(name).text, `${name}: the canonical id may be named`);
      refuse(() => encodeValid(name, { eventId: 'other-id' }), `${name}: a non-canonical id is refused`);
    } else {
      refuse(() => encodeValid(name, { eventId: undefined }), `${name}: the caller names it`);
      refuse(() => encodeValid(name, { eventId: 'bad id' }), name);
    }
    if (POINT.has(name)) refuse(() => encodeValid(name, { startedAt: T0, endedAt: T1 }), `${name} is a point event`);
    else refuse(() => encodeValid(name, { startedAt: T1, endedAt: T0 }), `${name}: end before start`);
    for (const bad of ['2026-01-01T00:00:00+02:00', '2026-02-30T00:00:00Z', 'now', undefined, 1767225600000]) refuse(() => encodeValid(name, { startedAt: bad, endedAt: bad }), `${name} stamp ${bad}`);
    for (const [k, v] of [['ticket', 'a b'], ['runId', ''], ['ticket', undefined]]) refuse(() => encodeValid(name, { [k]: v }), `${name} ${k}`);
  }
  assert.equal(JSON.parse(encodeValid('review_lane').text.split('\n')[1]).event_id, 'rv-review-a-primary-1');
  assert.equal(JSON.parse(encodeValid('gate_run').text.split('\n')[1]).event_id, 'gate_run-1');
  assert.equal(JSON.parse(encodeValid('closure').text.split('\n')[1]).event_id, 'closure-20260101T000000000Z-final');
  refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'closure', metrics: { ...VALID.closure.metrics, through: '2026-01-01T00:01:00.001Z' }, detail: VALID.closure.detail, startedAt: T1, endedAt: T1 }), 'through after the closure');
  refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'repair_batch', metrics: VALID.repair_batch.metrics, detail: { finding_ids: Array.from({ length: 600 }, () => 'F'.repeat(120)) }, startedAt: T0, endedAt: T1 }), 'size cap');
  // A Proxy whose descriptor trap shows a valid label while `get` (what JSON.stringify reads) returns another: the re-check of the bytes refuses it.
  const lying = new Proxy({ label: 'measured' }, { get: (t, k) => (k === 'label' ? 'bogus' : Reflect.get(t, k)) });
  assert.equal(ev.validateEvent('host_sleep', lying).ok, true, 'descriptor-based validation sees the valid value');
  refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', eventId: 's', name: 'host_sleep', metrics: lying, startedAt: T0, endedAt: T1 }), 'the written bytes are re-validated');
  const throwing = new Proxy({ label: 'measured' }, { ownKeys() { throw new Error('trap'); } });
  refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', eventId: 's', name: 'host_sleep', metrics: throwing, startedAt: T0, endedAt: T1 }), 'a throwing trap is a refusal');
});

test('choke point: encodeRecords refuses every S-04 row that did not come from encodeEvent, and a branded record cannot be altered', () => {
  const legacy = { schema: ev.RUN_LOG_SCHEMA, ticket: 'T1', run_id: 'r', event: 'start', event_id: 'x', kind: 'activity', name: 'build', timestamp: T0, metrics: { a: 'é' } };
  assert.equal(ev.encodeRecords([legacy]), `${JSON.stringify(legacy)}\n`);
  for (const name of ev.EVENT_NAMES) {
    const enc = encodeValid(name);
    assert.equal(ev.encodeRecords([enc]), enc.text);
    for (const line of enc.text.split('\n').filter(Boolean)) assert.throws(() => ev.encodeRecords([JSON.parse(line)]), (e) => e.code === 'unvalidated_event', `${name}: a valid but unencoded row`);
    assert.throws(() => ev.encodeRecords([legacy, { ...legacy, name }]), (e) => e.code === 'unvalidated_event', name);
    assert.throws(() => ev.encodeRecords([{ text: enc.text }]), (e) => e.code === 'not_a_row', `${name}: a forged {text}`);
    assert.throws(() => { enc.text = 'x'; }, TypeError);
  }
  for (const bad of [null, 'row', { ...legacy, schema: 'other' }]) assert.throws(() => ev.encodeRecords([bad]));
});

// ---- the single write path, structurally ---------------------------------------------------------------------------------
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === 'fixtures' ? [] : sources(join(dir, d.name)))
  : d.name.endsWith('.mjs') && !d.name.endsWith('.test.mjs') && !d.name.includes('test-helper') ? [join(dir, d.name)] : []));
test('structural: one module holds the row schema literal, only run-log.mjs imports the encoder or the appender, and run-log.mjs has one write call', () => {
  const files = sources(SCRIPTS).map((f) => [relative(SCRIPTS, f).split('\\').join('/'), loadMutationSource(f)]);
  assert.ok(files.length > 30, `the scan sees the scripts tree (${files.length})`);
  assert.deepEqual(files.filter(([, s]) => /['"`]ship-ticket-run-log-v1['"`]/.test(s)).map(([f]) => f), ['measure/events.mjs']);
  assert.deepEqual(files.filter(([, s]) => /\bencode(Event|Records)\b/.test(s)).map(([f]) => f).sort(), ['measure/events.mjs', 'run-log.mjs']);
  assert.deepEqual(files.filter(([, s]) => /\bappendLocked\b/.test(s)).map(([f]) => f).sort(), ['run-log-io.mjs', 'run-log.mjs']);
  assert.deepEqual(files.filter(([, s]) => /\bRUN_LOG_SCHEMA\b/.test(s)).map(([f]) => f).sort(), ['measure/events.mjs', 'run-log.mjs']);
  const runLog = files.find(([f]) => f === 'run-log.mjs')[1];
  assert.equal((runLog.match(/\b(appendFileSync|writeFileSync|writeSync|createWriteStream|openSync|truncateSync)\b/g) ?? []).length, 0);
  assert.equal((runLog.match(/\bappendLocked\(/g) ?? []).length, 1);
  assert.match(runLog, /await appendLocked\(path, encodeRecords\(records\)/);
});

// ---- CLI ---------------------------------------------------------------------------------------------------------------
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  const log = join(dir, '.git', 'ai-skills', 'ship-ticket', 'T1.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  const cli = (...args) => spawnSync(process.execPath, [RUN_LOG, ...args, '--repo', dir, '--ticket', 'T1'], { encoding: 'utf8' });
  const bytes = () => (existsSync(log) ? readFileSync(log) : null);
  return { dir, log, cli, bytes };
}
const metricArgs = (metrics) => Object.entries(metrics).flatMap(([k, v]) => ['--metric', `${k}=${v}`]);
const eventArgs = (name, over = {}) => ['event', '--run-id', 'run-1', '--name', name, ...metricArgs({ ...VALID[name].metrics, ...over }),
  ...(VALID[name].eventId ? ['--event-id', VALID[name].eventId] : []), ...(VALID[name].detail ? ['--detail', JSON.stringify(VALID[name].detail)] : []),
  '--started-at', times(name).startedAt, '--ended-at', times(name).endedAt];

test('W2: generic start and end refuse EVERY event name, and nothing is written', (t) => {
  const r = repo(t);
  for (const name of ev.EVENT_NAMES) {
    for (const cmd of ['start', 'end']) {
      const res = r.cli(cmd, '--run-id', 'run-1', '--kind', ['owner_decision', 'host_sleep'].includes(name) ? 'wait' : 'activity', '--name', name, '--event-id', 'e1', '--metric', 'label=measured');
      assert.equal(res.status, 1, `${cmd} ${name}`);
      assert.match(res.stderr, /is a measurement event: use run-log\.mjs event/);
    }
  }
  assert.equal(r.bytes(), null);
});

test('event: every kind but closure is written through the CLI, typed by the schema (a digit-only sha stays a string), and reads back', (t) => {
  const r = repo(t);
  const written = [];
  for (const name of ev.EVENT_NAMES.filter((n) => n !== 'closure')) {
    const over = name === 'review_lane' ? { candidate_sha: '1234567' } : {};
    const res = r.cli(...eventArgs(name, over));
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    written.push({ ...VALID[name].metrics, ...over });
  }
  const { events, lost } = ev.readEvents(r.bytes());
  assert.deepEqual(events.map((e) => e.end.metrics), written);
  assert.equal(events.find((e) => e.end.name === 'review_lane').end.metrics.candidate_sha, '1234567');
  assert.deepEqual(lost, { torn_bytes: 0, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0 });
  const lone = r.cli('event', '--run-id', 'run-1', '--name', 'host_sleep', '--event-id', 'sleep-9', '--metric', 'label=measured', '--started-at', T0);
  assert.equal(lone.status, 0, lone.stderr);
  assert.ok(Date.parse(JSON.parse(lone.stdout.split('\n')[1]).timestamp) > Date.parse(T0), 'a lone --started-at ends now, not at the start');
  written.push({ label: 'measured' });
  assert.deepEqual(ev.readEvents(r.bytes()).events.map((e) => e.end.metrics), written);
  const before = r.bytes();
  for (const args of [eventArgs('review_lane'), eventArgs('milestone'), eventArgs('host_sleep'), // duplicates of (run, event_id)
    eventArgs('review_lane', { majors: 'x' }), eventArgs('gate_run', { clean: 'yes' }), eventArgs('finding', { severity: 'High' }), eventArgs('run_mode', { label: 'unknown' }),
    ['event', '--run-id', 'run-1', '--name', 'closure', ...metricArgs(VALID.closure.metrics), '--detail', JSON.stringify(VALID.closure.detail)],
    ['event', '--run-id', 'run-1', '--name', 'review_round', '--metric', 'label=measured'], [...eventArgs('host_sleep'), '--outcome', 'pass'],
    ['event', '--run-id', 'run-1', '--name', 'repair_batch', '--event-id', 'x', ...metricArgs({ label: 'measured', n: 9 }), '--detail', '{bad json']]) {
    const res = r.cli(...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.deepEqual(r.bytes(), before, `refused and left unchanged: ${args.slice(0, 5).join(' ')}`);
  }
});

test('close: an orchestrator closure with explicit counts is written (label estimated); engine closures and malformed counts are refused', (t) => {
  const r = repo(t);
  const close = (...extra) => r.cli('close', '--run-id', 'run-1', '--through', T0, '--final', 'true', '--count-source', 'orchestrator_tally', ...extra);
  const ok = close('--count', 'review_lane=2', '--count', 'gate_run=0', '--count', 'usage.codex=1');
  assert.equal(ok.status, 0, ok.stderr);
  const [closure] = ev.readEvents(r.bytes()).events;
  assert.deepEqual(closure.end.metrics, { label: 'estimated', through: T0, final: true, emitter: 'orchestrator', count_source: 'orchestrator_tally' });
  assert.deepEqual(closure.end.detail, { counts: { review_lane: 2, gate_run: 0, usage: { codex: 1 } } });
  const before = r.bytes();
  for (const args of [['--count', 'review_lane=2', '--final', 'true'], // duplicate closure id
    ['--count', 'run_mode=1', '--final', 'false'], ['--count', 'closure=1', '--final', 'false'], ['--count', 'usage.openai=1', '--final', 'false'],
    ['--count', 'review_lane=-1', '--final', 'false'], ['--count', 'review_lane=x', '--final', 'false'], ['--final', 'false'], ['--count', 'review_lane=1', '--from-engine-state', 'x'],
    ['--count', 'review_lane=1', '--metric', 'label=measured'], ['--count', 'review_lane=1', '--name', 'closure']]) {
    const res = r.cli('close', '--run-id', 'run-1', '--through', T0, '--count-source', 'orchestrator_tally', ...(args.includes('--final') ? [] : ['--final', 'false']), ...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.deepEqual(r.bytes(), before, args.join(' '));
  }
  for (const source of ['engine_state', 'bogus']) assert.equal(r.cli('close', '--run-id', 'run-1', '--through', T0, '--final', 'false', '--count-source', source, '--count', 'review_lane=1').status, 1, source);
  assert.equal(r.cli('close', '--run-id', 'run-1', '--through', '2999-01-01T00:00:00Z', '--final', 'false', '--count-source', 'posthoc', '--count', 'review_lane=1').status, 1, 'through in the future');
  assert.deepEqual(r.bytes(), before);
});

test('R11 via the CLI: a crashed event write (torn record) is dropped and a deterministic replay succeeds; a legacy start also repairs a torn tail', (t) => {
  const r = repo(t);
  assert.equal(r.cli(...eventArgs('milestone')).status, 0);
  const committed = r.bytes();
  const rec = encodeValid('review_lane').text;
  for (const cut of [rec.indexOf('\n') + 1, rec.indexOf('\n') + 7, 3]) {
    writeFileSync(r.log, Buffer.concat([committed, Buffer.from(rec.slice(0, cut))]));
    const res = r.cli(...eventArgs('review_lane'));
    assert.equal(res.status, 0, `cut ${cut}: ${res.stderr}`);
    assert.equal(r.bytes().toString(), committed.toString() + rec, `cut ${cut}: exactly one copy of the record`);
    writeFileSync(r.log, committed);
  }
  writeFileSync(r.log, Buffer.concat([committed, Buffer.from(rec.slice(0, 20))]));
  const start = r.cli('start', '--run-id', 'run-1', '--kind', 'activity', '--name', 'build', '--event-id', 'b1');
  assert.equal(start.status, 0, start.stderr);
  const after = r.bytes().toString();
  assert.ok(after.startsWith(committed.toString()));
  const added = after.slice(committed.length).split('\n');
  assert.equal(added.length, 2, 'one complete line was added and the torn tail is gone');
  assert.equal(JSON.parse(added[0]).event_id, 'b1');
});

test('history: an invalid measurement record or undecodable bytes refuse an event write, unchanged; legacy damage refuses it too', (t) => {
  const r = repo(t);
  const enc = encodeValid('milestone').text.split('\n');
  const end = JSON.parse(enc[1]);
  for (const damaged of [`${enc[0]}\n${JSON.stringify({ ...end, metrics: { ...end.metrics, at: 'shipped' } })}\n`, `${enc[1]}\n`, `${enc[0]}\n${enc[0]}\n${enc[1]}\n`]) {
    writeFileSync(r.log, damaged);
    assert.equal(r.cli(...eventArgs('host_sleep')).status, 1, damaged.slice(0, 60));
    assert.equal(r.bytes().toString(), damaged);
  }
  const bad = Buffer.concat([Buffer.from('{"schema":"x","name":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  writeFileSync(r.log, bad);
  const res = r.cli(...eventArgs('host_sleep'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not valid UTF-8/);
  assert.deepEqual(r.bytes(), bad);
  writeFileSync(r.log, '{"not":"a row"}\n');
  assert.equal(r.cli(...eventArgs('host_sleep')).status, 1);
});

// ---- R11 corpus: every truncation point of every record kind ------------------------------------------------------------
const lockCtx = { processInfo: () => ({ alive: true, startTime: 'pinned' }) };
const quiet = { fsyncSync: () => {} }; // durability is not under test in the corpus loop (it is in the fault tests below)
test('R11 corpus: for every record kind and every cut k, read(prefix + record[0:k]) = read(prefix), and the next append yields prefix + record', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-r11-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = (event, extra) => `${JSON.stringify({ schema: ev.RUN_LOG_SCHEMA, ticket: 'T1', run_id: 'run-1', event, event_id: 'u1', kind: 'activity', name: 'build', timestamp: T0, metrics: { note: 'é€😀' }, ...extra })}\n`;
  const prefix = Buffer.from(legacy('start') + encodeValid('host_sleep').text);
  const records = [...ev.EVENT_NAMES.map((n) => encodeValid(n, n === 'host_sleep' ? { eventId: 'sleep-2' } : {}).text), legacy('start'), legacy('end', { duration_ms: 0, outcome: 'pass' })];
  const base = ev.readEvents(prefix);
  assert.equal(base.events.length, 1);
  let cuts = 0;
  for (const rec of records) {
    const bytes = Buffer.from(rec);
    for (let k = 0; k < bytes.length; k++) {
      const buf = Buffer.concat([prefix, bytes.subarray(0, k)]);
      assert.deepEqual(ev.readEvents(buf).events, base.events, `k=${k}`);
      assert.equal(ev.readEvents(buf).lost.undecodable_lines, 0, `k=${k}: a torn multi-byte tail is torn, not undecodable`);
      assert.equal(ev.committedLength(buf), prefix.length, `k=${k}`);
      const file = join(dir, `c${cuts++}.jsonl`);
      writeFileSync(file, buf);
      const res = await appendLocked(file, rec, { lockCtx, fs: quiet });
      assert.equal(res.truncated, k);
      assert.deepEqual(readFileSync(file), Buffer.concat([prefix, bytes]), `k=${k}`);
      assert.equal(existsSync(`${file}.lock`), false);
    }
  }
  assert.ok(cuts > 2000, `cuts ${cuts}`);
  // A COMPLETE legacy record is history, never a torn record; a complete S-04 record likewise.
  for (const rec of records) assert.equal(ev.committedLength(Buffer.concat([prefix, Buffer.from(rec)])), prefix.length + Buffer.byteLength(rec));
  // A torn tail LONGER than the record appended next is truncated, not just overwritten.
  const big = Buffer.from(ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'repair_batch', metrics: VALID.repair_batch.metrics, detail: { finding_ids: Array.from({ length: 50 }, (_, i) => `F${i}`) }, startedAt: T0, endedAt: T1 }).text);
  const long = join(dir, 'long.jsonl'), small = encodeValid('milestone').text;
  writeFileSync(long, Buffer.concat([prefix, big.subarray(0, big.length - 3)]));
  await appendLocked(long, small, { lockCtx, fs: quiet });
  assert.deepEqual(readFileSync(long), Buffer.concat([prefix, Buffer.from(small)]));
});

test('reader: a hand-damaged pair of ANY kind is invalid at read (kind, canonical id, start payload, envelope), never an event', () => {
  for (const name of ev.EVENT_NAMES) {
    const [s, e] = encodeValid(name).text.split('\n').map((l) => (l ? JSON.parse(l) : null));
    const otherKind = e.kind === 'wait' ? 'activity' : 'wait';
    const damage = [
      ['kind', { ...s, kind: otherKind }, { ...e, kind: otherKind }],
      ['start payload', { ...s, metrics: { label: 'measured' } }, e],
      ['start detail', { ...s, detail: {} }, e],
      ['outcome', s, { ...e, outcome: 'pass' }],
      ['schema', { ...s, schema: 'v2' }, { ...e, schema: 'v2' }],
      ['ticket mismatch', s, { ...e, ticket: 'T2' }],
      ...(VALID[name].eventId ? [] : [['non-canonical event id', { ...s, event_id: 'not-canonical' }, { ...e, event_id: 'not-canonical' }]]),
    ];
    for (const [what, ds, de] of damage) {
      assert.equal(ev.checkEventPair(ds, de).ok, false, `${name}: ${what}`);
      const read = ev.readEvents(Buffer.from(`${JSON.stringify(ds)}\n${JSON.stringify(de)}\n`));
      assert.deepEqual([read.events.length, read.lost.invalid_events], [0, 1], `${name}: ${what}`);
    }
    assert.equal(ev.checkEventPair(s, e).ok, true, name);
  }
});

test('strict decoding: an undecodable line mid-file is reported (never replaced) and the lines around it are still read', () => {
  const a = encodeValid('milestone').text, b = encodeValid('finding').text;
  const buf = Buffer.concat([Buffer.from(a), Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]), Buffer.from(b)]);
  const { events, lost } = ev.readEvents(buf);
  assert.deepEqual(events.map((e) => e.end.name), ['milestone', 'finding']);
  assert.equal(lost.undecodable_lines, 1);
  assert.equal(ev.readLog(buf).lines[2].text, null);
  const mixed = ev.readEvents(Buffer.from(`not json\n${a.split('\n')[1]}\n${a.split('\n')[0]}\n${b}`));
  assert.deepEqual(mixed.lost, { torn_bytes: 0, undecodable_lines: 0, malformed_lines: 1, invalid_events: 2 });
});

// ---- injected faults: no partial record survives, the lock is always released, no unhandled rejection ----------------
test('faults: a throw at every append boundary, a failed check, a refused lock, a short write and a crash mid-write', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-fault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const committed = Buffer.from(encodeValid('milestone').text), torn = Buffer.from('{"sch');
  const rec = encodeValid('finding').text, all = Buffer.concat([committed, Buffer.from(rec)]);
  let n = 0;
  const fresh = () => { const f = join(dir, `f${n++}.jsonl`); writeFileSync(f, Buffer.concat([committed, torn])); return f; };
  const boom = Object.assign(new Error('injected'), { code: 'injected' });
  for (const [at, expect] of [['append-read', Buffer.concat([committed, torn])], ['append-truncate', Buffer.concat([committed, torn])], ['append-write', committed], ['append-fsync', committed]]) {
    const f = fresh();
    await assert.rejects(appendLocked(f, rec, { lockCtx, hooks: { boundary: async (name) => { if (name === at) throw boom; } } }), boom, at);
    assert.deepEqual(readFileSync(f), expect, at);
    assert.equal(existsSync(`${f}.lock`), false, `${at}: lock released`);
    assert.deepEqual(ev.readEvents(readFileSync(f)).events, ev.readEvents(committed).events, `${at}: a rejection leaves the committed history only`);
  }
  let f = fresh();
  await assert.rejects(appendLocked(f, rec, { lockCtx, check: () => { throw boom; } }), boom);
  assert.deepEqual(readFileSync(f), Buffer.concat([committed, torn]), 'a refused check truncates nothing');
  f = join(dir, 'never.jsonl');
  await assert.rejects(appendLocked(f, rec, { lock: async () => { throw boom; } }), boom);
  assert.equal(existsSync(f), false, 'nothing is opened without the lock');
  const half = Math.floor(rec.length / 2);
  f = fresh();
  await assert.rejects(appendLocked(f, rec, { lockCtx, fs: { writeSync: (fd, data, off, len, pos) => realWriteSync(fd, data, 0, half, pos) } }), (e) => e.code === 'short_write');
  assert.deepEqual(readFileSync(f), committed, 'a short write is rolled back');
  f = fresh();
  await assert.rejects(appendLocked(f, rec, { lockCtx, fs: { writeSync: () => { throw boom; } } }), boom);
  assert.deepEqual(readFileSync(f), committed);
  // A crash: part of the record reaches the file and even the rollback fails. R11 then reads the committed history only,
  // and the next append (a replay) yields exactly one copy of the record.
  f = fresh();
  let wrote = false;
  const crash = { writeSync: (fd, data, off, len, pos) => { realWriteSync(fd, data, 0, half, pos); wrote = true; throw boom; },
    ftruncateSync: (fd, len) => { if (wrote) throw boom; return realFtruncate(fd, len); } };
  await assert.rejects(appendLocked(f, rec, { lockCtx, fs: crash }), boom);
  assert.deepEqual(readFileSync(f), Buffer.concat([committed, Buffer.from(rec).subarray(0, half)]));
  assert.deepEqual(ev.readEvents(readFileSync(f)).events, ev.readEvents(committed).events);
  await appendLocked(f, rec, { lockCtx });
  assert.deepEqual(readFileSync(f), all);
  const fsyncs = [];
  f = fresh();
  await appendLocked(f, rec, { lockCtx, fs: { fsyncSync: (fd) => fsyncs.push(fd) } });
  assert.ok(fsyncs.length >= 1, 'the append is fsynced');
  const fresh2 = join(dir, 'sub', 'new.jsonl');
  mkdirSync(dirname(fresh2));
  const dirSyncs = [];
  if (process.platform !== 'win32') { // a directory cannot be opened for fsync on win32
    await appendLocked(fresh2, rec, { lockCtx, platform: 'linux', fs: { fsyncSync: (fd) => dirSyncs.push(fd) } });
    assert.equal(dirSyncs.length, 2, 'a new file also fsyncs its directory');
    await appendLocked(fresh2, rec, { lockCtx, platform: 'linux', fs: { fsyncSync: (fd) => dirSyncs.push(fd) } });
    assert.equal(dirSyncs.length, 3, 'an existing file fsyncs only itself');
  } else await appendLocked(fresh2, rec, { lockCtx });
  assert.equal((statSync(fresh2).mode & 0o777).toString(8), process.platform === 'win32' ? (statSync(fresh2).mode & 0o777).toString(8) : '600');
});

test('lock: its own <log>.lock (never the engine lock); a live holder times out on an injected clock with nothing written; a pre-aborted signal writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'T1.jsonl');
  let seen;
  await appendLocked(f, encodeValid('milestone').text, { lock: async (ctx, opts) => { seen = { ctx, opts }; return { release: async () => {} }; } });
  assert.equal(seen.ctx.lockFile, `${f}.lock`);
  assert.equal(seen.opts.waitMs, 10000);
  const before = readFileSync(f);
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: 4242, process_start_time: 'pinned', host: 'h', run_id: 'other', nonce: 'n' }));
  let clock = 0;
  const sleeps = [];
  await assert.rejects(appendLocked(f, encodeValid('finding').text, { waitMs: 100, lockCtx: { ...lockCtx, host: 'h' },
    lockOptions: { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } } }), (e) => e.code === 'lock_timeout');
  assert.ok(sleeps.length > 0 && sleeps.reduce((a, b) => a + b, 0) <= 100);
  assert.deepEqual(readFileSync(f), before);
  rmSync(`${f}.lock`);
  const ac = new AbortController();
  ac.abort(Object.assign(new Error('stop'), { code: 'stop' }));
  await assert.rejects(appendLocked(f, encodeValid('finding').text, { lockCtx, lockOptions: { signal: ac.signal } }), (e) => e.code === 'stop');
  assert.deepEqual(readFileSync(f), before);
  assert.equal(existsSync(`${f}.lock`), false);
  await assert.rejects(appendLocked(f, 'no newline', { lockCtx }), (e) => e.code === 'bad_append');
});

// ---- legacy isolation (V §4.2/§4.3, design R1): T-C2, T-C3, T-C6 against the T-C1 golden ------------------------------
const at = (s) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
const ev2 = (name, s, e, over = {}, ticket = 'T1', runId = 'run-1') => ev.encodeEvent({ ticket, runId, eventId: VALID[name].eventId, name,
  metrics: { ...VALID[name].metrics, ...over }, detail: VALID[name].detail, startedAt: at(s), endedAt: at(e) }).text;
/** Every kind, timed to overlap T1's BUILD phase (100-700 s), its user wait, and review round a (700-1000 s): unstripped, they move legacy figures. */
const instrumented = (logs) => ({ ...logs,
  T1: [...logs.T1, ev2('owner_decision', 150, 200), ev2('host_sleep', 120, 140), ev2('gate_run', 110, 300), ev2('repair_batch', 870, 920),
    ev2('review_lane', 700, 800, { review_execution: 'review-a' }), ev2('milestone', 900, 900), ev2('finding', 900, 900), ev2('run_mode', 0, 0),
    ev2('run_mode', 5, 5, {}, 'T1', 'run-events-only'), ev2('closure', 1000, 1000, { through: at(1000) })],
  A: [ev2('milestone', 10, 10, {}, 'A', 'run-a'), ev2('review_lane', 10, 20, {}, 'A', 'run-a')] });

test('T-C2 / T-C3 / T-C6: with every event kind added (and an events-only ticket A), eval --all and run-log summary --all equal the origin/main golden', async () => {
  const { capture } = await import('../legacy-golden.capture.test-helper.mjs');
  const { GOLDEN } = await import('../legacy-golden.mjs');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  let injected;
  const got = await capture(SCRIPTS, { injectLogs: (logs) => (injected = instrumented(logs)) });
  assert.equal(JSON.stringify(got, null, 1), JSON.stringify(golden.data, null, 1));
  // The control: the injected rows really reach the CLIs and would move the legacy figures if they were not stripped.
  const rows = injected.T1.flatMap((r) => (typeof r === 'string' ? r.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [r])).filter((r) => r.run_id === 'run-1');
  const strip = (rs) => rs.filter((r) => !ev.isEventName(r.name));
  assert.notEqual(JSON.stringify(buildRun('T1', 'run-1', rows).durations), JSON.stringify(buildRun('T1', 'run-1', strip(rows)).durations));
  assert.deepEqual(ev.legacyRows(rows), strip(rows));
  assert.equal(new Set(rows.filter((r) => ev.isEventName(r.name)).map((r) => r.name)).size, ev.EVENT_NAMES.length);
});

test('lost signal: S-04-only damage leaves eval output byte-identical, and lostSignal reports it; an unreadable state is reported too', (t) => {
  const make = (extra) => {
    const dir = mkdtempSync(join(tmpdir(), 's04a2-lost-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    spawnSync('git', ['init', '-q', dir]);
    const d = join(dir, '.git', 'ai-skills', 'ship-ticket');
    mkdirSync(d, { recursive: true });
    const legacy = ['start', 'end'].map((event) => JSON.stringify({ schema: ev.RUN_LOG_SCHEMA, ticket: 'T1', run_id: 'run-1', event, event_id: 'wf', kind: 'workflow', name: 'ticket',
      timestamp: event === 'start' ? T0 : T1, metrics: {}, ...(event === 'end' ? { duration_ms: 60000, outcome: 'complete' } : {}) })).join('\n') + '\n';
    writeFileSync(join(d, 'T1.jsonl'), legacy + extra);
    return { dir, d };
  };
  const ms = encodeValid('milestone').text.split('\n');
  const damaged = `${ms[0]}\n${JSON.stringify({ ...JSON.parse(ms[1]), duration_ms: 5 })}\n${encodeValid('finding').text.split('\n')[1]}\n${encodeValid('review_lane').text.slice(0, 40)}`;
  const clean = make(''), dirty = make(damaged);
  const report = (dir) => spawnSync(process.execPath, [join(SCRIPTS, 'eval.mjs'), 'report', '--all', '--repo', dir], { encoding: 'utf8' });
  const a = report(clean.dir), b = report(dirty.dir);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.stdout, a.stdout);
  assert.deepEqual(Object.keys(JSON.parse(b.stdout)), ['schema', 'runs', 'cross_run', 'note']);
  assert.deepEqual(lostSignal(clean.d, 'T1'), { torn_bytes: 0, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0, state_unreadable: false });
  assert.deepEqual(lostSignal(dirty.d, 'T1'), { torn_bytes: 40, undecodable_lines: 0, malformed_lines: 0, invalid_events: 2, state_unreadable: false });
  writeFileSync(join(clean.d, 'T1.state.json'), '{"run_id": ');
  assert.equal(lostSignal(clean.d, 'T1').state_unreadable, true);
  writeFileSync(join(clean.d, 'T1.state.json'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
  assert.equal(lostSignal(clean.d, 'T1').state_unreadable, true, 'a state that only parses after a lossy decode is unreadable');
  assert.deepEqual(lostSignal(clean.d, 'NONE'), { torn_bytes: 0, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0, state_unreadable: false });
});

test('zero unhandled rejections across this file', () => { assert.equal(unhandled, 0); });

// ---- mutation check (L1): each mutant must be killed by a REAL assertion failure of this file --------------------------
const MUTANTS = [
  ['measure/events.mjs', 'label optional', "const LABEL = { label: E(['measured', 'estimated']) };", "const LABEL = { label: E(['measured', 'estimated'], true) };"],
  ['measure/events.mjs', 'string policy dropped', "if (!pattern.test(v)) problems.push", "if (false) problems.push"],
  ['measure/events.mjs', 'stricter field patterns ignored', "def.pattern?.[k] ?? SAFE_ID", "SAFE_ID"],
  ['measure/events.mjs', 'verdict iff result dropped', "rule((m('result') === 'verdict') === (m('verdict') !== undefined), 'verdict_iff_result_verdict', '/metrics/verdict');", ""],
  ['measure/events.mjs', 'majors without verdict', "rule(m('verdict') !== undefined || (m('majors') === undefined && m('minors') === undefined), 'counts_need_verdict', '/metrics/majors');", ""],
  ['measure/events.mjs', 'closure pair unchecked', "rule(CLOSURE_PAIRS.includes(`${m('emitter')}/${m('count_source')}`), 'closure_pair', '/metrics/count_source');", ""],
  ['measure/events.mjs', 'closure state reference unchecked', "rule(engine === (m('state_sha256') !== undefined) && engine === (m('state_seq') !== undefined), 'closure_state_ref', '/metrics/state_sha256');", ""],
  ['measure/events.mjs', 'closure label cap removed', "rule(m('label') === (engine ? 'measured' : 'estimated'), 'closure_label', '/metrics/label');", ""],
  ['measure/events.mjs', 'empty closure allowed', "rule(Reflect.ownKeys(c).length > 0 && (u === undefined || Reflect.ownKeys(u).length > 0), 'closure_empty', '/detail/counts');", ""],
  ['measure/events.mjs', 'validator budgets removed', "const r = validate(input, shape, LIMITS);", "const r = validate(input, shape);"],
  ['measure/events.mjs', 'reader: kind unchecked', "if (own(end, 'kind') !== def.kind) return fail('wrong_kind', '/kind');", ""],
  ['measure/events.mjs', 'reader: point events may span', " || (def.point && t1 !== t0)", ""],
  ['measure/events.mjs', 'reader: duration unchecked', " || own(end, 'duration_ms') !== t1 - t0", ""],
  ['measure/events.mjs', 'reader: canonical id unchecked', "if (def.id && own(end, 'event_id') !== def.id(metrics)) return fail('event_id_not_canonical', '/event_id');", ""],
  ['measure/events.mjs', 'reader: through after timestamp', "if (name === 'closure' && !(Date.parse(own(metrics, 'through')) <= t1)) return fail('through_after_timestamp', '/metrics/through');", ""],
  ['measure/events.mjs', 'reader: start row may carry payload', "metrics: event === 'start' ? { object: {} } :", "metrics: event === 'start' ? { open: true, object: {} } :"],
  ['measure/events.mjs', 'writer: caller id silently replaced', "if (def.id && eventId !== undefined && eventId !== id) throw coded('invalid_event', `${name}: event_id must be ${id}`);", ""],
  ['measure/events.mjs', 'writer: bytes not re-checked', "const c = checkEventPair(s, e);", "const c = { ok: true, problems: [] };"],
  ['measure/events.mjs', 'writer: size cap removed', "if (Buffer.byteLength(text) > ROW_BYTES_MAX) throw", "if (false) throw"],
  ['measure/events.mjs', 'choke point: unbranded event rows pass', "if (!r || typeof r !== 'object' || isEventName(own(r, 'name'))) throw", "if (!r || typeof r !== 'object') throw"],
  ['measure/events.mjs', 'R11: torn record kept', "if (row && typeof row === 'object' && row.event === 'start' && isEventName(row.name)) end = from;", ""],
  ['measure/events.mjs', 'R11: torn tail kept', "let end = buf.lastIndexOf(0x0a) + 1;", "let end = buf.length;"],
  ['measure/events.mjs', 'lossy decode', "const decode = (bytes) => { try { return strict.decode(bytes); } catch { return null; } };", "const decode = (bytes) => bytes.toString('utf8');"],
  ['measure/events.mjs', 'dangling starts not counted', "lost.invalid_events += starts.size;", ""],
  ['measure/events.mjs', 'legacyRows keeps events', "rows.filter((row) => !isEventName(row?.name))", "rows.filter(() => true)"],
  ['run-log-io.mjs', 'check skipped', "if (check) check(buf.subarray(0, committed));", ""],
  ['run-log-io.mjs', 'torn tail not truncated', "if (committed < size) truncate(fd, committed);", ""],
  ['run-log-io.mjs', 'failed write not rolled back', "try { truncate(fd, committed); } catch { /* left torn: R11 drops it */ }", ""],
  ['run-log-io.mjs', 'short write not reported', "if (written !== data.length) throw coded('short_write', `${written} of ${data.length} bytes to ${file}`);", ""],
  ['run-log-io.mjs', 'engine lock path', "lockFile: `${file}.lock`", "lockFile: `${dirname(file)}/T1.lock`"],
  ['run-log-io.mjs', 'lock never released', "} finally { await handle.release(); }", "} finally { }"],
  ['run-log-io.mjs', 'no fsync', "        fsync(fd);\n", "\n"],
  ['run-log-io.mjs', 'no directory fsync', "if (created && platform !== 'win32') {", "if (false) {"],
  ['run-log-io.mjs', 'directory fsync on every append', "if (created && platform !== 'win32') {", "if (platform !== 'win32') {"],
  ['measure/events.mjs', 'validator not total', "try { return crossChecked(name, def, input, metrics, detail, problems); } catch { return { ok: false, problems: [{ code: 'unreadable', path: '' }] }; }", "return crossChecked(name, def, input, metrics, detail, problems);"],
  ['run-log.mjs', 'lone --started-at is zero-length', "const endedAt = options['ended-at'] ?? now, startedAt = options['started-at'] ?? endedAt;", "const startedAt = options['started-at'] ?? options['ended-at'] ?? now, endedAt = options['ended-at'] ?? startedAt;"],
  ['run-log.mjs', 'start/end accept event names', "if (isEventName(name)) fail(`${name} is a measurement event: use run-log.mjs event`);", ""],
  ['run-log.mjs', 'event writes closures', "if (!isEventName(name) || name === 'closure') fail", "if (!isEventName(name)) fail"],
  ['run-log.mjs', 'duplicates allowed', "if (rows.some((row) => row.run_id === runId && row.event_id === id)) throw", "if (false) throw"],
  ['run-log.mjs', 'measurement history unchecked', "if (lost.invalid_events) throw", "if (false) throw"],
  ['run-log.mjs', 'metrics typed by guess', "typed(item.slice(at + 1), fieldType(name, key))", "typed(item.slice(at + 1), /^\\d+$/.test(item.slice(at + 1)) ? 'int' : fieldType(name, key))"],
  ['run-log.mjs', 'summary reads event rows', "      if (isEventName(row?.name)) continue;\n", "\n"],
  ['run-log.mjs', 'writers read the raw tail', "(tolerant ? buf : buf.subarray(0, committedLength(buf)))", "buf"],
  ['run-log.mjs', 'close claims measured', "await writeEvent(options, 'closure', { label: 'estimated',", "await writeEvent(options, 'closure', { label: 'measured',"],
  ['eval.mjs', 'eval reads event rows', "legacyRows(readJsonl(log))", "readJsonl(log)"],
  ['eval.mjs', 'unreadable state not reported', "catch { stateUnreadable = true; }", "catch { }"],
];
const CHILD_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), EVENTS_MUTANT_RUN: '1' };
test('mutation: every mutant is killed by a real assertion failure (never by a load error, crash or timeout), on an LF-normalised source', { skip: MUTANT_CHILD }, () => {
  const testRel = join('measure', 'events.test.mjs');
  const src = Object.fromEntries([...new Set(MUTANTS.map(([f]) => f))].map((f) => [f, loadMutationSource(join(SCRIPTS, f))]));
  for (const [f, name, from] of MUTANTS) assert.equal(src[f].split(from).length - 1, 1, `${f} "${name}": anchor must occur exactly once`);
  const crlf = src['measure/events.mjs'].replace(/\n/g, '\r\n');
  const dir = mkdtempSync(join(tmpdir(), 's04a2-crlf-'));
  try { writeFileSync(join(dir, 'e.mjs'), crlf); assert.equal(loadMutationSource(join(dir, 'e.mjs')), src['measure/events.mjs'], 'a CRLF checkout anchors the same'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(classify(runMutant({ root: SCRIPTS, testRel, env: CHILD_ENV })).verdict, 'survived', 'the unmutated tree passes in the harness');
  const bad = [];
  for (const [f, name, from, to] of MUTANTS) {
    const c = classify(runMutant({ root: SCRIPTS, testRel, env: CHILD_ENV, overrides: { [f]: src[f].replace(from, to) } }));
    console.log(`# mutant ${c.verdict}: ${f} ${name} <- ${c.failing.slice(0, 2).map((x) => x.slice(0, 50)).join(' | ')}`);
    if (c.verdict !== 'killed') bad.push(`${f} ${name}: ${c.verdict} ${c.why ?? ''}`);
  }
  assert.deepEqual(bad, []);
});
