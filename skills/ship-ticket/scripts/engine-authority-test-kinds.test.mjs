/**
 * S-01b2 P6: owner authority for TEST_KIND_WAIVER (design rev 3, §4 and §6 row 32). Pure units, no
 * engine CLI, no git, no clock. Assertions are on codes, ids and counts, never on message text.
 *
 * ============================ CONTRACT (P6) ============================
 * run-state.mjs        AUTHORITY_EVENTS gains TEST_KIND_WAIVER, so it is trusted only through
 *                      observeAuthority and a worker append of it is never exempt.
 * engine-authority.mjs testKindWaivers(S, candidate, { required, protected }) ->
 *   { ok: true, waived: [subject], unauthorized: [subject], ignored: { malformed, foreign, not_required, protected } }
 *   | { ok: false, code: 'test_kinds_waiver_input_invalid' | 'test_kinds_waiver_state_invalid' | 'test_kinds_waiver_budget_exceeded', waived: [], unauthorized: [], ignored: zeros }
 *   A TEST_KIND_WAIVER { run_id, requirement: 'kind:<id>'|'plan:<id>', candidate, plan_digest, authorized_by, reason }
 *   waives `requirement` only when trusted, of this run, for S.plan_digest (normDigest on both sides),
 *   for exactly `candidate`, required and not protected. A matching untrusted one is `unauthorized`
 *   unless a trusted one waives the same subject. Its own match: securityEvents/waiverState are unchanged.
 * ========================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from './engine-authority.mjs';
import * as R from './run-state.mjs';
import { LIVE } from './engine-quiesce.mjs';
import { pairProblem, pairKey, normDigest } from './engine-dag.mjs';

const J = JSON.stringify;
const RUN = 'run-1', DIGEST = 'sha256:' + 'a'.repeat(64);
const TKW = (over = {}) => ({ run_id: RUN, event: 'TEST_KIND_WAIVER', requirement: 'kind:contract', candidate: 'c1', plan_digest: DIGEST,
  authorized_by: 'owner', reason: 'accepted gap', ...over });
const REQ = { required: ['kind:contract', 'kind:migration', 'plan:item-1', 'kind:auth'], protected: ['kind:auth'] };
const ZERO = { malformed: 0, foreign: 0, not_required: 0, protected: 0 };
const pureS = ({ trusted = [], untrusted = [], over = {} } = {}) => ({ run_id: RUN, plan_digest: DIGEST, attempts: [],
  authority: { through: 0, trusted: trusted.map(e => J(e)), untrusted: untrusted.map(e => ({ line: J(e), seq: 1 })) }, ...over });
const tw = (S, candidate = 'c1', req = REQ) => A.testKindWaivers(S, candidate, req);
const plan = (events) => `# Plan\n\n${R.BEGIN}\n${events.map(R.eventLine).join('\n')}\n${R.END}\n`;
const START = { run_id: RUN, event: 'START', timestamp: '2026-11-18T00:00:00Z', approved_plan_digest: DIGEST };

// ------------------------------------------------------------------ AC1: authority classification

test('[P6-AC1] a TEST_KIND_WAIVER first seen while an attempt of each LIVE status exists is untrusted and only ever unauthorized', () => {
  assert.ok(LIVE.length >= 4, 'LIVE lists the statuses the engine treats as possibly running');
  for (const status of LIVE) {
    const S = { run_id: RUN, plan_digest: DIGEST, attempts: [] };
    A.observeAuthority(S, plan([START]), () => true);
    S.attempts.push({ id: 'att-1', status, pgid: 4242 });
    A.observeAuthority(S, plan([START, TKW()]), () => true);
    const kinds = (list) => list.map(l => JSON.parse(typeof l === 'string' ? l : l.line).event);
    assert.deepEqual(kinds(S.authority.untrusted), ['TEST_KIND_WAIVER'], status);
    assert.equal(kinds(S.authority.trusted).includes('TEST_KIND_WAIVER'), false, status);
    assert.deepEqual(tw(S), { ok: true, waived: [], unauthorized: ['kind:contract'], ignored: ZERO }, status);
    // the attempt retires; the same bytes are never promoted (dedup by line), a distinct re-append is
    S.attempts[0].status = 'exited';
    A.observeAuthority(S, plan([START, TKW()]), () => false);
    assert.deepEqual(tw(S).waived, [], `${status}: identical bytes stay untrusted after quiescence`);
    A.observeAuthority(S, plan([START, TKW(), TKW({ timestamp: '2026-11-18T01:00:00Z' })]), () => false);
    assert.deepEqual(tw(S), { ok: true, waived: ['kind:contract'], unauthorized: [], ignored: ZERO },
      `${status}: a distinct re-append once quiet is trusted, and a trusted waiver of the subject clears the unauthorized match`);
  }
});

test('[P6-AC1] the quiescent twin is trusted; an attempt that started and ended between observations still taints', () => {
  const S = { run_id: RUN, plan_digest: DIGEST, attempts: [] };
  A.observeAuthority(S, plan([START, TKW()]), () => false);
  assert.deepEqual(tw(S), { ok: true, waived: ['kind:contract'], unauthorized: [], ignored: ZERO });
  const T = { run_id: RUN, plan_digest: DIGEST, attempts: [] };
  A.observeAuthority(T, plan([START]), () => false);
  T.attempts.push({ id: 'att-1', status: 'exited', pgid: 7 });
  A.observeAuthority(T, plan([START, TKW()]), () => false);
  assert.deepEqual(tw(T), { ok: true, waived: [], unauthorized: ['kind:contract'], ignored: ZERO });
});

test('[P6-AC1] TEST_KIND_WAIVER is owner authority: a worker append of it is never exempt; a rewritten block taints it', () => {
  assert.ok(R.AUTHORITY_EVENTS.includes('TEST_KIND_WAIVER'));
  const before = plan([START]);
  const add = (line) => before.replace(R.END, line + '\n' + R.END);
  assert.equal(R.workerRunStateAppend(before, add(J({ event: 'NOTE' }))), true, 'the twin: a NOTE is exempt');
  assert.equal(R.workerRunStateAppend(before, add(J(TKW()))), false);
  assert.equal(R.workerRunStateAppend(before, add('  ' + J(TKW({ requirement: 'plan:item-1' })))), false, 'indented');
  // a quiescent observation of a block whose observed bytes were rewritten taints the line it reveals
  const S = { run_id: RUN, plan_digest: DIGEST, attempts: [] };
  A.observeAuthority(S, plan([START, { event: 'NOTE', n: 1 }]), () => false);
  A.observeAuthority(S, plan([START, { event: 'NOTE', n: 2 }, TKW()]), () => false);
  assert.deepEqual(tw(S), { ok: true, waived: [], unauthorized: ['kind:contract'], ignored: ZERO });
});

// ------------------------------------------------------------------ AC2: replay and scope

test('[P6-AC2] a foreign run, plan digest or candidate has no effect, trusted or not (replay)', () => {
  for (const over of [{ run_id: 'run-0' }, { plan_digest: 'sha256:' + 'b'.repeat(64) }, { candidate: 'c0' }]) {
    assert.deepEqual(tw(pureS({ trusted: [TKW(over)] })), { ok: true, waived: [], unauthorized: [], ignored: { ...ZERO, foreign: 1 } }, J(over));
    assert.deepEqual(tw(pureS({ untrusted: [TKW(over)] })), { ok: true, waived: [], unauthorized: [], ignored: ZERO }, `forged ${J(over)} is irrelevant`);
  }
  assert.deepEqual(tw(pureS({ trusted: [TKW()] })).waived, ['kind:contract'], 'the accepting twin');
  assert.deepEqual(tw(pureS({ trusted: [TKW({ plan_digest: DIGEST.replace('sha256:', 'sha256-') })] })).waived, ['kind:contract'], 'either digest spelling');
  // a waiver for c1 replayed after a repair moved the candidate to c2
  assert.deepEqual(tw(pureS({ trusted: [TKW()] }), 'c2').waived, []);
  // the whole trusted list of another run, replayed into this one
  const other = pureS({ trusted: [TKW({ run_id: 'run-0' }), TKW({ run_id: 'run-0', requirement: 'kind:migration' })] });
  assert.deepEqual(tw(other).waived, []);
});

test('[P6-AC2] a requirement that is not required, or protected, is never waived and is counted', () => {
  assert.deepEqual(tw(pureS({ trusted: [TKW({ requirement: 'kind:other' })] })), { ok: true, waived: [], unauthorized: [], ignored: { ...ZERO, not_required: 1 } });
  assert.deepEqual(tw(pureS({ trusted: [TKW({ requirement: 'kind:auth' })] })), { ok: true, waived: [], unauthorized: [], ignored: { ...ZERO, protected: 1 } });
  assert.deepEqual(tw(pureS({ trusted: [TKW({ requirement: 'plan:item-1' }), TKW({ requirement: 'kind:migration' }), TKW({ requirement: 'kind:migration', timestamp: 't' })] })).waived,
    ['kind:migration', 'plan:item-1'], 'both subject kinds; duplicates collapse; sorted');
  assert.deepEqual(tw(pureS({ untrusted: [TKW({ requirement: 'kind:auth' })] })).unauthorized, ['kind:auth'], 'a forged waiver of a protected kind is still surfaced');
  assert.deepEqual(tw(pureS({ untrusted: [TKW({ requirement: 'kind:other' })] })).unauthorized, [], 'a forged waiver of nothing required is irrelevant');
  // protection is the caller's recomputed set: the same waiver is effective once the kind is not protected
  assert.deepEqual(tw(pureS({ trusted: [TKW({ requirement: 'kind:auth' })] }), 'c1', { ...REQ, protected: [] }).waived, ['kind:auth']);
});

test('[P6-AC2] state-key deletion never matches by absence (undefined === undefined)', () => {
  const bare = (({ run_id: _r, plan_digest: _p, ...rest }) => rest)(TKW());
  for (const del of ['run_id', 'plan_digest']) {
    const S = pureS({ trusted: [bare] });
    delete S[del];
    assert.deepEqual(tw(S), { ok: false, code: 'test_kinds_waiver_state_invalid', waived: [], unauthorized: [], ignored: ZERO }, `S.${del} deleted`);
    const T = pureS({ trusted: [bare] });
    T[del] = '';
    assert.equal(tw(T).ok, false, `S.${del} emptied`);
  }
  assert.deepEqual(tw(pureS({ trusted: [bare] })).waived, [], 'a waiver without run_id and plan_digest matches nothing');
  const noAuth = pureS({ trusted: [TKW()] });
  delete noAuth.authority;
  assert.deepEqual(tw(noAuth), { ok: true, waived: [], unauthorized: [], ignored: ZERO }, 'no authority record: nothing is waived');
  for (const bad of [undefined, null, '', 7, ['c1']]) assert.equal(A.testKindWaivers(pureS({ trusted: [TKW()] }), bad, REQ).ok, false, `candidate ${J(bad)}`);
});

// ------------------------------------------------------------------ AC3: shape refusals

test('[P6-AC3] a malformed waiver is never effective and never unauthorized; it is counted', () => {
  const MALFORMED = [
    { requirement: 'kind:' }, { requirement: 'kind:-x' }, { requirement: 'Kind:contract' }, { requirement: 'kind:contract ' },
    { requirement: ' kind:contract' }, { requirement: 'kind:contract\n' }, { requirement: 'title_scanner_unsupported' }, { requirement: 'test:contract' },
    { requirement: 'kind:' + 'a'.repeat(65) }, { requirement: ['kind:contract'] }, { requirement: { toString: 'kind:contract' } }, { requirement: null },
    { requirement: 'kind:con tract' }, { requirement: 'kind:contrаct' }, { requirement: undefined },
    { authorized_by: '' }, { authorized_by: undefined }, { authorized_by: 1 }, { reason: '' }, { reason: undefined }, { reason: ['r'] },
    { candidate: '' }, { candidate: 1 }, { run_id: '' }, { run_id: 1 }, { plan_digest: '' }, { plan_digest: 1 },
  ];
  for (const over of MALFORMED) {
    assert.deepEqual(tw(pureS({ trusted: [TKW(over)] })), { ok: true, waived: [], unauthorized: [], ignored: { ...ZERO, malformed: 1 } }, J(over) ?? String(over));
    assert.deepEqual(tw(pureS({ untrusted: [TKW(over)] })).unauthorized, [], `forged ${J(over)}`);
  }
  assert.deepEqual(tw(pureS({ trusted: [TKW({ requirement: 'kind:' + 'a'.repeat(64) })] }), 'c1', { required: ['kind:' + 'a'.repeat(64)], protected: [] }).waived,
    ['kind:' + 'a'.repeat(64)], 'the 64-character boundary is accepted');
  assert.deepEqual(tw(pureS({ trusted: [TKW({ timestamp: '2026-11-18T02:00:00Z', note: 'x' })] })).waived, ['kind:contract'], 'extra keys (a re-append timestamp) are allowed');
  // a SECURITY_WAIVER-shaped line is not a test-kind waiver, and the reverse
  assert.deepEqual(tw(pureS({ trusted: [{ ...TKW(), event: 'SECURITY_WAIVER' }] })).waived, []);
});

test('[P6-AC3] invalid required/protected inputs and unparsable lines fail closed with a code, never a throw', () => {
  const S = pureS({ trusted: [TKW()] });
  for (const req of [undefined, null, {}, { required: 'kind:contract', protected: [] }, { required: ['kind:contract'] },
    { required: ['kind:contract', 'nope'], protected: [] }, { required: ['kind:contract'], protected: [1] }, { required: [, 'kind:contract'], protected: [] }]) {
    assert.deepEqual(A.testKindWaivers(S, 'c1', req), { ok: false, code: 'test_kinds_waiver_input_invalid', waived: [], unauthorized: [], ignored: ZERO }, J(req) ?? String(req));
  }
  const broken = pureS({ trusted: [TKW()] });
  broken.authority.trusted.push('{not json');
  assert.equal(tw(broken).ok, false, 'a corrupt trusted line');
  const notString = pureS({ trusted: [TKW()] });
  notString.authority.untrusted.push({ line: 7, seq: 1 });
  assert.equal(tw(notString).ok, false, 'a non-string untrusted line');
});

test('[P6-F1] a parsed trusted or untrusted line that is not a JSON object is a typed state refusal, never skipped', () => {
  const STATE = { ok: false, code: 'test_kinds_waiver_state_invalid', waived: [], unauthorized: [], ignored: ZERO };
  for (const raw of ['null', '[]', '[{}]', 'false', 'true', '0', '1', '"bad"']) {
    const T = pureS({ trusted: [TKW()] });
    T.authority.trusted.push(raw);
    assert.deepEqual(tw(T), STATE, `trusted ${raw}`);
    const U = pureS({ trusted: [TKW()] });
    U.authority.untrusted.push({ line: raw, seq: 1 });
    assert.deepEqual(tw(U), STATE, `untrusted ${raw}`);
  }
});

test('[P6-F2] authority.trusted / authority.untrusted that is null or missing is a state refusal, not an empty list', () => {
  const STATE = { ok: false, code: 'test_kinds_waiver_state_invalid', waived: [], unauthorized: [], ignored: ZERO };
  for (const key of ['trusted', 'untrusted']) {
    for (const how of ['null', 'missing']) {
      const S = pureS({ trusted: [TKW()] });
      if (how === 'null') S.authority[key] = null; else delete S.authority[key];
      assert.deepEqual(tw(S), STATE, `${key} ${how}`);
    }
  }
});

test('[P6-F3] only TEST_KIND_WAIVER lines count toward the byte budget; the budget is real bytes, not UTF-16 length', () => {
  const B = A.TEST_KIND_WAIVER_BUDGET;
  // a flood of fat unrelated untrusted lines (over the byte budget in total) cannot block a valid owner waiver
  const noise = J({ event: 'NOTE', pad: 'x'.repeat(1024) });
  const S = pureS({ trusted: [TKW()] });
  for (let i = 0; i < B.lines - 1; i++) S.authority.untrusted.push({ line: noise, seq: 1 });
  assert.ok(noise.length * (B.lines - 1) > B.bytes, 'the unrelated lines alone exceed the byte budget');
  assert.deepEqual(tw(S), { ok: true, waived: ['kind:contract'], unauthorized: [], ignored: ZERO });
  // the budget counts bytes: 2-byte characters are over at half the character count
  const wide = pureS({ trusted: [TKW({ reason: 'é'.repeat(B.bytes / 2) })] });
  assert.deepEqual(tw(wide), { ok: false, code: 'test_kinds_waiver_budget_exceeded', waived: [], unauthorized: [], ignored: ZERO });
});

test('[P6-F4] an e1: candidate identity matches the same identity only, over LF and CRLF plan text', () => {
  const E1 = 'e1:' + 'b'.repeat(64), OTHER = 'e1:' + 'c'.repeat(64);
  assert.deepEqual(tw(pureS({ trusted: [TKW({ candidate: E1 })] }), E1), { ok: true, waived: ['kind:contract'], unauthorized: [], ignored: ZERO });
  assert.deepEqual(tw(pureS({ trusted: [TKW({ candidate: E1 })] }), OTHER), { ok: true, waived: [], unauthorized: [], ignored: { ...ZERO, foreign: 1 } });
  assert.deepEqual(tw(pureS({ trusted: [TKW({ candidate: E1 })] }), E1 + '\r'), { ok: true, waived: [], unauthorized: [], ignored: { ...ZERO, foreign: 1 } }, 'no newline trimming');
  for (const eol of ['\n', '\r\n']) {
    const S = { run_id: RUN, plan_digest: DIGEST, attempts: [] };
    A.observeAuthority(S, plan([START]).replace(/\n/g, eol), () => false);
    A.observeAuthority(S, plan([START, TKW({ candidate: E1 })]).replace(/\n/g, eol), () => false);
    assert.deepEqual(tw(S, E1), { ok: true, waived: ['kind:contract'], unauthorized: [], ignored: ZERO }, J(eol));
    assert.deepEqual(tw(S, OTHER).waived, [], `${J(eol)} other identity`);
  }
});

// ------------------------------------------------------------------ hostile inputs (L6) and budget (L3)

test('[P6-L6] Proxy and accessor inputs are refused through own data descriptors only: no trap and no getter runs', () => {
  let calls = 0;
  const handler = {};
  for (const name of Object.getOwnPropertyNames(Reflect)) handler[name] = (...args) => { calls++; return Reflect[name](...args); };
  const trap = (target) => new Proxy(target, handler);
  const getter = (obj, key, value) => Object.defineProperty(obj, key, { enumerable: true, get: () => { calls++; return value; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const cases = [
    ['S proxy', () => tw(trap(pureS({ trusted: [TKW()] })))],
    ['S revoked proxy', () => tw(revoked.proxy)],
    ['S.run_id getter', () => tw(getter(pureS({ trusted: [TKW()] }), 'run_id', RUN))],
    ['S.authority proxy', () => { const S = pureS({ trusted: [TKW()] }); S.authority = trap(S.authority); return tw(S); }],
    ['S.authority.trusted proxy', () => { const S = pureS({ trusted: [TKW()] }); S.authority.trusted = trap(S.authority.trusted); return tw(S); }],
    ['trusted element getter', () => { const S = pureS(); getter(S.authority.trusted, 0, J(TKW())); return tw(S); }],
    ['untrusted entry getter', () => { const S = pureS(); S.authority.untrusted.push(getter({ seq: 1 }, 'line', J(TKW()))); return tw(S); }],
    ['required proxy', () => tw(pureS({ trusted: [TKW()] }), 'c1', { required: trap(['kind:contract']), protected: [] })],
    ['required element getter', () => tw(pureS({ trusted: [TKW()] }), 'c1', { required: getter([], 0, 'kind:contract'), protected: [] })],
    ['options getter', () => tw(pureS({ trusted: [TKW()] }), 'c1', getter({ protected: [] }, 'required', ['kind:contract']))],
    ['options proxy', () => tw(pureS({ trusted: [TKW()] }), 'c1', trap({ required: ['kind:contract'], protected: [] }))],
  ];
  for (const [name, run] of cases) {
    calls = 0;
    let out;
    assert.doesNotThrow(() => { out = run(); }, name);
    assert.equal(calls, 0, `${name}: no trap or getter ran`);
    assert.equal(out.ok, false, name);
    assert.deepEqual(out.waived, [], name);
  }
  for (const S of [null, undefined, 1, 'S', Symbol('s'), [], Object.create(null)]) {
    assert.doesNotThrow(() => tw(S), typeof S);
    assert.deepEqual(tw(S).waived, []);
  }
});

test('[P6-L3] huge or wide authority lists and requirement sets stop with test_kinds_waiver_budget_exceeded; the boundary passes', () => {
  const B = A.TEST_KIND_WAIVER_BUDGET;
  assert.ok(Number.isSafeInteger(B.lines) && Number.isSafeInteger(B.bytes) && Number.isSafeInteger(B.subjects));
  const over = { ok: false, code: 'test_kinds_waiver_budget_exceeded', waived: [], unauthorized: [], ignored: ZERO };
  const flood = (n, where) => { const S = pureS({ trusted: [TKW()] }); const l = J({ event: 'NOTE' });
    for (let i = 0; i < n; i++) (where === 'trusted' ? S.authority.trusted.push(l) : S.authority.untrusted.push({ line: l, seq: 1 })); return S; };
  assert.deepEqual(tw(flood(B.lines, 'untrusted')), over, 'a worker-planted untrusted flood');
  assert.deepEqual(tw(flood(B.lines, 'trusted')), over);
  assert.deepEqual(tw(flood(B.lines - 1, 'untrusted')).waived, ['kind:contract'], 'exactly the line budget passes');
  const sparse = pureS({ trusted: [TKW()] }); sparse.authority.trusted.length = 2 ** 32 - 1;
  assert.deepEqual(tw(sparse), over, 'a sparse array of maximal length is refused by its length');
  const fat = pureS({ trusted: [TKW({ reason: 'r'.repeat(B.bytes) })] });
  assert.deepEqual(tw(fat), over, 'one line over the byte budget');
  const many = Array.from({ length: B.subjects + 1 }, (_, i) => `kind:k${i}`);
  assert.deepEqual(tw(pureS({ trusted: [TKW()] }), 'c1', { required: many, protected: [] }), over, 'a requirement set over budget');
  assert.deepEqual(tw(pureS({ trusted: [TKW()] }), 'c1', { required: ['kind:contract'], protected: many }), over, 'a protected set over budget');
  assert.deepEqual(tw(pureS({ trusted: [TKW()] }), 'c1', { required: ['kind:contract', ...many.slice(0, B.subjects - 1)], protected: [] }).waived, ['kind:contract'],
    'exactly the subject budget passes');
});

// ------------------------------------------------------------------ AC4: the security waiverState is unchanged (L5 differential)

/*
 * ORACLE: verbatim copies of securityEvents, waiverState and observeAuthority (with its AUTHORITY_EVENTS
 * list) from origin/main 5a29114 skills/ship-ticket/scripts/engine-authority.mjs and run-state.mjs.
 * They share the current pairProblem/pairKey (engine-dag.mjs), parseRunState, blockExtends and
 * malformedReason, which this slice does not touch, so the differential proves engine-authority's
 * own security code and the observation rule for every pre-existing event are unchanged; it does not
 * prove those shared helpers unchanged.
 */
