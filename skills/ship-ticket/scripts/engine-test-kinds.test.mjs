/**
 * S-01b2 P2: the test-kind verdict core (engine-test-kinds.mjs), a pure function of
 * requirement x evidence x trusted waivers x reassessed classes. Design: S-01b2-design.md rev 3, section 8 (P2) and the
 * section 6 outcome table rows 14, 19, 20, 21, 22 and 22a.
 *
 * Claim level: these tests prove properties of the PURE verdict over the inputs it is given (requirement records,
 * already-counted evidence ids, already-matched waivers). They do not prove that the scanner counts a marker (P1), that the
 * evidence is bound to a candidate (P4), that a waiver is trusted (P6) or that any freeze point calls the verdict (P5a/P5b).
 *
 * `kindsForClasses` and the protected tag set are INJECTED (P3 owns them in test-kinds.mjs; neither is on main at
 * 5a29114). Unit tests inject a table-driven stub. The [R12] integration tests inject an adapter that calls main's REAL
 * `requiredFor` (the only class loop on main) and compare the verdict with `requiredFor` and `checkTitles`: they prove
 * agreement with main's requirement code, not with P3's future function.
 *
 * Tests tagged [R#] are the ones the mutation check (the last test) runs against each mutant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testKindsVerdict, CODES, POINTS, LIMITS } from './engine-test-kinds.mjs';
import { KINDS, TAGS, SURFACE_TAGS, ITEM_ID, requiredFor, checkTitles, validateDeclaration, CHANGED } from './test-kinds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const PROTECTED = ['money', 'tenancy', 'auth'];
const uniq = (xs) => [...new Set(xs)].sort();

// ---- the injected stub: class -> tags, then the REAL TAGS table for tag -> kinds ----
const CLASS_TAGS = { payments: ['money'], ui: ['ui-lifecycle'], data: ['tenancy'], misc: ['concurrency'], [CHANGED]: [] };
function addSources(kinds, tag, extra) {
  for (const k of TAGS[tag]) kinds[k] = uniq([...(kinds[k] ?? []), ...extra, `tag:${tag}`]);
}
function stubKfc(classes) {
  const kinds = {};
  for (const c of classes) {
    if (!Object.hasOwn(CLASS_TAGS, c)) return { ok: false, code: 'risk_class_unmapped' };
    for (const t of CLASS_TAGS[c]) addSources(kinds, t, [`class:${c}`]);
  }
  return { ok: true, kinds };
}
/** A bound record as P3 provenance is specified to produce it (sources are path elements). */
function boundFrom({ tags = [], classes = [], surfaces = [], items = [], protectedKinds = null } = {}) {
  const kinds = {};
  for (const t of tags) addSources(kinds, t, []);
  for (const [k, s] of Object.entries(stubKfc(classes).kinds)) kinds[k] = uniq([...(kinds[k] ?? []), ...s]);
  for (const s of surfaces) for (const t of SURFACE_TAGS[s]) addSources(kinds, t, [`surface:${s}`]);
  const prot = protectedKinds ?? Object.keys(kinds).filter((k) => kinds[k].some((x) => x.startsWith('surface:') || PROTECTED.some((p) => x === `tag:${p}`)));
  return { tags: uniq([...tags, ...classes.flatMap((c) => CLASS_TAGS[c] ?? []), ...surfaces.flatMap((s) => SURFACE_TAGS[s])]), items: uniq(items), kinds, protected: uniq(prot) };
}
const DEPS = { kindsForClasses: stubKfc, protectedTags: PROTECTED };
function input(o = {}) {
  return {
    bound: o.bound ?? boundFrom(),
    declaration: o.declaration ?? null,
    reassessed: o.reassessed ?? [],
    evidence: { kinds: o.kinds ?? [], items: o.items ?? [], unknown_markers: o.unknown ?? 0 },
    waivers: { trusted: o.trusted ?? [], untrusted: o.untrusted ?? [] },
    state: { point: o.point ?? 'F1', retry_authorised: o.retry ?? false, held: o.held ?? 0, open_repairs: o.open ?? 0 },
  };
}
const verdict = (o, deps = DEPS) => testKindsVerdict(input(o), deps);
const ERROR_ONLY = (v) => { assert.equal(v.status, 'refused'); assert.equal(v.code, 'test_kinds_error'); assert.deepEqual(v.codes, ['test_kinds_error']); };

test('[R1] all required kinds and items present: pass, no code, ids and counts reported', () => {
  const bound = boundFrom({ tags: ['async-state'], items: ['Item1'] });
  const v = verdict({ bound, kinds: ['stale-N2', 'error-twin', 'negative', 'race'], items: ['Item1', 'Other'], unknown: 3 });
  assert.equal(v.status, 'pass');
  assert.equal(v.code, null);
  assert.deepEqual(v.codes, []);
  assert.deepEqual(v.required_kinds, ['error-twin', 'negative', 'stale-N2']);
  assert.deepEqual(v.required_items, ['Item1']);
  assert.deepEqual(v.missing_kinds, []);
  assert.deepEqual(v.unmapped_items, []);
  assert.equal(v.counts.present_kinds, 3);
  assert.equal(v.counts.present_items, 1);
  assert.equal(v.counts.unknown_markers, 3);
  // nothing required at all also passes (an active run whose plan says `test-triggers: none`)
  assert.equal(verdict({}).status, 'pass');
});

