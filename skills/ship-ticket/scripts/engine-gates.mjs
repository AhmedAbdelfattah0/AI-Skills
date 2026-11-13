/**
 * Gate decisions recorded by `run-engine.mjs gate red|review|ship-ready|unit-review` under the engine lock
 * (unit-review: engine-unit-review.mjs).
 * The engine derives everything that binds: the candidate (pinned exclusions), the RED runner,
 * its format and resources (from the bound DAG), the frozen candidate and retry authorization (a
 * RUN-STATE RETRY event), the builder roster, the repair it enqueues, and the local proof (it runs
 * the DAG's testCommands itself). Inputs only select. `E` is run-engine.mjs's command context.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gateRed, gateReview, gateShipReady, specResults } from './gate.mjs';
import * as io from './engine-io.mjs';
import { retire, leaderStart } from './engine-quiesce.mjs';
import { retryEvent, securityEvents, waiverState } from './engine-authority.mjs';
import { note, judgment, pinnedSpecs, redRunner, boundRiskEvidence, clampTimeout, overlap, securityOn, pairKey, auditOn } from './engine-dag.mjs';
import { redChanges, invalidateRed, invalidCause } from './engine-attempts.mjs';
import { runnerDeps, unverified, truncation } from './engine-units.mjs';
import { unitReviewGate, reviewsMissing, unitExecution, unitReviewOn } from './engine-unit-review.mjs';

export const gateNo = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: false, reasons, ...extra });
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/**
 * Opt-in units: a review or ship-ready decision waits until every unit's checks pass on the current
 * binding and, with config.unitReview, until every unit has a current PASS unit review (recomputed).
 */
function unitsRefusal(E) {
  const open = unverified(E);
  if (open.length) return gateNo('units_unverified', [`unit check evidence is not verified: ${open.join(', ')} (drive runs the checks)`]);
  const missing = reviewsMissing(E.S, E.ctx.repoRoot);
  return missing.length ? gateNo('unit_reviews_missing', [`every unit needs a current PASS unit review (gate unit-review): ${missing.join(', ')}`]) : null;
}

/**
 * The final review on top of unit reviews (AIS-HARNESS-3 Wave 3; only with config.unitReview, after
 * unitsRefusal, so every unit is verified with a current PASS): an original must cover every
 * acceptance id mapped on a node with a primary acceptance_criteria row (its `id` when that is an
 * acceptance id, else its `criterion`: one row covers one id), and
 * every review step must name in `units_consumed` each unit exactly once with its current evidence
 * id. Stricter only: it refuses, it never accepts what gateReview would refuse.
 */
function finalReviewRefusal(S, input) {
  if (input.kind === 'original') {
    const rows = Array.isArray(input.primary?.acceptance_criteria) ? input.primary.acceptance_criteria : [];
    // One row covers one id: its `id` when that is an acceptance id, else its `criterion` (never both).
    const ids = new Set(S.config.acceptanceIds ?? []);
    const covered = new Set(rows.map(r => (ids.has(r?.id) ? r.id : r?.criterion)).filter(nonEmpty));
    const missing = [...new Set(Object.values(S.nodes).flatMap(n => n.acceptance ?? []))].sort().filter(id => !covered.has(id));
    if (missing.length) return gateNo('acceptance_uncovered', [`the final review's acceptance_criteria must cover every mapped acceptance id `
      + `(a row whose id, or else criterion, is the id; one row covers one id): missing ${missing.join(', ')}`]);
  }
  return consumedRefusal(S, input.units_consumed, 'the final review');
}

/** `units_consumed_stale` unless `list` names every unit exactly once with its current verified evidence id (else null). */
function consumedRefusal(S, list, who) {
  const units = Object.keys(S.unit_reviews).sort();
  const why = [];
  if (!Array.isArray(list)) why.push('units_consumed must be [{ unit, evidence_id }] naming every unit');
  else {
    for (const c of list) if (!units.includes(c?.unit)) why.push(`unknown unit ${c?.unit}`);
    for (const u of units) {
      const mine = list.filter(c => c?.unit === u), now = S.unit_checks[u].evidence.id;
      if (!mine.length) why.push(`${u}: not consumed (current evidence ${now})`);
      else if (mine.length > 1) why.push(`${u}: named ${mine.length} times`);
      else if (mine[0].evidence_id !== now) why.push(`${u}: consumed evidence ${mine[0].evidence_id} is stale, current is ${now}`);
    }
  }
  return why.length ? gateNo('units_consumed_stale', [`${who} must consume every unit's current verified evidence (status.units.<u>.evidence.id): ${why.join('; ')}`]) : null;
}

