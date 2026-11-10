// Tests for the vapt effectiveness tools: the scorer, the corpus-2 picker rule and the local-only input builder.
// Scorer tests run on a tiny made-up catalog (the evaluator is still the one in controls.mjs) and a prereg that
// reuses the real measures/claim text with a three-finding development set. No test touches the network.
// The last scorer test checks the real data folder; it fails until the orchestrator adds the data files.
// Run: node --test skills/vapt/effectiveness.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './controls.mjs';
import * as E from './fixtures/effectiveness/score.mjs';
import * as B from './fixtures/effectiveness/build-corpus2.mjs';
import * as P from './fixtures/effectiveness/prep-local.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const effDir = join(here, 'fixtures', 'effectiveness');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const REAL_PREREG = JSON.parse(readFileSync(join(effDir, 'prereg.json'), 'utf8'));
const tmp = (p) => mkdtempSync(join(tmpdir(), `${p}-`));

// ---------------------------------------------------------------- tiny world
const TINY = {
  catalog_version: 1,
  fact_vocabulary: {
    boundaries: { type: 'enum', values: ['b1', 'b2'] },
    principals: { type: 'enum', values: ['anonymous', 'service'] },
    flag_a: { type: 'bool' },
    flag_b: { type: 'bool' },
  },
  controls: [
    // always_on: selected for every boundary kind.
    { id: 'VAPT-API-01', applies_when: { any: [{ fact: 'boundaries', op: 'includes', value: 'b1' }, { fact: 'boundaries', op: 'includes', value: 'b2' }] }, sources: [] },
    { id: 'VAPT-API-02', applies_when: { fact: 'flag_b', op: 'is', value: true }, sources: [] },
    // specific but not universal: only boundary b2.
    { id: 'VAPT-API-03', applies_when: { fact: 'boundaries', op: 'includes', value: 'b2' }, sources: [] },
    { id: 'VAPT-ABUSE-01', applies_when: { fact: 'flag_a', op: 'is', value: true }, primary_facts: ['flag_a'], sources: [{ kind: 'audit', ref: 'storecraft-run-1:F01' }] },
    { id: 'VAPT-ABUSE-02', applies_when: { fact: 'flag_b', op: 'is', value: true }, primary_facts: ['flag_b'], sources: [{ kind: 'audit', ref: 'storecraft-run-1:F02' }] },
  ],
};
const TINY_PREREG = {
  ...REAL_PREREG,
  frozen: { ...REAL_PREREG.frozen, catalog_digest: 'sha256:tiny' },
  development_data: {
    ...REAL_PREREG.development_data,
    families: { famA: ['F01'], famB: ['F02'] },
    pre_audit_covered: { F03: 'VAPT-API-01' },
    wave_a_mapping: { covered: ['F03'], none: ['F01'], partial: ['F02'] },
  },
};
const F = (o = {}) => ({ boundaries: ['b1'], principals: ['service'], flag_a: false, flag_b: false, ...o });
const SCEN = [
  { id: 'S1', origin: 'audit:F01', facts: F({ flag_a: true }) },
  { id: 'S2', origin: 'synthetic', facts: F() },
];
const LABELS = [
  { scenario_id: 'S1', must_select: ['VAPT-ABUSE-01'], inapplicable: ['VAPT-API-03'] },
  { scenario_id: 'S2', must_select: [], inapplicable: ['VAPT-API-01'] },
];
const BASE = () => ({
  catalog: TINY,
  dev: {
    F01: { f: F({ flag_a: 'unknown' }), y: { 'VAPT-ABUSE-01': 'yes' } },
    F02: { f: F({ flag_b: true }), y: { 'VAPT-ABUSE-02': 'yes' } },
    F03: { f: F(), y: { 'VAPT-API-01': 'yes', 'VAPT-API-02': 'yes' }, y2: { 'VAPT-API-01': 'yes', 'VAPT-API-02': 'partial' } },
  },
  c2: [
    { id: 'C2-01', cwes: ['CWE-79'], f: F({ flag_a: true }), y: { 'VAPT-ABUSE-01': 'yes' } }, // caught
    { id: 'C2-02', cwes: ['CWE-79'], f: F(), y: { 'VAPT-ABUSE-01': 'yes' } }, // missed (known false)
    { id: 'C2-03', cwes: ['CWE-89'], f: F({ flag_a: 'unknown' }), y: { 'VAPT-ABUSE-01': 'yes' } }, // unknown-only
    { id: 'C2-04', cwes: ['CWE-89'], f: F(), y: { 'VAPT-API-01': 'yes' } }, // always-on only
    { id: 'C2-05', cwes: [], f: F(), y: {} }, // nothing needed
  ],
});
function mk(spec) {
  const ids = spec.catalog.controls.map((c) => c.id);
  const lab = (y) => Object.fromEntries(ids.map((i) => [i, y?.[i] ?? 'no']));
  const side = (items, key) => Object.fromEntries(Object.entries(items).map(([id, v]) => [id, lab(key === 2 ? (v.y2 ?? v.y) : v.y)]));
  const asObj = (arr) => Object.fromEntries(arr.map((c) => [c.id, c]));
  const dev = spec.dev; const c2 = asObj(spec.c2);
  return {
    catalog: spec.catalog,
    catalog_digest: 'sha256:tiny',
    prereg: TINY_PREREG,
    fixtures: { scenarios: SCEN, labels: LABELS, manifest: { version: 5 }, ledger: { entries: [] } },
    dev: {
      facts: { schema: 'vapt-effectiveness-facts-v1', cases: Object.fromEntries(Object.entries(dev).map(([id, v]) => [id, { facts: v.f }])) },
      judgments: { schema: 'vapt-effectiveness-judgments-v1', judges: { J1: side(dev, 1), J2: side(dev, 2) } },
    },
    corpus2: {
      index: { schema: 'vapt-effectiveness-corpus2-v1', frozen_at: '2026-11-01T00:00:00Z', examined: spec.c2.length, cases: spec.c2.map((c) => ({ id: c.id, ghsa_id: 'GHSA-x', cwes: c.cwes, ecosystem: 'npm', package: 'p', repo: 'o/r', fix_sha: 'a', parent_sha: 'b', files: ['x.js'], published_at: '2026-09-01T00:00:00Z' })), skipped: [] },
      facts: { schema: 'vapt-effectiveness-facts-v1', cases: Object.fromEntries(Object.entries(c2).map(([id, v]) => [id, { facts: v.f }])) },
      judgments: { schema: 'vapt-effectiveness-judgments-v1', judges: { J1: side(c2, 1), J2: side(c2, 2) } },
    },
  };
}
const run = (spec) => E.score(mk(spec));

