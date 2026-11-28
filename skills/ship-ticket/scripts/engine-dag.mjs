/**
 * Pure helpers of the durable run engine (run-engine.mjs): the `ship-ticket-engine-dag-v1`
 * schema, the plan narrative digest, dependency closure and scope, gate input validation,
 * RED spec pinning, sequenced engine events and judgments. No I/O. Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { posix, isAbsolute } from 'node:path';
import { validateNodes, schedule, RISK_EVIDENCE, CONTROL_ID } from './harness.mjs';
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
/** Plan roots a worker may never own (carrier.mjs PLAN_ROOTS). */
const PLAN_ROOTS = ['.specs', '.spec'];
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
  'candidateExclusions', 'testCommands', 'base', 'riskLabels', 'acceptanceIds', 'unitRecheckCeiling', 'unitReview',
  'securityPolicy', 'catalogDigest', 'controlCoverage', 'auditRecord', 'testKinds', 'pinnedBase', 'repoIdentity', 'durableRun', 'earlyChecks', 'stagePolicy'];

/**
 * S-12 (ASTF-6): `config.pinnedBase` ({ remote: <remote name> }, opt-in, never defaulted, bound by the DAG digest) pins the
 * run's base at init to the commit the REMOTE names for the base branch (run-engine.mjs init; S.base { remote, identity, ref,
 * sha, merge_base, pinned_at_seq }). Every engine base read goes through baseRef(S): the pinned merge base when the run has
 * one, else config.base (default HEAD), today's read byte for byte. One accessor, so no site reads a local ref while another
 * reads the pin (a partial switch would fire RED_INVALIDATED base_moved).
 */
export const pinnedBaseOn = (S) => S?.config?.pinnedBase !== undefined;
export const baseRef = (S) => (pinnedBaseOn(S) ? pinnedMergeBase(S) : S?.config?.base ?? 'HEAD');
/** A pinned run's merge base, or base_state_missing: a pinned run never falls back to a local ref. */
function pinnedMergeBase(S) {
  const m = S?.base?.merge_base;
  if (typeof m === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(m)) return m;
  throw coded('base_state_missing', 'the run pins its base (config.pinnedBase) but S.base has no well-formed merge_base: a partial pin is never resumed');
}
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * S-28a (ASTF-5): `config.repoIdentity` (exactly true, opt-in, never defaulted, bound by the DAG digest, needs config.pinnedBase)
 * binds the run to the repository its pinned remote names at init and re-verifies it at every gate (engine-identity.mjs).
 */
export const repoIdentityOn = (S) => S?.config?.repoIdentity === true;

/**
 * `config.auditRecord` (W3-record, boolean, opt-in, never defaulted, so the DAG digest covers it only
 * when set): `true` makes the engine record more (review verdicts and reconciliation text); it never
 * changes a gate decision. Absent or false, every record, event and log line is as before.
 */
export const auditOn = (S) => S?.config?.auditRecord === true;

/**
 * S-01b2 P5r: `config.testKinds` ({ policy: 1 }, opt-in, bound by the DAG digest) activates the test-kind freeze gate,
 * and a testCommands entry with `evidence: { report: 'fd', covers: [glob], files: bool, config_paths: [path] }` is the
 * runner that provides its evidence (`files` true exactly when args hold `{files}`). P4r's entry is FLAT: this is the map.
 */
export const evidenceEntries = (config) => Object.entries(config?.testCommands ?? {}).filter(([, e]) => e.evidence !== undefined);
export const flatEntry = (name, e) => ({ name, format: e.format, cmd: e.cmd, args: [...(e.args ?? [])], covers: [...e.evidence.covers], config_paths: [...e.evidence.config_paths] });

// ---- security policy 2 (AIS-HARNESS-4 Wave B) -------------------------------------------------