/** RED: the node's pinned specs, the DAG runner the input names, the node's resources; baseline = the computed candidate. */
async function redGate(E, input, candidate) {
  const node = E.S.nodes[input.node];
  if (!node) return gateNo('unknown_node', [`no node ${input.node} in the bound DAG`]);
  const runner = redRunner(E.S.config, input.command);
  if (!runner) return gateNo('unknown_command', [`no RED runner ${input.command ?? '(unnamed)'} among the formatted config.testCommands`]);
  // Policy 2: `addendum` names a trusted, effective SECURITY_ADDENDUM; its specs for this node are the pin
  // and the evidence lands in S.gates.red_addendum['<addendum_id>/<node>'] (node RED is untouched).
  let addendumSpecs, slot;
  if (input.addendum !== undefined) {
    const a = securityEvents(E.S).addenda.find(x => x.addendum_id === input.addendum);
    if (!a) return gateNo('spec_unpinned', [`no trusted, effective SECURITY_ADDENDUM ${input.addendum} of this run`]);
    addendumSpecs = a.pairs.filter(p => p.node === node.id).flatMap(p => p.specs);
    slot = { map: 'red_addendum', key: `${a.addendum_id}/${node.id}` };
  }
  const pin = pinnedSpecs(node, input.specs, addendumSpecs);
  if (pin.code) return gateNo(pin.code, [pin.reason]);
  const baseCommit = io.resolveCommit(E.ctx.repoRoot, E.S.config.base ?? 'HEAD');
  const v = await gateRed({ state: E.S, node: node.id, command: { cmd: runner.cmd, args: runner.args ?? [] }, format: runner.format,
    specs: pin.specs, baselineCandidate: candidate, timeoutMs: clampTimeout(E.S.config.timeoutMs), resources: [...node.resources], ...(slot ? { slot } : {}) }, runnerDeps(E));
  E.S = v.state; // gateRed re-verified the binding (deps.verifyBinding) before committing any evidence
  if (v.ok && slot) Object.assign(E.S.gates.red_addendum[slot.key], { command: runner.name, base_commit: baseCommit });
  else if (v.ok) { Object.assign(E.S.gates.red[node.id], { command: runner.name, base_commit: baseCommit }); delete E.S.gates.red_invalid?.[node.id]; }
  const { state: _s, ...out } = v;
  return out;
}

/** RED-bearing nodes whose barrier a ready pending/stale node, or a pending repair, waits on. */
function barrierNeeded(S) {
  const ids = new Set();
  for (const n of Object.values(S.nodes)) if (['pending', 'stale'].includes(n.state) && n.deps.every(d => S.nodes[d].state === 'done')) n.deps.forEach(d => ids.add(d));
  for (const r of S.repairs) if (r.state === 'pending') {
    for (const n of Object.values(S.nodes)) if (n.writes.some(w => r.writes.some(p => overlap(w, p)))) n.deps.forEach(d => ids.add(d));
  }
  return [...ids].filter(d => S.nodes[d].redSpecs.length);
}

/**
 * Before a drive dispatches: RED evidence a waiting node or repair needs that no longer binds (a
 * spec or config.base changed) is invalidated and RED is re-run by the engine with the recorded
 * runner and specs, once per invalidation (RED_RERUN). An accepted re-run is reported as a
 * red_invalidated naming it (the drive stops; the next one dispatches). A refused re-run stays in
 * `S.gates.red_invalid` and `view` reports it on every drive and status until RED is accepted again
 * (`gate red`), or the spec and base are restored to the old evidence's bytes (RED_RESTORED).
 */
export async function refreshRed(E, transient) {
  for (const d of barrierNeeded(E.S)) {
    const ev = E.S.gates.red[d];
    const what = ev && redChanges(E, ev);
    if (what) invalidateRed(E, d, what);
    const inv = E.S.gates.red_invalid?.[d];
    if (!inv) continue;
    if (inv.rerun) {
      if (!redChanges(E, inv.evidence)) { E.S.gates.red[d] = inv.evidence; delete E.S.gates.red_invalid[d]; note(E.S, 'RED_RESTORED', { node: d }); }
      continue;
    }
    const before = E.S.attempts.length;
    const c = io.candidateId(E.ctx.repoRoot, E.S.config.base ?? 'HEAD', E.S.pinned_exclusions);
    const v = c.candidate_id ? await redGate(E, { node: d, command: inv.command, specs: inv.evidence.specs }, c.candidate_id)
      : gateNo('candidate_unavailable', [c.reason]);
    const attempt_id = E.S.attempts.slice(before).find(a => a.kind === 'gate-red')?.attempt_id ?? null;
    note(E.S, 'RED_RERUN', { node: d, attempt_id, ok: v.ok, code: v.code });
    const rerun = { attempt_id, ok: v.ok, code: v.code, reasons: v.reasons ?? [] };
    if (v.ok) transient.push(judgment('red_invalidated', d, `${invalidCause(d, inv)}; the engine re-ran RED (attempt ${attempt_id}): `
      + 'red_accepted; dependents dispatch on the next drive'));
    else E.S.gates.red_invalid[d] = { ...E.S.gates.red_invalid[d], rerun };
    await E.commit();
  }
}

