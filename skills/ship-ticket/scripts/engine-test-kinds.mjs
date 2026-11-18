/**
 * S-01b2 P2: the test-kind verdict core. PURE and synchronous: requirement x evidence x trusted waivers x reassessed
 * classes -> verdict. No I/O, no clock, no cache: every call recomputes from its inputs (design rev 3, section 1).
 *
 *   testKindsVerdict(input, deps) -> { status, code, codes, required_kinds, required_items, protected_kinds,
 *                                      missing_kinds, unmapped_items, waived, counts }
 *
 * input (every object closed, every array <= LIMITS.maxItems; anything else is `test_kinds_error`):
 *   bound        S.test_kinds.bound: { tags:[tag], items:[item], kinds:{ <kind>: [<source>...] }, protected:[kind] }
 *                A source is a provenance path element: `tag:<t>`, `class:<c>` or `surface:<boundary kind>`.
 *   declaration  the validated base declaration or null; passed unread to kindsForClasses.
 *   reassessed   [class]: the classes of risk-floor `reassess` on this candidate.
 *   evidence     { kinds:[kind], items:[item], unknown_markers:uint }: ids counted by the scanner (P1/P4), never titles.
 *                A grammar-valid kind id naming no kind is counted into unknown_markers (row 31), never present.
 *   waivers      { trusted:[subject], untrusted:[subject] }: `kind:<id>` / `plan:<id>` of waivers ALREADY matched to this
 *                run, plan digest and candidate and classified by trust (P6 owns matching and trust).
 *   state        { point: POINTS, retry_authorised:bool, held:uint, open_repairs:uint } supplied by the caller (P5a/P5b).
 * deps (injected; P3 owns both in test-kinds.mjs):
 *   kindsForClasses(classes, declaration) -> { ok:true, kinds:{ <kind>: [<source>...] } } | { ok:false, code:'risk_class_unmapped' }
 *                The sources of a kind reached through a class carry BOTH `class:<c>` and every `tag:<t>` on the path,
 *                so protection through a class mapping is visible; a kind with no `tag:` source is test_kinds_error.
 *                Called once per verdict, synchronously, with the
 *                sorted union of the bound `class:` sources and the reassessed classes.
 *   protectedTags [tag], non-empty (design: money, tenancy, auth).
 *
 * Rules:
 * - Required kinds = bound kinds UNION kindsForClasses kinds (add-only, INV-R). Required items = bound items.
 * - Protection is recomputed on every call BEFORE waivers: a kind is protected when it is in bound.protected, or any of
 *   its effective sources is `surface:*` or `tag:<protected tag>`. Items have no sources and are never protected.
 * - A trusted waiver is EFFECTIVE when its subject is required and not protected; it removes exactly that subject.
 *   A protected subject is counted `waiver_protected`, a subject not required (an unknown kind included) `waiver_not_required`.
 * - Untrusted waivers (interim rule pending design rev 4, Codex finding 8 on rows 21/32): an untrusted subject refuses
 *   `waiver_unauthorized` unless an effective trusted waiver covers the same subject (the security waiverState precedent).
 * - Row 22: a held repair refuses `test_kinds_held` at F1 (unless a RETRY is authorised), F4, S1 and V.
 *   Row 22a: an open test_kinds repair refuses `test_kinds_repair_open` at `gate` only.
 * - `codes` lists every refusal in CODES order; `code` is the first; `status` is 'pass' only when there is none.
 *
 * Hostile input (L3, L6): proxies are refused before any trap can run (util.types.isProxy); only own DATA descriptors
 * are read, so no getter runs; arrays are bounded by their `length` descriptor before any element is read; all work
 * is charged to one budget. Nothing throws: any failure is the empty `test_kinds_error` verdict. Outputs carry only
 * closed enums, ids validated against the kind table and the id grammars, and counts (never input text).
 */
import { types } from 'node:util';
import { KINDS, ITEM_ID, NAME } from './test-kinds.mjs';
import { CLASS_NAME } from './risk-floor.mjs';

/** Refusal codes in precedence order. */
export const CODES = Object.freeze(['test_kinds_error', 'test_kinds_held', 'test_kinds_repair_open', 'risk_class_unmapped', 'waiver_unauthorized', 'missing_test_kinds', 'unmapped_lifecycle_item']);
/** The verdict call sites (design section 1): freeze points F1-F4, ship-ready S1/S2, the advisory view V, and `gate test-kinds`. */
export const POINTS = Object.freeze(['F1', 'F2', 'F3', 'F4', 'S1', 'S2', 'V', 'gate']);
export const LIMITS = Object.freeze({ maxItems: 512, maxKeys: 64, maxIdLength: 80, maxWork: 4096 });
const HELD_POINTS = new Set(['F1', 'F4', 'S1', 'V']);
const COUNT_KEYS = ['required_kinds', 'required_items', 'added_kinds', 'protected_kinds', 'present_kinds', 'present_items', 'missing_kinds', 'unmapped_items', 'waived', 'waiver_protected', 'waiver_not_required', 'waiver_untrusted', 'unknown_markers', 'reassessed_classes'];

