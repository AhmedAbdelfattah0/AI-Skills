// Structure, integrity and label-consistency test for the vapt selection fixtures.
// Scores nothing: it checks that the fixture files are well formed, sealed, internally
// consistent with the control catalog, and that the labels obey the labelling policy.
// Selector scoring needs Wave B's select and is not done here. Reachability of the labels
// is checked against the catalog evaluator (imported from controls.mjs; the guard below forbids local copies).
// Run: node --test skills/vapt/fixtures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './controls.mjs';
import * as S from './fixtures/selector.mjs';
import { DIFF_SIGNALS } from './controls.mjs';
import { holds, selected, via, why, computeLedger, computeBroadOnly, computeReassess, computeBaselines, scoreSelector, ledgerReason } from './fixtures/selector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raw = (p) => readFileSync(join(here, p));
const rawOpt = (p) => (existsSync(join(here, p)) ? raw(p) : null);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const CATEGORIES = ['low-risk', 'authentication', 'authorization', 'multi-tenant-data', 'public-api',
  'sensitive-data', 'cloudflare-worker-infra', 'scope-exceeds-plan'];
const SCENARIO_KEYS = ['id', 'set', 'category', 'family', 'origin', 'summary', 'changed_surfaces', 'facts'];
const SCOPE_KEYS = ['planned_surfaces', 'planned_facts', 'actual_diff_signals'];
const LABEL_KEYS = ['scenario_id', 'must_select', 'inapplicable', 'rationale', 'confidence', 'inapplicable_basis'];
const MIN_BASIS = 20;
const SIGNALS = DIFF_SIGNALS;
const AMENDMENT_FILES = ['amendments.json', 'amendments_round2.json', 'amendments_round3.json', 'amendments_round4.json'];
const LABEL_HISTORY = 'label_history.json';
const SCOPE_LABEL_KEYS = ['expected_reassess', 'reassess_rationale', 'added_controls'];
const REASSESS = ['UNCHANGED', 'ADD_CONTROLS', 'REAPPROVAL'];
const CONFIDENCE = ['high', 'medium', 'low'];
const MIN_RATIONALE = 15;
const PROVENANCE = ['provenance/fact_vocabulary.json', 'provenance/controls_public.json'];
const BANNED_NAMES = /storecraft|paymob|supabase/i;
const isUnknown = (v) => v === null || v === 'unknown';
const dupes = (a) => a.filter((x, i) => a.indexOf(x) !== i);
const union = (surfaces) => [...new Set((surfaces ?? []).flatMap((s) => s.boundaries ?? []))].sort();

const catalogRaw = raw('controls.json');
const catalog = JSON.parse(catalogRaw);
const VOCAB = catalog.fact_vocabulary;
const CONTROL_IDS = new Set(catalog.controls.map((c) => c.id));
const BOUNDARIES = VOCAB.boundaries.values;
// A control is never inapplicable while one of its own primary facts is true, with ONE narrow exemption:
// the catalog selects VAPT-ABUSE-07 on any persistent write on purpose (a write may carry a sensitive field the
// facts do not name), so a labeler may still judge it inapplicable there. Only these control/fact pairs are
// skipped; every such case stays visible in the computed ledger (disagreements.json, via 'fact persistent_write').
export const BROAD_FACTS = { 'VAPT-ABUSE-07': ['persistent_write'] };
const PRIMARY = new Map(catalog.controls.filter((c) => c.primary_facts)
  .map((c) => [c.id, c.primary_facts.filter((f) => !(BROAD_FACTS[c.id] ?? []).includes(f))]));
const CONTROL = new Map(catalog.controls.map((c) => [c.id, c]));
const LEDGER_FILE = 'fixtures/disagreements.json';
const REGEN = 'regenerate it with: node skills/vapt/fixtures/make-ledger.mjs';

function load() {
  const files = {
    scenarios: raw('fixtures/scenarios.json'),
    labels: raw('fixtures/labels.json'),
    amendments: rawOpt('fixtures/amendments.json'),
    amendments2: rawOpt('fixtures/amendments_round2.json'),
    amendments3: rawOpt('fixtures/amendments_round3.json'),
    amendments4: rawOpt('fixtures/amendments_round4.json'),
    labelHistory: rawOpt(`fixtures/${LABEL_HISTORY}`),
    provenance: Object.fromEntries(PROVENANCE.map((p) => [p, rawOpt(`fixtures/${p}`)])),
  };
  let labels = JSON.parse(files.labels);
  // Version 1 stored labels as an object keyed by scenario id; normalise so one set of checks reads both.
  if (!Array.isArray(labels)) labels = Object.entries(labels).map(([scenario_id, l]) => ({ scenario_id, ...l }));
  return {
    files,
    catalogRaw,
    manifest: JSON.parse(raw('fixtures/manifest.json')),
    scenarios: JSON.parse(files.scenarios),
    labels,
    amendments: files.amendments ? JSON.parse(files.amendments) : null,
    amendments2: files.amendments2 ? JSON.parse(files.amendments2) : null,
    amendments3: files.amendments3 ? JSON.parse(files.amendments3) : null,
    amendments4: files.amendments4 ? JSON.parse(files.amendments4) : null,
    labelHistory: files.labelHistory ? JSON.parse(files.labelHistory) : null,
    ledger: rawOpt(LEDGER_FILE) ? JSON.parse(raw(LEDGER_FILE)) : null,
  };
}
const clone = (x) => structuredClone(x);

// Each checker returns a list of problems; empty means the invariant holds.
export function checkHashes(d) {
  const e = [];
  const h = d.manifest.sha256 ?? {};
  if (h['scenarios.json'] !== sha(d.files.scenarios)) e.push('scenarios.json hash differs from manifest');
  if (h['labels.json'] !== sha(d.files.labels)) e.push('labels.json hash differs from manifest');
  if (!d.files.amendments) e.push('amendments.json is missing');
  else if (h['amendments.json'] !== sha(d.files.amendments)) e.push('amendments.json hash differs from manifest');
  for (const [name, buf] of [['amendments_round2.json', d.files.amendments2], ['amendments_round3.json', d.files.amendments3], ['amendments_round4.json', d.files.amendments4], [LABEL_HISTORY, d.files.labelHistory]]) {
    if (!buf) e.push(`${name} is missing`);
    else if (h[name] !== sha(buf)) e.push(`${name} hash differs from manifest`);
  }
  for (const p of PROVENANCE) {
    const buf = d.files.provenance?.[p];
    if (!buf) e.push(`${p} is missing`);
    else if (h[p] !== sha(buf)) e.push(`${p} hash differs from manifest`);
  }
  return e;
}

export function checkCatalogDigest(d) {
  return d.manifest.catalog_digest_at_seal === sha(d.catalogRaw) ? [] : [
    'controls.json changed since seal: catalog_digest_at_seal differs. Re-seal required: re-record the digest and treat all prior sealed results as stale.'];
}

export function checkSets(d) {
  const e = [];
  const ids = d.scenarios.map((s) => s.id);
  const { dev = [], sealed = [] } = d.manifest.sets ?? {};
  if (ids.length !== 35) e.push(`expected 35 scenarios, found ${ids.length}`);
  if (dev.length !== 14) e.push(`manifest dev set has ${dev.length} ids, expected 14`);
  if (sealed.length !== 21) e.push(`manifest sealed set has ${sealed.length} ids, expected 21`);
  if (new Set(ids).size !== ids.length) e.push('duplicate scenario id');
  if (dev.some((i) => sealed.includes(i))) e.push('dev and sealed overlap');
  for (const i of [...dev, ...sealed]) if (!ids.includes(i)) e.push(`${i}: in a manifest set but has no scenario`);
  for (const i of ids) if (!dev.includes(i) && !sealed.includes(i)) e.push(`${i}: scenario is in no manifest set`);
  for (const s of d.scenarios) {
    const listed = dev.includes(s.id) ? 'dev' : sealed.includes(s.id) ? 'sealed' : null;
    if (listed !== s.set) e.push(`${s.id}: set "${s.set}" disagrees with manifest (${listed})`);
  }
  const sealedScenarios = d.scenarios.filter((s) => s.set === 'sealed');
  for (const c of CATEGORIES) {
    const n = sealedScenarios.filter((s) => s.category === c).length;
    if (n < 2) e.push(`sealed category ${c} has ${n} scenarios, expected >= 2`);
  }
  for (const s of sealedScenarios) if (s.origin !== 'synthetic') e.push(`${s.id}: sealed origin must be synthetic`);
  for (const s of d.scenarios.filter((x) => x.set === 'dev'))
    if (!/^audit:F\d\d$/.test(s.origin) && s.origin !== 'synthetic') e.push(`${s.id}: dev origin must be audit:F## or synthetic`);
  return e;
}