test('[R2] AC2: every missing kind and every missing item refuses, generated over each required subject', () => {
  const bound = boundFrom({ tags: ['async-state', 'money', 'entrypoint'], classes: ['ui'], surfaces: ['auth-lifecycle'], items: ['ItemA', 'ItemB'] });
  const allKinds = Object.keys(bound.kinds).sort();
  assert.ok(allKinds.length >= 6, 'the fixture requires several kinds');
  for (const k of allKinds) {
    const v = verdict({ bound, kinds: allKinds.filter((x) => x !== k), items: bound.items });
    assert.equal(v.status, 'refused', k);
    assert.equal(v.code, 'missing_test_kinds', k);
    assert.deepEqual(v.missing_kinds, [k]);
    assert.equal(v.counts.missing_kinds, 1);
  }
  for (const i of bound.items) {
    const v = verdict({ bound, kinds: allKinds, items: bound.items.filter((x) => x !== i) });
    assert.equal(v.code, 'unmapped_lifecycle_item', i);
    assert.deepEqual(v.unmapped_items, [i]);
  }
  const both = verdict({ bound });
  assert.deepEqual(both.codes, ['missing_test_kinds', 'unmapped_lifecycle_item']);
  assert.deepEqual(both.missing_kinds, allKinds);
  // evidence for kinds that are not required, and unknown markers, never stand in for a missing one
  const other = verdict({ bound: boundFrom({ tags: ['concurrency'] }), kinds: Object.keys(KINDS).filter((k) => k !== 'race'), unknown: 50 });
  assert.deepEqual(other.missing_kinds, ['race']);
  // a kind added only by a reassessed class is required too
  const added = verdict({ bound: boundFrom({ tags: ['entrypoint'] }), kinds: ['real-entrypoint'], reassessed: ['misc'] });
  assert.equal(added.code, 'missing_test_kinds');
  assert.deepEqual(added.missing_kinds, ['race']);
  assert.equal(added.counts.added_kinds, 1);
  assert.equal(added.counts.reassessed_classes, 1);
});

test('[R3] AC1 generated monotonicity: adding any source never removes a required kind or item, never unprotects, never turns a refusal into a pass', () => {
  const U = ['tag:async-state', 'tag:money', 'tag:entrypoint', 'bclass:payments', 'bclass:ui', 'surface:auth-lifecycle', 'rclass:data', 'rclass:misc', 'rclass:payments', 'item:I1'];
  const evidence = ['negative', 'race', 'real-entrypoint'];
  const trusted = [...Object.keys(KINDS).map((k) => `kind:${k}`), 'plan:I1'];
  const memo = new Map();
  const at = (mask) => {
    if (memo.has(mask)) return memo.get(mask);
    const pick = (p) => U.filter((u, i) => mask & (1 << i) && u.startsWith(p)).map((u) => u.slice(u.indexOf(':') + 1));
    const bound = boundFrom({ tags: pick('tag:'), classes: pick('bclass:'), surfaces: pick('surface:'), items: pick('item:') });
    const v = testKindsVerdict(input({ bound, reassessed: pick('rclass:'), kinds: evidence, trusted }), DEPS);
    assert.notEqual(v.code, 'test_kinds_error', `subset ${mask} is a valid input`);
    memo.set(mask, v);
    return v;
  };
  const sub = (a, b, what) => assert.deepEqual(a.filter((x) => !b.includes(x)), [], what);
  let pairs = 0;
  for (let mask = 0; mask < 1 << U.length; mask++) {
    const a = at(mask);
    for (let i = 0; i < U.length; i++) {
      if (mask & (1 << i)) continue;
      const b = at(mask | (1 << i)), why = `adding ${U[i]} to subset ${mask}`;
      sub(a.required_kinds, b.required_kinds, `${why}: required kinds`);
      sub(a.required_items, b.required_items, `${why}: required items`);
      sub(a.protected_kinds, b.protected_kinds, `${why}: protected kinds`);
      sub(a.missing_kinds, b.missing_kinds, `${why}: missing kinds (fixed evidence, every subject trusted-waived)`);
      if (a.status === 'refused') assert.equal(b.status, 'refused', `${why}: a refusal stays a refusal`);
      pairs++;
    }
  }
  assert.equal(pairs, U.length * (1 << (U.length - 1)), 'every (subset, added source) pair was checked');
  // the generator reaches both outcomes, so the implications above are not vacuous
  assert.ok([...memo.values()].some((v) => v.status === 'pass') && [...memo.values()].some((v) => v.status === 'refused'));
});

