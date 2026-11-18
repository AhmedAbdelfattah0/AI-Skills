/**
 * S-01b2 P4r: the bottom layer of the runner-evidence modules (design rev 6 sections 1 and 4): PURE primitives with no I/O
 * (owner amendment 2026-11-18): the named limits, the typed refusal, the hostile-input readers, the ONE path identity, the
 * marker counter and the strict report scan. It imports nothing from its siblings.
 * `engine-test-kinds-io.mjs` holds the shared rules (identity, R-3, the declared entry, the current context, the record schema)
 * and builds records; `engine-test-kinds-reuse.mjs` reuses them and gives the verdict. The header of the io module states the claim.
 *
 * REFUSE, NEVER DROP (I-C): an input over any cap here (bytes, depth, scan tokens, results, title length) is a typed refusal of
 * the whole report. Nothing is skipped to stay under a cap, because a skipped non-passing result is a subtraction R-3 then misses.
 */
import { types } from 'node:util';
import { compileGlob, matchSegments } from './risk-floor.mjs';
import { ITEM_ID, KINDS } from './test-kinds.mjs';

export const LIMITS = Object.freeze({ maxReportBytes: 32 * 1024 * 1024, maxResults: 100_000, maxPaths: 20_000, maxIdentityBytes: 256 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024, maxConfigBytes: 64 * 1024 * 1024, maxMarkerFiles: 2_000, maxScanTokens: 8_000_000, maxDepth: 64, maxList: 64, maxPathChars: 512,
  maxTitleChars: 2048, maxIds: 512 });
export const REFUSALS = Object.freeze(['runner_unsupported', 'runner_config_changed', 'runner_output_tampered', 'runner_survivor', 'evidence_run_failed', 'evidence_unavailable', 'candidate_moved', 'quiescence_unknown', 'evidence_budget_exceeded', 'test_kinds_error']);
export const FILE_VOIDS = Object.freeze(['runner_uncovered', 'result_outside_repo', 'not_in_P', 'not_regular', 'not_test_file', 'file_too_large']);
/** A marker id as the bytes spell it, and a CREDITABLE id (a known kind or a lifecycle item id). */
export const MARKER_ID = /^(?:kind|plan):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const creditable = (m) => typeof m === 'string' && (m.startsWith('kind:') ? Object.hasOwn(KINDS, m.slice(5)) : m.startsWith('plan:') && ITEM_ID.test(m.slice(5)));

/** A typed refusal: a code from REFUSALS and, where one cause is worth naming, a `detail` (e.g. `submodule_unsupported_v0`). */
export class Refusal extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
export const refuse = (code, detail) => { throw new Refusal(code, detail); };
export const codeOf = (e, dflt) => (e instanceof Refusal ? e.code : dflt);
/** `{ code, detail? }` of a caught error: what every exported interface returns for a refusal. */
export const refusalOf = (e, dflt) => ({ code: codeOf(e, dflt), ...(e instanceof Refusal && e.detail ? { detail: e.detail } : {}) });
export const charge = (ctx, n = 1) => { ctx.work += n; if (ctx.work > ctx.max) refuse('evidence_budget_exceeded'); };

// ---- hostile-input readers (L6): own DATA descriptors only, never a trap or a getter ----
export const plain = (v) => v !== null && typeof v === 'object' && !types.isProxy(v) && [Object.prototype, null].includes(Reflect.getPrototypeOf(v));
export function own(o, k) {
  if (!plain(o) && !(Array.isArray(o) && !types.isProxy(o))) refuse('test_kinds_error');
  const d = Reflect.getOwnPropertyDescriptor(o, k);
  if (!d || !('value' in d)) refuse('test_kinds_error');
  return d.value;
}
/** An optional own data property: absent or `undefined` gives `dflt`. */
export const ownOr = (o, k, dflt) => { if (!plain(o)) refuse('test_kinds_error'); const v = Reflect.getOwnPropertyDescriptor(o, k) ? own(o, k) : undefined; return v === undefined ? dflt : v; };
export function arr(v, max, ok, ctx) {
  if (!Array.isArray(v) || types.isProxy(v) || Reflect.getPrototypeOf(v) !== Array.prototype) refuse('test_kinds_error');
  const n = Reflect.getOwnPropertyDescriptor(v, 'length')?.value;
  if (!Number.isSafeInteger(n) || n < 0) refuse('test_kinds_error');
  if (n > max) refuse('evidence_budget_exceeded');
  charge(ctx, n + 1);
  const out = [];
  for (let i = 0; i < n; i++) { const x = own(v, String(i)); if (!ok(x)) refuse('test_kinds_error'); out.push(x); }
  return out;
}
/** The object's own keys when they are exactly `keys` (a plain object, string keys only), else null. */
export function exactKeys(o, keys) {
  if (!plain(o)) return null;
  const ks = Reflect.ownKeys(o);
  return ks.length === keys.length && ks.every((k) => typeof k === 'string' && keys.includes(k)) ? ks : null;
}
export const isStr = (max) => (v) => typeof v === 'string' && v.length <= max;
/** A repo-relative POSIX path: no absolute, drive (`C:/x`, `C:x`), backslash, NUL, empty, `.` or `..` segment. */
export const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length <= LIMITS.maxPathChars && !/[\\\0]|^[A-Za-z]:/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
/**
 * THE path identity (S2): every comparison of a path with a git path goes through `pathIndex`. Two spellings with one key (NFC,
 * then lower case) may name ONE file on a case- or normalisation-insensitive filesystem (macOS, Windows), so a spelling that
 * shares a key with a git path without being it is an ALIAS and is refused, on every platform (a pure string rule, no probing).
 * `pathIndex(paths)` refuses two git paths with one key; it returns `lookup(p, code)`: p when p is a git path, null when no git
 * path shares its key, and for an alias THROWS `code` (detail `path_alias`). `under(p, dir)` is the same rule for a prefix.
 */
