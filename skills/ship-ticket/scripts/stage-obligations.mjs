/**
 * PR-3 (STAB S4-min, plan §7 P6): stage obligations instead of waivers, and plan feasibility. Opt-in by
 * `config.stagePolicy: { version: 1 }` (bound by the DAG digest); the stage policy itself is ONE visible
 * `stage-policy-v1: <json>` line of the approved narrative, so the plan digest the owner approved carries every stage and
 * every deferral (no DAG field, gate input or RUN-STATE line carries one). PROVISIONAL and UNQUALIFIED: no run is activated.
 *
 * Replaces, for a flagged run only (§6.1 P6; every other run keeps the frozen semantics):
 * - the `SECURITY_WAIVER boundary:"plan-3b"` route of `references/ship.md:102-114` for a verification row whose stage does not
 *   exist in the run: the plan declares it deferred and it becomes an OPEN OBLIGATION, bound to the candidate at SHIP_READY.
 *   SHIP_READY covers the merge stage only and lists the open obligations. The policy TEXT of ship.md:102-114, plan.md and
 *   security-risk.md §5 is unchanged (owner approval pending).
 * - the narrow `preflight` scope (schema, ordering, security binding): plus required artifacts, declared stages, named and
 *   executable RED/proof runners, and the existing path signal pre-scan of planned writes. Init runs the same checks.
 *
 * An obligation is NEVER marked verified by the Factory: there is no verify command, no evidence record and no ledger. It
 * stays open in this run and is closed OUTSIDE the Factory, through the follow-up ticket its tracker_ref (or trigger) names,
 * by that ticket's own acceptance (CI, exact-head review, merge). Only an open CURRENT-stage obligation could block a merge
 * (plan §7.2), and a current-stage control can never be deferred here, so every obligation this module records is a
 * deferred-stage one. Factory recording does not enforce deployment. The engine writes no authority event.
 * Trust bound (D1): `state.json` is same-user trusted; load checks the record's SHAPE against the retained line, and owner
 * commands compare that line with the approved narrative. Neither authenticates state.
 */
import { createHash } from 'node:crypto';
import { resolveExecutable } from './engine-prove.mjs'; // S5's resolver (side-effect-free module): one PATH semantics for proof and feasibility