/**
 * Runs whose trusted START was approved before this instant are grandfathered (no security policy
 * needed, byte-identical behaviour). The one place the cutoff lives.
 * It must be >= the merge instant of the Wave B PR and is finalized by the owner at merge: a run
 * STARTed after the cutoff by an engine without Wave B (no config.securityPolicy) would otherwise fail
 * verifyBinding (security_policy_required) once this engine resumes it.
 */
export const SECURITY_POLICY_CUTOFF = '2026-11-12T00:00:00.000Z';
/** Whether a START approves a legacy run: approved_at (else timestamp) strictly before the cutoff; missing or unparseable fails closed. */
export function legacyApproval(start) {
  const at = start?.approved_at ?? start?.timestamp;
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) && t < Date.parse(SECURITY_POLICY_CUTOFF);
}
/** Every new branch, event, state key and view field of Wave B is gated on this. */
export const securityOn = (S) => S?.config?.securityPolicy === 2;
/** Every refusal code the engine half of Wave B introduced (security-plan.mjs keeps its own SECURITY_CODES). */
export const ENGINE_SECURITY_CODES = Object.freeze(['security_policy_required', 'security_pairs_mismatch', 'catalog_unavailable', 'control_unproven',
  'waiver_unauthorized', 'addendum_conflict', 'addendum_outside_contract', 'addendum_required', 'reassess_unclassified', 'reassess_stale',
  'security_review_stale', 'security_row_escape', 'security_outcome_escape', 'security_reapproval', 'security_na_disputed']);
/** A boundary id: printable (no control character or line break), no edge whitespace, at most 200 characters; ':' allowed. */
export const BOUNDARY_ID = /^[^\s\x00-\x1f\x7f\x85\u2028\u2029](?:[^\x00-\x1f\x7f\x85\u2028\u2029]{0,198}[^\s\x00-\x1f\x7f\x85\u2028\u2029])?$/;
/** The pair id '<boundary>:<control>' (review rule_rows subject_id). */
export const pairKey = (p) => `${p.boundary}:${p.control}`;
/** security-plan.mjs parsePairId's split: the LAST colon that precedes a control id (kept local: the engine imports no catalog code on legacy paths). */
const PAIR_ID = /^(.+):(VAPT-[A-Z]+-\d\d)$/;
/** Whether the pair id of (boundary, control) splits back into exactly that boundary and control. */
export const pairRoundTrips = (boundary, control) => { const m = PAIR_ID.exec(`${boundary}:${control}`); return Boolean(m) && m[1] === boundary && m[2] === control; };
const specKey = (s) => `${s.file}\u0000${s.name}`;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const isSpec = (s) => isObj(s) && Object.keys(s).length === 2 && typeof s.file === 'string' && s.file.length > 0 && typeof s.name === 'string' && s.name.length > 0;
/** A repository-relative, normalized path: not absolute, no backslash, no '.', '..' or empty segment (writes, othersOwned, pair specs). */
const normalRel = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !p.includes('\\') && !p.split('/').some(x => x === '..' || x === '.' || !x);

/**
 * Shape and contract checks of one (boundary, control) pair against `nodes` (by id): returns
 * { shape } for a malformed pair, { contract } when its node is unknown or a spec is not under the
 * node's writes, { pinned } when a spec is missing from the node's named redSpecs, else {}.
 */
