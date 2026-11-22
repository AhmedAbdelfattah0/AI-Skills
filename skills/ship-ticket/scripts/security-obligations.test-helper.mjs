// Fixtures for the F12a security-obligation tests (block format 3: surface-level facts, dropped pairs, the obligation
// matrix). A small synthetic catalog WITH not_applicable gates (the security-plan.test.mjs catalog has none), and a
// generic generator of a large selection over the REAL catalog: many surfaces of many kinds, every bool fact true for
// the change, each surface lowering every fact its kind's catalog gates name, plus one keeper surface that lowers
// nothing (so no fact is lowered on every surface). No ticket names, no hardcoded counts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SP from './security-plan.mjs';

const leaf = (fact, value, op = 'is') => ({ fact, op, value });
const B = (v) => leaf('boundaries', v, 'includes');
const ctl = (id, tier, applies_when, not_applicable) => ({ id, family: id.split('-')[1], title: id, tier, applies_when, not_applicable,
  verify: { type: 'runtime', pattern: 'p' }, env: 'request-harness' });
const R = 'cannot exhibit the attack on this kind of surface for the stated reason';
/** Gated synthetic catalog: API-01..03 kind-universal on rh/rs (so new-route is mechanical); API-04 gated by persistent_write; CFG-04 by session_context; ABUSE-02 by outbound_message; WEB-01 rendering only. */
export const GATED = {
  catalog_version: 1,
  fact_vocabulary: {
    boundaries: { type: 'enum', values: ['request-handler', 'rendering-sink', 'outbound-data'] },
    principals: { type: 'enum', values: ['anonymous', 'authenticated', 'staff', 'service'] },
    persistent_write: { type: 'bool', values: [true, false] },
    session_context: { type: 'bool', values: [true, false] },
    outbound_message: { type: 'bool', values: [true, false] },
  },
  controls: [
    ctl('VAPT-API-01', '[NN]', { any: [B('request-handler'), B('rendering-sink')] }, { 'outbound-data': `outbound-data ${R}` }),
    ctl('VAPT-API-02', '[NN]', { any: [B('request-handler'), B('rendering-sink')] }, { 'outbound-data': `outbound-data ${R}` }),
    ctl('VAPT-API-03', '[NN]', { any: [B('request-handler'), B('rendering-sink')] }, { 'outbound-data': `outbound-data ${R}` }),
    ctl('VAPT-API-04', '[NN]', { all: [{ any: [B('request-handler'), B('rendering-sink')] }, leaf('persistent_write', true)] },
      { 'request-handler': `gated by persistent_write: request-handler ${R}`, 'rendering-sink': `gated by persistent_write: rendering-sink ${R}`, 'outbound-data': `outbound-data ${R}` }),
    ctl('VAPT-CFG-04', '[NN]', { all: [{ any: [B('request-handler'), B('rendering-sink')] }, leaf('session_context', true)] },
      { 'request-handler': `gated by session_context: request-handler ${R}`, 'rendering-sink': `gated by session_context: rendering-sink ${R}`, 'outbound-data': `outbound-data ${R}` }),
    ctl('VAPT-ABUSE-02', '[D]', { any: [leaf('outbound_message', true), B('outbound-data')] },
      { 'request-handler': `gated by outbound_message: request-handler ${R}`, 'rendering-sink': `gated by outbound_message: rendering-sink ${R}` }),
    ctl('VAPT-WEB-01', '[NN]', { any: [B('rendering-sink')] }, { 'request-handler': `request-handler ${R}`, 'outbound-data': `outbound-data ${R}` }),
  ],
};
export const writeCatalog = (obj) => { const p = join(mkdtempSync(join(tmpdir(), 'secobl-')), 'controls.json'); writeFileSync(p, JSON.stringify(obj, null, 2)); return p; };
export const GATED_PATH = writeCatalog(GATED);
export const gated = () => SP.loadCatalog({ catalogPath: GATED_PATH });
export const TRUE3 = { persistent_write: true, session_context: true, outbound_message: true };
export const cite3 = (facts) => Object.fromEntries(Object.keys(TRUE3).map((k) => [k, facts[k] === 'unknown' ? 'unknown: not determined' : 'src/x.ts:handler']));
/** A surface, optionally lowering `low` facts with path-shaped citations. */
export const surf = (boundary_id, kind, path = `src/${boundary_id}.ts`, low = null, cite = (f) => `${path}:${f}Free`) => ({ boundary_id, kind, path, principals: ['authenticated'],
  ...(low ? { facts: Object.fromEntries(low.map((f) => [f, false])), evidence: Object.fromEntries(low.map((f) => [f, cite(f)])) } : {}) });