function factErrors(id, facts, label) {
  const e = [];
  if (facts === null || typeof facts !== 'object') return [`${id}: ${label} is not an object`];
  for (const k of Object.keys(VOCAB)) if (!(k in facts)) e.push(`${id}: ${label} missing fact ${k}`);
  for (const k of Object.keys(facts)) if (!(k in VOCAB)) e.push(`${id}: ${label} unexpected fact ${k}`);
  for (const [k, v] of Object.entries(facts)) {
    const def = VOCAB[k];
    if (!def) continue;
    if (def.type === 'bool') {
      if (typeof v !== 'boolean' && !isUnknown(v)) e.push(`${id}: ${label}.${k} must be boolean or unknown`);
    } else if (isUnknown(v)) {
      // an enum fact may also be unknown
    } else if (!Array.isArray(v)) e.push(`${id}: ${label}.${k} must be an array`);
    else for (const x of v) if (!def.values.includes(x)) e.push(`${id}: ${label}.${k} has out-of-vocabulary value ${x}`);
  }
  return e;
}

function surfaceErrors(id, surfaces, label) {
  const e = [];
  if (!Array.isArray(surfaces)) return [`${id}: ${label} is not an array`];
  for (const s of surfaces) {
    if (typeof s.path !== 'string' || !s.path) e.push(`${id}: ${label} entry without path`);
    if (!Array.isArray(s.boundaries)) e.push(`${id}: ${label} ${s.path} boundaries is not an array`);
    else for (const b of s.boundaries) if (!BOUNDARIES.includes(b)) e.push(`${id}: ${label} ${s.path} bad boundary ${b}`);
    for (const k of Object.keys(s)) if (!['path', 'boundaries'].includes(k)) e.push(`${id}: ${label} ${s.path} unexpected key ${k}`);
  }
  return e;
}

export function checkScenarios(d) {
  const e = [];
  for (const s of d.scenarios) {
    const scope = s.category === 'scope-exceeds-plan';
    const allowed = scope ? [...SCENARIO_KEYS, ...SCOPE_KEYS] : SCENARIO_KEYS;
    for (const k of Object.keys(s)) if (!allowed.includes(k)) e.push(`${s.id}: unexpected key ${k}`);
    for (const k of allowed) if (!(k in s)) e.push(`${s.id}: missing key ${k}`);
    if (!CATEGORIES.includes(s.category)) e.push(`${s.id}: unknown category ${s.category}`);
    if (typeof s.summary !== 'string' || s.summary.length < 20) e.push(`${s.id}: summary too short`);
    if (BANNED_NAMES.test(String(s.summary))) e.push(`${s.id}: summary names a product or company`);
    e.push(...factErrors(s.id, s.facts, 'facts'));
    e.push(...surfaceErrors(s.id, s.changed_surfaces, 'changed_surfaces'));
    if (Array.isArray(s.facts?.boundaries) && Array.isArray(s.changed_surfaces)
      && s.facts.boundaries.slice().sort().join() !== union(s.changed_surfaces).join())
      e.push(`${s.id}: facts.boundaries [${s.facts.boundaries}] is not the union of changed_surfaces boundaries [${union(s.changed_surfaces)}]`);
    if (scope) {
      e.push(...factErrors(s.id, s.planned_facts, 'planned_facts'));
      e.push(...surfaceErrors(s.id, s.planned_surfaces, 'planned_surfaces'));
      if (Array.isArray(s.planned_facts?.boundaries) && Array.isArray(s.planned_surfaces)
        && s.planned_facts.boundaries.slice().sort().join() !== union(s.planned_surfaces).join())
        e.push(`${s.id}: planned_facts.boundaries is not the union of planned_surfaces boundaries`);
      if (!Array.isArray(s.actual_diff_signals) || !s.actual_diff_signals.length) e.push(`${s.id}: actual_diff_signals empty`);
      else {
        for (const x of s.actual_diff_signals) if (!SIGNALS.includes(x)) e.push(`${s.id}: actual_diff_signals value '${x}' is not in the signal vocabulary`);
        if (s.actual_diff_signals.includes('none') && s.actual_diff_signals.length > 1) e.push(`${s.id}: actual_diff_signals 'none' must be the sole value`);
        for (const x of dupes(s.actual_diff_signals)) e.push(`${s.id}: actual_diff_signals lists ${x} twice`);
      }
    }
  }
  const withUnknown = d.scenarios.filter((s) => s.facts && Object.values(s.facts).some(isUnknown)).length;
  if (withUnknown < 6) e.push(`only ${withUnknown} scenarios carry an unknown fact value, need >= 6`);
  return e;
}

export function checkLabels(d) {
  const e = [];
  const byId = new Map(d.scenarios.map((s) => [s.id, s]));
  const labelIds = d.labels.map((l) => l.scenario_id);
  for (const id of dupes(labelIds)) e.push(`${id}: duplicate label entry`);
  for (const id of byId.keys()) if (!labelIds.includes(id)) e.push(`${id}: no labels`);
  for (const id of labelIds) if (!byId.has(id)) e.push(`${id}: labels for unknown scenario`);
  for (const l of d.labels) {
    const id = l.scenario_id;
    const s = byId.get(id);
    const scope = s?.category === 'scope-exceeds-plan';
    const allowed = scope ? [...LABEL_KEYS, ...SCOPE_LABEL_KEYS] : LABEL_KEYS;
    for (const k of Object.keys(l)) if (!allowed.includes(k) && !(k === 'exceptions' && s?.category === 'low-risk')) e.push(`${id}: unexpected label key ${k}`);
    for (const k of allowed) if (!(k in l)) e.push(`${id}: missing label key ${k}`);
    const must = l.must_select ?? [];
    const inap = l.inapplicable ?? [];
    const added = l.added_controls ?? [];
    for (const [name, arr] of [['must_select', must], ['inapplicable', inap], ['added_controls', added]]) {
      if (!Array.isArray(arr)) { e.push(`${id}: ${name} is not an array`); continue; }
      for (const c of dupes(arr)) e.push(`${id}: ${name} lists ${c} twice`);
      for (const c of arr) if (!CONTROL_IDS.has(c)) e.push(`${id}: unknown control ${c} in ${name}`);
    }
    if (!CONFIDENCE.includes(l.confidence)) e.push(`${id}: confidence must be one of ${CONFIDENCE.join('|')}`);
    for (const c of must) if (inap.includes(c)) e.push(`${id}: ${c} is in both must_select and inapplicable`);
    for (const c of must) if (typeof l.rationale?.[c] !== 'string' || l.rationale[c].length < MIN_RATIONALE) e.push(`${id}: ${c} lacks a rationale of >= ${MIN_RATIONALE} chars`);
    if (s?.category === 'low-risk') {
      if (must.length) e.push(`${id}: low-risk must have empty must_select`);
      if (!inap.length) e.push(`${id}: low-risk must name inapplicable controls`);
    }
    if (s) for (const [c, facts] of PRIMARY) {
      // An unknown primary fact counts as true: the label cannot rule the control out on facts nobody knows.
      const hit = facts.find((f) => s.facts?.[f] === true || isUnknown(s.facts?.[f]));
      if (hit && inap.includes(c)) e.push(`${id}: ${c} is inapplicable although its primary fact ${hit} is ${s.facts[hit] === true ? 'true' : 'unknown'}`);
    }
    if (scope) {
      if (!REASSESS.includes(l.expected_reassess)) e.push(`${id}: expected_reassess not in ${REASSESS.join('|')}`);
      if (typeof l.reassess_rationale !== 'string' || l.reassess_rationale.length < MIN_RATIONALE) e.push(`${id}: reassess_rationale missing or shorter than ${MIN_RATIONALE}`);
      for (const c of added) if (!must.includes(c)) e.push(`${id}: added control ${c} is not in must_select`);
      if (l.expected_reassess === 'UNCHANGED' && added.length) e.push(`${id}: UNCHANGED must have empty added_controls`);
      if (['REAPPROVAL', 'ADD_CONTROLS'].includes(l.expected_reassess) && !added.length) e.push(`${id}: ${l.expected_reassess} needs non-empty added_controls`);
    }
  }
  return e;
}

