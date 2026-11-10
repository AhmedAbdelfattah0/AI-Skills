#!/usr/bin/env node
// security-plan.mjs — catalog-driven security control selection for ship-ticket plans (policy 2).
//
//   select   --facts <file|-> [--catalog <controls.json>]
//   reassess --plan <plan.md> --inventory <json> --changed <json> [--classifications <json>] [--addenda <json>] [--catalog <controls.json>]
//
// stdout is always one JSON object with `code` and `reasons[]`. Exit 0: a result (selected; reassessed as
// UNCHANGED or ADD_CONTROLS). Exit 2: a refusal or judgment point (catalog_missing, catalog_invalid,
// fact_uncited, control_unpaired, classification_missing, plan_block_missing, plan_block_invalid, or the
// outcome REAPPROVAL). Exit 1: malformed input (bad_input, fact_out_of_vocabulary, surface_facts_mismatch).
//
// The catalog is skills/vapt/controls.json and its evaluator skills/vapt/controls.mjs (one definition of the
// selection semantics). A standalone install without vapt refuses catalog_missing: never an empty selection.
// Keyword matches on a diff only create signals; they never select a control. Imports no engine module.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EVALUATOR_URL = new URL('../../vapt/controls.mjs', import.meta.url).href;
const DEFAULT_CATALOG = fileURLToPath(new URL('../../vapt/controls.json', import.meta.url));
const EVAL_FNS = ['unknownish', 'assertFacts', 'selected', 'via', 'why', 'catalogDigest'];
let DEFAULT_EVALUATOR = null;
try { DEFAULT_EVALUATOR = await import(EVALUATOR_URL); } catch { DEFAULT_EVALUATOR = null; }

/** Every refusal code this module emits. Exit 1 for EXIT_ONE codes, 2 for the rest. */
export const SECURITY_CODES = ['catalog_missing', 'catalog_invalid', 'bad_input', 'fact_out_of_vocabulary', 'surface_facts_mismatch',
  'fact_uncited', 'control_unpaired', 'classification_missing', 'plan_block_missing', 'plan_block_invalid'];
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
  const digest = ev.catalogDigest(raw);
  REGISTRY.set(catalog, { digest, evaluator: ev });
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