const FAIL = Symbol('test_kinds_error');
const fail = () => { throw FAIL; };
const charge = (ctx, n = 1) => { ctx.work += n; if (ctx.work > LIMITS.maxWork) fail(); };
const isKind = (s) => Object.hasOwn(KINDS, s);
const id = (re) => (v) => typeof v === 'string' && v.length <= LIMITS.maxIdLength && re.test(v);
const isTag = id(NAME), isItem = id(ITEM_ID), isClass = id(CLASS_NAME);
const isKindId = (v) => typeof v === 'string' && v.length <= LIMITS.maxIdLength && isKind(v);
const isMarkerName = id(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/); // the `[kind:<name>]` marker grammar (test-kinds.mjs markers)
function isSource(v) {
  if (typeof v !== 'string' || v.length > LIMITS.maxIdLength) return false;
  const i = v.indexOf(':'), kind = v.slice(0, i), name = v.slice(i + 1);
  return i > 0 && (kind === 'class' ? isClass(name) : (kind === 'tag' || kind === 'surface') && isTag(name));
}
function isSubject(v) {
  if (typeof v !== 'string' || v.length > LIMITS.maxIdLength) return false;
  if (v.startsWith('kind:')) return isMarkerName(v.slice(5)); // an unknown kind is grammar-valid: it is not required (row 32)
  return v.startsWith('plan:') && isItem(v.slice(5));
}

/** A non-proxy object whose prototype is Object.prototype or null (checked without running any trap). */
function plainObject(v) {
  if (v === null || typeof v !== 'object' || types.isProxy(v)) return false;
  const proto = Reflect.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
/** A plain, non-proxy object with exactly `keys` as own data properties; returns their values. */
function record(v, keys, ctx) {
  if (!plainObject(v)) fail();
  const own = Reflect.ownKeys(v);
  charge(ctx, own.length);
  if (own.length !== keys.length) fail();
  const out = {};
  for (const k of keys) {
    const d = Reflect.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) fail();
    out[k] = d.value;
  }
  return out;
}
/** A plain, non-proxy, dense array of at most LIMITS.maxItems elements accepted by `ok`; returns a new array. */
function list(v, ok, ctx) {
  if (!Array.isArray(v) || types.isProxy(v) || Reflect.getPrototypeOf(v) !== Array.prototype) fail();
  const ld = Reflect.getOwnPropertyDescriptor(v, 'length');
  const n = ld && ld.value;
  if (!Number.isSafeInteger(n) || n < 0 || n > LIMITS.maxItems) fail();
  charge(ctx, n + 1);
  if (Reflect.ownKeys(v).length !== n + 1) fail(); // holes, extra or symbol keys
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = Reflect.getOwnPropertyDescriptor(v, String(i));
    if (!d || !('value' in d) || !ok(d.value)) fail();
    out.push(d.value);
  }
  return out;
}
/** `{ <kind>: [<source>...] }` with known kinds and non-empty source lists, as a Map of Sets. */
function kindMap(v, ctx) {
  if (!plainObject(v)) fail();
  const own = Reflect.ownKeys(v);
  charge(ctx, own.length);
  if (own.length > LIMITS.maxKeys) fail();
  const out = new Map();
  for (const k of own) {
    if (!isKindId(k)) fail();
    const d = Reflect.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) fail();
    const sources = list(d.value, isSource, ctx);
    if (!sources.length) fail();
    out.set(k, new Set(sources));
  }
  return out;
}
const uint = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : fail());
const sorted = (xs) => [...new Set(xs)].sort();

function emptyCounts() { const c = {}; for (const k of COUNT_KEYS) c[k] = 0; return c; }
function errorVerdict() {
  return { status: 'refused', code: 'test_kinds_error', codes: ['test_kinds_error'], required_kinds: [], required_items: [], protected_kinds: [], missing_kinds: [], unmapped_items: [], waived: [], counts: emptyCounts() };
}

/** The class mapping through the injected function; its result is read as hostile data. */
function classKinds(kfc, classes, declaration, ctx) {
  const res = kfc(classes, declaration);
  if (!plainObject(res)) fail();
  const d = Reflect.getOwnPropertyDescriptor(res, 'ok');
  if (!d || !('value' in d)) fail();
  if (d.value === true) {
    const kinds = kindMap(record(res, ['ok', 'kinds'], ctx).kinds, ctx);
    // a kind reached through a class must name the tag(s) on its path, or protection through the class is invisible (fail closed)
    for (const srcs of kinds.values()) if (![...srcs].some((s) => s.startsWith('tag:'))) fail();
    return { unmapped: false, kinds };
  }
  if (d.value === false && record(res, ['ok', 'code'], ctx).code === 'risk_class_unmapped') return { unmapped: true, kinds: new Map() };
  return fail();
}

