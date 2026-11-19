#!/usr/bin/env node
// security-plan.mjs — catalog-driven security control selection for ship-ticket plans (policy 2).
//
//   select   --facts <file|-> [--catalog <controls.json>]
//   reassess --plan <plan.md> --inventory <json> --changed <json> [--classifications <json>] [--addenda <json>] [--catalog <controls.json>]
//   obligations --plan <plan.md> --repo <dir> [--addenda <pair ids json>] [--waived <pair ids json>] [--catalog <controls.json>]
//
// stdout is always one JSON object with `code` and `reasons[]`. Exit 0: a result (selected; reassessed as
// UNCHANGED or ADD_CONTROLS; obligations). Exit 2: a refusal or judgment point (every SECURITY_CODES code not
// listed under exit 1, or the outcome REAPPROVAL). Exit 1: malformed input (bad_input, fact_out_of_vocabulary, surface_facts_mismatch).
//
// The catalog is skills/vapt/controls.json and its evaluator skills/vapt/controls.mjs (one definition of the
// selection semantics). A standalone install without vapt refuses catalog_missing: never an empty selection.
// Keyword matches on a diff only create signals; they never select a control. Imports no engine module.
import { readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EVALUATOR_URL = new URL('../../vapt/controls.mjs', import.meta.url).href;
const DEFAULT_CATALOG = fileURLToPath(new URL('../../vapt/controls.json', import.meta.url));
const EVAL_FNS = ['unknownish', 'assertFacts', 'selected', 'via', 'why', 'catalogDigest'];
let DEFAULT_EVALUATOR = null;
try { DEFAULT_EVALUATOR = await import(EVALUATOR_URL); } catch { DEFAULT_EVALUATOR = null; }

/**
 * Every refusal code this module emits. Exit 1 for EXIT_ONE codes, 2 for the rest. F12a (block format 3) added
 * surface_fact_not_lowerable, surface_fact_ungated, surface_fact_reinflates (a refused surface-level fact),
 * disposition_missing, disposition_duplicate, disposition_unknown (the obligation matrix) and
 * surface_inventory_incomplete (a signalling non-test path written by the plan that no surface lists) and
 * citation_missing (a surface-fact citation whose file, or `:symbol` text, is not in the tree checked).
 */
export const SECURITY_CODES = ['catalog_missing', 'catalog_invalid', 'bad_input', 'fact_out_of_vocabulary', 'surface_facts_mismatch',
  'fact_uncited', 'control_unpaired', 'classification_missing', 'plan_block_missing', 'plan_block_invalid',
  'surface_fact_not_lowerable', 'surface_fact_ungated', 'surface_fact_reinflates', 'disposition_missing', 'disposition_duplicate',
  'disposition_unknown', 'surface_inventory_incomplete', 'citation_missing'];
const EXIT_ONE = new Set(['bad_input', 'fact_out_of_vocabulary', 'surface_facts_mismatch']);
export const OUTCOMES = ['UNCHANGED', 'ADD_CONTROLS', 'REAPPROVAL'];

// ---------------------------------------------------------------------------------------------------- utils
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
// The unknown encoding is the evaluator's (`ev.unknownish`, skills/vapt/controls.mjs): this module keeps no copy.
const partlyUnknown = (ev, v) => ev.unknownish(v) || (Array.isArray(v) && v.includes('unknown'));
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const uniqSorted = (xs) => [...new Set(xs)].sort();
const normPath = (p) => String(p).replace(/^(\.\/)+/, '');
/**
 * A surface or changed path, normalized. A backslash is refused, never converted: on POSIX it is a legal file-name
 * character, so `src\a.ts` converted would alias `src/a.ts`. Git reports changed paths with forward slashes.
 */
function inputPath(p, what) {
  if (String(p).includes('\\')) refuse('bad_input', `${what} ${JSON.stringify(p)} contains a backslash; use forward slashes`);
  return normPath(p);
}
/** Canonical JSON: object keys sorted recursively, no whitespace, undefined dropped. */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canon(x))).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
class Refusal extends Error { constructor(code, reasons) { super(code); this.code = code; this.reasons = reasons; } }
const refuse = (code, ...reasons) => { throw new Refusal(code, reasons); };
const asResult = (fn) => { try { return fn(); } catch (e) { if (e instanceof Refusal) return { ok: false, code: e.code, reasons: e.reasons }; throw e; } };

// ---------------------------------------------------------------------------------------------------- pair ids
const CONTROL_ID = /^VAPT-[A-Z]+-\d\d$/;
const PAIR_ID = /^(.+):(VAPT-[A-Z]+-\d\d)$/;
/** `<boundary_id>:<control_id>`; the boundary id may itself contain colons. */
export function pairId(boundaryId, controlId) {
  if (!nonEmpty(boundaryId) || /[\r\n]/.test(boundaryId) || typeof controlId !== 'string' || !CONTROL_ID.test(controlId)) {
    throw new TypeError(`invalid pair (${JSON.stringify(boundaryId)}, ${JSON.stringify(controlId)})`);
  }
  return `${boundaryId}:${controlId}`;
}
/** Split on the LAST colon that precedes a control id. Returns null for anything malformed. */
export function parsePairId(s) {
  if (typeof s !== 'string') return null;
  const m = PAIR_ID.exec(s);
  if (!m || !nonEmpty(m[1]) || /[\r\n]/.test(m[1])) return null;
  return { boundary_id: m[1], control_id: m[2] };
}

// ---------------------------------------------------------------------------------------------------- catalog
const REGISTRY = new WeakMap(); // catalog object -> { digest, evaluator }

/** sha256 of the catalog's raw bytes, `sha256:<hex>` (same form as skills/vapt/controls.mjs). */
export function catalogDigest(raw) {
  return DEFAULT_EVALUATOR ? DEFAULT_EVALUATOR.catalogDigest(raw) : sha(raw);
}

function catalogShapeErrors(c) {
  const errs = [];
  if (!isObj(c)) return ['catalog is not an object'];
  if (c.catalog_version === undefined) errs.push('catalog_version missing');
  const v = c.fact_vocabulary;
  if (!isObj(v) || !isObj(v.boundaries) || v.boundaries.type !== 'enum' || !Array.isArray(v.boundaries.values) || !v.boundaries.values.length) errs.push('fact_vocabulary.boundaries enum missing');
  if (isObj(v)) for (const [k, d] of Object.entries(v)) if (!isObj(d) || !['bool', 'enum'].includes(d.type) || (d.type === 'enum' && !Array.isArray(d.values))) errs.push(`fact_vocabulary.${k} malformed`);
  if (!Array.isArray(c.controls) || !c.controls.length) errs.push('controls missing or empty');
  else {
    const seen = new Set();
    for (const x of c.controls) {
      if (!isObj(x) || typeof x.id !== 'string' || !CONTROL_ID.test(x.id)) { errs.push(`control id ${JSON.stringify(x?.id)} malformed`); continue; }
      if (seen.has(x.id)) errs.push(`${x.id} duplicated`);
      seen.add(x.id);
      if (!['[NN]', '[D]'].includes(x.tier)) errs.push(`${x.id} tier`);
      if (!isObj(x.applies_when)) errs.push(`${x.id} applies_when`);
      if (!isObj(x.verify) || !nonEmpty(x.verify.type)) errs.push(`${x.id} verify.type`);
    }
  }
  return errs;
}

/**
 * The `not_applicable` grammar, parsed once at load (runtime never reads the prose again): per control, per
 * boundary kind, either a fact gate (a reason that starts `gated by <fact>[ or <fact>...]: `, each fact a bool of
 * the vocabulary) or null (a kind-level reason). Absent `not_applicable` is valid (no entry). A reason that starts
 * `gated by` but breaks the grammar, names a non-bool fact or a gate that does not select the control is refused:
 * a surface-level fact may only lower a gate this map names (security-plan.mjs F12a), so the map must be exact.
 */
export const GATED_CLAUSE = /^gated by ([a-z_]+(?: or [a-z_]+)*): \S/;
function catalogGates(c, ev, errs) {
  const gates = new Map();
  const vocab = c.fact_vocabulary;
  const kinds = vocab.boundaries.values;
  const bools = Object.entries(vocab).filter(([, d]) => d.type === 'bool').map(([k]) => k);
  const world = (k, extra) => ({ ...Object.fromEntries(bools.map((b) => [b, false])), boundaries: [k],
    ...(isObj(vocab.principals) && vocab.principals.values?.length ? { principals: [vocab.principals.values[0]] } : {}), ...extra });
  for (const x of c.controls) {
    if (x.not_applicable === undefined) continue;
    if (!isObj(x.not_applicable)) { errs.push(`${x.id} not_applicable must be an object`); continue; }
    const m = new Map();
    for (const [k, reason] of Object.entries(x.not_applicable)) {
      if (!kinds.includes(k)) { errs.push(`${x.id} not_applicable key '${k}' is not a boundary kind`); continue; }
      if (!nonEmpty(reason)) { errs.push(`${x.id} not_applicable.${k} needs a reason`); continue; }
      if (!/^gated by\b/.test(reason)) { m.set(k, null); continue; }
      const g = GATED_CLAUSE.exec(reason);
      if (!g) { errs.push(`${x.id} not_applicable.${k}: malformed 'gated by <fact>[ or <fact>]: <reason>' clause`); continue; }
      const facts = g[1].split(' or ');
      const badFact = facts.find((f) => vocab[f]?.type !== 'bool');
      if (badFact) { errs.push(`${x.id} not_applicable.${k}: gate '${badFact}' is not a bool fact`); continue; }
      const one = { ...c, controls: [x] };
      let wrong = null;
      try {
        if (ev.selected(one, world(k)).length) wrong = `${k} alone selects ${x.id}, so the gate is stale`;
        else for (const f of facts) if (!ev.selected(one, world(k, { [f]: true })).length) wrong = `${k} + ${f}=true does not select ${x.id}`;
      } catch (e) { wrong = String(e.message); }
      if (wrong) { errs.push(`${x.id} not_applicable.${k}: ${wrong}`); continue; }
      m.set(k, new Set(facts));
    }
    gates.set(x.id, m);
  }
  return gates;
}

/**
 * Load and register the catalog. `catalogPath` defaults to ../../vapt/controls.json. `evaluator` is the
 * evaluator module (default: ../../vapt/controls.mjs; null simulates its absence). Never throws.
 * -> { ok:true, code:'catalog_loaded', reasons:[], catalog, digest, catalog_version } | { ok:false, code, reasons }
 */
export function loadCatalog({ catalogPath, evaluator } = {}) {
  const ev = evaluator === undefined ? DEFAULT_EVALUATOR : evaluator;
  if (!ev || !EVAL_FNS.every((f) => typeof ev[f] === 'function')) {
    return { ok: false, code: 'catalog_missing', reasons: [`catalog evaluator not found (${EVALUATOR_URL}); install the vapt skill`] };
  }
  const path = catalogPath ?? DEFAULT_CATALOG;
  let raw;
  try { raw = readFileSync(path); } catch (e) { return { ok: false, code: 'catalog_missing', reasons: [`catalog ${path}: ${e.code ?? e.message}`] }; }
  let catalog;
  try { catalog = JSON.parse(raw.toString('utf8')); } catch (e) { return { ok: false, code: 'catalog_invalid', reasons: [`catalog ${path}: ${e.message}`] }; }
  const errs = catalogShapeErrors(catalog);
  if (errs.length) return { ok: false, code: 'catalog_invalid', reasons: errs };
  const gateErrs = [];
  const gates = catalogGates(catalog, ev, gateErrs);
  if (gateErrs.length) return { ok: false, code: 'catalog_invalid', reasons: gateErrs };
  const digest = ev.catalogDigest(raw);
  REGISTRY.set(catalog, { digest, evaluator: ev, gates });
  return { ok: true, code: 'catalog_loaded', reasons: [], catalog, digest, catalog_version: catalog.catalog_version };
}