const O_AUTHORITY_EVENTS = ['START', 'DAG_BOUND', 'RETRY', 'UNIT_CLEAR', 'SECURITY_ADDENDUM', 'SECURITY_WAIVER'];
const O_BOUND_ON_INIT = ['START', 'DAG_BOUND'];
const O_mayRun = (a, isAlive) => (a.status === 'unknown' ? isAlive(a.pgid) !== false : LIVE.includes(a.status));
function O_observeAuthority(S, planText, isAlive) {
  const fresh = !S.authority;
  const A = (S.authority ??= { through: 0, trusted: [], untrusted: [] });
  const R2 = R.parseRunState(planText ?? '');
  const rewritten = Boolean(R2 && A.block && !R.blockExtends(A.block, R2));
  const tainted = (S.attempts ?? []).length > A.through || rewritten || R.malformedReason(R2) !== null;
  for (const e of R2?.events ?? []) {
    if (!O_AUTHORITY_EVENTS.includes(e.event)) continue;
    const line = JSON.stringify(e);
    if (A.trusted.includes(line) || A.untrusted.some(u => u.line === line)) continue;
    if (tainted && !(fresh && O_BOUND_ON_INIT.includes(e.event))) A.untrusted.push({ line, seq: S.seq ?? 0 });
    else A.trusted.push(line);
  }
  if (rewritten) A.rewrites = (A.rewrites ?? 0) + 1;
  if (R2) A.block = { length: R2.length, digest: R2.digest };
  if (!(S.attempts ?? []).some(a => O_mayRun(a, isAlive))) A.through = (S.attempts ?? []).length;
}
const O_trustedEvents = (S, kind) => (S.authority?.trusted ?? []).map(l => JSON.parse(l)).filter(e => e.event === kind);
const O_untrustedEvents = (S, kind) => (S.authority?.untrusted ?? []).map(u => JSON.parse(u.line)).filter(e => e.event === kind);
const O_SAFE_ADDENDUM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const O_nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const O_specKey = (s) => `${s.file}\u0000${s.name}`;
function O_securityEvents(S) {
  const nodes = S.nodes ?? {};
  const pairs = (S.config?.controlCoverage ?? []).map(p => structuredClone(p));
  const effective = new Set(pairs.map(pairKey)), specs = new Set(pairs.flatMap(p => p.specs.map(O_specKey)));
  const addenda = [], conflicts = [], outside = [], seen = new Map();
  const mine = (e) => e.run_id === S.run_id;
  for (const line of S.authority?.trusted ?? []) {
    const e = JSON.parse(line);
    if (e.event !== 'SECURITY_ADDENDUM' || !mine(e)) continue;
    const id = e.addendum_id;
    if (!(typeof id === 'string' && O_SAFE_ADDENDUM.test(id)) || !O_nonEmpty(e.authorized_by) || !O_nonEmpty(e.reason) || !Array.isArray(e.pairs) || !e.pairs.length) {
      conflicts.push({ addendum_id: id ?? null, reason: 'an addendum needs a safe addendum_id, authorized_by, a reason and non-empty pairs' });
      continue;
    }
    if (seen.has(id)) {
      if (seen.get(id) !== line) conflicts.push({ addendum_id: id, reason: `addendum ${id} was appended again with other bytes` });
      continue;
    }
    seen.set(id, line);
    let problem = null;
    const mineKeys = new Set(), mineSpecs = new Set();
    for (const p of e.pairs) {
      const why = pairProblem(p, nodes, { needPinned: false });
      if (why.shape) { problem = { conflict: why.shape }; break; }
      if (why.contract) { problem = { outside: why.contract }; break; }
      if (effective.has(pairKey(p)) || mineKeys.has(pairKey(p))) { problem = { conflict: `${pairKey(p)} is already effective (addenda only add)` }; break; }
      const shared = p.specs.find(s => specs.has(O_specKey(s)) || mineSpecs.has(O_specKey(s)));
      if (shared) { problem = { conflict: `${pairKey(p)}: spec ${shared.file} "${shared.name}" is already another pair's` }; break; }
      mineKeys.add(pairKey(p));
      p.specs.forEach(s => mineSpecs.add(O_specKey(s)));
    }
    if (problem?.conflict) { conflicts.push({ addendum_id: id, reason: problem.conflict }); continue; }
    if (problem?.outside) { outside.push({ addendum_id: id, reason: problem.outside }); continue; }
    const added = e.pairs.map(p => ({ boundary: p.boundary, control: p.control, node: p.node, specs: p.specs.map(s => ({ file: s.file, name: s.name })), addendum: id }));
    for (const p of added) { pairs.push(p); effective.add(pairKey(p)); p.specs.forEach(s => specs.add(O_specKey(s))); }
    addenda.push({ addendum_id: id, pairs: added });
  }
  return { pairs, addenda, waivers: O_trustedEvents(S, 'SECURITY_WAIVER').filter(mine),
    forged: { addenda: O_untrustedEvents(S, 'SECURITY_ADDENDUM').filter(mine), waivers: O_untrustedEvents(S, 'SECURITY_WAIVER').filter(mine) },
    conflicts, outside };
}
function O_waiverState(S, sec, candidate) {
  const keys = new Set(sec.pairs.map(pairKey));
  const match = (e) => e.candidate === candidate && e.policy_version === 2 && O_nonEmpty(e.authorized_by) && O_nonEmpty(e.reason)
    && keys.has(`${e.boundary}:${e.control}`);
  const waived = [...new Set(sec.waivers.filter(match).map(e => `${e.boundary}:${e.control}`))].sort();
  const unauthorized = [...new Set(sec.forged.waivers.filter(match).map(e => `${e.boundary}:${e.control}`))].filter(k => !waived.includes(k)).sort();
  return { waived, unauthorized };
}