/** red_invalidated judgments for every refused engine re-run of RED (they stay until RED binds again). */
export const redInvalidJudgments = (S) => Object.entries(S.gates?.red_invalid ?? {}).filter(([, inv]) => inv.rerun && !inv.rerun.ok)
  .map(([d, inv]) => judgment('red_invalidated', d, `${invalidCause(d, inv)}; the engine re-ran RED (attempt ${inv.rerun.attempt_id}): `
    + `${inv.rerun.code}${inv.rerun.reasons[0] ? ` (${inv.rerun.reasons[0]})` : ''}. Once dependents implement the specs RED cannot be `
    + 're-established: restore the spec file(s) and config.base to the evidence bytes, or the owner decides'));

/** Node risk labels whose repair needs the second opinion before its targeted confirmation (review.md Targeted confirmation). */
const CONFIRM_SECOND_OPINION = ['concurrency', 'security'];

/**
 * The second-opinion policy of a final-review confirmation of `rx`: 'required' when its repair's
 * write set overlaps a node labelled concurrency or security, else 'optional' (a supplied second
 * opinion is validated and counted, never ignored).
 */
function confirmationPolicy(S, rx) {
  const ws = S.review_chain.findLast(r => r.review_execution === rx && r.kind === 'repair')?.write_set ?? [];
  const risky = Object.values(S.nodes).some(n => (n.risk ?? []).some(l => CONFIRM_SECOND_OPINION.includes(l))
    && [...n.reads, ...n.writes].some(p => ws.some(q => overlap(p, q))));
  // Policy 2: a repair touching any effective pair's spec file needs the second opinion too.
  const pairSpec = securityOn(S) && securityEvents(S).pairs.some(p => p.specs.some(s => ws.some(q => overlap(s.file, q))));
  return risky || pairSpec ? 'required' : 'optional';
}

/**
 * Review: the frozen candidate is the stored one (set by the first original review, a repair, or an
 * authorized retry). A new original after any earlier original needs a RETRY linked to its
 * predecessor. An accepted FAIL enqueues the finding-bound repair from its write set.
 */
async function reviewGate(E, input, candidate) {
  const S = E.S;
  const units = unitsRefusal(E);
  if (units) return units;
  if (unitExecution(S, input.review_execution)) return gateNo('chain_broken', [`review_execution ${input.review_execution} belongs to a unit review chain`]);
  const originals = S.review_chain.filter(r => r.kind === 'original');
  let retry = null;
  if (input.kind === 'original' && originals.length) {
    const predecessor = originals.at(-1).review_execution;
    const found = retryEvent(E.S, input.review_execution, predecessor);
    retry = found.retry;
    if (!retry && found.forged) return gateNo('retry_unauthorized', [`a RETRY for ${input.review_execution} appeared while dispatched work could run, `
      + 'so it is not owner authority; once status shows nothing live, the owner re-appends a distinct RETRY (e.g. with a timestamp)'], { judgment_point: true });
    if (!retry) return gateNo('retry_unauthorized', [`review ${predecessor} already ran; a new original review needs a RUN-STATE RETRY `
      + `{ review_execution: ${input.review_execution}, predecessor: ${predecessor}, authorized_by } (a fresh id alone is refused)`]);
  }
  if (S.freeze && !retry && candidate !== S.freeze.candidate) {
    return gateNo('stale_candidate', [`the work tree is ${candidate}, frozen is ${S.freeze.candidate}: unexpected drift after the freeze`]);
  }
  const frozen = retry || !S.freeze ? candidate : S.freeze.candidate;
  const { units_consumed: consumedUnits, ...review } = input;
  // W3-record: only the bound DAG's config.auditRecord sets recordVerdicts (never an input); absent, the policy is as before.
  const recording = auditOn(S) ? { recordVerdicts: true } : {};
  const v = gateReview({ ...review, state: { ...S, frozen_candidate: frozen, builders: S.builders } },
    input.kind === 'confirmation' ? { confirmationSecondOpinion: confirmationPolicy(S, input.review_execution), ...recording } : { ...recording });
  if (!v.ok) return { judgment_point: false, ...v };
  if (unitReviewOn(S)) {
    const stale = finalReviewRefusal(S, input);
    if (stale) return stale;
    v.record.units_consumed = consumedUnits.map(c => ({ unit: c.unit, evidence_id: c.evidence_id }));
  }
  if (securityOn(S)) {
    const sec = await securityContext(E, candidate);
    const refusal = securityRefusal(sec) ?? reassessRefusal(S, sec) ?? (input.kind === 'original' ? securityRowsRefusal(input.primary, sec) : null);
    if (refusal) return refusal;
    // What this review covered: ship-ready refuses once the catalog or the addendum set moves past it.
    if (input.kind === 'original') v.record.security_coverage = coverageOf(sec);
  }
  const brief = input.repair_prompt_file;
  if (v.repair && !(nonEmpty(brief) && isAbsolute(brief) && existsSync(brief) && statSync(brief).isFile())) {
    return gateNo('repair_prompt_missing', ['an accepted FAIL opens a repair: repair_prompt_file must be the absolute path of its brief']);
  }
  if (retry) {
    S.review_chain.push({ review_execution: input.review_execution, kind: 'retry', predecessor: retry.predecessor, authorized_by: retry.authorized_by });
    for (const r of S.repairs) if (r.review_execution === retry.predecessor && ['pending', 'failed'].includes(r.state)) { r.state = 'cancelled'; r.reason = 'superseded by retry'; }
  }
  S.review_chain.push(v.record);
  if (input.kind === 'original') { S.freeze = { candidate, seq: S.seq ?? 0 }; S.frozen_candidate = candidate; }
  if (v.repair) {
    S.repairs.push({ id: `repair-${v.repair.review_execution}`, kind: 'review', review_execution: v.repair.review_execution,
      writes: [...v.repair.write_set], promptFile: brief, state: 'pending', old_candidate: candidate });
    note(S, 'REPAIR_ENQUEUED', { review_execution: v.repair.review_execution });
  }
  return { judgment_point: false, ...v };
}