export function pairProblem(p, nodesById, { needPinned = true } = {}) {
  if (!isObj(p) || Object.keys(p).some(k => !['boundary', 'control', 'node', 'specs'].includes(k))) return { shape: 'a pair is { boundary, control, node, specs }' };
  if (typeof p.boundary !== 'string' || !BOUNDARY_ID.test(p.boundary)) return { shape: `boundary ${J(p.boundary)} must be a printable id (no line break or control character, no edge whitespace)` };
  if (typeof p.control !== 'string' || !CONTROL_ID.test(p.control)) return { shape: `control ${J(p.control)} is not a catalog control id` };
  if (!pairRoundTrips(p.boundary, p.control)) return { shape: `pair id ${J(pairKey(p))} does not split back into its boundary and control` };
  if (typeof p.node !== 'string') return { shape: 'node must be a node id' };
  if (!Array.isArray(p.specs) || !p.specs.length || !p.specs.every(isSpec)) return { shape: `${pairKey(p)}: specs must be a non-empty [{ file, name }]` };
  // A backslash would match a different file on POSIX than the one the spec names; held to the othersOwned rule.
  const odd = p.specs.find(s => !normalRel(s.file));
  if (odd) return { shape: `${pairKey(p)}: spec file ${J(odd.file)} must be repository-relative and normalized (no backslash, '.', '..' or empty segment)` };
  const n = Object.hasOwn(nodesById, p.node) ? nodesById[p.node] : undefined;
  if (!n) return { contract: `${pairKey(p)}: node ${p.node} is not in the DAG` };
  const outside = p.specs.find(s => !under(s.file, n.writes ?? []));
  if (outside) return { contract: `${pairKey(p)}: spec ${outside.file} is not under node ${p.node} writes (contract expansion needs re-approval)` };
  if (needPinned) {
    const named = (n.redSpecs ?? []).filter(isObj).map(specKey);
    const unpinned = p.specs.find(s => !named.includes(specKey(s)));
    if (unpinned) return { pinned: `${pairKey(p)}: spec ${unpinned.file} "${unpinned.name}" is not a named redSpecs entry of node ${p.node}` };
  }
  return {};
}
const J = JSON.stringify;

/**
 * Policy-2 config: securityPolicy (only 2), catalogDigest ('sha256:<hex>'), controlCoverage (each pair
 * its own spec(s), each spec a named redSpecs entry under its node's writes, no spec shared between
 * pairs). None of the three is defaulted, so a legacy DAG's bytes and bound config are unchanged.
 */
function validateSecurity(nodes, c, bad) {
  const p = c.securityPolicy;
  if (p !== undefined && p !== 2) bad('config.securityPolicy must be 2 (omit it only for a run approved before the policy cutoff)');
  if (p !== 2) {
    if (c.controlCoverage !== undefined || c.catalogDigest !== undefined) bad('config.controlCoverage and config.catalogDigest need config.securityPolicy 2');
    return;
  }
  if (typeof c.catalogDigest !== 'string' || !DIGEST_RE.test(c.catalogDigest)) bad('config.catalogDigest must be sha256:<hex> of the catalog the plan was approved against');
  if (!Array.isArray(c.controlCoverage)) bad('config.controlCoverage must be an array of { boundary, control, node, specs } ([] is an evidenced empty assessment)');
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const pairs = new Set(), specs = new Map();
  for (const pair of c.controlCoverage) {
    const why = pairProblem(pair, byId);
    if (why.shape || why.contract || why.pinned) bad(`config.controlCoverage: ${why.shape ?? why.contract ?? why.pinned}`);
    if (pairs.has(pairKey(pair))) bad(`config.controlCoverage: duplicate pair ${pairKey(pair)}`);
    pairs.add(pairKey(pair));
    for (const s of pair.specs) {
      const other = specs.get(specKey(s));
      if (other !== undefined && other !== pairKey(pair)) bad(`config.controlCoverage: spec ${s.file} "${s.name}" is shared by ${other} and ${pairKey(pair)} (each pair has its own spec)`);
      specs.set(specKey(s), pairKey(pair));
    }
  }
  if (c.controlCoverage.length && !Object.values(c.testCommands ?? {}).some(e => e.format))
    bad('config.controlCoverage needs a formatted config.testCommands runner (the proof parses each pair spec\'s result)');
}
/**
 * S5 (P5a): `config.earlyChecks` (exactly { version: 1 }, opt-in, never defaulted, bound by the DAG digest) enables the pre-review
 * `gate prove` (engine-prove.mjs): the repository's declared working-tree early checks and the bounded proof, both before REVIEW.
 * Only with it may a testCommands entry carry the per-entry fields below; a DAG without it is validated and run as before.
 *   timeoutMs  the entry's own deadline (1 s .. 1 h; default config.timeoutMs)
 *   resource, role ('setup' | 'consumer' | 'teardown'), after [entry names]: the D8 setup/consumer/teardown contract.
 * The run order is the declaration order (bound by the DAG digest): the engine never reorders entries. `after` may name only an
 * EARLIER entry, and for each declared resource every consumer must declare (directly or through `after`) every setup of it, and
 * every teardown every consumer, so a reset declared after a reader, or a reader with no declared setup, is refused at preflight and
 * init. Shared state no entry declares is not detectable (stated limit).
 */