// ---- evaluator single-source guard: the evaluator exists once, in controls.mjs ----
const SHARED = ['unknownish', 'assertFacts', 'holds', 'via', 'why', 'selected'];
// A local declaration of a shared evaluator function in `src` (function, or const/let/var binding).
export function localEvaluatorDecls(src) {
  const text = String(src);
  return SHARED.filter((n) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*${n}\\s*\\(|(?:const|let|var)\\s+${n}\\s*=)`, 'm').test(text));
}
export function checkSharedEvaluator(sources) {
  return Object.entries(sources).flatMap(([file, src]) => localEvaluatorDecls(src)
    .map((n) => `evaluator drift: ${file} declares its own '${n}'; import it from controls.mjs instead of pasting a copy (a copy needs ${REGEN} and a re-seal).`));
}

// ---- reachability: the labels against what the catalog evaluator selects from each scenario's facts ----
export function checkReachability(d) {
  const e = [];
  for (const s of d.scenarios) {
    const l = d.labels.find((x) => x.scenario_id === s.id);
    if (!l) continue;
    const sel = selected(catalog, s.facts);
    for (const c of l.must_select ?? []) if (CONTROL.has(c) && !sel.includes(c))
      e.push(`${s.id}: unreachable required control ${c}: its applies_when fails on the scenario facts (${why(CONTROL.get(c).applies_when, s.facts)})`);
    if (s.category !== 'low-risk' && !(l.must_select ?? []).length) e.push(`${s.id}: non-low-risk scenario has an empty must_select`);
    for (const c of l.added_controls ?? []) if (!(l.must_select ?? []).includes(c)) e.push(`${s.id}: added control ${c} is not in must_select`);
  }
  return e;
}

// ---- the disagreement ledger: inapplicable labels the catalog selects anyway, computed and listed exactly ----
const ledgerKey = (x) => `${x.scenario}|${x.control}|${x.via}`;
export function checkLedger(d) {
  const e = [];
  const L = d.ledger;
  if (!L || !Array.isArray(L.entries) || !L.by_control || typeof L.by_control !== 'object') return [`${LEDGER_FILE} is missing or malformed; ${REGEN}`];
  const computed = computeLedger(catalog, d.scenarios, d.labels);
  const want = new Set(computed.map(ledgerKey));
  const have = L.entries.map(ledgerKey);
  for (const k of dupes(have)) e.push(`ledger lists ${k} twice`);
  for (const x of computed) if (!have.includes(ledgerKey(x)))
    e.push(`${x.scenario}: ${x.control} is inapplicable but the catalog selects it (via ${x.via}) and the ledger does not list it; ${REGEN}`);
  for (const x of L.entries) if (!want.has(ledgerKey(x)))
    e.push(`stale ledger entry ${ledgerKey(x)}: the catalog does not select this inapplicable control that way; ${REGEN}`);
  if (L.total !== L.entries.length) e.push(`ledger total ${L.total} differs from its ${L.entries.length} entries`);
  const affected = new Set(L.entries.map((x) => x.control));
  for (const c of affected) if (typeof L.by_control[c] !== 'string' || L.by_control[c].trim().length < 20) e.push(`ledger by_control lacks a reason for ${c}`);
    else if (!L.by_control[c].includes(CONTROL.get(c)?.title)) e.push(`ledger by_control reason for ${c} does not name its title "${CONTROL.get(c)?.title}"`);
  for (const c of Object.keys(L.by_control)) if (!affected.has(c)) e.push(`ledger by_control names ${c}, which has no entry`);
  for (const r of dupes(Object.values(L.by_control))) e.push(`ledger by_control reuses one reason for several controls: '${r}'`);
  // Computed sections: exact match, both directions.
  const exact = (name, want2, have2, key) => {
    if (!Array.isArray(have2)) { e.push(`ledger ${name} is missing; ${REGEN}`); return; }
    const w = want2.map(key); const h = have2.map(key);
    for (const k of w) if (!h.includes(k)) e.push(`ledger ${name} lacks computed row ${k}; ${REGEN}`);
    for (const k of h) if (!w.includes(k)) e.push(`stale ledger ${name} row ${k}; ${REGEN}`);
  };
  exact('broad_gate_only_required', computeBroadOnly(catalog, d.scenarios, d.labels), L.broad_gate_only_required, ledgerKey);
  exact('reassess', computeReassess(catalog, d.scenarios, d.labels), L.reassess, (x) => JSON.stringify([x.scenario, x.delta, x.added_in_delta, x.already_planned]));
  return e;
}

// ---- inapplicable_basis and low-risk exceptions ----
export function checkBasis(d) {
  const e = [];
  const byId = new Map(d.scenarios.map((s) => [s.id, s]));
  for (const l of d.labels) {
    const id = l.scenario_id; const low = byId.get(id)?.category === 'low-risk';
    if (typeof l.inapplicable_basis !== 'string' || l.inapplicable_basis.trim().length < MIN_BASIS) e.push(`${id}: inapplicable_basis missing or shorter than ${MIN_BASIS}`);
    if (!low) { if ('exceptions' in l) e.push(`${id}: only low-risk scenarios may carry exceptions`); continue; }
    const ex = l.exceptions;
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) { e.push(`${id}: low-risk scenario needs an exceptions object`); continue; }
    const inap = l.inapplicable ?? []; const keys = Object.keys(ex);
    for (const c of keys) if (inap.includes(c)) e.push(`${id}: ${c} is both inapplicable and an exception`);
    for (const c of keys) if (!CONTROL_IDS.has(c)) e.push(`${id}: exception names unknown control ${c}`);
    for (const c of CONTROL_IDS) if (!inap.includes(c) && !keys.includes(c)) e.push(`${id}: ${c} is neither inapplicable nor an exception`);
    for (const [c, r] of Object.entries(ex)) if (typeof r !== 'string' || r.trim().length < MIN_BASIS) e.push(`${id}: exception reason for ${c} shorter than ${MIN_BASIS}`);
  }
  return e;
}

// ---- pre-registered baselines: recomputed, must equal the manifest ----
export function checkBaselines(d) {
  const want = computeBaselines(catalog, d.scenarios, d.labels, computeLedger(catalog, d.scenarios, d.labels));
  const have = d.manifest.preregistered_baselines;
  if (!have) return ['manifest.preregistered_baselines is missing'];
  return JSON.stringify(have) === JSON.stringify(want) ? [] : [
    `manifest.preregistered_baselines differ from the recomputed values ${JSON.stringify(want)}; re-seal (they may not drift silently)`];
}

// ---- dated history timeline, seal anchor, recoverable label history ----
export function checkHistory(d) {
  const e = [];
  const h = d.manifest.history ?? [];
  const versions = h.map((x) => x.version);
  for (const v of dupes(versions)) e.push(`history has version ${v} twice`);
  h.forEach((x, i) => {
    for (const k of ['version', 'date', 'change']) if (!(k in x)) e.push(`history ${i}: missing ${k}`);
    for (const k of Object.keys(x)) if (!['version', 'date', 'change'].includes(k)) e.push(`history ${i}: unexpected key ${k}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))) e.push(`history ${i}: date is not YYYY-MM-DD`);
    if (typeof x.change !== 'string' || x.change.length < 20) e.push(`history ${i}: change too short`);
  });
  for (let v = 1; v <= d.manifest.version; v++) if (!versions.includes(v)) e.push(`history lacks version ${v}`);
  if (Math.max(...versions) !== d.manifest.version) e.push('the last history version differs from manifest.version');
  if (typeof d.manifest.seal_anchor !== 'string' || !/git log --follow/.test(d.manifest.seal_anchor)) e.push('manifest.seal_anchor missing or does not say how to find the anchor commit');
  const lh = d.labelHistory;
  if (!lh || !Array.isArray(lh.changes)) return [...e, `${LABEL_HISTORY} is missing or malformed`];
  lh.changes.forEach((c, i) => {
    if (!['removed_from_must_select', 'added_to_must_select'].includes(c.change)) e.push(`label history ${i}: bad change ${c.change}`);
    if (!d.scenarios.some((s) => s.id === c.scenario)) e.push(`label history ${i}: unknown scenario ${c.scenario}`);
    if (!CONTROL_IDS.has(c.control)) e.push(`label history ${i}: unknown control ${c.control}`);
    if (c.change === 'removed_from_must_select' && (typeof c.reason !== 'string' || c.reason.length < 10)) e.push(`label history ${i}: removal lacks a reason`);
  });
  return e;
}