export const sel3 = (catalog, surfaces, facts = TRUE3) => SP.selectControls(catalog, { security_policy: 2, surfaces, facts, evidence: cite3(facts) });
export const planOf = (sel, extra = '') => `# Plan\n\n## 3a\n\n${SP.renderSection3a(sel)}\n${extra}\n<!-- RUN-STATE:BEGIN -->\n{"event":"START"}\n<!-- RUN-STATE:END -->\n`;

/** The standard format-3 approval on the gated catalog: A (request-handler, lowers persistent_write) and keeper K. */
export const approved3 = (catalog) => {
  const s = sel3(catalog, [surf('A', 'request-handler', 'src/a.ts', ['persistent_write']), surf('K', 'request-handler', 'src/k.ts')]);
  if (!s.ok) throw new Error(JSON.stringify(s));
  return s;
};
/** A reassess input over approved3: `changed` files, Design Contract src/**, optional classifications/inventory/addenda. */
export const reIn3 = (catalog, { files = [], classifications = [], inventory = [], addenda = [], plan, contract = ['src/**'] } = {}) => ({ plan: plan ?? planOf(approved3(catalog)), catalog,
  inventory: { surfaces: inventory }, changed: { contract_paths: contract, files }, classifications, addenda });

/** The bool facts a catalog gate names for `kind` (read from the catalog grammar, as the planner does). */
export function gatedFacts(catalog, kind) {
  return [...new Set(catalog.controls.flatMap((c) => {
    const m = typeof c.not_applicable?.[kind] === 'string' && SP.GATED_CLAUSE.exec(c.not_applicable[kind]);
    return m ? m[1].split(' or ') : [];
  }))].sort();
}

/**
 * A large selection over the REAL catalog shaped like a big security-sensitive change: `kinds` surfaces (one per
 * boundary kind, all bool facts true for the change), each lowering every fact its kind's gates name, cited at its
 * own path, plus one keeper surface of `keeperKind` that lowers nothing. Returns the select input.
 */
export function largeShape(catalog, { kinds = catalog.fact_vocabulary.boundaries.values.slice(0, 8), keeperKind = 'business-invariant' } = {}) {
  const bools = Object.keys(catalog.fact_vocabulary).filter((k) => catalog.fact_vocabulary[k].type === 'bool');
  const surfaces = kinds.map((k, i) => {
    const g = gatedFacts(catalog, k);
    const path = `pkg/mod${i}/${k}.ts`;
    return { boundary_id: `s${i}-${k}`, kind: k, path, principals: ['staff'],
      ...(g.length ? { facts: Object.fromEntries(g.map((f) => [f, false])), evidence: Object.fromEntries(g.map((f) => [f, `${path}:${f}`])) } : {}) };
  });
  surfaces.push({ boundary_id: 'keeper', kind: keeperKind, path: 'pkg/keeper/rules.ts', principals: ['service'] });
  return { security_policy: 2, surfaces, facts: Object.fromEntries(bools.map((b) => [b, true])), evidence: Object.fromEntries(bools.map((b) => [b, 'pkg/keeper/rules.ts:apply'])) };
}