export const earlyChecksOn = (S) => S?.config?.earlyChecks?.version === 1;
const EARLY_ENTRY_FIELDS = ['timeoutMs', 'resource', 'role', 'after'];
export const ENTRY_ROLES = ['setup', 'consumer', 'teardown'];
/** Every `after` ancestor of entry `name` (transitive) in `cmds` (validated entries). */
export function entryAncestors(cmds, name, seen = new Set()) {
  for (const a of cmds[name]?.after ?? []) if (!seen.has(a)) { seen.add(a); entryAncestors(cmds, a, seen); }
  return seen;
}
function validateEarlyChecks(c, bad) {
  if (c.earlyChecks === undefined) return;
  if (!(isObj(c.earlyChecks) && Object.keys(c.earlyChecks).join() === 'version' && c.earlyChecks.version === 1)) bad('config.earlyChecks must be exactly { version: 1 }');
  const cmds = c.testCommands ?? {}, names = Object.keys(cmds);
  for (const [i, name] of names.entries()) {
    const e = cmds[name];
    if (e.timeoutMs !== undefined && !(Number.isInteger(e.timeoutMs) && e.timeoutMs >= 1000 && e.timeoutMs <= 3600000))
      bad(`config.testCommands.${name}.timeoutMs must be an integer in [1000, 3600000] (the entry's own deadline)`);
    if ((e.role === undefined) !== (e.resource === undefined)) bad(`config.testCommands.${name}: resource and role are declared together`);
    if (e.role !== undefined && !ENTRY_ROLES.includes(e.role)) bad(`config.testCommands.${name}.role must be ${ENTRY_ROLES.join('|')}`);
    if (e.resource !== undefined && !(typeof e.resource === 'string' && SAFE_NAME.test(e.resource))) bad(`config.testCommands.${name}.resource must be a safe name`);
    if (e.after !== undefined && !(strings(e.after) && new Set(e.after).size === e.after.length)) bad(`config.testCommands.${name}.after must be distinct entry names`);
    const later = (e.after ?? []).find(a => !names.slice(0, i).includes(a));
    if (later !== undefined) bad(`config.testCommands.${name}.after names ${J(later)}, which is not an entry declared before it: the run order is the `
      + 'declaration order (bound by the DAG digest) and the engine never reorders it; declare dependent entries in their order');
  }
  // D8: per declared resource, every consumer declares every setup, and every teardown every consumer (a reset after a reader is refused).
  const byRole = (res, role) => names.filter(n => cmds[n].resource === res && cmds[n].role === role);
  for (const res of new Set(names.map(n => cmds[n].resource).filter(r => r !== undefined))) {
    for (const [late, early] of [['consumer', 'setup'], ['teardown', 'consumer']]) for (const x of byRole(res, late)) {
      const missing = byRole(res, early).find(y => !entryAncestors(cmds, x).has(y));
      if (missing !== undefined) bad(`config.testCommands: undeclared interdependence on resource ${J(res)}: ${late} ${x} does not declare ${early} ${missing} `
        + `(directly or through after), so the order between them is undeclared (D8: a ${early} must be declared before, and named by, each ${late})`);
    }
  }
}
const NODE_FIELDS = ['id', 'deps', 'reads', 'writes', 'othersOwned', 'resources', 'risk', 'complexity', 'modelTier',
  'estimatedMemoryMb', 'promptFile', 'phase', 'role', 'evidence', 'redSpecs', 'unit', 'acceptance', 'checks'];
