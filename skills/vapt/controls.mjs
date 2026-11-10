// The catalog evaluator, shared by controls.test.mjs, fixtures/selector.mjs and the ship-ticket security planner.
// One definition: fixtures.test.mjs guards fixtures/selector.mjs and controls.test.mjs against declaring local copies of
// unknownish, assertFacts, holds, via, why or selected. The ship-ticket planner (security-plan.mjs) imports this module at run time.
import { createHash } from 'node:crypto';

// ---- evaluator: unknown (absent, null, "unknown") matches every leaf ----
export const unknownish = (v) => v === undefined || v === null || v === 'unknown';
// Out-of-vocabulary input is an error, never a silent non-match (which would drop a control).
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

// Digest of the catalog's raw bytes, in the form recorded by seals and plans.
export const catalogDigest = (rawBytes) => 'sha256:' + createHash('sha256').update(rawBytes).digest('hex');

// Vocabulary of diff signals a planner may report when the change exceeds the approved plan.
export const DIFF_SIGNALS = ['out-of-plan-path', 'new-route', 'new-dependency', 'auth-or-middleware-change', 'migration-or-rls-change',
  'env-or-secret-reference', 'infra-or-ci-config', 'mail-or-notification-send', 'payment-or-stock-or-wallet-call', 'none'];
