// Fixture-only scoring over the catalog evaluator. The evaluator itself lives in ../controls.mjs, the one
// definition shared with controls.test.mjs and the ship-ticket planner; it is re-exported here so
// fixtures.test.mjs and make-ledger.mjs keep one import. Never paste a local copy of those functions here:
// fixtures.test.mjs fails if one appears. No other imports: the catalog is passed in.
import { selected, via } from '../controls.mjs';

export { unknownish, assertFacts, holds, via, why, selected } from '../controls.mjs';

// Inapplicable labels the catalog selects anyway: [{scenario, control, via}], sorted by scenario then control.
export function computeLedger(catalog, scenarios, labels) {
  const out = [];
  for (const s of scenarios) {
    const l = labels.find((x) => x.scenario_id === s.id);
    if (!l) continue;
    const sel = selected(catalog, s.facts);
    for (const c of l.inapplicable ?? []) if (sel.includes(c)) {
      const control = catalog.controls.find((x) => x.id === c);
      out.push({ scenario: s.id, control: c, via: via(control.applies_when, s.facts) });
    }
  }
  return out.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.control.localeCompare(b.control));
}

const byId = (catalog, id) => catalog.controls.find((x) => x.id === id);
const labelFor = (labels, id) => labels.find((x) => x.scenario_id === id);
const order = (a, b) => a.scenario.localeCompare(b.scenario) || (a.control ?? '').localeCompare(b.control ?? '');

// Required ABUSE labels reachable only through a broad gate: every primary fact of the control is known false
// (not true, not unknown) in the scenario, so only a business-invariant or auth-lifecycle leaf selects it.
export function computeBroadOnly(catalog, scenarios, labels) {
  const out = [];
  for (const s of scenarios) {
    const l = labelFor(labels, s.id);
    if (!l) continue;
    const sel = selected(catalog, s.facts);
    for (const c of l.must_select ?? []) {
      const ctl = byId(catalog, c);
      if (!c.startsWith('VAPT-ABUSE-') || !ctl?.primary_facts?.length || !sel.includes(c)) continue;
      if (ctl.primary_facts.every((f) => s.facts[f] === false)) out.push({ scenario: s.id, control: c, via: via(ctl.applies_when, s.facts) });
    }
  }
  return out.sort(order);
}

// Scope-exceeds-plan reassessment: delta = selected(actual facts) minus selected(planned facts).
export function computeReassess(catalog, scenarios, labels) {
  const out = [];
  for (const s of scenarios) {
    if (s.category !== 'scope-exceeds-plan' || !s.planned_facts) continue;
    const actual = selected(catalog, s.facts);
    const planned = selected(catalog, s.planned_facts);
    const added = labelFor(labels, s.id)?.added_controls ?? [];
    const delta = actual.filter((c) => !planned.includes(c)).sort();
    out.push({
      scenario: s.id,
      delta,
      added_in_delta: added.filter((c) => delta.includes(c)).sort(),
      already_planned: added.filter((c) => planned.includes(c)).sort(),
    });
  }
  return out.sort(order);
}

// Controls selected for every single boundary kind in a known-negative world (all bool facts false).
export function boundaryUniversal(catalog) {
  const V = catalog.fact_vocabulary;
  const neg = Object.fromEntries(Object.entries(V).filter(([, d]) => d.type === 'bool').map(([k]) => [k, false]));
  let ids = null;
  for (const b of V.boundaries.values) {
    const s = selected(catalog, { ...neg, principals: ['service'], boundaries: [b] });
    ids = ids ? ids.filter((x) => s.includes(x)) : s;
  }
  return ids;
}

// Pre-registered baselines: recall of must_select and inapplicable violations for three reference selectors.
// Score one selector (scenario -> control ids) against the labels. A hard defect is a violation PAIR
// (scenario, control) that is not in the ledger's pair set.
export function scoreSelector(scenarios, labels, ledgerEntries, fn) {
  const ledgered = new Set(ledgerEntries.map((x) => `${x.scenario}|${x.control}`));
  let recalled = 0; const violations = new Set();
  for (const s of scenarios) {
    const l = labelFor(labels, s.id);
    if (!l) continue;
    const sel = fn(s);
    recalled += (l.must_select ?? []).filter((c) => sel.includes(c)).length;
    for (const c of l.inapplicable ?? []) if (sel.includes(c)) violations.add(`${s.id}|${c}`);
  }
  const hard = [...violations].filter((k) => !ledgered.has(k));
  return { recalled, inapplicable_violations: violations.size, net_hard_defects: hard.length };
}

// Pre-registered baselines: recall of must_select and inapplicable violations for three reference selectors.
export function computeBaselines(catalog, scenarios, labels, ledgerEntries) {
  const all = catalog.controls.map((c) => c.id);
  const universal = boundaryUniversal(catalog);
  const anyBoundary = (s) => Array.isArray(s.facts.boundaries) && s.facts.boundaries.length > 0;
  const selectors = {
    catalog_faithful: (s) => selected(catalog, s.facts),
    all_controls_when_any_boundary: (s) => (anyBoundary(s) ? all : []),
    boundary_universal_when_any_boundary: (s) => (anyBoundary(s) ? universal : []),
  };
  const must_select_total = labels.reduce((n, l) => n + (l.must_select ?? []).length, 0);
  const result = { must_select_total, ledger_size: ledgerEntries.length, boundary_universal_controls: universal.length, baselines: {} };
  for (const [name, fn] of Object.entries(selectors)) {
    const r = scoreSelector(scenarios, labels, ledgerEntries, fn);
    result.baselines[name] = { recall: `${r.recalled}/${must_select_total}`, ...r };
  }
  return result;
}

// A per-control ledger reason naming the control's title and the gate the catalog selects it on.
export function gateSummary(node) {
  const leaf = (n) => (n.fact === 'boundaries' ? `boundary ${n.value}` : `${n.fact}`);
  const kids = node.any ?? [node];
  const bounds = kids.filter((n) => n.fact === 'boundaries').map((n) => n.value);
  const rest = kids.filter((n) => n.fact !== 'boundaries')
    .map((n) => (n.all || n.any ? `a compound condition` : leaf(n)));
  const parts = [];
  if (bounds.length) parts.push(bounds.length >= 7 ? `any of ${bounds.length} boundary kinds` : `boundary ${bounds.join(' or ')}`);
  if (rest.length) parts.push(rest.join(' or '));
  return parts.join(' or ');
}
export function ledgerReason(catalog, id) {
  const c = byId(catalog, id);
  return `${id} "${c.title}" is selected by the catalog on ${gateSummary(c.applies_when)}; `
    + 'the labeler judged it intrinsically inapplicable to the listed scenarios, so each entry is catalog over-breadth.';
}