export function checkCoverage(d) {
  const e = [];
  const byId = new Map(d.scenarios.map((s) => [s.id, s]));
  for (const c of CONTROL_IDS) {
    const hits = d.labels.filter((l) => (l.must_select ?? []).includes(c));
    const sealedHits = hits.filter((l) => byId.get(l.scenario_id)?.set === 'sealed');
    if (hits.length < 2) e.push(`${c} is in must_select of ${hits.length} scenarios, need >= 2`);
    if (sealedHits.length < 1) e.push(`${c} is in must_select of no sealed scenario`);
  }
  const seen = new Set(d.scenarios.flatMap((s) => (s.changed_surfaces ?? []).flatMap((x) => x.boundaries ?? [])));
  for (const b of BOUNDARIES) if (!seen.has(b)) e.push(`boundary kind ${b} appears in no changed_surfaces`);
  const verdicts = d.labels.map((l) => l.expected_reassess).filter(Boolean);
  for (const v of ['REAPPROVAL', 'UNCHANGED']) if (!verdicts.includes(v)) e.push(`no scenario carries the ${v} verdict`);
  const limits = d.manifest.limits ?? [];
  const states = limits.some((x) => /ADD_CONTROLS/.test(x) && /no fixture/i.test(x));
  if (!verdicts.includes('ADD_CONTROLS') && !states) e.push('manifest limits must state that ADD_CONTROLS has no fixture');
  if (verdicts.includes('ADD_CONTROLS') && states) e.push('manifest limits say ADD_CONTROLS has no fixture but one exists');
  return e;
}

export function checkAmendments(d) {
  const e = [];
  if (!Array.isArray(d.amendments)) return ['amendments.json is missing or not an array'];
  if (!d.amendments.length) e.push('amendments.json is empty');
  const rounds = [[2, d.amendments2], [3, d.amendments3], [4, d.amendments4]];
  for (const [n, list] of rounds) {
    if (!Array.isArray(list)) e.push(`amendments round ${n} is missing or not an array`);
    else if (!list.length) e.push(`amendments round ${n} is empty`);
  }
  if (e.length) return e;
  const facts = new Map(d.scenarios.map((s) => [s.id, s.facts]));
  // Rounds 2 to 4: an entry's new value is the scenario's current value unless a later round amends the same fact.
  for (const [n, list] of rounds) list.forEach((a, i) => {
    for (const k of ['id', 'fact', 'old', 'new', 'reason']) if (!(k in a)) e.push(`round-${n} amendment ${i}: missing ${k}`);
    if (typeof a.reason !== 'string' || !a.reason.trim()) e.push(`round-${n} amendment ${i}: empty reason`);
    const later = rounds.filter(([m]) => m > n).some(([, l]) => l.some((b) => b.id === a.id && b.fact === a.fact));
    if (!facts.has(a.id)) e.push(`round-${n} amendment ${i}: unknown scenario ${a.id}`);
    else if (!(a.fact in VOCAB)) e.push(`round-${n} amendment ${i}: unknown fact ${a.fact}`);
    else if (!later && JSON.stringify(facts.get(a.id)[a.fact]) !== JSON.stringify(a.new)) e.push(`round-${n} amendment ${i}: ${a.id}.${a.fact} is not the amended value`);
  });
  const ids = new Set(d.scenarios.map((s) => s.id));
  d.amendments.forEach((a, i) => {
    for (const k of ['id', 'fact', 'old', 'new', 'reason']) if (!(k in a)) e.push(`amendment ${i}: missing ${k}`);
    if (typeof a.reason !== 'string' || !a.reason.trim()) e.push(`amendment ${i}: empty reason`);
    if (a.id !== undefined && !ids.has(a.id)) e.push(`amendment ${i}: unknown scenario ${a.id}`);
    if (a.fact !== undefined && !(a.fact in VOCAB)) e.push(`amendment ${i}: unknown fact ${a.fact}`);
  });
  return e;
}


const real = load();
const labelOf = (d, id) => d.labels.find((l) => l.scenario_id === id);
const firstScenario = (d, pred) => d.scenarios.find(pred);

test('fixtures are present and non-trivial', () => {
  assert.equal(real.manifest.version, 6);
  assert.equal(real.scenarios.length, 35);
  assert.equal(real.labels.length, 35);
});
test('manifest hashes equal the file hashes', () => assert.deepEqual(checkHashes(real), []));
test('catalog digest at seal equals the sha256 of controls.json', () => assert.deepEqual(checkCatalogDigest(real), []));
test('manifest records history, provenance, sealing rules and limits', () => {
  for (const k of ['created', 'history', 'provenance', 'rules', 'limits']) assert.ok(real.manifest[k] !== undefined, `manifest.${k}`);
  assert.ok(real.manifest.history.length >= 2, 'history must record the failed version 1 and the reseal');
});
test('set membership, categories and origins are consistent', () => assert.deepEqual(checkSets(real), []));
test('scenario facts, surfaces and boundary unions are consistent', () => assert.deepEqual(checkScenarios(real), []));
test('labels obey the labelling policy and primary-fact consistency', () => assert.deepEqual(checkLabels(real), []));
const catalogTestSrc = readFileSync(join(here, 'controls.test.mjs'), 'utf8');
const selectorSrc = readFileSync(join(here, 'fixtures/selector.mjs'), 'utf8');
test('fixtures/selector.mjs re-exports the one evaluator in controls.mjs (object identity)', () => {
  for (const n of SHARED) {
    assert.equal(typeof C[n], 'function', `${n} exported by controls.mjs`);
    assert.strictEqual(S[n], C[n], `${n} in fixtures/selector.mjs must be the controls.mjs export`);
  }
});
test('neither selector.mjs nor controls.test.mjs declares its own evaluator function', () => {
  assert.deepEqual(checkSharedEvaluator({ 'fixtures/selector.mjs': selectorSrc, 'controls.test.mjs': catalogTestSrc }), []);
});
test('evaluator copy behaves: unknown matches every leaf, includes/is leaves, all/any', () => {
  const node = { any: [{ fact: 'persistent_write', op: 'is', value: true }, { all: [
    { fact: 'boundaries', op: 'includes', value: 'file-path' }, { fact: 'session_context', op: 'is', value: true }] }] };
  const f = (x) => ({ persistent_write: false, session_context: false, boundaries: ['request-handler'], ...x });
  assert.equal(holds(node, f()), false);
  assert.equal(holds(node, f({ persistent_write: true })), true);
  assert.equal(holds(node, f({ persistent_write: null })), true);
  assert.equal(holds(node, f({ boundaries: ['file-path'] })), false);
  assert.equal(holds(node, f({ boundaries: ['file-path'], session_context: 'unknown' })), true);
  assert.equal(holds(node, f({ boundaries: ['unknown'], session_context: true })), true);
  assert.equal(via(node, f({ persistent_write: true })), 'fact persistent_write');
  assert.equal(via(node, f({ persistent_write: null })), 'unknown persistent_write');
  assert.equal(via(node, f({ boundaries: ['file-path'], session_context: true })), 'boundary file-path & fact session_context');
  assert.match(why(node, f()), /persistent_write is false/);
  const known = Object.fromEntries(Object.entries(VOCAB).filter(([, v]) => v.type === 'bool').map(([k]) => [k, false]));
  const sel = selected(catalog, { ...known, principals: ['service'], boundaries: ['request-handler'] });
  assert.ok(sel.includes('VAPT-API-01') && !sel.includes('VAPT-ABUSE-07'), 'selected follows applies_when');
  assert.throws(() => selected(catalog, f({ not_a_fact: true })), /out-of-vocabulary/);
});
test('every required control is reachable from its scenario facts; non-low-risk must_select is non-empty', () => {
  assert.deepEqual(checkReachability(real), []);
});
test('the disagreement ledger equals the computed set of catalog-selected inapplicable labels', (t) => {
  assert.deepEqual(checkLedger(real), []);
  assert.ok(!('known_label_catalog_disagreements' in real.manifest), 'superseded by the computed ledger');
  t.diagnostic(`ledger size: ${real.ledger?.entries?.length} catalog over-breadth entries over ${Object.keys(real.ledger?.by_control ?? {}).length} controls`);
});
test('coverage matrix: controls, boundaries, categories and reassess verdicts', () => assert.deepEqual(checkCoverage(real), []));
test('amendments (rounds 1 to 4) are recorded and well formed', () => assert.deepEqual(checkAmendments(real), []));
test('every label carries an inapplicable_basis; low-risk exceptions complete the control set exactly', () => assert.deepEqual(checkBasis(real), []));
test('pre-registered baselines equal the values recomputed with the selector', (t) => {
  assert.deepEqual(checkBaselines(real), []);
  for (const [k, v] of Object.entries(real.manifest.preregistered_baselines?.baselines ?? {}))
    t.diagnostic(`${k}: recall ${v.recall}, inapplicable violations ${v.inapplicable_violations}, net hard defects ${v.net_hard_defects}`);
});
test('history is one dated timeline, the seal anchor is stated, and label history is recoverable', () => assert.deepEqual(checkHistory(real), []));
test('scenario text is not copied from labels or catalog internals', () => {
  for (const s of real.scenarios) assert.ok(!/VAPT-[A-Z]+-\d\d/.test(s.summary), `${s.id}: summary cites a control id`);
});

