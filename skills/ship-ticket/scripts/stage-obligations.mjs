/**
 * STAB S4 (P6): stage obligations and plan feasibility. Opt-in by `config.stagePolicy: { version: 1 }` (bound by the
 * DAG digest); the stage policy itself is ONE `stage-policy-v1: <json>` line of the approved narrative, so the plan
 * digest the owner approved carries every stage and every deferral (no DAG field and no gate input carries one).
 * PROVISIONAL (not stress-tested in R4/R5) and UNQUALIFIED: no run is activated by this change.
 *
 * Replaces, for a flagged run only (§6.1 P6 rows; every other run keeps the frozen semantics):
 * - `references/ship.md:102-114`, the `SECURITY_WAIVER boundary:"plan-3b"` route for a 3b row whose stage does not
 *   exist in the run: such a row is declared deferred and becomes an OPEN OBLIGATION. It is never a waiver, never
 *   `verified` by SHIP_READY, and SHIP_READY covers the merge stage only. The policy TEXT of ship.md:102-114,
 *   plan.md:411-420 and security-risk.md §5 is unchanged (owner approval pending, see IMPL-S4-REPORT.md).
 * - the narrow `preflight` scope (`run-engine.mjs` preflight: schema, ordering, security binding): plus required
 *   artifacts, declared stages, RED and proof runners, and a path signal pre-scan of planned writes. The same checks
 *   run at init, so an unpreflighted infeasible plan is refused there too.
 *
 * Factory recording does NOT enforce deployment. An open obligation stops nothing outside this run until the deploy
 * boundary (for example a hosted `production` deployment environment) consumes it; the tracker/trigger is how it surfaces.
 * The engine writes no authority event: OBLIGATION_VERIFIED is evidence (no authorized_by), never acceptance.
 */