test('[R4] AC3: protection is recomputed from ALL effective provenance, bound and reassessed, before waivers apply', () => {
  // (a) the discriminating case: `race` is waivable while it comes from `concurrency` only; a reassessed class that reaches
  // `money` makes it protected, so the same trusted waiver stops applying
  const bound = boundFrom({ tags: ['concurrency'] });
  const before = verdict({ bound, trusted: ['kind:race'] });
  assert.equal(before.status, 'pass');
  assert.deepEqual(before.waived, ['kind:race']);
  const after = verdict({ bound, trusted: ['kind:race'], reassessed: ['payments'], kinds: ['negative'] });
  assert.equal(after.status, 'refused');
  assert.equal(after.code, 'missing_test_kinds');
  assert.deepEqual(after.missing_kinds, ['race']);
  assert.ok(after.protected_kinds.includes('race'));
  assert.deepEqual(after.waived, []);
  assert.equal(after.counts.waiver_protected, 1);
  // (b) a bound class source with no tag path and a stale (empty) bound protection: the class is re-mapped every verdict
  const stale = { tags: ['money'], items: [], kinds: { negative: ['class:payments'], race: ['class:payments'] }, protected: [] };
  const vb = verdict({ bound: stale, trusted: ['kind:race', 'kind:negative'] });
  assert.deepEqual(vb.protected_kinds, ['negative', 'race']);
  assert.deepEqual(vb.missing_kinds, ['negative', 'race']);
  // (c) bound protection is add-only: a kind protected at init stays protected even when no source shows why
  const pinned = { tags: [], items: [], kinds: { regression: ['tag:repair'] }, protected: ['regression'] };
  assert.equal(verdict({ bound: pinned, trusted: ['kind:regression'] }).code, 'missing_test_kinds');
  // (d) a security surface protects; a direct protected tag protects; each injected protected tag is honoured
  assert.deepEqual(verdict({ bound: { tags: [], items: [], kinds: { 'real-entrypoint': ['surface:security-config', 'tag:entrypoint'] }, protected: [] } }).protected_kinds, ['real-entrypoint']);
  for (const p of PROTECTED) {
    const b = { tags: [p], items: [], kinds: { negative: [`tag:${p}`] }, protected: [] };
    assert.deepEqual(verdict({ bound: b, trusted: ['kind:negative'] }).missing_kinds, ['negative'], p);
    assert.equal(verdict({ bound: b, trusted: ['kind:negative'] }, { ...DEPS, protectedTags: PROTECTED.filter((x) => x !== p) }).status, 'pass', `${p} not protected when not injected`);
  }
  // (e) an unprotected source alone does not protect
  assert.deepEqual(verdict({ bound: boundFrom({ tags: ['concurrency', 'entrypoint'] }) }).protected_kinds, []);
  // (f) the protected set cannot be injected empty or absent (that would fail open)
  ERROR_ONLY(verdict({}, { ...DEPS, protectedTags: [] }));
  ERROR_ONLY(verdict({}, { kindsForClasses: stubKfc }));
});

test('[R5] AC4: a trusted waiver removes exactly one non-protected required subject; nothing else has an effect', () => {
  const bound = boundFrom({ tags: ['concurrency', 'entrypoint', 'tenancy'], items: ['ItemA', 'ItemB'] });
  const present = ['negative', 'ownership']; // the protected (tenancy) kinds are present
  const all = ['race', 'real-entrypoint'];
  // each non-protected missing subject is removed by its own waiver only
  for (const k of all) {
    const v = verdict({ bound, kinds: present, items: bound.items, trusted: [`kind:${k}`] });
    assert.deepEqual(v.missing_kinds, all.filter((x) => x !== k), k);
    assert.deepEqual(v.waived, [`kind:${k}`]);
  }
  const vi = verdict({ bound, kinds: [...present, ...all], items: ['ItemB'], trusted: ['plan:ItemA'] });
  assert.equal(vi.status, 'pass');
  assert.deepEqual(vi.waived, ['plan:ItemA']);
  // protected subjects: no effect, counted
  const vp = verdict({ bound, kinds: all, items: bound.items, trusted: ['kind:negative', 'kind:ownership'] });
  assert.deepEqual(vp.missing_kinds, ['negative', 'ownership']);
  assert.deepEqual(vp.waived, []);
  assert.equal(vp.counts.waiver_protected, 2);
  // subjects that are not required: no effect, counted; a waiver for a present kind changes nothing
  const vn = verdict({ bound, kinds: present, items: bound.items, trusted: ['kind:regression', 'plan:Nope', 'kind:race'] });
  assert.deepEqual(vn.missing_kinds, ['real-entrypoint']);
  assert.equal(vn.counts.waiver_not_required, 2);
  // an untrusted matching waiver refuses (row 21), even when it names a present kind, and never removes anything
  const vu = verdict({ bound, kinds: [...present, ...all], items: bound.items, untrusted: ['kind:race'] });
  assert.equal(vu.code, 'waiver_unauthorized');
  assert.equal(vu.counts.waiver_untrusted, 1);
  const vu2 = verdict({ bound, kinds: present, items: bound.items, untrusted: ['kind:race', 'kind:real-entrypoint'] });
  assert.deepEqual(vu2.missing_kinds, all);
  assert.deepEqual(vu2.codes, ['waiver_unauthorized', 'missing_test_kinds']);
  // coordinator precedence (pending rev 4, Codex finding 8 on rows 21/32): an EFFECTIVE trusted waiver (required, not
  // protected) for the same subject suppresses the untrusted one; an ineffective trusted waiver does not
  const vs = verdict({ bound, kinds: present, items: bound.items, trusted: ['kind:race', 'kind:real-entrypoint'], untrusted: ['kind:race'] });
  assert.equal(vs.status, 'pass');
  assert.equal(vs.counts.waiver_untrusted, 1);
  const vs2 = verdict({ bound, kinds: present, items: bound.items, trusted: ['kind:race'], untrusted: ['kind:real-entrypoint'] });
  assert.deepEqual(vs2.codes, ['waiver_unauthorized', 'missing_test_kinds'], 'a trusted waiver suppresses only its own subject');
  const vs3 = verdict({ bound, kinds: all, items: bound.items, trusted: ['kind:negative'], untrusted: ['kind:negative'] });
  assert.deepEqual(vs3.codes, ['waiver_unauthorized', 'missing_test_kinds'], 'a trusted waiver of a protected subject is ineffective and suppresses nothing');
  const vs4 = verdict({ bound, kinds: [...present, ...all], items: bound.items, trusted: ['kind:regression'], untrusted: ['kind:regression'] });
  assert.equal(vs4.code, 'waiver_unauthorized', 'a trusted waiver of a subject that is not required is ineffective');
  const vs5 = verdict({ bound, kinds: [...present, ...all], items: ['ItemB'], trusted: ['plan:ItemA'], untrusted: ['plan:ItemA'] });
  assert.equal(vs5.status, 'pass', 'items follow the same rule');
  // a malformed subject is not a waiver: the input is refused whole
  for (const bad of ['race', 'kind:', 'kind:Race!', 'plan:9x', 'tag:money', 'kind:race ', ' kind:race']) ERROR_ONLY(verdict({ bound, trusted: [bad] }));
});