// REPAIR is never a DAG node: the engine dispatches repairs from review records only (it would fail 'dispatch refused').
const NODE_PHASES = ['BUILD', 'PROVE', 'SHIP'];
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
  if ((c.riskLabels !== undefined && !Array.isArray(c.riskLabels)) || !(c.riskLabels ?? []).every(l => typeof l === 'string' && Object.hasOwn(RISK_EVIDENCE, l)))
    bad(`config.riskLabels must be an array of ${Object.keys(RISK_EVIDENCE).join('|')}`);
  if (!isObj(c.testCommands ?? {})) bad('config.testCommands must map name -> { cmd, args, format? }');
  for (const [name, e] of Object.entries(c.testCommands ?? {})) {
    if (!SAFE_NAME.test(name) || !isObj(e)) bad(`config.testCommands.${name} must be a { cmd, args, format? } entry with a safe name`);
    only(e, ['cmd', 'args', 'format', 'evidence', ...(c.earlyChecks !== undefined ? EARLY_ENTRY_FIELDS : [])], `testCommands.${name}`);
    if (typeof e.cmd !== 'string' || !e.cmd || !strings(e.args ?? [])) bad(`config.testCommands.${name} needs cmd and args: [string]`);
    if (e.format !== undefined && !RUNNER_FORMATS.includes(e.format)) bad(`config.testCommands.${name}.format must be ${RUNNER_FORMATS.join('|')}`);
    const v = e.evidence;
    if (v === undefined) continue;
    if (!isObj(v)) bad(`config.testCommands.${name}.evidence must be an object`);
    only(v, ['report', 'covers', 'files', 'config_paths'], `testCommands.${name}.evidence`);
    if (c.testKinds === undefined || !e.format || v.report !== 'fd' || !strings(v.covers) || !v.covers.length || !strings(v.config_paths)
      || typeof v.files !== 'boolean' || v.files !== (e.args ?? []).includes('{files}'))
      bad(`config.testCommands.${name}.evidence needs config.testKinds, a format, report 'fd', non-empty covers, config_paths, and files true exactly when args hold {files}`);
  }
  if (c.testKinds !== undefined && !(isObj(c.testKinds) && Object.keys(c.testKinds).join() === 'policy' && c.testKinds.policy === 1)) bad('config.testKinds must be exactly { policy: 1 }');
  // S1 (P1): every new run is a durable run (lib/run-placement.mjs: state, log, usage, attempts and lock in the git common
  // dir; a persisted deadline per launched attempt). `false` is the documented escape hatch to the legacy per-worktree
  // placement; `{ version: 1 }` states the default explicitly. An engine without S1 refuses the field (unknown config).
  if (c.durableRun !== undefined && c.durableRun !== false && !(isObj(c.durableRun) && Object.keys(c.durableRun).join() === 'version' && c.durableRun.version === 1))
    bad('config.durableRun must be false (the legacy per-worktree placement) or exactly { version: 1 }');
  validateEarlyChecks(c, bad);
  // PR-3 (STAB S4-min, P6, opt-in, UNQUALIFIED): stage obligations + plan feasibility; the policy itself is the approved
  // narrative's stage-policy-v1 line (stage-obligations.mjs). An engine without PR-3 refuses the field (unknown config).
  if (c.stagePolicy !== undefined && !(isObj(c.stagePolicy) && Object.keys(c.stagePolicy).join() === 'version' && c.stagePolicy.version === 1)) bad('config.stagePolicy must be exactly { version: 1 }');
  if (!Array.isArray(doc.nodes) || !doc.nodes.length) bad('nodes must be a non-empty array');
  const nodes = doc.nodes.map(n => {
    if (!isObj(n)) bad('node must be an object');
    only(n, NODE_FIELDS, `node ${n.id}`);
    if (!NODE_PHASES.includes(n.phase ?? 'BUILD')) bad(`node ${n.id}: phase must be ${NODE_PHASES.join('|')} (REVIEW is never dispatched; REPAIR only from a review record)`);
    if (typeof n.promptFile !== 'string') bad(`node ${n.id}: promptFile required`);
    for (const k of ['othersOwned', 'evidence', 'redSpecs']) if (n[k] !== undefined && !Array.isArray(n[k])) bad(`node ${n.id}: ${k} must be an array`);
    return { deps: [], reads: [], writes: [], othersOwned: [], resources: [], risk: [], complexity: 'medium', modelTier: 'inherit',
      estimatedMemoryMb: 0, phase: 'BUILD', evidence: [], redSpecs: [], ...n };
  });
  // othersOwned goes to the carrier as ownership paths (repoRelative there); hold it to the same rule as writes (harness validateNodes).
  for (const n of nodes) {
    if (!Array.isArray(n.othersOwned)) continue;
    const badPath = n.othersOwned.find(p => !normalRel(p));
    if (badPath !== undefined) bad(`node ${n.id}: othersOwned paths must be repository-relative and normalized`);
  }
  // The carrier refuses any worker that owns a plan root (no forged START); refuse it here, at init, not as a node_failed mid-run.
  for (const n of nodes) {
    const hit = [...(Array.isArray(n.writes) ? n.writes : []), ...(Array.isArray(n.othersOwned) ? n.othersOwned : [])].find(p => typeof p === 'string' && PLAN_ROOTS.some(r => {
      const q = p.replace(/\\/g, '/').split('/').filter(x => x && x !== '.').join('/').toLowerCase();
      const norm = posix.normalize(q);
      return norm === r || norm.startsWith(r + '/');
    }));
    if (hit !== undefined) bad(`node ${n.id}: ${hit} is under a plan artifact root (.specs/.spec); workers may not own it, so write it from the orchestrator, not a node`);
  }
  try {
    const plain = nodes.map(n => ({ id: n.id, deps: n.deps, reads: n.reads, writes: n.writes, resources: n.resources, risk: n.risk,
      complexity: n.complexity, model: n.modelTier, estimatedMemoryMb: n.estimatedMemoryMb }));
    validateNodes({ phase: 'BUILD', nodes: plain });
    schedule({ phase: 'BUILD', nodes: plain, maxConcurrency: c.width ?? 1, memoryBudgetMb: c.memoryBudgetMb ?? null }); // cycles, budget
  } catch (e) { bad(e.message); }
  validateUnits(nodes, c, bad);
  validateSecurity(nodes, c, bad);
  if (c.auditRecord !== undefined && typeof c.auditRecord !== 'boolean') bad('config.auditRecord must be a boolean');
  if (c.pinnedBase !== undefined && !(isObj(c.pinnedBase) && Object.keys(c.pinnedBase).join() === 'remote' && typeof c.pinnedBase.remote === 'string'
    && SAFE_REMOTE.test(c.pinnedBase.remote))) bad('config.pinnedBase must be exactly { remote: <remote name> }');
  if (c.pinnedBase !== undefined && c.base !== undefined && !(typeof c.base === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(c.base) && !c.base.includes('..')))
    bad('config.pinnedBase needs config.base to be absent, HEAD or a branch name');
  if (c.repoIdentity !== undefined && !(c.repoIdentity === true && c.pinnedBase !== undefined)) bad('config.repoIdentity must be exactly true and needs config.pinnedBase');
  return { schema: DAG_SCHEMA, nodes,
    config: { billing: 'subscription', width: 1, modelMap: {}, riskLabels: [], testCommands: {}, ...c, candidateExclusions: [...(ex ?? pinned ?? [])] } };
}

