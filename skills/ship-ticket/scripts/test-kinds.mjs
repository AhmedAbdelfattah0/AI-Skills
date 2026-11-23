#!/usr/bin/env node
/**
 * Risk-triggered required test kinds (T1-S trigger table, S-01b). The kinds a builder must deliver are a TABLE LOOKUP, not a
 * model choice: the approved plan's trigger tags, its recorded risk-floor classes (risk-floor.mjs) and its verified security
 * surfaces (security-plan.mjs) select rows of the table below; each row names the required test kinds (a)-(g).
 *
 *   test-kinds.mjs require --repo <dir> --base <commit> --plan <plan.md>
 *   test-kinds.mjs check   --repo <dir> --base <commit> --plan <plan.md> (--titles <json array|file> | --report-file <final message>)
 *
 * Opt-in: nothing is required (`not_declared`, exit 0) unless the plan has a `test-triggers:` line or the repository commits
 * `.ship-ticket/test-triggers.json`, read from the BASE commit only (never the tree under check). Plan lines, all from the plan
 * narrative (RUN-STATE excluded): exactly one `test-triggers: <tag>[, <tag>...]` (or `none`); `lifecycle-item: <id> <text>`;
 * `test-waiver: <kind|item id> <reason>` (a requested owner disposition). A waiver NEVER removes a requirement here: it is only
 * reported in `waiver_requested` (not applied, needs trusted approval). Applying one needs the engine's pinned approval record
 * for the selected run (S-01b2); the plan file cannot carry that authority. The `risk_floor:` record line is TRUSTED advisory input as recorded
 * in the approved plan (its base must equal --base; it is not recomputed here; absent = `risk_floor_missing`). Tag convention for test titles:
 * `[kind:<kind id>]` and `[plan:<item id>]`, exact and case-sensitive; one title may carry several.
 * Fail closed: an unknown tag, an unmapped risk class, an unmapped or unverifiable security surface, a malformed line or
 * declaration is a refusal, never an empty required set. Fail-closed RECOGNITION (MARKERS, one tokeniser for every plan
 * marker): a line carrying a marker's token (after the normalisation documented at MARKERS) that does not parse strictly
 * as that marker is the marker's refusal code, never absence; homoglyphs and misspellings are not caught. A malformed
 * RUN-STATE is `run_state_invalid` in an opted-in plan. Output: one JSON object, enums, ids and numbers only.
 * Exit: 0 required/pass/not_declared, 1 refused/freeze_refused, 2 usage.
 * ADVISORY: no engine step enforces the result yet (freeze integration is S-01b2). Presence of a tagged title is not proof
 * that the test exercises the property (mutation is S-01c), and `check` trusts the titles it is given.
 * REUSE: util.parseArgs (native); risk-floor.mjs parseRecordedLine/decodeStrict; security-plan.mjs parsePlanSecurityBlock;
 * worker-report.mjs parseWorkerReport. The declaration validator follows risk-floor.mjs (lib/shape.mjs is not on this base).
 * S-01b2 (P3, requirement provenance for the engine gate): `optIn` is the opt-in predicate requiredFor calls; requiredFor
 * also returns `provenance` {<kind>: [`tag:<t>` | `class:<c>` | `surface:<s>`...]}, keyed by exactly its `kinds`;
 * `kindsForClasses` maps reassessed classes through requiredFor's own class loop; `PROTECTED_TAGS`; and the declaration key
 * `tests: {globs?, runner_modules?}` (evidence scope only, read from BASE like the rest; it never changes a requirement).
 */
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { realpathSync, readFileSync } from 'node:fs';
import { parseArgs, types } from 'node:util';
import { parseRecordedLine, decodeStrict, compileGlob, CHANGED, CLASS_NAME } from './risk-floor.mjs';
import { parsePlanSecurityBlock } from './security-plan.mjs';
import { parseWorkerReport } from './worker-report.mjs';
import { isEntrypoint } from './harness.mjs';

export { CHANGED };
export const DECLARATION_PATH = '.ship-ticket/test-triggers.json';
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_DECLARATION = 64 * 1024;
const f = (o) => Object.freeze(o);