/**
 * Run every DAG testCommands entry under the durable runner protocol and return the commands, or
 * `{ refusal }`. A runner reaches 'exited' only through retire() (whole group proven gone);
 * otherwise it stays 'unknown' with a durable quiescence_unknown judgment and nothing is recorded.
 * The caller records LOCAL_PROOF only after re-verifying the binding and the candidate.
 */
async function runProof(E) {
  const run = runnerDeps(E).spawnRunner;
  const commands = [], runs = [];
  for (const [name, c] of Object.entries(E.S.config.testCommands ?? {})) {
    const a = { attempt_id: 'att-' + randomUUID(), kind: 'proof', node: name, status: 'intent', started_at: new Date().toISOString() }; // started_at: telemetry only (eval proof wall)
    E.S.attempts.push(a);
    await E.commit();
    let result;
    try {
      const launch = await run({ attempt_id: a.attempt_id, command: { cmd: c.cmd, args: c.args ?? [] }, timeoutMs: clampTimeout(E.S.config.timeoutMs) });
      Object.assign(a, { pid: launch.pid, pgid: launch.pgid, leader_start: leaderStart(launch.pgid), status: 'running' });
      await E.commit();
      launch.release();
      result = await launch.done;
    } catch (e) { result = { exitCode: null, timedOut: false, error: e.message, quiescent: true }; } // retire() decides
    if (result.quiescent !== true || !(await retire(E.S, a, E.alive, 'exited'))) {
      a.status = 'unknown';
      const reason = `cannot prove proof runner group ${a.pgid ?? a.pid} (${name}) has exited; no local proof recorded`;
      if (!E.S.judgments.some(j => j.code === 'quiescence_unknown' && j.node === name)) E.S.judgments.push(judgment('quiescence_unknown', name, reason));
      await E.commit();
      return { refusal: gateNo('quiescence_unknown', [reason], { judgment_point: true }) };
    }
    a.envelope = { exitCode: result.exitCode, timedOut: result.timedOut, ...truncation(result) };
    // args: an unlocated pass is the spec's only when the command runs exactly that file (gate.mjs soleFile).
    if (c.format) runs.push({ format: c.format, stdout: result.stdout ?? '', truncated: result.truncated === true || result.timedOut === true, args: [...(c.args ?? [])] });
    commands.push({ name, cmd: c.cmd, args: [...(c.args ?? [])], exit_code: result.exitCode,
      result: result.exitCode === 0 && !result.timedOut ? 'pass' : 'fail', ...(result.error ? { error: result.error } : {}) });
  }
  await E.commit();
  // Policy 2 only: the parsed status of every effective pair spec (only pass proves; legacy proof bytes unchanged).
  if (!securityOn(E.S)) return { commands };
  const specs = securityEvents(E.S).pairs.flatMap(p => p.specs);
  return { commands, spec_results: specResults(specs, runs) };
}

const proven = (S, candidate) => S.local_proof?.candidate_id === candidate && S.local_proof.commands.length > 0
  && S.local_proof.commands.every(c => c.result === 'pass');

/**
 * Ship-ready's unit conjuncts: every unit verified with a current PASS review and, with unit
 * reviews, the final record that authorizes ship (the last accepted original or confirmation)
 * still consuming every unit's current evidence (Wave 3 repair). Null when they hold.
 */
function unitShipRefusal(E) {
  const S = E.S, last = S.review_chain.at(-1);
  const units = unitsRefusal(E);
  if (units) return units;
  if (unitReviewOn(S) && last && ['original', 'confirmation'].includes(last.kind)) {
    return consumedRefusal(S, last.units_consumed, `final review ${last.review_execution} (${last.kind}), which authorizes ship,`);
  }
  return null;
}