// Negative tests: every invariant must fail on an in-memory mutation.
const mutated = (fn) => { const d = clone(real); d.files = real.files; d.catalogRaw = real.catalogRaw; fn(d); return d; };
const sealedOf = (d, cat) => d.scenarios.filter((s) => s.set === 'sealed' && s.category === cat);
const anyMust = (d) => d.labels.find((l) => l.must_select.length);
const scopeId = (d) => d.scenarios.find((s) => s.category === 'scope-exceeds-plan').id;

test('negative: tampered scenarios, labels, amendments or provenance break the manifest hash', () => {
  const tampered = Buffer.from(real.files.scenarios.toString().replace('S-DEV-01', 'S-DEV-XX'));
  assert.ok(checkHashes({ ...real, files: { ...real.files, scenarios: tampered } }).length > 0);
  assert.ok(checkHashes({ ...real, files: { ...real.files, labels: Buffer.concat([real.files.labels, Buffer.from(' ')]) } }).length > 0);
  assert.ok(checkHashes({ ...real, files: { ...real.files, amendments: Buffer.concat([real.files.amendments ?? Buffer.alloc(0), Buffer.from(' ')]) } }).length > 0);
  assert.ok(checkHashes({ ...real, files: { ...real.files, amendments2: Buffer.concat([real.files.amendments2 ?? Buffer.alloc(0), Buffer.from(' ')]) } }).some((m) => /amendments_round2/.test(m)));
  assert.ok(checkHashes({ ...real, files: { ...real.files, amendments2: null } }).some((m) => /amendments_round2.json is missing/.test(m)));
  for (const p of PROVENANCE) {
    const prov = { ...real.files.provenance, [p]: Buffer.concat([real.files.provenance[p] ?? Buffer.alloc(0), Buffer.from(' ')]) };
    assert.ok(checkHashes({ ...real, files: { ...real.files, provenance: prov } }).length > 0, p);
  }
});
test('negative: a changed controls.json fails the digest check with a re-seal message', () => {
  const errs = checkCatalogDigest({ ...real, catalogRaw: Buffer.concat([real.catalogRaw, Buffer.from('\n')]) });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Re-seal required/);
  assert.match(errs[0], /prior sealed results/);
});
test('negative: duplicate id, set disagreement, overlap and one-sided membership are rejected', () => {
  assert.ok(checkSets(mutated((d) => { d.scenarios[1].id = d.scenarios[0].id; })).length > 0);
  assert.ok(checkSets(mutated((d) => { d.scenarios[0].set = 'sealed'; })).length > 0);
  assert.ok(checkSets(mutated((d) => { d.manifest.sets.sealed.push(d.manifest.sets.dev[0]); })).length > 0);
  assert.ok(checkSets(mutated((d) => { d.manifest.sets.dev.push('S-GHOST'); })).length > 0, 'manifest id without scenario');
  assert.ok(checkSets(mutated((d) => { d.manifest.sets.dev.pop(); })).length > 0, 'scenario in no manifest set');
});
test('negative: a sealed category with fewer than 2 scenarios is rejected', () => {
  assert.ok(checkSets(mutated((d) => { sealedOf(d, 'public-api')[0].category = 'authentication'; sealedOf(d, 'public-api').slice(1).forEach((s) => { s.category = 'authentication'; }); })).length > 0);
});
test('negative: origin rules are enforced', () => {
  assert.ok(checkSets(mutated((d) => { sealedOf(d, 'low-risk')[0].origin = 'audit:F01'; })).length > 0);
  assert.ok(checkSets(mutated((d) => { d.scenarios.find((s) => s.set === 'dev').origin = 'made-up'; })).length > 0);
});
test('negative: fact violations are rejected', () => {
  const key = 'persistent_write';
  assert.ok(checkScenarios(mutated((d) => { delete d.scenarios[0].facts[key]; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].facts[key] = 'yes'; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].facts.extra_fact = true; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].facts.boundaries = ['request_handler']; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].facts.boundaries = 'request-handler'; })).length > 0);
});
test('negative: facts.boundaries must equal the union of changed_surfaces boundaries', () => {
  assert.ok(checkScenarios(mutated((d) => {
    const s = d.scenarios[0]; s.facts.boundaries = s.facts.boundaries.slice(1);
  })).length > 0, 'dropped boundary');
  assert.ok(checkScenarios(mutated((d) => {
    const s = d.scenarios[0]; const extra = BOUNDARIES.find((b) => !s.facts.boundaries.includes(b)); s.facts.boundaries.push(extra);
  })).length > 0, 'extra boundary');
  assert.ok(checkScenarios(mutated((d) => {
    const s = d.scenarios.find((x) => x.category === 'scope-exceeds-plan' && x.planned_surfaces.length); s.planned_facts.boundaries = s.planned_facts.boundaries.length ? [] : [BOUNDARIES[0]];
  })).length > 0, 'planned boundaries');
});
test('negative: surface and scenario key violations are rejected', () => {
  assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].changed_surfaces[0].boundaries = ['nope']; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { delete d.scenarios[0].changed_surfaces[0].boundaries; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].surprise = 1; })).length > 0);
});
test('negative: fewer than 6 unknown-valued scenarios is rejected', () => {
  assert.ok(checkScenarios(mutated((d) => {
    for (const s of d.scenarios) for (const [k, v] of Object.entries(s.facts)) if (isUnknown(v)) s.facts[k] = false;
  })).length > 0);
});
test('negative: product or company names in a summary are rejected', () => {
  for (const name of ['StoreCraft', 'PAYMOB', 'Supabase'])
    assert.ok(checkScenarios(mutated((d) => { d.scenarios[0].summary += ` using ${name} internally`; })).length > 0, name);
});
test('negative: scope-exceeds scenarios must carry planned and actual data', () => {
  const scope = (d) => d.scenarios.find((s) => s.category === 'scope-exceeds-plan');
  assert.ok(checkScenarios(mutated((d) => { delete scope(d).planned_facts; })).length > 0);
  assert.ok(checkScenarios(mutated((d) => { scope(d).actual_diff_signals = []; })).length > 0);
});
test('negative: label coverage, duplicate entries and control-id violations are rejected', () => {
  assert.ok(checkLabels(mutated((d) => { d.labels = d.labels.filter((l) => l.scenario_id !== d.scenarios[0].id); })).length > 0);
  assert.ok(checkLabels(mutated((d) => { d.labels.push({ ...clone(d.labels[0]), scenario_id: 'S-GHOST' }); })).length > 0);
  assert.ok(checkLabels(mutated((d) => { d.labels.push(clone(d.labels[0])); })).length > 0);
  assert.ok(checkLabels(mutated((d) => { d.labels[0].must_select.push('VAPT-NOPE-99'); })).length > 0);
  assert.ok(checkLabels(mutated((d) => { d.labels[0].inapplicable.push('VAPT-NOPE-99'); })).length > 0);
});
test('negative: duplicates, bad confidence and must_select/inapplicable overlap are rejected', () => {
  assert.ok(checkLabels(mutated((d) => { const l = anyMust(d); l.must_select.push(l.must_select[0]); })).length > 0, 'dup must');
  assert.ok(checkLabels(mutated((d) => { const l = d.labels[0]; l.inapplicable.push(l.inapplicable[0] ?? 'VAPT-API-01', l.inapplicable[0] ?? 'VAPT-API-01'); })).length > 0, 'dup inapplicable');
  assert.ok(checkLabels(mutated((d) => { d.labels[0].confidence = 'certain'; })).length > 0, 'confidence');
  assert.ok(checkLabels(mutated((d) => { const l = anyMust(d); l.inapplicable.push(l.must_select[0]); })).length > 0, 'overlap');
});
test('negative: a rationale under 15 chars or missing is rejected', () => {
  assert.ok(checkLabels(mutated((d) => { const l = anyMust(d); l.rationale[l.must_select[0]] = 'x'.repeat(14); })).length > 0);
  assert.ok(checkLabels(mutated((d) => { const l = anyMust(d); delete l.rationale[l.must_select[0]]; })).length > 0);
  assert.ok(checkLabels(mutated((d) => { labelOf(d, scopeId(d)).reassess_rationale = 'short'; })).length > 0);
});
test('negative: low-risk label rules are enforced', () => {
  const low = (d) => labelOf(d, d.scenarios.find((s) => s.category === 'low-risk').id);
  assert.ok(checkLabels(mutated((d) => { low(d).must_select = ['VAPT-API-01']; low(d).rationale['VAPT-API-01'] = 'a long enough rationale text'; })).length > 0);
  assert.ok(checkLabels(mutated((d) => { low(d).inapplicable = []; })).length > 0);
});
test('negative: an ABUSE control is not inapplicable when its primary fact is true', () => {
  for (const [c, facts] of PRIMARY) {
    const s = real.scenarios.find((x) => facts.some((f) => x.facts[f] === true));
    assert.ok(s, `no scenario has a true primary fact for ${c}`);
    const errs = checkLabels(mutated((d) => {
      const l = labelOf(d, s.id);
      l.must_select = l.must_select.filter((x) => x !== c);
      l.inapplicable = [...new Set([...l.inapplicable, c])];
    }));
    assert.ok(errs.some((m) => m.includes(c) && m.includes('primary fact')), c);
  }
});
test('negative: scope-exceeds labels need a valid verdict, rationale and consistent added controls', () => {
  assert.ok(checkLabels(mutated((d) => { labelOf(d, scopeId(d)).expected_reassess = 'MAYBE'; })).length > 0);
  assert.ok(checkLabels(mutated((d) => { delete labelOf(d, scopeId(d)).reassess_rationale; })).length > 0);
  const withAdded = (d) => d.labels.find((l) => l.added_controls?.length);
  assert.ok(checkLabels(mutated((d) => { const l = withAdded(d); l.added_controls.push(d.labels.find((x) => x !== l).must_select.find((c) => !l.must_select.includes(c)) ?? 'VAPT-NOPE-99'); })).length > 0, 'not subset');
  assert.ok(checkLabels(mutated((d) => { withAdded(d).added_controls = []; })).length > 0, 'verdict needs added controls');
  const unchanged = real.labels.find((l) => l.expected_reassess === 'UNCHANGED');
  assert.ok(unchanged, 'an UNCHANGED fixture exists');
  assert.ok(checkLabels(mutated((d) => { const l = labelOf(d, unchanged.scenario_id); l.added_controls = [l.must_select[0] ?? 'VAPT-API-01']; l.must_select = [...new Set([...l.must_select, ...l.added_controls])]; l.rationale[l.added_controls[0]] = 'a long enough rationale text'; l.inapplicable = l.inapplicable.filter((x) => x !== l.added_controls[0]); })).length > 0, 'UNCHANGED with added controls');
});
test('negative: coverage gaps are rejected', () => {
  assert.ok(checkCoverage(mutated((d) => { for (const l of d.labels) l.must_select = l.must_select.filter((c) => c !== 'VAPT-API-01'); })).length > 0, 'control in no must_select');
  assert.ok(checkCoverage(mutated((d) => {
    for (const l of d.labels) if (d.scenarios.find((s) => s.id === l.scenario_id).set === 'sealed') l.must_select = l.must_select.filter((c) => c !== 'VAPT-API-01');
  })).length > 0, 'control in no sealed scenario');
  assert.ok(checkCoverage(mutated((d) => { for (const s of d.scenarios) for (const x of s.changed_surfaces) x.boundaries = x.boundaries.filter((b) => b !== 'file-path'); })).length > 0, 'boundary kind absent');
  assert.ok(checkCoverage(mutated((d) => { for (const l of d.labels) if (l.expected_reassess === 'UNCHANGED') l.expected_reassess = 'REAPPROVAL'; })).length > 0, 'UNCHANGED absent');
  assert.ok(checkCoverage(mutated((d) => { for (const l of d.labels) if (l.expected_reassess === 'REAPPROVAL') l.expected_reassess = 'UNCHANGED'; })).length > 0, 'REAPPROVAL absent');
  assert.ok(checkCoverage(mutated((d) => { d.manifest.limits = d.manifest.limits.filter((x) => !/ADD_CONTROLS/.test(x)); })).length > 0, 'limits silent on ADD_CONTROLS');
});
test('negative: amendments must be present, complete and match real scenarios and facts', () => {
  assert.ok(checkAmendments(mutated((d) => { d.amendments = null; })).length > 0);
  assert.ok(checkAmendments(mutated((d) => { delete d.amendments[0].reason; })).length > 0);
  assert.ok(checkAmendments(mutated((d) => { delete d.amendments[0].old; })).length > 0);
  assert.ok(checkAmendments(mutated((d) => { d.amendments[0].id = 'S-GHOST'; })).length > 0);
  assert.ok(checkAmendments(mutated((d) => { d.amendments[0].fact = 'not_a_fact'; })).length > 0);
  assert.ok(checkAmendments(mutated((d) => { d.amendments2 = null; })).length > 0, 'round 2 missing');
  assert.ok(checkAmendments(mutated((d) => { d.amendments4 = null; })).length > 0, 'round 4 missing');
  assert.ok(checkAmendments(mutated((d) => { d.amendments4[0].id = 'S-GHOST'; })).length > 0, 'round 4 scenario');
  assert.ok(checkAmendments(mutated((d) => { delete d.amendments2[0].reason; })).length > 0, 'round 2 reason');
  assert.ok(checkAmendments(mutated((d) => { d.amendments2[0].id = 'S-GHOST'; })).length > 0, 'round 2 scenario');
  assert.ok(checkAmendments(mutated((d) => { const a = d.amendments2[0]; d.scenarios.find((s) => s.id === a.id).facts[a.fact] = !a.new; }))
    .some((m) => /not the amended value/.test(m)), 'round 2 value not applied');
});
test('negative: the BROAD_FACTS exemption is narrow (only ABUSE-07/persistent_write) and does not leak', () => {
  assert.deepEqual(BROAD_FACTS, { 'VAPT-ABUSE-07': ['persistent_write'] });
  const inapWhere = (c, fact) => mutated((d) => {
    const s = d.scenarios.find((x) => x.category !== 'low-risk');
    for (const k of PRIMARY.get(c) ?? []) s.facts[k] = false;
    s.facts[fact] = true;
    const l = labelOf(d, s.id); l.must_select = l.must_select.filter((x) => x !== c); l.inapplicable = [...new Set([...l.inapplicable, c])];
  });
  const hit = (errs, c, f) => errs.some((m) => m.includes(c) && m.includes(`primary fact ${f}`));
  assert.ok(!hit(checkLabels(inapWhere('VAPT-ABUSE-07', 'persistent_write')), 'VAPT-ABUSE-07', 'persistent_write'), 'exempt pair is skipped');
  assert.ok(hit(checkLabels(inapWhere('VAPT-ABUSE-07', 'sensitive_field_write')), 'VAPT-ABUSE-07', 'sensitive_field_write'), 'ABUSE-07 narrow fact still rejected');
  for (const [c, facts] of PRIMARY) if (c !== 'VAPT-ABUSE-07')
    for (const f of facts) assert.ok(hit(checkLabels(inapWhere(c, f)), c, f), `${c}/${f} not exempt`);
});
test('negative: a pasted local evaluator function is rejected with a controls.mjs pointer', () => {
  for (const decl of ['export function holds(node, facts) { return true; }', 'export const unknownish = (v) => v == null;',
    'function via(node, facts) { return ""; }', 'const why = () => "";', 'export function assertFacts(f) { return f; }', 'function selected() { return []; }']) {
    const errs = checkSharedEvaluator({ 'fixtures/selector.mjs': `${selectorSrc}\n${decl}\n` });
    assert.equal(errs.length, 1, `${decl}: ${errs.join('|')}`);
    assert.ok(/controls\.mjs/.test(errs[0]) && /re-seal/.test(errs[0]), errs[0]);
  }
  assert.deepEqual(localEvaluatorDecls('export { holds, via } from "../controls.mjs";\nimport { selected } from "../controls.mjs";'), [], 're-exports and imports are not declarations');
});
// Data-independent mutations: start from a clean world where every label is reachable and the ledger is exact,
// so each negative proves its own check fires (the real data may currently be red on these checks).
const cleanWorld = () => mutated((d) => {
  for (const s of d.scenarios) {
    const l = labelOf(d, s.id); const sel = selected(catalog, s.facts);
    l.must_select = l.must_select.filter((c) => sel.includes(c));
    if (l.added_controls) l.added_controls = l.added_controls.filter((c) => sel.includes(c));
  }
  const entries = computeLedger(catalog, d.scenarios, d.labels);
  d.ledger = {
    total: entries.length, entries,
    by_control: Object.fromEntries([...new Set(entries.map((x) => x.control))].map((c) => [c, ledgerReason(catalog, c)])),
    broad_gate_only_required: computeBroadOnly(catalog, d.scenarios, d.labels),
    reassess: computeReassess(catalog, d.scenarios, d.labels),
  };
});
const ledgered = (d) => d.ledger.entries[0];
test('negative: the clean baseline passes reachability and ledger checks', () => {
  const d = cleanWorld();
  assert.deepEqual(checkLedger(d), []);
  assert.deepEqual(checkReachability(d).filter((m) => !/empty must_select/.test(m)), []);
  assert.ok(d.ledger.entries.length > 0, 'baseline has ledger entries to mutate');
});
test('negative: an emptied must_select on a non-low-risk scenario is rejected', () => {
  const errs = checkReachability(mutated((d) => { labelOf(d, d.scenarios.find((s) => s.category !== 'low-risk').id).must_select = []; }));
  assert.ok(errs.some((m) => /empty must_select/.test(m)));
});
test('negative: an unreachable required control is rejected and names the failing leaf', () => {
  const d = cleanWorld();
  const s = d.scenarios.find((x) => selected(catalog, x.facts).length < CONTROL_IDS.size);
  const c = [...CONTROL_IDS].find((x) => !selected(catalog, s.facts).includes(x));
  const l = labelOf(d, s.id); l.must_select.push(c); l.inapplicable = l.inapplicable.filter((x) => x !== c);
  const errs = checkReachability(d);
  assert.ok(errs.some((m) => m.startsWith(`${s.id}: unreachable required control ${c}`) && /needs/.test(m)), errs.join('\n'));
});
test('negative: added_controls outside must_select is rejected by the reachability check', () => {
  const d = cleanWorld();
  const l = d.labels.find((x) => x.added_controls?.length);
  l.added_controls.push([...CONTROL_IDS].find((c) => !l.must_select.includes(c)));
  assert.ok(checkReachability(d).some((m) => /added control .* is not in must_select/.test(m)));
});
test('negative: an extra or stale ledger entry is rejected', () => {
  assert.ok(checkLedger((() => { const d = cleanWorld(); d.ledger.entries.push({ ...ledgered(d), scenario: 'S-GHOST' }); d.ledger.total += 1; return d; })())
    .some((m) => /stale ledger entry S-GHOST/.test(m)), 'invented entry');
  assert.ok(checkLedger((() => { const d = cleanWorld(); const x = ledgered(d); d.ledger.entries.push({ ...x, via: 'fact invented' }); d.ledger.total += 1; return d; })())
    .some((m) => /stale ledger entry/.test(m)), 'wrong via');
  assert.ok(checkLedger((() => { const d = cleanWorld(); const x = ledgered(d); const l = labelOf(d, x.scenario); l.inapplicable = l.inapplicable.filter((c) => c !== x.control); return d; })())
    .some((m) => /stale ledger entry/.test(m)), 'label no longer inapplicable');
  assert.ok(checkLedger((() => { const d = cleanWorld(); d.ledger.entries.push(ledgered(d)); d.ledger.total += 1; return d; })())
    .some((m) => /twice/.test(m)), 'duplicate entry');
});
test('negative: an unlisted catalog-selected inapplicable label is rejected', () => {
  assert.ok(checkLedger((() => { const d = cleanWorld(); d.ledger.entries.shift(); d.ledger.total -= 1; return d; })())
    .some((m) => /ledger does not list it/.test(m)), 'dropped entry');
  const d = cleanWorld();
  const s = d.scenarios.find((x) => { const l = labelOf(d, x.id); return selected(catalog, x.facts).some((c) => !l.must_select.includes(c) && !l.inapplicable.includes(c)); });
  const l = labelOf(d, s.id);
  const c = selected(catalog, s.facts).find((x) => !l.must_select.includes(x) && !l.inapplicable.includes(x));
  l.inapplicable.push(c);
  assert.ok(checkLedger(d).some((m) => m.startsWith(`${s.id}: ${c} is inapplicable but the catalog selects it`)), 'inapplicable gains a selected control');
});
test('negative: ledger bookkeeping (total, by_control reasons) is enforced', () => {
  assert.ok(checkLedger((() => { const d = cleanWorld(); d.ledger.total += 1; return d; })()).some((m) => /total/.test(m)));
  assert.ok(checkLedger((() => { const d = cleanWorld(); delete d.ledger.by_control[ledgered(d).control]; return d; })()).some((m) => /lacks a reason/.test(m)));
  assert.ok(checkLedger((() => { const d = cleanWorld(); d.ledger.by_control['VAPT-NOPE-99'] = 'a reason long enough to pass'; return d; })()).some((m) => /no entry/.test(m)));
  assert.ok(checkLedger((() => { const d = cleanWorld(); d.ledger = null; return d; })()).length > 0, 'missing ledger');
});