// ------------------------------------------------------------ scorer: basics
test('identity: the scorer uses the evaluator function exported by controls.mjs, not a copy', () => {
  assert.strictEqual(E.selected, C.selected);
});

test('known_only: unknown booleans become false, absent/null/"unknown" enums become [] and known values stay', () => {
  const k = E.knownOnly({ boundaries: 'unknown', principals: ['service'], flag_a: 'unknown', flag_b: true }, TINY.fact_vocabulary);
  assert.deepEqual(k, { boundaries: [], principals: ['service'], flag_a: false, flag_b: true });
  const k2 = E.knownOnly({ flag_a: null }, TINY.fact_vocabulary);
  assert.deepEqual(k2, { boundaries: [], principals: [], flag_a: false, flag_b: false });
});

test('always_on is boundaryUniversal of the full catalog; specific is the rest', () => {
  const r = run(BASE());
  assert.deepEqual(r.always_on, ['VAPT-API-01']);
  assert.deepEqual(r.specific, ['VAPT-API-02', 'VAPT-API-03', 'VAPT-ABUSE-01', 'VAPT-ABUSE-02']);
  assert.equal(r.schema, 'vapt-effectiveness-results-v1');
  assert.equal(r.catalog_digest, 'sha256:tiny');
  assert.equal(r.fixtures_version, 5);
});

test('R0: restates the catalog_faithful baseline from the fixtures (recall, violations, hard defects)', () => {
  const r = run(BASE());
  assert.deepEqual(r.R0, { recalled: 1, must_select_total: 1, inapplicable_violations: 1, net_hard_defects: 1, fixtures_version: 5 });
});

test('R1: writer vs reference facts: unknown on one side is counted apart from agreement; enums compare value sets', () => {
  const r = run(BASE());
  assert.equal(r.R1.cases, 1);
  assert.deepEqual(r.R1.boolean.flag_a, { agree: 0, writer_true_ref_false: 0, writer_false_ref_true: 0, writer_unknown: 1, ref_unknown: 0 });
  assert.deepEqual(r.R1.boolean.flag_b, { agree: 1, writer_true_ref_false: 0, writer_false_ref_true: 0, writer_unknown: 0, ref_unknown: 0 });
  assert.deepEqual(r.R1.enum.boundaries, { both: 1, writer_only: 0, ref_only: 0 });
});

test('R2: a source control selected only through an unknown fact is counted unknown_only; always-on sources are counted apart', () => {
  const r = run(BASE());
  assert.deepEqual(r.R2.pairs.specific, { selected_known: 1, selected_unknown_only: 1, not_selected: 0 });
  assert.deepEqual(r.R2.pairs.always_on, { selected_known: 1, selected_unknown_only: 0, not_selected: 0 });
  assert.deepEqual(r.R2.findings, { specific_source_selected_known: 1, specific_source_selected_unknown_only: 1, specific_source_not_selected: 0, only_always_on_sources: 1 });
  assert.deepEqual(r.R2.primary_facts, { some_true: 1, none_true_some_unknown: 1, all_false: 0 });
});

test('R3 full fold: known hit, unknown-only hit and always-on-only outcomes are told apart', () => {
  const full = run(BASE()).R3.folds.full;
  assert.deepEqual(full, { findings: 3, specific_hit_known: 1, specific_hit_unknown_only: 1, always_on_only: 1, partial_only: 0, none: 0 });
});

test('R3 ablation: removing the only positive control of a family leaves its finding with no hit', () => {
  const r = run(BASE()).R3.folds;
  assert.deepEqual(Object.keys(r), ['full', 'family:famA', 'family:famB', 'all_abuse_removed']);
  assert.deepEqual(r['family:famA'], { findings: 1, specific_hit_known: 0, specific_hit_unknown_only: 0, always_on_only: 0, partial_only: 0, none: 1 });
  assert.deepEqual(r['family:famB'], { findings: 1, specific_hit_known: 0, specific_hit_unknown_only: 0, always_on_only: 0, partial_only: 0, none: 1 });
  assert.equal(r.all_abuse_removed.findings, 2);
  assert.equal(r.all_abuse_removed.none, 2);
});

test('R3 partial_only: a remaining selected control that both judges rate at least partial counts as partial_only', () => {
  const s = BASE();
  s.dev.F01.y = { 'VAPT-ABUSE-01': 'yes', 'VAPT-API-02': 'partial' };
  s.dev.F01.f = F({ flag_a: 'unknown', flag_b: true });
  const r = E.score(mk(s)).R3.folds['family:famA'];
  assert.equal(r.partial_only, 1);
  assert.equal(r.none, 0);
});

test('R4 caught/missed/unknown-only/always-on-only/none cases are counted per selector', () => {
  const R4 = run(BASE()).R4;
  assert.deepEqual(R4.cells.catalog_as_given, { needed_selected: 2, needed_missed: 1, unneeded_selected: 0, unneeded_left_out: 17 });
  assert.deepEqual(R4.cells.catalog_known_only, { needed_selected: 1, needed_missed: 2, unneeded_selected: 0, unneeded_left_out: 17 });
  assert.deepEqual(R4.cells.select_everything, { needed_selected: 3, needed_missed: 0, unneeded_selected: 17, unneeded_left_out: 0 });
  assert.deepEqual(R4.cells.always_on_only, { needed_selected: 0, needed_missed: 3, unneeded_selected: 0, unneeded_left_out: 17 });
  assert.deepEqual(R4.outcomes.catalog_as_given, { specific_hit: 2, specific_missed: 1, always_on_hit: 1, always_on_missed: 0, partial_only: 0, no_check_in_catalog: 1 });
  assert.deepEqual(R4.outcomes.catalog_known_only, { specific_hit: 1, specific_missed: 2, always_on_hit: 1, always_on_missed: 0, partial_only: 0, no_check_in_catalog: 1 });
  assert.deepEqual(R4.by_cwe['CWE-79'].catalog_as_given, { specific_hit: 1, specific_missed: 1, always_on_hit: 0, always_on_missed: 0, partial_only: 0, no_check_in_catalog: 0 });
  assert.equal(R4.by_cwe.none.catalog_as_given.no_check_in_catalog, 1);
});