/** The kinds, keyed by the tag a test title carries. `letter` is the E §1.4 class (a)-(g). */
export const KINDS = f({
  negative: f({ letter: 'a', definition: 'a negative or adversarial test for each new input or authority path (a rejected, ignored or forbidden case)' }),
  race: f({ letter: 'b', definition: 'a concurrency or race scenario: overlapping requests or out-of-order responses' }),
  'stale-N2': f({ letter: 'c', definition: 'stale-result handling with N >= 2 supersessions, not only one' }),
  'error-twin': f({ letter: 'c', definition: 'the error-path twin of every stale-success test: a superseded failure is ignored too' }),
  'lifecycle-destroy': f({ letter: 'd', definition: 'state lifecycle through a real destroy or teardown, not a second init call' }),
  ownership: f({ letter: 'd', definition: 'an ownership boundary: state of one visit, session, user or tenant is never served to another' }),
  'contract-producer': f({ letter: 'e', definition: 'the producer side of a changed cross-module contract' }),
  'contract-consumer': f({ letter: 'e', definition: 'the consumer side of a changed cross-module contract' }),
  'real-entrypoint': f({ letter: 'f', definition: 'integration through the real production entrypoint and wiring, not a hand-built app' }),
  regression: f({ letter: 'g', definition: 'a regression test for the fix that fails when the fix is absent' }),
});
/** Surface tag -> required kinds. Rows pinned by acceptance tests: async-state + ui-lifecycle (AC4), entrypoint and shared-contract (AC10). Others are provisional. */
export const TAGS = f({
  'async-state': f(['stale-N2', 'error-twin', 'negative']),
  'ui-lifecycle': f(['lifecycle-destroy']),
  concurrency: f(['race']),
  money: f(['negative', 'race']),
  tenancy: f(['negative', 'ownership']),
  auth: f(['negative', 'ownership']),
  'input-path': f(['negative']),
  'shared-contract': f(['contract-producer', 'contract-consumer']),
  entrypoint: f(['real-entrypoint']),
  repair: f(['regression']),
});
/** security-plan boundary kind (skills/vapt/controls.json) -> surface tags. Provisional. */
export const SURFACE_TAGS = f({
  'request-handler': f(['input-path', 'entrypoint']), 'auth-lifecycle': f(['auth']), 'external-input-operation': f(['input-path']),
  'rendering-sink': f(['input-path']), 'server-input': f(['input-path']), 'file-path': f(['input-path']), 'client-storage': f(['input-path']),
  'outbound-data': f(['input-path']), 'async-consumer': f(['concurrency', 'input-path']), 'security-config': f(['entrypoint']), 'business-invariant': f(['money']),
});

/**
 * S-01b2: a kind is PROTECTED (never waivable) when any of its sources is one of these tags, reached directly or through a
 * class mapping, or a security surface. With `provenance` (below) that is: some `tag:<t>` with t here, or any `surface:<s>`.
 */
export const PROTECTED_TAGS = f(['money', 'tenancy', 'auth']);
/** S-01b2 evidence scope (declaration key `tests`): the import specifiers a test file may take `test`/`it`/`describe`/`suite`
 * from, matched by exact string equality. Grammar: `node:` or `bun:` plus lower-case segments, or a lower-case package name
 * with an optional `@scope/` and subpath segments. No `.`/`..` segment, no query, fragment, percent-encoding or whitespace. */
export const RUNNER_MODULE = /^(?:(?:node|bun):[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63}){0,3}|(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,7})$/;
const MAX_TEST_GLOBS = 64, MAX_RUNNER_MODULES = 16, MAX_CLASSES = 256;

const bad = (code, message = code) => Object.assign(new Error(message), { code });
const uniq = (xs) => [...new Set(xs)].sort();
/** An own DATA property (an accessor is refused, never called); undefined when absent. Never reads through a trap. */
const ownData = (o, k, refuse) => { const d = Object.getOwnPropertyDescriptor(o, k); if (d && !('value' in d)) throw refuse(); return d?.value; };
/** A list of strings read by own descriptors: an array (no proxy), 1..max entries, each passing `ok`; sorted and unique. */
function stringList(a, max, ok, refuse) {
  if (types.isProxy(a) || !Array.isArray(a) || a.length < 1 || a.length > max) throw refuse();
  const out = [];
  for (let i = 0; i < a.length; i++) { const x = ownData(a, String(i), refuse); if (typeof x !== 'string' || !ok(x)) throw refuse(); out.push(x); }
  return uniq(out);
}
const isGlob = (g) => { try { compileGlob(g); return true; } catch { return false; } }; // the #72 grammar and matcher
/** The declaration key `tests: {globs?, runner_modules?}` (S-01b2): both lists widen the EVIDENCE scope only, never the requirement. */
function validateTests(v, inv) {
  const refuse = () => inv('tests must be {globs?, runner_modules?}: non-empty lists of #72 globs and runner module names');
  if (v === undefined) return { globs: [], runner_modules: [] };
  if (types.isProxy(v) || v === null || typeof v !== 'object' || Array.isArray(v)) throw refuse();
  const keys = Reflect.ownKeys(v);
  if (!keys.length || keys.some((k) => k !== 'globs' && k !== 'runner_modules')) throw refuse();
  const list = (k, max, ok) => { const x = ownData(v, k, refuse); return x === undefined ? [] : stringList(x, max, ok, refuse); };
  return { globs: list('globs', MAX_TEST_GLOBS, isGlob), runner_modules: list('runner_modules', MAX_RUNNER_MODULES, (m) => RUNNER_MODULE.test(m)) };
}