/** Surfaces -> normalized, sorted by boundary_id. */
function validateSurfaces(surfaces, vocab) {
  if (!Array.isArray(surfaces)) refuse('bad_input', 'surfaces must be an array');
  const kinds = new Set([...vocab.boundaries.values, 'unknown']);
  const principals = isObj(vocab.principals) ? new Set([...vocab.principals.values, 'unknown']) : null;
  const seen = new Set();
  const out = [];
  for (const s of surfaces) {
    if (!isObj(s) || !nonEmpty(s.boundary_id) || /[\r\n]/.test(s.boundary_id) || typeof s.kind !== 'string' || !nonEmpty(s.path)
      || !Array.isArray(s.principals) || !s.principals.length || !s.principals.every((p) => typeof p === 'string')) {
      refuse('bad_input', `surface ${JSON.stringify(s)} needs boundary_id, kind, path and a non-empty principals[]`);
    }
    if (Object.keys(s).some((k) => !['boundary_id', 'kind', 'path', 'principals'].includes(k))) refuse('bad_input', `surface ${s.boundary_id} has unknown keys`);
    if (seen.has(s.boundary_id)) refuse('bad_input', `duplicate boundary_id ${s.boundary_id}`);
    seen.add(s.boundary_id);
    if (!kinds.has(s.kind)) refuse('fact_out_of_vocabulary', `surface ${s.boundary_id}: kind ${JSON.stringify(s.kind)} is not a boundary kind`);
    if (principals) for (const p of s.principals) if (!principals.has(p)) refuse('fact_out_of_vocabulary', `surface ${s.boundary_id}: principal ${JSON.stringify(p)}`);
    out.push({ boundary_id: s.boundary_id, kind: s.kind, path: inputPath(s.path, `surface ${s.boundary_id}: path`), principals: uniqSorted(s.principals) });
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
function compute({ catalog, evaluator: ev }, facts, surfaces) {
  const byId = new Map(catalog.controls.map((c) => [c.id, c]));
  const change = ev.selected(catalog, facts);
  const pairs = [];
  const bySurface = new Set();
  for (const s of surfaces) {
    const sf = { ...facts, boundaries: [s.kind] };
    for (const id of ev.selected(catalog, sf)) {
      bySurface.add(id);
      const c = byId.get(id);
      pairs.push({ pair_id: pairId(s.boundary_id, id), boundary_id: s.boundary_id, kind: s.kind, control_id: id, tier: c.tier,
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
  const ids = uniqSorted([...change, ...bySurface]);
  const controls = ids.map((id) => {
    const c = byId.get(id);
    return { control_id: id, tier: c.tier, verify_type: c.verify?.type ?? null, env: c.env ?? null,
      why: change.includes(id) ? ev.via(c.applies_when, facts) : 'surface-level only',
      boundary_ids: uniqSorted(pairs.filter((p) => p.control_id === id).map((p) => p.boundary_id)) };
  });
  const excluded = catalog.controls.filter((c) => !ids.includes(c.id)).map((c) => ({ control_id: c.id, why: ev.why(c.applies_when, facts) }))
    .sort((a, b) => (a.control_id < b.control_id ? -1 : 1));
  const unknown_facts = Object.keys(catalog.fact_vocabulary).filter((k) => partlyUnknown(ev, facts[k])).sort();
  return { controls, pairs, excluded, unknown_facts, unpaired };
}

const selectionDigest = ({ catalog_digest, facts_digest, controls }) => sha(canon({ policy: 2, catalog_digest, facts_digest, controls: uniqSorted(controls) }));

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
    const surfaces = validateSurfaces(input.surfaces, vocab);
    checkFacts(ev, input.facts, vocab);
    const derived = { boundaries: uniqSorted(surfaces.map((s) => s.kind)), principals: uniqSorted(surfaces.flatMap((s) => s.principals)) };
    for (const k of DERIVED) {
      if (input.facts[k] !== undefined && !sameSet(input.facts[k], derived[k])) {
        refuse('surface_facts_mismatch', `facts.${k} ${JSON.stringify(input.facts[k])} differs from the surfaces' ${JSON.stringify(derived[k])}`);
      }
    }
    checkCitations(ev, input.facts, input.evidence, vocab, Object.keys(vocab).filter((k) => !DERIVED.includes(k)));
    const facts = normFacts(ev, { ...input.facts, ...(vocab.principals ? derived : { boundaries: derived.boundaries }) }, vocab);
    return buildSelection(r, catalog, digest, facts, surfaces);
  });
}

function buildSelection(reg, catalog, digest, facts, surfaces) {
  const core = compute(reg, facts, surfaces);
  if (core.unpaired.length) refuse('control_unpaired', `selected with no surface to pair with: ${core.unpaired.join(', ')}`);
  const facts_digest = sha(canon(facts));
  const ids = core.controls.map((c) => c.control_id);
  const sel = {
    ok: true, code: 'selected', reasons: [], tool: 'security-plan', v: 1, security_policy: 2,
    catalog_version: catalog.catalog_version, catalog_digest: digest, facts_digest,
    selection_digest: selectionDigest({ catalog_digest: digest, facts_digest, controls: ids }),
    controls: core.controls, pairs: core.pairs, excluded: core.excluded, unknown_facts: core.unknown_facts,
    facts, surfaces,
    config_fragment: { securityPolicy: 2, catalogDigest: digest, securityControls: ids,
      controlCoverage: core.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: null, specs: [] })) },
  };
  sel.rows_md = renderSection3a(sel);
  return sel;
}

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

const RS_BEGIN = '<!-- RUN-STATE:BEGIN -->', RS_END = '<!-- RUN-STATE:END -->';
/** The plan without its RUN-STATE body, so appended events can never add or break a block or pairs line. */
const narrative = (text) => { const b = text.indexOf(RS_BEGIN), e = text.indexOf(RS_END); return b < 0 || e < b ? text : text.slice(0, b + RS_BEGIN.length) + text.slice(e); };
const countBlocks = (text) => (typeof text === 'string' ? [...narrative(text).matchAll(BLOCK_RE)].length : 0);

/**
 * The §3a machine block, verified: exactly one block, well-formed, its selection digest recomputes, every pair
 * names a listed surface and control, and every `security-pairs` line in the plan equals the block's. Else null.
 */
