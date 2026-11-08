/**
 * Pure helpers of the durable run engine (run-engine.mjs): the `ship-ticket-engine-dag-v1`
 * schema, the plan narrative digest, dependency closure and scope, gate input validation,
 * RED spec pinning, sequenced engine events and judgments. No I/O. Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { validateNodes, schedule, RISK_EVIDENCE } from './harness.mjs';
import { exactExclusions } from './gate.mjs';
import { BEGIN, END } from './run-state.mjs';
export { BEGIN, END, runStateEvents } from './run-state.mjs';
/** Digest in the skill's canonical `sha256:<hex>` form (the form real START events carry). */
export const sha = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');
/** Normalize the legacy `sha256-<hex>` spelling to the canonical `sha256:<hex>`. */
export const normDigest = (d) => (typeof d === 'string' ? d.replace(/^sha256-/, 'sha256:') : d);
/** Error carrying a machine-readable `code`. */
export const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
/** A judgment point for STATUS.judgments. */
export const judgment = (code, node, reason) => ({ code, ...(node ? { node } : {}), reason });
/** The timeout the carrier validates (1 s .. 1 h); the engine's timers use the same clamped value. */
export const clampTimeout = (ms) => Math.min(3600000, Math.max(1000, ms));
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RUNNER_FORMATS = ['tap', 'vitest-json', 'jest-json'];

/** Append a sequenced engine event to state (read by gate ordering and eval.mjs). */
export function note(S, type, extra = {}) {
  S.seq = (S.seq ?? 0) + 1;
  S.events.push({ seq: S.seq, type, ...extra });
}

/** sha256 of the plan with everything strictly between the RUN-STATE markers removed (markers kept). */
export function planNarrativeDigest(text) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  if (b < 0 || e < b) throw coded('plan_invalid', 'plan has no RUN-STATE block');
  return sha(text.slice(0, b + BEGIN.length) + text.slice(e));
}

export const DAG_SCHEMA = 'ship-ticket-engine-dag-v1';
const CONFIG_FIELDS = ['provider', 'modelMap', 'permissionMode', 'billing', 'width', 'memoryBudgetMb', 'timeoutMs', 'budget',
  'candidateExclusions', 'testCommands', 'base', 'riskLabels', 'acceptanceIds', 'unitRecheckCeiling', 'unitReview'];
const NODE_FIELDS = ['id', 'deps', 'reads', 'writes', 'othersOwned', 'resources', 'risk', 'complexity', 'modelTier',
  'estimatedMemoryMb', 'promptFile', 'phase', 'role', 'evidence', 'redSpecs', 'unit', 'acceptance', 'checks'];
const NODE_PHASES = ['BUILD', 'PROVE', 'REPAIR', 'SHIP'];
const PINNED_PLAN = /^\.specs\/plans\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;

/**
 * Validate a `ship-ticket-engine-dag-v1` document; unknown fields anywhere throw `dag_invalid`.
 * With `ticket`, `candidateExclusions` must be exactly the pinned pair for it (any order) or absent
 * (then defaulted to it); without, it must at least have the pinned shape.
 */