/** Ship-ready's security conjuncts on one security context (checked before the proof and again after it). */
const shipSecurityRefusal = (S, sec) => securityRefusal(sec) ?? reassessRefusal(S, sec) ?? coverageRefusal(S, sec);

/** Ship-ready: exclusions pinned, artifact digests and red_accepted derived; local proof run by the engine when it is all that is missing. */
async function shipReadyGate(E, input, candidate) {
  const S = E.S;
  const units = unitShipRefusal(E);
  if (units) return units;
  if (input.candidate_id !== undefined && input.candidate_id !== candidate) return gateNo('candidate_mismatch', [`input names ${input.candidate_id}, current is ${candidate}`]);
  // Derived on every call (and again after the proof): red_accepted from the current RED gates (RED can
  // be invalidated between calls) and exists from the work tree (a git-ignored evidence file can go).
  const rebind = () => {
    const list = input.risk_evidence ?? S.risk_evidence;
    if (list !== undefined) S.risk_evidence = boundRiskEvidence(S, list.map(({ kind, path }) => ({ kind, path })), io.evidenceExists(E.ctx.repoRoot));
  };
  rebind();
  let sec = null;
  if (securityOn(S)) {
    sec = await securityContext(E, candidate);
    const refusal = shipSecurityRefusal(S, sec);
    if (refusal) return refusal;
  }
  const current = { candidate_id: candidate, exclusions: input.exclusions ?? S.pinned_exclusions, artifact_digests: io.artifactDigests(E.ctx.repoRoot, input.artifacts),
    ...(sec ? { control_pairs: controlPairs(E, sec, candidate) } : {}) };
  let v = gateShipReady({ state: S, current });
  if (!v.ok && v.reasons.every(r => r === 'missing_local_proof') && !proven(S, candidate)) {
    const { refusal, commands, spec_results } = await runProof(E);
    if (refusal) return refusal;
    // The proof ran repository commands, which can move config.base (an empty commit): forget the base
    // redChanges cached for the pre-proof derivation, so the post-proof control_pairs re-resolve it.
    E.baseCommit = undefined;
    // The proof ran repository commands: the approval binding (excluded plan narrative, DAG bytes) and
    // the candidate must still hold BEFORE a proof bound to the candidate is recorded.
    const unbound = E.verifyBinding();
    if (unbound.length) {
      S.local_proof = { candidate_id: null, commands, seq: S.seq, dropped: unbound.map(j => j.code) };
      return gateNo(unbound[0].code, [`local proof drifted the approval binding: ${unbound.map(j => j.reason).join('; ')}`], { judgment_point: true });
    }
    // ...and the unit evidence must still be fresh: a proof command that moves config.base (e.g. an
    // empty commit) leaves the candidate unchanged but every unit's evidence stale (P5/P12).
    const stale = unitShipRefusal(E);
    if (stale) {
      S.local_proof = { candidate_id: null, commands, seq: S.seq, dropped: [stale.code] };
      return gateNo(stale.code, [`local proof made the unit evidence stale: ${stale.reasons.join('; ')}`]);
    }
    // ...and the tree must be the one the commands ran on: a proof that changed it (codegen, --fix)
    // tested neither tree, so it is bound to none (a RETRY review of the new tree needs a new proof).
    const after = io.candidateId(E.ctx.repoRoot, S.config.base ?? 'HEAD', S.pinned_exclusions);
    if (after.candidate_id !== candidate) {
      S.local_proof = { candidate_id: null, commands, seq: S.seq, dropped: ['candidate_mismatch'] };
      return gateNo('candidate_mismatch', [`local proof changed the work tree: ${candidate} -> ${after.candidate_id ?? after.reason}`]);
    }
    // ...and the security decision must still hold: a proof command can rewrite the installed catalog or append
    // RUN-STATE lines, so the pre-proof context is re-derived and its three refusals rerun before anything binds.
    if (sec) {
      sec = await securityContext(E, candidate); // post-proof security context
      const moved = shipSecurityRefusal(S, sec);
      if (moved) {
        S.local_proof = { candidate_id: null, commands, seq: S.seq, dropped: [moved.code] };
        return moved;
      }
    }
    S.local_proof = { candidate_id: candidate, commands, seq: S.seq, ...(spec_results ? { spec_results } : {}) };
    if (sec) current.control_pairs = controlPairs(E, sec, candidate);
    // Git-ignored artifacts and evidence are outside the candidate id: re-derive them from what the proof left.
    rebind();
    current.artifact_digests = io.artifactDigests(E.ctx.repoRoot, input.artifacts);
    note(S, 'LOCAL_PROOF', { candidate_id: candidate, passed: commands.length > 0 && commands.every(c => c.result === 'pass') });
    v = gateShipReady({ state: E.S, current });
  }
  if (v.ok && S.ship_ready?.candidate_id !== candidate) {
    note(S, 'SHIP_READY', { candidate_id: candidate });
    S.ship_ready = { candidate_id: candidate, seq: S.seq };
    S.outbox.push({ run_id: S.run_id, event: 'SHIP_READY', event_id: 'ship-ready-' + candidate, candidate_id: candidate, timestamp: new Date().toISOString() });
  }
  return { judgment_point: false, ...v };
}