test('[R6] row 14 and row 19: an unmapped reassessed class refuses; a broken kindsForClasses is test_kinds_error, never a pass', () => {
  const bound = boundFrom({ tags: ['entrypoint'] });
  const v = verdict({ bound, kinds: ['real-entrypoint'], reassessed: ['mystery'] });
  assert.equal(v.status, 'refused');
  assert.deepEqual(v.codes, ['risk_class_unmapped']);
  // the changed-declaration class maps to nothing and is NOT unmapped
  assert.equal(verdict({ bound, kinds: ['real-entrypoint'], reassessed: [CHANGED] }).status, 'pass');
  const broken = [
    () => { throw new Error('boom /secret/path'); },
    () => undefined, () => null, () => 'ok', () => ({ ok: true }), () => ({ ok: false }), () => ({ ok: false, code: 'something_else' }),
    () => ({ ok: true, kinds: { 'not-a-kind': ['tag:money'] } }), () => ({ ok: true, kinds: { race: 'tag:money' } }),
    () => ({ ok: true, kinds: { race: ['money'] } }), () => ({ ok: true, kinds: { race: [] } }), () => ({ ok: true, kinds: [] }),
    () => ({ ok: true, kinds: {}, extra: 1 }), () => Promise.resolve({ ok: true, kinds: {} }),
    () => new Proxy({ ok: true, kinds: {} }, {}),
  ];
  for (const [i, f] of broken.entries()) ERROR_ONLY(verdict({ bound, kinds: ['real-entrypoint'], reassessed: ['misc'] }, { ...DEPS, kindsForClasses: f }), `broken kindsForClasses #${i}`);
  // kindsForClasses is called once, synchronously, with the union of bound and reassessed classes and the declaration
  const calls = [], decl = { tags: {}, classes: {} };
  verdict({ bound: boundFrom({ classes: ['ui'] }), reassessed: ['misc', 'ui'], declaration: decl }, { ...DEPS, kindsForClasses: (c, d) => (calls.push([c, d]), stubKfc(c)) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], ['misc', 'ui']);
  assert.equal(calls[0][1], decl);
});

test('[R7] rows 22 and 22a: a held repair refuses at F1 (without an authorised RETRY), F4, S1 and V; an open repair refuses only `gate test-kinds`', () => {
  const held = new Set(['F1', 'F4', 'S1', 'V']);
  for (const point of POINTS) {
    for (const retry of [false, true]) {
      const v = verdict({ point, retry, held: 1 });
      const want = held.has(point) && !(point === 'F1' && retry);
      assert.equal(v.codes.includes('test_kinds_held'), want, `${point} retry=${retry}`);
      const o = verdict({ point, retry, open: 1 });
      assert.equal(o.codes.includes('test_kinds_repair_open'), point === 'gate', `${point} open`);
      assert.equal(verdict({ point, retry }).status, 'pass', `${point}: nothing held or open passes`);
    }
  }
  assert.deepEqual([...POINTS].sort(), ['F1', 'F2', 'F3', 'F4', 'S1', 'S2', 'V', 'gate'].sort());
  for (const bad of ['f1', 'F5', '', null, 1]) ERROR_ONLY(testKindsVerdict({ ...input(), state: { point: bad, retry_authorised: false, held: 0, open_repairs: 0 } }, DEPS));
});

