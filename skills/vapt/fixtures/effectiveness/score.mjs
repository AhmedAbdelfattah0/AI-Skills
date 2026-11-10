// Deterministic scorer for the vapt effectiveness measurement. The rules are fixed in prereg.json; this file
// implements them and nothing else. Selection is done by selected() from ../../controls.mjs, the one evaluator.
// CLI: node score.mjs --write | --block | --report <path> | --hashes
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selected, assertFacts, unknownish, catalogDigest } from '../../controls.mjs';
import { boundaryUniversal, computeBaselines } from '../selector.mjs';

export { selected };

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..', '..', '..', '..');
const LABELS = ['yes', 'partial', 'no'];
const DEV_FACTS = 'storecraft-facts.json';
const DEV_JUDG = 'storecraft-judgments.json';
const C2_INDEX = 'corpus2-index.json';
const C2_FACTS = 'corpus2-facts.json';
const C2_JUDG = 'corpus2-judgments.json';
export const DATA_FILES = [DEV_FACTS, DEV_JUDG, C2_INDEX, C2_FACTS, C2_JUDG];
export const HASHED_FILES = ['prereg.json', ...DATA_FILES];
const BEGIN = '<!-- RESULTS:BEGIN -->';
const END = '<!-- RESULTS:END -->';

/** SHA-256 of a buffer or string as lowercase hex. */
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** True for an abuse-case control id. */
const isAbuse = (id) => id.startsWith('VAPT-ABUSE-');
/** Sorted copy of an iterable of strings. */
const sortStr = (a) => [...a].sort();
/** Object mapping each key to 0. */
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

// known_only: every unknown boolean -> false, every unknown enum (absent, null, "unknown") -> [].
export function knownOnly(facts, vocab) {
  const out = {};
  for (const [name, def] of Object.entries(vocab)) {
    const v = facts[name];
    if (def.type === 'bool') out[name] = unknownish(v) ? false : v;
    else out[name] = unknownish(v) ? [] : v;
  }
  return out;
}

// ------------------------------------------------------------ input checks
/** Sorted ids of the development-set findings named in the prereg. */
function devFindings(prereg) {
  const d = prereg.development_data;
  const ids = new Set([...Object.values(d.families).flat(), ...Object.keys(d.pre_audit_covered)]);
  return [...ids].sort();
}

/** Validate a judgments file (both judges, every case, known controls) and throw on any defect. */
function checkJudgments(name, judg, caseIds, controlIds) {
  const judges = judg?.judges;
  if (!judges || !judges.J1 || !judges.J2) throw new Error(`${name}: judgments need both judges J1 and J2`);
  for (const j of ['J1', 'J2']) {
    for (const id of Object.keys(judges[j])) if (!caseIds.includes(id)) throw new Error(`${name}: judge ${j} labels case ${id}, which has no facts`);
    for (const id of caseIds) {
      const row = judges[j][id];
      if (!row) throw new Error(`${name}: case ${id} has facts but no judgments from ${j}`);
      for (const c of controlIds) {
        if (!(c in row)) throw new Error(`${name}: judge ${j} case ${id} is missing control ${c}`);
        if (!LABELS.includes(row[c])) throw new Error(`${name}: judge ${j} case ${id} control ${c} holds ${JSON.stringify(row[c])}, not yes, partial or no`);
      }
      for (const c of Object.keys(row)) if (!controlIds.includes(c)) throw new Error(`${name}: judge ${j} case ${id} labels ${c}, which is not a catalog control`);
    }
  }
}

/** Map each development finding to the set of catalog controls that cite it as a source. */
function sourceControls(catalog, prereg, findings) {
  const map = Object.fromEntries(findings.map((f) => [f, new Set()]));
  for (const c of catalog.controls) {
    for (const s of c.sources ?? []) {
      if (s.kind !== 'audit') continue;
      const f = s.ref.slice(s.ref.indexOf(':') + 1);
      if (map[f]) map[f].add(c.id);
    }
  }
  for (const [f, c] of Object.entries(prereg.development_data.pre_audit_covered)) map[f].add(c);
  for (const f of findings) if (map[f].size === 0) throw new Error(`finding ${f} has no source control in the catalog`);
  return Object.fromEntries(findings.map((f) => [f, sortStr(map[f])]));
}

