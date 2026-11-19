// S-04a2 measurement event contract: invariant-level tests (generic over EVERY event kind), the R11 torn-tail corpus, injected
// write faults, the single write choke point, legacy isolation (T-C2, T-C3, T-C6 against the T-C1 golden) and the mutation check.
// No wall-clock windows and no real sleeps: lock waits run on an injected clock, the win32 rename retry wait is an injected no-op
// (`wait`), the CLI child runs on a pinned clock, and host probes (processInfo) are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync as realWriteSync, ftruncateSync as realFtruncate,
  openSync as realOpen, closeSync as realClose, renameSync as realRename } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ev from './events.mjs';
import { createHash } from 'node:crypto';
import { appendLocked, quarantineLocked, sidecarPath } from '../run-log-io.mjs';
import { buildRun } from '../run-summary.mjs';
import { lostSignal } from '../eval.mjs';
import { classify, loadMutationSource, runMutant, runMutantAsync } from '../lib/mutation.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const RUN_LOG = join(SCRIPTS, 'run-log.mjs');
const MUTANT_CHILD = process.env.EVENTS_MUTANT_RUN === '1';
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

// ---- the test's OWN oracle: one valid example and the field types of every kind (independent of events.mjs) ----------------
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-01T00:01:00.000Z';
const POINT = new Set(['run_mode', 'milestone', 'finding', 'closure', 'log_loss']);
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
  log_loss: { metrics: { label: 'measured', cause: 'torn_tail', offset: 10, bytes: 5, sha256: 'd'.repeat(64) } },
};
const NOT_CLI = new Set(['closure', 'log_loss']); // written only by `close` and by the writer
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
  finding: `label:${L} fingerprint:fp severity:E(Blocker,Major,Minor,Info) repeat:bool occurrence:posint`,
  // In this base (an orchestrator posthoc closure) the cross-field rules leave exactly these values valid.
  closure: 'label:E(estimated) through:ts final:bool emitter:E(orchestrator) count_source:E(orchestrator_tally,posthoc) state_sha256?:never state_seq?:never',
  log_loss: 'label:E(measured) cause:E(torn_tail,quarantine) offset:uint bytes:posint sha256:sha256',
};
// Values outside a field's enum: `result` in the base must stay `verdict` (verdict is set); other results are tested by the cross-field test.
const ENUM_DECOYS = ['verdict', 'timeout', 'cancelled', 'infra_failed', 'no_result', 'engine', 'engine_state', 'measured', 'estimated', 'High', 'major', 'PASS ', 'pass'];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isTs = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) && new Date(v.replace(/\.\d+Z$/, 'Z')).toISOString().slice(0, 19) === v.slice(0, 19);
const ORACLE = {
  id: (v) => typeof v === 'string' && SAFE.test(v), rx: (v) => typeof v === 'string' && /^review-[A-Za-z0-9._-]{1,80}$/.test(v),
  fp: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v),
  hex: (v) => typeof v === 'string' && /^[a-f0-9]{7,64}$/.test(v), sha256: (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
  posint: (v) => Number.isSafeInteger(v) && v >= 1, uint: (v) => Number.isSafeInteger(v) && v >= 0, int: (v) => Number.isSafeInteger(v),
  bool: (v) => typeof v === 'boolean', ts: isTs, never: () => false,
};
const parseFields = (spec) => spec.split(' ').map((f) => {
  const [, key, optional, type] = /^([a-z_0-9]+)(\?)?:(.+)$/.exec(f);
  const en = /^E\((.*)\)$/.exec(type);
  return { key, optional: Boolean(optional), valid: en ? (v) => en[1].split(',').includes(v) : ORACLE[type], values: en ? en[1].split(',') : [] };
});
const CORPUS = [null, true, false, 0, 1, 2, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, '1', '0', 'true', '', 'x', 'X-1.b_c', 'review-a', `review-${'a'.repeat(80)}`, `review-${'a'.repeat(81)}`, 'a'.repeat(96), 'a'.repeat(97), 'abcdef0', 'ABCDEF0', 'abcdef',
  'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(128), 'a'.repeat(129), '-x', '.x', 'a b', 'a\nb', 'a/b', '../x', 'é', 'a:b', T0, '2026-01-01T00:00:00Z', '2026-02-30T00:00:00Z',
  '2026-01-01T00:00:00+02:00', '2026-01-01T24:00:00Z', {}, [], ['x'], { a: 1 }, ...ENUM_DECOYS];
const times = (name) => (POINT.has(name) ? { startedAt: T1, endedAt: T1 } : { startedAt: T0, endedAt: T1 });
const clone = (x) => JSON.parse(JSON.stringify(x));
const ZERO_LOST = { torn_bytes: 0, undecodable_lines: 0, malformed_lines: 0, invalid_events: 0, loss_records: 0, recovered_bytes: 0 };
const marker = (ticket = 'T1') => (info) => ev.encodeRecords([ev.encodeLoss(ticket, info, T1)]);
/** The measurement half of run-log's whole-file check (the legacy half is exercised through the CLI tests). */
const cleanCheck = (after) => { const { lost } = ev.readEvents(after); const bad = Object.entries(lost).filter(([k, n]) => n && !['loss_records', 'recovered_bytes'].includes(k)); if (bad.length) throw Object.assign(new Error(JSON.stringify(bad)), { code: 'unsafe_history' }); };
/** Test guards so a missing sidecar or an unexpected rejection fails by ASSERTION (a mutant is then killed, not invalid). */
const readSidecar = (path) => { assert.ok(existsSync(path), `sidecar exists: ${path}`); return JSON.parse(readFileSync(path, 'utf8')); };
const mustResolve = async (promise, what) => { try { return await promise; } catch (e) { return assert.fail(`${what}: rejected ${e?.code ?? e}`); } };
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
    if (name === 'log_loss') { // a loss record is not a fact: it is counted in the lost signal
      assert.deepEqual(read.events, []);
      assert.deepEqual(read.lost, { ...ZERO_LOST, loss_records: 1, recovered_bytes: 5 });
    } else {
      assert.deepEqual(read.events, [{ start, end }], name);
      assert.deepEqual(read.lost, ZERO_LOST);
    }
    assert.deepEqual(read.bad, [], name);
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
  const closureAt = (through) => JSON.parse(ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'closure', metrics: { ...VALID.closure.metrics, through }, detail: VALID.closure.detail, startedAt: T1, endedAt: T1 }).text.split('\n')[1]).event_id;
  assert.equal(closureAt('2026-01-01T00:00:00Z'), closureAt('2026-01-01T00:00:00.000Z'), 'one instant, one closure id');
  assert.notEqual(closureAt('2026-01-01T00:00:00.001Z'), closureAt('2026-01-01T00:00:00.000Z'));
  // Every canonical id fits SAFE_ID at the maxima of the fields it embeds.
  const maxed = { review_lane: { review_execution: `review-${'a'.repeat(80)}`, lane_role: 'second_opinion', attempt: Number.MAX_SAFE_INTEGER },
    repair_batch: { n: Number.MAX_SAFE_INTEGER }, gate_run: { n: Number.MAX_SAFE_INTEGER }, owner_decision: { n: Number.MAX_SAFE_INTEGER },
    finding: { fingerprint: 'a'.repeat(96), occurrence: Number.MAX_SAFE_INTEGER }, closure: { through: '2026-01-01T00:00:00.123456789Z', final: false },
    milestone: { at: 'plan_approved' }, log_loss: { offset: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER } };
  for (const name of ev.EVENT_NAMES.filter((n) => VALID[n].eventId === undefined)) {
    const enc = ev.encodeEvent({ ticket: 'T1', runId: 'r', name, metrics: { ...VALID[name].metrics, ...maxed[name] }, detail: VALID[name].detail, ...times(name) });
    assert.ok(SAFE.test(JSON.parse(enc.text.split('\n')[1]).event_id), name);
  }
  refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'closure', metrics: { ...VALID.closure.metrics, through: '2026-01-01T00:01:00.001Z' }, detail: VALID.closure.detail, startedAt: T1, endedAt: T1 }), 'through after the closure');
  refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'repair_batch', metrics: VALID.repair_batch.metrics, detail: { finding_ids: Array.from({ length: 600 }, () => 'F'.repeat(120)) }, startedAt: T0, endedAt: T1 }), 'size cap');
  // A Proxy whose `get` trap lies: the encoder never calls `get` (data descriptors only), so the bytes are the validated value.
  const lying = new Proxy({ label: 'measured' }, { get: (t, k) => (k === 'label' ? 'bogus' : Reflect.get(t, k)) });
  let lyingText;
  try { lyingText = ev.encodeEvent({ ticket: 'T1', runId: 'r', eventId: 's', name: 'host_sleep', metrics: lying, startedAt: T0, endedAt: T1 }).text; } catch (e) { lyingText = `refused: ${e.code}`; }
  assert.ok(lyingText.includes('"label":"measured"') && !lyingText.includes('bogus'), 'what is written is what was validated');
  for (const hostile of [{ label: 'measured', toJSON: () => ({ label: 'bogus' }) }, Object.defineProperty({}, 'label', { get: () => 'measured', enumerable: true })]) {
    refuse(() => ev.encodeEvent({ ticket: 'T1', runId: 'r', eventId: 's', name: 'host_sleep', metrics: hostile, startedAt: T0, endedAt: T1 }), 'toJSON / getter');
  }
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

