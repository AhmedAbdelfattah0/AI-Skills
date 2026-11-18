/**
 * S-01b2 P2: the test-kind verdict core (engine-test-kinds.mjs), a pure function of
 * requirement x evidence x trusted waivers x reassessed classes. Design: S-01b2-design.md rev 5, section 8 (P2) and the
 * section 6 outcome table rows 16 (a P2 work cap), 17 (an exception), 19 (an unmapped reassessed class), 20a-20c (waiver and
 * missing subjects), 29 (an unknown marker) and 30 (waiver outcomes).
 *
 * Claim level: these tests prove properties of the PURE verdict over the inputs it is given (requirement records,
 * already-counted evidence ids, already-matched waivers). They do not prove that the scanner counts a marker (P1), that the
 * evidence is bound to a candidate (P4), that a waiver is trusted (P6) or that any freeze point calls the verdict (P5a/P5b).
 *
 * `kindsForClasses` and the protected tag set are INJECTED, and P3 owns both in test-kinds.mjs (on main since #91). Unit tests
 * inject a table-driven stub that returns P3's REAL result shape `{ ok, tags, kinds, provenance, errors }`. [R12] and [R14]
 * inject the REAL imported `kindsForClasses` and `PROTECTED_TAGS`: [R12] compares the verdict with `requiredFor` and
 * `checkTitles`; [R14] is the seam test that fails if P3's output shape (or P2's reading of it) changes.
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
import { KINDS, TAGS, SURFACE_TAGS, ITEM_ID, PROTECTED_TAGS, requiredFor, checkTitles, validateDeclaration, kindsForClasses, CHANGED } from './test-kinds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const PROTECTED = [...PROTECTED_TAGS];
const uniq = (xs) => [...new Set(xs)].sort();

// ---- the injected stub: class -> tags, then the REAL TAGS table for tag -> kinds ----
const CLASS_TAGS = { payments: ['money'], ui: ['ui-lifecycle'], data: ['tenancy'], misc: ['concurrency'], [CHANGED]: [] };
function addSources(kinds, tag, extra) {
  for (const k of TAGS[tag]) kinds[k] = uniq([...(kinds[k] ?? []), ...extra, `tag:${tag}`]);
}
/** P3's real shape: `{ ok, tags, kinds:[kind], provenance:{<kind>:[source]}, errors }`, called with ONE object. */
function stubKfc({ classes }) {
  const provenance = {}, tags = [];
  for (const c of classes) {
    if (!Object.hasOwn(CLASS_TAGS, c)) return { ok: false, tags: [], kinds: [], provenance: {}, errors: ['risk_class_unmapped'] };
    for (const t of CLASS_TAGS[c]) { tags.push(t); addSources(provenance, t, [`class:${c}`]); }
  }
  return { ok: true, tags: uniq(tags), kinds: Object.keys(provenance).sort(), provenance, errors: [] };
}
/** A bound record as P3 provenance is specified to produce it (sources are path elements). */
function boundFrom({ tags = [], classes = [], surfaces = [], items = [], protectedKinds = null } = {}) {
  const kinds = {};
  for (const t of tags) addSources(kinds, t, []);
  for (const [k, s] of Object.entries(stubKfc({ classes }).provenance)) kinds[k] = uniq([...(kinds[k] ?? []), ...s]);
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
const ERROR_ONLY = (v, why) => { assert.equal(v.status, 'refused', why); assert.equal(v.code, 'test_kinds_error', why); assert.deepEqual(v.codes, ['test_kinds_error'], why); };
/** Row 16: a cap (maxItems, maxKeys or the maxWork budget) was exceeded. */
const BUDGET_ONLY = (v, why) => { assert.equal(v.status, 'refused', why); assert.equal(v.code, 'evidence_budget_exceeded', why); assert.deepEqual(v.codes, ['evidence_budget_exceeded'], why); };

test('[R1] all required kinds and items present: pass, no code, ids and counts reported', () => {
  const bound = boundFrom({ tags: ['async-state'], items: ['Item1'] });
  const v = verdict({ bound, kinds: ['stale-N2', 'error-twin', 'negative', 'race', 'mystery-kind', 'mystery-kind'], items: ['Item1', 'Other'], unknown: 3 });
  assert.equal(v.status, 'pass');
  assert.equal(v.code, null);
  assert.deepEqual(v.codes, []);
  assert.deepEqual(v.required_kinds, ['error-twin', 'negative', 'stale-N2']);
  assert.deepEqual(v.required_items, ['Item1']);
  assert.deepEqual(v.missing_kinds, []);
  assert.deepEqual(v.unmapped_items, []);
  assert.equal(v.counts.present_kinds, 3);
  assert.equal(v.counts.present_items, 1);
  assert.equal(v.counts.unknown_markers, 4, 'row 29: a well-formed unknown kind id in the evidence is counted, once');
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

// Scope: TRUSTED waivers only. Untrusted waivers are excluded on purpose: under the interim precedence an added source can
// make a trusted waiver effective, which suppresses an untrusted one, so a `waiver_unauthorized` refusal can become a pass.
test('[R3] AC1 generated monotonicity: adding any source never removes a required kind or item, never unprotects, never turns a refusal into a pass (trusted waivers)', () => {
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
  const vn = verdict({ bound, kinds: present, items: bound.items, trusted: ['kind:regression', 'plan:Nope', 'kind:race', 'kind:no-such-kind'] });
  assert.deepEqual(vn.missing_kinds, ['real-entrypoint']);
  assert.equal(vn.counts.waiver_not_required, 3, 'row 30: a subject that is not required (an unknown kind too) has no effect and is counted');
  // an untrusted matching waiver refuses (row 20a, the deferred interim behaviour), even when it names a present kind, and never removes anything
  const vu = verdict({ bound, kinds: [...present, ...all], items: bound.items, untrusted: ['kind:race'] });
  assert.equal(vu.code, 'waiver_unauthorized');
  assert.equal(vu.counts.waiver_untrusted, 1);
  const vu2 = verdict({ bound, kinds: present, items: bound.items, untrusted: ['kind:race', 'kind:real-entrypoint'] });
  assert.deepEqual(vu2.missing_kinds, all);
  assert.deepEqual(vu2.codes, ['waiver_unauthorized', 'missing_test_kinds']);
  // interim precedence (kept; rev 5 row 30 'untrusted under trusted cover' is the same rule): an EFFECTIVE trusted waiver (required, not
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

test('[R6] row 19 and row 17: an unmapped reassessed class refuses; a broken kindsForClasses is test_kinds_error, never a pass', () => {
  const bound = boundFrom({ tags: ['entrypoint'] });
  const v = verdict({ bound, kinds: ['real-entrypoint'], reassessed: ['mystery'] });
  assert.equal(v.status, 'refused');
  assert.deepEqual(v.codes, ['risk_class_unmapped']);
  // the changed-declaration class maps to nothing and is NOT unmapped
  assert.equal(verdict({ bound, kinds: ['real-entrypoint'], reassessed: [CHANGED] }).status, 'pass');
  const ok = (o = {}) => ({ ok: true, tags: [], kinds: [], provenance: {}, errors: [], ...o });
  const bad = (o = {}) => ({ ok: false, tags: [], kinds: [], provenance: {}, errors: ['risk_class_unmapped'], ...o });
  const broken = [
    () => { throw new Error('boom /secret/path'); },
    () => undefined, () => null, () => 'ok', () => ({ ok: true }), () => ({ ok: false }), () => bad({ errors: ['something_else'] }),
    () => bad({ errors: [] }), () => bad({ errors: ['risk_class_unmapped', 'declaration_invalid'] }), () => bad({ kinds: ['race'] }), () => bad({ provenance: { race: ['tag:concurrency'] } }),
    () => ok({ provenance: { 'not-a-kind': ['tag:money'] }, kinds: ['not-a-kind'] }), () => ok({ provenance: { race: 'tag:money' }, kinds: ['race'] }),
    () => ok({ provenance: { race: ['money'] }, kinds: ['race'] }), () => ok({ provenance: { race: ['class:misc'] }, kinds: ['race'] }), // no tag on the class path
    () => ok({ provenance: { race: [] }, kinds: ['race'] }), () => ok({ provenance: [] }),
    () => ok({ provenance: { race: ['tag:concurrency'] }, kinds: [] }), () => ok({ provenance: {}, kinds: ['race'] }), // `kinds` and `provenance` must agree
    () => ok({ errors: ['risk_floor_invalid'] }), () => ok({ tags: ['Bad Tag'] }),
    () => ({ ...ok(), extra: 1 }), () => { const r = ok(); delete r.provenance; return r; },
    () => ({ ok: true, kinds: { race: ['tag:concurrency'] } }), // main's OLD documented shape (kinds as the provenance map) is refused
    () => Promise.resolve(ok()),
    () => new Proxy(ok(), {}),
  ];
  for (const [i, f] of broken.entries()) ERROR_ONLY(verdict({ bound, kinds: ['real-entrypoint'], reassessed: ['misc'] }, { ...DEPS, kindsForClasses: f }), `broken kindsForClasses #${i}`);
  // kindsForClasses is called once, synchronously, with ONE object { classes, declaration }: the union of bound and reassessed classes
  const calls = [], decl = { tags: {}, classes: {} };
  verdict({ bound: boundFrom({ classes: ['ui'] }), reassessed: ['misc', 'ui'], declaration: decl }, { ...DEPS, kindsForClasses: (...a) => (calls.push(a), stubKfc(a[0])) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, 'called with a single object argument');
  assert.deepEqual(Object.keys(calls[0][0]).sort(), ['classes', 'declaration']);
  assert.deepEqual(calls[0][0].classes, ['misc', 'ui']);
  assert.equal(calls[0][0].declaration, decl);
});

test('[R7] held and open-repair gates (inert in V0, rev 6 s5.2: P4r passes held:0, open_repairs:0; kept and tested): a held repair refuses at F1 (without an authorised RETRY), F4, S1 and V; an open repair refuses only `gate test-kinds`', () => {
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
  assert.deepEqual([...CODES], ['test_kinds_error', 'evidence_budget_exceeded', 'test_kinds_held', 'test_kinds_repair_open', 'risk_class_unmapped', 'waiver_unauthorized', 'missing_test_kinds', 'unmapped_lifecycle_item']);
  const v = verdict({ point: 'V', held: 1, bound: boundFrom({ tags: ['concurrency'], items: ['X1'] }), reassessed: ['mystery'], untrusted: ['kind:race'] });
  assert.deepEqual(v.codes, ['test_kinds_held', 'risk_class_unmapped', 'waiver_unauthorized', 'missing_test_kinds', 'unmapped_lifecycle_item']);
  assert.equal(v.code, 'test_kinds_held');
  const g = verdict({ point: 'gate', open: 2, bound: boundFrom({ tags: ['concurrency'] }) });
  assert.deepEqual(g.codes, ['test_kinds_repair_open', 'missing_test_kinds']);
});

const OUT_KEYS = ['status', 'code', 'codes', 'required_kinds', 'required_items', 'protected_kinds', 'missing_kinds', 'unmapped_items', 'waived', 'counts'];
const COUNT_KEYS = ['required_kinds', 'required_items', 'added_kinds', 'protected_kinds', 'present_kinds', 'present_items', 'missing_kinds', 'unmapped_items', 'waived', 'waiver_protected', 'waiver_not_required', 'waiver_evidenced', 'waiver_untrusted', 'unknown_markers', 'reassessed_classes'];
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
  const deepKinds = { race: ['tag:concurrency'] }; let cur = deepKinds.race; for (let i = 0; i < 1000; i++) { const next = []; cur.push(next); cur = next; }
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
    'array with an extra key': { ...base, evidence: { ...base.evidence, kinds: Object.assign(['race'], { x: 1 }) } },
    'work budget': { ...base, bound: { ...base.bound, kinds: Object.fromEntries(Object.keys(KINDS).map((k) => [k, Array.from({ length: 450 }, () => 'tag:concurrency')])) } },
    'missing key': { bound: base.bound, evidence: base.evidence, waivers: base.waivers, state: base.state, reassessed: [] },
    'array as object': { ...base, evidence: [] },
    'string object': { ...base, evidence: { ...base.evidence, kinds: [Object('race')] } },
    'oversized id': { ...base, evidence: { ...base.evidence, kinds: ['r'.repeat(1 << 20)] } },
    'unknown kind in bound': { ...base, bound: { ...base.bound, kinds: { racing: ['tag:concurrency'] } } },
    'bad source': { ...base, bound: { ...base.bound, kinds: { race: ['concurrency'] } } },
    'empty source list': { ...base, bound: { ...base.bound, kinds: { race: [] } } },
    'bad class': { ...base, reassessed: ['Bad Class'] },
    'negative count': { ...base, evidence: { ...base.evidence, unknown_markers: -1 } },
    'fractional count': { ...base, state: { ...base.state, held: 0.5 } },
    'NaN count': { ...base, state: { ...base.state, open_repairs: NaN } },
    'boolean as string': { ...base, state: { ...base.state, retry_authorised: 'yes' } },
    'declaration proxy': { ...base, declaration: P({}) },
    'declaration array': { ...base, declaration: [] },
    'deps proxy': null,
  };
  const CAPS = new Set(['huge array', 'wide kinds map', 'work budget']); // row 16: a cap, not a malformed value
  for (const [name, inp] of Object.entries(cases)) {
    let v;
    assert.doesNotThrow(() => { v = name === 'deps proxy' ? testKindsVerdict(input(), P(DEPS)) : testKindsVerdict(inp, DEPS); }, name);
    (CAPS.has(name) ? BUDGET_ONLY : ERROR_ONLY)(v, name);
  }
  assert.equal(touched, 0, 'no proxy trap and no getter ever ran');
  // a shared (DAG) reference is fine when it is valid data: the same array object used twice
  const shared = ['tag:concurrency'];
  assert.equal(verdict({ bound: { tags: [], items: [], kinds: { race: shared, negative: shared }, protected: [] }, kinds: ['race', 'negative'] }).status, 'pass');
  // the caps are exactly at their limits: maxItems elements pass, one more refuses
  const many = Array.from({ length: LIMITS.maxItems }, () => 'race');
  assert.equal(verdict({ bound: boundFrom({ tags: ['concurrency'] }), kinds: many }).status, 'pass');
  BUDGET_ONLY(verdict({ bound: boundFrom({ tags: ['concurrency'] }), kinds: [...many, 'race'] }));
  // the work budget is charged across lists: each list within maxItems, the total over maxWork, refuses (the case above);
  // one full list stays within it
  assert.ok(Object.keys(KINDS).length * 451 > LIMITS.maxWork && LIMITS.maxItems < LIMITS.maxWork / 2, 'the budget case really exceeds only the total');
  assert.equal(verdict({ bound: { tags: [], items: [], kinds: { race: Array.from({ length: LIMITS.maxItems }, () => 'tag:concurrency') }, protected: [] }, kinds: ['race'] }).status, 'pass');
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
/** A bound record whose class provenance comes from the REAL kindsForClasses (tags via requiredFor, one call per tag). */
function realBound(tags, classes, declaration = null, items = []) {
  const kinds = {};
  for (const t of tags) { const rt = req([t], [], declaration); assert.equal(rt.status, 'required'); for (const k of rt.kinds) kinds[k] = uniq([...(kinds[k] ?? []), `tag:${t}`]); }
  const fromClasses = kindsForClasses({ classes, declaration });
  assert.equal(fromClasses.ok, true, JSON.stringify(fromClasses.errors));
  for (const [k, s] of Object.entries(fromClasses.provenance)) kinds[k] = uniq([...(kinds[k] ?? []), ...s]);
  return { tags: uniq(tags), items, kinds, protected: [] };
}
const REAL = { kindsForClasses, protectedTags: PROTECTED_TAGS };

test('[R12] integration (REAL kindsForClasses and PROTECTED_TAGS from test-kinds.mjs): the verdict agrees with main\'s requiredFor and checkTitles (same requirement code path)', () => {
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
    assert.deepEqual(Object.keys(bound.kinds).sort(), full.kinds, 'the real class mapping reproduces requiredFor\'s kinds');
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

test('[R14] seam with P3: P2 reads the REAL kindsForClasses result shape; any change of that shape fails closed', () => {
  // the real producer's exact shape (a change here is the signal that P2's reading must change with it)
  const real = kindsForClasses({ classes: ['auth'], declaration: null });
  assert.deepEqual(Object.keys(real).sort(), ['errors', 'kinds', 'ok', 'provenance', 'tags']);
  assert.equal(real.ok, true);
  assert.deepEqual(Object.keys(real.provenance).sort(), [...real.kinds].sort());
  assert.ok(Object.values(real.provenance).every((srcs) => srcs.some((x) => x.startsWith('tag:')) && srcs.some((x) => x === 'class:auth')), 'class sources carry the class and a tag');
  const refused = kindsForClasses({ classes: ['mystery'], declaration: null });
  assert.deepEqual([refused.ok, refused.errors, refused.kinds, refused.tags, Object.keys(refused.provenance)], [false, ['risk_class_unmapped'], [], [], []]);
  // the three outcomes the review named, through the real function, with otherwise empty valid inputs
  const none = testKindsVerdict(input({ bound: boundFrom() }), REAL);
  assert.equal(none.status, 'pass', 'classes [] -> pass');
  assert.equal(none.code, null);
  const auth = testKindsVerdict(input({ bound: boundFrom(), reassessed: ['auth'] }), REAL);
  assert.equal(auth.code, 'missing_test_kinds', 'classes [auth] -> missing_test_kinds');
  assert.deepEqual(auth.required_kinds, ['negative', 'ownership']);
  assert.deepEqual(auth.protected_kinds, ['negative', 'ownership'], 'auth is a protected tag, read from the real provenance');
  const mystery = testKindsVerdict(input({ bound: boundFrom(), reassessed: ['mystery'] }), REAL);
  assert.deepEqual(mystery.codes, ['risk_class_unmapped'], 'classes [mystery] -> risk_class_unmapped');
  // a shape change in P3 refuses test_kinds_error, never a pass and never an accidental unmapped
  const wrap = (f) => ({ ...REAL, kindsForClasses: (a) => f(kindsForClasses(a)) });
  const shapes = {
    'provenance dropped': (r) => { const { provenance: _p, ...rest } = r; return rest; },
    'provenance renamed': (r) => { const { provenance, ...rest } = r; return { ...rest, sources: provenance }; },
    'extra key': (r) => ({ ...r, note: 1 }),
    'kinds as the map (the old documented shape)': (r) => ({ ok: r.ok, kinds: r.provenance }),
    'errors dropped': (r) => { const { errors: _e, ...rest } = r; return rest; },
    'old positional shape': () => ({ ok: false, code: 'risk_class_unmapped' }),
  };
  for (const [name, f] of Object.entries(shapes)) ERROR_ONLY(testKindsVerdict(input({ bound: boundFrom(), reassessed: ['auth'] }), wrap(f)), name);
  // the function receives one object, so a P2 still calling (classes, declaration) would pass an array and get risk_floor_invalid
  const seen = [];
  testKindsVerdict(input({ bound: boundFrom(), reassessed: ['auth'] }), { ...REAL, kindsForClasses: (...a) => (seen.push(a), kindsForClasses(...a)) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 1);
});

test('[R15] row 16: a cap breach is evidence_budget_exceeded, and an oversized own-key set is refused before any property is visited', () => {
  const wide = (n) => { const o = {}; for (let i = 0; i < n; i++) o[`k${i}`] = 1; return o; };
  const base = input();
  let calls = 0;
  const deps = { ...DEPS, kindsForClasses: (a) => { calls++; return stubKfc(a); } };
  const origGet = Reflect.getOwnPropertyDescriptor;
  let visits = 0;
  Reflect.getOwnPropertyDescriptor = (...a) => { visits++; return origGet(...a); };
  const N = 250000;
  const cases = {
    'root record with 250,000 own properties': { ...base, ...wide(N) },
    'bound.kinds with 250,000 own properties': { ...base, bound: { ...base.bound, kinds: wide(N) } },
    'empty evidence array with 250,000 extra own properties': { ...base, evidence: { ...base.evidence, kinds: Object.assign([], wide(N)) } },
  };
  const out = {};
  try {
    for (const [name, inp] of Object.entries(cases)) { visits = 0; out[name] = { v: testKindsVerdict(inp, deps), visits }; }
  } finally { Reflect.getOwnPropertyDescriptor = origGet; }
  for (const [name, { v, visits: n }] of Object.entries(out)) {
    BUDGET_ONLY(v, name);
    assert.ok(n <= LIMITS.maxKeys, `${name}: ${n} property reads (the counted-visit budget is ${LIMITS.maxKeys}, not ${N})`);
  }
  assert.equal(calls, 0, 'refused before the class mapping ran');
  assert.ok(out['root record with 250,000 own properties'].visits === 0, 'the root record is refused before any descriptor read');
  // the total work cap is a budget breach too, and so are the per-list and per-map caps
  BUDGET_ONLY(verdict({ kinds: Array.from({ length: LIMITS.maxItems + 1 }, () => 'race') }));
  // a record over maxKeys (but well under the work budget) is a cap breach too, not a shape error; one at the shape size is an error
  BUDGET_ONLY(testKindsVerdict({ ...base, ...wide(LIMITS.maxKeys) }, DEPS), 'a root record with more than maxKeys own properties');
  assert.equal(testKindsVerdict({ ...base, bound: { ...base.bound, kinds: wide(LIMITS.maxKeys + 1) } }, DEPS).code, 'evidence_budget_exceeded');
  // a malformed value that is not a cap breach stays test_kinds_error
  ERROR_ONLY(verdict({ kinds: ['Not A Kind!'] }));
  ERROR_ONLY(testKindsVerdict({ ...base, extra: 1 }, DEPS));
});

test('[R16] unknown_markers: the validated operand plus the unknown-kind count is itself validated', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  ERROR_ONLY(verdict({ unknown: MAX, kinds: ['mystery-kind'] }), 'MAX_SAFE_INTEGER + 1 is 2^53, not a safe integer');
  ERROR_ONLY(verdict({ unknown: MAX - 1, kinds: ['mystery-kind', 'other-mystery', 'race'] }));
  const edge = verdict({ unknown: MAX - 1, kinds: ['mystery-kind'] });
  assert.equal(edge.status, 'pass');
  assert.equal(edge.counts.unknown_markers, MAX, 'the largest safe sum is accepted exactly');
  assert.equal(verdict({ unknown: MAX }).counts.unknown_markers, MAX);
});

test('[R17] row 30: a trusted waiver on an evidenced subject is counted waiver_evidenced; an untrusted waiver is refused unless an effective trusted waiver covers THAT subject', () => {
  const bound = boundFrom({ tags: ['concurrency', 'entrypoint'], items: ['ItemA'] });
  const present = ['race', 'real-entrypoint'];
  const ev = verdict({ bound, kinds: present, items: ['ItemA'], trusted: ['kind:race', 'plan:ItemA'] });
  assert.equal(ev.status, 'pass');
  assert.equal(ev.counts.waiver_evidenced, 2, 'both waived subjects already have counting evidence');
  assert.deepEqual(ev.waived, [], 'an evidenced subject is not "waived": nothing was removed');
  const miss = verdict({ bound, kinds: ['real-entrypoint'], items: [], trusted: ['kind:race', 'plan:ItemA'] });
  assert.equal(miss.counts.waiver_evidenced, 0);
  assert.deepEqual(miss.waived, ['kind:race', 'plan:ItemA']);
  const mixed = verdict({ bound, kinds: ['race'], items: ['ItemA'], trusted: ['kind:race', 'kind:real-entrypoint'] });
  assert.equal(mixed.counts.waiver_evidenced, 1);
  assert.equal(mixed.counts.waived, 1);
  const prot = verdict({ bound: boundFrom({ tags: ['money'] }), kinds: ['negative'], trusted: ['kind:negative'] });
  assert.equal(prot.counts.waiver_evidenced, 0, 'a protected subject is waiver_protected, not waiver_evidenced');
  assert.equal(prot.counts.waiver_protected, 1);
  // `some`, not `every`: ONE uncovered untrusted waiver refuses even when another untrusted waiver is covered (both subjects evidenced)
  const one = verdict({ bound, kinds: present, items: ['ItemA'], trusted: ['kind:race'], untrusted: ['kind:race', 'kind:real-entrypoint'] });
  assert.equal(one.code, 'waiver_unauthorized');
  assert.equal(one.counts.waiver_untrusted, 2);
  const all = verdict({ bound, kinds: present, items: ['ItemA'], trusted: ['kind:race', 'kind:real-entrypoint'], untrusted: ['kind:race', 'kind:real-entrypoint'] });
  assert.equal(all.status, 'pass', 'every untrusted waiver covered by an effective trusted waiver: no refusal');
});

test('[R18] the ids-only guards: a non-id string in bound.protected is refused whole; a function-Proxy kindsForClasses is refused before any trap runs', () => {
  const SECRET = 'SECRET-<script>';
  for (const bad of ['not-a-kind', SECRET, 'Race', '']) {
    const v = verdict({ bound: { tags: [], items: [], kinds: { race: ['tag:concurrency'] }, protected: [bad] }, kinds: ['race'] });
    ERROR_ONLY(v, `protected: ${JSON.stringify(bad)}`);
    assert.ok(!JSON.stringify(v).includes('SECRET'));
  }
  assert.equal(verdict({ bound: { tags: [], items: [], kinds: { race: ['tag:concurrency'] }, protected: ['race'] }, kinds: ['race'] }).status, 'pass', 'a real kind id is accepted');
  let touched = 0;
  const fnProxy = new Proxy(stubKfc, { apply: (t, th, args) => { touched++; return Reflect.apply(t, th, args); }, get: (t, k, r) => { touched++; return Reflect.get(t, k, r); } });
  assert.equal(typeof fnProxy, 'function');
  ERROR_ONLY(verdict({}, { ...DEPS, kindsForClasses: fnProxy }));
  assert.equal(touched, 0, 'no trap ran');
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
const MUTANTS = [
  { name: 'a security surface does not protect', from: "if (s.startsWith('surface:') || (s.startsWith", to: 'if ((s.startsWith' },
  { name: 'a protected tag does not protect', from: "(s.startsWith('tag:') && protectedTags.has(s.slice(4)))", to: 'false' },
  { name: 'the bound protection is dropped (not add-only)', from: 'const prot = new Set(boundProtected);', to: 'const prot = new Set();' },
  { name: 'bound class sources are not re-mapped (protection not recomputed for them)', from: "for (const srcs of boundKinds.values()) for (const s of srcs) if (s.startsWith('class:')) classes.add(s.slice(6));", to: '' },
  { name: 'reassessed kinds are not required', from: 'for (const m of [boundKinds, mapped.kinds])', to: 'for (const m of [boundKinds])' },
  { name: 'a protected subject is waivable', from: "else if (w.startsWith('kind:') && prot.has(name)) waiverProtected++;", to: '' },
  { name: 'a waiver of a subject that is not required counts as effective', from: "if (w.startsWith('kind:') ? !effective.has(name) : !items.has(name)) waiverNotRequired++;", to: 'if (false) waiverNotRequired++;' },
  { name: 'a trusted waiver removes nothing', from: 'const missing = missing0.filter((k) => !effectiveWaivers.has(`kind:${k}`));', to: 'const missing = missing0;' },
  { name: 'an item waiver removes nothing', from: 'const unmapped = unmapped0.filter((i) => !effectiveWaivers.has(`plan:${i}`));', to: 'const unmapped = unmapped0;' },
  { name: 'an untrusted waiver is ignored', from: "if (unauthorized) raised.add('waiver_unauthorized');", to: '' },
  { name: 'any trusted waiver, even ineffective, suppresses an untrusted one', from: 'untrusted.some((w) => !effectiveWaivers.has(w))', to: 'untrusted.some((w) => !trusted.includes(w))' },
  { name: 'an authorised RETRY does not lift the held check at F1', from: "!(S.point === 'F1' && S.retry_authorised)", to: 'true' },
  { name: 'the held check is not derived in the view', from: "new Set(['F1', 'F4', 'S1', 'V'])", to: "new Set(['F1', 'F4', 'S1'])" },
  { name: 'an open repair refuses at every point', from: "open > 0 && S.point === 'gate'", to: 'open > 0' },
  { name: 'an unmapped class is ignored', from: "if (mapped.unmapped) raised.add('risk_class_unmapped');", to: '' },
  { name: 'a missing item does not refuse', from: "if (unmapped.length) raised.add('unmapped_lifecycle_item');", to: '' },
  { name: 'a missing kind does not refuse', from: "if (missing.length) raised.add('missing_test_kinds');", to: '' },
  { name: 'any failure code from kindsForClasses reads as unmapped', from: "errors.length === 1 && errors[0] === 'risk_class_unmapped'", to: 'true' },
  { name: 'an object proxy is read', from: "if (v === null || typeof v !== 'object' || types.isProxy(v)) return false;", to: "if (v === null || typeof v !== 'object') return false;" },
  { name: 'an array proxy is read', from: '!Array.isArray(v) || types.isProxy(v) ||', to: '!Array.isArray(v) ||' },
  { name: 'a getter is invoked', from: "    if (!d || !('value' in d)) fail();\n    out[k] = d.value;", to: '    out[k] = v[k];' },
  { name: 'the array length cap is dropped', from: 'if (n > LIMITS.maxItems) over();', to: '' },
  { name: 'extra array keys are accepted', from: 'if (keyCount !== n + 1) fail();', to: '' },
  { name: 'the work budget is not enforced', from: 'if (ctx.work > LIMITS.maxWork) over();', to: '' },
  { name: 'an empty source list is accepted', from: 'if (!sources.length) fail();', to: '' },
  { name: 'any string is a source', from: 'const sources = list(d.value, isSource, ctx);', to: "const sources = list(d.value, (x) => typeof x === 'string', ctx);" },
  { name: 'evidence may name any string', from: 'new Set(list(E.kinds, isMarkerName, ctx))', to: "new Set(list(E.kinds, (x) => typeof x === 'string', ctx))" },
  { name: 'an unknown evidence kind counts as present', from: 'new Set([...evidenceKinds].filter(isKind))', to: 'new Set(evidenceKinds)' },
  { name: 'an unknown evidence kind is not counted', from: ' + (evidenceKinds.size - presentKinds.size)', to: '' },
  { name: 'a class-reached kind without a tag source is accepted', from: "for (const srcs of kinds.values()) if (![...srcs].some((s) => s.startsWith('tag:'))) fail();", to: '' },
  { name: 'an empty protected set is accepted', from: 'if (!protectedTags.size) fail();', to: '' },
  { name: 'an exception escapes', from: "try { return compute(input, deps); } catch (e) { return e === BUDGET ? errorVerdict('evidence_budget_exceeded') : errorVerdict(); }", to: 'return compute(input, deps);' },
  { name: 'a protected kind id may be any string', from: 'const boundProtected = list(B.protected, isKindId, ctx);', to: "const boundProtected = list(B.protected, (x) => typeof x === 'string', ctx);" },
  { name: 'a function Proxy kindsForClasses is called', from: "typeof D.kindsForClasses !== 'function' || types.isProxy(D.kindsForClasses)", to: "typeof D.kindsForClasses !== 'function'" },
  { name: 'ONE covered untrusted waiver excuses them all (some -> every)', from: 'untrusted.some((w) => !effectiveWaivers.has(w))', to: 'untrusted.length > 0 && untrusted.every((w) => !effectiveWaivers.has(w))' },
  { name: 'the unknown_markers sum is not validated', from: 'uint(uint(E.unknown_markers) +', to: '(uint(E.unknown_markers) +' },
  { name: 'a trusted waiver on an evidenced subject is not counted', from: 'waiverEvidenced++', to: '0' },
  { name: 'a cap breach is reported as test_kinds_error', from: "return e === BUDGET ? errorVerdict('evidence_budget_exceeded') : errorVerdict();", to: 'return errorVerdict();' },
  { name: 'an oversized record is not refused before its keys are read', from: 'if (own.length > LIMITS.maxKeys) over();\n  if (own.length !== keys.length) fail();', to: 'if (own.length !== keys.length) fail();' },
  { name: 'the real kindsForClasses `errors` is not required to be exactly the unmapped code', from: "errors.length === 1 && errors[0] === 'risk_class_unmapped'", to: "errors.includes('risk_class_unmapped')" },
  { name: 'kinds and provenance need not agree', from: 'if (sorted(kindIds).join() !== sorted(kinds.keys()).join()) fail();', to: '' },
];
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
  assert.ok(control.passed >= 18, `the control ran the tagged tests (${control.passed})`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: uniq(r.killers ?? []) }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.length).map((r) => `${r.m.name} (exit ${r.code})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure');
  t.diagnostic(`mutants ${mutants.length}, all killed by assertions`);
});