// ---- security policy 2 (AIS-HARNESS-4 Wave B) ----------------------------------------------------

let securityPlanModule = null;
/** security-plan.mjs, loaded only by policy-2 paths (a legacy run never touches the catalog machinery). */
export const securityPlan = async () => (securityPlanModule ??= await import('./security-plan.mjs'));
/** loadCatalog options: the installed catalog, or ctx.catalogFile (an in-process test seam; no CLI flag). */
export const catalogOptions = (ctx) => (ctx.catalogFile ? { catalogPath: ctx.catalogFile } : {});

/**
 * Everything a policy-2 decision on `candidate` reads, re-derived per call: the installed catalog, the
 * effective pairs (DAG coverage + trusted addenda), the waivers of this candidate and the freshness
 * tuple (candidate, approved plan digest, catalog digest, effective addendum set).
 */
export async function securityContext(E, candidate) {
  const sp = await securityPlan();
  const catalog = sp.loadCatalog(catalogOptions(E.ctx));
  const events = securityEvents(E.S);
  const { waived, unauthorized } = waiverState(E.S, events, candidate);
  const tuple = { candidate_id: candidate, plan_digest: E.S.plan_digest, catalog_digest: catalog.ok ? catalog.digest : null,
    addendum_set: events.addenda.map(a => a.addendum_id).sort() };
  return { sp, catalog, events, waived, unauthorized, tuple };
}
const coverageOf = (sec) => ({ catalog_digest: sec.tuple.catalog_digest, addendum_set: [...sec.tuple.addendum_set] });
const sameTuple = (a, b) => Boolean(a) && ['candidate_id', 'plan_digest', 'catalog_digest'].every(k => a[k] === b[k])
  && JSON.stringify(a.addendum_set) === JSON.stringify(b.addendum_set);

/** Policy-2 event problems every security decision refuses on (judgment points: the owner resolves them). */
export function securityRefusal(sec) {
  const jp = { judgment_point: true };
  if (!sec.catalog.ok) return gateNo('catalog_unavailable', [`the control catalog is unavailable (${sec.catalog.code}): ${(sec.catalog.reasons ?? []).join('; ')}`], jp);
  const { conflicts, outside, forged, addenda } = sec.events;
  if (conflicts.length) return gateNo('addendum_conflict', conflicts.map(c => `${c.addendum_id}: ${c.reason}`), jp);
  if (outside.length) return gateNo('addendum_outside_contract', outside.map(c => `${c.addendum_id}: ${c.reason} (WAIT_FOR_USER: re-approve the plan)`), jp);
  const trustedIds = new Set(addenda.map(a => a.addendum_id));
  const open = forged.addenda.filter(e => !trustedIds.has(e.addendum_id));
  if (open.length) return gateNo('addendum_required', open.map(e => `SECURITY_ADDENDUM ${e.addendum_id} appeared while dispatched work could run, so it is not owner `
    + 'authority and adds nothing; once status shows nothing live, the owner re-appends it as a distinct line'), jp);
  if (sec.unauthorized.length) return gateNo('waiver_unauthorized', sec.unauthorized.map(k => `a SECURITY_WAIVER of ${k} appeared while dispatched work could run: `
    + 'not owner authority; once nothing is live the owner re-appends a distinct line'), jp);
  return null;
}

/** The recorded reassessment must be of exactly this tuple (gate reassess records it). */
export function reassessRefusal(S, sec) {
  const r = S.security?.reassessed;
  if (sameTuple(r, sec.tuple)) return null;
  const parts = !r ? ['no reassessment recorded'] : ['candidate_id', 'plan_digest', 'catalog_digest', 'addendum_set']
    .filter(k => JSON.stringify(r[k]) !== JSON.stringify(sec.tuple[k])).map(k => `${k} changed since the reassessment`);
  return gateNo('reassess_stale', [`run gate reassess on the current candidate first: ${parts.join(', ')}`]);
}

/** Ship-ready: the original review behind the authorizing record must have covered the current catalog and addenda. */
export function coverageRefusal(S, sec) {
  const chain = S.review_chain, last = chain.at(-1);
  if (!last || !['original', 'confirmation'].includes(last.kind) || last.outcome !== 'PASS') return null; // gateShipReady: review_not_accepted
  const original = chain.find(r => r.review_execution === last.review_execution && r.kind === 'original');
  if (JSON.stringify(original?.security_coverage) === JSON.stringify(coverageOf(sec))) return null;
  return gateNo('security_review_stale', [`review ${last.review_execution} covered ${JSON.stringify(original?.security_coverage ?? null)}, now `
    + `${JSON.stringify(coverageOf(sec))}: an addendum or a catalog change needs a new independent review (an owner RETRY)`]);
}