// ------------------------------------------------------------------- score
/** Compute the full results object from the loaded inputs. */
export function score(inputs) {
  const { catalog, prereg, fixtures, dev, corpus2 } = inputs;
  if (inputs.catalog_digest !== prereg.frozen.catalog_digest) {
    throw new Error(`catalog digest ${inputs.catalog_digest} is not the frozen digest ${prereg.frozen.catalog_digest}`);
  }
  const vocab = catalog.fact_vocabulary;
  const controlIds = catalog.controls.map((c) => c.id);
  const alwaysOn = boundaryUniversal(catalog);
  const alwaysSet = new Set(alwaysOn);
  const specific = controlIds.filter((c) => !alwaysSet.has(c));
  const specSet = new Set(specific);

  // ---- case data
  const findings = devFindings(prereg);
  const devFactCases = dev.facts.cases ?? {};
  for (const f of findings) if (!devFactCases[f]) throw new Error(`development facts are missing family finding ${f}`);
  for (const f of Object.keys(devFactCases)) if (!findings.includes(f)) throw new Error(`development facts hold ${f}, which is not a preregistered finding`);
  const idx = corpus2.index.cases;
  const idxIds = idx.map((c) => c.id);
  const c2FactCases = corpus2.facts.cases ?? {};
  for (const id of Object.keys(c2FactCases)) if (!idxIds.includes(id)) throw new Error(`corpus 2 facts hold case ${id}, which is not in the index`);
  for (const id of idxIds) if (!c2FactCases[id]) throw new Error(`corpus 2 index case ${id} has no facts`);
  checkJudgments('development', dev.judgments, findings, controlIds);
  checkJudgments('corpus 2', corpus2.judgments, idxIds, controlIds);

  const prep = (cases, ids) => Object.fromEntries(ids.map((id) => {
    const facts = cases[id].facts;
    try { assertFacts(facts, vocab); } catch (e) { throw new Error(`case ${id}: ${e.message}`); }
    return [id, { facts, known: knownOnly(facts, vocab) }];
  }));
  const devC = prep(devFactCases, findings);
  const c2C = prep(c2FactCases, idxIds);

  // ---- labels
  const label = (corp, j, id, c) => corp.judges[j][id][c];
  const positive = (corp, id, c) => label(corp, 'J1', id, c) === 'yes' && label(corp, 'J2', id, c) === 'yes';
  const atLeastPartial = (corp, id, c) => !positive(corp, id, c)
    && ['J1', 'J2'].every((j) => label(corp, j, id, c) === 'yes' || label(corp, j, id, c) === 'partial');
  const devJ = dev.judgments;
  const c2J = corpus2.judgments;

  const sel = (cat, facts) => new Set(selected(cat, facts));

  // ---- R0
  const base = computeBaselines(catalog, fixtures.scenarios, fixtures.labels, fixtures.ledger.entries ?? []);
  const cf = base.baselines.catalog_faithful;
  const R0 = { recalled: cf.recalled, must_select_total: base.must_select_total, inapplicable_violations: cf.inapplicable_violations, net_hard_defects: cf.net_hard_defects, fixtures_version: fixtures.manifest.version };

  // ---- R1
  const refs = fixtures.scenarios.filter((s) => typeof s.origin === 'string' && s.origin.startsWith('audit:'));
  const boolNames = Object.keys(vocab).filter((k) => vocab[k].type === 'bool');
  const enumNames = Object.keys(vocab).filter((k) => vocab[k].type !== 'bool');
  const R1b = Object.fromEntries(boolNames.map((n) => [n, { agree: 0, writer_true_ref_false: 0, writer_false_ref_true: 0, writer_unknown: 0, ref_unknown: 0 }]));
  const R1e = Object.fromEntries(enumNames.map((n) => [n, { both: 0, writer_only: 0, ref_only: 0 }]));
  let r1cases = 0;
  const setOf = (v) => new Set(Array.isArray(v) ? v.filter((x) => x !== 'unknown') : []);
  for (const s of refs) {
    const f = s.origin.slice('audit:'.length);
    const w = devC[f];
    if (!w) continue;
    r1cases++;
    for (const n of boolNames) {
      const a = w.facts[n]; const b = s.facts[n]; const t = R1b[n];
      if (unknownish(a)) t.writer_unknown++;
      if (unknownish(b)) t.ref_unknown++;
      if (unknownish(a) || unknownish(b)) continue;
      if (a === b) t.agree++; else if (a === true) t.writer_true_ref_false++; else t.writer_false_ref_true++;
    }
    for (const n of enumNames) {
      const a = setOf(w.facts[n]); const b = setOf(s.facts[n]); const t = R1e[n];
      for (const x of a) if (b.has(x)) t.both++; else t.writer_only++;
      for (const x of b) if (!a.has(x)) t.ref_only++;
    }
  }
  const R1 = { label: prereg.development_data.label, cases: r1cases, boolean: R1b, enum: R1e };

  // ---- R2
  const sources = sourceControls(catalog, prereg, findings);
  const pairKeys = ['selected_known', 'selected_unknown_only', 'not_selected'];
  const pairs = { specific: zero(pairKeys), always_on: zero(pairKeys) };
  const perFinding = { specific_source_selected_known: 0, specific_source_selected_unknown_only: 0, specific_source_not_selected: 0, only_always_on_sources: 0 };
  const pf = { some_true: 0, none_true_some_unknown: 0, all_false: 0 };
  for (const f of findings) {
    const given = sel(catalog, devC[f].facts); const known = sel(catalog, devC[f].known);
    const kind = (c) => (known.has(c) ? 'selected_known' : given.has(c) ? 'selected_unknown_only' : 'not_selected');
    const spec = sources[f].filter((c) => specSet.has(c));
    for (const c of sources[f]) pairs[specSet.has(c) ? 'specific' : 'always_on'][kind(c)]++;
    if (spec.length === 0) perFinding.only_always_on_sources++;
    else if (spec.some((c) => kind(c) === 'selected_known')) perFinding.specific_source_selected_known++;
    else if (spec.some((c) => kind(c) === 'selected_unknown_only')) perFinding.specific_source_selected_unknown_only++;
    else perFinding.specific_source_not_selected++;
    for (const c of sources[f].filter(isAbuse)) {
      const ctl = catalog.controls.find((x) => x.id === c);
      const vals = (ctl.primary_facts ?? []).map((n) => devC[f].facts[n]);
      if (vals.some((v) => v === true)) pf.some_true++;
      else if (vals.some((v) => unknownish(v))) pf.none_true_some_unknown++;
      else pf.all_false++;
    }
  }
  const R2 = { label: prereg.development_data.label, pairs, findings: perFinding, primary_facts: pf };

  // ---- R3
  const outcomeKeys = ['specific_hit_known', 'specific_hit_unknown_only', 'always_on_only', 'partial_only', 'none'];
  const familyOf = (f) => Object.entries(prereg.development_data.families).find(([, l]) => l.includes(f))?.[0];
  const auditSourcesOf = (c) => (c.sources ?? []).filter((s) => s.kind === 'audit').map((s) => s.ref.slice(s.ref.indexOf(':') + 1));
  const fold = (removeIds, ids) => {
    const cat = { ...catalog, controls: catalog.controls.filter((c) => !removeIds.has(c.id)) };
    const rem = cat.controls.map((c) => c.id);
    const out = { findings: ids.length, ...zero(outcomeKeys) };
    for (const f of ids) {
      const given = sel(cat, devC[f].facts); const known = sel(cat, devC[f].known);
      const pos = (c) => positive(devJ, f, c);
      const remSpec = rem.filter((c) => specSet.has(c));
      if (remSpec.some((c) => pos(c) && known.has(c))) out.specific_hit_known++;
      else if (remSpec.some((c) => pos(c) && given.has(c))) out.specific_hit_unknown_only++;
      else if (rem.some((c) => alwaysSet.has(c) && pos(c) && given.has(c))) out.always_on_only++;
      else if (rem.some((c) => given.has(c) && atLeastPartial(devJ, f, c))) out.partial_only++;
      else out.none++;
    }
    return out;
  };
  const folds = { full: fold(new Set(), findings) };
  for (const [name, list] of Object.entries(prereg.development_data.families)) {
    const rm = new Set(catalog.controls.filter((c) => auditSourcesOf(c).some((f) => list.includes(f))).map((c) => c.id));
    folds[`family:${name}`] = fold(rm, [...list].sort());
  }
  folds.all_abuse_removed = fold(new Set(controlIds.filter(isAbuse)), findings.filter((f) => familyOf(f)));
  const R3 = { label: prereg.development_data.label, folds };

  // ---- R4
  const cellKeys = ['needed_selected', 'needed_missed', 'unneeded_selected', 'unneeded_left_out'];
  const caseKeys = ['specific_hit', 'specific_missed', 'always_on_hit', 'always_on_missed', 'partial_only', 'no_check_in_catalog'];
  const selectors = {
    catalog_as_given: (id) => sel(catalog, c2C[id].facts),
    catalog_known_only: (id) => sel(catalog, c2C[id].known),
    select_everything: () => new Set(controlIds),
    always_on_only: () => new Set(alwaysOn),
  };
  const caseOutcome = (id, s) => {
    const p = (c) => positive(c2J, id, c);
    const posSpec = specific.filter(p);
    if (posSpec.length) return posSpec.some((c) => s.has(c)) ? 'specific_hit' : 'specific_missed';
    const posAlways = alwaysOn.filter(p);
    if (posAlways.length) return posAlways.some((c) => s.has(c)) ? 'always_on_hit' : 'always_on_missed';
    if (controlIds.some((c) => atLeastPartial(c2J, id, c))) return 'partial_only';
    return 'no_check_in_catalog';
  };
  const cells = {}; const outcomes = {}; const byCwe = {};
  for (const [name, fn] of Object.entries(selectors)) {
    const t = zero(cellKeys); const o = zero(caseKeys);
    for (const k of idx) {
      const s = fn(k.id);
      for (const c of specific) {
        const need = positive(c2J, k.id, c);
        t[need ? (s.has(c) ? 'needed_selected' : 'needed_missed') : (s.has(c) ? 'unneeded_selected' : 'unneeded_left_out')]++;
      }
      const oc = caseOutcome(k.id, s);
      o[oc]++;
      if (name === 'catalog_as_given' || name === 'catalog_known_only') {
        const cwe = k.cwes?.[0] ?? 'none';
        byCwe[cwe] ??= {};
        byCwe[cwe][name] ??= zero(caseKeys);
        byCwe[cwe][name][oc]++;
      }
    }
    cells[name] = t; outcomes[name] = o;
  }
  const by_cwe = {};
  for (const cwe of sortStr(Object.keys(byCwe))) by_cwe[cwe] = { catalog_as_given: byCwe[cwe].catalog_as_given ?? zero(caseKeys), catalog_known_only: byCwe[cwe].catalog_known_only ?? zero(caseKeys) };
  const R4 = { label: prereg.corpus2_rule.label, cells, outcomes, by_cwe };

  // ---- R5
  const breadth = (cat, caseMap, ids, key) => {
    const n = ids.map((id) => selected(cat, caseMap[id][key]).length).sort((a, b) => a - b);
    if (!n.length) return { cases: 0, min: 0, median: 0, max: 0 };
    const m = n.length >> 1;
    return { cases: n.length, min: n[0], median: n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2, max: n[n.length - 1] };
  };
  const R5 = {
    development: { as_given: breadth(catalog, devC, findings, 'facts'), known_only: breadth(catalog, devC, findings, 'known') },
    corpus2: { as_given: breadth(catalog, c2C, idxIds, 'facts'), known_only: breadth(catalog, c2C, idxIds, 'known') },
  };

  // ---- judges
  const matrix = (corp, ids) => {
    const m = Object.fromEntries(LABELS.map((a) => [a, zero(LABELS)]));
    for (const id of ids) for (const c of controlIds) m[label(corp, 'J1', id, c)][label(corp, 'J2', id, c)]++;
    return m;
  };
  const CAT = ['covered', 'partial', 'none'];
  const wave = Object.fromEntries(CAT.map((a) => [a, zero(CAT)]));
  const nonAbuse = controlIds.filter((c) => !isAbuse(c));
  const mapping = prereg.development_data.wave_a_mapping;
  for (const f of findings) {
    const row = CAT.find((k) => (mapping[k] ?? []).includes(f));
    if (!row) throw new Error(`finding ${f} is not in wave_a_mapping`);
    const col = nonAbuse.some((c) => positive(devJ, f, c)) ? 'covered'
      : nonAbuse.every((c) => label(devJ, 'J1', f, c) === 'no' && label(devJ, 'J2', f, c) === 'no') ? 'none' : 'partial';
    wave[row][col]++;
  }
  const judges = { agreement: { development: matrix(devJ, findings), corpus2: matrix(c2J, idxIds) }, wave_a_concordance: wave };

  // ---- claim
  const rule = prereg.claim_rules.beyond_the_audited_product;
  const oc = outcomes.catalog_as_given; const cl = cells.catalog_as_given;
  const hit = oc.specific_hit; const needs = oc.specific_hit + oc.specific_missed;
  const allowed = needs >= 1 && 2 * hit >= needs && cl.unneeded_left_out >= cl.unneeded_selected;
  const sentence = allowed
    ? rule.allowed_sentence.replace('{cases}', String(idx.length)).replace('{specific_hit}', String(hit)).replace('{needs_specific}', String(needs))
      .replace('{unneeded_left_out}', String(cl.unneeded_left_out)).replace('{unneeded_selected}', String(cl.unneeded_selected))
    : rule.otherwise_sentence;

  return { schema: 'vapt-effectiveness-results-v1', catalog_digest: inputs.catalog_digest, fixtures_version: fixtures.manifest.version, always_on: alwaysOn, specific, R0, R1, R2, R3, R4, R5, judges, claim: { allowed, sentence } };
}

