// The catalog evaluator, copied ONCE for the fixtures (used by fixtures.test.mjs and make-ledger.mjs).
// unknownish, assertFacts and holds are verbatim copies of the same declarations in ../controls.test.mjs;
// the drift guard in fixtures.test.mjs fails if they differ (whitespace-normalised). On drift: re-sync them
// from controls.test.mjs, regenerate the ledger (node skills/vapt/fixtures/make-ledger.mjs), and re-seal.
// No imports: the catalog is passed in.

// ---- begin verbatim copy of controls.test.mjs ----
export const unknownish = (v) => v === undefined || v === null || v === 'unknown';
export function assertFacts(facts, vocab) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new TypeError('out-of-vocabulary facts: not an object');
  for (const [name, v] of Object.entries(facts)) {
    const def = vocab[name];
    if (!def) throw new TypeError(`out-of-vocabulary fact name '${name}'`);
    if (unknownish(v)) continue;
    if (def.type === 'bool') {
      if (v !== true && v !== false) throw new TypeError(`out-of-vocabulary value ${JSON.stringify(v)} for bool fact '${name}'`);
    } else {
      if (!Array.isArray(v)) throw new TypeError(`out-of-vocabulary value ${JSON.stringify(v)} for enum fact '${name}' (must be an array)`);
      for (const x of v) if (x !== 'unknown' && !def.values.includes(x)) throw new TypeError(`out-of-vocabulary value ${JSON.stringify(x)} in enum fact '${name}'`);
    }
  }
  return facts;
}
export function holds(node, facts, vocab) {
  if (vocab) assertFacts(facts, vocab);
  if (!node || typeof node !== 'object') return false;
  if (node.all) return node.all.every((n) => holds(n, facts));
  if (node.any) return node.any.some((n) => holds(n, facts));
  const v = facts[node.fact];
  if (unknownish(v)) return true;
  if (node.op === 'includes') return Array.isArray(v) ? v.includes('unknown') || v.includes(node.value) : v === node.value;
  return v === node.value;
}
// ---- end verbatim copy ----

// Ids of the catalog controls whose applies_when holds for these facts (facts.boundaries carries the boundaries).
// Out-of-vocabulary facts throw instead of silently matching or dropping a control.
export function selected(catalog, facts) {
  assertFacts(facts, catalog.fact_vocabulary);
  return catalog.controls.filter((c) => holds(c.applies_when, facts)).map((c) => c.id);
}

// Why a HOLDING node holds: a leaf reads 'boundary X', 'fact X' or 'unknown X'; `any` reports its first
// holding child; `all` joins its children with ' & '. Deterministic, so the ledger can be compared exactly.
export function via(node, facts) {
  if (node.all) return node.all.map((n) => via(n, facts)).join(' & ');
  if (node.any) { const n = node.any.find((x) => holds(x, facts)); return n ? via(n, facts) : ''; }
  const v = facts[node.fact];
  if (unknownish(v) || (Array.isArray(v) && !v.includes(node.value) && v.includes('unknown'))) return `unknown ${node.fact}`;
  if (node.fact === 'boundaries') return `boundary ${node.value}`;
  return node.op === 'includes' ? `fact ${node.fact} includes ${node.value}` : `fact ${node.fact}`;
}

// Why a FAILING node fails: a leaf names the fact, its value and what it needs; `any` lists every failing
// child; `all` names its first failing child.
export function why(node, facts) {
  if (node.all) { const n = node.all.find((x) => !holds(x, facts)); return n ? why(n, facts) : ''; }
  if (node.any) return `none of: ${node.any.map((n) => why(n, facts)).join('; ')}`;
  return `${node.fact} is ${JSON.stringify(facts[node.fact])}, needs ${node.op} ${JSON.stringify(node.value)}`;
}

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