// The waiver corpus: every security event shape [S8]-[S10]/[S24] and the pure C1 rows vary, plus
// TEST_KIND_WAIVER lines that mimic a security waiver as closely as the shape allows.
const SPEC = { file: 'spec/sec.test.mjs', name: 'p' }, SPEC2 = { file: 'spec/sec.test.mjs', name: 'q' };
const PAIR = { boundary: 'GET-orders', control: 'VAPT-API-01', node: 'api', specs: [SPEC] };
const ADD = (over = {}) => ({ run_id: RUN, event: 'SECURITY_ADDENDUM', addendum_id: 'add-1', authorized_by: 'owner', reason: 'r',
  pairs: [{ boundary: 'POST-orders', control: 'VAPT-API-02', node: 'api', specs: [SPEC2] }], ...over });
const WAIVE = (over = {}) => ({ run_id: RUN, event: 'SECURITY_WAIVER', boundary: 'GET-orders', control: 'VAPT-API-01', candidate: 'c1',
  policy_version: 2, authorized_by: 'owner', reason: 'r', ...over });
const POOL = [
  WAIVE(), WAIVE({ candidate: 'c0' }), WAIVE({ policy_version: 1 }), WAIVE({ authorized_by: '' }), WAIVE({ reason: '' }), WAIVE({ control: 'VAPT-API-09' }),
  WAIVE({ boundary: 'POST-orders', control: 'VAPT-API-02' }), WAIVE({ run_id: 'run-0' }),
  ADD(), ADD({ reason: 'other bytes' }), ADD({ reason: '' }), ADD({ pairs: [{ ...ADD().pairs[0], node: 'web' }] }), ADD({ pairs: [{ ...PAIR, specs: [SPEC2] }] }),
  ADD({ run_id: 'run-0' }),
  TKW(), TKW({ candidate: 'c0' }), TKW({ requirement: 'kind:auth' }),
  { ...TKW(), boundary: 'GET-orders', control: 'VAPT-API-01', policy_version: 2 },
];
const secS = (trusted, untrusted, coverage) => ({ run_id: RUN, plan_digest: DIGEST, config: { securityPolicy: 2, controlCoverage: coverage },
  nodes: { api: { id: 'api', writes: ['spec'] }, web: { id: 'web', writes: ['web'] } },
  authority: { through: 0, trusted: trusted.map(e => J(e)), untrusted: untrusted.map(e => ({ line: J(e), seq: 1 })) } });