test('I1 only validated bytes are written: for EVERY kind, a legacy-looking record whose serialisation would be that kind is refused, never written', () => {
  const legacy = { schema: ev.RUN_LOG_SCHEMA, ticket: 'T1', run_id: 'r', event: 'start', event_id: 'x', kind: 'activity', name: 'build', timestamp: T0, metrics: {} };
  for (const name of ev.EVENT_NAMES) {
    const [s, e] = encodeValid(name).text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const row of [s, e]) {
      const forged = [
        ['toJSON', { ...legacy, toJSON: () => row }],
        ['getter name', Object.defineProperty({ ...legacy }, 'name', { get: () => name, enumerable: true })],
        ['inherited name', Object.assign(Object.create({ name }), (({ name: _n, ...rest }) => rest)(legacy))],
        ['non-enumerable name', Object.defineProperty((({ name: _n, ...rest }) => rest)(legacy), 'name', { value: name, enumerable: false })],
        ['Proxy get', new Proxy({ ...legacy }, { get: (t, k) => (k === 'name' ? name : Reflect.get(t, k)) })],
        ['nested toJSON', { ...legacy, metrics: { toJSON: () => row } }],
        ['Proxy descriptor', new Proxy({ ...legacy }, { getOwnPropertyDescriptor: (t, k) => (k === 'name' ? { value: name, enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(t, k)) })],
      ];
      for (const [how, rec] of forged) {
        let text = null;
        try { text = ev.encodeRecords([rec]); } catch (err) { assert.ok(['not_plain_data', 'unvalidated_event', 'not_a_row'].includes(err.code), `${name} ${how}: ${err.code}`); }
        if (text !== null) { // accepted only when the BYTES are a legacy row: then nothing of the S-04 kind was written
          const parsed = JSON.parse(text);
          assert.equal(ev.isEventName(parsed.name), false, `${name} ${how}: wrote ${text.slice(0, 80)}`);
          assert.deepEqual(parsed, legacy, `${name} ${how}`);
        }
      }
    }
  }
  // canonicalJson is JSON.stringify for plain data (legacy rows keep their exact bytes) and refuses everything else.
  for (const v of [legacy, { a: [1, -0, 1.5, 'é€😀', null, true, { b: [] }], 2: 'x', 10: 'y', z: {} }, Object.assign(Object.create(null), { a: 1 }), [], 'x', 0]) assert.equal(ev.canonicalJson(v), JSON.stringify(v));
  for (const v of [undefined, () => 1, 1n, NaN, Infinity, Symbol('s'), new Date(0), new Map(), [1, , 3], Object.assign([1], { x: 2 }), { [Symbol('k')]: 1 }, { a: undefined }]) assert.throws(() => ev.canonicalJson(v), (e) => e.code === 'not_plain_data', String(typeof v));
  let deep = {}; for (let i = 0; i < 40; i++) deep = { d: deep };
  assert.throws(() => ev.canonicalJson(deep), (e) => e.code === 'not_plain_data');
  let invoked = false;
  for (const v of [Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false }), Object.defineProperty({}, 'g', { get: () => { invoked = true; return 1; }, enumerable: true })]) {
    assert.throws(() => ev.canonicalJson(v), (e) => e.code === 'not_plain_data' && /not an enumerable data property/.test(e.message), JSON.stringify(Object.getOwnPropertyNames(v)));
  }
  assert.equal(invoked, false, 'a getter is never invoked');
  assert.throws(() => ev.canonicalJson(new Proxy({}, { ownKeys() { throw new Error('trap'); } })), (e) => e.code === 'not_plain_data');
});

// ---- the single write path, structurally ---------------------------------------------------------------------------------
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === 'fixtures' ? [] : sources(join(dir, d.name)))
  : d.name.endsWith('.mjs') && !d.name.endsWith('.test.mjs') && !d.name.includes('test-helper') ? [join(dir, d.name)] : []));