export function validateEngineDag(doc, { ticket } = {}) {
  const bad = (m) => { throw coded('dag_invalid', m); };
  const only = (o, allowed, where) => { const x = Object.keys(o).filter(k => !allowed.includes(k)); if (x.length) bad(`unknown ${where} field(s): ${x}`); };
  if (!isObj(doc) || doc.schema !== DAG_SCHEMA) bad(`schema must be ${DAG_SCHEMA}`);
  only(doc, ['schema', 'config', 'nodes'], 'top-level');
  const c = doc.config;
  if (!isObj(c)) bad('config must be an object');
  only(c, CONFIG_FIELDS, 'config');
  if (typeof c.provider !== 'string') bad('config.provider required');
  if (!['subscription', 'api', undefined].includes(c.billing)) bad('config.billing must be subscription or api');
  if (!Number.isInteger(c.width ?? 1) || (c.width ?? 1) < 1 || (c.width ?? 1) > 32) bad('config.width must be 1..32');
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1) bad('config.timeoutMs must be a positive integer');
  const ex = c.candidateExclusions;
  const pinned = ticket ? [`.specs/plans/${ticket}.md`, 'session-log.md'] : null;
  if (ex !== undefined && !(strings(ex) && (ticket ? exactExclusions(ex, ticket)
    : ex.length === 2 && new Set(ex).size === 2 && ex.includes('session-log.md') && ex.some(x => PINNED_PLAN.test(x)))))
    bad(`config.candidateExclusions must be exactly ['.specs/plans/${ticket ?? '<ticket>'}.md', 'session-log.md'] (no directories, no extras)`);
  if (!Array.isArray(c.riskLabels ?? []) || !(c.riskLabels ?? []).every(l => typeof l === 'string' && Object.hasOwn(RISK_EVIDENCE, l)))
    bad(`config.riskLabels must be an array of ${Object.keys(RISK_EVIDENCE).join('|')}`);
  if (!isObj(c.testCommands ?? {})) bad('config.testCommands must map name -> { cmd, args, format? }');
  for (const [name, e] of Object.entries(c.testCommands ?? {})) {
    if (!SAFE_NAME.test(name) || !isObj(e)) bad(`config.testCommands.${name} must be a { cmd, args, format? } entry with a safe name`);
    only(e, ['cmd', 'args', 'format'], `testCommands.${name}`);
    if (typeof e.cmd !== 'string' || !e.cmd || !strings(e.args ?? [])) bad(`config.testCommands.${name} needs cmd and args: [string]`);
    if (e.format !== undefined && !RUNNER_FORMATS.includes(e.format)) bad(`config.testCommands.${name}.format must be ${RUNNER_FORMATS.join('|')}`);
  }
  if (!Array.isArray(doc.nodes) || !doc.nodes.length) bad('nodes must be a non-empty array');
  const nodes = doc.nodes.map(n => {
    if (!isObj(n)) bad('node must be an object');
    only(n, NODE_FIELDS, `node ${n.id}`);
    if (!NODE_PHASES.includes(n.phase ?? 'BUILD')) bad(`node ${n.id}: phase must be ${NODE_PHASES.join('|')} (REVIEW is never dispatched)`);
    if (typeof n.promptFile !== 'string') bad(`node ${n.id}: promptFile required`);
    for (const k of ['othersOwned', 'evidence', 'redSpecs']) if (!Array.isArray(n[k] ?? [])) bad(`node ${n.id}: ${k} must be an array`);
    return { deps: [], reads: [], writes: [], othersOwned: [], resources: [], risk: [], complexity: 'medium', modelTier: 'inherit',
      estimatedMemoryMb: 0, phase: 'BUILD', evidence: [], redSpecs: [], ...n };
  });
  try {
    const plain = nodes.map(n => ({ id: n.id, deps: n.deps, reads: n.reads, writes: n.writes, resources: n.resources, risk: n.risk,
      complexity: n.complexity, model: n.modelTier, estimatedMemoryMb: n.estimatedMemoryMb }));
    validateNodes({ phase: 'BUILD', nodes: plain });
    schedule({ phase: 'BUILD', nodes: plain, maxConcurrency: c.width ?? 1, memoryBudgetMb: c.memoryBudgetMb ?? null }); // cycles, budget
  } catch (e) { bad(e.message); }
  validateUnits(nodes, c, bad);
  return { schema: DAG_SCHEMA, nodes,
    config: { billing: 'subscription', width: 1, modelMap: {}, riskLabels: [], testCommands: {}, ...c, candidateExclusions: [...(ex ?? pinned ?? [])] } };
}

/** A unit tagged node collapses into its unit; any other node is its own vertex (for unit cycles and order). */
export const unitVertex = (n) => (n.unit !== undefined ? `u:${n.unit}` : `n:${n.id}`);

/**
 * The opt-in Wave 2a fields (absent by default): `unit` (a safe id distinct from every node id and
 * testCommands name), `checks` (testCommands names; needs `unit`), `acceptance` (ids from
 * config.acceptanceIds, the approved plan's acceptance criteria). Once any node has `acceptance`,
 * every id of config.acceptanceIds must be mapped to at least one node. Units may not form a cycle
 * (also through unit-less nodes), or a unit's checks could wait on its own dependents.
 * `config.unitRecheckCeiling` (Wave 2b-i, needs a unit) is the run-wide unit re-check ceiling
 * (engine-units.mjs DEFAULT_UNIT_RECHECK_CEILING when absent; never defaulted into the config).
 * `config.unitReview` (Wave 2b-ii, boolean, needs a unit; never defaulted, so the DAG digest covers
 * it only when set): `true` makes every unit need an accepted, current unit review chain
 * (engine-unit-review.mjs) before `gate review` and `gate ship-ready`.
 */