// ------------------------------------------------------------------ report
let cachedPrereg;
/** Read and cache the prereg.json next to this script. */
const defaultPrereg = () => (cachedPrereg ??= JSON.parse(readFileSync(join(here, 'prereg.json'), 'utf8')));

/** One markdown table row. */
const row = (cells) => `| ${cells.join(' | ')} |`;
/** A markdown table from a header and rows. */
function table(head, rows) { return [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n'); }
/** Two-column markdown table of an object's counts and cases. */
const kv = (obj) => table(['Count', 'Cases'], Object.entries(obj).map(([k, v]) => [k, v]));

/** Render the results as the markdown block that goes between the report markers. */
export function renderBlock(results, prereg = defaultPrereg()) {
  const lab = prereg.development_data.label;
  const R = results; const L = [];
  const h = (t) => L.push('', t, '');
  const p = (t) => L.push(t, '');
  L.push('## Claim', '', R.claim.sentence, '');
  p('Counts only. This report does not say that security improved.');
  h('## R0 selector fidelity on the fixture scenarios');
  L.push(table(['Measure', 'Count'], [['must-select labels recalled', R.R0.recalled], ['must-select labels in total', R.R0.must_select_total], ['inapplicable labels selected', R.R0.inapplicable_violations], ['net hard defects', R.R0.net_hard_defects], ['fixtures version', R.R0.fixtures_version]]), '');
  p(`Limit: ${prereg.measures.R0.note}`);
  h(`## R1 writer facts against reference scenarios (${lab})`);
  p(`Cases compared: ${R.R1.cases}.`);
  L.push(table(['Fact', 'Agree', 'Writer true, reference false', 'Writer false, reference true', 'Writer unknown', 'Reference unknown'],
    Object.entries(R.R1.boolean).map(([k, v]) => [k, v.agree, v.writer_true_ref_false, v.writer_false_ref_true, v.writer_unknown, v.ref_unknown])), '');
  L.push(table(['Enum fact', 'In both', 'Writer only', 'Reference only'], Object.entries(R.R1.enum).map(([k, v]) => [k, v.both, v.writer_only, v.ref_only])), '');
  p(`Limit: ${prereg.measures.R1.note}`);
  h(`## R2 source control selection (${lab})`);
  L.push(table(['Source controls', 'Selected, known facts', 'Selected through unknown only', 'Not selected'],
    [['specific', ...pairKeysOf(R.R2.pairs.specific)], ['always on', ...pairKeysOf(R.R2.pairs.always_on)]]), '');
  L.push(table(['Findings', 'Count'], [['specific source selected, known facts', R.R2.findings.specific_source_selected_known], ['specific source selected through unknown only', R.R2.findings.specific_source_selected_unknown_only], ['specific source not selected', R.R2.findings.specific_source_not_selected], ['only always-on sources', R.R2.findings.only_always_on_sources]]), '');
  L.push(table(['Primary facts of the source control', 'Count'], [['some true', R.R2.primary_facts.some_true], ['none true, some unknown', R.R2.primary_facts.none_true_some_unknown], ['all false', R.R2.primary_facts.all_false]]), '');
  p('Limit: the writer saw the catalog vocabulary, whose examples paraphrase some of these findings.');
  h(`## R3 ablation of family-derived controls (${lab})`);
  L.push(table(['Fold', 'Findings', 'Specific hit, known facts', 'Specific hit, unknown only', 'Always-on only', 'Partial only', 'None'],
    Object.entries(R.R3.folds).map(([k, v]) => [k, v.findings, v.specific_hit_known, v.specific_hit_unknown_only, v.always_on_only, v.partial_only, v.none])), '');
  p(`Limit: ${prereg.measures.R3.note}`);
  h(`## R4 selection on public advisories (${prereg.corpus2_rule.label})`);
  L.push(table(['Selector', 'Needed, selected', 'Needed, missed', 'Unneeded, selected', 'Unneeded, left out'],
    Object.entries(R.R4.cells).map(([k, v]) => [k, v.needed_selected, v.needed_missed, v.unneeded_selected, v.unneeded_left_out])), '');
  const ck = ['specific_hit', 'specific_missed', 'always_on_hit', 'always_on_missed', 'partial_only', 'no_check_in_catalog'];
  L.push(table(['Case outcome', ...ck], Object.entries(R.R4.outcomes).filter(([k]) => k.startsWith('catalog')).map(([k, v]) => [k, ...ck.map((c) => v[c])])), '');
  const cweRows = [];
  for (const [cwe, v] of Object.entries(R.R4.by_cwe)) for (const [sel, o] of Object.entries(v)) cweRows.push([cwe, sel, ...ck.map((c) => o[c])]);
  L.push(table(['First CWE', 'Selector', ...ck], cweRows), '');
  p('Limit: fact writers and judges are model agents without enforced blindness; the cases are one slice of recent public advisories.');
  h('## R5 breadth (controls selected per case)');
  const br = [];
  for (const [corp, v] of Object.entries(R.R5)) for (const [mode, s] of Object.entries(v)) br.push([corp, mode, s.cases, s.min, s.median, s.max]);
  L.push(table(['Corpus', 'Facts', 'Cases', 'Minimum', 'Median', 'Maximum'], br), '');
  p('Limit: one run. Breadth counts the controls selected, not the controls needed, and the development facts are broad (see R1).');
  h('## Judges');
  const mat = (m) => table(['Judge 1 \\ Judge 2', ...LABELS], LABELS.map((a) => [a, ...LABELS.map((b) => m[a][b])]));
  p('Development cells, judge 1 by judge 2:');
  L.push(mat(R.judges.agreement.development), '');
  p('Corpus 2 cells, judge 1 by judge 2:');
  L.push(mat(R.judges.agreement.corpus2), '');
  p(`Wave A concordance (${lab}), mapping by judges' category:`);
  const CAT = ['covered', 'partial', 'none'];
  L.push(table(['Mapping \\ Judges', ...CAT], CAT.map((a) => [a, ...CAT.map((b) => R.judges.wave_a_concordance[a][b])])), '');
  p('Limit: both judges are the same model family, so their agreement overstates independent agreement.');
  h('## Not measured');
  for (const t of prereg.not_measured) L.push(`- ${t}`);
  L.push('');
  return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') ;
}
/** The three case-list fields of a paired-selection result. */
const pairKeysOf = (o) => [o.selected_known, o.selected_unknown_only, o.not_selected];

/** Replace the text between the report markers; throw if the markers are missing. */
export function replaceBlock(text, block) {
  const a = text.indexOf(BEGIN); const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`report has no ${BEGIN} ... ${END} block`);
  return text.slice(0, a + BEGIN.length) + '\n' + block + text.slice(b);
}
/** The text between the report markers, or null if they are missing. */
const extractBlock = (text) => {
  const a = text.indexOf(BEGIN); const b = text.indexOf(END);
  return a < 0 || b < a ? null : text.slice(a + BEGIN.length + 1, b);
};

// ----------------------------------------------------------------- loading
/** Path of skills/vapt under a repo root. */
const vaptDir = (root) => join(root, 'skills', 'vapt');
/** Read every input file of the effectiveness study from disk. */
export function loadInputs(dir = here, repoRoot = DEFAULT_ROOT) {
  const j = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const fx = join(vaptDir(repoRoot), 'fixtures');
  const catBytes = readFileSync(join(vaptDir(repoRoot), 'controls.json'));
  let labels = j(join(fx, 'labels.json'));
  if (!Array.isArray(labels)) labels = Object.entries(labels).map(([scenario_id, l]) => ({ scenario_id, ...l }));
  return {
    catalog: JSON.parse(catBytes),
    catalog_digest: catalogDigest(catBytes),
    prereg: j(join(dir, 'prereg.json')),
    fixtures: { scenarios: j(join(fx, 'scenarios.json')), labels, manifest: j(join(fx, 'manifest.json')), ledger: j(join(fx, 'disagreements.json')) },
    dev: { facts: j(join(dir, DEV_FACTS)), judgments: j(join(dir, DEV_JUDG)) },
    corpus2: { index: j(join(dir, C2_INDEX)), facts: j(join(dir, C2_FACTS)), judgments: j(join(dir, C2_JUDG)) },
  };
}
/** SHA-256 of each hashed data file in the folder. */
export function dataHashes(dir = here) {
  return Object.fromEntries(HASHED_FILES.map((f) => [f, sha(readFileSync(join(dir, f)))]));
}

// -------------------------------------------------------------- real data
const FORBIDDEN_KEY = /^(selected|selection|selections|selected_controls)$/i;
/** Paths of every object key in a JSON value that matches the pattern. */
const hasKey = (v, re, path = '') => {
  if (Array.isArray(v)) return v.flatMap((x, i) => hasKey(x, re, `${path}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => (re.test(k) ? [`${path}.${k}`] : []).concat(hasKey(x, re, `${path}.${k}`)));
  return [];
};
/** Check an object has exactly the given keys; record problems in e and return false if it is not an object. */
const exactKeys = (o, keys, where, e) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) { e.push(`${where}: not an object`); return false; }
  for (const k of Object.keys(o)) if (!keys.includes(k)) e.push(`${where}: unexpected key '${k}'`);
  for (const k of keys) if (!(k in o)) e.push(`${where}: missing key '${k}'`);
  return true;
};

/** Validate a facts file against the vocabulary and case ids, recording problems in e. */
function checkFacts(file, doc, vocab, ids, e) {
  if (!exactKeys(doc, ['schema', 'cases'], file, e)) return;
  if (doc.schema !== 'vapt-effectiveness-facts-v1') e.push(`${file}: schema is ${JSON.stringify(doc.schema)}`);
  const cases = doc.cases ?? {};
  if (ids) {
    for (const i of ids) if (!(i in cases)) e.push(`${file}: missing case ${i}`);
    for (const i of Object.keys(cases)) if (!ids.includes(i)) e.push(`${file}: unexpected case ${i}`);
  }
  for (const [id, c] of Object.entries(cases)) {
    if (!exactKeys(c, ['facts'], `${file} ${id}`, e)) continue;
    if (!exactKeys(c.facts, Object.keys(vocab), `${file} ${id} facts`, e)) continue;
    for (const [n, def] of Object.entries(vocab)) {
      const v = c.facts[n];
      if (def.type === 'bool') { if (v !== true && v !== false && v !== 'unknown') e.push(`${file} ${id}: fact ${n} is not true, false or "unknown"`); }
      else if (v !== 'unknown' && !(Array.isArray(v) && v.every((x) => def.values.includes(x)))) e.push(`${file} ${id}: fact ${n} is not a list of vocabulary values or "unknown"`);
    }
  }
}
/** Validate a judgments file against the control and case ids, recording problems in e. */
function checkJudgFile(file, doc, controlIds, ids, e) {
  if (!exactKeys(doc, ['schema', 'judges'], file, e)) return;
  if (doc.schema !== 'vapt-effectiveness-judgments-v1') e.push(`${file}: schema is ${JSON.stringify(doc.schema)}`);
  if (!exactKeys(doc.judges, ['J1', 'J2'], `${file} judges`, e)) return;
  for (const j of ['J1', 'J2']) {
    exactKeys(doc.judges[j], ids, `${file} ${j}`, e);
    for (const [id, r] of Object.entries(doc.judges[j] ?? {})) {
      if (!exactKeys(r, controlIds, `${file} ${j} ${id}`, e)) continue;
      for (const c of controlIds) if (!LABELS.includes(r[c])) e.push(`${file} ${j} ${id} ${c}: label is not yes, partial or no`);
    }
  }
}

/** Check the data folder is complete, sealed, scored and reported; return a list of problems. */
export function checkRealData(dir = here, repoRoot = DEFAULT_ROOT) {
  const e = [];
  const need = [...HASHED_FILES, 'manifest.json', 'results.json', 'REPORT.md'];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  for (const f of missing) e.push(`missing file ${f}`);
  if (missing.length) return e;
  const j = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  let manifest, prereg;
  try { manifest = j('manifest.json'); prereg = j('prereg.json'); } catch (x) { return [...e, `unreadable JSON: ${x.message}`]; }
  const catBytes = readFileSync(join(vaptDir(repoRoot), 'controls.json'));
  const catalog = JSON.parse(catBytes);
  const vocab = catalog.fact_vocabulary;
  const controlIds = catalog.controls.map((c) => c.id);

  // sealing
  const want = dataHashes(dir);
  exactKeys(manifest.sha256, HASHED_FILES, 'manifest.json sha256', e);
  for (const f of HASHED_FILES) if (manifest.sha256?.[f] !== want[f]) e.push(`${f}: sha256 differs from manifest.json`);
  const digest = catalogDigest(catBytes);
  if (new Set([manifest.catalog_digest, prereg.frozen?.catalog_digest, digest]).size !== 1) {
    e.push(`catalog digest disagrees (manifest ${manifest.catalog_digest}, prereg ${prereg.frozen?.catalog_digest}, controls.json ${digest}): results are stale and need a re-score after the catalog is re-frozen`);
  }
  const fixM = JSON.parse(readFileSync(join(vaptDir(repoRoot), 'fixtures', 'manifest.json'), 'utf8'));
  if (manifest.fixtures_version !== fixM.version) e.push(`manifest fixtures_version ${manifest.fixtures_version} is not the fixtures manifest version ${fixM.version}: results are stale and need a re-score`);

  // schema-closed data
  let docs;
  try { docs = Object.fromEntries(DATA_FILES.map((f) => [f, j(f)])); } catch (x) { return [...e, `unreadable data file: ${x.message}`]; }
  for (const f of DATA_FILES) for (const p of hasKey(docs[f], FORBIDDEN_KEY)) e.push(`${f}: forbidden key '${p.split('.').pop()}' at ${p}`);
  const devIds = devFindings(prereg);
  const c2 = docs[C2_INDEX];
  if (exactKeys(c2, ['schema', 'frozen_at', 'examined', 'cases', 'skipped'], C2_INDEX, e)) {
    if (c2.schema !== 'vapt-effectiveness-corpus2-v1') e.push(`${C2_INDEX}: schema is ${JSON.stringify(c2.schema)}`);
    const rules = prereg.corpus2_rule.skip_log.match(/withdrawn.*cap/)?.[0].split(/,\s*/) ?? [];
    if (!rules.length) e.push('prereg.json corpus2_rule.skip_log: no preregistered skip rules could be parsed from it, so skipped entries cannot be checked');
    for (const [i, c] of (c2.cases ?? []).entries()) {
      exactKeys(c, ['id', 'ghsa_id', 'cwes', 'ecosystem', 'package', 'repo', 'fix_sha', 'parent_sha', 'files', 'published_at'], `${C2_INDEX} case ${i}`, e);
      if (!/^C2-\d\d$/.test(c.id ?? '')) e.push(`${C2_INDEX} case ${i}: bad id`);
    }
    for (const [i, s] of (c2.skipped ?? []).entries()) {
      exactKeys(s, ['ghsa_id', 'rule'], `${C2_INDEX} skipped ${i}`, e);
      if (!rules.includes(s.rule)) e.push(`${C2_INDEX} skipped ${i}: rule '${s.rule}' is not a preregistered skip rule`);
    }
  }
  const c2Ids = (c2?.cases ?? []).map((c) => c.id);
  checkFacts(DEV_FACTS, docs[DEV_FACTS], vocab, devIds, e);
  checkFacts(C2_FACTS, docs[C2_FACTS], vocab, c2Ids, e);
  checkJudgFile(DEV_JUDG, docs[DEV_JUDG], controlIds, devIds, e);
  checkJudgFile(C2_JUDG, docs[C2_JUDG], controlIds, c2Ids, e);
  if (e.length) return e;

  // results and report
  let results, inputs;
  try { inputs = loadInputs(dir, repoRoot); results = score(inputs); } catch (x) { return [...e, `scoring failed: ${x.message}`]; }
  if (readFileSync(join(dir, 'results.json'), 'utf8') !== JSON.stringify(results, null, 2) + '\n') e.push('results.json differs from the scorer output: results are stale, re-score with: node skills/vapt/fixtures/effectiveness/score.mjs --write');
  const report = readFileSync(join(dir, 'REPORT.md'), 'utf8');
  const block = extractBlock(report);
  if (block === null) e.push(`REPORT.md has no ${BEGIN} block`);
  else if (block !== renderBlock(results, prereg)) e.push('REPORT.md results block differs from the scorer output: regenerate it with: node skills/vapt/fixtures/effectiveness/score.mjs --report skills/vapt/fixtures/effectiveness/REPORT.md');
  if (/\d%/.test(report)) e.push('REPORT.md contains a percentage (a digit followed by %): counts only');
  return e;
}

// --------------------------------------------------------------------- cli
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const dir = here; const root = DEFAULT_ROOT;
  if (a[0] === '--hashes') console.log(JSON.stringify(dataHashes(dir), null, 2));
  else if (a[0] === '--write' || a[0] === '--block' || a[0] === '--report') {
    const inputs = loadInputs(dir, root);
    const res = score(inputs);
    if (a[0] === '--write') writeFileSync(join(dir, 'results.json'), JSON.stringify(res, null, 2) + '\n');
    else if (a[0] === '--block') process.stdout.write(renderBlock(res, inputs.prereg));
    else {
      if (!a[1]) { console.error('--report needs a path'); process.exit(2); }
      writeFileSync(a[1], replaceBlock(readFileSync(a[1], 'utf8'), renderBlock(res, inputs.prereg)));
    }
  } else { console.error('usage: score.mjs --write | --block | --report <path> | --hashes'); process.exit(2); }
}