import { accessSync, statSync, constants } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.trim().length > 0;
const J = JSON.stringify;
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map(k => `${J(k)}:${canon(v[k])}`).join(',')}}` : J(v));

export const STAGE_LINE = 'stage-policy-v1: ';
const POLICY_KEYS = ['merge_stage', 'stages', 'rows', 'deferred', 'artifacts', 'no_runtime_boundary'];
const ROW_KEYS = ['id', 'check', 'stage', 'pair'];
const DEFER_KEYS = ['row', 'stage', 'environment', 'subject', 'required_evidence', 'trigger', 'tracker_ref'];
const EVIDENCE_KEYS = ['stage', 'environment', 'subject', 'candidate_id', 'required_evidence', 'result', 'ref', 'summary'];
const PAIR = /^[^:]+:VAPT-[A-Z]+-\d+$/;

export const stageOn = (config) => config?.stagePolicy !== undefined;

/**
 * Parse and validate the approved narrative's stage-policy line (exactly one, at column 1). Refusals:
 * stage_policy_missing, stage_policy_invalid, stage_unavailable (a row whose stage neither exists nor is deferred),
 * stage_deferral_invalid (a deferral of an available stage, the merge stage, another stage than its row's, or a 3a
 * pair: a current-stage control can never be deferred), obligation_trigger_missing (no trigger and no tracker).
 */
export function parseStagePolicy(narrative, { ticket } = {}) {
  const lines = narrative.split(/\r?\n/).filter(l => l.startsWith(STAGE_LINE));
  // R1 MINOR-2: the authorizing line must be one the owner sees: never inside an HTML comment (terminated or not) or a code fence.
  const visible = narrative.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '')
    .split(/\r?\n/).filter(l => l.startsWith(STAGE_LINE));
  if (visible.length !== lines.length) throw coded('stage_policy_invalid', 'a stage-policy line sits inside an HTML comment or a code fence: the approved line must be visible in the rendered plan');
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
  // R1 MINOR-6: `rows` are the verification rows the plan DECLARES here; they are not cross-checked against the §3b table text
  // (no canonical row inventory exists), so a row missing from this line is simply not stage-checked.
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
  if (!Array.isArray(artifacts) || !artifacts.every(a => str(a) && normalSpecs(a) && (!ticket || a !== `.specs/plans/${ticket}.md`))) bad('artifacts: normalized orchestrator-written paths under .specs/ (never the plan itself)');
  if (p.no_runtime_boundary !== undefined && typeof p.no_runtime_boundary !== 'boolean') bad('no_runtime_boundary must be a boolean');
  return { merge_stage: p.merge_stage, stages: [...p.stages], rows: [...rows.values()], deferred: [...deferred.values()], artifacts: [...artifacts], no_runtime_boundary: p.no_runtime_boundary === true,
    policy_digest: sha(canon(p)) };
}
// R1 MINOR-3: exact paths only (no glob character), so an artifact never widens the Design Contract beyond itself.
const normalSpecs = (p) => !/[\\*?[\]{}!]/.test(p) && p.startsWith('.specs/') && p.split('/').every(s => s && s !== '.' && s !== '..');

/** Glob match (`*` one segment, `**` any depth), the reassess Design Contract dialect. */
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Whether `cmd` resolves to an executable regular file (a path relative to the repository root, an absolute path, or a PATH entry). */
function executable(cmd, root, env = process.env) {
  const ok = (p) => { try { if (!statSync(p).isFile()) return false; accessSync(p, constants.X_OK); return true; } catch { return false; } };
  if (isAbsolute(cmd)) return ok(cmd);
  if (cmd.includes('/')) return ok(join(root, cmd));
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some(d => ok(join(d, cmd)));
}

/**
 * The plan-feasibility checks preflight AND init run for a flagged run (refusals thrown as coded errors):
 * required_artifact_outside_contract (a repository-required artifact, today the design-parity artifact of a `ui` run,
 * is not declared in `artifacts`; a node can never write under .specs/), red_runner_missing (a RED or pair spec that no
 * formatted runner command reaches by a file, directory or glob argument),
 * runner_not_executable (a testCommands cmd that does not resolve to an executable file). `inventoryGaps` is the
 * security-plan pre-scan (path-only, L4): its surface gaps are refused for every block format, and the whole path
 * pre-scan is returned so the plan sees each signal its writes will raise.
 */
export function feasibility({ policy, config, nodes, ticket, repoRoot, riskLabels = [], sp = null, block = null, env }) {
  const labels = new Set([...(config.riskLabels ?? []), ...riskLabels, ...nodes.flatMap(n => n.risk ?? [])]);
  const required = labels.has('ui') ? [`.specs/design-parity/${ticket}.md`] : [];
  const missing = required.filter(a => !policy.artifacts.includes(a));
  if (missing.length) throw coded('required_artifact_outside_contract', `the repository requires ${missing.join(', ')} (design-parity.md, a ui run) but the stage policy does not declare it in artifacts: the first reassess would see it outside the Design Contract (a sticky REAPPROVAL); declare it and re-approve`);
  const tc = config.testCommands ?? {};
  // A check the engine itself runs in this run (a testCommands entry or a node check) is a current-stage control: never deferred.
  const inRun = new Set([...Object.keys(tc), ...nodes.flatMap(n => n.checks ?? [])]);
  const runHere = policy.deferred.filter(d => inRun.has(policy.rows.find(r => r.id === d.row).check));
  if (runHere.length) throw coded('stage_deferral_invalid', `deferred row(s) ${runHere.map(d => d.row).join(', ')} name a check this run executes (config.testCommands or a node check): a current-stage control is never deferred`);
  const formatted = Object.keys(tc).filter(k => tc[k].format);
  const specs = [...new Set([...nodes.flatMap(n => (n.redSpecs ?? []).map(s => (typeof s === 'string' ? s : s.file))),
    ...(config.controlCoverage ?? []).flatMap(c => c.specs.map(s => s.file))])].sort();
  // R1 (Codex 4): coverage is derived from the COMMAND, never declared: a formatted entry reaches a spec only when one of its
  // non-option arguments names that file, a directory holding it, or a glob matching it (gate red runs cmd + args as given).
  const reaches = (f) => formatted.some(k => (tc[k].args ?? []).filter(a => !a.startsWith('-')).map(a => a.replace(/^\.\//, '').replace(/\/+$/, ''))
    .some(a => a === f || f.startsWith(a + '/') || (/[*?]/.test(a) && globRe(a).test(f))));
  const uncovered = specs.filter(f => !reaches(f));
  if (uncovered.length) throw coded('red_runner_missing', `no formatted config.testCommands entry's command reaches RED/proof spec(s) ${uncovered.join(', ')} (by file, directory or glob argument): a designed harness is needed before approval`);
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