test('[R8] codes are reported in one fixed precedence; `code` is the first', () => {
  assert.deepEqual([...CODES], ['test_kinds_error', 'test_kinds_held', 'test_kinds_repair_open', 'risk_class_unmapped', 'waiver_unauthorized', 'missing_test_kinds', 'unmapped_lifecycle_item']);
  const v = verdict({ point: 'V', held: 1, bound: boundFrom({ tags: ['concurrency'], items: ['X1'] }), reassessed: ['mystery'], untrusted: ['kind:race'] });
  assert.deepEqual(v.codes, ['test_kinds_held', 'risk_class_unmapped', 'waiver_unauthorized', 'missing_test_kinds', 'unmapped_lifecycle_item']);
  assert.equal(v.code, 'test_kinds_held');
  const g = verdict({ point: 'gate', open: 2, bound: boundFrom({ tags: ['concurrency'] }) });
  assert.deepEqual(g.codes, ['test_kinds_repair_open', 'missing_test_kinds']);
});

const OUT_KEYS = ['status', 'code', 'codes', 'required_kinds', 'required_items', 'protected_kinds', 'missing_kinds', 'unmapped_items', 'waived', 'counts'];
const COUNT_KEYS = ['required_kinds', 'required_items', 'added_kinds', 'protected_kinds', 'present_kinds', 'present_items', 'missing_kinds', 'unmapped_items', 'waived', 'waiver_protected', 'waiver_not_required', 'waiver_untrusted', 'unknown_markers', 'reassessed_classes'];
function assertIdsOnly(v, where) {
  assert.deepEqual(Object.keys(v).sort(), [...OUT_KEYS].sort(), where);
  assert.ok(['pass', 'refused'].includes(v.status), where);
  assert.ok(v.code === null || CODES.includes(v.code), where);
  for (const c of v.codes) assert.ok(CODES.includes(c), where);
  for (const k of ['required_kinds', 'protected_kinds', 'missing_kinds']) for (const x of v[k]) assert.ok(Object.hasOwn(KINDS, x), `${where}: ${k}`);
  for (const k of ['required_items', 'unmapped_items']) for (const x of v[k]) assert.ok(ITEM_ID.test(x), `${where}: ${k}`);
  for (const x of v.waived) assert.ok(/^kind:/.test(x) ? Object.hasOwn(KINDS, x.slice(5)) : /^plan:/.test(x) && ITEM_ID.test(x.slice(5)), `${where}: waived`);
  assert.deepEqual(Object.keys(v.counts).sort(), [...COUNT_KEYS].sort(), where);
  for (const n of Object.values(v.counts)) assert.ok(Number.isSafeInteger(n) && n >= 0, `${where}: counts`);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(v))), JSON.stringify(v), `${where}: plain JSON data`);
}

test('[R9] AC5: every output, valid or refused, is closed keys, enums, ids and counts; hostile strings and exception text never appear', () => {
  const SECRET = 'SECRET-/etc/passwd-<script>';
  const outs = [
    verdict({}), verdict({ bound: boundFrom({ tags: ['money', 'async-state'], items: ['ItemA'] }), trusted: ['kind:race', 'plan:ItemA'], untrusted: ['kind:negative'], unknown: 9 }),
    verdict({ reassessed: ['mystery'] }), verdict({ point: 'gate', open: 1 }), verdict({ point: 'S1', held: 1 }),
    verdict({ kinds: [SECRET] }), verdict({ trusted: [SECRET] }), verdict({ reassessed: [SECRET] }), verdict({ items: [SECRET] }),
    verdict({ bound: { tags: [], items: [SECRET], kinds: {}, protected: [] } }),
    verdict({}, { ...DEPS, kindsForClasses: () => { throw new Error(SECRET); } }),
    testKindsVerdict(SECRET, DEPS), testKindsVerdict(undefined, undefined),
  ];
  for (const [i, v] of outs.entries()) {
    assertIdsOnly(v, `output #${i}`);
    assert.ok(!JSON.stringify(v).includes('SECRET'), `output #${i} carries no input text`);
  }
  // a refused-with-error output is empty but complete
  const e = outs.at(-1);
  ERROR_ONLY(e);
  assert.deepEqual(Object.values(e.counts).filter((n) => n !== 0), []);
});