/**
 * An original review under policy 2: exactly one primary rule_row per effective pair, subject_id
 * '<boundary>:<control>'; NOT_APPLICABLE only for a waived pair; security_outcome NOT_TRIGGERED only
 * when every effective pair is waived.
 */
export function securityRowsRefusal(p, sec) {
  const rows = p.rule_rows, keys = sec.events.pairs.map(pairKey);
  const wrong = keys.map(k => [k, rows.filter(r => r.subject_id === k).length]).filter(([, n]) => n !== 1);
  if (wrong.length) return gateNo('incomplete_contract', wrong.map(([k, n]) => `primary.rule_rows must hold exactly one row with subject_id ${k} (found ${n})`));
  const escape = keys.filter(k => rows.find(r => r.subject_id === k).outcome === 'NOT_APPLICABLE' && !sec.waived.includes(k));
  if (escape.length) return gateNo('security_row_escape', escape.map(k => `${k}: NOT_APPLICABLE needs a trusted SECURITY_WAIVER for this candidate`));
  if (p.security_outcome === 'NOT_TRIGGERED' && keys.some(k => !sec.waived.includes(k)))
    return gateNo('security_outcome_escape', ['security_outcome NOT_TRIGGERED while unwaived security pairs are effective']);
  return null;
}

/**
 * Per effective, unwaived pair: proven when its RED slot (node RED, or the addendum's) holds every
 * pair spec exactly, the RED still binds (no spec rewritten, base unmoved: the placeholder-file
 * guard), and this candidate's local proof shows each spec 'pass'.
 */
function controlPairs(E, sec, candidate) {
  const S = E.S;
  const results = S.local_proof?.candidate_id === candidate ? S.local_proof.spec_results ?? [] : [];
  return sec.events.pairs.filter(p => !sec.waived.includes(pairKey(p))).map(p => {
    const ev = p.addendum ? S.gates.red_addendum?.[`${p.addendum}/${p.node}`] : S.gates.red?.[p.node];
    const red = Boolean(ev) && p.specs.every(s => (ev.specs ?? []).some(x => x.file === s.file && x.name === s.name)) && !redChanges(E, ev);
    const pass = p.specs.every(s => results.some(r => r.file === s.file && r.name === s.name && r.status === 'pass'));
    return { boundary: p.boundary, control: p.control, proven: red && pass };
  });
}

/**
 * Added lines per file of a `git diff` text: Map(path -> lines). Header state per file: `diff --git`
 * starts a file, `--- ` arms its header, and `+++ ` is the file header only while armed (after `--- `,
 * before the file's first `@@`); inside a hunk every '+' line is an added line, even one that reads
 * `+++ ` (an added source line starting with '++ ').
 */
export function addedLinesByFile(text) {
  const added = new Map();
  let cur = null, armed = false, inHunk = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) { cur = null; armed = false; inHunk = false; continue; }
    if (!inHunk && l.startsWith('--- ')) { armed = true; continue; }
    if (armed && l.startsWith('+++ ')) {
      armed = false;
      cur = l.startsWith('+++ b/') ? l.slice(6) : null;
      if (cur !== null && !added.has(cur)) added.set(cur, []);
      continue;
    }
    if (l.startsWith('@@')) { inHunk = true; armed = false; continue; }
    if (inHunk && cur !== null && l.startsWith('+')) added.get(cur).push(l.slice(1));
  }
  return added;
}

const MAX_ADDED_BYTES = 1024 * 1024;
/** The candidate's changed paths with their added lines (git diff from config.base; an unlisted path is read whole: more signals, never fewer). */
function changedFiles(E, paths) {
  const root = E.ctx.repoRoot, added = new Map();
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U0', E.S.config.base ?? 'HEAD', '--'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
  if (r.status === 0) for (const [p, lines] of addedLinesByFile(r.stdout)) added.set(p, lines);
  return paths.map(p => {
    if (added.has(p)) return { path: p, added: added.get(p) };
    try { const b = readFileSync(join(root, p)); return { path: p, added: b.length <= MAX_ADDED_BYTES ? b.toString('utf8').split(/\r?\n/) : [] }; }
    catch { return { path: p, added: [] }; }
  });
}

/**
 * The Design Contract of `nodes` (an array): every node's writes, each a file or a directory (`w` and
 * `w/**`), as security-plan.mjs reassess matches changed and surface paths against it. The one derivation
 * shared by gate reassess and init (bindSecurity); a DAG with no writes gets a contract nothing matches.
 */
export function designContract(nodes) {
  const contract = [...new Set(nodes.flatMap(n => n.writes.flatMap(w => [w, `${w}/**`])))].sort();
  return contract.length ? contract : ['\u0000no-design-contract'];
}