const has = (errs, re) => errs.some((m) => re.test(m));
const lowId = (d) => d.scenarios.find((s) => s.category === 'low-risk').id;
const nonLowId = (d) => d.scenarios.find((s) => s.category !== 'low-risk').id;
test('negative: inapplicable_basis and low-risk exceptions are enforced', () => {
  assert.ok(has(checkBasis(mutated((d) => { delete d.labels[0].inapplicable_basis; })), /inapplicable_basis missing/));
  assert.ok(has(checkBasis(mutated((d) => { d.labels[0].inapplicable_basis = 'x'.repeat(19); })), /inapplicable_basis missing or shorter/));
  assert.ok(has(checkBasis(mutated((d) => { delete labelOf(d, lowId(d)).exceptions; })), /needs an exceptions object/));
  assert.ok(has(checkBasis(mutated((d) => { const l = labelOf(d, lowId(d)); l.inapplicable.push(Object.keys(l.exceptions ?? { 'VAPT-API-01': 1 })[0]); })), /both inapplicable and an exception|neither/));
  assert.ok(has(checkBasis(mutated((d) => { const l = labelOf(d, lowId(d)); l.inapplicable.pop(); })), /neither inapplicable nor an exception/), 'gap');
  assert.ok(has(checkBasis(mutated((d) => { const l = labelOf(d, lowId(d)); l.exceptions = { ...(l.exceptions ?? {}) }; const k = Object.keys(l.exceptions)[0] ?? 'VAPT-CFG-03'; l.exceptions[k] = 'short'; })), /shorter than/), 'short exception reason');
  assert.ok(has(checkBasis(mutated((d) => { labelOf(d, nonLowId(d)).exceptions = {}; })), /only low-risk/));
});
test('negative: an unknown primary fact counts as true; the BROAD_FACTS pair stays exempt', () => {
  const d = mutated((x) => {
    const s = x.scenarios.find((y) => y.category !== 'low-risk');
    s.facts.shared_resource = null; s.facts.attempt_limit = false;
    const l = labelOf(x, s.id); l.must_select = l.must_select.filter((c) => c !== 'VAPT-ABUSE-04'); l.inapplicable = [...new Set([...l.inapplicable, 'VAPT-ABUSE-04'])];
  });
  assert.ok(has(checkLabels(d), /VAPT-ABUSE-04 is inapplicable although its primary fact shared_resource is unknown/));
  const e = mutated((x) => {
    const s = x.scenarios.find((y) => y.category !== 'low-risk');
    for (const f of ['sensitive_field_write', 'plan_gated_feature', 'spends_or_reserves_value']) s.facts[f] = false;
    s.facts.persistent_write = 'unknown';
    const l = labelOf(x, s.id); l.must_select = l.must_select.filter((c) => c !== 'VAPT-ABUSE-07'); l.inapplicable = [...new Set([...l.inapplicable, 'VAPT-ABUSE-07'])];
  });
  assert.ok(!has(checkLabels(e), /VAPT-ABUSE-07 is inapplicable although its primary fact persistent_write/), 'exempt pair stays exempt when unknown');
});
test('negative: broad_gate_only_required and reassess sections must match the computation exactly', () => {
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); d.ledger.broad_gate_only_required.push({ scenario: 'S-GHOST', control: 'VAPT-ABUSE-06', via: 'x' }); return d; })()), /stale ledger broad_gate_only_required/));
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); const s = d.scenarios.find((x) => x.category !== 'low-risk' && selected(catalog, x.facts).includes('VAPT-ABUSE-06') && x.facts.state_transitions === false && !labelOf(d, x.id).must_select.includes('VAPT-ABUSE-06'));
    assert.ok(s, 'a scenario reaching ABUSE-06 only through a broad gate'); const l = labelOf(d, s.id); l.must_select.push('VAPT-ABUSE-06'); l.inapplicable = l.inapplicable.filter((c) => c !== 'VAPT-ABUSE-06'); l.rationale['VAPT-ABUSE-06'] = 'a long enough rationale text';
    d.ledger.entries = computeLedger(catalog, d.scenarios, d.labels); d.ledger.total = d.ledger.entries.length; return d; })()), /ledger broad_gate_only_required lacks computed row/), 'new broad-only label not recorded');
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); d.ledger.broad_gate_only_required = undefined; return d; })()), /broad_gate_only_required is missing/));
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); d.ledger.reassess[0].delta = []; return d; })()), /ledger reassess/), 'tampered delta');
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); d.ledger.reassess[0].already_planned.push('VAPT-NOPE-99'); return d; })()), /ledger reassess/), 'tampered already_planned');
});
test('negative: actual_diff_signals must come from the vocabulary; none only alone', () => {
  const scope = (d) => d.scenarios.find((s) => s.category === 'scope-exceeds-plan');
  assert.ok(has(checkScenarios(mutated((d) => { scope(d).actual_diff_signals = ['touched-a-file']; })), /not in the signal vocabulary/));
  assert.ok(has(checkScenarios(mutated((d) => { scope(d).actual_diff_signals = ['none', 'new-route']; })), /'none' must be the sole value/));
});
test('negative: by_control reasons must name the title and be distinct', () => {
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); for (const k of Object.keys(d.ledger.by_control)) d.ledger.by_control[k] = 'catalog selects broadly; labeler judged intrinsically inapplicable'; return d; })()), /does not name its title/));
  assert.ok(has(checkLedger((() => { const d = cleanWorld(); const [a, b] = Object.keys(d.ledger.by_control); const r = `${CONTROL.get(a).title} ${CONTROL.get(b).title} shared reason`; d.ledger.by_control[a] = r; d.ledger.by_control[b] = r; return d; })()), /reuses one reason/));
});
test('negative: drifted pre-registered baselines are rejected', () => {
  assert.ok(has(checkBaselines(mutated((d) => { d.manifest.preregistered_baselines.baselines.catalog_faithful.recalled -= 1; })), /re-seal/));
  assert.ok(has(checkBaselines(mutated((d) => { d.labels.find((l) => l.must_select.length).must_select.pop(); })), /differ/), 'label change moves the baselines');
  assert.ok(has(checkBaselines(mutated((d) => { delete d.manifest.preregistered_baselines; })), /missing/));
});
test('negative: history timeline, seal anchor and label history are enforced', () => {
  assert.ok(has(checkHistory(mutated((d) => { d.manifest.history.push({ ...d.manifest.history[0] }); })), /twice/));
  assert.ok(has(checkHistory(mutated((d) => { delete d.manifest.history[0].date; })), /missing date/));
  assert.ok(has(checkHistory(mutated((d) => { d.manifest.history[0].note = 'old style'; })), /unexpected key note/));
  assert.ok(has(checkHistory(mutated((d) => { d.manifest.history = d.manifest.history.filter((x) => x.version !== 2); })), /lacks version 2/));
  assert.ok(has(checkHistory(mutated((d) => { delete d.manifest.seal_anchor; })), /seal_anchor/));
  assert.ok(has(checkHistory(mutated((d) => { d.labelHistory = null; })), /label_history.json is missing/));
  assert.ok(has(checkHistory(mutated((d) => { d.labelHistory.changes[0].control = 'VAPT-NOPE-99'; })), /unknown control/));
  assert.ok(has(checkHistory(mutated((d) => { const c = d.labelHistory.changes.find((x) => x.change === 'removed_from_must_select'); delete c.reason; })), /lacks a reason/));
  assert.ok(has(checkHashes({ ...real, files: { ...real.files, labelHistory: Buffer.concat([real.files.labelHistory ?? Buffer.alloc(0), Buffer.from(' ')]) } }), /label_history.json/));
  assert.ok(has(checkHashes({ ...real, files: { ...real.files, amendments3: null } }), /amendments_round3.json is missing/));
  assert.ok(has(checkHashes({ ...real, files: { ...real.files, amendments4: null } }), /amendments_round4.json is missing/));
  assert.ok(has(checkHashes({ ...real, files: { ...real.files, amendments4: Buffer.concat([real.files.amendments4 ?? Buffer.alloc(0), Buffer.from(' ')]) } }), /amendments_round4.json hash differs/));
});
test('negative: net hard defects count violation pairs outside the ledger, never a count difference', () => {
  const entries = computeLedger(catalog, real.scenarios, real.labels);
  const ledgered = new Set(entries.map((x) => `${x.scenario}|${x.control}`));
  // An inapplicable pair the catalog does not select, so it is outside the ledger.
  let outside = null;
  for (const s of real.scenarios) for (const c of labelOf(real, s.id).inapplicable) if (!outside && !ledgered.has(`${s.id}|${c}`)) outside = { scenario: s.id, control: c };
  assert.ok(outside, 'an unledgered inapplicable pair exists');
  const skip = entries[0];
  const swap = (s) => {
    const sel = entries.filter((x) => x.scenario === s.id && x !== skip).map((x) => x.control);
    return s.id === outside.scenario ? [...sel, outside.control] : sel;
  };
  const r = scoreSelector(real.scenarios, real.labels, entries, swap);
  assert.equal(r.inapplicable_violations, entries.length, 'same violation count as the ledger');
  assert.ok(r.net_hard_defects >= 1, `one unledgered pair must score >= 1, got ${r.net_hard_defects}`);
  const onlyLedgered = scoreSelector(real.scenarios, real.labels, entries, (s) => entries.filter((x) => x.scenario === s.id && x !== skip).map((x) => x.control));
  assert.equal(onlyLedgered.net_hard_defects, 0, 'violating only ledgered pairs scores 0');
  for (const v of Object.values(computeBaselines(catalog, real.scenarios, real.labels, entries).baselines)) assert.ok(v.net_hard_defects >= 0, 'never negative');
});