const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.trim().length > 0;
const J = JSON.stringify;
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map(k => `${J(k)}:${canon(v[k])}`).join(',')}}` : J(v));

export const STAGE_LINE = 'stage-policy-v1: ';
const POLICY_KEYS = ['merge_stage', 'stages', 'rows', 'deferred', 'artifacts'];
const ROW_KEYS = ['id', 'check', 'stage', 'pair'];
const DEFER_KEYS = ['row', 'stage', 'environment', 'subject', 'required_evidence', 'trigger', 'tracker_ref'];
const PAIR = /^[^:]+:VAPT-[A-Z]+-\d+$/;

export const stageOn = (config) => config?.stagePolicy !== undefined;

/**
 * Parse and validate the approved narrative's stage-policy line (exactly one, at column 1, visible). Refusals:
 * stage_policy_missing, stage_policy_invalid, stage_unavailable (a row whose stage neither exists nor is deferred),
 * stage_deferral_invalid (a deferral of an available stage, the merge stage, another stage than its row's, or a 3a pair:
 * a current-stage control can never be deferred), obligation_trigger_missing (no trigger and no tracker).
 * Residual W8b (disclosed): stage availability is plan-asserted. A plan can omit a stage that exists (list only `merge`)
 * and so defer that stage's row; only the owner's approval of the visible, digest-bound line controls that. W8a (a check
 * this run executes) is refused in `feasibility`. `rows` are not cross-checked against the §3b table text.
 */
export function parseStagePolicy(narrative, { ticket } = {}) {
  const raw = narrative.split(/\r?\n/);
  const lines = raw.filter(l => l.startsWith(STAGE_LINE));
  const seen = visibleIndexes(raw);
  if (raw.some((l, i) => l.startsWith(STAGE_LINE) && !seen.has(i))) throw coded('stage_policy_invalid', 'a stage-policy line sits inside an HTML comment or a code fence: the approved line must be visible in the rendered plan');
  if (!lines.length) throw coded('stage_policy_missing', `config.stagePolicy needs one "${STAGE_LINE}<json>" line in the approved narrative (the plan approval carries the stage policy)`);
  if (lines.length > 1) throw coded('stage_policy_invalid', 'more than one stage-policy line in the approved narrative');
  let p;
  try { p = JSON.parse(lines[0].slice(STAGE_LINE.length)); } catch { throw coded('stage_policy_invalid', 'the stage-policy line is not JSON'); }
  const bad = (m) => { throw coded('stage_policy_invalid', m); };
  if (!isObj(p)) bad('the stage policy is an object');
  const extra = Object.keys(p).filter(k => !POLICY_KEYS.includes(k));
  if (extra.length) bad(`unknown stage policy field(s): ${extra.join(', ')}`);
  if (!Array.isArray(p.stages) || !p.stages.length || !p.stages.every(str) || new Set(p.stages).size !== p.stages.length) bad('stages: the unique stages that exist in this run');
  if (!p.stages.includes(p.merge_stage)) bad('merge_stage must be one of stages (SHIP_READY covers it)');
  if (!Array.isArray(p.rows) || !p.rows.length) bad('rows: the verification rows this plan declares (not cross-checked against the §3b table)');
  const rows = new Map();
  for (const r of p.rows) {
    if (!isObj(r) || Object.keys(r).some(k => !ROW_KEYS.includes(k)) || !str(r.id) || !str(r.check) || !str(r.stage) || (r.pair !== undefined && !(str(r.pair) && PAIR.test(r.pair))))
      bad(`row ${J(r)}: { id, check, stage, pair? }`);
    if (rows.has(r.id)) bad(`duplicate row ${r.id}`);
    rows.set(r.id, r);
  }
  if (!Array.isArray(p.deferred)) bad('deferred: an array (empty when every stage exists)');
  const deferred = new Map();
  for (const d of p.deferred) {
    if (!isObj(d) || Object.keys(d).some(k => !DEFER_KEYS.includes(k)) || !['row', 'stage', 'environment', 'subject', 'required_evidence'].every(k => str(d[k]))
      || [d.trigger, d.tracker_ref].some(v => v !== undefined && typeof v !== 'string')) bad(`deferral ${J(d)}: { row, stage, environment, subject, required_evidence, trigger?, tracker_ref? }`);
    const row = rows.get(d.row);
    if (!row) bad(`deferral of unknown row ${d.row}`);
    if (deferred.has(d.row)) bad(`row ${d.row} is deferred twice`);
    if (p.stages.includes(d.stage) || d.stage !== row.stage) throw coded('stage_deferral_invalid', `row ${d.row}: only a stage that does not exist in this run, the row's own stage, can be deferred (a current-stage control is never deferred; ${J(d.stage)} vs available ${J(p.stages)})`);
    if (row.pair !== undefined || PAIR.test(row.check)) throw coded('stage_deferral_invalid', `row ${d.row} names a §3a catalog pair: the engine proves pairs at the merge stage; never deferred`);
    if (!str(d.trigger) && !str(d.tracker_ref)) throw coded('obligation_trigger_missing', `deferral of row ${d.row} names neither a trigger nor a tracker: an unpaid stage with nothing to surface it is refused`);
    deferred.set(d.row, d);
  }
  for (const r of rows.values()) if (!p.stages.includes(r.stage) && !deferred.has(r.id))
    throw coded('stage_unavailable', `row ${r.id} (${r.check}) runs at stage ${J(r.stage)}, which does not exist in this run: declare it deferred with a trigger or tracker, or re-plan`);
  const artifacts = p.artifacts ?? [];
  if (!Array.isArray(artifacts) || !artifacts.every(a => str(a) && normalSpecs(a) && (!ticket || a !== `.specs/plans/${ticket}.md`))) bad('artifacts: exact orchestrator-written paths under .specs/ (no glob, never the plan itself)');
  return { policy_line: lines[0], merge_stage: p.merge_stage, stages: [...p.stages], rows: [...rows.values()], deferred: [...deferred.values()], artifacts: [...artifacts],
    policy_digest: sha(canon(p)) };
}
// Exact paths only (no glob character), so an artifact never widens the Design Contract beyond itself.
const normalSpecs = (p) => !/[\\*?[\]{}!]/.test(p) && p.startsWith('.specs/') && p.split('/').every(s => s && s !== '.' && s !== '..');