function validateUnits(nodes, c, bad) {
  const ids = new Set(nodes.map(n => n.id)), cmds = Object.keys(c.testCommands ?? {});
  for (const n of nodes) {
    if (n.unit !== undefined && !(typeof n.unit === 'string' && SAFE_NAME.test(n.unit) && n.unit !== '__proto__')) bad(`node ${n.id}: unit must be a safe id`);
    if (n.unit !== undefined && (ids.has(n.unit) || cmds.includes(n.unit))) bad(`node ${n.id}: unit ${n.unit} collides with a node id or testCommands name`);
    if (n.checks !== undefined) {
      if (!strings(n.checks)) bad(`node ${n.id}: checks must be testCommands names`);
      if (n.unit === undefined) bad(`node ${n.id}: checks need a unit`);
      const unknown = n.checks.filter(x => !cmds.includes(x));
      if (unknown.length) bad(`node ${n.id}: unknown check(s) ${unknown} (not in config.testCommands)`);
    }
    if (n.acceptance !== undefined && !strings(n.acceptance)) bad(`node ${n.id}: acceptance must be acceptance criterion ids`);
  }
  const cap = c.unitRecheckCeiling;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0 && cap <= 100)) bad('config.unitRecheckCeiling must be an integer 0..100');
  if (cap !== undefined && !nodes.some(n => n.unit !== undefined)) bad('config.unitRecheckCeiling needs a node with a unit');
  if (c.unitReview !== undefined && typeof c.unitReview !== 'boolean') bad('config.unitReview must be a boolean');
  if (c.unitReview !== undefined && !nodes.some(n => n.unit !== undefined)) bad('config.unitReview needs a node with a unit');
  const acc = c.acceptanceIds;
  if (acc !== undefined && !(strings(acc) && acc.length && acc.every(Boolean) && new Set(acc).size === acc.length))
    bad('config.acceptanceIds must be unique non-empty strings');
  if (acc === undefined && nodes.some(n => n.acceptance !== undefined)) bad('node acceptance needs config.acceptanceIds (the approved plan\'s acceptance criterion ids)');
  if (acc !== undefined) {
    const unknown = [...new Set(nodes.flatMap(n => n.acceptance ?? []))].filter(x => !acc.includes(x));
    if (unknown.length) bad(`acceptance id(s) ${unknown} are not in config.acceptanceIds`);
    const unmapped = acc.filter(id => !nodes.some(n => (n.acceptance ?? []).includes(id)));
    if (unmapped.length) bad(`acceptance criteria mapped to no node: ${unmapped}`);
  }
  if (!nodes.some(n => n.unit !== undefined)) return;
  const byId = Object.fromEntries(nodes.map(n => [n.id, n])), edges = new Map();
  for (const n of nodes) for (const d of n.deps) {
    const from = unitVertex(byId[d]), to = unitVertex(n);
    if (from !== to) edges.set(from, new Set([...(edges.get(from) ?? []), to]));
  }
  const state = new Map();
  const visit = (v, path) => {
    if (state.get(v) === 'done') return;
    if (state.get(v) === 'open') bad(`units form a cycle: ${[...path, v].join(' -> ')}`);
    state.set(v, 'open');
    for (const w of edges.get(v) ?? []) visit(w, [...path, v]);
    state.set(v, 'done');
  };
  for (const n of nodes) visit(unitVertex(n), []);
}

/** Transitive dependents of `ids`, including `ids`. */
export function closure(S, ids) {
  const out = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, n] of Object.entries(S.nodes)) if (!out.has(id) && n.deps.some(d => out.has(d))) { out.add(id); grew = true; }
  }
  return [...out].sort();
}

/** Ancestors of `until` (inclusive), or null for no limit. */
export function scope(S, until) {
  if (!until) return null;
  if (!S.nodes[until]) throw coded('bad_context', `unknown node ${until}`);
  const out = new Set([until]);
  for (const id of out) for (const d of S.nodes[id].deps) out.add(d);
  return out;
}

/** True when `p` equals or sits under one of `roots`. */
export const under = (p, roots) => roots.some(r => p === r || p.startsWith(r + '/'));
export const overlap = (p, q) => p === q || p.startsWith(q + '/') || q.startsWith(p + '/');

/** Whether provider output reports success (claude JSON without is_error; a codex agent message). */
export function providerOk(provider, out) {
  if (out === null) return false;
  if (provider === 'claude') { try { return JSON.parse(out).is_error !== true; } catch { return false; } }
  if (provider === 'codex') return out.split(/\r?\n/).some(l => { try { const e = JSON.parse(l); return e.type === 'item.completed' && e.item?.type === 'agent_message'; } catch { return false; } });
  return true;
}

// ---- gate CLI inputs ------------------------------------------------------------------------