test('[R10] hostile input: proxies, getters, huge, sparse, deep, non-plain and inherited values refuse test_kinds_error without running a trap or getter and without throwing', () => {
  let touched = 0;
  const trap = { get: () => { touched++; }, getOwnPropertyDescriptor: () => { touched++; }, ownKeys: () => { touched++; return []; }, has: () => { touched++; }, getPrototypeOf: () => { touched++; return Object.prototype; } };
  const P = (t) => new Proxy(t, trap);
  const getter = (o, k, v) => Object.defineProperty(o, k, { enumerable: true, get: () => { touched++; return v; } });
  const huge = []; huge.length = LIMITS.maxItems + 1; getter(huge, 0, 'race'); // the length alone must refuse it
  const sparse = ['race']; sparse.length = 3;
  const deepKinds = { race: ['tag:concurrency'] }; let d = deepKinds; for (let i = 0; i < 1000; i++) { d.race.push([]); d = { race: d.race[1] }; }
  const wideMap = {}; for (let i = 0; i < 5000; i++) wideMap[`k${i}`] = ['tag:money'];
  class Box { constructor() { this.kinds = []; this.items = []; this.unknown_markers = 0; } }
  const inherited = Object.create({ kinds: [], items: [], unknown_markers: 0 });
  const withSym = { ...input().evidence, [Symbol('x')]: 1 };
  const base = input();
  const cases = {
    'root proxy': P(input()),
    'evidence proxy': { ...base, evidence: P(base.evidence) },
    'kinds array proxy': { ...base, evidence: { ...base.evidence, kinds: P(['race']) } },
    'bound map proxy': { ...base, bound: { ...base.bound, kinds: P({}) } },
    'state proxy': { ...base, state: P(base.state) },
    'getter field': { ...base, evidence: getter({ items: [], unknown_markers: 0 }, 'kinds', ['race']) },
    'getter element': { ...base, evidence: { ...base.evidence, kinds: getter([], 0, 'race') } },
    'huge array': { ...base, evidence: { ...base.evidence, kinds: huge } },
    'sparse array': { ...base, evidence: { ...base.evidence, kinds: sparse } },
    'deep sources': { ...base, bound: { ...base.bound, kinds: deepKinds } },
    'wide kinds map': { ...base, bound: { ...base.bound, kinds: wideMap } },
    'class instance': { ...base, evidence: new Box() },
    'inherited fields': { ...base, evidence: inherited },
    'symbol key': { ...base, evidence: withSym },
    'unknown key': { ...base, extra: true },
    'missing key': { bound: base.bound, evidence: base.evidence, waivers: base.waivers, state: base.state, reassessed: [] },
    'array as object': { ...base, evidence: [] },
    'string object': { ...base, evidence: { ...base.evidence, kinds: [Object('race')] } },
    'oversized id': { ...base, evidence: { ...base.evidence, kinds: ['r'.repeat(1 << 20)] } },
    'unknown kind in bound': { ...base, bound: { ...base.bound, kinds: { racing: ['tag:concurrency'] } } },
    'bad source': { ...base, bound: { ...base.bound, kinds: { race: ['concurrency'] } } },
    'bad class': { ...base, reassessed: ['Bad Class'] },
    'negative count': { ...base, evidence: { ...base.evidence, unknown_markers: -1 } },
    'fractional count': { ...base, state: { ...base.state, held: 0.5 } },
    'NaN count': { ...base, state: { ...base.state, open_repairs: NaN } },
    'boolean as string': { ...base, state: { ...base.state, retry_authorised: 'yes' } },
    'declaration proxy': { ...base, declaration: P({}) },
    'declaration array': { ...base, declaration: [] },
    'deps proxy': null,
  };
  for (const [name, inp] of Object.entries(cases)) {
    let v;
    assert.doesNotThrow(() => { v = name === 'deps proxy' ? testKindsVerdict(input(), P(DEPS)) : testKindsVerdict(inp, DEPS); }, name);
    ERROR_ONLY(v, name);
  }
  assert.equal(touched, 0, 'no proxy trap and no getter ever ran');
  // a shared (DAG) reference is fine when it is valid data: the same array object used twice
  const shared = ['tag:concurrency'];
  assert.equal(verdict({ bound: { tags: [], items: [], kinds: { race: shared, negative: shared }, protected: [] }, kinds: ['race', 'negative'] }).status, 'pass');
  // the caps are exactly at their limits: maxItems elements pass, one more refuses
  const many = Array.from({ length: LIMITS.maxItems }, () => 'race');
  assert.equal(verdict({ bound: boundFrom({ tags: ['concurrency'] }), kinds: many }).status, 'pass');
  ERROR_ONLY(verdict({ bound: boundFrom({ tags: ['concurrency'] }), kinds: [...many, 'race'] }));
});

test('[R11] purity: no input is mutated, nothing is cached across calls, frozen inputs work', () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  const inp = deepFreeze(input({ bound: boundFrom({ tags: ['money'], items: ['ItemA'] }), kinds: ['negative'], trusted: ['plan:ItemA'], reassessed: ['misc'] }));
  const snap = JSON.stringify(inp);
  const a = testKindsVerdict(inp, DEPS), b = testKindsVerdict(inp, DEPS);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.equal(JSON.stringify(inp), snap);
  // recomputed on every call: the same bound record gives a different verdict when the evidence changes
  assert.equal(testKindsVerdict({ ...inp, evidence: { kinds: ['negative', 'race'], items: [], unknown_markers: 0 } }, DEPS).status, 'pass');
});