/** Indexes of lines outside every CommonMark fence (up to 3 spaces, 3+ backticks or tildes, closed by the same character at least as long). */
function unfenced(lines) {
  const out = new Set();
  let fence = null;
  for (const [i, l] of lines.entries()) {
    if (fence) {
      const c = /^ {0,3}(`+|~+)[ \t]*$/.exec(l);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      continue;
    }
    const o = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (o && !(o[1][0] === '`' && o[2].includes('`'))) { fence = { ch: o[1][0], len: o[1].length }; continue; }
    out.add(i);
  }
  return out;
}
/** HTML comments (terminated or not) blanked to spaces, line structure kept. */
const blankComments = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * The line indexes a renderer shows as prose, fail closed: a line counts only when it is visible under BOTH lexing orders,
 * comments blanked before fences are lexed AND fences lexed before comments are blanked (R2 MINOR-2: a `<!--` in a code
 * span with its `-->` inside a fence must not erase the fence opener). A blanked stage line no longer starts with the
 * marker, so it is never counted as visible either.
 */
function visibleIndexes(raw) {
  const a = blankComments(raw.join('\n')).split('\n');
  const first = unfenced(a);
  const fenced = unfenced(raw);
  const b = blankComments(raw.map((l, i) => (fenced.has(i) ? l : '')).join('\n')).split('\n');
  return new Set([...first].filter(i => fenced.has(i) && a[i] === raw[i] && b[i] === raw[i]));
}

/**
 * Whether `cmd` resolves to an executable regular file, by S5's `resolveExecutable` (a path with `/` relative to the
 * repository root, else each PATH entry, an empty or relative entry resolved against the root). It resolves nothing on
 * win32, so a stage run there is refused (fail closed; stage runs are POSIX-only and UNQUALIFIED).
 */
const executable = (cmd, root, env = process.env, platform = process.platform) => resolveExecutable(cmd, env, root, platform) !== null;

/**
 * The plan-feasibility checks preflight AND init run for a flagged run (refusals thrown as coded errors):
 * - required_artifact_outside_contract: a repository-required artifact (today the design-parity artifact of a `ui` run)
 *   is not declared in `artifacts` (a node never writes under .specs/, so the first reassess would see it outside the
 *   Design Contract: a sticky REAPPROVAL);
 * - proof_runner_missing (review R1 MAJOR-1): no config.testCommands entry at all; the local proof at SHIP_READY needs at
 *   least one command, so such a plan can never ship;
 * - stage_deferral_invalid: a deferred row names a check this run executes (a testCommands entry or a node check);
 * - red_runner_missing: for each RED-bearing node, no ONE eligible runner (formatted, non-evidence, executable) names
 *   EVERY spec file pinned to that node verbatim as an argument (review R1 MAJOR-2: gate red runs one runner per
 *   invocation and checks the node's complete pinned spec set against that one output, and a subset cannot be selected;
 *   control-pair specs count for their node). An evidence entry is refused by gate red. The check is a NECESSARY
 *   condition only and deliberately has no selector parser: a directory, a glob or an option-shaped reach is refused as
 *   UNPROVEN rather than guessed. Naming is not execution: an entry that names the specs but runs something else
 *   (`node x.mjs --test spec`) passes here and fails closed at gate red;
 * - runner_not_executable: a testCommands cmd that does not resolve to an executable file;
 * - surface_inventory_incomplete: the existing security-plan path pre-scan (inventoryGaps, L4: path-only) of planned writes.
 * Returns the full path signal pre-scan so the plan sees each signal its writes will raise.
 */
export function feasibility({ policy, config, nodes, ticket, repoRoot, riskLabels = [], sp = null, block = null, env }) {
  const labels = new Set([...(config.riskLabels ?? []), ...riskLabels, ...nodes.flatMap(n => n.risk ?? [])]);
  const required = labels.has('ui') ? [`.specs/design-parity/${ticket}.md`] : [];
  const missing = required.filter(a => !policy.artifacts.includes(a));
  if (missing.length) throw coded('required_artifact_outside_contract', `the repository requires ${missing.join(', ')} (design-parity.md, a ui run) but the stage policy does not declare it in artifacts: the first reassess would see it outside the Design Contract (a sticky REAPPROVAL); declare it and re-approve`);
  const tc = config.testCommands ?? {};
  if (!Object.keys(tc).length) throw coded('proof_runner_missing', 'config.testCommands is empty: the local proof at SHIP_READY needs at least one command, so this plan can never ship; declare the proof command and re-approve');
  const inRun = new Set([...Object.keys(tc), ...nodes.flatMap(n => n.checks ?? [])]);
  const runHere = policy.deferred.filter(d => inRun.has(policy.rows.find(r => r.id === d.row).check));
  if (runHere.length) throw coded('stage_deferral_invalid', `deferred row(s) ${runHere.map(d => d.row).join(', ')} name a check this run executes (config.testCommands or a node check): a current-stage control is never deferred`);
  const eligible = Object.values(tc).filter(e => e.format && e.evidence === undefined && executable(e.cmd, repoRoot, env));
  const pinned = new Map();
  const pin = (node, file) => pinned.set(node, new Set([...(pinned.get(node) ?? []), file]));
  for (const n of nodes) for (const s of n.redSpecs ?? []) pin(n.id, typeof s === 'string' ? s : s.file);
  for (const c of config.controlCoverage ?? []) for (const s of c.specs) pin(c.node, s.file);
  const unnamed = [...pinned].filter(([, set]) => !eligible.some(e => [...set].every(f => (e.args ?? []).includes(f))));
  if (unnamed.length) throw coded('red_runner_missing', `no ONE formatted, non-evidence, executable config.testCommands entry names every RED/proof spec of node(s) ${unnamed.map(([id, set]) => `${id} (${[...set].sort().join(', ')})`).join('; ')} verbatim as arguments (gate red runs one runner per invocation; directory, glob and option reach are unproven): a designed harness is needed before approval`);
  const notExec = Object.entries(tc).filter(([, e]) => !executable(e.cmd, repoRoot, env)).map(([k, e]) => `${k} (${e.cmd})`);
  if (notExec.length) throw coded('runner_not_executable', `config.testCommands ${notExec.join(', ')} does not resolve to an executable file`);
  if (!sp) return { signal_prescan: [] };
  const writes = [...new Set(nodes.flatMap(n => n.writes ?? []).filter(w => /.\.[A-Za-z0-9]+$/.test(w.split('/').pop())))].sort();
  const gaps = sp.inventoryGaps({ files: writes, surfacePaths: (block?.surfaces ?? []).map(s => s.path) });
  if (gaps.length) throw coded('surface_inventory_incomplete', `DAG-written path(s) raise a surface signal but no §3a surface lists them: ${gaps.map(g => `${g.path} (${g.kinds.join(', ')})`).join('; ')}`);
  const by = new Map();
  for (const s of sp.reassessSignals({ paths: writes, c5: true })) by.set(s.path, [...(by.get(s.path) ?? []), s.kind]);
  return { signal_prescan: [...by].map(([path, kinds]) => ({ path, kinds: [...new Set(kinds)].sort() })) };
}

/**
 * The state a flagged run records at init. The approved line itself is RETAINED (`policy_line`), so every later load
 * validates the record against run-owned policy and never reads the caller's plan (a foreign-worktree sweep stays safe).
 * One OPEN obligation per deferred row, keyed by row.
 */
export function initialStage(policy) {
  return { version: 1, policy_line: policy.policy_line, policy_digest: policy.policy_digest, merge_stage: policy.merge_stage, stages: policy.stages,
    artifacts: policy.artifacts,
    obligations: policy.deferred.map(d => ({ row: d.row, check: policy.rows.find(r => r.id === d.row).check, verified_through: policy.merge_stage, deferred_stage: d.stage,
      environment: d.environment, subject: d.subject, required_evidence: d.required_evidence, trigger: d.trigger ?? null, tracker_ref: d.tracker_ref ?? null,
      candidate: null, base: null, generation: null, status: 'open', lineage: [] })) };
}

/** The retained, run-owned stage policy (parsed from S.stage.policy_line; load has already validated the record against it). */
export const retainedStagePolicy = (S) => parseStagePolicy(S.stage.policy_line);

/**
 * At SHIP_READY: bind every obligation to (candidate, base, generation). A different candidate than the bound one RE-BINDS
 * it, keyed by row, with a lineage entry; it stays open (nothing here ever verifies it). Returns the fields SHIP_READY
 * carries: it covers the merge stage only. `generation` is the succession seam (PR-4b: `S.succession.g`); 0 on main.
 * On a same-candidate re-run only `base` and generation move, with no lineage entry, as S.ship_ready.base does.
 */
export function shipStage(S, candidate, base) {
  const st = S.stage, generation = S.succession?.g ?? 0;
  for (const o of st.obligations) {
    if (o.candidate !== null && o.candidate !== candidate)
      o.lineage.push({ from: o.candidate, to: candidate, from_base: o.base, to_base: base ?? null, generation, seq: S.seq });
    o.candidate = candidate; o.base = base ?? null; o.generation = generation;
  }
  return { verified_through: st.merge_stage, obligations_open: st.obligations.map(o => o.row) };
}

const IMMUTABLE = ['row', 'check', 'verified_through', 'deferred_stage', 'environment', 'subject', 'required_evidence', 'trigger', 'tracker_ref'];
const OB_KEYS = [...IMMUTABLE, 'candidate', 'base', 'generation', 'status', 'lineage'].sort().join();
/**
 * On EVERY load, against the RETAINED run-owned line (never the caller's plan): the stage record must be the one that line
 * derives (version, digest, merge stage, stages, artifacts, each obligation's immutable fields, in order), every status is
 * `open` (no Factory path writes another) and lineage is well-formed. Returns a refusal reason, or null. Shape only (D1).
 */
export function stageStateRefusal(S) {
  const st = S.stage;
  if (!isObj(st) || typeof st.policy_line !== 'string') return 'S.stage carries no retained policy line';
  let policy;
  try { policy = parseStagePolicy(st.policy_line); } catch (e) { return `the retained stage policy does not parse (${e.code ?? e.message})`; }
  const want = initialStage(policy);
  if (Object.keys(st).sort().join() !== Object.keys(want).sort().join()) return 'S.stage has missing or extra fields';
  for (const k of ['version', 'policy_line', 'policy_digest', 'merge_stage', 'stages', 'artifacts'])
    if (canon(st[k]) !== canon(want[k])) return `S.stage.${k} is not the retained policy's`;
  if (!Array.isArray(st.obligations) || st.obligations.length !== want.obligations.length) return 'S.stage.obligations is not the approved set (missing or added)';
  for (const [i, o] of st.obligations.entries()) {
    const w = want.obligations[i];
    if (!isObj(o) || Object.keys(o).sort().join() !== OB_KEYS) return `obligation ${i} has missing or extra fields`;
    const edited = IMMUTABLE.filter(k => canon(o[k]) !== canon(w[k]));
    if (edited.length) return `obligation ${w.row}: ${edited.join(', ')} differ(s) from the approved policy`;
    if (o.status !== 'open') return `obligation ${w.row}: status ${J(o.status)}; the Factory never closes an obligation (its tracker follow-up does)`;
    if (!Array.isArray(o.lineage) || !o.lineage.every(l => isObj(l) && str(l.from) && str(l.to))) return `obligation ${w.row}: lineage is malformed`;
  }
  return null;
}

/** verifyBinding (owner commands, which read the owner's plan): the retained line must be exactly the approved narrative's single visible stage line. */
export function stageBindingRefusal(S, narrative) {
  let p;
  try { p = parseStagePolicy(narrative); } catch (e) { return `the approved stage line does not parse (${e.code})`; }
  return p.policy_line === S.stage.policy_line ? null : 'the retained stage policy line is not the approved narrative\'s';
}