const isTk = (e) => e.event === 'TEST_KIND_WAIVER';

test('[P6-AC4] differential: securityEvents and waiverState equal the 5a29114 oracle over the waiver corpus, TEST_KIND_WAIVER lines included', () => {
  const subsets = [[]];
  for (let i = 0; i < POOL.length; i++) { subsets.push([POOL[i]]); for (let j = i + 1; j < POOL.length; j++) subsets.push([POOL[i], POOL[j]]); }
  let cases = 0, waivedSeen = 0, unauthorizedSeen = 0, tkLines = 0;
  for (const coverage of [[], [PAIR]]) for (const trusted of subsets) for (const untrusted of [[], ...POOL.map(e => [e])]) for (const candidate of ['c0', 'c1']) {
    const S = secS(trusted, untrusted, coverage), O = secS(trusted, untrusted, coverage);
    const got = A.securityEvents(S), want = O_securityEvents(O);
    assert.deepEqual(got, want, `securityEvents ${J({ trusted, untrusted, coverage })}`);
    const w = A.waiverState(S, got, candidate);
    assert.deepEqual(w, O_waiverState(O, want, candidate), `waiverState ${J({ trusted, untrusted, coverage, candidate })}`);
    // test-kind lines never move the security result: equal to the oracle on the same state without them
    const bare = secS(trusted.filter(e => !isTk(e)), untrusted.filter(e => !isTk(e)), coverage);
    const bareSec = O_securityEvents(bare);
    assert.deepEqual(got, bareSec, 'test-kind lines leave securityEvents unchanged');
    assert.deepEqual(w, O_waiverState(bare, bareSec, candidate), 'test-kind lines leave waiverState unchanged');
    assert.deepEqual(S, O, 'neither function mutates the state');
    cases++; waivedSeen += w.waived.length > 0; unauthorizedSeen += w.unauthorized.length > 0;
    tkLines += [...trusted, ...untrusted].some(isTk);
  }
  // the corpus exercises both outcomes and the test-kind lines (a vacuous corpus would prove nothing)
  assert.ok(cases > 4000 && waivedSeen > 100 && unauthorizedSeen > 100 && tkLines > 1000, J({ cases, waivedSeen, unauthorizedSeen, tkLines }));
});