test('R4 always-on-only case: an always-on control is the only positive and is selected -> always_on_hit (not a specific hit)', () => {
  const s = BASE(); s.c2 = [s.c2[3]];
  const o = E.score(mk(s)).R4.outcomes.catalog_as_given;
  assert.equal(o.always_on_hit, 1);
  assert.equal(o.specific_hit + o.specific_missed, 0);
});

test('R5: breadth min/median/max of controls selected per case, as_given and known_only, dev and corpus 2', () => {
  const R5 = run(BASE()).R5;
  assert.deepEqual(R5.development.as_given, { cases: 3, min: 1, median: 2, max: 3 });
  assert.deepEqual(R5.development.known_only, { cases: 3, min: 1, median: 1, max: 3 });
  assert.equal(R5.corpus2.as_given.cases, 5);
});

test('judges: 3x3 agreement counts (judge 1 rows, judge 2 columns) and the Wave A concordance against the mapping', () => {
  const J = run(BASE()).judges;
  assert.deepEqual(J.agreement.development, { yes: { yes: 3, partial: 1, no: 0 }, partial: { yes: 0, partial: 0, no: 0 }, no: { yes: 0, partial: 0, no: 11 } });
  assert.equal(J.agreement.corpus2.yes.yes, 4);
  assert.deepEqual(J.wave_a_concordance, { covered: { covered: 1, partial: 0, none: 0 }, partial: { covered: 0, partial: 0, none: 1 }, none: { covered: 0, partial: 0, none: 1 } });
});

// -------------------------------------------------------------- claim rule
test('claim allowed: hits cover at least half the needing cases and unneeded left out >= unneeded selected', () => {
  const r = run(BASE());
  assert.equal(r.claim.allowed, true);
  assert.equal(r.claim.sentence, 'On 5 public advisory cases the catalog selected a needed specific check in 2 of the 3 cases that needed one, and left out 17 unneeded specific checks against 0 it selected.');
});

test('claim not allowed (too few hits): only a missed case -> the otherwise sentence', () => {
  const s = BASE(); s.c2 = [s.c2[1]];
  const r = E.score(mk(s));
  assert.equal(r.claim.allowed, false);
  assert.equal(r.claim.sentence, 'On this corpus the catalog did not show useful selection.');
});

test('claim not allowed (over-selection): a hit does not save a case that selects more unneeded than it leaves out', () => {
  const s = BASE();
  s.c2 = [{ id: 'C2-01', cwes: ['CWE-79'], f: F({ boundaries: ['b2'], flag_a: true, flag_b: true }), y: { 'VAPT-ABUSE-01': 'yes' } }];
  const r = E.score(mk(s));
  assert.equal(r.R4.cells.catalog_as_given.unneeded_selected, 3);
  assert.equal(r.R4.cells.catalog_as_given.unneeded_left_out, 0);
  assert.equal(r.claim.allowed, false);
});

test('claim zero-needs: no case needs a specific check -> not allowed, no division, the otherwise sentence', () => {
  const s = BASE(); s.c2 = [s.c2[4]];
  const r = E.score(mk(s));
  assert.equal(r.R4.outcomes.catalog_as_given.no_check_in_catalog, 1);
  assert.equal(r.claim.allowed, false);
  assert.equal(r.claim.sentence, REAL_PREREG.claim_rules.beyond_the_audited_product.otherwise_sentence);
});