/** Validate a parsed repository declaration `{version:1, tags?:{tag:[kind]}, classes?:{riskClass:[tag]}, tests?:{globs?, runner_modules?}}`; it can only ADD rows. */
export function validateDeclaration(d) {
  const inv = (m) => bad('declaration_invalid', m);
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (types.isProxy(d) || (isMap(d) && Reflect.ownKeys(d).some((k) => !('value' in Object.getOwnPropertyDescriptor(d, k))))) throw inv('a declaration is plain data (no proxy, no top-level accessor)');
  if (isMap(d) && Object.getPrototypeOf(d) !== null && Object.getPrototypeOf(d) !== Object.prototype) throw inv('a declaration has a plain or null prototype (nothing is read through an inherited name)');
  if (!isMap(d) || ownData(d, 'version', () => inv('version is plain data')) !== 1 || Object.keys(d).some((k) => !['version', 'tags', 'classes', 'tests'].includes(k))) throw inv('version must be 1; only version, tags, classes and tests are allowed');
  const [dTags, dClasses, dTests] = ['tags', 'classes', 'tests'].map((k) => ownData(d, k, () => inv(`${k} is plain data`))); // own data only: never through the prototype
  const tests = validateTests(dTests, inv);
  const list = (v, ok, what) => { if (!Array.isArray(v) || !v.length || v.length > 16 || !v.every(ok)) throw inv(`${what} must be a non-empty list of at most 16 known names`); return uniq(v); };
  const tags = Object.create(null), classes = Object.create(null); // no inherited names (`constructor`) can resolve
  for (const [k, field, out] of [['tags', dTags, tags], ['classes', dClasses, classes]]) {
    if (field === undefined) continue;
    if (!isMap(field) || Object.keys(field).length > 64) throw inv(`${k} must be an object of at most 64 entries`);
    for (const name of Object.keys(field)) if (!(k === 'classes' ? CLASS_NAME : NAME).test(name) || name === 'none') throw inv(`${k} name ${JSON.stringify(name)} is not a lower-case identifier (none is reserved)`);
    Object.assign(out, field);
  }
  for (const t of Object.keys(tags)) tags[t] = list(tags[t], (x) => Object.hasOwn(KINDS, x), `tags.${t}`);
  const known = (x) => Object.hasOwn(TAGS, x) || Object.hasOwn(tags, x);
  for (const c of Object.keys(classes)) classes[c] = list(classes[c], known, `classes.${c}`);
  return { tags, classes, tests };
}