test('[P6-AC4] differential: observeAuthority classifies every pre-existing event exactly as the 5a29114 oracle', () => {
  const EV = [START, { run_id: RUN, event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' }, WAIVE(), ADD(),
    { event: 'NOTE', n: 1 }, { run_id: RUN, event: 'UNIT_CLEAR', unit: 'u1' }];
  let cases = 0;
  const seen = new Set();
  // `pre`: an attempt recorded before the first observation (a fresh authority record that is already tainted)
  const FIRSTS = [[], [START], [START, EV[4]], ...EV.map(e => [e]), EV];
  for (const first of FIRSTS) for (const pre of [null, 'running', 'exited']) for (const status of [null, ...LIVE, 'exited']) for (const added of EV) for (const alive of [true, false]) {
    const S = { run_id: RUN, attempts: [], seq: 3 }, O = { run_id: RUN, attempts: [], seq: 3 };
    if (pre) { S.attempts.push({ id: 'p', status: pre, pgid: 8 }); O.attempts.push({ id: 'p', status: pre, pgid: 8 }); }
    A.observeAuthority(S, plan(first), () => alive); O_observeAuthority(O, plan(first), () => alive);
    assert.deepEqual(S, O, J({ first, pre, alive }));
    if (status) { S.attempts.push({ id: 'a', status, pgid: 9 }); O.attempts.push({ id: 'a', status, pgid: 9 }); }
    for (const text of [plan([...first, added]), plan([added, ...first]), plan([...first, added]).replace(R.END, R.END + '\n' + R.END)]) {
      A.observeAuthority(S, text, () => alive); O_observeAuthority(O, text, () => alive);
      assert.deepEqual(S, O, J({ first, pre, status, added, alive, text }));
      cases++;
    }
    for (const l of S.authority.trusted) seen.add(`trusted:${JSON.parse(l).event}`);
    for (const u of S.authority.untrusted) seen.add(`untrusted:${JSON.parse(u.line).event}`);
  }
  // non-vacuous: every authority event of the corpus was classified both ways somewhere
  for (const ev of ['START', 'RETRY', 'SECURITY_WAIVER', 'SECURITY_ADDENDUM', 'UNIT_CLEAR']) {
    assert.ok(seen.has(`trusted:${ev}`) && seen.has(`untrusted:${ev}`), `${ev} ${J([...seen])}`);
  }
  assert.ok(cases > 5000, String(cases));
});

test('[P6-AC4] testKindWaivers ignores every security event, and normDigest is the only digest normalisation (sha256- matches; case does not)', () => {
  const S = secS([WAIVE(), ADD(), { ...WAIVE(), requirement: 'kind:contract', plan_digest: DIGEST }], [WAIVE(), ADD()], [PAIR]);
  assert.deepEqual(tw(S), { ok: true, waived: [], unauthorized: [], ignored: ZERO });
  assert.equal(normDigest('sha256-x'), 'sha256:x');
  // normDigest is the whole normalisation: the legacy sha256- spelling matches; case and other forms do not
  const hex = 'a'.repeat(64);
  assert.deepEqual(tw(pureS({ trusted: [TKW({ plan_digest: 'sha256-' + hex })] })).waived, ['kind:contract'], 'legacy sha256- waiver digest');
  assert.deepEqual(tw(pureS({ trusted: [TKW()], over: { plan_digest: 'sha256-' + hex } })).waived, ['kind:contract'], 'legacy sha256- state digest');
  assert.deepEqual(tw(pureS({ trusted: [TKW({ plan_digest: 'SHA256:' + hex })] })).ignored.foreign, 1, 'uppercase prefix is not normalised');
  assert.deepEqual(tw(pureS({ trusted: [TKW({ plan_digest: 'sha256:' + hex.toUpperCase() })] })).ignored.foreign, 1, 'uppercase hex is not normalised');
});