test('no percentages and no timestamps anywhere in the results; key order is deterministic', () => {
  const a = JSON.stringify(run(BASE()));
  assert.ok(!/\d%/.test(a));
  assert.equal(a, JSON.stringify(run(BASE())));
  assert.deepEqual(Object.keys(JSON.parse(a)), ['schema', 'catalog_digest', 'fixtures_version', 'always_on', 'specific', 'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'judges', 'claim']);
});

// --------------------------------------------------------- scorer: mutations
test('mutation: flipping one writer fact (F02 flag_b true -> false) moves a source pair from selected_known to not_selected', () => {
  const base = run(BASE());
  const s = BASE(); s.dev.F02.f = F({ flag_b: false });
  const r = E.score(mk(s));
  assert.equal(base.R2.pairs.specific.selected_known, 1);
  assert.equal(r.R2.pairs.specific.selected_known, 0);
  assert.equal(r.R2.pairs.specific.not_selected, 1);
});

test('mutation: one judge changing "yes" to "no" removes a positive and turns a known hit into none', () => {
  const s = BASE(); s.dev.F02.y2 = {}; // judge 2 now says no for the only control judge 1 rated yes
  const r = E.score(mk(s));
  assert.equal(r.R3.folds.full.specific_hit_known, 0);
  assert.equal(r.R3.folds.full.none, 1);
});

test('mutation: removing one control from the catalog shrinks the specific list and the maximum breadth', () => {
  const base = run(BASE());
  const s = BASE(); s.catalog = { ...TINY, controls: TINY.controls.filter((c) => c.id !== 'VAPT-API-02') };
  s.dev.F03.y = { 'VAPT-API-01': 'yes' }; delete s.dev.F03.y2;
  const r = E.score(mk(s));
  assert.equal(base.specific.length - 1, r.specific.length);
  assert.equal(base.R5.development.as_given.max, 3);
  assert.equal(r.R5.development.as_given.max, 2);
});

// --------------------------------------------------------- scorer: failures
test('fails loudly: facts without judgments, a missing control id, a foreign label value, and an unknown corpus-2 id', () => {
  let s = mk(BASE()); delete s.dev.judgments.judges.J2.F01;
  assert.throws(() => E.score(s), /F01/);
  s = mk(BASE()); delete s.dev.judgments.judges.J1.F02['VAPT-API-03'];
  assert.throws(() => E.score(s), /VAPT-API-03/);
  s = mk(BASE()); s.dev.judgments.judges.J1.F02['VAPT-API-03'] = 'maybe';
  assert.throws(() => E.score(s), /maybe/);
  s = mk(BASE()); s.dev.judgments.judges.J1.F99 = s.dev.judgments.judges.J1.F01;
  assert.throws(() => E.score(s), /F99/);
  s = mk(BASE()); s.corpus2.index.cases = s.corpus2.index.cases.filter((c) => c.id !== 'C2-03');
  assert.throws(() => E.score(s), /C2-03/);
});

test('fails loudly: a missing family finding, out-of-vocabulary facts (naming the case) and a catalog digest that is not the frozen one', () => {
  let s = mk(BASE()); delete s.dev.facts.cases.F02; delete s.dev.judgments.judges.J1.F02; delete s.dev.judgments.judges.J2.F02;
  assert.throws(() => E.score(s), /F02/);
  s = mk(BASE()); s.corpus2.facts.cases['C2-02'].facts.not_a_fact = true;
  assert.throws(() => E.score(s), /C2-02/);
  s = mk(BASE()); s.catalog_digest = 'sha256:other';
  assert.throws(() => E.score(s), /digest/);
});

test('renderBlock: counts only, the development label in R1/R2/R3 headings, and the claim sentence the rule selects', () => {
  const r = run(BASE());
  const b = E.renderBlock(r, TINY_PREREG);
  assert.ok(!/\d%/.test(b));
  for (const m of ['R1', 'R2', 'R3']) {
    const line = b.split('\n').find((l) => l.startsWith('#') && l.includes(m));
    assert.ok(line?.includes(TINY_PREREG.development_data.label), `${m} heading names the label`);
  }
  assert.ok(b.includes(r.claim.sentence));
  assert.equal(b, E.renderBlock(r, TINY_PREREG));
});

test('replaceBlock swaps only the text between the markers', () => {
  const t = 'head\n<!-- RESULTS:BEGIN -->\nold\n<!-- RESULTS:END -->\ntail\n';
  assert.equal(E.replaceBlock(t, 'new\n'), 'head\n<!-- RESULTS:BEGIN -->\nnew\n<!-- RESULTS:END -->\ntail\n');
  assert.throws(() => E.replaceBlock('no markers', 'x'));
});

// ---------------------------------------------------------- checkRealData
const DATA_FILES = ['storecraft-facts.json', 'storecraft-judgments.json', 'corpus2-index.json', 'corpus2-facts.json', 'corpus2-judgments.json'];

function writeSynthetic() {
  const root = tmp('eff');
  const vdir = join(root, 'skills', 'vapt');
  const eff = join(vdir, 'fixtures', 'effectiveness');
  mkdirSync(eff, { recursive: true });
  copyFileSync(join(here, 'controls.json'), join(vdir, 'controls.json'));
  for (const f of ['scenarios.json', 'labels.json', 'manifest.json', 'disagreements.json']) copyFileSync(join(here, 'fixtures', f), join(vdir, 'fixtures', f));
  copyFileSync(join(effDir, 'prereg.json'), join(eff, 'prereg.json'));
  const catalog = JSON.parse(readFileSync(join(here, 'controls.json'), 'utf8'));
  const ids = catalog.controls.map((c) => c.id);
  const lab = (yes = []) => Object.fromEntries(ids.map((i) => [i, yes.includes(i) ? 'yes' : 'no']));
  const facts = (extra = {}) => ({ facts: { boundaries: ['request-handler'], principals: ['anonymous'], persistent_write: 'unknown', outbound_message: false, recipient_unproven: false, identity_claim_unproven: true, spends_or_reserves_value: false, shared_resource: false, caller_triggered_debit: false, state_transitions: false, plan_gated_feature: false, link_or_token_in_message: false, session_context: false, attempt_limit: false, sensitive_field_write: false, ...extra } });
  const devIds = Array.from({ length: 24 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`);
  const c2Ids = ['C2-01', 'C2-02', 'C2-03'];
  const sides = (cases) => ({ J1: Object.fromEntries(cases.map((c) => [c, lab(['VAPT-ABUSE-01'])])), J2: Object.fromEntries(cases.map((c) => [c, lab(['VAPT-ABUSE-01', 'VAPT-API-01'].slice(0, c === 'C2-02' ? 2 : 1))])) });
  const w = (name, o) => writeFileSync(join(eff, name), JSON.stringify(o, null, 2) + '\n');
  w('storecraft-facts.json', { schema: 'vapt-effectiveness-facts-v1', cases: Object.fromEntries(devIds.map((i) => [i, facts()])) });
  w('storecraft-judgments.json', { schema: 'vapt-effectiveness-judgments-v1', judges: sides(devIds) });
  w('corpus2-index.json', { schema: 'vapt-effectiveness-corpus2-v1', frozen_at: '2026-11-01T00:00:00Z', examined: 4, cases: c2Ids.map((id, i) => ({ id, ghsa_id: `GHSA-aaaa-bbbb-000${i}`, cwes: i ? ['CWE-79'] : [], ecosystem: 'npm', package: 'pkg', repo: 'o/r', fix_sha: 'a'.repeat(40), parent_sha: 'b'.repeat(40), files: ['index.js'], published_at: '2026-09-01T00:00:00Z' })), skipped: [{ ghsa_id: 'GHSA-zzzz-zzzz-zzzz', rule: 'cwe_cap' }] });
  w('corpus2-facts.json', { schema: 'vapt-effectiveness-facts-v1', cases: Object.fromEntries(c2Ids.map((i) => [i, facts({ identity_claim_unproven: i === 'C2-01' })])) });
  w('corpus2-judgments.json', { schema: 'vapt-effectiveness-judgments-v1', judges: sides(c2Ids) });
  finalize(root);
  return root;
}
// Recompute hashes, results and report so only the thing a test then tampers with is wrong.
function finalize(root, { results = true, report = true } = {}) {
  const eff = join(root, 'skills', 'vapt', 'fixtures', 'effectiveness');
  const fixM = JSON.parse(readFileSync(join(root, 'skills', 'vapt', 'fixtures', 'manifest.json'), 'utf8'));
  writeFileSync(join(eff, 'manifest.json'), JSON.stringify({
    schema: 'vapt-effectiveness-manifest-v1', sha256: E.dataHashes(eff), catalog_digest: REAL_PREREG.frozen.catalog_digest, fixtures_version: fixM.version,
    posted: {}, provenance: {}, local_only: {}, recheck: {}, limits: [],
  }, null, 2) + '\n');
  const inputs = E.loadInputs(eff, root);
  const res = E.score(inputs);
  if (results) writeFileSync(join(eff, 'results.json'), JSON.stringify(res, null, 2) + '\n');
  if (report) writeFileSync(join(eff, 'REPORT.md'), `# Report\n\n<!-- RESULTS:BEGIN -->\n${E.renderBlock(res, inputs.prereg)}<!-- RESULTS:END -->\n\nEnd.\n`);
}
const edit = (root, name, fn) => {
  const p = join(root, 'skills', 'vapt', 'fixtures', 'effectiveness', name);
  const o = JSON.parse(readFileSync(p, 'utf8')); fn(o); writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
};
const problemsOf = (root) => E.checkRealData(join(root, 'skills', 'vapt', 'fixtures', 'effectiveness'), root);

test('checkRealData: a clean synthetic folder passes', () => {
  const root = writeSynthetic();
  assert.deepEqual(problemsOf(root), []);
  rmSync(root, { recursive: true });
});

test('checkRealData: tampered data file, changed digest, stale results, differing block, percent sign, extra key and a selection key are each reported', () => {
  const effOf = (r) => join(r, 'skills', 'vapt', 'fixtures', 'effectiveness');
  const cases = [];
  let r = writeSynthetic(); // data changed after hashing
  edit(r, 'corpus2-judgments.json', (o) => { o.judges.J1['C2-01']['VAPT-API-02'] = 'yes'; });
  cases.push([r, /corpus2-judgments\.json: sha256 differs/, 'tampered data file']);
  r = writeSynthetic();
  edit(r, 'manifest.json', (o) => { o.catalog_digest = 'sha256:' + '0'.repeat(64); });
  cases.push([r, /stale|re-score/i, 'changed manifest digest']);
  r = writeSynthetic();
  writeFileSync(join(r, 'skills', 'vapt', 'controls.json'), readFileSync(join(r, 'skills', 'vapt', 'controls.json'), 'utf8') + '\n');
  cases.push([r, /stale|re-score/i, 'controls.json bytes changed']);
  r = writeSynthetic();
  edit(r, 'results.json', (o) => { o.R0.recalled += 1; });
  cases.push([r, /results\.json/, 'stale results.json']);
  r = writeSynthetic();
  { const p = join(effOf(r), 'REPORT.md'); writeFileSync(p, readFileSync(p, 'utf8').replace('<!-- RESULTS:END -->', 'extra line\n<!-- RESULTS:END -->')); }
  cases.push([r, /REPORT\.md.*block|block.*REPORT\.md/i, 'report block differs']);
  r = writeSynthetic();
  { const p = join(effOf(r), 'REPORT.md'); writeFileSync(p, readFileSync(p, 'utf8') + '\nIt rose by 50% overall.\n'); }
  cases.push([r, /%/, 'percent sign']);
  r = writeSynthetic();
  edit(r, 'corpus2-facts.json', (o) => { o.cases['C2-01'].note = 'free text'; }); finalize(r);
  cases.push([r, /unexpected key 'note'/, 'extra free-text key']);
  r = writeSynthetic();
  edit(r, 'corpus2-judgments.json', (o) => { o.selected = ['VAPT-API-01']; }); finalize(r);
  cases.push([r, /selected/, 'selection key']);
  for (const [root, re, what] of cases) {
    const p = problemsOf(root);
    assert.ok(p.length > 0 && p.some((x) => re.test(x)), `${what}: expected a problem matching ${re}, got ${JSON.stringify(p)}`);
    rmSync(root, { recursive: true });
  }
});

test('checkRealData: a prereg whose skip_log has no parsable rules is reported, not silently unchecked', () => {
  const root = writeSynthetic();
  const p = join(root, 'skills', 'vapt', 'fixtures', 'effectiveness', 'prereg.json');
  const o = JSON.parse(readFileSync(p, 'utf8'));
  o.corpus2_rule.skip_log = 'Every advisory examined and not kept is logged with the first rule that excluded it.';
  writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
  const probs = problemsOf(root);
  assert.ok(probs.some((x) => /corpus2_rule\.skip_log/.test(x) && /prereg\.json/.test(x)), `got ${JSON.stringify(probs)}`);
  rmSync(root, { recursive: true });
});

test('checkRealData: the real data folder is complete, sealed, scored and reported (fails until the orchestrator adds the data files)', () => {
  assert.deepEqual(E.checkRealData(effDir, repoRoot), []);
});

// ------------------------------------------------------- corpus 2 rule
const adv = (o = {}) => ({
  ghsa_id: 'GHSA-aaaa-bbbb-cccc', withdrawn_at: null, published_at: '2026-09-01T10:00:00Z',
  references: ['https://example.com/x', 'https://github.com/own/rep/commit/' + 'a'.repeat(40), 'https://github.com/own/other/commit/' + 'b'.repeat(40)],
  cwes: [{ cwe_id: 'CWE-79' }], vulnerabilities: [{ package: { ecosystem: 'npm', name: 'pkg' } }], ...o,
});
const commit = (files, parents = 1) => ({ sha: 'a'.repeat(40), parents: Array.from({ length: parents }, (_, i) => ({ sha: String(i).repeat(40) })), files: files.map((f) => (typeof f === 'string' ? { filename: f, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' } : f)) });
const small = () => 100;

test('isSourceFile: extension list, excluded directories, and excluded basename patterns', () => {
  for (const p of ['a.js', 'src/a.mjs', 'x/y.cjs', 'a.ts', 'a.tsx', 'a.jsx', 'pkg/mod.py']) assert.equal(B.isSourceFile(p), true, p);
  for (const p of ['README.md', 'a.json', 'a.d.ts', 'a.min.js', 'a.test.js', 'a.spec.ts', 'test_a.py', 'a_test.py', 'conftest.py', 'src/test/a.js', 'tests/a.py', '__tests__/a.js', 'spec/a.js', 'specs/a.js', 'e2e/a.js', 'testing/a.js', 'fixtures/a.js', 'doc/a.js', 'docs/a.js', 'example/a.js', 'examples/a.js', 'sample/a.js', 'samples/a.js', 'vendor/a.js', 'node_modules/p/a.js', 'dist/a.js', 'build/a.js', 'src/dist/a.js']) assert.equal(B.isSourceFile(p), false, p);
  assert.equal(B.isSourceFile('src/latest/a.js'), true); // a directory merely containing 'test' is fine
});

test('firstCommitRef: the first matching reference in list order is the fix commit; non-commit links are ignored', () => {
  assert.deepEqual(B.firstCommitRef(adv()), { owner: 'own', repo: 'rep', sha: 'a'.repeat(40) });
  assert.equal(B.firstCommitRef(adv({ references: ['https://github.com/o/r/pull/3', 'https://github.com/o/r/commits'] })), null);
  assert.equal(B.firstCommitRef(adv({ references: [] })), null);
});

test('npmOrPip: the first npm or pip vulnerability supplies ecosystem and package; others give null', () => {
  const a = adv({ vulnerabilities: [{ package: { ecosystem: 'go', name: 'g' } }, { package: { ecosystem: 'pip', name: 'pp' } }, { package: { ecosystem: 'npm', name: 'nn' } }] });
  assert.deepEqual(B.npmOrPip(a), { ecosystem: 'pip', package: 'pp' });
  assert.equal(B.npmOrPip(adv({ vulnerabilities: [{ package: { ecosystem: 'rubygems', name: 'x' } }] })), null);
});

test('decide: a clean advisory is kept with the committed fields and only the modified source files', () => {
  const c = commit(['src/a.js', 'README.md', { filename: 'src/new.js', status: 'added' }, 'tests/a.test.js', 'lib/b.py']);
  const d = B.decide(adv(), c, [], small);
  assert.equal(d.keep, true);
  assert.deepEqual(d.case, { ghsa_id: 'GHSA-aaaa-bbbb-cccc', cwes: ['CWE-79'], ecosystem: 'npm', package: 'pkg', repo: 'own/rep', fix_sha: 'a'.repeat(40), parent_sha: '0'.repeat(40), files: ['lib/b.py', 'src/a.js'], published_at: '2026-09-01T10:00:00Z' });
});

test('decide: each skip rule fires with its own name, in the preregistered order', () => {
  const ok = commit(['a.js']);
  assert.equal(B.decide(adv({ withdrawn_at: '2026-09-02T00:00:00Z' }), ok, [], small).rule, 'withdrawn');
  assert.equal(B.decide(adv({ references: ['https://x.y/z'] }), null, [], small).rule, 'no_fix_commit');
  assert.equal(B.decide(adv(), null, [], small).rule, 'commit_unavailable');
  assert.equal(B.decide(adv(), commit(['a.js'], 2), [], small).rule, 'merge_commit');
  assert.equal(B.decide(adv(), commit(['a.js'], 0), [], small).rule, 'merge_commit');
  assert.equal(B.decide(adv(), commit(['README.md', { filename: 'a.js', status: 'added' }]), [], small).rule, 'no_source_files');
  assert.equal(B.decide(adv(), commit(['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js']), [], small).rule, 'too_many_files');
  assert.equal(B.decide(adv(), commit(['a.js', 'b.js', 'c.js', 'd.js', 'e.js']), [], small).keep, true);
  assert.equal(B.decide(adv(), commit(['a.js', 'b.js']), [], () => 100001).rule, 'too_large');
  assert.equal(B.decide(adv(), commit(['a.js', 'b.js']), [], () => 100000).keep, true);
  const kept = (cwe, repo) => ({ cwes: cwe ? [cwe] : [], repo });
  assert.equal(B.decide(adv(), ok, [kept('CWE-79', 'x/y'), kept('CWE-79', 'x/z')], small).rule, 'cwe_cap');
  assert.equal(B.decide(adv(), ok, [kept('CWE-79', 'x/y')], small).keep, true);
  assert.equal(B.decide(adv(), ok, [kept('CWE-1', 'own/rep'), kept('CWE-2', 'own/rep')], small).rule, 'repo_cap');
  // cwe_cap is checked before repo_cap
  assert.equal(B.decide(adv(), ok, [kept('CWE-79', 'own/rep'), kept('CWE-79', 'own/rep')], small).rule, 'cwe_cap');
});

test('decide: an advisory listing no CWE is capped as the group "none"', () => {
  const a = adv({ cwes: [] });
  const k = [{ cwes: [], repo: 'a/b' }, { cwes: [], repo: 'c/d' }];
  assert.equal(B.decide(a, commit(['a.js']), k, small).rule, 'cwe_cap');
});

test('decide: the size check is skipped when an earlier rule already excluded the advisory', () => {
  let called = 0;
  B.decide(adv(), commit(['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js']), [], () => { called++; return 1; });
  assert.equal(called, 0);
});

test('orderedAdvisories: published desc then ghsa asc across page boundaries, window applied, pages fetched lazily', () => {
  const pages = {
    p1: { items: [adv({ ghsa_id: 'GHSA-3', published_at: '2026-09-03T00:00:00Z' }), adv({ ghsa_id: 'GHSA-9', published_at: '2026-09-02T00:00:00Z' })], next: 'p2' },
    p2: { items: [adv({ ghsa_id: 'GHSA-1', published_at: '2026-09-02T00:00:00Z' }), adv({ ghsa_id: 'GHSA-5', published_at: '2026-08-01T00:00:00Z' })], next: 'p3' },
    p3: { items: [adv({ ghsa_id: 'GHSA-7', published_at: '2026-07-31T23:59:59Z' })], next: null },
    future: null,
  };
  const asked = [];
  const fetchPage = (cur) => { asked.push(cur ?? 'p1'); return pages[cur ?? 'p1']; };
  const out = [...B.orderedAdvisories(fetchPage, { from: '2026-08-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })].map((a) => a.ghsa_id);
  assert.deepEqual(out, ['GHSA-3', 'GHSA-1', 'GHSA-9', 'GHSA-5']);
  // laziness: taking one item must not fetch the third page
  asked.length = 0;
  const it = B.orderedAdvisories(fetchPage, { from: '2026-08-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });
  it.next();
  assert.ok(asked.length <= 2, `fetched ${asked.join(',')}`);
});

test('orderedAdvisories: an advisory published after the freeze time is dropped', () => {
  const fetchPage = () => ({ items: [adv({ ghsa_id: 'GHSA-A', published_at: '2026-11-02T00:00:00Z' }), adv({ ghsa_id: 'GHSA-B', published_at: '2026-10-31T00:00:00Z' })], next: null });
  assert.deepEqual([...B.orderedAdvisories(fetchPage, { from: '2026-08-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })].map((a) => a.ghsa_id), ['GHSA-B']);
});

test('pickFrom: stops at the limit without consuming more advisories, logs each skip with its first rule, numbers kept cases', () => {
  let pulled = 0;
  function* src() {
    const list = [
      adv({ ghsa_id: 'GHSA-1', withdrawn_at: 'x' }),
      adv({ ghsa_id: 'GHSA-2', vulnerabilities: [{ package: { ecosystem: 'go', name: 'g' } }] }), // not npm/pip: not examined
      adv({ ghsa_id: 'GHSA-3', references: [] }),
      adv({ ghsa_id: 'GHSA-4', references: ['https://github.com/a/r4/commit/' + 'c'.repeat(40)], cwes: [{ cwe_id: 'CWE-1' }] }),
      adv({ ghsa_id: 'GHSA-5', references: ['https://github.com/a/r5/commit/' + 'c'.repeat(40)], cwes: [{ cwe_id: 'CWE-2' }] }),
      adv({ ghsa_id: 'GHSA-6', references: ['https://github.com/a/r6/commit/' + 'c'.repeat(40)], cwes: [{ cwe_id: 'CWE-3' }] }),
    ];
    for (const a of list) { pulled++; yield a; }
  }
  const getCommit = () => commit(['a.js']);
  const r = B.pickFrom(src(), { getCommit, getSize: small, limit: 2 });
  assert.deepEqual(r.cases.map((c) => [c.id, c.ghsa_id]), [['C2-01', 'GHSA-4'], ['C2-02', 'GHSA-5']]);
  assert.deepEqual(r.skipped, [{ ghsa_id: 'GHSA-1', rule: 'withdrawn' }, { ghsa_id: 'GHSA-3', rule: 'no_fix_commit' }]);
  assert.equal(r.examined, 4);
  assert.equal(pulled, 5, 'the sixth advisory is never pulled once the limit is reached');
});

test('pickFrom: maxExamined stops the run and an unavailable commit is logged commit_unavailable', () => {
  const list = [1, 2, 3].map((n) => adv({ ghsa_id: `GHSA-${n}` }));
  const r = B.pickFrom(list, { getCommit: () => null, getSize: small, limit: 24, maxExamined: 2 });
  assert.equal(r.examined, 2);
  assert.deepEqual(r.skipped.map((s) => s.rule), ['commit_unavailable', 'commit_unavailable']);
});

test('patchFor: assembles a diff for the kept files only', () => {
  const c = commit(['a.js', 'b.js', 'README.md']);
  const p = B.patchFor(c, ['b.js']);
  assert.ok(p.includes('diff --git a/b.js b/b.js'));
  assert.ok(!p.includes('a.js') && !p.includes('README'));
  assert.ok(p.includes('+b'));
});

test('splitHttpResponse: splits headers from body on LF and CRLF, and throws a clear error without a separator', () => {
  assert.deepEqual(B.splitHttpResponse('HTTP/2 200\nlink: <x>; rel="next"\n\n[1,2]\n'), { head: 'HTTP/2 200\nlink: <x>; rel="next"', body: '[1,2]' });
  assert.deepEqual(B.splitHttpResponse('HTTP/2 200\r\nlink: a\r\n\r\n[3]'), { head: 'HTTP/2 200\r\nlink: a', body: '[3]' });
  assert.throws(() => B.splitHttpResponse('HTTP/2 200\nlink: a\n[3]'), /no header\/body separator/);
});

// ---------------------------------------------------------- prep-local
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
function tinyRepo() {
  const dir = tmp('prep');
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.txt'), 'l1\nl2\nl3\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'first commit', '-m', 'body of the first');
  const c1 = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src', 'a.txt'), 'l1\nl2x\nl3y\n');
  git(dir, 'commit', '-q', '-am', 'second change');
  const c2 = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src', 'a.txt'), 'later\n');
  git(dir, 'commit', '-q', '-am', 'third change, after the audited commit');
  return { dir, c1, c2 };
}
const FINDINGS = [
  { verdict: 'confirmed', title: 'Alpha weakness', description: 'd1', root_cause: 'r1', intended_behavior: 'i1', conditions: 'c1', trace: [{ file: 'src/a.txt', line: 2 }, { file: 'src/a.txt', line: 3 }], evidence: [{ file: 'src/a.txt', line: 1 }, { file: 'gone.txt', line: 4 }], execution: { attacker_perspective: 'ap1' }, remediation: { strategy: 's1' } },
  { verdict: 'rejected', title: 'Not real', trace: [], evidence: [] },
  { verdict: 'confirmed', title: 'Beta weakness', description: 'd2', root_cause: 'r2', intended_behavior: 'i2', conditions: 'c2', trace: [{ file: 'src/a.txt', line: 1 }], evidence: [], execution: { attacker_perspective: 'ap2' }, remediation: { strategy: 's2' } },
];
const REPORT = '| ID | Sev | Title | Where |\n|---|---|---|---|\n| F01 | high | Alpha weakness | x |\n| F02 | low | Beta weakness | y |\n| F03 | low | Not real | z |\n';

test('confirmedFindings: accepts an array or {findings} and keeps only verdict confirmed', () => {
  assert.equal(P.confirmedFindings(FINDINGS).length, 2);
  assert.equal(P.confirmedFindings({ findings: FINDINGS }).length, 2);
});

test('mapFindingIds: exact title match in a table row gives the id; a missing title or two findings on one id throws', () => {
  const c = P.confirmedFindings(FINDINGS);
  assert.deepEqual(P.mapFindingIds(c, REPORT).map((m) => m.id), ['F01', 'F02']);
  assert.throws(() => P.mapFindingIds(c, REPORT.replace('Alpha weakness', 'Alpha weakness!')), /Alpha weakness/);
  assert.throws(() => P.mapFindingIds([c[0], { ...c[0] }], REPORT), /F01|more than one|same/i);
  assert.throws(() => P.mapFindingIds(c, REPORT + '| F09 | low | Beta weakness | dup |\n'), /Beta weakness/);
});

test('blameCommits: unique commits that last wrote the cited lines, most cited lines first', () => {
  const { dir, c1, c2 } = tinyRepo();
  const r = P.blameCommits(dir, c2, [{ file: 'src/a.txt', line: 1 }, { file: 'src/a.txt', line: 2 }, { file: 'src/a.txt', line: 3 }]);
  assert.deepEqual(r.commits, [{ hash: c2, count: 2 }, { hash: c1, count: 1 }]);
  assert.deepEqual(r.missing, []);
  const m = P.blameCommits(dir, c2, [{ file: 'gone.txt', line: 4 }]);
  assert.deepEqual(m.commits, []);
  assert.deepEqual(m.missing, ['gone.txt']);
  rmSync(dir, { recursive: true });
});

test('build: writes ticket (messages without hashes), code at the audited commit, judge record, and a reproducible bundle hash', () => {
  const { dir, c2 } = tinyRepo();
  const o1 = tmp('out1'); const o2 = tmp('out2');
  P.build({ findings: FINDINGS, report: REPORT, repo: dir, sha: c2, out: o1 });
  P.build({ findings: FINDINGS, report: REPORT, repo: dir, sha: c2, out: o2 });
  const ticket = readFileSync(join(o1, 'F01', 'writer', 'ticket.txt'), 'utf8');
  assert.ok(ticket.includes('src/a.txt') && ticket.includes('gone.txt'));
  assert.ok(ticket.includes('second change') && ticket.includes('first commit') && ticket.includes('body of the first'));
  assert.ok(ticket.indexOf('second change') < ticket.indexOf('first commit'), 'most-cited commit first');
  assert.ok(!/[0-9a-f]{40}/.test(ticket) && !ticket.includes(c2.slice(0, 7)), 'no hashes');
  assert.ok(/gone\.txt.*(not present|does not exist)/i.test(ticket));
  assert.ok(!ticket.includes('third change'));
  assert.equal(readFileSync(join(o1, 'F01', 'writer', 'code', 'src', 'a.txt'), 'utf8'), 'l1\nl2x\nl3y\n', 'content at the audited commit, not the later one');
  assert.ok(!existsSync(join(o1, 'F01', 'writer', 'code', 'gone.txt')));
  const jf = JSON.parse(readFileSync(join(o1, 'F01', 'judge', 'finding.json'), 'utf8'));
  assert.deepEqual(Object.keys(jf), ['title', 'description', 'root_cause', 'intended_behavior', 'conditions', 'attacker_perspective', 'remediation_strategy']);
  assert.equal(jf.attacker_perspective, 'ap1'); assert.equal(jf.remediation_strategy, 's1');
  assert.ok(!existsSync(join(o1, 'F03')), 'unconfirmed findings are not written');
  // bundle hash: recompute independently
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(o1);
  const lines = files.map((p) => relative(o1, p).split('\\').join('/')).filter((r) => r !== 'bundle.sha256').sort().map((r) => `${r} ${sha(readFileSync(join(o1, r)))}`);
  const want = sha(lines.join('\n') + '\n');
  assert.equal(readFileSync(join(o1, 'bundle.sha256'), 'utf8').trim(), want);
  assert.equal(readFileSync(join(o2, 'bundle.sha256'), 'utf8'), readFileSync(join(o1, 'bundle.sha256'), 'utf8'));
  for (const d of [dir, o1, o2]) rmSync(d, { recursive: true });
});

test('build: a cited directory is treated as missing, noted in the ticket and not written under code/', () => {
  const { dir, c2 } = tinyRepo();
  const o = tmp('outdir');
  const f = [{ ...FINDINGS[0], trace: [{ file: 'src/a.txt', line: 2 }], evidence: [{ file: 'src', line: 1 }] }, FINDINGS[1], FINDINGS[2]];
  const r = P.blameCommits(dir, c2, [{ file: 'src', line: 1 }]);
  assert.deepEqual(r.missing, ['src']);
  P.build({ findings: f, report: REPORT, repo: dir, sha: c2, out: o });
  const ticket = readFileSync(join(o, 'F01', 'writer', 'ticket.txt'), 'utf8');
  assert.ok(/src\b.*(not present|does not exist)/i.test(ticket), 'directory noted as missing in the ticket');
  assert.ok(statSync(join(o, 'F01', 'writer', 'code', 'src', 'a.txt')).isFile());
  assert.deepEqual(readdirSync(join(o, 'F01', 'writer', 'code', 'src')), ['a.txt'], 'the directory itself is not written as a file');
  for (const d of [dir, o]) rmSync(d, { recursive: true });
});

test('build: a confirmed finding whose title is not in the report stops the run before writing anything', () => {
  const { dir, c2 } = tinyRepo();
  const o = tmp('out3');
  assert.throws(() => P.build({ findings: FINDINGS, report: REPORT.replace('Beta weakness', 'Other'), repo: dir, sha: c2, out: join(o, 'x') }), /Beta weakness/);
  assert.ok(!existsSync(join(o, 'x')));
  for (const d of [dir, o]) rmSync(d, { recursive: true });
});