/** The state a flagged run records at init: the policy digest and one OPEN obligation per deferred row (never verified). */
export function initialStage(policy) {
  return { version: 1, policy_digest: policy.policy_digest, merge_stage: policy.merge_stage, stages: policy.stages, artifacts: policy.artifacts,
    no_runtime_boundary: policy.no_runtime_boundary,
    obligations: policy.deferred.map(d => ({ row: d.row, check: policy.rows.find(r => r.id === d.row).check, verified_through: policy.merge_stage, deferred_stage: d.stage,
      environment: d.environment, subject: d.subject, required_evidence: d.required_evidence, trigger: d.trigger ?? null, tracker_ref: d.tracker_ref ?? null,
      candidate: null, base: null, generation: null, status: 'open', evidence: null, lineage: [] })) };
}

/**
 * At SHIP_READY: bind every obligation to (candidate, base, generation). A different candidate than the bound one
 * RE-BINDS it (lineage entry kept); a verified obligation whose evidence was for the old candidate REOPENS (its
 * evidence names another candidate). Returns the fields SHIP_READY carries: it covers the merge stage only.
 * `generation` is S3's `S.succession.g` when present (0 otherwise): the S3 seam, read without importing S3 code.
 */
export function shipStage(S, candidate, base) {
  const st = S.stage, generation = S.succession?.g ?? 0;
  for (const o of st.obligations) {
    if (o.candidate !== null && o.candidate !== candidate) {
      const reopened = o.status === 'verified';
      o.lineage.push({ from: o.candidate, to: candidate, from_base: o.base, to_base: base ?? null, generation, reopened, seq: S.seq });
      if (reopened) { o.status = 'open'; o.evidence = null; }
    }
    o.candidate = candidate; o.base = base ?? null; o.generation = generation;
  }
  // NIT-4: on a same-candidate re-run only `base` (and generation) move, with no lineage entry, as S.ship_ready.base does.
  return { verified_through: st.merge_stage, obligations_open: st.obligations.filter(o => o.status === 'open').map(o => o.row) };
}

/**
 * Record new evidence for a deferred stage. Refusals (nothing written): obligation_unknown, obligation_unbound (no
 * SHIP_READY bound it to a candidate yet), obligation_already_verified, obligation_evidence_missing (not exactly
 * { stage, environment, subject, candidate_id, ref, summary } of non-empty strings), obligation_evidence_mismatch (another
 * stage, environment, subject or candidate than the obligation's), obligation_evidence_reused (the same evidence
 * record already verified an obligation). Returns the event to append (evidence only: no authorized_by).
 */
export function verifyObligation(S, row, evidence) {
  const o = S.stage.obligations.find(x => x.row === row);
  if (!o) throw coded('obligation_unknown', `no obligation for row ${row}: obligations come only from the approved stage policy`);
  if (o.candidate === null) throw coded('obligation_unbound', `obligation ${row} is not bound to a candidate yet (SHIP_READY binds it)`);
  if (o.status === 'verified') throw coded('obligation_already_verified', `obligation ${row} is verified for ${o.candidate}`);
  if (!isObj(evidence) || Object.keys(evidence).length !== EVIDENCE_KEYS.length || !EVIDENCE_KEYS.every(k => str(evidence[k])) || !['pass', 'fail'].includes(evidence.result))
    throw coded('obligation_evidence_missing', `evidence is exactly { ${EVIDENCE_KEYS.join(', ')} } of non-empty strings, result 'pass' or 'fail'`);
  const off = ['stage', 'environment', 'subject', 'required_evidence'].filter(k => evidence[k] !== o[k === 'stage' ? 'deferred_stage' : k]);
  if (evidence.candidate_id !== o.candidate) off.push('candidate_id');
  if (off.length) throw coded('obligation_evidence_mismatch', `evidence ${off.join(', ')} differ(s) from obligation ${row} (${o.deferred_stage} / ${o.environment} / ${o.subject} / ${o.required_evidence} / ${o.candidate})`);
  // R1 (Codex 5): a reported failure never verifies; the evidence identity is its ref (the run, job or record it names), not its free text.
  if (evidence.result !== 'pass') throw coded('obligation_evidence_failed', `evidence ${evidence.ref} reports result ${evidence.result}: obligation ${row} stays open`);
  const ref = evidence.ref.trim();
  if (S.stage.obligations.some(x => x.evidence?.ref_id === ref)) throw coded('obligation_evidence_reused', `evidence ref ${ref} already verified an obligation`);
  const digest = sha(canon(evidence));
  o.status = 'verified';
  o.evidence = { ...evidence, digest, ref_id: ref, seq: S.seq };
  return { event: 'OBLIGATION_VERIFIED', row, deferred_stage: o.deferred_stage, candidate_id: o.candidate, evidence_digest: digest, ref: evidence.ref };
}