// ---- [R12] integration with main's REAL requirement code (L8: fixtures from the real producer) ----
const FLOOR = (classes) => `risk-floor: floor=STANDARD; classes=${classes.length ? classes.join(',') : 'none'}; claimed=STANDARD; ai=STANDARD; final=STANDARD; paths=1; matched=1; base=0123456789ab; head=worktree; declaration=none`;
const plan = (tags, classes, extra = '') => `# plan\n\ntest-triggers: ${tags.length ? tags.join(', ') : 'none'}\n${FLOOR(classes)}\n${extra}`;
function req(tags, classes, declaration = null, extra = '') {
  const r = requiredFor({ planText: plan(tags, classes, extra), declaration });
  return r;
}
/** kindsForClasses built ONLY from requiredFor calls: class -> tags (one call per class), tag -> kinds (one call per tag). */
function realKfc(classes, declaration) {
  const kinds = {};
  for (const c of classes) {
    const rc = req([], [c], declaration);
    if (rc.status !== 'required') return { ok: false, code: rc.errors[0] };
    for (const t of rc.tags) {
      const rt = req([t], [], declaration);
      assert.equal(rt.status, 'required', `tag ${t} resolves through requiredFor`);
      for (const k of rt.kinds) kinds[k] = uniq([...(kinds[k] ?? []), `class:${c}`, `tag:${t}`]);
    }
  }
  return { ok: true, kinds };
}
function realBound(tags, classes, declaration = null, items = []) {
  const kinds = {};
  for (const t of tags) { const rt = req([t], [], declaration); assert.equal(rt.status, 'required'); for (const k of rt.kinds) kinds[k] = uniq([...(kinds[k] ?? []), `tag:${t}`]); }
  const fromClasses = realKfc(classes, declaration);
  assert.equal(fromClasses.ok, true);
  for (const [k, s] of Object.entries(fromClasses.kinds)) kinds[k] = uniq([...(kinds[k] ?? []), ...s]);
  return { tags: uniq(tags), items, kinds, protected: [] };
}
const REAL = { kindsForClasses: realKfc, protectedTags: PROTECTED };

test('[R12] integration: the verdict agrees with main\'s requiredFor and checkTitles (same requirement code path)', () => {
  assert.ok(PROTECTED.every((t) => Object.hasOwn(TAGS, t)), 'every protected tag is a real TAGS row');
  const declaration = validateDeclaration({ version: 1, classes: { payments: ['money'], auth: ['concurrency'] }, tags: { money: ['regression'] } });
  const cases = [
    { tags: ['async-state', 'ui-lifecycle'], classes: [] },
    { tags: ['entrypoint'], classes: ['auth', CHANGED] }, // a class named like a tag, and the changed-declaration class
    { tags: [], classes: ['payments'], declaration }, // a declared class
    { tags: ['money'], classes: ['auth', 'payments'], declaration }, // built-in and declared mapping united, declared tag rows
    { tags: ['shared-contract', 'repair'], classes: [], items: ['ItemA'] },
  ];
  for (const c of cases) {
    const full = req(c.tags, c.classes, c.declaration ?? null, (c.items ?? []).map((i) => `lifecycle-item: ${i} the item text\n`).join(''));
    assert.equal(full.status, 'required', JSON.stringify(full.errors));
    const bound = realBound(c.tags, c.classes, c.declaration ?? null, full.items);
    assert.deepEqual(Object.keys(bound.kinds).sort(), full.kinds, 'the adapter reproduces requiredFor\'s kinds');
    // differential against checkTitles over every title subset of the required kinds (no waivers, nothing reassessed)
    const ks = full.kinds;
    for (let mask = 0; mask < 1 << ks.length; mask++) {
      const present = ks.filter((k, i) => mask & (1 << i));
      const titles = [...present.map((k) => `does it [kind:${k}]`), ...full.items.map((i) => `item [plan:${i}]`)];
      const ref = checkTitles(full, titles);
      const v = testKindsVerdict(input({ bound, declaration: c.declaration ?? null, kinds: present, items: full.items }), REAL);
      assert.deepEqual(v.missing_kinds, ref.missing_kinds);
      assert.equal(v.status === 'pass', ref.status === 'pass');
    }
  }
  // a reassessed class adds exactly what requiredFor would require with that class recorded
  const bound = realBound(['entrypoint'], ['auth']);
  const v = testKindsVerdict(input({ bound, reassessed: ['concurrency', 'tenancy'] }), REAL);
  assert.deepEqual(v.required_kinds, req(['entrypoint'], ['auth', 'concurrency', 'tenancy']).kinds);
  // protection through real mappings: `auth` (built-in class) and `payments` (declared class -> money) protect their kinds
  assert.deepEqual(v.protected_kinds, ['negative', 'ownership']);
  const pd = testKindsVerdict(input({ bound: realBound([], [], declaration), declaration, reassessed: ['payments'], trusted: ['kind:race', 'kind:regression'] }), REAL);
  assert.deepEqual(pd.missing_kinds, ['negative', 'race', 'regression']);
  assert.deepEqual(pd.waived, []);
  // an unmapped class refuses with requiredFor's own code
  const um = testKindsVerdict(input({ bound, reassessed: ['mystery'] }), REAL);
  assert.equal(um.code, req([], ['mystery']).errors[0]);
  assert.equal(um.code, 'risk_class_unmapped');
});