function compute(input, deps) {
  const ctx = { work: 0 };
  const I = record(input, ['bound', 'declaration', 'reassessed', 'evidence', 'waivers', 'state'], ctx);
  const D = record(deps, ['kindsForClasses', 'protectedTags'], ctx);
  if (typeof D.kindsForClasses !== 'function' || types.isProxy(D.kindsForClasses)) fail();
  const protectedTags = new Set(list(D.protectedTags, isTag, ctx));
  if (!protectedTags.size) fail();

  const B = record(I.bound, ['tags', 'items', 'kinds', 'protected'], ctx);
  list(B.tags, isTag, ctx);
  const items = new Set(list(B.items, isItem, ctx));
  const boundKinds = kindMap(B.kinds, ctx);
  const boundProtected = list(B.protected, isKindId, ctx);
  if (I.declaration !== null && !plainObject(I.declaration)) fail(); // passed through to kindsForClasses, never read here
  const reassessed = sorted(list(I.reassessed, isClass, ctx));
  const E = record(I.evidence, ['kinds', 'items', 'unknown_markers'], ctx);
  const evidenceKinds = new Set(list(E.kinds, isMarkerName, ctx)), presentItems = new Set(list(E.items, isItem, ctx));
  const presentKinds = new Set([...evidenceKinds].filter(isKind));
  // row 31: a well-formed kind id naming no kind counts as nothing and is reported as a count
  const unknownMarkers = uint(E.unknown_markers) + (evidenceKinds.size - presentKinds.size);
  const W = record(I.waivers, ['trusted', 'untrusted'], ctx);
  const trusted = sorted(list(W.trusted, isSubject, ctx)), untrusted = sorted(list(W.untrusted, isSubject, ctx));
  const S = record(I.state, ['point', 'retry_authorised', 'held', 'open_repairs'], ctx);
  if (!POINTS.includes(S.point) || typeof S.retry_authorised !== 'boolean') fail();
  const held = uint(S.held), open = uint(S.open_repairs);

  // effective provenance: bound UNION the class mapping of every bound and reassessed class (add-only)
  const classes = new Set(reassessed);
  for (const srcs of boundKinds.values()) for (const s of srcs) if (s.startsWith('class:')) classes.add(s.slice(6));
  const mapped = classKinds(D.kindsForClasses, sorted(classes), I.declaration, ctx);
  const effective = new Map();
  for (const m of [boundKinds, mapped.kinds]) for (const [k, srcs] of m) effective.set(k, new Set([...(effective.get(k) ?? []), ...srcs]));

  // protection, recomputed BEFORE waivers
  const prot = new Set(boundProtected);
  for (const [k, srcs] of effective) for (const s of srcs) if (s.startsWith('surface:') || (s.startsWith('tag:') && protectedTags.has(s.slice(4)))) prot.add(k);

  const required = sorted(effective.keys());
  const requiredItems = sorted(items);
  const missing0 = required.filter((k) => !presentKinds.has(k)), unmapped0 = requiredItems.filter((i) => !presentItems.has(i));
  const effectiveWaivers = new Set();
  let waiverProtected = 0, waiverNotRequired = 0;
  for (const w of trusted) {
    const name = w.slice(5);
    if (w.startsWith('kind:') ? !effective.has(name) : !items.has(name)) waiverNotRequired++;
    else if (w.startsWith('kind:') && prot.has(name)) waiverProtected++;
    else effectiveWaivers.add(w);
  }
  const missing = missing0.filter((k) => !effectiveWaivers.has(`kind:${k}`));
  const unmapped = unmapped0.filter((i) => !effectiveWaivers.has(`plan:${i}`));
  const waived = sorted([...missing0.map((k) => `kind:${k}`), ...unmapped0.map((i) => `plan:${i}`)].filter((s) => effectiveWaivers.has(s)));
  const unauthorized = untrusted.some((w) => !effectiveWaivers.has(w));

  const raised = new Set();
  if (held > 0 && HELD_POINTS.has(S.point) && !(S.point === 'F1' && S.retry_authorised)) raised.add('test_kinds_held');
  if (open > 0 && S.point === 'gate') raised.add('test_kinds_repair_open');
  if (mapped.unmapped) raised.add('risk_class_unmapped');
  if (unauthorized) raised.add('waiver_unauthorized');
  if (missing.length) raised.add('missing_test_kinds');
  if (unmapped.length) raised.add('unmapped_lifecycle_item');
  const codes = CODES.filter((c) => raised.has(c));

  const counts = emptyCounts();
  Object.assign(counts, {
    required_kinds: required.length, required_items: requiredItems.length, added_kinds: required.filter((k) => !boundKinds.has(k)).length,
    protected_kinds: prot.size, present_kinds: required.length - missing0.length, present_items: requiredItems.length - unmapped0.length,
    missing_kinds: missing.length, unmapped_items: unmapped.length, waived: waived.length, waiver_protected: waiverProtected,
    waiver_not_required: waiverNotRequired, waiver_untrusted: untrusted.length, unknown_markers: unknownMarkers, reassessed_classes: reassessed.length,
  });
  return { status: codes.length ? 'refused' : 'pass', code: codes[0] ?? null, codes, required_kinds: required, required_items: requiredItems,
    protected_kinds: sorted(prot), missing_kinds: missing, unmapped_items: unmapped, waived, counts };
}

/** Never throws; see the header. */
export function testKindsVerdict(input, deps) {
  try { return compute(input, deps); } catch { return errorVerdict(); }
}