// ---- FAIL-CLOSED RECOGNITION: one tokeniser over one marker table ----
// Invariant: a plan line that carries the TOKEN of a recognised marker either parses strictly as that marker or yields the
// marker's refusal code; a near miss is never read as absent. Absence of the token is genuine absence. Detection reads a
// normalised COPY of each line: NFKC (fullwidth forms and compatibility spaces fold); every format (\p{Cf}) and default-
// ignorable code point removed (zero-width space, soft hyphen, BOM, variation selector, combining grapheme joiner, Hangul
// filler); HTML character references for ASCII punctuation decoded (`&#45;`, `&#x2d;`, `&hyphen;`, `&lowbar;`, `&colon;`);
// inline HTML tags (`<b>`, `</code>`) removed; a Markdown backslash escape before ASCII punctuation removed; lower case;
// every dash (\p{Pd}, U+2212) and `_` folded to `-`. A token starts at a word boundary (`latest waiver:` and
// `attest-triggers` carry none) and is the marker's words joined by one or more dashes, with optional whitespace around them. Plain
// whitespace or nothing never joins words, so prose ("this test triggers a reload", "the risk floor") and camelCase
// identifiers (`runState`, `testTriggers`) carry no token; snake_case ones (`test_triggers`, `run_state`) do. The three
// plan keys also match whitespace-joined words followed by at most 8 non-alphanumeric characters and a colon
// (`Test triggers:`, `**Test triggers**:`, `_Test triggers_:`). Strict
// parsing always reads the RAW line. Markers inside code fences or HTML comments count like any other line (the plan
// header is a comment). NOT caught (they read as absent): homoglyphs such as a Cyrillic letter, misspellings
// (`test-trigers`), combining marks inside a word, words joined by nothing (`testtriggers:`), and whitespace-joined
// words whose colon is not near them (`Test triggers (tags):`).
const LINES = /\r?\n/;
const RS_BEGIN = '<!-- RUN-STATE:BEGIN -->', RS_END = '<!-- RUN-STATE:END -->';
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const MD_ESCAPE = /\\(?=[!-/:-@[-`{-~])/g;
const FOLD_DASH = /[_\p{Pd}\u2212]/gu;
const NAMED = Object.freeze({ hyphen: '-', dash: '-', minus: '-', ndash: '-', mdash: '-', lowbar: '_', colon: ':', nbsp: ' ', lt: '<', gt: '>', excl: '!' });
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi;
const decodeEntities = (l) => l.replace(ENTITY, (all, d, h, n) => {
  const c = d ? Number(d) : h ? parseInt(h, 16) : -1;
  if (c >= 0) return c <= 0x10ffff ? String.fromCodePoint(c) : all;
  return NAMED[n.toLowerCase()] ?? all;
});
const INLINE_TAG = /<\/?[a-z][a-z0-9]*\s*\/?>/gi;
export const normaliseForDetection = (l) => decodeEntities(l).normalize('NFKC').replace(INVISIBLE, '').replace(INLINE_TAG, '').replace(MD_ESCAPE, '').toLowerCase().replace(FOLD_DASH, '-');
const JOIN = '\\s*-+\\s*';
const EDGE = '(?<![a-z0-9])'; // a token starts a word
const token = (...words) => new RegExp(EDGE + words.join(JOIN));
// a plan key: its words joined by dashes, or by whitespace when a colon follows closely (0 such lines in 650 real plans)
const keyToken = (a, b) => new RegExp(`${EDGE}(?:${a}${JOIN}${b}|${a}\\s+${b}[^a-z0-9]{0,8}:)`);
const KEY_LINE = (key) => new RegExp(`^\\s*${key}:(?!:)(.*)$`); // the strict plan-key line (a doubled colon is a near miss)
const keyLine = (key) => (l) => KEY_LINE(key).test(l);
const floorLine = (l) => /^(?:risk_floor:[ \t]*)?risk-floor:/.test(l.trimStart()); // parseRecordedLine's own filter; it validates the rest
const reassessLine = (l) => /^risk_reassess:[ \t]*risk-floor: floor=/.test(l.trimStart()); // risk-floor.mjs `reassess` output, ignored here
const BLOCK_LINE = /^[ \t]*<!-- security-plan: (.*) -->[ \t]*$/; // security-plan.mjs BLOCK_RE, one line
const PAIRS_LINE = /^\s*security-pairs sha256:[0-9a-f]{64}\s*$/;
/**
 * Every recognised plan marker: `token` (matched on the normalised line), `valid` (the strict test on the raw line), the
 * refusal `code` for a token-bearing line that is not valid, `benign` (normalised mentions that name a script file), `event`
 * (a RUN-STATE event record, a line starting with `{`, is never a marker line)
 * and `opt_in` (the marker opts the plan into this check). RUN-STATE is the one exclusion zone: well-formed means no
 * BEGIN/END marker line anywhere in the plan, or exactly one exact BEGIN line followed by one exact END line.
 */
export const MARKERS = f([
  f({ id: 'test-triggers', token: keyToken('test', 'triggers'), code: 'plan_line_invalid', opt_in: true, valid: keyLine('test-triggers') }),
  f({ id: 'lifecycle-item', token: keyToken('lifecycle', 'item'), code: 'plan_line_invalid', opt_in: true, valid: keyLine('lifecycle-item') }),
  f({ id: 'test-waiver', token: keyToken('test', 'waiver'), code: 'waiver_invalid', opt_in: true, valid: keyLine('test-waiver') }),
  f({ id: 'risk-floor', token: token('risk', 'floor'), code: 'risk_floor_invalid', benign: /risk-floor(?:\.test)?\.mjs\b/g, valid: (l) => floorLine(l) || reassessLine(l) }),
  f({ id: 'classes', token: /classes\s*=/, code: 'risk_floor_invalid', valid: (l) => floorLine(l) || reassessLine(l) }),
  // the three below are SYNTAX tokens (the words in their marker context), since real plans use the bare words in prose
  // (650 real, unopted plans scanned for prose: "Security-plan size", `security_pairs_mismatch`, "## RUN-STATE", "the RUN-STATE block")
  f({ id: 'security-plan', token: new RegExp(`<!-+\\s*security${JOIN}plan|security${JOIN}plan\\s*[:=]|"selection-digest"\\s*:`), code: 'security_block_invalid', benign: /security-plan(?:\.test)?\.mjs\b/g, valid: (l) => BLOCK_LINE.test(l) }),
  f({ id: 'security-pairs', token: new RegExp(`security${JOIN}pairs\\s*(?:sha|[:=])`), code: 'security_block_invalid', valid: (l) => PAIRS_LINE.test(l) }),
  f({ id: 'run-state', token: new RegExp(`run${JOIN}state[\\s:=]*(?:begin|end)\\b`), code: 'run_state_invalid', event: true, valid: (l, i) => l.trim() === [RS_BEGIN, RS_END][i] }),
]);
const MARKER = Object.fromEntries(MARKERS.map((m) => [m.id, m]));
/** The raw lines of `text` that carry marker `m`'s token (the one recogniser every marker uses). */
export function carriers(text, m) {
  return text.split(LINES).filter((l) => {
    if (m.event && l.trimStart().startsWith('{')) return false; // an event record names the markers in its text; it is never one
    const n = normaliseForDetection(l);
    return m.token.test(m.benign ? n.replace(m.benign, ' ') : n);
  });
}
/**
 * The plan without its RUN-STATE region (cut at the exact BEGIN and END LINES, never at a substring), or null when the
 * markers are not well-formed. An event record (a line starting with `{`) may name the markers in its text: real START
 * events carry "file bytes before RUN-STATE:BEGIN". Every other line carrying a BEGIN/END token is a marker line.
 */
export function planNarrative(t) {
  const m = MARKER['run-state'], ls = t.split('\n');
  const at = ls.flatMap((l, i) => (carriers(l, m).length ? [i] : []));
  if (!at.length) return t;
  if (at.length !== 2 || !at.every((i, k) => m.valid(ls[i], k))) return null;
  return [...ls.slice(0, at[0]), ...ls.slice(at[1] + 1)].join('\n');
}
const linesOf = (text, key) => text.split(LINES).map((l) => KEY_LINE(key).exec(l)).filter(Boolean).map((m) => m[1].trim());

// opt-in: a repository declaration or any opt-in token (scanned over the whole plan when RUN-STATE is malformed)
const optedIn = (planText, text, declaration) => Boolean(declaration) || MARKERS.some((m) => m.opt_in && carriers(text ?? planText, m).length > 0);
/** `arg`'s own data fields, or null when `arg` is not a plain object or a field is an accessor (never called). */
function fieldsOf(arg, ...keys) {
  if (arg === null || typeof arg !== 'object' || types.isProxy(arg)) return null;
  try { return keys.map((k) => ownData(arg, k, () => bad('arg_invalid'))); } catch { return null; }
}
/**
 * S-01b2 activation: true exactly when `requiredFor` with the same input does NOT answer `not_declared`; requiredFor calls
 * it, and both read the input through `fieldsOf`: own data fields only, so an inherited field is not there and an accessor or
 * a proxy is never called. Total and fail-closed: a non-string plan, or an argument that is not plain data, is opted in,
 * never "nothing declared".
 */
export function optIn(arg) {
  const fields = fieldsOf(arg, 'planText', 'declaration');
  if (!fields) return true;
  const [planText, declaration = null] = fields;
  return typeof planText !== 'string' || optedIn(planText, planNarrative(planText), declaration);
}

/** The tag table under a declaration: built-in rows united with the declared ones (add-only; no inherited names). */
function tagTable(declaration) {
  const table = Object.assign(Object.create(null), TAGS);
  for (const [t, ks] of Object.entries(declaration?.tags ?? {})) table[t] = uniq([...(table[t] ?? []), ...ks]);
  return table;
}
/**
 * THE class loop: requiredFor (recorded floor classes) and kindsForClasses (reassessed classes) both run it, so a class maps
 * the same way at init and at every verdict. Add-only: the declared mapping and the built-in reading (a class named like a
 * tag is that tag; `risk_declaration_changed` is nothing) are UNITED. Own properties only, so a JSON-restored declaration
 * never resolves `constructor`. `add(tag, source)` receives each tag with its `class:<c>` source.
 */
function classTags(classes, declaration, table, errors, add) {
  for (const c of classes) {
    const declared = declaration && Object.hasOwn(declaration.classes, c) ? declaration.classes[c] : null;
    const builtin = Object.hasOwn(table, c) ? [c] : c === CHANGED ? [] : null;
    if (!declared && !builtin) errors.push('risk_class_unmapped'); else [...(declared ?? []), ...(builtin ?? [])].forEach((t) => add(t, `class:${c}`));
  }
}
/** A tag set that records where each tag came from (`class:<c>`, `surface:<s>`; a plan tag adds no origin beyond itself). */
function sourcedTags() {
  const tags = new Set(), origins = new Map();
  const add = (t, src = null) => { tags.add(t); if (src) { if (!origins.has(t)) origins.set(t, new Set()); origins.get(t).add(src); } };
  return { tags, add, origins };
}
/** kind -> sorted sources: `tag:<t>` for every tag whose row requires the kind, plus that tag's `class:`/`surface:` origins. Keys = the kinds. */
function provenanceOf(tags, origins, table) {
  const by = new Map();
  for (const t of tags) for (const k of table[t]) {
    if (!by.has(k)) by.set(k, new Set());
    by.get(k).add(`tag:${t}`); for (const o of origins.get(t) ?? []) by.get(k).add(o);
  }
  return Object.fromEntries([...by.keys()].sort().map((k) => [k, [...by.get(k)].sort()]));
}

/** The required kinds and items for a plan, under an optional validated declaration. Pure; never throws. */
// P5 must pass readDeclaration output only (validated declaration)
export function requiredFor(arg) {
  const fields = fieldsOf(arg, 'planText', 'declaration', 'baseSha'); // the same own-data reader as optIn
  const [planText, declaration = null, baseSha = null] = fields ?? [];
  const errors = [], out = (status, o = {}) => ({ status, kinds: [], items: [], waiver_requested: [], tags: [], errors: uniq(errors), provenance: {}, ...o });
  if (!fields || typeof planText !== 'string') return (errors.push('plan_invalid'), out('refused'));
  const text = planNarrative(planText); // the ONE narrative every parse below reads
  if (!optIn({ planText, declaration })) return out('not_declared');
  if (text === null) return (errors.push('run_state_invalid'), out('refused'));
  for (const m of MARKERS) if (carriers(text, m).some((l) => !m.valid(l))) errors.push(m.code);
  const trig = linesOf(text, 'test-triggers');
  const table = tagTable(declaration);
  const { tags, add, origins } = sourcedTags();
  if (!trig.length) errors.push('plan_tags_missing');
  else if (trig.length > 1 || !trig[0]) errors.push('plan_line_invalid');
  else if (trig[0] !== 'none') for (const t of trig[0].split(',').map((x) => x.trim())) { if (Object.hasOwn(table, t)) add(t); else errors.push('unknown_tag'); }
  // risk floor classes: exactly one strict record line as risk-floor.mjs writes it (trusted as recorded in the plan, not recomputed)
  const floorLines = text.split(LINES).filter(floorLine);
  if (!floorLines.length) errors.push('risk_floor_missing');
  else {
    let classes = null; // parseRecordedLine validates exactly one line strictly (the same filter); the classes are read from that line
    try {
      const rec = parseRecordedLine(text);
      if (baseSha !== null && rec.base !== String(baseSha).slice(0, 12)) errors.push('risk_floor_base_mismatch');
      const raw = /; classes=([^;]*);/.exec(floorLines[0])[1];
      classes = raw === 'none' ? [] : raw.split(','); // `none` is the producer's empty-set sentinel
      if (!classes.every((c) => CLASS_NAME.test(c) && c !== 'none')) throw new Error('bad class');
    } catch { classes = null; errors.push('risk_floor_invalid'); }
    classTags(classes ?? [], declaration, table, errors, add);
  }
  // security surfaces: BOTH readings, ALWAYS (no early exit when the narrative carries no security token). The block is
  // parsed from the one narrative, never re-cut; the engine binds parsePlanSecurityBlock(plan), which cuts RUN-STATE at
  // substrings (run-engine.mjs). Any difference between the two (block, pairs, hence kinds) is a refusal, not a choice;
  // and a security token in the narrative demands a verified block.
  const blockToken = carriers(text, MARKER['security-plan']).length > 0 || carriers(text, MARKER['security-pairs']).length > 0;
  const block = parsePlanSecurityBlock(text, { alreadyCut: true }), engineBlock = parsePlanSecurityBlock(planText);
  if ((blockToken && !block) || JSON.stringify(engineBlock) !== JSON.stringify(block)) errors.push('security_block_invalid');
  else if (block) for (const s of block.surfaces) { if (Object.hasOwn(SURFACE_TAGS, s.kind)) SURFACE_TAGS[s.kind].forEach((t) => add(t, `surface:${s.kind}`)); else errors.push('surface_kind_unmapped'); }
  const items = [];
  for (const l of linesOf(text, 'lifecycle-item')) { const m = /^(\S+)\s+\S/.exec(l); if (!m || !ITEM_ID.test(m[1]) || Object.hasOwn(KINDS, m[1]) || items.includes(m[1])) errors.push('plan_line_invalid'); else items.push(m[1]); }
  const waivers = new Set();
  for (const l of linesOf(text, 'test-waiver')) { const m = /^(\S+)\s+\S/.exec(l); if (!m || !(Object.hasOwn(KINDS, m[1]) || items.includes(m[1]))) errors.push('waiver_invalid'); else waivers.add(m[1]); }
  if (errors.length) return out('refused');
  const kinds = uniq([...tags].flatMap((t) => table[t]));
  // waivers are reported, never applied: the requirement stays and a missing kind is still missing
  return out('required', { tags: uniq([...tags]), kinds, items: items.sort(), waiver_requested: uniq([...waivers].filter((w) => kinds.includes(w) || items.includes(w))),
    provenance: provenanceOf(tags, origins, table) });
}

/** A bound declaration (validated, possibly restored from JSON) copied by own data properties into null-prototype maps of string lists. */
function declarationCopy(d) {
  const refuse = () => bad('declaration_invalid');
  if (d === null) return null;
  if (types.isProxy(d) || typeof d !== 'object' || Array.isArray(d)) throw refuse();
  const copy = (field, keyOk, itemOk) => {
    const v = ownData(d, field, refuse), out = Object.create(null);
    if (v === undefined) return out;
    if (types.isProxy(v) || v === null || typeof v !== 'object' || Array.isArray(v)) throw refuse();
    const keys = Reflect.ownKeys(v);
    if (keys.length > 64) throw refuse();
    for (const k of keys) { if (typeof k !== 'string' || !keyOk.test(k) || k === 'none') throw refuse(); out[k] = stringList(ownData(v, k, refuse), 16, itemOk, refuse); }
    return out;
  };
  const tags = copy('tags', NAME, (k) => Object.hasOwn(KINDS, k));
  const classes = copy('classes', CLASS_NAME, (t) => Object.hasOwn(TAGS, t) || Object.hasOwn(tags, t));
  return { tags, classes };
}
/**
 * S-01b2: the kinds a list of risk classes (a `reassess` result) adds, through the SAME class loop as requiredFor
 * (`classTags`) under the same base-pinned declaration. Pure; never throws. Output:
 * `{ ok, tags, kinds, provenance: {<kind>: [<source>...]}, errors }`; `ok:false` has empty lists and one or more of
 * `risk_floor_invalid` (classes not a list of 0..256 class names, `none` excluded; risk-floor.mjs writes at most 200 declared
 * classes plus `risk_declaration_changed`), `declaration_invalid`, `risk_class_unmapped`, `test_kinds_error` (an internal fault).
 */
export function kindsForClasses(arg) {
  const refused = (errors) => ({ ok: false, tags: [], kinds: [], provenance: {}, errors: uniq(errors) });
  try {
    const cfield = fieldsOf(arg, 'classes'), dfield = fieldsOf(arg, 'declaration'); // own data only: an accessor is never called
    if (!cfield) return refused(['risk_floor_invalid']);
    if (!dfield) return refused(['declaration_invalid']);
    const [classes] = cfield, declaration = dfield[0] ?? null;
    const empty = !types.isProxy(classes) && Array.isArray(classes) && classes.length === 0; // `classes=none`: the empty set
    let list;
    try { list = empty ? [] : stringList(classes, MAX_CLASSES, (c) => CLASS_NAME.test(c) && c !== 'none', () => bad('risk_floor_invalid')); } catch { return refused(['risk_floor_invalid']); }
    let decl;
    try { decl = declarationCopy(declaration); } catch { return refused(['declaration_invalid']); }
    const table = tagTable(decl), errors = [], { tags, add, origins } = sourcedTags();
    classTags(list, decl, table, errors, add);
    if (errors.length) return refused(errors);
    return { ok: true, tags: uniq([...tags]), kinds: uniq([...tags].flatMap((t) => table[t])), provenance: provenanceOf(tags, origins, table), errors: [] };
  } catch { return refused(['test_kinds_error']); }
}

/** The `[kind:..]` and `[plan:..]` markers in test titles. `unknown`: well-formed kind markers naming no kind. */
export function markers(titles) {
  const kinds = new Set(), items = new Set(), unknown = new Set();
  for (const t of titles) for (const m of String(t).matchAll(/\[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g)) {
    if (m[1] === 'plan') items.add(m[2]); else if (Object.hasOwn(KINDS, m[2])) kinds.add(m[2]); else unknown.add(`kind:${m[2]}`);
  }
  return { kinds: [...kinds].sort(), items: [...items].sort(), unknown: [...unknown].sort() };
}

/** Compare a requirement with test titles. `freeze_refused` lists `missing_test_kinds` and/or `unmapped_lifecycle_item`. */
export function checkTitles(req, titles) {
  if (req.status !== 'required') return { ...req, status: req.status, reasons: [], record_line: `test-kinds: status=${req.status}` };
  const m = markers(titles);
  const missing = req.kinds.filter((k) => !m.kinds.includes(k)), unmapped = req.items.filter((i) => !m.items.includes(i));
  const reasons = [...(missing.length ? ['missing_test_kinds'] : []), ...(unmapped.length ? ['unmapped_lifecycle_item'] : [])];
  const status = reasons.length ? 'freeze_refused' : 'pass';
  const counts = { required: req.kinds.length, present: req.kinds.length - missing.length, missing: missing.length, waiver_requested: req.waiver_requested.length, items: req.items.length, unmapped: unmapped.length, unknown_markers: m.unknown.length };
  return { status, reasons, missing_kinds: missing, unmapped_items: unmapped, unknown_markers: m.unknown, waiver_requested: req.waiver_requested, counts,
    record_line: `test-kinds: status=${status}; ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('; ')}; reasons=${reasons.join(',') || 'none'}` };
}

// ---- the declaration at BASE ----
// TEMPORARY third copy of the hardened-git helper (also in fast-checks.mjs and risk-floor.mjs): no inherited GIT_*, no replace
// objects, literal pathspecs. TODO(S-02a0b): replace with lib/git-capability.mjs (git-exec) when it lands; do not extend this copy.
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const git = (cwd, args) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const gitText = (cwd, args) => git(cwd, args).toString('utf8').replace(/\n$/, '');
/** `{declaration|null, baseSha}` from the BASE commit. */
export function readDeclaration(repo, base) {
  if (typeof base !== 'string' || !base || base.startsWith('-')) throw bad('base_invalid');
  let top, sha;
  try { top = realpathSync.native(gitText(realpathSync.native(repo), ['rev-parse', '--show-toplevel'])); } catch { throw bad('repo_unavailable'); }
  try { sha = gitText(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]); } catch { throw bad('base_invalid'); }
  const entry = gitText(top, ['ls-tree', '-z', sha, '--', DECLARATION_PATH]).replace(/\0$/, '');
  if (!entry) return { declaration: null, baseSha: sha };
  const m = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
  if (!m || Number(gitText(top, ['cat-file', '-s', m[2]])) > MAX_DECLARATION) throw bad('declaration_invalid', 'not a regular file within the size limit');
  try { return { declaration: validateDeclaration(JSON.parse(decodeStrict(git(top, ['cat-file', 'blob', m[2]])))), baseSha: sha }; } catch (e) { throw e.code === 'declaration_invalid' ? e : bad('declaration_invalid'); }
}

// ---- CLI ----
const refusedOut = (code) => ({ status: 'refused', kinds: [], items: [], waiver_requested: [], tags: [], errors: [code], provenance: {} });
export function main(argv) {
  const usage = { code: 2, out: { status: 'refused', errors: ['bad_usage'], usage: 'test-kinds.mjs require|check --repo <dir> --base <commit> --plan <plan.md> [--titles <json|file> | --report-file <file>]' } };
  const [cmd, ...rest] = argv;
  let v;
  try { ({ values: v } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { repo: { type: 'string' }, base: { type: 'string' }, plan: { type: 'string' }, titles: { type: 'string' }, 'report-file': { type: 'string' } } })); } catch { return usage; }
  if (!['require', 'check'].includes(cmd) || !v.repo || !v.base || !v.plan || rest.filter((a) => a.startsWith('--')).length !== Object.keys(v).length) return usage;
  if (cmd === 'require' ? (v.titles || v['report-file']) : !v.titles === !v['report-file']) return usage;
  let r;
  try {
    const planText = decodeStrict(readFileSync(v.plan));
    const { declaration, baseSha } = readDeclaration(v.repo, v.base);
    r = requiredFor({ planText, declaration, baseSha });
  } catch (e) { r = refusedOut(e.code && /^[a-z_]+$/.test(e.code) ? e.code : 'plan_unreadable'); }
  if (cmd === 'check' && r.status === 'required') {
    let titles = null;
    if (v['report-file']) {
      let p; try { p = parseWorkerReport(readFileSync(v['report-file'], 'utf8'), { testKindsDeclared: true }); } catch { p = { failure: 'report_unreadable' }; }
      if (p.status === 'structured') titles = p.report.test_titles; else r = refusedOut(/^[a-z_]+$/.test(p.failure) ? p.failure : 'report_unstructured');
    } else {
      try { titles = JSON.parse(v.titles.trim().startsWith('[') ? v.titles : readFileSync(v.titles, 'utf8')); } catch { titles = null; }
      if (!Array.isArray(titles) || !titles.every((t) => typeof t === 'string')) { titles = null; r = refusedOut('titles_invalid'); }
    }
    if (titles) r = checkTitles(r, titles);
  } else if (cmd === 'check') r = checkTitles(r, []);
  return { code: ['refused', 'freeze_refused'].includes(r.status) ? 1 : 0, out: r };
}
if (isEntrypoint(import.meta.url)) { const { code, out } = main(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(out)}\n`); process.exitCode = code; }