/**
 * gate reassess (policy 2): security-plan.mjs reassess over the candidate's changed files (paths and
 * added lines), the Design Contract (designContract of the DAG nodes), the input `surfaces` (a new
 * boundary the change introduces; reassess unites them with the approved §3a block's) and the trusted
 * addenda. UNCHANGED records S.security.reassessed (the freshness tuple) and a
 * SECURITY_REASSESSED event; an unclassified signal -> reassess_unclassified; ADD_CONTROLS not yet
 * covered by a trusted addendum -> addendum_required (with the suggested addendum); REAPPROVAL ->
 * S.security.reapproval, a judgment that stops drive and every gate (verifyBinding).
 */
async function reassessGate(E, input, candidate) {
  const S = E.S;
  const sec = await securityContext(E, candidate);
  const refusal = securityRefusal(sec);
  if (refusal) return refusal;
  const plan = io.readIfExists(E.P.plan) ?? '';
  // The input surfaces pass straight through: reassess unites them with the approved ones (an identical one is
  // that surface; one that redefines an approved boundary id is refused bad_input; one outside the Design
  // Contract is a REAPPROVAL basis).
  const res = sec.sp.reassess({ plan, catalog: sec.catalog, inventory: { candidate_id: candidate, surfaces: input.surfaces ?? [] },
    changed: { contract_paths: designContract(Object.values(S.nodes)), files: changedFiles(E, E.candidatePaths ?? []) },
    classifications: input.classifications ?? [], addenda: sec.events.addenda.map(a => ({ pairs: a.pairs.map(pairKey) })) });
  if (!res.ok) {
    if (res.code === 'classification_missing') return gateNo('reassess_unclassified', res.reasons, { unclassified: res.unclassified ?? [], signals: res.signals ?? [] });
    if (['plan_block_missing', 'plan_block_invalid'].includes(res.code)) return gateNo('security_pairs_mismatch', res.reasons, { judgment_point: true });
    if (['catalog_missing', 'catalog_invalid'].includes(res.code)) return gateNo('catalog_unavailable', res.reasons, { judgment_point: true });
    return gateNo(res.code, res.reasons ?? []);
  }
  S.security ??= {};
  if (res.outcome === 'REAPPROVAL') {
    S.security.reapproval = { candidate_id: candidate, basis: res.reapproval_basis, seq: S.seq ?? 0 };
    note(S, 'SECURITY_REAPPROVAL', { candidate_id: candidate });
    return gateNo('security_reapproval', res.reasons, { judgment_point: true, outcome: res.outcome, reapproval_basis: res.reapproval_basis });
  }
  if (res.outcome === 'ADD_CONTROLS') return gateNo('addendum_required', res.delta_pairs.map(p => `${p}: not in an effective pair or a trusted SECURITY_ADDENDUM`),
    { judgment_point: true, outcome: res.outcome, delta_pairs: res.delta_pairs, addendum: res.addendum });
  note(S, 'SECURITY_REASSESSED', { candidate_id: candidate, outcome: res.outcome });
  S.security.reassessed = { ...sec.tuple, outcome: res.outcome, seq: S.seq };
  S.outbox.push({ run_id: S.run_id, event: 'SECURITY_REASSESSED', event_id: `security-reassessed-${S.run_id}-${S.seq}`, candidate_id: candidate,
    outcome: res.outcome, plan_digest: sec.tuple.plan_digest, catalog_digest: sec.tuple.catalog_digest, addendum_set: sec.tuple.addendum_set,
    timestamp: new Date().toISOString() });
  return { ok: true, code: 'reassessed', judgment_point: false, reasons: [], outcome: res.outcome, signals: res.signals };
}

/** View judgments of a policy-2 run (none for a legacy run): a recorded REAPPROVAL and unresolved event problems. */
export function securityJudgments(S) {
  if (!securityOn(S)) return [];
  const out = [];
  if (S.security?.reapproval) out.push(judgment('security_reapproval', null, `reassessment of ${S.security.reapproval.candidate_id} needs REAPPROVAL: a new START and plan digest (WAIT_FOR_USER)`));
  const ev = securityEvents(S), trustedIds = new Set(ev.addenda.map(a => a.addendum_id));
  for (const c of ev.conflicts) out.push(judgment('addendum_conflict', null, `${c.addendum_id}: ${c.reason}`));
  for (const c of ev.outside) out.push(judgment('addendum_outside_contract', null, `${c.addendum_id}: ${c.reason}`));
  for (const e of ev.forged.addenda.filter(x => !trustedIds.has(x.addendum_id))) out.push(judgment('addendum_required', null, `SECURITY_ADDENDUM ${e.addendum_id} is untrusted (appended while work was live); re-append it once nothing is live`));
  return out;
}

export const GATES = { red: redGate, review: reviewGate, 'ship-ready': shipReadyGate, 'unit-review': unitReviewGate, reassess: reassessGate };