export function parsePlanSecurityBlock(planText) {
  if (typeof planText !== 'string') return null;
  planText = narrative(planText);
  const m = [...planText.matchAll(BLOCK_RE)];
  if (m.length !== 1) return null;
  let b;
  try { b = JSON.parse(m[0][1]); } catch { return null; }
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

/** Approved pairs united with every addendum's pairs: add-only by construction. Malformed pair ids throw. */
export function effectiveSet(approvedBlock, addenda = []) {
  const all = [...(approvedBlock?.pairs ?? [])];
  if (!Array.isArray(addenda)) throw new TypeError('addenda must be an array');
  for (const a of addenda) { if (!isObj(a) || !Array.isArray(a.pairs)) throw new TypeError('addendum needs pairs[]'); all.push(...a.pairs); }
  for (const p of all) if (!parsePairId(p)) throw new TypeError(`invalid pair id ${JSON.stringify(p)}`);
  return uniqSorted(all);
}

/** The approved-plan digest: sha256 of the plan with the RUN-STATE body removed (markers kept adjacent). */
export const planDigest = (text) => sha(narrative(text));

// ---------------------------------------------------------------------------------------------------- signals
const DEP_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lockb', 'bun.lock', 'deno.json', 'deno.lock', 'pipfile', 'pipfile.lock', 'poetry.lock', 'pyproject.toml', 'setup.py', 'setup.cfg', 'uv.lock',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'packages.lock.json', 'directory.packages.props', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock', 'podfile', 'podfile.lock']);
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
  ['new-route', (p, b) => /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|webhooks?)(\/|\.)/.test(p) || /^(route|\+server|\+page\.server)\.[cm]?[jt]sx?$/.test(b),
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
export function reassessSignals({ paths = [], approvedPairs = [], approvedSurfaces = [], catalog, inventorySurfaces = [], inventoryPairs = [] } = {}) {
  const files = asResult(() => normFiles(paths));
  if (files.ok === false) throw new TypeError(files.reasons.join('; '));
  const ids = new Set((catalog?.controls ?? []).map((c) => c.id));
  const idOf = (p) => (typeof p === 'string' ? p : p?.pair_id);
  const paired = new Set(approvedPairs.map(idOf));
  const selectedHere = new Set(inventoryPairs.map(idOf));
  const carries = (surfaces, set, cls) => surfaces.length > 0 && cls.every((c) => surfaces.some((s) => set.has(`${s.boundary_id}:${c}`)));
  const out = new Map();
  for (const f of files) {
    const b = f.path.split('/').pop().toLowerCase();
    const p = f.path.toLowerCase();
    for (const [kind, pathTest, lineTest] of RULES) {
      if (!(pathTest(p, b) || (lineTest && f.added.some((l) => lineTest.test(l))))) continue;
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
      const again = compute(r, block.facts, block.surfaces);
      if (canon(again.pairs.map((p) => p.pair_id)) !== canon(block.pairs)) refuse('plan_block_invalid', 'block pairs do not follow from its facts and surfaces');
    }

    // The pairs the inventory's surfaces select under the approved facts (classifications only add to these):
    // a new surface at a signal's path closes the signal, and its pairs not yet effective become delta_pairs.
    const surfaceFacts = (base) => normFacts(ev, { ...base, boundaries: uniqSorted(surfaces.map((s) => s.kind)),
      ...(vocab.principals ? { principals: ev.unknownish(base.principals) ? 'unknown' : uniqSorted([...(base.principals ?? []), ...surfaces.flatMap((s) => s.principals)]) } : {}) }, vocab);
    const inventoryPairs = compute(r, surfaceFacts(block.facts), surfaces).pairs.map((p) => p.pair_id);
    const signals = reassessSignals({ paths: files, approvedPairs: effective, approvedSurfaces: block.surfaces, catalog, inventorySurfaces: surfaces, inventoryPairs });
    const basis = [];
    if (block.catalog_digest !== digest) basis.push({ kind: 'catalog_digest_changed' });
    const outside = uniqSorted([...files.map((f) => f.path), ...surfaces.map((s) => s.path)].filter((p) => !contract.some((re) => re.test(p))));
    for (const p of outside) { basis.push({ kind: 'out-of-plan-path', path: p }); signals.push({ id: `out-of-plan-path@${p}`, kind: 'out-of-plan-path', path: p, class: null }); }
    signals.sort((a, b) => (a.id < b.id ? -1 : 1));

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
    const core = compute(r, facts, surfaces);
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

const USAGE = 'usage: security-plan.mjs select --facts <file|-> [--catalog <path>] | reassess --plan <plan.md> --inventory <json> --changed <json> [--classifications <json>] [--addenda <json>] [--catalog <path>]';
const FLAGS = { select: { required: ['facts'], optional: ['catalog'] },
  reassess: { required: ['plan', 'inventory', 'changed'], optional: ['classifications', 'addenda', 'catalog'] } };

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