test('structural: one module holds the row schema literal, only run-log.mjs imports the encoder or the appender, and run-log.mjs has one write call', () => {
  const files = sources(SCRIPTS).map((f) => [relative(SCRIPTS, f).split('\\').join('/'), loadMutationSource(f)]);
  assert.ok(files.length > 30, `the scan sees the scripts tree (${files.length})`);
  assert.deepEqual(files.filter(([, s]) => /['"`]ship-ticket-run-log-v1['"`]/.test(s)).map(([f]) => f), ['measure/events.mjs']);
  assert.deepEqual(files.filter(([, s]) => /\bencode(Event|Records|Loss)\b/.test(s)).map(([f]) => f).sort(), ['measure/events.mjs', 'run-log.mjs']);
  assert.deepEqual(files.filter(([, s]) => /\b(appendLocked|quarantineLocked)\b/.test(s)).map(([f]) => f).sort(), ['run-log-io.mjs', 'run-log.mjs']);
  assert.deepEqual(files.filter(([, s]) => /\bRUN_LOG_SCHEMA\b/.test(s)).map(([f]) => f).sort(), ['measure/events.mjs', 'run-log.mjs']);
  const runLog = files.find(([f]) => f === 'run-log.mjs')[1];
  assert.equal((runLog.match(/\b(appendFileSync|writeFileSync|writeSync|createWriteStream|openSync|truncateSync)\b/g) ?? []).length, 0);
  assert.equal((runLog.match(/\bappendLocked\(/g) ?? []).length, 1);
  assert.match(runLog, /await appendLocked\(path, encodeRecords\(records\), \{ marker: \(info\) => encodeRecords\(\[encodeLoss\(/);
  assert.equal((runLog.match(/\bquarantineLocked\(/g) ?? []).length, 1);
  assert.equal((runLog.match(/check: \(after(, before)?\) => \{? ?assertCleanLog\(after, path\)/g) ?? []).length, 2, 'both write paths validate the whole resulting file');
});

// ---- CLI ---------------------------------------------------------------------------------------------------------------
/** The CLI child's clock is pinned (a preloaded `Date` whose no-argument constructor and `now()` return FIXED_NOW), so neither a real
 *  clock before T0 nor one beyond year 2999 can change an outcome. FIXED_NOW is after T1 and before the 2999 "future" the tests use. */
const FIXED_NOW = '2026-06-01T00:00:00.000Z';
const PIN_CLOCK = `data:text/javascript,${encodeURIComponent(`const R = Date, F = ${Date.parse(FIXED_NOW)};
globalThis.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(F); } static now() { return F; } };`)}`;
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  const log = join(dir, '.git', 'ai-skills', 'ship-ticket', 'T1.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  const cli = (...args) => spawnSync(process.execPath, ['--import', PIN_CLOCK, RUN_LOG, ...args, '--repo', dir, '--ticket', 'T1'], { encoding: 'utf8' });
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
  assert.deepEqual([...ev.CLI_EVENT_NAMES].sort(), ev.EVENT_NAMES.filter((n) => !NOT_CLI.has(n)).sort());
  for (const name of ev.CLI_EVENT_NAMES) {
    const over = name === 'review_lane' ? { candidate_sha: '1234567' } : {};
    const res = r.cli(...eventArgs(name, over));
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    written.push({ ...VALID[name].metrics, ...over });
  }
  const { events, lost } = ev.readEvents(r.bytes());
  assert.deepEqual(events.map((e) => e.end.metrics), written);
  assert.equal(events.find((e) => e.end.name === 'review_lane').end.metrics.candidate_sha, '1234567');
  assert.deepEqual(lost, ZERO_LOST);
  const lone = r.cli('event', '--run-id', 'run-1', '--name', 'host_sleep', '--event-id', 'sleep-9', '--metric', 'label=measured', '--started-at', T0);
  assert.equal(lone.status, 0, lone.stderr);
  assert.equal(JSON.parse(lone.stdout.split('\n')[1]).timestamp, FIXED_NOW, 'a lone --started-at ends now (the pinned clock), not at the start');
  assert.ok(Date.parse(FIXED_NOW) > Date.parse(T0) && Date.parse(FIXED_NOW) < Date.parse('2999-01-01T00:00:00Z'), 'the pinned clock sits between T0 and the "future" used below');
  written.push({ label: 'measured' });
  assert.deepEqual(ev.readEvents(r.bytes()).events.map((e) => e.end.metrics), written);
  const before = r.bytes();
  for (const args of [eventArgs('review_lane'), eventArgs('milestone'), eventArgs('host_sleep'), // duplicates of (run, event_id)
    eventArgs('review_lane', { majors: 'x' }), eventArgs('gate_run', { clean: 'yes' }), eventArgs('finding', { severity: 'High' }), eventArgs('run_mode', { label: 'unknown' }),
    ['event', '--run-id', 'run-1', '--name', 'closure', ...metricArgs(VALID.closure.metrics), '--detail', JSON.stringify(VALID.closure.detail)],
    ['event', '--run-id', 'run-1', '--name', 'log_loss', ...metricArgs(VALID.log_loss.metrics)],
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

test('I2/I3 via the CLI: a torn tail is moved to a sidecar with a log_loss record; the loss survives a later write and a later start (Codex case)', (t) => {
  const r = repo(t);
  assert.equal(r.cli(...eventArgs('milestone')).status, 0);
  const committed = r.bytes();
  const rec = encodeValid('review_lane').text;
  for (const cut of [rec.indexOf('\n') + 7, 3, rec.length - 1]) { // cut = length - 1: a complete row missing only its final LF is still torn
    writeFileSync(r.log, Buffer.concat([committed, Buffer.from(rec.slice(0, cut))]));
    if (cut > rec.indexOf('\n')) { // a complete start line is not torn: it fails closed until quarantined (I3)
      const refused = r.cli(...eventArgs('review_lane'));
      assert.equal(refused.status, 1, `cut ${cut}`);
      assert.match(refused.stderr, /quarantine/);
      assert.equal(r.cli('quarantine').status, 0);
    }
    const res = r.cli('start', '--run-id', 'run-1', '--kind', 'activity', '--name', 'build', '--event-id', `b${cut}`); // an unrelated legacy start
    assert.equal(res.status, 0, `cut ${cut}: ${res.stderr}`);
    assert.equal(r.cli(...eventArgs('review_lane')).status, 0, `cut ${cut}: the replay succeeds once`);
    const d = dirname(r.log), sidecars = readdirSync(d).filter((f) => f.startsWith('T1.jsonl.lost-'));
    const moved = Buffer.concat(sidecars.flatMap((f) => readSidecar(join(d, f)).pieces.map((p) => Buffer.from(p.base64, 'base64'))));
    assert.deepEqual(moved, Buffer.from(rec.slice(0, cut)), `cut ${cut}: every dropped byte is in a sidecar, verbatim`);
    const sig = lostSignal(d, 'T1');
    assert.equal(sig.recovered_bytes, cut, `cut ${cut}: the loss stays visible after recovery and later writes`);
    assert.ok(sig.loss_records >= 1);
    assert.equal(ev.readEvents(r.bytes()).events.filter((e) => e.end.name === 'review_lane').length, 1);
    for (const f of sidecars) rmSync(join(d, f));
    writeFileSync(r.log, committed);
  }
});

test('I3/I4 via the CLI: a COMPLETE invalid or malformed row is never torn: event AND legacy writes fail closed until quarantine (Codex case)', (t) => {
  const r = repo(t);
  const legacyStart = (id) => `${JSON.stringify({ schema: ev.RUN_LOG_SCHEMA, ticket: 'T1', run_id: 'run-1', event: 'start', event_id: id, kind: 'activity', name: 'build', timestamp: T0, metrics: {} })}\n`;
  const damageOf = (name) => {
    const [s, e] = encodeValid(name).text.split('\n').filter(Boolean);
    return [`{"event":"start","name":"${name}","metrics":{"label":"bogus"}}\n`, `${s}\n`, `${e}\n`, `${s}\n${JSON.stringify({ ...JSON.parse(e), duration_ms: 7 })}\n`, '{"half": \n'];
  };
  for (const name of ['milestone', 'review_lane']) { // every kind is covered in-process below; the CLI adds the legacy rules and the command
    for (const bad of damageOf(name)) {
      const good = legacyStart('g1') + encodeValid('milestone').text;
      const before = Buffer.from(good + bad);
      writeFileSync(r.log, before);
      for (const args of [eventArgs('host_sleep'), ['start', '--run-id', 'run-1', '--kind', 'activity', '--name', 'build', '--event-id', 'g2']]) {
        const res = r.cli(...args);
        assert.equal(res.status, 1, `${name} ${bad.slice(0, 50)}: ${args[0]}`);
        assert.deepEqual(r.bytes(), before, 'refused and left unchanged');
      }
      assert.ok(ev.readEvents(before).lost.invalid_events + ev.readEvents(before).lost.malformed_lines >= 1, 'the reader sees it');
      const q = r.cli('quarantine');
      assert.equal(q.status, 0, q.stderr);
      const info = JSON.parse(q.stdout).quarantined;
      assert.ok(info, `${name} ${bad.slice(0, 40)}: something was quarantined`);
      assert.equal(info.bytes, Buffer.byteLength(bad));
      const side = readSidecar(JSON.parse(q.stdout).sidecar);
      assert.equal(Buffer.concat(side.pieces.map((p) => Buffer.from(p.base64, 'base64'))).toString(), bad, 'moved verbatim');
      assert.ok(r.bytes().toString().startsWith(good), 'every valid line is kept');
      assert.equal(r.cli(...eventArgs('host_sleep')).status, 0, 'writes resume');
      assert.equal(lostSignal(dirname(r.log), 'T1').recovered_bytes, Buffer.byteLength(bad));
      rmSync(JSON.parse(q.stdout).sidecar);
    }
  }
  writeFileSync(r.log, legacyStart('g1'));
  assert.deepEqual(JSON.parse(r.cli('quarantine').stdout), { quarantined: null }, 'a clean log is untouched');
});

test('history: undecodable bytes and legacy damage refuse an event write, unchanged', (t) => {
  const r = repo(t);
  const bad = Buffer.concat([Buffer.from('{"schema":"x","name":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  writeFileSync(r.log, bad);
  const res = r.cli(...eventArgs('host_sleep'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not valid UTF-8/);
  assert.deepEqual(r.bytes(), bad);
  writeFileSync(r.log, '{"not":"a row"}\n');
  assert.equal(r.cli(...eventArgs('host_sleep')).status, 1);
  assert.equal(r.bytes().toString(), '{"not":"a row"}\n');
});

// ---- R11 corpus: every truncation point of every record kind ------------------------------------------------------------
const lockCtx = { processInfo: () => ({ alive: true, startTime: 'pinned' }) };
const quiet = { fsyncSync: () => {} }; // durability is not under test in the corpus loop (it is in the fault tests below)
test('R11 corpus (I2/I3): every record kind, every cut k: torn = the bytes after the last LF only; the next append moves exactly them to a sidecar with a log_loss record, or fails closed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-r11-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = (event, extra) => `${JSON.stringify({ schema: ev.RUN_LOG_SCHEMA, ticket: 'T1', run_id: 'run-1', event, event_id: 'u1', kind: 'activity', name: 'build', timestamp: T0, metrics: { note: 'é€😀' }, ...extra })}\n`;
  const prefix = Buffer.from(legacy('start') + encodeValid('host_sleep').text);
  const records = [...ev.EVENT_NAMES.map((n) => encodeValid(n, n === 'host_sleep' ? { eventId: 'sleep-2' } : {}).text), legacy('start'), legacy('end', { duration_ms: 0, outcome: 'pass' })];
  const next = encodeValid('milestone').text;
  let cuts = 0, refused = 0;
  for (const rec of records) {
    const bytes = Buffer.from(rec);
    for (let k = 0; k < bytes.length; k++) {
      const part = bytes.subarray(0, k), lf = part.lastIndexOf(0x0a) + 1, torn = part.subarray(lf);
      const buf = Buffer.concat([prefix, part]);
      const read = ev.readEvents(buf);
      assert.equal(ev.committedLength(buf), prefix.length + lf, `k=${k}`);
      assert.equal(read.lost.torn_bytes, torn.length, `k=${k}`);
      assert.equal(read.lost.undecodable_lines, 0, `k=${k}: a torn multi-byte tail is torn, not undecodable`);
      assert.deepEqual(read.events, ev.readEvents(Buffer.concat([prefix, part.subarray(0, lf)])).events, `k=${k}: complete lines read the same with or without the torn tail`);
      const file = join(dir, `c${cuts++}.jsonl`);
      writeFileSync(file, buf);
      if (lf > 0) { // a complete start line of an S-04 record without its end: never torn, fails closed
        await assert.rejects(appendLocked(file, next, { lockCtx, fs: quiet, marker: marker(), check: cleanCheck }), (e) => e.code === 'unsafe_history', `k=${k}`);
        assert.deepEqual(readFileSync(file), buf, `k=${k}: unchanged`);
        assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(`c${cuts - 1}.jsonl.lost-`)), [], `k=${k}: nothing moved`);
        refused++;
        continue;
      }
      const res = await mustResolve(appendLocked(file, next, { lockCtx, fs: quiet, marker: marker(), check: cleanCheck }), 'appendLocked');
      const after = readFileSync(file);
      if (k === 0) { assert.equal(res.lost, null); assert.deepEqual(after, Buffer.concat([prefix, Buffer.from(next)])); continue; }
      assert.deepEqual(res.lost, { offset: prefix.length, bytes: k, sha256: createHash('sha256').update(torn).digest('hex'), cause: 'torn_tail' }, `k=${k}`);
      assert.deepEqual(after, Buffer.concat([prefix, Buffer.from(marker()(res.lost)), Buffer.from(next)]), `k=${k}`);
      const side = readSidecar(sidecarPath(file, res.lost));
      assert.deepEqual(Buffer.from(side.pieces[0].base64, 'base64'), torn, `k=${k}: verbatim`);
      assert.deepEqual(ev.readEvents(after).lost, { ...ZERO_LOST, loss_records: 1, recovered_bytes: k }, `k=${k}`);
      assert.equal(existsSync(`${file}.lock`), false);
    }
  }
  assert.ok(cuts > 2000 && refused > 500, `cuts ${cuts}, refused ${refused}`);
  for (const rec of records) assert.equal(ev.committedLength(Buffer.concat([prefix, Buffer.from(rec)])), prefix.length + Buffer.byteLength(rec));
  // A torn tail LONGER than the text appended next is fully replaced (the stale rest is truncated) and fully preserved.
  const big = Buffer.from(ev.encodeEvent({ ticket: 'T1', runId: 'r', name: 'repair_batch', metrics: VALID.repair_batch.metrics, detail: { finding_ids: Array.from({ length: 300 }, (_, i) => `F${i}`) }, startedAt: T0, endedAt: T1 }).text);
  const long = join(dir, 'long.jsonl'), tornLong = big.subarray(big.indexOf(0x0a) + 1, big.length - 3);
  writeFileSync(long, Buffer.concat([prefix, tornLong]));
  const res = await mustResolve(appendLocked(long, next, { lockCtx, fs: quiet, marker: marker(), check: cleanCheck }), 'appendLocked');
  assert.ok(tornLong.length > Buffer.byteLength(marker()(res.lost) + next));
  assert.deepEqual(readFileSync(long), Buffer.concat([prefix, Buffer.from(marker()(res.lost)), Buffer.from(next)]));
  assert.deepEqual(Buffer.from(readSidecar(sidecarPath(long, res.lost)).pieces[0].base64, 'base64'), tornLong);
  // The loss record stays counted through later appends (no reset).
  await mustResolve(appendLocked(long, encodeValid('finding').text, { lockCtx, fs: quiet, marker: marker(), check: cleanCheck }), 'appendLocked');
  await mustResolve(appendLocked(long, legacy('end', { duration_ms: 0, outcome: 'pass' }), { lockCtx, fs: quiet, marker: marker(), check: cleanCheck }), 'appendLocked');
  assert.equal(ev.readEvents(readFileSync(long)).lost.recovered_bytes, tornLong.length);
  await assert.rejects(appendLocked(join(dir, 'nomark.jsonl'), next, { lockCtx }).then(() => { writeFileSync(join(dir, 'nomark.jsonl'), '{"x'); return appendLocked(join(dir, 'nomark.jsonl'), next, { lockCtx }); }), (e) => e.code === 'loss_unrecorded');
  assert.equal(readFileSync(join(dir, 'nomark.jsonl'), 'utf8'), '{"x', 'no loss record, no move');
});

test('I3 in-process, every kind: a complete invalid row (the Codex row, a dangling start, an orphan or tampered end) is never torn and refuses the append, unchanged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-i3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  for (const name of ev.EVENT_NAMES) {
    const [s, e] = encodeValid(name).text.split('\n').filter(Boolean);
    for (const bad of [`{"event":"start","name":"${name}","metrics":{"label":"bogus"}}\n`, `${s}\n`, `${e}\n`, `${s}\n${JSON.stringify({ ...JSON.parse(e), duration_ms: 7 })}\n`]) {
      const before = Buffer.from(encodeValid('milestone').text + bad), file = join(dir, `i${n++}.jsonl`);
      assert.equal(ev.committedLength(before), before.length, `${name}: a complete row is committed, not torn`);
      writeFileSync(file, before);
      await assert.rejects(appendLocked(file, encodeValid('finding').text, { lockCtx, fs: quiet, marker: marker(), check: cleanCheck }), (err) => err.code === 'unsafe_history', `${name} ${bad.slice(0, 40)}`);
      assert.deepEqual(readFileSync(file), before);
    }
  }
});

test('I4 quarantine (in-process, every kind): moves exactly readEvents().bad to a sidecar, keeps every other byte, records the loss; a refused check moves nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-q-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = encodeValid('milestone').text;
  let n = 0;
  for (const name of ev.EVENT_NAMES) {
    const [s, e] = encodeValid(name).text.split('\n').filter(Boolean);
    const bads = [`${s}\n`, `${JSON.stringify({ ...JSON.parse(e), event_id: 'orphan' })}\n`, Buffer.from([0x7b, 0xff, 0x0a]), 'not json\n']; // a dangling start, an orphan end
    const file = join(dir, `q${n++}.jsonl`);
    const parts = [good, bads[0], encodeValid('milestone', { metrics: { label: 'measured', at: 'failed' } }).text, bads[1], bads[2], bads[3], 'torn'].map((x) => Buffer.from(x));
    const before = Buffer.concat(parts);
    writeFileSync(file, before);
    const info = await mustResolve(quarantineLocked(file, { lockCtx, fs: quiet, select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: cleanCheck }), 'quarantineLocked');
    const moved = Buffer.concat([parts[1], parts[3], parts[4], parts[5], parts[6]]);
    assert.deepEqual(info, { offset: parts[0].length, bytes: moved.length, sha256: createHash('sha256').update(moved).digest('hex'), cause: 'quarantine' }, name);
    assert.deepEqual(readFileSync(file), Buffer.concat([parts[0], parts[2], Buffer.from(marker()(info))]), name);
    const side = readSidecar(sidecarPath(file, info));
    assert.deepEqual(Buffer.concat(side.pieces.map((p) => Buffer.from(p.base64, 'base64'))), moved);
    assert.deepEqual(side.pieces.map((p) => p.offset), [1, 3, 4, 5, 6].map((i) => Buffer.concat(parts.slice(0, i)).length), `${name}: original offsets kept`);
    assert.deepEqual(ev.readEvents(readFileSync(file)).lost, { ...ZERO_LOST, loss_records: 1, recovered_bytes: moved.length });
    const refuse = Object.assign(new Error('no'), { code: 'no' });
    writeFileSync(file, before);
    await assert.rejects(quarantineLocked(file, { lockCtx, fs: quiet, select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: () => { throw refuse; } }), refuse);
    assert.deepEqual(readFileSync(file), before, `${name}: a refused quarantine changes nothing`);
  }
});

test('I2 quarantine sidecars: two recoveries with equal removed bytes and first offset but different later offsets keep both sidecars', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-qc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = encodeValid('milestone').text, [s] = encodeValid('milestone').text.split('\n').filter(Boolean);
  const dangling = Buffer.from(`${s}\n`), gapA = Buffer.from(good), gapB = Buffer.from(good + good);
  const run = async (name, gap) => {
    const file = join(dir, name);
    writeFileSync(file, Buffer.concat([Buffer.from(good), dangling, gap, dangling]));
    const info = await mustResolve(quarantineLocked(file, { lockCtx, fs: quiet, select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: cleanCheck }), 'quarantineLocked');
    return { file, info };
  };
  const a = await run('a.jsonl', gapA), b = await run('b.jsonl', gapB);
  assert.equal(a.info.sha256, b.info.sha256, 'same removed bytes');
  assert.equal(a.info.offset, b.info.offset, 'same first offset');
  // The same log name with the second layout: replay both recoveries into one log path to force the old collision.
  const shared = join(dir, 'shared.jsonl');
  const paths = [];
  for (const gap of [gapA, gapB]) {
    writeFileSync(shared, Buffer.concat([Buffer.from(good), dangling, gap, dangling]));
    const info = await mustResolve(quarantineLocked(shared, { lockCtx, fs: quiet, select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: cleanCheck }), 'quarantineLocked');
    paths.push(sidecarPath(shared, info));
  }
  assert.notEqual(paths[0], paths[1], 'different layouts, different sidecars');
  const offsets = paths.map((p) => readSidecar(p).pieces.map((x) => x.offset));
  assert.notDeepEqual(offsets[0], offsets[1]);
  for (const p of paths) assert.ok(existsSync(p), `${p} survived`);
});

/**
 * win32 file semantics on every OS: an fs seam that registers every handle it opens and refuses (EPERM, as Windows does) to
 * rename over a path one of those handles still holds. `transient` refuses the first N renames (antivirus); `alwaysRefuse` refuses
 * every rename (a foreign holder the retries outlast).
 */
const windowsFs = ({ alwaysRefuse = false, transient = 0 } = {}) => {
  const held = new Map(), opened = [], renamedOver = [];
  const fs = { fsyncSync: () => {},
    openSync: (p, flags, mode) => { const fd = realOpen(p, flags, mode); held.set(fd, resolve(p)); opened.push(resolve(p)); return fd; },
    closeSync: (fd) => { held.delete(fd); realClose(fd); },
    renameSync: (from, to) => {
      renamedOver.push(resolve(to));
      if (alwaysRefuse || renamedOver.length <= transient || [...held.values()].includes(resolve(to))) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      realRename(from, to);
    } };
  return { fs, held, opened, renamedOver };
};

test('win32 replace (I4): quarantine never renames over a log this process holds open; a refused replace loses no byte and leaks no handle, temp or lock', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-win-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = Buffer.from(encodeValid('milestone').text), [s] = encodeValid('finding').text.split('\n');
  const bad = Buffer.from(`${s}\n`), original = Buffer.concat([good, bad]);
  const waits = [], opts = (fs) => ({ lockCtx, fs, platform: 'win32', wait: async (ms) => { waits.push(ms); }, select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: cleanCheck });
  const leftovers = (file) => readdirSync(dir).filter((x) => x.startsWith(`${file.split(/[\\/]/).pop()}.`) && (x.endsWith('.tmp') || x.endsWith('.lock')));

  const file = join(dir, 'ok.jsonl');
  writeFileSync(file, original);
  const win = windowsFs();
  const info = await mustResolve(quarantineLocked(file, opts(win.fs)), 'quarantineLocked');
  assert.ok(win.opened.includes(resolve(file)) && win.renamedOver.includes(resolve(file)), 'the seam saw the log opened and replaced');
  assert.deepEqual(readFileSync(file), Buffer.concat([good, Buffer.from(marker()(info))]));
  assert.deepEqual(Buffer.from(readSidecar(sidecarPath(file, info)).pieces[0].base64, 'base64'), bad);
  assert.deepEqual([...win.held.values()], [], 'no handle left open');
  assert.deepEqual(leftovers(file), [], 'no temp file or lock left');

  const flaky = join(dir, 'flaky.jsonl'), av = windowsFs({ transient: 2 });
  writeFileSync(flaky, original);
  const flakyInfo = await mustResolve(quarantineLocked(flaky, opts(av.fs)), 'quarantineLocked after transient EPERM');
  assert.equal(av.renamedOver.filter((x) => x === resolve(flaky)).length, 3, 'two transient refusals, then the replace');
  assert.deepEqual(waits, [10, 20], 'the retry waits went through the injected wait seam (no real sleep)');
  assert.deepEqual(readFileSync(flaky), Buffer.concat([good, Buffer.from(marker()(flakyInfo))]));

  const refused = join(dir, 'refused.jsonl');
  writeFileSync(refused, original);
  const foreign = windowsFs({ alwaysRefuse: true });
  await assert.rejects(quarantineLocked(refused, opts(foreign.fs)), (e) => e.code === 'EPERM');
  assert.ok(foreign.renamedOver.includes(resolve(refused)), 'the replace was attempted');
  assert.equal(waits.length, 2 + 9, 'ten attempts, nine injected waits, then the refusal');
  assert.deepEqual(readFileSync(refused), original, 'a refused replace leaves every byte of the log');
  const lost = readdirSync(dir).filter((x) => x.startsWith('refused.jsonl.lost-'));
  assert.equal(lost.length, 1, 'the sidecar was written before the replace');
  assert.deepEqual(Buffer.from(readSidecar(join(dir, lost[0])).pieces[0].base64, 'base64'), bad, 'and holds the selected bytes verbatim');
  assert.deepEqual([...foreign.held.values()], [], 'no handle left open');
  assert.deepEqual(leftovers(refused), [], 'no temp file or lock left');

  const appended = join(dir, 'append.jsonl');
  const app = windowsFs();
  await mustResolve(appendLocked(appended, good.toString(), { lockCtx, fs: app.fs, platform: 'win32' }), 'appendLocked');
  await mustResolve(appendLocked(appended, encodeValid('finding').text, { lockCtx, fs: app.fs, platform: 'win32', marker: marker(), check: cleanCheck }), 'appendLocked');
  assert.ok(app.opened.includes(resolve(appended)), 'the seam saw the append open the log');
  assert.deepEqual([...app.held.values()], [], 'the append leaves no handle open');
  assert.deepEqual(leftovers(appended), [], 'and no lock');
});

test('quarantine diagnostics: a temp that cannot be removed is named on the error (leaked_tmp); a directory-fsync failure after the replace says replaced (the quarantine took effect)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-diag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = Buffer.from(encodeValid('milestone').text), [s] = encodeValid('finding').text.split('\n');
  const bad = Buffer.from(`${s}\n`), original = Buffer.concat([good, bad]);
  const base = { lockCtx, platform: 'win32', select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: cleanCheck };
  const boom = Object.assign(new Error('injected'), { code: 'injected' });

  // The rename fails, and the temp has become a directory, so unlink fails with something other than ENOENT.
  const leaky = join(dir, 'leaky.jsonl');
  writeFileSync(leaky, original);
  let tmpSeen;
  const err = await quarantineLocked(leaky, { ...base, fs: { renameSync: (from) => { tmpSeen = from; rmSync(from); mkdirSync(from); throw boom; } } }).then(() => null, (e) => e);
  assert.equal(err, boom, 'the original failure is what is thrown');
  assert.equal(err.leaked_tmp, tmpSeen, 'the leaked temp is named');
  assert.deepEqual(readFileSync(leaky), original, 'the log is unchanged');
  rmSync(tmpSeen, { recursive: true });
  // An ordinary failure (temp removable) names nothing.
  writeFileSync(leaky, original);
  const boom2 = Object.assign(new Error('injected again'), { code: 'injected' });
  const clean = await quarantineLocked(leaky, { ...base, fs: { renameSync: () => { throw boom2; } } }).then(() => null, (e) => e);
  assert.equal(clean, boom2);
  assert.equal(Object.hasOwn(clean, 'leaked_tmp'), false, 'a removed temp is not reported');

  // The failure cases above run under win32 semantics on every host: no directory is ever opened for fsync (a real Windows host could not).
  const opened = [];
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { // the same, through the DEFAULT platform (no `platform` option): process.platform stubbed to win32
    writeFileSync(leaky, original);
    const viaDefault = await quarantineLocked(leaky, { ...base, platform: undefined, fs: { openSync: (p, f, m) => { opened.push(p); return realOpen(p, f, m); }, renameSync: () => { throw boom2; } } }).then(() => null, (e) => e);
    assert.equal(viaDefault, boom2);
  } finally { Object.defineProperty(process, 'platform', real); }
  assert.ok(opened.length > 0 && !opened.includes(dir), 'no directory was opened for fsync under win32 semantics');
  if (process.platform === 'win32') { t.diagnostic('directory fsync does not exist on win32: the replaced-then-failed case is skipped, not asserted'); return; }
  const dirSync = join(dir, 'dirsync.jsonl');
  writeFileSync(dirSync, original);
  const dirs = new Set();
  const fs = { openSync: (path, flags, mode) => { const fd = realOpen(path, flags, mode); if (path === dir) dirs.add(fd); return fd; },
    fsyncSync: (fd) => { if (dirs.has(fd) && !readFileSync(dirSync).equals(original) && readdirSync(dir).some((x) => x.startsWith('dirsync.jsonl.lost-'))) throw boom; } };
  const boom3 = Object.assign(new Error('injected dir fsync'), { code: 'injected' });
  const late = await quarantineLocked(dirSync, { ...base, platform: 'linux', fs: { ...fs, fsyncSync: (fd) => { try { fs.fsyncSync(fd); } catch { throw boom3; } } } }).then(() => null, (e) => e);
  assert.equal(late, boom3);
  assert.equal(late.replaced, true, 'distinguishable from a refusal');
  assert.equal(late.loss.cause, 'quarantine');
  assert.ok(!readFileSync(dirSync).equals(original), 'the replace did take effect');
  assert.deepEqual(Buffer.from(readSidecar(sidecarPath(dirSync, late.loss)).pieces[0].base64, 'base64'), bad);
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
  assert.deepEqual(mixed.lost, { ...ZERO_LOST, malformed_lines: 1, invalid_events: 2 });
});

// ---- injected faults: a rejection restores the original bytes (except the injected failed-rollback crash, which leaves visible damage), the lock is always released, no unhandled rejection ----
test('faults (I2): a throw at every boundary, a failed check, a refused lock, a short write and a crash: the torn bytes are never lost, and a rejection restores the original bytes except in the injected failed-rollback (crash) case, which leaves visible damage and keeps the torn bytes in the sidecar', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-fault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const committed = Buffer.from(encodeValid('milestone').text), torn = Buffer.from('{"sch'), original = Buffer.concat([committed, torn]);
  const rec = encodeValid('finding').text;
  let n = 0;
  const fresh = () => { const f = join(dir, `f${n++}.jsonl`); writeFileSync(f, original); return f; };
  const opts = (extra) => ({ lockCtx, marker: marker(), check: cleanCheck, ...extra });
  const boom = Object.assign(new Error('injected'), { code: 'injected' });
  for (const at of ['append-read', 'append-sidecar', 'append-write', 'append-fsync']) {
    const f = fresh();
    await assert.rejects(appendLocked(f, rec, opts({ hooks: { boundary: async (name) => { if (name === at) throw boom; } } })), boom, at);
    assert.deepEqual(readFileSync(f), original, `${at}: the original bytes are restored`);
    assert.equal(existsSync(`${f}.lock`), false, `${at}: lock released`);
  }
  let f = fresh();
  await assert.rejects(appendLocked(f, rec, opts({ check: () => { throw boom; } })), boom);
  assert.deepEqual(readFileSync(f), original, 'a refused check moves nothing');
  assert.deepEqual(readdirSync(dir).filter((x) => x.startsWith(`f${n - 1}.jsonl.lost`)), [], 'and writes no sidecar');
  f = join(dir, 'never.jsonl');
  await assert.rejects(appendLocked(f, rec, { lock: async () => { throw boom; } }), boom);
  assert.equal(existsSync(f), false, 'nothing is opened without the lock');
  f = join(dir, 'new-refused.jsonl');
  await assert.rejects(appendLocked(f, rec, { lockCtx, check: () => { throw boom; } }), boom);
  assert.equal(existsSync(f), false, 'a refused first write removes the empty log that open(wx+) created');
  assert.equal(existsSync(`${f}.lock`), false);
  if (process.platform !== 'win32') { // another creator's file is never removed: swap a different empty file in during check (rename keeps both inodes alive)
    f = join(dir, 'new-swapped.jsonl');
    await assert.rejects(appendLocked(f, rec, { lockCtx, check: () => { writeFileSync(`${f}.other`, ''); realRename(`${f}.other`, f); throw boom; } }), boom);
    assert.equal(existsSync(f), true, 'an empty file another creator put at the path is not ours and is left alone');
  } else t.diagnostic('swapping a file over an open log is refused on win32: the not-ours case is skipped, not asserted');
  f = join(dir, 'new-ok.jsonl');
  await mustResolve(appendLocked(f, rec, { lockCtx, check: cleanCheck }), 'appendLocked');
  assert.deepEqual(readFileSync(f), Buffer.from(rec), 'a first write that passes check keeps the log');
  const half = Math.floor(rec.length / 2);
  f = fresh();
  await assert.rejects(appendLocked(f, rec, opts({ fs: { writeSync: (fd, data, off, len, pos) => realWriteSync(fd, data, 0, len > half ? half : len, pos) } })), (e) => e.code === 'short_write');
  assert.deepEqual(readFileSync(f), original, 'a short write is rolled back to the original bytes');
  f = fresh();
  await assert.rejects(appendLocked(f, rec, opts({ fs: { writeSync: () => { throw boom; } } })), boom);
  assert.deepEqual(readFileSync(f), original);
  // A crash: part of the new bytes reach the file and the rollback fails. The torn bytes are already in the sidecar; the damage
  // is visible (never silently fine) and quarantine recovers it, after which the append succeeds once.
  f = fresh();
  let calls = 0;
  const crash = { writeSync: (fd, data, off, len, pos) => { if (calls++ === 0) realWriteSync(fd, data, 0, half, pos); throw boom; }, ftruncateSync: () => { throw boom; } };
  await assert.rejects(appendLocked(f, rec, opts({ fs: crash })), boom);
  const sidecars = () => readdirSync(dir).filter((x) => x.startsWith(`${f.split(/[\\/]/).pop()}.lost-`));
  assert.equal(sidecars().length, 1);
  assert.deepEqual(Buffer.from(readSidecar(join(dir, sidecars()[0])).pieces[0].base64, 'base64'), torn, 'the torn bytes survived the crash');
  const crashed = ev.readEvents(readFileSync(f));
  assert.ok(crashed.lost.torn_bytes + crashed.lost.invalid_events > 0, 'the crash is visible');
  await assert.rejects(appendLocked(f, rec, opts({})), (e) => ['unsafe_history'].includes(e.code));
  await mustResolve(quarantineLocked(f, { lockCtx, select: (buf) => ev.readEvents(buf).bad, marker: marker(), check: cleanCheck }), 'quarantineLocked');
  await mustResolve(appendLocked(f, rec, opts({})), 'appendLocked');
  const healed = ev.readEvents(readFileSync(f));
  assert.deepEqual(healed.events.map((e) => e.end.name), ['milestone', 'finding']);
  assert.ok(healed.lost.recovered_bytes > 0 && healed.lost.invalid_events === 0);
  const fsyncs = [];
  f = fresh();
  await mustResolve(appendLocked(f, rec, opts({ fs: { fsyncSync: (fd) => fsyncs.push(fd) } })), 'appendLocked');
  assert.ok(fsyncs.length >= 2, 'the sidecar and the append are fsynced');
  const fresh2 = join(dir, 'sub', 'new.jsonl');
  mkdirSync(dirname(fresh2));
  const dirSyncs = [];
  if (process.platform !== 'win32') { // a directory cannot be opened for fsync on win32
    await mustResolve(appendLocked(fresh2, rec, { lockCtx, platform: 'linux', fs: { fsyncSync: (fd) => dirSyncs.push(fd) } }), 'appendLocked');
    assert.equal(dirSyncs.length, 2, 'a new file also fsyncs its directory');
    await mustResolve(appendLocked(fresh2, rec, { lockCtx, platform: 'linux', fs: { fsyncSync: (fd) => dirSyncs.push(fd) } }), 'appendLocked');
    assert.equal(dirSyncs.length, 3, 'an existing file fsyncs only itself');
  } else await appendLocked(fresh2, rec, { lockCtx });
  if (process.platform === 'win32') t.diagnostic('file mode 0600 is not verified on win32 (no POSIX permission bits): skipped, not asserted');
  else assert.equal((statSync(fresh2).mode & 0o777).toString(8), '600');
  const big = join(dir, 'big.jsonl');
  writeFileSync(big, Buffer.alloc(64, 0x0a));
  await assert.rejects(appendLocked(big, rec, { lockCtx, maxBytes: 63 }), (e) => e.code === 'log_too_large');
});

test('lock: its own <log>.lock (never the engine lock); a live holder times out on an injected clock with nothing written; a pre-aborted signal writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's04a2-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'T1.jsonl');
  let seen;
  await mustResolve(appendLocked(f, encodeValid('milestone').text, { lock: async (ctx, opts) => { seen = { ctx, opts }; return { release: async () => {} }; } }), 'appendLocked');
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
    ev2('run_mode', 5, 5, {}, 'T1', 'run-events-only'), ev2('closure', 1000, 1000, { through: at(1000) }), ev2('log_loss', 950, 950)],
  A: [ev2('milestone', 10, 10, {}, 'A', 'run-a'), ev2('review_lane', 10, 20, {}, 'A', 'run-a')] });

test('T-C2 / T-C3 / T-C6: with every event kind added (and an events-only ticket A), eval --all and run-log summary --all equal the origin/main golden', async () => {
  const { capture } = await import('../legacy-golden.capture.test-helper.mjs');
  const { GOLDEN } = await import('../legacy-golden.mjs');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  let injected;
  const got = await capture(SCRIPTS, { injectLogs: (logs) => (injected = instrumented(logs)) });
  // S-01b2 P5r (AMD-P5r-2): the ONE intended difference from the pinned base capture. Policy v2 makes the refusal of the
  // policy_version:99 fixture name both supported versions; the golden itself stays the pure origin/main capture.
  const expected = structuredClone(golden.data), V1 = 'supports policy_version 1;', V12 = 'supports policy_version 1, 2;';
  assert.equal(expected.policy_refusal.stderr.split(V1).length, 2, 'the base capture names version 1 exactly once');
  expected.policy_refusal.stderr = expected.policy_refusal.stderr.replace(V1, V12);
  assert.equal(JSON.stringify(got, null, 1), JSON.stringify(expected, null, 1));
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
  assert.deepEqual(lostSignal(clean.d, 'T1'), { ...ZERO_LOST, state_unreadable: false });
  assert.deepEqual(lostSignal(dirty.d, 'T1'), { ...ZERO_LOST, torn_bytes: 40, invalid_events: 2, state_unreadable: false });
  writeFileSync(join(clean.d, 'T1.state.json'), '{"run_id": ');
  assert.equal(lostSignal(clean.d, 'T1').state_unreadable, true);
  writeFileSync(join(clean.d, 'T1.state.json'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
  assert.equal(lostSignal(clean.d, 'T1').state_unreadable, true, 'a state that only parses after a lossy decode is unreadable');
  assert.deepEqual(lostSignal(clean.d, 'NONE'), { ...ZERO_LOST, state_unreadable: false });
  for (const bad of ['../x', '', 'a/b', undefined]) assert.throws(() => lostSignal(clean.d, bad), TypeError);
});

test('zero unhandled rejections across this file', () => { assert.equal(unhandled, 0); });

// ---- mutation check (L1): each mutant must be killed by a REAL assertion failure of this file --------------------------
const MUTANTS = [
  ['measure/events.mjs', 'label optional', "const LABEL = { label: E(['measured', 'estimated']) };", "const LABEL = { label: E(['measured', 'estimated'], true) };"],
  ['measure/events.mjs', 'string policy dropped', "if (!pattern.test(v)) problems.push", "if (false) problems.push"],
  ['measure/events.mjs', 'stricter field patterns ignored', "def.pattern?.[k] ?? SAFE_ID", "SAFE_ID"],
  ['measure/events.mjs', 'review_execution cap loosened', "REVIEW_EXEC = /^review-[A-Za-z0-9._-]{1,80}$/;", "REVIEW_EXEC = /^review-[A-Za-z0-9._-]{1,120}$/;"],
  ['measure/events.mjs', 'fingerprint cap dropped', "pattern: { fingerprint: FINGERPRINT },", ""],
  ['measure/events.mjs', 'closure id per string, not per instant', "new Date(m.through).toISOString().replace(", "m.through.replace("],
  ['measure/events.mjs', 'verdict iff result dropped', "rule((m('result') === 'verdict') === (m('verdict') !== undefined), 'verdict_iff_result_verdict', '/metrics/verdict');", ""],
  ['measure/events.mjs', 'majors without verdict', "rule(m('verdict') !== undefined || (m('majors') === undefined && m('minors') === undefined), 'counts_need_verdict', '/metrics/majors');", ""],
  ['measure/events.mjs', 'closure pair unchecked', "rule(CLOSURE_PAIRS.includes(`${m('emitter')}/${m('count_source')}`), 'closure_pair', '/metrics/count_source');", ""],
  ['measure/events.mjs', 'closure state reference unchecked', "rule(engine === (m('state_sha256') !== undefined) && engine === (m('state_seq') !== undefined), 'closure_state_ref', '/metrics/state_sha256');", ""],
  ['measure/events.mjs', 'closure label cap removed', "rule(m('label') === (engine ? 'measured' : 'estimated'), 'closure_label', '/metrics/label');", ""],
  ['measure/events.mjs', 'empty closure allowed', "rule(Reflect.ownKeys(c).length > 0 && (u === undefined || Reflect.ownKeys(u).length > 0), 'closure_empty', '/detail/counts');", ""],
  ['measure/events.mjs', 'validator budgets removed', "const r = validate(input, shape, LIMITS);", "const r = validate(input, shape);"],
  ['measure/events.mjs', 'validator not total', "try { return crossChecked(name, def, input, metrics, detail, problems); } catch { return { ok: false, problems: [{ code: 'unreadable', path: '' }] }; }", "return crossChecked(name, def, input, metrics, detail, problems);"],
  ['measure/events.mjs', 'reader: kind unchecked', "if (own(end, 'kind') !== def.kind) return fail('wrong_kind', '/kind');", ""],
  ['measure/events.mjs', 'reader: point events may span', " || (def.point && t1 !== t0)", ""],
  ['measure/events.mjs', 'reader: duration unchecked', " || own(end, 'duration_ms') !== t1 - t0", ""],
  ['measure/events.mjs', 'reader: canonical id unchecked', "if (def.id && own(end, 'event_id') !== def.id(metrics)) return fail('event_id_not_canonical', '/event_id');", ""],
  ['measure/events.mjs', 'reader: through after timestamp', "if (name === 'closure' && !(Date.parse(own(metrics, 'through')) <= t1)) return fail('through_after_timestamp', '/metrics/through');", ""],
  ['measure/events.mjs', 'reader: start row may carry payload', "metrics: event === 'start' ? { object: {} } :", "metrics: event === 'start' ? { open: true, object: {} } :"],
  ['measure/events.mjs', 'writer: caller id silently replaced', "if (def.id && eventId !== undefined && eventId !== id) throw coded('invalid_event', `${name}: event_id must be ${id}`);", ""],
  ['measure/events.mjs', 'writer: bytes not re-checked', "const c = checkEventPair(s, e);", "const c = { ok: true, problems: [] };"],
  ['measure/events.mjs', 'writer: size cap removed', "if (Buffer.byteLength(text) > ROW_BYTES_MAX) throw", "if (false) throw"],
  ['measure/events.mjs', 'I1: legacy rows serialised by JSON.stringify', "const line = canonicalJson(r), row = JSON.parse(line);", "const line = JSON.stringify(r), row = JSON.parse(line);"],
  ['measure/events.mjs', 'I1: event payload serialised by JSON.stringify', "${canonicalJson({ ...base, event: 'end'", "${JSON.stringify({ ...base, event: 'end'"],
  ['measure/events.mjs', 'I1: canonical encoder reads getters and hidden keys', "if (!d || !('value' in d) || !d.enumerable) bad(", "if (!d) bad("],
  ['measure/events.mjs', 'I1: canonical encoder accepts any prototype', "if (proto !== (arr ? Array.prototype : Object.prototype) && !(proto === null && !arr)) bad('not a plain object or array');", ""],
  ['measure/events.mjs', 'I1: canonical encoder has no budget', "if (++work > LIMITS.maxNodes || depth > 32) bad('too large or too deep');", ""],
  ['measure/events.mjs', 'choke point: unbranded event rows pass', "|| Array.isArray(row) || isEventName(row.name)) throw", "|| Array.isArray(row)) throw"],
  ['measure/events.mjs', 'I3: a complete line counted as torn', "export const committedLength = (buf) => buf.lastIndexOf(0x0a) + 1;", "export const committedLength = (buf) => { const e = buf.lastIndexOf(0x0a) + 1, f = e >= 2 ? buf.lastIndexOf(0x0a, e - 2) + 1 : 0; return /\"event\":\"start\"/.test(buf.subarray(f, e).toString()) ? f : e; };"],
  ['measure/events.mjs', 'lossy decode', "const decode = (bytes) => { try { return strict.decode(bytes); } catch { return null; } };", "const decode = (bytes) => bytes.toString('utf8');"],
  ['measure/events.mjs', 'dangling starts not counted', "for (const { l } of starts.values()) reject(l);", ""],
  ['measure/events.mjs', 'I2: loss records not counted', "if (row.name === 'log_loss') { lost.loss_records++; lost.recovered_bytes += row.metrics.bytes; } else events.push", "if (row.name === 'log_loss') { /* ignored */ } else events.push"],
  ['measure/events.mjs', 'I4: torn tail not quarantined', "if (torn_bytes) bad.push([buf.length - torn_bytes, buf.length]);", ""],
  ['measure/events.mjs', 'I4: malformed lines not quarantined', "lost.malformed_lines++; bad.push([l.from, l.to + 1]); continue;", "lost.malformed_lines++; continue;"],
  ['measure/events.mjs', 'legacyRows keeps events', "rows.filter((row) => !isEventName(row?.name))", "rows.filter(() => true)"],
  ['measure/events.mjs', 'CLI may write writer-only names', "EVENT_NAMES.filter((n) => EVENTS[n].cli !== false)", "EVENT_NAMES.filter((n) => n !== 'closure')"],
  ['run-log-io.mjs', 'I1: check sees only the new text', "opts.check(Buffer.concat([before, out]), before);", "opts.check(out, before);"],
  ['run-log-io.mjs', 'I1: check skipped', "if (opts.check) opts.check(", "if (false) opts.check("],
  ['run-log-io.mjs', 'I2: no sidecar', "if (info) await saveLost(file, info, [[committed, tail]], opts);", ""],
  ['run-log-io.mjs', 'I2: no loss record', "const out = Buffer.from((info ? opts.marker(info) : '') + text, 'utf8');", "const out = Buffer.from(text, 'utf8');"],
  ['run-log-io.mjs', 'I2: a torn tail without a marker is overwritten', "if (info && !opts.marker) throw", "if (false) throw"],
  ['run-log-io.mjs', 'I2: rollback restores nothing', "try { writeAll(write, fd, tail, committed); truncate(fd, buf.length); } catch", "try { } catch"],
  ['run-log-io.mjs', 'stale torn rest kept', "if (buf.length > committed + out.length) truncate(fd, committed + out.length);", ""],
  ['run-log-io.mjs', 'short write not reported', "if (n !== data.length) throw coded('short_write'", "if (false) throw coded('short_write'"],
  ['run-log-io.mjs', 'engine lock path', "lockFile: `${file}.lock`", "lockFile: `${dirname(file)}/T1.lock`"],
  ['run-log-io.mjs', 'lock never released', "} finally { await handle.release(); }", "} finally { }"],
  ['run-log-io.mjs', 'no fsync', "      fsync(fd);\n", "\n"],
  ['run-log-io.mjs', 'no directory fsync', "if (created && platform !== 'win32') {", "if (false) {"],
  ['run-log-io.mjs', 'directory fsync on every append', "if (created && platform !== 'win32') {", "if (platform !== 'win32') {"],
  ['run-log-io.mjs', 'no size cap', "if (size > (opts.maxBytes ?? LOG_BYTES_MAX)) throw", "if (false) throw"],
  ['run-log-io.mjs', 'win32: quarantine replaces the log while holding it open', "if (!hold) { const f = fd; fd = null; close(f); }", ""],
  ['run-log-io.mjs', 'win32: quarantine replace not retried', "await renameRetrying(tmp, file, { rename, platform, wait: opts.wait });", "rename(tmp, file);"],
  ['run-log-io.mjs', 'a refused first write leaves the empty log', "if (mine) dropIfOurs(file, mine);", ""],
  ['run-log-io.mjs', 'I4: quarantine check skipped', "if (check) check(after, buf);", ""],
  ['run-log-io.mjs', 'I4: quarantine without sidecar', "await saveLost(file, info, pieces, opts);\n    await boundary(opts.hooks, 'append-write', { file });\n    const tmp", "await boundary(opts.hooks, 'append-write', { file });\n    const tmp"],
  ['run-log.mjs', 'lone --started-at is zero-length', "const endedAt = options['ended-at'] ?? now, startedAt = options['started-at'] ?? endedAt;", "const startedAt = options['started-at'] ?? options['ended-at'] ?? now, endedAt = options['ended-at'] ?? startedAt;"],
  ['run-log.mjs', 'start/end accept event names', "if (isEventName(name)) fail(`${name} is a measurement event: use run-log.mjs event`);", ""],
  ['run-log.mjs', 'duplicates allowed', "if (rows.some((row) => row.run_id === runId && row.event_id === id)) throw", "if (false) throw"],
  ['run-log.mjs', 'I1: measurement history unchecked', "if (bad.length) throw unsafe(path", "if (false) throw unsafe(path"],
  ['run-log.mjs', 'I1: legacy rules not applied to the whole file', "if (warnings.length) throw unsafe(path, `unsafe log history", "if (false) throw unsafe(path, `unsafe log history"],
  ['run-log.mjs', 'metrics typed by guess', "typed(item.slice(at + 1), fieldType(name, key))", "typed(item.slice(at + 1), /^\\d+$/.test(item.slice(at + 1)) ? 'int' : fieldType(name, key))"],
  ['run-log.mjs', 'summary reads event rows', "      if (isEventName(row?.name)) continue;\n", "\n"],
  ['run-log.mjs', 'writers read the raw tail', "(tolerant ? buf : buf.subarray(0, committedLength(buf)))", "buf"],
  ['run-log.mjs', 'close claims measured', "await writeEvent(options, 'closure', { label: 'estimated',", "await writeEvent(options, 'closure', { label: 'measured',"],
  ['eval.mjs', 'eval reads event rows', "legacyRows(readJsonl(log))", "readJsonl(log)"],
  ['eval.mjs', 'unreadable state not reported', "catch { stateUnreadable = true; }", "catch { }"],
  ['eval.mjs', 'lostSignal ticket unchecked', "if (typeof ticket !== 'string' || !SAFE_ID.test(ticket)) throw", "if (false) throw"],
];
const CHILD_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), EVENTS_MUTANT_RUN: '1' };
// Long (about 5-6 min): runs in the single-OS engine-properties CI job (EVENTS_MUTATION=1), or locally with that variable.
test('mutation: every mutant is killed by a real assertion failure (never by a load error, crash or timeout), on an LF-normalised source', { skip: MUTANT_CHILD || process.env.EVENTS_MUTATION !== '1' }, async () => {
  const testRel = join('measure', 'events.test.mjs');
  const src = Object.fromEntries([...new Set(MUTANTS.map(([f]) => f))].map((f) => [f, loadMutationSource(join(SCRIPTS, f))]));
  for (const [f, name, from] of MUTANTS) assert.equal(src[f].split(from).length - 1, 1, `${f} "${name}": anchor must occur exactly once`);
  const crlf = src['measure/events.mjs'].replace(/\n/g, '\r\n');
  const dir = mkdtempSync(join(tmpdir(), 's04a2-crlf-'));
  try { writeFileSync(join(dir, 'e.mjs'), crlf); assert.equal(loadMutationSource(join(dir, 'e.mjs')), src['measure/events.mjs'], 'a CRLF checkout anchors the same'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(classify(runMutant({ root: SCRIPTS, testRel, env: CHILD_ENV })).verdict, 'survived', 'the unmutated tree passes in the harness');
  const bad = [], queue = [...MUTANTS];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const [f, name, from, to] = m;
      const c = classify(await runMutantAsync({ root: SCRIPTS, testRel, env: CHILD_ENV, timeout: 300000, overrides: { [f]: src[f].replace(from, to) } }));
      console.log(`# mutant ${c.verdict}: ${f} ${name} <- ${c.failing.slice(0, 2).map((x) => x.slice(0, 50)).join(' | ')}`);
      if (c.verdict !== 'killed') bad.push(`${f} ${name}: ${c.verdict} ${c.why ?? ''}`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.EVENTS_MUTATION_JOBS) || 4 }, worker));
  assert.deepEqual(bad.sort(), []);
});