/**
 * STAB-410 F-9, plan time only: every pair where a node READS a path that one of its TRANSITIVE dependents WRITES. Such a
 * write lands after the reader finished, so drift() would mark the reader stale and re-run it (before the freeze) or raise
 * post_freeze_drift (after). Overlap is equality or a whole-segment prefix in either direction, case-folded like the harness
 * collision rule; a glob counts by its literal prefix (the whole segments before the first segment holding a glob character),
 * so a glob without one overlaps everything (fail closed). Pure; `nodes` are validated DAG nodes (missing deps/reads/writes
 * are empty). Returns [{ reader, writer, read, write }] in node, read and dependent order, each pair once. Called ONLY by
 * run-engine `preflight`, never by validateEngineDag or init, so in-flight and legacy runs are untouched.
 */
const GLOB_CHAR = /[*?[\]{}!]/;
const literalPrefix = (p) => {
  const segs = String(p).toLowerCase().split('/');
  const i = segs.findIndex((x) => GLOB_CHAR.test(x));
  return (i < 0 ? segs : segs.slice(0, i)).join('/');
};
const pathsOverlap = (a, b) => {
  const x = literalPrefix(a), y = literalPrefix(b);
  return x === '' || y === '' || x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
};
export function dagReadWriteConflicts(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const children = new Map(list.map((n) => [n.id, []]));
  for (const n of list) for (const d of n.deps ?? []) children.get(d)?.push(n.id);
  const byId = new Map(list.map((n) => [n.id, n]));
  const out = [];
  for (const n of list) {
    const reads = n.reads ?? [];
    if (!reads.length) continue;
    const seen = new Set(), dependents = [], stack = [...(children.get(n.id) ?? [])];
    while (stack.length) { const id = stack.shift(); if (seen.has(id) || id === n.id) continue; seen.add(id); dependents.push(id); stack.push(...(children.get(id) ?? [])); }
    dependents.sort((a, b) => list.indexOf(byId.get(a)) - list.indexOf(byId.get(b)));
    for (const read of reads) for (const id of dependents) for (const write of byId.get(id).writes ?? []) {
      if (pathsOverlap(read, write)) out.push({ reader: n.id, writer: id, read, write });
    }
  }
  return out;
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
      if (n.checks.some(x => c.testCommands[x].evidence)) bad(`node ${n.id}: a unit check cannot be an evidence runner (it needs the report channel)`);
    }
    if (n.acceptance !== undefined && !strings(n.acceptance)) bad(`node ${n.id}: acceptance must be acceptance criterion ids`);
  }
  const cap = c.unitRecheckCeiling;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0 && cap <= 100)) bad('config.unitRecheckCeiling must be an integer 0..100');
  if (cap !== undefined && !nodes.some(n => n.unit !== undefined)) bad('config.unitRecheckCeiling needs a node with a unit');
  if (c.unitReview !== undefined && typeof c.unitReview !== 'boolean') bad('config.unitReview must be a boolean');
  if (c.unitReview !== undefined && !nodes.some(n => n.unit !== undefined)) bad('config.unitReview needs a node with a unit');
  const acc = c.acceptanceIds;
  // Wave 3: the final review must cover every mapped acceptance id; without ids that would pass vacuously.
  if (c.unitReview === true && acc === undefined) bad('config.unitReview needs config.acceptanceIds (the approved plan\'s acceptance criterion ids, each mapped to a node)');
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