const RS_BEGIN = '<!-- RUN-STATE:BEGIN -->', RS_END = '<!-- RUN-STATE:END -->';
/** The approved narrative of a plan text: the RUN-STATE body removed (it is never approved content). */
const narrativeOf = (text) => { const b = text.indexOf(RS_BEGIN), e = text.indexOf(RS_END); return b >= 0 && e > b ? text.slice(0, b) + text.slice(e) : text; };

/**
 * R1 (Codex 3): the approved stage policy re-read from the plan for gate reassess: `no_runtime_boundary` and `artifacts` come
 * from the approved line, never from the mutable state record.
 */
export function reassessStagePolicy(planText, ticket) {
  const p = parseStagePolicy(narrativeOf(planText), { ticket });
  return { no_runtime_boundary: p.no_runtime_boundary, artifacts: p.artifacts };
}

const IMMUTABLE = ['row', 'check', 'verified_through', 'deferred_stage', 'environment', 'subject', 'required_evidence', 'trigger', 'tracker_ref'];
const OB_KEYS = [...IMMUTABLE, 'candidate', 'base', 'generation', 'status', 'evidence', 'lineage'].sort().join();
/**
 * R1 (Codex 1): on EVERY load, the stage record must be the one the approved policy derives: version, digest, merge stage,
 * stages, artifacts, no_runtime_boundary and each obligation's immutable fields, in order (none missing, added or edited).
 * The mutable part is checked for shape: status open (evidence null) or verified (evidence of this candidate with an
 * identity), lineage an array. Returns a refusal reason, or null.
 */
export function stageStateRefusal(S, planText, ticket) {
  let policy;
  try { policy = parseStagePolicy(narrativeOf(planText ?? ''), { ticket }); } catch (e) { return `the approved stage policy does not parse (${e.code ?? e.message})`; }
  const want = initialStage(policy), st = S.stage;
  if (!isObj(st)) return 'S.stage is not an object';
  for (const k of ['version', 'policy_digest', 'merge_stage', 'stages', 'artifacts', 'no_runtime_boundary'])
    if (canon(st[k]) !== canon(want[k])) return `S.stage.${k} is not the approved policy's`;
  if (Object.keys(st).sort().join() !== Object.keys(want).sort().join()) return 'S.stage has missing or extra fields';
  if (!Array.isArray(st.obligations) || st.obligations.length !== want.obligations.length) return 'S.stage.obligations is not the approved set (missing or added)';
  for (const [i, o] of st.obligations.entries()) {
    const w = want.obligations[i];
    if (!isObj(o) || Object.keys(o).sort().join() !== OB_KEYS) return `obligation ${i} has missing or extra fields`;
    const edited = IMMUTABLE.filter(k => canon(o[k]) !== canon(w[k]));
    if (edited.length) return `obligation ${w.row}: ${edited.join(', ')} differ(s) from the approved policy`;
    if (!Array.isArray(o.lineage)) return `obligation ${w.row}: lineage is not an array`;
    if (o.status === 'open') { if (o.evidence !== null) return `obligation ${w.row}: open with evidence`; }
    else if (o.status === 'verified') {
      if (!isObj(o.evidence) || o.candidate === null || o.evidence.candidate_id !== o.candidate || o.evidence.result !== 'pass' || !str(o.evidence.ref_id) || !str(o.evidence.digest))
        return `obligation ${w.row}: verified without pass evidence of its bound candidate`;
    } else return `obligation ${w.row}: unknown status ${J(o.status)}`;
  }
  return null;
}