function resolveCatalog(arg) {
  if (isObj(arg) && arg.ok === false) return { refusal: { ok: false, code: arg.code, reasons: arg.reasons ?? [] } };
  const catalog = isObj(arg) && arg.ok === true ? arg.catalog : arg;
  const reg = isObj(catalog) ? REGISTRY.get(catalog) : undefined;
  if (!reg) throw new TypeError('catalog must come from loadCatalog()');
  return { catalog, ...reg };
}

// ---------------------------------------------------------------------------------------------------- validation
function checkFacts(ev, facts, vocab) {
  try { ev.assertFacts(facts, vocab); } catch (e) { refuse('fact_out_of_vocabulary', String(e.message)); }
}

/**
 * Surfaces -> normalized, sorted by boundary_id. `allowFacts` (select only, never reassess: an inventory surface
 * cannot lower a fact after approval) admits a surface's optional `facts` and `evidence` objects (F12a), which
 * lowerings() checks; a surface without them normalizes exactly as before.
 */
function validateSurfaces(surfaces, vocab, { allowFacts = false } = {}) {
  if (!Array.isArray(surfaces)) refuse('bad_input', 'surfaces must be an array');
  const keys = allowFacts ? ['boundary_id', 'kind', 'path', 'principals', 'facts', 'evidence'] : ['boundary_id', 'kind', 'path', 'principals'];
  const kinds = new Set([...vocab.boundaries.values, 'unknown']);
  const principals = isObj(vocab.principals) ? new Set([...vocab.principals.values, 'unknown']) : null;
  const seen = new Set();
  const out = [];
  for (const s of surfaces) {
    if (!isObj(s) || !nonEmpty(s.boundary_id) || /[\r\n]/.test(s.boundary_id) || typeof s.kind !== 'string' || !nonEmpty(s.path)
      || !Array.isArray(s.principals) || !s.principals.length || !s.principals.every((p) => typeof p === 'string')) {
      refuse('bad_input', `surface ${JSON.stringify(s)} needs boundary_id, kind, path and a non-empty principals[]`);
    }
    if (Object.keys(s).some((k) => !keys.includes(k))) refuse('bad_input', `surface ${s.boundary_id} has unknown keys`);
    if (seen.has(s.boundary_id)) refuse('bad_input', `duplicate boundary_id ${s.boundary_id}`);
    seen.add(s.boundary_id);
    if (!kinds.has(s.kind)) refuse('fact_out_of_vocabulary', `surface ${s.boundary_id}: kind ${JSON.stringify(s.kind)} is not a boundary kind`);
    if (principals) for (const p of s.principals) if (!principals.has(p)) refuse('fact_out_of_vocabulary', `surface ${s.boundary_id}: principal ${JSON.stringify(p)}`);
    const n = { boundary_id: s.boundary_id, kind: s.kind, path: inputPath(s.path, `surface ${s.boundary_id}: path`), principals: uniqSorted(s.principals) };
    if (s.facts !== undefined || s.evidence !== undefined) {
      if (!isObj(s.facts) || !Object.keys(s.facts).length || !isObj(s.evidence)) refuse('bad_input', `surface ${s.boundary_id}: facts must be a non-empty object with an evidence object`);
      const extra = Object.keys(s.evidence).filter((k) => !Object.hasOwn(s.facts, k));
      if (extra.length) refuse('bad_input', `surface ${s.boundary_id}: evidence for facts it does not set: ${extra.join(', ')}`);
      n.facts = { ...s.facts };
      n.evidence = { ...s.evidence };
    }
    out.push(n);
  }
  return out.sort((a, b) => (a.boundary_id < b.boundary_id ? -1 : a.boundary_id > b.boundary_id ? 1 : 0));
}

const DERIVED = ['boundaries', 'principals'];
/** A known value cites a path; an unknown one says `unknown: <why>`. Only the keys in `keys` are checked. */
function checkCitations(ev, facts, evidence, vocab, keys) {
  for (const k of Object.keys(evidence)) if (!vocab[k]) refuse('fact_out_of_vocabulary', `evidence for unknown fact '${k}'`);
  for (const k of keys) {
    const v = facts[k], e = evidence[k];
    if (!nonEmpty(e) || /[\r\n]/.test(e)) refuse('fact_uncited', `${k}: no citation`);
    const saysUnknown = /^unknown:/i.test(e.trim());
    if (saysUnknown && !/^unknown:\s*\S/i.test(e.trim())) refuse('fact_uncited', `${k}: "unknown:" needs a reason`);
    if (saysUnknown && !partlyUnknown(ev, v)) refuse('fact_uncited', `${k}: a known value needs a path citation, not "unknown:"`);
    if (!saysUnknown && ev.unknownish(v)) refuse('fact_uncited', `${k}: an unknown value needs "unknown: <why>"`);
  }
}

const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && canon(uniqSorted(a)) === canon(uniqSorted(b));