export const pathKey = (p) => p.normalize('NFC').toLowerCase();
export function pathIndex(paths) {
  const byKey = new Map();
  for (const p of paths) { const k = pathKey(p); if (byKey.has(k)) refuse('evidence_unavailable', 'path_alias'); byKey.set(k, p); }
  return (p, code = 'evidence_unavailable') => { const q = byKey.get(pathKey(p)); return q === undefined ? null : q === p ? p : refuse(code, 'path_alias'); };
}
export const under = (p, dir) => {
  if (p === dir || p.startsWith(`${dir}/`)) return true;
  const k = pathKey(p), d = pathKey(dir);
  return k === d || k.startsWith(`${d}/`) ? refuse('evidence_unavailable', 'path_alias') : false;
};
const isGlob = (g) => { try { compileGlob(g); return typeof g === 'string' && g.length <= LIMITS.maxPathChars; } catch { return false; } };
export const globList = (v, ctx) => arr(v, LIMITS.maxList, isGlob, ctx);
export const matcher = (globs) => globs.map((g) => compileGlob(g));
export const matches = (compiled, rel, ctx) => {
  charge(ctx);
  try { const segs = rel.split('/'); return compiled.some((g) => matchSegments(g, segs, ctx.glob)); } catch { return refuse('evidence_budget_exceeded'); }
};

// ---- marker counting (R-3): the same grammar as P3 `markers` ----
const MARKER = /\[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g;
/** Occurrences of every `[kind:x]` / `[plan:x]` marker (latin1 view: markers are ASCII, line endings do not matter). */
export function countMarkers(text, out = new Map()) {
  for (const m of text.matchAll(MARKER)) out.set(`${m[1]}:${m[2]}`, (out.get(`${m[1]}:${m[2]}`) ?? 0) + 1);
  return out;
}
export const bufMarkers = (buf) => countMarkers(buf.toString('latin1'));

// ---- the report: a strict JSON shape scan (duplicate keys, depth, work), then the whole-run pre-pass ----
/** Throws a Refusal: evidence_unavailable for malformed/duplicate-key/too-deep JSON, evidence_budget_exceeded past the token cap. */
export function scanJson(text) {
  let i = 0, tokens = 0;
  const n = text.length, bad = () => refuse('evidence_unavailable');
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; } };
  const str = () => { const s = i++; while (i < n) { const c = text.charCodeAt(i); if (c === 34) { i++; return text.slice(s, i); } if (c === 92) i += 2; else if (c < 32) bad(); else i++; } return bad(); };
  const lit = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const val = (d) => {
    if (d > LIMITS.maxDepth) bad();
    if (++tokens > LIMITS.maxScanTokens) refuse('evidence_budget_exceeded');
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']', keys = new Set();
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        ws();
        if (c === '{') {
          if (text[i] !== '"') bad();
          const raw = str();
          let key = raw.slice(1, -1);
          if (key.includes('\\')) { try { key = JSON.parse(raw); } catch { bad(); } }
          if (keys.has(key)) bad(); // a duplicate key: which value wins is a parser accident, never evidence
          keys.add(key); ws();
          if (text[i++] !== ':') bad();
        }
        val(d + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; return; }
        bad();
      }
    } else if (c === '"') str();
    else { lit.lastIndex = i; const m = lit.exec(text); if (!m) bad(); i += m[0].length; }
  };
  val(0); ws();
  if (i !== n) bad();
}
/** The scanned text, parsed. An escape the scan let through and JSON rejects (`"\x"`) is malformed evidence, never an internal error. */
export function parseScanned(text) {
  scanJson(text);
  try { return JSON.parse(text); } catch { return refuse('evidence_unavailable'); }
}
const STATUSES = new Set(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled']); // vitest's StatusMap image plus jest's `disabled`
const field = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The whole-run checks (I8), on the parsed document, BEFORE the parser materialises any result. Throws a Refusal. */
export function preflight(doc, ctx) {
  const unavailable = () => refuse('evidence_unavailable'), failed = () => refuse('evidence_run_failed');
  if (!isObj(doc)) unavailable();
  const success = field(doc, 'success'), suites = field(doc, 'testResults');
  for (const k of ['numFailedTestSuites', 'numFailedTests']) { const v = field(doc, k); if (!Number.isSafeInteger(v) || v < 0) unavailable(); if (v > 0) failed(); }
  if (typeof success !== 'boolean') unavailable();
  if (!success) failed();
  if (!Array.isArray(suites)) unavailable();
  let results = 0;
  for (const s of suites) {
    charge(ctx);
    if (!isObj(s) || typeof field(s, 'name') !== 'string' || !Array.isArray(field(s, 'assertionResults'))) unavailable();
    if (field(s, 'status') === 'failed') failed();
    if (field(s, 'status') !== 'passed') unavailable();
    const cases = field(s, 'assertionResults');
    results += cases.length;
    if (results > LIMITS.maxResults) refuse('evidence_budget_exceeded');
    for (const c of cases) {
      charge(ctx);
      if (!isObj(c) || !STATUSES.has(field(c, 'status')) || typeof field(c, 'title') !== 'string') unavailable();
      if (field(c, 'status') === 'failed') failed();
      if (field(c, 'title').length > LIMITS.maxTitleChars) refuse('evidence_budget_exceeded'); // I-C: refused, whatever the status (C1)
    }
  }
}