// ---- module copies: CRLF (L10) and mutation (L1) ----
/** The static relative-import closure of `entry` (the modules a copy must contain), plus the vapt catalog security-plan.mjs loads. */
function closure(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import\()\s*'\.\/([^']+)'/g)) todo.push(m[1]);
  }
  return [...seen].sort();
}
function copyLayout(transform = (s) => s) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-test-kinds-')));
  const dir = join(root, 'skills', 'ship-ticket', 'scripts');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  for (const f of closure('engine-test-kinds.test.mjs')) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), transform(readFileSync(join(HERE, f), 'utf8'), f)); }
  if (existsSync(join(SKILLS, 'vapt'))) cpSync(join(SKILLS, 'vapt'), join(root, 'skills', 'vapt'), { recursive: true });
  return { root, dir };
}
const lf = (s) => s.replace(/\r\n/g, '\n');

test('[R13] CRLF copy: every module of the closure with CRLF line endings gives byte-identical verdicts (L10)', async (t) => {
  assert.ok(closure('engine-test-kinds.test.mjs').includes('engine-test-kinds.mjs'));
  const { root, dir } = copyLayout((s) => lf(s).replace(/\n/g, '\r\n'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(readFileSync(join(dir, 'engine-test-kinds.mjs'), 'utf8').includes('\r\n'), 'the copy really is CRLF');
  const crlf = await import(pathToFileURL(join(dir, 'engine-test-kinds.mjs')).href);
  const inputs = [input({}), input({ bound: boundFrom({ tags: ['money', 'async-state'], classes: ['ui'], items: ['ItemA'] }), reassessed: ['misc', 'mystery'], kinds: ['race'], trusted: ['kind:stale-N2'], untrusted: ['plan:ItemA'], point: 'V', held: 1 }),
    input({ bound: boundFrom({ tags: ['concurrency'] }), trusted: ['kind:race'] }), input({ kinds: ['x'.repeat(100)] })];
  for (const i of inputs) assert.equal(JSON.stringify(crlf.testKindsVerdict(i, DEPS)), JSON.stringify(testKindsVerdict(i, DEPS)));
});

// ---- mutation check (L1): a mutant counts as killed ONLY by an ERR_ASSERTION failure in an [R#] test ----
const MUTANTS = [];
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
const run = (args, cwd) => new Promise((resolve) => {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
});
async function runMutant(t, mutant) {
  const { root, dir } = copyLayout((s, f) => {
    if (!mutant || f !== 'engine-test-kinds.mjs') return s;
    const text = lf(s);
    assert.equal(text.split(mutant.from).length, 2, `mutant "${mutant.name}": its target text occurs exactly once`);
    return text.replace(mutant.from, () => mutant.to);
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (mutant) {
    const load = await run(['--input-type=module', '-e', "await import('./engine-test-kinds.mjs')"], dir);
    if (load.code !== 0) return { invalid: true, tail: load.out.slice(-800) };
  }
  const r = await run(['--test', '--test-reporter=tap', '--test-name-pattern=\\[R\\d+\\]', 'engine-test-kinds.test.mjs'], dir);
  const blocks = r.out.split(/^(?=\s*(?:not )?ok \d+ - )/m).filter((b) => /^\s*not ok \d+ - /.test(b));
  const killers = blocks.filter((b) => /^\s*not ok \d+ - \[R\d+\]/.test(b) && /code: '?ERR_ASSERTION'?/.test(b)).map((b) => /\[R\d+\]/.exec(b)[0]);
  const passed = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  return { invalid: false, ...r, killers, passed, tail: r.out.slice(-1500) };
}

test('mutation: the control passes every [R#] test; every guard mutant loads and is killed by an assertion', { timeout: 30 * 60 * 1000 }, async (t) => {
  assert.ok(MUTANTS.length >= 1, 'mutants are declared');
  assert.equal(new Set(MUTANTS.map((m) => m.name)).size, MUTANTS.length, 'mutant names are distinct');
  for (const m of MUTANTS) assert.notEqual(m.from, m.to, m.name);
  const jobs = [null, ...MUTANTS], results = [];
  for (let i = 0; i < jobs.length; i += 4) results.push(...await Promise.all(jobs.slice(i, i + 4).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test:\n${control.tail}`);
  assert.ok(control.passed >= 13, `the control ran the tagged tests (${control.passed})`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: uniq(r.killers ?? []) }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.length).map((r) => `${r.m.name} (exit ${r.code})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure');
  t.diagnostic(`mutants ${mutants.length}, all killed by assertions`);
});
