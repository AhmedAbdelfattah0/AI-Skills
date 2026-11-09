// Regenerates fixtures/disagreements.json from controls.json, scenarios.json and labels.json:
//   entries / by_control       inapplicable labels the catalog selects anyway (catalog over-breadth)
//   broad_gate_only_required   required ABUSE labels reachable only through a broad gate
//   reassess                   scope-exceeds-plan deltas: selected(actual) minus selected(planned)
// A hand-edited by_control reason is preserved only if it still names the control's title.
// Prints the pre-registered baselines for manifest.preregistered_baselines (the test recomputes them).
// Run: node skills/vapt/fixtures/make-ledger.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLedger, computeBroadOnly, computeReassess, computeBaselines, ledgerReason } from './selector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const json = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const out = join(here, 'disagreements.json');

const catalog = json('../controls.json');
const scenarios = json('scenarios.json');
let labels = json('labels.json');
if (!Array.isArray(labels)) labels = Object.entries(labels).map(([scenario_id, l]) => ({ scenario_id, ...l }));

const entries = computeLedger(catalog, scenarios, labels);
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).by_control ?? {} : {};
const by_control = {};
for (const c of [...new Set(entries.map((x) => x.control))].sort()) {
  const title = catalog.controls.find((x) => x.id === c).title;
  by_control[c] = typeof previous[c] === 'string' && previous[c].includes(title) ? previous[c] : ledgerReason(catalog, c);
}
const ledger = {
  note: 'Computed by make-ledger.mjs; do not edit entries by hand. entries are expected catalog over-breadth cost, not '
    + 'selector errors. broad_gate_only_required are required labels reachable only through a broad gate: if those gates '
    + 'narrow, they are the first catalog-misses to review and must not be dropped silently. reassess holds the '
    + 'scope-exceeds-plan deltas; only added_in_delta is scored.',
  total: entries.length,
  by_control,
  entries,
  broad_gate_only_required: computeBroadOnly(catalog, scenarios, labels),
  reassess: computeReassess(catalog, scenarios, labels),
};
writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`wrote ${entries.length} entries over ${Object.keys(by_control).length} controls, `
  + `${ledger.broad_gate_only_required.length} broad-gate-only required, ${ledger.reassess.length} reassess rows to ${out}`);
console.log(JSON.stringify({ preregistered_baselines: computeBaselines(catalog, scenarios, labels, entries) }, null, 2));