const GATE_FIELDS = {
  red: ['node', 'command', 'specs'],
  review: ['review_execution', 'kind', 'primary', 'second_opinion', 'reconciliation', 'graded_artifacts', 'repair_ownership', 'repair_prompt_file'],
  'ship-ready': ['risk_evidence', 'artifacts', 'exclusions', 'candidate_id'],
  'unit-review': ['unit', 'review_execution', 'kind', 'approved_plan_digest', 'dag_digest', 'base_commit', 'primary', 'second_opinion',
    'reconciliation', 'graded_artifacts', 'repair_ownership', 'repair_prompt_file'],
};

/**
 * Validate a gate input document; unknown fields or wrong types throw `bad_input` (a usage error).
 * Inputs only select: a RED command, format, resources and timeout come from the bound DAG, and
 * local proof is produced by the engine (never accepted from the input).
 */
export function gateInput(kind, doc) {
  const bad = (m) => { throw coded('bad_input', `gate ${kind}: ${m}`); };
  if (!Object.hasOwn(GATE_FIELDS, kind ?? '')) bad('kind must be red, review, ship-ready or unit-review');
  if (!isObj(doc)) bad('input must be a JSON object');
  const extra = Object.keys(doc).filter(k => !GATE_FIELDS[kind].includes(k));
  if (extra.length) bad(`unknown input field(s): ${extra.join(', ')} (commands, formats, resources and local proof come from the bound DAG)`);
  if (kind === 'red') {
    if (typeof doc.node !== 'string') bad('node is a required string');
    if (doc.command !== undefined && typeof doc.command !== 'string') bad('command selects a config.testCommands entry by name');
    if (doc.specs !== undefined && !(Array.isArray(doc.specs) && doc.specs.every(x => isObj(x) && typeof x.file === 'string' && typeof x.name === 'string')))
      bad('specs must be [{ file, name }]');
  }
  if (['review', 'unit-review'].includes(kind) && doc.repair_prompt_file !== undefined && typeof doc.repair_prompt_file !== 'string') bad('repair_prompt_file must be a path');
  if (kind === 'unit-review') {
    for (const k of ['unit', 'approved_plan_digest', 'dag_digest', 'base_commit']) if (typeof doc[k] !== 'string' || !doc[k]) bad(`${k} is a required string`);
    if (doc.repair_ownership !== undefined && !strings(doc.repair_ownership)) bad('repair_ownership must be paths');
  }
  if (kind === 'ship-ready') {
    if (doc.exclusions !== undefined && !strings(doc.exclusions)) bad('exclusions must be strings');
    if (doc.candidate_id !== undefined && typeof doc.candidate_id !== 'string') bad('candidate_id must be a string');
    if (doc.artifacts !== undefined && !(isObj(doc.artifacts) && Object.values(doc.artifacts).every(v => typeof v === 'string'))) bad('artifacts must map name -> path');
    if (doc.risk_evidence !== undefined && !(Array.isArray(doc.risk_evidence)
      && doc.risk_evidence.every(e => isObj(e) && typeof e.kind === 'string' && typeof e.path === 'string' && Object.keys(e).length === 2)))
      bad('risk_evidence must be [{ kind, path }] (red_accepted is derived from engine state)');
  }
  return doc;
}

/**
 * RED specs pinned by the DAG node: `{file,name}` entries are used as-is (input specs, if any,
 * must equal them); plain path entries only bound which files input specs may name.
 */
export function pinnedSpecs(node, specs) {
  const pinned = node.redSpecs ?? [];
  const named = pinned.filter(isObj);
  if (named.length) {
    if (specs && JSON.stringify(specs) !== JSON.stringify(named)) return { code: 'spec_unpinned', reason: 'input specs differ from the DAG redSpecs' };
    return { specs: named };
  }
  const files = pinned.filter(p => typeof p === 'string');
  if (specs && specs.every(s => files.includes(s.file))) return { specs };
  return { code: 'spec_unpinned', reason: `RED specs must name files declared in node ${node.id} redSpecs` };
}

/** The RED runner the input selects among the DAG's formatted testCommands (the only one when unnamed). */
export function redRunner(config, name) {
  const runners = Object.entries(config.testCommands ?? {}).filter(([, e]) => e.format);
  const pick = name ?? (runners.length === 1 ? runners[0][0] : undefined);
  const hit = runners.find(([k]) => k === pick);
  return hit ? { name: hit[0], ...hit[1] } : null;
}

/**
 * Risk evidence with `red_accepted` derived from accepted RED gates in engine state and `exists`
 * from the `exists(path)` probe (engine-io.mjs evidenceExists), never from input.
 */
export const boundRiskEvidence = (S, list, exists) => list.map(e => ({ ...e,
  red_accepted: Object.values(S.gates?.red ?? {}).some(ev => (ev.specs ?? []).some(s => s.file === e.path)),
  exists: typeof e.path === 'string' && e.path.length > 0 && exists(e.path) }));