/** Normalized facts over the whole vocabulary: unknown encodings -> 'unknown', enums sorted and deduped. */
function normFacts(ev, facts, vocab) {
  const out = {};
  for (const k of Object.keys(vocab).sort()) {
    const v = facts[k];
    out[k] = ev.unknownish(v) ? 'unknown' : Array.isArray(v) ? uniqSorted(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- selection core
/**
 * The selection core. `lower` (block format 3 only; null = legacy, byte-identical): Map(boundary_id -> Map(fact ->
 * citation)) of the facts that surface lowered true->false. A surface pair (s, C) is dropped-by-fact only when C's own catalog
 * gate for s.kind names a lowered fact and C, re-evaluated by the evaluator with exactly those facts false, is no
 * longer selected; its legacy pairing (and so the paired_by 'change' fallback) is computed WITHOUT lowering, so a
 * drop can never re-inflate a control onto other surfaces. `keep`: pair ids reopened (never dropped).
 */
function compute({ catalog, evaluator: ev, gates }, facts, surfaces, { lower = null, keep = null } = {}) {
  const byId = new Map(catalog.controls.map((c) => [c.id, c]));
  const change = ev.selected(catalog, facts);
  const pairs = [];
  const na = [];
  const bySurface = new Set();
  for (const s of surfaces) {
    const sf = { ...facts, boundaries: [s.kind] };
    const low = lower?.get(s.boundary_id);
    for (const id of ev.selected(catalog, sf)) {
      bySurface.add(id);
      const c = byId.get(id);
      const pid = pairId(s.boundary_id, id);
      const fs = low ? [...(gates?.get(id)?.get(s.kind) ?? [])].filter((f) => low.has(f)).sort() : [];
      if (fs.length && !keep?.has(pid) && !ev.selected({ ...catalog, controls: [c] }, { ...sf, ...Object.fromEntries(fs.map((f) => [f, false])) }).length) {
        na.push({ pair_id: pid, boundary_id: s.boundary_id, kind: s.kind, control_id: id, tier: c.tier, facts: fs,
          evidence: Object.fromEntries(fs.map((f) => [f, low.get(f)])) });
        continue;
      }
      pairs.push({ pair_id: pid, boundary_id: s.boundary_id, kind: s.kind, control_id: id, tier: c.tier,
        paired_by: 'surface', why: ev.via(c.applies_when, sf) });
    }
  }
  // Selected for the change but by no single surface (a predicate spanning kinds): fail closed, pair with every surface.
  const unpaired = [];
  for (const id of change) {
    if (bySurface.has(id)) continue;
    if (!surfaces.length) { unpaired.push(id); continue; }
    const c = byId.get(id);
    for (const s of surfaces) pairs.push({ pair_id: pairId(s.boundary_id, id), boundary_id: s.boundary_id, kind: s.kind, control_id: id,
      tier: c.tier, paired_by: 'change', why: 'change: ' + ev.via(c.applies_when, facts) });
  }
  pairs.sort((a, b) => (a.pair_id < b.pair_id ? -1 : a.pair_id > b.pair_id ? 1 : 0));
  na.sort((a, b) => (a.pair_id < b.pair_id ? -1 : a.pair_id > b.pair_id ? 1 : 0));
  // Block format 3: `controls` are the controls with an effective pair (a control dropped on every surface is in na_pairs only).
  const ids = lower ? uniqSorted(pairs.map((p) => p.control_id)) : uniqSorted([...change, ...bySurface]);
  const controls = ids.map((id) => {
    const c = byId.get(id);
    return { control_id: id, tier: c.tier, verify_type: c.verify?.type ?? null, env: c.env ?? null,
      why: change.includes(id) ? ev.via(c.applies_when, facts) : 'surface-level only',
      boundary_ids: uniqSorted(pairs.filter((p) => p.control_id === id).map((p) => p.boundary_id)) };
  });
  const selectedIds = uniqSorted([...change, ...bySurface]);
  const excluded = catalog.controls.filter((c) => !selectedIds.includes(c.id)).map((c) => ({ control_id: c.id, why: ev.why(c.applies_when, facts) }))
    .sort((a, b) => (a.control_id < b.control_id ? -1 : 1));
  const unknown_facts = Object.keys(catalog.fact_vocabulary).filter((k) => partlyUnknown(ev, facts[k])).sort();
  return { controls, pairs, excluded, unknown_facts, unpaired, ...(lower ? { na_pairs: na } : {}) };
}

/**
 * Legacy (block format 2): {policy:2, catalog_digest, facts_digest, controls}. Block format 3 adds what a
 * surface-level fact changes: the surfaces (with their facts and citations), the effective pairs and the
 * dropped pairs, so no surface fact, citation or disposition can move without moving the digest.
 */
const selectionDigest = ({ catalog_digest, facts_digest, controls, v3 }) => (v3
  ? sha(canon({ policy: 3, catalog_digest, facts_digest, controls: uniqSorted(controls), surfaces: v3.surfaces, pairs: uniqSorted(v3.pairs), na_pairs: v3.na_pairs }))
  : sha(canon({ policy: 2, catalog_digest, facts_digest, controls: uniqSorted(controls) })));

/**
 * Select controls for a change. `catalogArg` is a loadCatalog() result (or its catalog). Input:
 * { security_policy:2, surfaces:[{boundary_id,kind,path,principals[]}], facts:{...}, evidence:{fact:"path[:symbol]"|"unknown: why"}, summary? }
 */
export function selectControls(catalogArg, input) {
  const r = resolveCatalog(catalogArg);
  if (r.refusal) return r.refusal;
  return asResult(() => {
    const { catalog, digest, evaluator: ev } = r;
    const vocab = catalog.fact_vocabulary;
    if (!isObj(input)) refuse('bad_input', 'input must be an object');
    const extra = Object.keys(input).filter((k) => !['security_policy', 'surfaces', 'facts', 'evidence', 'summary'].includes(k));
    if (extra.length) refuse('bad_input', `unknown input keys: ${extra.join(', ')}`);
    if (input.security_policy !== 2) refuse('bad_input', 'security_policy must be 2');
    if (!isObj(input.facts)) refuse('bad_input', 'facts must be an object');
    if (!isObj(input.evidence)) refuse('bad_input', 'evidence must be an object');
    if (input.summary !== undefined && typeof input.summary !== 'string') refuse('bad_input', 'summary must be a string');
    const surfaces = validateSurfaces(input.surfaces, vocab, { allowFacts: true });
    checkFacts(ev, input.facts, vocab);
    const derived = { boundaries: uniqSorted(surfaces.map((s) => s.kind)), principals: uniqSorted(surfaces.flatMap((s) => s.principals)) };
    for (const k of DERIVED) {
      if (input.facts[k] !== undefined && !sameSet(input.facts[k], derived[k])) {
        refuse('surface_facts_mismatch', `facts.${k} ${JSON.stringify(input.facts[k])} differs from the surfaces' ${JSON.stringify(derived[k])}`);
      }
    }
    checkCitations(ev, input.facts, input.evidence, vocab, Object.keys(vocab).filter((k) => !DERIVED.includes(k)));
    const facts = normFacts(ev, { ...input.facts, ...(vocab.principals ? derived : { boundaries: derived.boundaries }) }, vocab);
    const lower = surfaces.some((s) => s.facts) ? lowerings(r, facts, surfaces) : null;
    return buildSelection(r, catalog, digest, facts, surfaces, lower);
  });
}

// ---------------------------------------------------------------------------------------------------- surface facts (F12a)
const CITE_PATH = /^[A-Za-z0-9_@+.$()[\]-]+(?:\/[A-Za-z0-9_@+.$()[\]-]+)*$/;
const CITE_SYMBOL = /^[A-Za-z_$][\w$.#<>[\]-]*$/;
const PLACEHOLDER = /^(tbd|tba|todo|fixme|n\/?a|na|none|null|nil|unknown|placeholder|example|path|file|symbol|xxx+|-+|\.+|\?+|\*+)$/i;
/** Repository docs that state intent, never the code's behaviour: a citation of them proves nothing (R2). */
const DOCS_ONLY = new Set(['readme.md', 'readme', 'claude.md', 'agents.md', 'changelog.md', 'contributing.md', 'license', 'license.md', 'code_of_conduct.md']);
/**
 * A machine-checkable citation of a surface-level fact: one `path[:symbol]`, repository-relative (no leading '/',
 * no '.' or '..' segment, no whitespace or backslash), the path naming a file (it holds a '/' or a '.'), and no
 * placeholder (TBD, n/a, unknown, ...) as the path, its last segment or the symbol. Null when acceptable.
 */
export function citationProblem(e) {
  if (typeof e !== 'string' || !e.length || e.length > 300 || /\s/.test(e)) return 'a citation is one path[:symbol] with no whitespace (at most 300 characters)';
  const i = e.indexOf(':');
  const path = i < 0 ? e : e.slice(0, i), sym = i < 0 ? null : e.slice(i + 1);
  if (!CITE_PATH.test(path) || path.split('/').some((x) => x === '.' || x === '..')) return `${JSON.stringify(path)} is not a repository-relative path`;
  if (!/[./]/.test(path)) return `${JSON.stringify(path)} does not name a file`;
  if (PLACEHOLDER.test(path) || PLACEHOLDER.test(path.split('/').pop()) || PLACEHOLDER.test(path.split('/').pop().replace(/\.[^.]*$/, ''))) return `${JSON.stringify(path)} is a placeholder`;
  if (sym !== null && (!CITE_SYMBOL.test(sym) || PLACEHOLDER.test(sym))) return `symbol ${JSON.stringify(sym)} is not an identifier`;
  if (sym !== null && sym.length < 3) return `symbol ${JSON.stringify(sym)} is shorter than 3 characters (it would match almost any file)`;
  if (path.split('/').includes('.git')) return `${JSON.stringify(path)} is inside .git, not the repository's code`;
  if (path.split('/').includes('node_modules')) return `${JSON.stringify(path)} is inside node_modules, a dependency, not the repository's code`;
  if (DOCS_ONLY.has(path.split('/').pop().toLowerCase())) return `${JSON.stringify(path)} is a docs-only file (README, CLAUDE.md, ...): cite the code that makes the fact false`;
  return null;
}

/**
 * B3 (F12a): every surface-fact citation of a format-3 block must name a file that EXISTS under `root` and, when it
 * has a `:symbol`, whose text contains that symbol. `root` is the tree the caller checks: the repository working tree
 * at init and preflight (the plan's base), the candidate work tree at gate review, `--repo` for the obligations CLI.
 * At plan time (init, preflight) a cited path under one of `pending` (the DAG nodes' writes: a file the change will
 * create) is deferred; gate review checks it with no pending set. An unreadable root, a missing or non-file path, or a
 * missing symbol -> citation_missing (fail closed). A format-2 block has no surface facts: nothing to check.
 */
export function verifyCitations(block, { root, pending = [] } = {}) {
  return asResult(() => {
    if (!isObj(block) || block.policy !== 3) return { ok: true, code: 'citations_verified', reasons: [], checked: [] };
    let dir = false;
    try { dir = typeof root === 'string' && root.length > 0 && statSync(root).isDirectory(); } catch { dir = false; }
    if (!dir) refuse('citation_missing', `the repository root ${JSON.stringify(root)} cannot be read, so no citation can be verified`);
    const cites = uniqSorted(block.surfaces.filter((x) => isObj(x.evidence)).flatMap((x) => Object.values(x.evidence)));
    const under = (p) => pending.some((w) => p === w || p.startsWith(String(w).replace(/\/+$/, '') + '/'));
    const bad = [], checked = [];
    for (const c of cites) {
      if (citationProblem(c) !== null) { bad.push(`${c}: not a path[:symbol] citation`); continue; }
      const i = c.indexOf(':');
      const path = i < 0 ? c : c.slice(0, i), sym = i < 0 ? null : c.slice(i + 1);
      if (under(path)) continue;
      let text = null;
      try { if (exactCase(root, path) && statSync(join(root, path)).isFile()) text = readFileSync(join(root, path), 'utf8'); } catch { text = null; }
      if (text === null) { bad.push(`${c}: ${path} is not a file in ${root}`); continue; }
      // R2: a gitignored file is not part of the candidate. `git check-ignore` exit 0 = ignored; outside a git repository
      // (exit 128: no ignore rules apply) the file is taken as it is.
      if (spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore', timeout: 15000 }).status === 0) { bad.push(`${c}: ${path} is gitignored, not part of the candidate`); continue; }
      if (sym !== null && !text.includes(sym)) { bad.push(`${c}: ${path} does not contain ${JSON.stringify(sym)}`); continue; }
      checked.push(c);
    }
    if (bad.length) refuse('citation_missing', ...bad);
    return { ok: true, code: 'citations_verified', reasons: [], checked };
  });
}

/** Whether every segment of `path` exists under `root` with exactly that case (case-insensitive file systems agree with Linux). */
function exactCase(root, path) {
  let dir = root;
  for (const seg of path.split('/')) { if (!readdirSync(dir).includes(seg)) return false; dir = join(dir, seg); }
  return true;
}

/** The facts any control's catalog gate names for boundary kind `kind` (what a surface of that kind may lower). */
const gatedFactsOf = (gates, kind) => new Set([...gates.values()].flatMap((m) => [...(m.get(kind) ?? [])]));

/**
 * Validate the surface-level facts of `surfaces` against the normalized change-level `facts`; returns the
 * lowering map for compute(). A surface may only set a BOOLEAN fact from true to false
 * (surface_fact_not_lowerable: a non-bool, a non-false value, a change-level value that is not true, a surface
 * of kind `unknown`), only a fact some catalog gate for its kind names (surface_fact_ungated), with a
 * machine-checkable citation (fact_uncited), and never on every surface: the change-level fact is the OR of
 * its surfaces, so all of them lowering it contradicts the change fact (surface_fact_reinflates).
 */
function lowerings({ catalog, gates }, facts, surfaces) {
  const vocab = catalog.fact_vocabulary;
  const lower = new Map();
  for (const s of surfaces) {
    if (!s.facts) continue;
    if (s.kind === 'unknown') refuse('surface_fact_not_lowerable', `surface ${s.boundary_id}: a surface of kind unknown lowers no fact (its kind selects every control)`);
    const gated = gatedFactsOf(gates, s.kind);
    const m = new Map();
    for (const f of Object.keys(s.facts).sort()) {
      const v = s.facts[f];
      if (!vocab[f]) refuse('fact_out_of_vocabulary', `surface ${s.boundary_id}: unknown fact '${f}'`);
      if (DERIVED.includes(f) || vocab[f].type !== 'bool') refuse('surface_fact_not_lowerable', `surface ${s.boundary_id}: ${f} is not a bool fact`);
      if (v !== false) refuse('surface_fact_not_lowerable', `surface ${s.boundary_id}: ${f} ${JSON.stringify(v)}: a surface may only lower a fact to false`);
      if (facts[f] !== true) refuse('surface_fact_not_lowerable', `surface ${s.boundary_id}: ${f} is ${JSON.stringify(facts[f])} for the change; only a true change fact can be lowered (never unknown)`);
      if (!gated.has(f)) refuse('surface_fact_ungated', `surface ${s.boundary_id}: no catalog not_applicable gate for kind ${s.kind} names ${f}`);
      const problem = citationProblem(s.evidence[f]);
      if (problem) refuse('fact_uncited', `surface ${s.boundary_id}: ${f}: ${problem}`);
      m.set(f, s.evidence[f]);
    }
    lower.set(s.boundary_id, m);
  }
  for (const f of uniqSorted([...lower.values()].flatMap((m) => [...m.keys()]))) {
    if (surfaces.every((s) => lower.get(s.boundary_id)?.has(f))) refuse('surface_fact_reinflates', `every surface lowers ${f}, so the change-level ${f}=true has no surface (the change fact is the OR of its surfaces)`);
  }
  return lower;
}

/** The path-only signal kinds of `path` (no added line): what reassess will see whenever that file changes. */
const pathSignalKinds = (path) => fileKinds({ path: normPath(path), added: [] }, true, null);

function buildSelection(reg, catalog, digest, facts, surfaces, lower = null) {
  const core = compute(reg, facts, surfaces, { lower });
  if (core.unpaired.length) refuse('control_unpaired', `selected with no surface to pair with: ${core.unpaired.join(', ')}`);
  if (lower) {
    // Defence in depth: the effective and the dropped pairs partition exactly the pairs the same facts select without any surface fact.
    const legacy = compute(reg, facts, surfaces).pairs.map((p) => p.pair_id);
    const now = [...core.pairs.map((p) => p.pair_id), ...core.na_pairs.map((p) => p.pair_id)].sort();
    if (canon(now) !== canon(legacy)) refuse('surface_fact_reinflates', 'the surface facts change the pairs beyond dropping some (effective + dropped must equal the pairs without surface facts)');
    // B2: a control the change selects keeps at least one effective pair. Every surface that pairs it lowering its gate is
    // the change fact held by no surface that matters (a "keeper" whose kind cannot pair the control is no keeper).
    const effectiveControls = new Set(core.pairs.map((p) => p.control_id));
    const emptied = uniqSorted(core.na_pairs.map((p) => p.control_id).filter((c) => !effectiveControls.has(c)));
    if (emptied.length) refuse('surface_fact_reinflates', ...emptied.map((c) => `${c} is selected for the change but every pair of it is dropped by a surface fact: some surface that pairs ${c} must keep the fact (else the change-level fact is not true)`));
    for (const [bid, m] of lower) for (const f of m.keys()) {
      if (!core.na_pairs.some((p) => p.boundary_id === bid && p.facts.includes(f))) refuse('surface_fact_ungated', `surface ${bid}: lowering ${f} drops no pair (another gate fact still holds)`);
    }
    for (const p of core.na_pairs) {
      const s = surfaces.find((x) => x.boundary_id === p.boundary_id);
      const hit = pathSignalKinds(s.path).find((k) => (SIGNAL_CLASS[k] ?? []).includes(p.control_id));
      if (hit) refuse('surface_fact_not_lowerable', `surface ${p.boundary_id}: its own path raises a ${hit} signal whose class includes ${p.control_id}, so every reassessment would reopen the pair`);
    }
  }
  const facts_digest = sha(canon(facts));
  const ids = core.controls.map((c) => c.control_id);
  const v3 = lower ? { surfaces, pairs: core.pairs.map((p) => p.pair_id), na_pairs: blockNa(core.na_pairs) } : undefined;
  const sel = {
    ok: true, code: 'selected', reasons: [], tool: 'security-plan', v: 1, security_policy: 2,
    catalog_version: catalog.catalog_version, catalog_digest: digest, facts_digest,
    selection_digest: selectionDigest({ catalog_digest: digest, facts_digest, controls: ids, v3 }),
    controls: core.controls, pairs: core.pairs, excluded: core.excluded, unknown_facts: core.unknown_facts,
    facts, surfaces, ...(lower ? { block_format: 3, na_pairs: core.na_pairs } : {}),
    // Only DAG config keys (validateEngineDag CONFIG_FIELDS): the selected control ids are `controls` above.
    config_fragment: { securityPolicy: 2, catalogDigest: digest,
      controlCoverage: core.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: null, specs: [] })) },
  };
  sel.rows_md = renderSection3a(sel);
  return sel;
}

/** A dropped pair as the block records it: its id, the lowered fact(s) and their citations. */
const blockNa = (na) => na.map((p) => ({ pair_id: p.pair_id, facts: [...p.facts], evidence: { ...p.evidence } }));

// ---------------------------------------------------------------------------------------------------- plan text
/** `security-pairs sha256:<hex>` over canonical JSON {policy:2, catalog_digest, pairs: sorted pair ids}. */
export function pairsLine({ catalogDigest: digest, pairs }) {
  if (!nonEmpty(digest) || !Array.isArray(pairs)) throw new TypeError('pairsLine needs catalogDigest and pairs[]');
  const ids = pairs.map((p) => (typeof p === 'string' ? p : p?.pair_id));
  for (const id of ids) if (!parsePairId(id)) throw new TypeError(`invalid pair id ${JSON.stringify(id)}`);
  return 'security-pairs ' + sha(canon({ policy: 2, catalog_digest: digest, pairs: uniqSorted(ids) }));
}

const BLOCK_RE = /^[ \t]*<!-- security-plan: (.*) -->[ \t]*$/gm;
const PAIRS_LINE_RE = /security-pairs sha256:[0-9a-f]{64}/g;
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const blockJson = (b) => canon(b).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** The plan §3a body: rows, exclusions, unknowns, the pairs line and the machine block. */
export function renderSection3a(sel) {
  const verify = new Map((sel.controls ?? []).map((c) => [c.control_id, c.verify_type]));
  const pairs = sel.pairs.map((p) => p.pair_id);
  if (sel.block_format === 3) return renderFormat3(sel, verify, pairs);
  const block = { policy: 2, catalog_digest: sel.catalog_digest, facts: sel.facts, surfaces: sel.surfaces,
    controls: sel.controls.map((c) => c.control_id), pairs, selection_digest: sel.selection_digest };
  if (!sel.pairs.length && !sel.controls.length) {
    // Nothing selected (a small fix): the compact form, one evidence line, the pairs line and the machine block.
    return [`No security-relevant surface: no changed surface selects a catalog control under the cited facts (policy 2, catalog v${esc(sel.catalog_version)} \`${sel.catalog_digest}\`, selection \`${sel.selection_digest}\`, ${sel.surfaces?.length ?? 0} surface(s), unknown facts: ${sel.unknown_facts?.length ? sel.unknown_facts.join(', ') : 'none'}).`,
      pairsLine({ catalogDigest: sel.catalog_digest, pairs }), `<!-- security-plan: ${blockJson(block)} -->`].join('\n');
  }
  const out = [`Security risk assessment: policy 2, catalog v${esc(sel.catalog_version)} \`${sel.catalog_digest}\`, selection \`${sel.selection_digest}\`.`, ''];
  out.push('| Boundary | Kind | Control | Tier | Verify | Paired by | Why it applies |', '|---|---|---|---|---|---|---|');
  for (const p of sel.pairs) out.push(`| \`${esc(p.boundary_id)}\` | ${esc(p.kind)} | ${p.control_id} | ${p.tier} | ${esc(verify.get(p.control_id) ?? '')} | ${p.paired_by} | ${esc(p.why)} |`);
  out.push('');
  if (sel.excluded?.length) { out.push('Excluded (predicates false for the cited facts):'); for (const e of sel.excluded) out.push(`- ${e.control_id}: ${esc(e.why)}`); out.push(''); }
  out.push(`Unknown facts (their controls stay selected): ${sel.unknown_facts?.length ? sel.unknown_facts.join(', ') : 'none'}.`, '');
  out.push(pairsLine({ catalogDigest: sel.catalog_digest, pairs }));
  out.push(`<!-- security-plan: ${blockJson(block)} -->`);
  return out.join('\n');
}

/**
 * Block format 3 (surface-level facts): the effective pairs (each needs its own RED spec), the pairs dropped by a
 * cited surface fact (each still needs one review row), exclusions, unknowns, the pairs line of the EFFECTIVE
 * pairs only (so init binding keeps its meaning) and the machine block with `policy: 3` (an engine that predates
 * format 3 refuses it outright: its parser accepts policy 2 only).
 */
function renderFormat3(sel, verify, pairs) {
  const block = { policy: 3, catalog_digest: sel.catalog_digest, facts: sel.facts, surfaces: sel.surfaces,
    controls: sel.controls.map((c) => c.control_id), pairs, na_pairs: blockNa(sel.na_pairs), selection_digest: sel.selection_digest };
  const out = [`Security risk assessment: policy 2, block format 3 (surface-level facts), catalog v${esc(sel.catalog_version)} \`${sel.catalog_digest}\`, selection \`${sel.selection_digest}\`.`, ''];
  if (sel.pairs.length) {
    out.push('| Boundary | Kind | Control | Tier | Verify | Paired by | Why it applies |', '|---|---|---|---|---|---|---|');
    for (const p of sel.pairs) out.push(`| \`${esc(p.boundary_id)}\` | ${esc(p.kind)} | ${p.control_id} | ${p.tier} | ${esc(verify.get(p.control_id) ?? '')} | ${p.paired_by} | ${esc(p.why)} |`);
  } else out.push('No effective pair: every selected pair is dropped by a cited surface fact.');
  out.push('', 'Dropped by a cited surface fact (not applicable; each still needs one review row, NOT_APPLICABLE citing the evidence, or FAIL to dispute it):', '');
  out.push('| Boundary | Kind | Control | Tier | Lowered fact | Evidence |', '|---|---|---|---|---|---|');
  for (const p of sel.na_pairs) out.push(`| \`${esc(p.boundary_id)}\` | ${esc(p.kind)} | ${p.control_id} | ${p.tier} | ${p.facts.join(', ')} | ${p.facts.map((f) => `\`${esc(p.evidence[f])}\``).join(', ')} |`);
  out.push('');
  if (sel.excluded?.length) { out.push('Excluded (predicates false for the cited facts):'); for (const e of sel.excluded) out.push(`- ${e.control_id}: ${esc(e.why)}`); out.push(''); }
  out.push(`Unknown facts (their controls stay selected): ${sel.unknown_facts?.length ? sel.unknown_facts.join(', ') : 'none'}.`, '');
  out.push(pairsLine({ catalogDigest: sel.catalog_digest, pairs }));
  out.push(`<!-- security-plan: ${blockJson(block)} -->`);
  return out.join('\n');
}

const RS_BEGIN = '<!-- RUN-STATE:BEGIN -->', RS_END = '<!-- RUN-STATE:END -->';
/** The plan without its RUN-STATE body, so appended events can never add or break a block or pairs line. */
const narrative = (text) => { const b = text.indexOf(RS_BEGIN), e = text.indexOf(RS_END); return b < 0 || e < b ? text : text.slice(0, b + RS_BEGIN.length) + text.slice(e); };
const countBlocks = (text) => (typeof text === 'string' ? [...narrative(text).matchAll(BLOCK_RE)].length : 0);

/**
 * The §3a machine block, verified: exactly one block, well-formed, its selection digest recomputes, every pair
 * names a listed surface and control, and every `security-pairs` line in the plan equals the block's. Else null.
 * `opts.alreadyCut: true` means the caller passes text whose RUN-STATE region it already removed (test-kinds.mjs
 * planNarrative): no second cut is applied, so one narrative interpretation holds. Default: unchanged.
 */
export function parsePlanSecurityBlock(planText, opts = {}) {
  if (typeof planText !== 'string') return null;
  if (opts?.alreadyCut === true) {
    // uncut text passed by mistake would expose the RUN-STATE body: an exact marker line left in it is a refusal
    if (planText.split('\n').some((l) => l.trim() === RS_BEGIN || l.trim() === RS_END)) return null;
  } else planText = narrative(planText);
  const m = [...planText.matchAll(BLOCK_RE)];
  if (m.length !== 1) return null;
  let b;
  try { b = JSON.parse(m[0][1]); } catch { return null; }
  if (isObj(b) && b.policy === 3) return parseFormat3(b, planText);
  if (!isObj(b) || b.policy !== 2 || typeof b.catalog_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(b.catalog_digest)) return null;
  if (!isObj(b.facts) || !Array.isArray(b.surfaces) || !Array.isArray(b.controls) || !Array.isArray(b.pairs) || typeof b.selection_digest !== 'string') return null;
  if (!b.surfaces.every((s) => isObj(s) && nonEmpty(s.boundary_id) && typeof s.kind === 'string' && nonEmpty(s.path) && Array.isArray(s.principals))) return null;
  if (!b.controls.every((c) => typeof c === 'string' && CONTROL_ID.test(c)) || canon(b.controls) !== canon(uniqSorted(b.controls))) return null;
  if (canon(b.pairs) !== canon(uniqSorted(b.pairs))) return null;
  const sids = new Set(b.surfaces.map((s) => s.boundary_id));
  for (const p of b.pairs) { const q = parsePairId(p); if (!q || !sids.has(q.boundary_id) || !b.controls.includes(q.control_id)) return null; }
  if (!b.controls.every((c) => b.pairs.some((p) => parsePairId(p).control_id === c))) return null;
  if (selectionDigest({ catalog_digest: b.catalog_digest, facts_digest: sha(canon(b.facts)), controls: b.controls }) !== b.selection_digest) return null;
  const lines = planText.match(PAIRS_LINE_RE) ?? [];
  const want = pairsLine({ catalogDigest: b.catalog_digest, pairs: b.pairs });
  if (!lines.length || !lines.every((l) => l === want)) return null;
  return { policy: 2, catalog_digest: b.catalog_digest, facts: b.facts, surfaces: b.surfaces, controls: b.controls, pairs: b.pairs, selection_digest: b.selection_digest };
}

const BLOCK3_KEYS = ['catalog_digest', 'controls', 'facts', 'na_pairs', 'pairs', 'policy', 'selection_digest', 'surfaces'];
/**
 * Block format 3: exactly its keys; each surface's optional `facts` (every value false) cite a machine-checkable
 * path each; `na_pairs` sorted and unique, disjoint from `pairs`, each on a listed surface with the facts it names
 * lowered there and the same citations; every control of `controls` has an effective pair; the v3 selection
 * digest recomputes; every pairs line equals the one of the EFFECTIVE pairs. Whether the drops follow from the
 * catalog is checked where the catalog is loaded (reassess, obligationMatrix). Else null.
 */
function parseFormat3(b, planText) {
  if (canon(Object.keys(b).sort()) !== canon(BLOCK3_KEYS) || typeof b.catalog_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(b.catalog_digest)) return null;
  if (!isObj(b.facts) || !Array.isArray(b.surfaces) || !Array.isArray(b.controls) || !Array.isArray(b.pairs) || !Array.isArray(b.na_pairs) || typeof b.selection_digest !== 'string') return null;
  const sids = new Map();
  for (const s of b.surfaces) {
    if (!isObj(s) || !nonEmpty(s.boundary_id) || typeof s.kind !== 'string' || !nonEmpty(s.path) || !Array.isArray(s.principals) || sids.has(s.boundary_id)) return null;
    if (Object.keys(s).some((k) => !['boundary_id', 'kind', 'path', 'principals', 'facts', 'evidence'].includes(k))) return null;
    if (s.facts !== undefined || s.evidence !== undefined) {
      if (!isObj(s.facts) || !isObj(s.evidence) || !Object.keys(s.facts).length || canon(Object.keys(s.facts).sort()) !== canon(Object.keys(s.evidence).sort())) return null;
      if (!Object.entries(s.facts).every(([f, v]) => v === false && citationProblem(s.evidence[f]) === null)) return null;
    }
    sids.set(s.boundary_id, s);
  }
  if (!b.controls.every((c) => typeof c === 'string' && CONTROL_ID.test(c)) || canon(b.controls) !== canon(uniqSorted(b.controls))) return null;
  if (canon(b.pairs) !== canon(uniqSorted(b.pairs))) return null;
  for (const p of b.pairs) { const q = parsePairId(p); if (!q || !sids.has(q.boundary_id) || !b.controls.includes(q.control_id)) return null; }
  if (!b.controls.every((c) => b.pairs.some((p) => parsePairId(p).control_id === c))) return null;
  const naIds = b.na_pairs.map((n) => n?.pair_id);
  if (!naIds.length || canon(naIds) !== canon(uniqSorted(naIds)) || naIds.some((id) => b.pairs.includes(id))) return null;
  for (const n of b.na_pairs) {
    if (!isObj(n)) return null;
    const q = parsePairId(n.pair_id), s = q && sids.get(q.boundary_id);
    if (!s?.facts || canon(Object.keys(n).sort()) !== canon(['evidence', 'facts', 'pair_id']) || !Array.isArray(n.facts) || !n.facts.length
      || canon(n.facts) !== canon(uniqSorted(n.facts)) || !isObj(n.evidence) || canon(Object.keys(n.evidence).sort()) !== canon(n.facts)) return null;
    if (!n.facts.every((f) => s.facts[f] === false && n.evidence[f] === s.evidence[f])) return null;
  }
  const v3 = { surfaces: b.surfaces, pairs: b.pairs, na_pairs: b.na_pairs };
  if (selectionDigest({ catalog_digest: b.catalog_digest, facts_digest: sha(canon(b.facts)), controls: b.controls, v3 }) !== b.selection_digest) return null;
  const lines = planText.match(PAIRS_LINE_RE) ?? [];
  const want = pairsLine({ catalogDigest: b.catalog_digest, pairs: b.pairs });
  if (!lines.length || !lines.every((l) => l === want)) return null;
  return { policy: 3, catalog_digest: b.catalog_digest, facts: b.facts, surfaces: b.surfaces, controls: b.controls, pairs: b.pairs,
    na_pairs: b.na_pairs, selection_digest: b.selection_digest };
}

/** The lowering map of a block format 3 (null for format 2): Map(boundary_id -> Map(fact -> citation)). */
const blockLowering = (block) => (block?.policy === 3
  ? new Map(block.surfaces.filter((s) => s.facts).map((s) => [s.boundary_id, new Map(Object.keys(s.facts).sort().map((f) => [f, s.evidence[f]]))])) : null);

/** Approved pairs united with every addendum's pairs: add-only by construction. Malformed pair ids throw. */
export function effectiveSet(approvedBlock, addenda = []) {
  const all = [...(approvedBlock?.pairs ?? [])];
  if (!Array.isArray(addenda)) throw new TypeError('addenda must be an array');
  for (const a of addenda) { if (!isObj(a) || !Array.isArray(a.pairs)) throw new TypeError('addendum needs pairs[]'); all.push(...a.pairs); }
  for (const p of all) if (!parsePairId(p)) throw new TypeError(`invalid pair id ${JSON.stringify(p)}`);
  return uniqSorted(all);
}

// ---------------------------------------------------------------------------------------------------- accountability (F12a)
/**
 * The dispositions of one surface x control cell. proven: an effective pair (approved or added by a trusted
 * addendum; its own RED spec must prove it); waived: an effective pair a trusted SECURITY_WAIVER of the candidate
 * accepts (the ONLY risk acceptance); dropped-by-fact: dropped by a cited surface-level fact (block format 3);
 * dropped-by-kind: the control is selected for the change but the catalog's not_applicable reason excludes this
 * surface's kind; excluded-by-change-fact: the change-level facts select no pair here (the control is in
 * excluded[], or this kind's catalog gate names only facts that are false for the change).
 */
export const DISPOSITIONS = ['proven', 'waived', 'dropped-by-fact', 'dropped-by-kind', 'excluded-by-change-fact'];

/**
 * Check a matrix: exactly one cell per (surface, catalog control) and per extra effective pair, each with a
 * disposition of DISPOSITIONS; a dropped-by-fact cell names its facts and their citations. Refusals:
 * disposition_unknown, disposition_duplicate, disposition_missing (in that order). -> { ok:true } | refusal.
 */
export function verifyMatrix(matrix, { surfaces = [], controls = [] } = {}) {
  return asResult(() => {
    if (!Array.isArray(matrix)) refuse('disposition_missing', 'the matrix must be an array of cells');
    const bad = matrix.filter((c) => !isObj(c) || !DISPOSITIONS.includes(c.disposition) || !nonEmpty(c.boundary_id) || typeof c.control_id !== 'string' || !CONTROL_ID.test(c.control_id)
      || (c.disposition === 'dropped-by-fact' && !(Array.isArray(c.facts) && c.facts.length && isObj(c.evidence) && c.facts.every((f) => citationProblem(c.evidence[f]) === null))));
    if (bad.length) refuse('disposition_unknown', ...bad.map((c) => `cell ${JSON.stringify(c)} has no known disposition (or a dropped-by-fact cell without cited facts)`));
    const seen = new Map();
    for (const c of matrix) seen.set(`${c.boundary_id}:${c.control_id}`, (seen.get(`${c.boundary_id}:${c.control_id}`) ?? 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    if (dup.length) refuse('disposition_duplicate', ...dup.map((k) => `${k} has more than one disposition`));
    const missing = surfaces.flatMap((s) => controls.map((c) => `${s}:${c}`)).filter((k) => !seen.has(k));
    if (missing.length) refuse('disposition_missing', ...missing.map((k) => `${k} has no disposition`));
    return { ok: true, code: 'matrix_complete', reasons: [] };
  });
}

/**
 * The full surface x control obligation matrix of an approved block (format 2 or 3), standalone (no engine module,
 * runnable in the manual flow): `addenda` are the pair ids trusted SECURITY_ADDENDUMs added, `waived` the pair ids
 * trusted SECURITY_WAIVERs accept for the candidate (each must be effective, else ignored as waiverState does).
 * Each cell is derived independently from the block and the catalog: a cell the block both pairs and drops, a
 * dropped pair the catalog would not pair, or an obligated cell neither paired nor dropped fails closed.
 * -> { ok:true, code:'obligations', matrix, counts } | refusal (catalog_*, plan_block_invalid, disposition_*).
 */
export function obligationMatrix(catalogArg, block, { addenda = [], waived = [] } = {}) {
  const r = resolveCatalog(catalogArg);
  if (r.refusal) return r.refusal;
  const res = asResult(() => {
    const { catalog, digest, evaluator: ev, gates } = r;
    if (!isObj(block) || ![2, 3].includes(block.policy)) refuse('plan_block_invalid', 'obligationMatrix needs a parsed security-plan block');
    if (block.catalog_digest !== digest) refuse('catalog_invalid', `the block was selected against ${block.catalog_digest}, the loaded catalog is ${digest}`);
    try { checkFacts(ev, block.facts, catalog.fact_vocabulary); } catch { refuse('plan_block_invalid', 'block facts are outside the vocabulary'); }
    if (!Array.isArray(addenda) || !Array.isArray(waived) || ![...addenda, ...waived].every((p) => parsePairId(p))) refuse('bad_input', 'addenda and waived are pair id lists');
    if (block.policy === 3) replayFormat3(r, block);
    const legacy = new Set(compute(r, block.facts, block.surfaces).pairs.map((p) => p.pair_id));
    const change = new Set(ev.selected(catalog, block.facts));
    const effective = new Set([...block.pairs, ...addenda]);
    const waivedSet = new Set(waived.filter((p) => effective.has(p)));
    const na = new Map((block.na_pairs ?? []).map((n) => [n.pair_id, n]));
    const matrix = [];
    const cellOf = (s, c) => {
      const id = `${s.boundary_id}:${c.id}`;
      if (effective.has(id)) {
        if (na.has(id) && block.pairs.includes(id)) refuse('disposition_duplicate', `${id}: the block both pairs and drops it`);
        return { disposition: waivedSet.has(id) ? 'waived' : 'proven', ...(na.has(id) ? { reopened: true } : {}) };
      }
      if (na.has(id)) {
        if (!legacy.has(id)) refuse('disposition_duplicate', `${id}: dropped-by-fact, but the catalog never pairs it here (it is also dropped-by-kind or excluded)`);
        const n = na.get(id);
        return { disposition: 'dropped-by-fact', facts: [...n.facts], evidence: { ...n.evidence } };
      }
      if (legacy.has(id)) refuse('disposition_missing', `${id}: the catalog pairs it under the block facts, but it is neither effective nor dropped by a cited fact`);
      if (!change.has(c.id)) return { disposition: 'excluded-by-change-fact', why: ev.why(c.applies_when, block.facts) };
      const g = gates.get(c.id)?.get(s.kind);
      if (g instanceof Set) return { disposition: 'excluded-by-change-fact', facts: [...g].sort(), why: `${s.kind} is gated by ${[...g].sort().join(' or ')}, false for the change` };
      if (g === null) return { disposition: 'dropped-by-kind', why: `catalog not_applicable.${s.kind}` };
      refuse('disposition_missing', `${id}: ${c.id} is selected for the change, not paired with ${s.kind}, and the catalog gives no not_applicable reason`);
    };
    for (const s of block.surfaces) for (const c of catalog.controls) matrix.push({ boundary_id: s.boundary_id, kind: s.kind, control_id: c.id, ...cellOf(s, c) });
    const sids = new Set(block.surfaces.map((s) => s.boundary_id));
    for (const id of [...effective].sort()) {
      const q = parsePairId(id);
      if (!sids.has(q.boundary_id)) matrix.push({ boundary_id: q.boundary_id, kind: null, control_id: q.control_id, disposition: waivedSet.has(id) ? 'waived' : 'proven', extra: true });
    }
    const check = verifyMatrix(matrix, { surfaces: [...sids], controls: catalog.controls.map((c) => c.id) });
    if (!check.ok) refuse(check.code, ...check.reasons);
    const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, matrix.filter((c) => c.disposition === d).length]));
    return { ok: true, code: 'obligations', reasons: [], block_format: block.policy, matrix, counts, matrix_digest: sha(canon(matrix)) };
  });
  return res;
}

/** The approved-plan digest: sha256 of the plan with the RUN-STATE body removed (markers kept adjacent). */
export const planDigest = (text) => sha(narrative(text));

// ---------------------------------------------------------------------------------------------------- signals
const DEP_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lockb', 'bun.lock', 'deno.json', 'deno.lock', 'pipfile', 'pipfile.lock', 'poetry.lock', 'pyproject.toml', 'setup.py', 'setup.cfg', 'uv.lock',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'packages.lock.json', 'directory.packages.props', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock', 'podfile', 'podfile.lock']);
/**
 * C5 (F12a, block format 3 ONLY: a format-2 run keeps origin/main's detector byte for byte, pinned by
 * security-plan-legacy.golden.json). A format-3 run narrows the surface-introducing signals in exactly three
 * places, and every narrowing that applies is RECORDED (`c5_exempted`: path, signal, rule), never silent:
 * - rule `test-file`, auth-or-middleware-change: a test-named file (TEST_FILE) raises none, unless its path is under a
 *   router root or a middleware/plugins root (MIDDLEWARE_ROOT: Nitro loads every file in middleware/, @fastify/autoload
 *   every file in plugins/);
 * - rule `test-file`, new-route: a test-named file raises none, unless its path is under a router root
 *   (ROUTER_ROOT: any `routes/`, `route/`, `pages/`, `api/`, `controllers/`, `handlers/`, `endpoints/`, `webhooks/`,
 *   `functions/` segment, or `server/api|routes|middleware/`): file-system routers (React Router / Remix flatRoutes,
 *   TanStack, SolidStart, SvelteKit, Next.js pages/, Nitro, Vercel api/) serve every file there, test-named or not;
 * - a path whose only route evidence is a workspace project folder named `api` (`apps|packages|services|libs|
 *   modules|projects/api/`) raises an OPEN `possible-route` signal instead of `new-route` (R2): it is never silent and
 *   needs a classification (a reason may close it, recorded in classifications_used), but no inventory surface. Its
 *   routes/, controllers/, ... subfolders, a nested api/, an `api.*` file and every added route line (format 3 adds
 *   fastify/hono/elysia verbs and tRPC procedures) still raise `new-route`.
 * After R2 every exemption that applies is a test-named file; exemptionRefusal() refuses any other record (fail closed).
 * migration-or-rls-change is NEVER narrowed: migration runners select by directory and name, not by import.
 * A test-named file is ONLY: `*.test.*`, `*.spec.*`, `*.e2e-spec.*`, `*_test|_spec.<go|py|rb|ex|exs>`, `test_*.py`,
 * or a path under `__tests__/`, `__mocks__/` or `__fixtures__/`.
 */
const TEST_FILE = /(^|\/)(__tests__|__mocks__|__fixtures__)\/|\.(test|spec|e2e-spec)\.[a-z0-9]+$|_test\.(go|py|rb|exs)$|_spec\.rb$|(^|\/)test_[^/]+\.py$/;
/** Directories whose files a framework loads as middleware or plugins (Nitro middleware/, @fastify/autoload plugins/): never exempt. */
const MIDDLEWARE_ROOT = /(^|\/)(middlewares?|plugins)\//;
const ROUTER_ROOT = /(^|\/)(routes?|pages|api|controllers?|handlers?|endpoints?|webhooks?|functions)\/|(^|\/)server\/(api|routes|middleware)\//;
/** A test-named file outside every router root (format 3: such a file raises no new-route or auth signal; recorded). */
export const isTestPath = (p) => { const q = String(p).toLowerCase(); return TEST_FILE.test(q) && !ROUTER_ROOT.test(q); };
const WORKSPACE_API = /(^|\/)(apps|packages|services|libs|modules|projects)\/api\//g;
const ROUTE_DIR = /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|webhooks?)(\/|\.)/;
const ROUTE_FILE = /^(route|\+server|\+page\.server)\.[cm]?[jt]sx?$/;
/** Format-3 extra route registrations (fastify / hono / elysia verbs, tRPC procedures): so the workspace-api narrowing cannot blind them. */
const ROUTE_LINE_V3 = /\b(fastify|instance|hono|elysia)\.(get|post|put|patch|delete|all|route|head|options)\s*\(|[Pp]rocedure\b.*\.(query|mutation|subscription)\s*\(/;
/** [kind, path test, added-line test]: mechanical patterns only; a match creates a signal, never a control. */
const RULES = [
  ['new-dependency', (p, b) => DEP_FILES.has(b) || /^requirements[\w.-]*\.txt$/.test(b) || /\.csproj$/.test(b), null],
  ['migration-or-rls-change', (p) => /(^|\/)(migrations?|migrate)\//.test(p) || /\.sql$/.test(p),
    /\b(create|alter|drop)\s+policy\b|row\s+level\s+security|security\s+definer/i],
  ['infra-or-ci-config', (p, b) => /^\.github\/workflows\//.test(p) || /^\.circleci\//.test(p) || /\.(tf|tfvars|hcl)$/.test(b)
    || /(^|\/)(terraform|infra|k8s|kubernetes|helm|deploy|deployment)\//.test(p)
    || /^(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|jenkinsfile|bitbucket-pipelines\.ya?ml|dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|wrangler\.(toml|json|jsonc)|vercel\.json|netlify\.toml|fly\.toml|render\.yaml|serverless\.ya?ml|firebase\.json|procfile|nginx\.conf|\.htaccess)$/.test(b), null],
  ['env-or-secret-reference', (p, b) => /^\.env(\..*)?$/.test(b) || /(^|\/)secrets?(\/|\.)/.test(p),
    /\bprocess\.env\b|\bimport\.meta\.env\b|\bDeno\.env\b|\bos\.environ\b|\bgetenv\s*\(|\bENV\[|\$\{\{\s*secrets\.|\bsecrets\.[A-Z_]/],
  ['auth-or-middleware-change', (p) => /(^|\/)(auth|authn|authz|middlewares?|sessions?|guards?|policies|permissions|rbac|login|oauth)(\/|\.|-|_)/.test(p), null],
  ['new-route', (p, b) => ROUTE_DIR.test(p) || ROUTE_FILE.test(b),
    /\b(app|router|server|api|route)\.(get|post|put|patch|delete|all|route)\s*\(|@(Get|Post|Put|Patch|Delete|All|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/],
  ['mail-or-notification-send', (p, b) => /(mail|notif|sms|push)/.test(b),
    /\b(send_?mail|send_?email|send_?sms|send_?push|send_?notification|nodemailer|createTransport|resend\.emails|sgMail|sendgrid|mailgun|postmark|twilio|SendEmailCommand|ses\.send|messages\.create|web-?push)\b/i],
  ['payment-or-stock-or-wallet-call', (p, b) => /(payment|billing|checkout|invoice|stripe|paymob|paypal|wallet|stock|inventory|quota|credit|refund|coupon)/.test(b),
    /\b(stripe|paymob|paypal|braintree|adyen|checkout\.sessions|paymentIntents|charges\.create|refunds?\.create|wallet|reserve_?stock|release_?stock|decrement_?stock|stock|inventory|quota|credits?)\b/i],
];
/** The controls an approved surface at the signal's path must already carry for the signal to need no classification. */
const SIGNAL_CLASS = {
  'mail-or-notification-send': ['VAPT-ABUSE-02', 'VAPT-ABUSE-03'],
  'payment-or-stock-or-wallet-call': ['VAPT-ABUSE-04', 'VAPT-ABUSE-05', 'VAPT-ABUSE-07'],
  'env-or-secret-reference': ['VAPT-CFG-03'],
  'migration-or-rls-change': ['VAPT-API-01', 'VAPT-ABUSE-07'],
  'auth-or-middleware-change': ['VAPT-API-02', 'VAPT-API-03', 'VAPT-CFG-04', 'VAPT-ABUSE-08'],
  'new-route': ['VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03'],
  'new-dependency': null,
  'infra-or-ci-config': null,
  'possible-route': null, // format 3 only (R2): never mechanical, a classification (a reason suffices) closes it
};

function normFiles(files) {
  if (!Array.isArray(files)) refuse('bad_input', 'changed files must be an array');
  return files.map((f) => {
    if (typeof f === 'string' && nonEmpty(f)) return { path: inputPath(f, 'changed file'), added: [] };
    if (!isObj(f) || !nonEmpty(f.path) || (f.added !== undefined && (!Array.isArray(f.added) || !f.added.every((l) => typeof l === 'string')))) {
      refuse('bad_input', `changed file ${JSON.stringify(f)} needs path and optional added[] of strings`);
    }
    return { path: inputPath(f.path, 'changed file'), added: f.added ?? [] };
  });
}

/**
 * Signal kinds that can introduce a new boundary: off every approved surface no classification (a reason or
 * cited facts) dismisses one; it closes only through an inventory surface at its path (see `reassess`).
 */
export const SURFACE_SIGNALS = ['new-route', 'auth-or-middleware-change', 'migration-or-rls-change'];

/**
 * Mechanical signals over changed paths and their added lines: [{id, kind, path, class|null}], sorted by id.
 * class 'approved-pairs': a surface at that path (approved, or in the candidate's inventory) already carries
 * every control of the signal's class in an effective pair; 'inventory-surface': an inventory surface at that
 * path selects every such control (its pairs are computed, and reported as delta_pairs when not yet effective);
 * else null (open: `reassess` decides whether a classification may close it).
 */
export function reassessSignals({ paths = [], approvedPairs = [], approvedSurfaces = [], catalog, inventorySurfaces = [], inventoryPairs = [], c5 = false, exempted = null } = {}) {
  const files = asResult(() => normFiles(paths));
  if (files.ok === false) throw new TypeError(files.reasons.join('; '));
  const ids = new Set((catalog?.controls ?? []).map((c) => c.id));
  const idOf = (p) => (typeof p === 'string' ? p : p?.pair_id);
  const paired = new Set(approvedPairs.map(idOf));
  const selectedHere = new Set(inventoryPairs.map(idOf));
  const carries = (surfaces, set, cls) => surfaces.length > 0 && cls.every((c) => surfaces.some((s) => set.has(`${s.boundary_id}:${c}`)));
  const out = new Map();
  for (const f of files) {
    for (const kind of fileKinds(f, c5, exempted)) {
      const id = `${kind}@${f.path}`;
      const cls = SIGNAL_CLASS[kind];
      const mechanical = Array.isArray(cls) && cls.every((c) => ids.has(c));
      const at = (list) => list.filter((s) => normPath(s.path) === f.path);
      const here = [...at(approvedSurfaces), ...at(inventorySurfaces)];
      const cls2 = !mechanical ? null : carries(here, paired, cls) ? 'approved-pairs'
        : carries(at(inventorySurfaces), selectedHere, cls) ? 'inventory-surface' : null;
      out.set(id, { id, kind, path: f.path, class: cls2 });
    }
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The signal kinds one changed file raises, in RULES order. `c5` false: origin/main's detector, unchanged. `c5` true
 * (block format 3): the same detector plus ROUTE_LINE_V3, minus the C5 narrowings, each one pushed onto `exempted`
 * ({ path, kind, rule }) when given.
 */
function fileKinds(f, c5, exempted) {
  const b = f.path.split('/').pop().toLowerCase();
  const p = f.path.toLowerCase();
  const kinds = [];
  for (const [kind, pathTest, lineTest] of RULES) {
    const byPath = pathTest(p, b), byLine = Boolean(lineTest) && f.added.some((l) => lineTest.test(l));
    const byLineV3 = c5 && kind === 'new-route' && f.added.some((l) => ROUTE_LINE_V3.test(l));
    if (!(byPath || byLine || byLineV3)) continue;
    if (c5) {
      const test = TEST_FILE.test(p);
      const rule = kind === 'auth-or-middleware-change' && test && !ROUTER_ROOT.test(p) && !MIDDLEWARE_ROOT.test(p) ? 'test-file'
        : kind === 'new-route' && test && !ROUTER_ROOT.test(p) ? 'test-file' : null;
      if (rule) { exempted?.push({ path: f.path, kind, rule }); continue; }
      // R2: a workspace api/ folder alone is no route directory, but the file is never silent: an open possible-route signal.
      if (kind === 'new-route' && !byLine && !byLineV3 && !ROUTE_DIR.test(p.replace(WORKSPACE_API, '$1$2/')) && !ROUTE_FILE.test(b)) { kinds.push('possible-route'); continue; }
    }
    kinds.push(kind);
  }
  return kinds;
}

/**
 * R2: every C5 exemption record must be of a test-named file; any other record (a narrowing of a production file) is
 * refused surface_inventory_incomplete, so no exemption can silently drop a deployed file. Null when consumed.
 */
export function exemptionRefusal(records) {
  const bad = (records ?? []).filter((e) => !TEST_FILE.test(String(e?.path ?? '').toLowerCase()));
  return bad.length ? { ok: false, code: 'surface_inventory_incomplete', reasons: bad.map((e) => `${e?.path}: ${e?.kind} narrowed by ${e?.rule}, but it is not a test file`) } : null;
}

/** Exemption records, unique and sorted by path, signal kind. */
const dedupExempt = (xs) => [...new Map(xs.map((e) => [`${e.path}\u0000${e.kind}`, e])).values()].sort((a, b) => (a.path + a.kind < b.path + b.kind ? -1 : 1));

/**
 * Surface-inventory completeness (C5, F12a, block format 3): every path of `files` (path strings, or {path, added[]})
 * that raises a surface-introducing signal under the format-3 detector (the one reassess uses) must be the path of a
 * listed surface. Returns the gaps [{ path, kinds }]; the C5 narrowings it applied go to `exempted` (never silent).
 */
export function inventoryGaps({ files = [], surfacePaths = [], exempted = null } = {}) {
  const listed = new Set(surfacePaths.map(normPath));
  const sigs = reassessSignals({ paths: files, c5: true, exempted }).filter((s) => SURFACE_SIGNALS.includes(s.kind) && !listed.has(s.path));
  const by = new Map();
  for (const s of sigs) by.set(s.path, uniqSorted([...(by.get(s.path) ?? []), s.kind]));
  return [...by].map(([path, kinds]) => ({ path, kinds })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------- reassess
function globRe(glob) {
  let g = normPath(glob);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Monotone merge: unknown beats true beats false; enums union. Never lowers a fact. */
function mergeFacts(ev, vocab, base, add) {
  const out = { ...base };
  for (const [k, a] of Object.entries(add)) {
    const b = out[k];
    if (ev.unknownish(a) || ev.unknownish(b)) out[k] = 'unknown';
    else if (vocab[k].type === 'bool') out[k] = b === true || a === true;
    else out[k] = uniqSorted([...(Array.isArray(b) ? b : []), ...a]);
  }
  return out;
}

function validateClassifications(ev, list, vocab) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) refuse('bad_input', 'classifications must be an array');
  const seen = new Set();
  return list.map((c) => {
    if (!isObj(c) || !nonEmpty(c.signal_id)) refuse('bad_input', 'a classification needs signal_id');
    if (seen.has(c.signal_id)) refuse('bad_input', `duplicate classification ${c.signal_id}`);
    seen.add(c.signal_id);
    const facts = c.facts ?? {}, evidence = c.evidence ?? {};
    if (!isObj(facts) || !isObj(evidence) || (c.reason !== undefined && typeof c.reason !== 'string')) refuse('bad_input', `classification ${c.signal_id} is malformed`);
    if (!Object.keys(facts).length && !nonEmpty(c.reason)) refuse('bad_input', `classification ${c.signal_id} needs facts or a reason`);
    if (DERIVED.some((k) => k in facts)) refuse('bad_input', `classification ${c.signal_id}: boundaries and principals come from the inventory`);
    checkFacts(ev, facts, vocab);
    checkCitations(ev, facts, evidence, vocab, Object.keys(facts));
    return { signal_id: c.signal_id, facts, reason: c.reason ?? null };
  });
}

/**
 * Replay a block format 3 under the loaded catalog: select again from its own facts and surfaces (every
 * surface-fact rule of lowerings() and buildSelection() re-applied) and require the same selection digest, so a
 * hand-edited lowering (an unknown or false change fact, an ungated fact, a drop the evaluator does not make)
 * never binds. Refusal -> plan_block_invalid naming the rule.
 */
function replayFormat3(r, block) {
  const vocab = r.catalog.fact_vocabulary;
  let again;
  try {
    const surfaces = validateSurfaces(block.surfaces, vocab, { allowFacts: true });
    again = buildSelection(r, r.catalog, r.digest, block.facts, surfaces, lowerings(r, block.facts, surfaces));
  } catch (e) {
    if (e instanceof Refusal) refuse('plan_block_invalid', `block surface facts do not replay (${e.code}): ${e.reasons.join('; ')}`);
    throw e;
  }
  if (again.selection_digest !== block.selection_digest || canon(again.pairs.map((p) => p.pair_id)) !== canon(block.pairs)
    || canon(blockNa(again.na_pairs)) !== canon(block.na_pairs)) refuse('plan_block_invalid', 'block dropped pairs do not follow from its facts, surfaces and the catalog gates');
}

const surfaceKey = (s) => canon([s.kind, normPath(s.path), uniqSorted(s.principals)]);
/**
 * The candidate's surfaces: the approved block's surfaces united with the (validated) inventory's, sorted by
 * boundary_id. An inventory surface identical to an approved one is that surface; one that reuses an approved
 * boundary id with another kind, path or principals is refused (bad_input), so an approved id's pairs can never
 * cover a new path. The result is the same whether or not the caller already listed the approved surfaces.
 */
function withApprovedSurfaces(approved, inventory) {
  const byId = new Map(inventory.map((s) => [s.boundary_id, s]));
  const out = [...inventory];
  for (const a of approved) {
    const s = byId.get(a.boundary_id);
    if (!s) { out.push({ boundary_id: a.boundary_id, kind: a.kind, path: normPath(a.path), principals: uniqSorted(a.principals) }); continue; }
    if (surfaceKey(s) !== surfaceKey(a)) refuse('bad_input', `inventory surface ${a.boundary_id} redefines the approved surface (kind, path or principals differ); give a new boundary a new id`);
  }
  return out.sort((a, b) => (a.boundary_id < b.boundary_id ? -1 : a.boundary_id > b.boundary_id ? 1 : 0));
}

/**
 * Reassess an approved plan against the candidate. input = { plan: <plan text>, catalog: loadCatalog() result,
 * inventory: {candidate_id?, surfaces[]} | surfaces[], changed: {contract_paths[], files: [path | {path, added?[]}]},
 * classifications?: [{signal_id, facts?, evidence?, reason?}], addenda?: [{pairs[], ...}], candidate_id? }.
 * REAPPROVAL (catalog digest changed, or a path outside the contract) precedes classification_missing; delta_pairs
 * is computed on every outcome.
 */
export function reassess(input = {}) {
  const r = resolveCatalog(input.catalog);
  if (r.refusal) return r.refusal;
  let unclassifiedSignals = null;
  const res = asResult(() => {
    const { catalog, digest, evaluator: ev } = r;
    const vocab = catalog.fact_vocabulary;
    if (typeof input.plan !== 'string') refuse('bad_input', 'plan text required');
    const nBlocks = countBlocks(input.plan);
    if (!nBlocks) refuse('plan_block_missing', 'the plan has no <!-- security-plan: --> block in §3a');
    const block = parsePlanSecurityBlock(input.plan);
    if (!block) refuse('plan_block_invalid', nBlocks > 1 ? 'more than one security-plan block' : 'the security-plan block is malformed or inconsistent');
    const inv = Array.isArray(input.inventory) ? { surfaces: input.inventory } : input.inventory;
    if (!isObj(inv)) refuse('bad_input', 'inventory must be {surfaces[]} or an array');
    const surfaces = withApprovedSurfaces(block.surfaces, validateSurfaces(inv.surfaces, vocab));
    const changed = input.changed;
    if (!isObj(changed) || !Array.isArray(changed.contract_paths) || !changed.contract_paths.length || !changed.contract_paths.every(nonEmpty)) {
      refuse('bad_input', 'changed.contract_paths (the Design Contract paths) is required');
    }
    const files = normFiles(changed.files);
    const contract = changed.contract_paths.map(globRe);
    const addenda = input.addenda ?? [];
    let effective;
    try { effective = effectiveSet(block, addenda); } catch (e) { refuse('bad_input', String(e.message)); }

    // The approved block must still reproduce its own pairs under the same catalog.
    if (block.catalog_digest === digest) {
      try { checkFacts(ev, block.facts, vocab); } catch { refuse('plan_block_invalid', 'block facts are outside the vocabulary'); }
      const again = compute(r, block.facts, block.surfaces, { lower: blockLowering(block) });
      if (canon(again.pairs.map((p) => p.pair_id)) !== canon(block.pairs)) refuse('plan_block_invalid', 'block pairs do not follow from its facts and surfaces');
      if (block.policy === 3) replayFormat3(r, block);
    }

    // Block format 3: an approved dropped pair REOPENS (it stays out of `pairs`, so it becomes a delta pair) whenever
    // a changed path of an approved surface raises a signal whose class names its control, whatever any
    // classification says (`keep`, from the signal kinds alone), and whenever a used classification raises a
    // lowered fact (true or unknown) or the merged change fact is no longer true (`lowerNow` below).
    const lowerApproved = blockLowering(block);
    let keep = null;
    if (lowerApproved) {
      keep = new Set();
      for (const s of reassessSignals({ paths: files, c5: true })) {
        for (const a of block.surfaces) if (normPath(a.path) === s.path) for (const c of SIGNAL_CLASS[s.kind] ?? []) keep.add(`${a.boundary_id}:${c}`);
      }
    }
    // The pairs the inventory's surfaces select under the approved facts (classifications only add to these):
    // a new surface at a signal's path closes the signal, and its pairs not yet effective become delta_pairs.
    const surfaceFacts = (base) => normFacts(ev, { ...base, boundaries: uniqSorted(surfaces.map((s) => s.kind)),
      ...(vocab.principals ? { principals: ev.unknownish(base.principals) ? 'unknown' : uniqSorted([...(base.principals ?? []), ...surfaces.flatMap((s) => s.principals)]) } : {}) }, vocab);
    const inventoryPairs = compute(r, surfaceFacts(block.facts), surfaces, { lower: lowerApproved, keep }).pairs.map((p) => p.pair_id);
    const c5 = block.policy === 3, c5_exempted = [];
    const signals = reassessSignals({ paths: files, approvedPairs: effective, approvedSurfaces: block.surfaces, catalog, inventorySurfaces: surfaces, inventoryPairs, c5, exempted: c5 ? c5_exempted : null });
    const basis = [];
    if (block.catalog_digest !== digest) basis.push({ kind: 'catalog_digest_changed' });
    const outside = uniqSorted([...files.map((f) => f.path), ...surfaces.map((s) => s.path)].filter((p) => !contract.some((re) => re.test(p))));
    for (const p of outside) { basis.push({ kind: 'out-of-plan-path', path: p }); signals.push({ id: `out-of-plan-path@${p}`, kind: 'out-of-plan-path', path: p, class: null }); }
    signals.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (block.policy === 3) { const ex = exemptionRefusal(c5_exempted); if (ex) refuse(ex.code, ...ex.reasons); }
    if (block.policy === 3 && !basis.length) {
      // C5 inventory completeness: a signalling non-test path the plan writes must be a listed surface (typed, before classification).
      const gaps = inventoryGaps({ files: files.filter((f) => contract.some((re) => re.test(f.path))), surfacePaths: surfaces.map((s) => s.path), exempted: [] });
      if (gaps.length) refuse('surface_inventory_incomplete', ...gaps.map((g) => `${g.path}: ${g.kinds.join(', ')} with no surface at its path (add one to the inventory)`));
    }

    const classifications = validateClassifications(ev, input.classifications, vocab);
    const byId = new Map(classifications.map((c) => [c.signal_id, c]));
    const open = signals.filter((s) => s.kind !== 'out-of-plan-path' && s.class === null);
    // No classification (a reason, cited facts, or both) dismisses a surface-introducing signal off every approved
    // surface: the change may add a boundary, and facts never add one (boundaries and principals are derived from
    // surfaces). Such a signal closes only through an inventory surface at its path that selects its control
    // class (class 'inventory-surface' or 'approved-pairs' above). A classification still explains any other
    // signal, or one on an approved surface's path; its facts are merged below whether or not it closed anything.
    const approvedPaths = new Set(block.surfaces.map((s) => normPath(s.path)));
    const dismissed = (s) => byId.has(s.id) && !(SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));
    const unclassified = open.filter((s) => !dismissed(s)).map((s) => s.id);
    if (!basis.length && unclassified.length) { unclassifiedSignals = { signals, unclassified }; refuse('classification_missing', ...unclassified.map((id) => `unclassified signal ${id}`)); }
    const used = classifications.filter((c) => signals.some((s) => s.id === c.signal_id));

    let merged = { ...block.facts };
    for (const c of used) merged = mergeFacts(ev, vocab, merged, c.facts);
    const facts = surfaceFacts(merged);
    let lowerNow = lowerApproved;
    if (lowerApproved) {
      const raised = new Set(used.flatMap((c) => Object.entries(c.facts).filter(([, v]) => v === true || ev.unknownish(v)).map(([f]) => f)));
      lowerNow = new Map([...lowerApproved].map(([bid, m]) => [bid, new Map([...m].filter(([f]) => facts[f] === true && !raised.has(f)))]));
    }
    const core = compute(r, facts, surfaces, { lower: lowerNow, keep });
    const approvedControls = new Set(effective.map((p) => parsePairId(p).control_id));
    const newUnpaired = core.unpaired.filter((c) => !approvedControls.has(c));
    if (newUnpaired.length) refuse('control_unpaired', `selected with no inventory surface to pair with: ${newUnpaired.join(', ')}`);
    const pairs = core.pairs.map((p) => p.pair_id);
    const delta_pairs = pairs.filter((p) => !effective.includes(p));
    const outcome = basis.length ? 'REAPPROVAL' : delta_pairs.length ? 'ADD_CONTROLS' : 'UNCHANGED';
    const addendaPairs = uniqSorted(addenda.flatMap((a) => a.pairs));
    const candidate_id = input.candidate_id ?? inv.candidate_id ?? null;
    const out = {
      ok: true, code: 'reassessed',
      reasons: basis.map((x) => (x.path ? `${x.kind}: ${x.path}` : x.kind)),
      outcome, reapproval_basis: basis, signals, classifications_used: used.map((c) => c.signal_id).sort(),
      delta_pairs, merged_facts: facts, candidate_id, approved_plan_digest: planDigest(input.plan),
      catalog_digest: digest, approved_catalog_digest: block.catalog_digest,
      effective_addendum_digest: sha(canon(addendaPairs)),
      ...(block.policy === 3 ? { reopened_pairs: block.na_pairs.map((n) => n.pair_id).filter((id) => pairs.includes(id)), c5_exempted: dedupExempt(c5_exempted) } : {}),
    };
    if (outcome === 'ADD_CONTROLS') {
      out.addendum = { pairs: delta_pairs, controls: uniqSorted(delta_pairs.map((p) => parsePairId(p).control_id)), catalog_digest: digest, candidate_id,
        basis_signals_digest: sha(canon({ signals: signals.map((s) => ({ id: s.id, class: s.class })),
          classifications: used.map((c) => ({ signal_id: c.signal_id, facts: c.facts, reason: c.reason })) })) };
    }
    return out;
  });
  if (res.ok === false && res.code === 'classification_missing' && unclassifiedSignals) Object.assign(res, unclassifiedSignals);
  return res;
}

// ---------------------------------------------------------------------------------------------------- CLI
function isEntrypoint(moduleUrl) {
  const script = process.argv[1];
  if (!script) return false;
  let resolved = script;
  try { resolved = realpathSync(script); } catch { /* fall back to the given path */ }
  return pathToFileURL(resolved).href === moduleUrl || pathToFileURL(script).href === moduleUrl;
}

async function readInput(path) {
  if (path === '-') { let s = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) s += chunk; return s; }
  return readFileSync(path, 'utf8');
}
async function readJsonArg(name, path) {
  let text;
  try { text = await readInput(path); } catch (e) { refuse('bad_input', `--${name} ${path}: ${e.code ?? e.message}`); }
  try { return JSON.parse(text); } catch (e) { refuse('bad_input', `--${name} ${path}: ${e.message}`); }
}

const USAGE = 'usage: security-plan.mjs select --facts <file|-> [--catalog <path>] | reassess --plan <plan.md> --inventory <json> --changed <json> [--classifications <json>] [--addenda <json>] [--catalog <path>] | obligations --plan <plan.md> --repo <dir> [--addenda <pair ids json>] [--waived <pair ids json>] [--catalog <path>]';
const FLAGS = { select: { required: ['facts'], optional: ['catalog'] },
  reassess: { required: ['plan', 'inventory', 'changed'], optional: ['classifications', 'addenda', 'catalog'] },
  obligations: { required: ['plan', 'repo'], optional: ['addenda', 'waived', 'catalog'] } };

export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    const spec = FLAGS[cmd];
    if (!spec) refuse('bad_input', USAGE);
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
      if (!k || rest[i + 1] === undefined || Object.hasOwn(flags, k) || ![...spec.required, ...spec.optional].includes(k)) refuse('bad_input', `bad or repeated flag ${rest[i]}`, USAGE);
      flags[k] = rest[i + 1];
    }
    for (const k of spec.required) if (!flags[k]) refuse('bad_input', `--${k} is required`, USAGE);
    const loaded = loadCatalog(flags.catalog ? { catalogPath: flags.catalog } : {});
    if (!loaded.ok) return loaded;
    if (cmd === 'select') return selectControls(loaded, await readJsonArg('facts', flags.facts));
    let plan;
    try { plan = readFileSync(flags.plan, 'utf8'); } catch (e) { refuse('bad_input', `--plan ${flags.plan}: ${e.code ?? e.message}`); }
    if (cmd === 'obligations') {
      if (!countBlocks(plan)) refuse('plan_block_missing', 'the plan has no <!-- security-plan: --> block in §3a');
      const block = parsePlanSecurityBlock(plan);
      if (!block) refuse('plan_block_invalid', 'the security-plan block is malformed or inconsistent');
      const m = obligationMatrix(loaded, block, { addenda: flags.addenda ? await readJsonArg('addenda', flags.addenda) : [],
        waived: flags.waived ? await readJsonArg('waived', flags.waived) : [] });
      if (!m.ok) return m;
      const cited = verifyCitations(block, { root: flags.repo }); // the working tree of --repo (no pending: what exists now)
      return cited.ok ? { ...m, citations_checked: cited.checked } : cited;
    }
    return reassess({ plan, catalog: loaded, inventory: await readJsonArg('inventory', flags.inventory), changed: await readJsonArg('changed', flags.changed),
      classifications: flags.classifications ? await readJsonArg('classifications', flags.classifications) : [],
      addenda: flags.addenda ? await readJsonArg('addenda', flags.addenda) : [] });
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, reasons: e.reasons };
    throw e;
  }
}

/** Exit status for a CLI result: 0 result, 2 refusal or REAPPROVAL, 1 malformed input. */
export const exitCodeFor = (r) => (r.ok === false ? (EXIT_ONE.has(r.code) ? 1 : 2) : r.outcome === 'REAPPROVAL' ? 2 : 0);

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exitCode = exitCodeFor(r);
  }).catch((e) => { process.stderr.write(`security-plan: ${e?.stack ?? e}\n`); process.exitCode = 1; });
}