/**
 * Ancestors of `until` (inclusive), or null for no limit. A dependency in another unit counts as done
 * only once its whole unit is verified (engine-units.mjs depDone), so every member of such a unit
 * (and its ancestors) is in scope too.
 */
export function scope(S, until) {
  if (!until) return null;
  if (!S.nodes[until]) throw coded('bad_context', `unknown node ${until}`);
  const out = new Set([until]);
  for (const id of out) for (const d of S.nodes[id].deps) {
    out.add(d);
    const u = S.nodes[d].unit;
    if (u !== undefined && u !== S.nodes[id].unit) for (const m of Object.values(S.nodes)) if (m.unit === u) out.add(m.id);
  }
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

const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;
/** A reassess input surface: exactly { boundary_id, kind, path, principals[] }; the boundary id obeys BOUNDARY_ID and the pair-id round trip. */
const surfaceShape = (s) => isObj(s) && Object.keys(s).length === 4 && ['boundary_id', 'kind', 'path', 'principals'].every(k => Object.hasOwn(s, k))
  && typeof s.boundary_id === 'string' && BOUNDARY_ID.test(s.boundary_id) && pairRoundTrips(s.boundary_id, 'VAPT-API-01')
  && nonEmptyString(s.kind) && nonEmptyString(s.path) && Array.isArray(s.principals) && s.principals.length > 0 && s.principals.every(nonEmptyString);

const GATE_FIELDS = {
  red: ['node', 'command', 'specs', 'addendum'],
  reassess: ['classifications', 'surfaces'],
  review: ['review_execution', 'kind', 'primary', 'second_opinion', 'reconciliation', 'graded_artifacts', 'repair_ownership', 'repair_prompt_file',
    'units_consumed'],
  'ship-ready': ['risk_evidence', 'artifacts', 'exclusions', 'candidate_id'],
  prove: [], // S5: everything prove runs comes from the bound DAG and the base's early-check declaration
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
  if (!Object.hasOwn(GATE_FIELDS, kind ?? '')) bad('kind must be red, review, ship-ready, unit-review, reassess or prove');
  if (!isObj(doc)) bad('input must be a JSON object');
  const extra = Object.keys(doc).filter(k => !GATE_FIELDS[kind].includes(k));
  if (extra.length) bad(`unknown input field(s): ${extra.join(', ')} (commands, formats, resources and local proof come from the bound DAG)`);
  if (kind === 'red') {
    if (typeof doc.node !== 'string') bad('node is a required string');
    if (doc.command !== undefined && typeof doc.command !== 'string') bad('command selects a config.testCommands entry by name');
    if (doc.specs !== undefined && !(Array.isArray(doc.specs) && doc.specs.every(x => isObj(x) && typeof x.file === 'string' && typeof x.name === 'string')))
      bad('specs must be [{ file, name }]');
    if (doc.addendum !== undefined && !(typeof doc.addendum === 'string' && SAFE_NAME.test(doc.addendum))) bad('addendum names a trusted SECURITY_ADDENDUM addendum_id');
  }
  if (kind === 'reassess' && doc.classifications !== undefined && !(Array.isArray(doc.classifications) && doc.classifications.every(c => isObj(c)
    && typeof c.signal_id === 'string' && c.signal_id.length > 0 && Object.keys(c).every(k => ['signal_id', 'facts', 'evidence', 'reason'].includes(k)))))
    bad('classifications must be [{ signal_id, facts?, evidence?, reason? }] (security-plan.mjs reassess)');
  if (kind === 'reassess' && doc.surfaces !== undefined && !(Array.isArray(doc.surfaces) && doc.surfaces.every(surfaceShape)))
    bad('surfaces must be [{ boundary_id, kind, path, principals: [string] }] with a printable boundary id that round-trips as a pair id (security-plan.mjs select surfaces)');
  if (['review', 'unit-review'].includes(kind) && doc.repair_prompt_file !== undefined && typeof doc.repair_prompt_file !== 'string') bad('repair_prompt_file must be a path');
  if (['review', 'unit-review'].includes(kind) && doc.repair_ownership !== undefined && !strings(doc.repair_ownership)) bad('repair_ownership must be paths');
  if (kind === 'unit-review') {
    for (const k of ['unit', 'approved_plan_digest', 'dag_digest', 'base_commit']) if (typeof doc[k] !== 'string' || !doc[k]) bad(`${k} is a required string`);
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
export function pinnedSpecs(node, specs, addendumSpecs) {
  // A trusted SECURITY_ADDENDUM's named specs for this node are the pin source when given (gate red --addendum).
  if (addendumSpecs !== undefined) {
    if (!addendumSpecs.length) return { code: 'spec_unpinned', reason: `the addendum names no spec for node ${node.id}` };
    if (specs && JSON.stringify(specs) !== JSON.stringify(addendumSpecs)) return { code: 'spec_unpinned', reason: 'input specs differ from the addendum specs' };
    return { specs: addendumSpecs };
  }
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
