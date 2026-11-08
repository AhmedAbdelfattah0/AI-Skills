/**
 * Gate decisions recorded by `run-engine.mjs gate red|review|ship-ready|unit-review` under the engine lock
 * (unit-review: engine-unit-review.mjs).
 * The engine derives everything that binds: the candidate (pinned exclusions), the RED runner,
 * its format and resources (from the bound DAG), the frozen candidate and retry authorization (a
 * RUN-STATE RETRY event), the builder roster, the repair it enqueues, and the local proof (it runs
 * the DAG's testCommands itself). Inputs only select. `E` is run-engine.mjs's command context.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gateRed, gateReview, gateShipReady } from './gate.mjs';
import * as io from './engine-io.mjs';
import { retire, leaderStart } from './engine-quiesce.mjs';
import { retryEvent } from './engine-authority.mjs';
import { note, judgment, pinnedSpecs, redRunner, boundRiskEvidence, clampTimeout, overlap } from './engine-dag.mjs';
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
 * acceptance id mapped on a node with a primary acceptance_criteria row (`criterion` or `id`), and
 * every review step must name in `units_consumed` each unit exactly once with its current evidence
 * id. Stricter only: it refuses, it never accepts what gateReview would refuse.
 */
function finalReviewRefusal(S, input) {
  if (input.kind === 'original') {
    const rows = Array.isArray(input.primary?.acceptance_criteria) ? input.primary.acceptance_criteria : [];
    const covered = new Set(rows.flatMap(r => [r?.criterion, r?.id]).filter(nonEmpty));
    const missing = [...new Set(Object.values(S.nodes).flatMap(n => n.acceptance ?? []))].sort().filter(id => !covered.has(id));
    if (missing.length) return gateNo('acceptance_uncovered', [`the final review's acceptance_criteria must cover every mapped acceptance id `
      + `(a row whose criterion or id is the id): missing ${missing.join(', ')}`]);
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
  const pin = pinnedSpecs(node, input.specs);
  if (pin.code) return gateNo(pin.code, [pin.reason]);
  const baseCommit = io.resolveCommit(E.ctx.repoRoot, E.S.config.base ?? 'HEAD');
  const v = await gateRed({ state: E.S, node: node.id, command: { cmd: runner.cmd, args: runner.args ?? [] }, format: runner.format,
    specs: pin.specs, baselineCandidate: candidate, timeoutMs: clampTimeout(E.S.config.timeoutMs), resources: [...node.resources] }, runnerDeps(E));
  E.S = v.state; // gateRed re-verified the binding (deps.verifyBinding) before committing any evidence
  if (v.ok) { Object.assign(E.S.gates.red[node.id], { command: runner.name, base_commit: baseCommit }); delete E.S.gates.red_invalid?.[node.id]; }
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

/**
 * Review: the frozen candidate is the stored one (set by the first original review, a repair, or an
 * authorized retry). A new original after any earlier original needs a RETRY linked to its
 * predecessor. An accepted FAIL enqueues the finding-bound repair from its write set.
 */
function reviewGate(E, input, candidate) {
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
  const v = gateReview({ ...review, state: { ...S, frozen_candidate: frozen, builders: S.builders } });
  if (!v.ok) return { judgment_point: false, ...v };
  if (unitReviewOn(S)) {
    const stale = finalReviewRefusal(S, input);
    if (stale) return stale;
    v.record.units_consumed = consumedUnits.map(c => ({ unit: c.unit, evidence_id: c.evidence_id }));
  }
  const brief = input.repair_prompt_file;
  if (v.repair && !(nonEmpty(brief) && isAbsolute(brief) && existsSync(brief) && statSync(brief).isFile())) {
    return gateNo('repair_prompt_missing', ['an accepted FAIL opens a repair: repair_prompt_file must be the absolute path of its brief']);
  }
  if (retry) {
    S.review_chain.push({ review_execution: input.review_execution, kind: 'retry', predecessor: retry.predecessor, authorized_by: retry.authorized_by });
    for (const r of S.repairs) if (r.review_execution === retry.predecessor && r.state === 'pending') { r.state = 'cancelled'; r.reason = 'superseded by retry'; }
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
  const commands = [];
  for (const [name, c] of Object.entries(E.S.config.testCommands ?? {})) {
    const a = { attempt_id: 'att-' + randomUUID(), kind: 'proof', node: name, status: 'intent' };
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
    commands.push({ name, cmd: c.cmd, args: [...(c.args ?? [])], exit_code: result.exitCode,
      result: result.exitCode === 0 && !result.timedOut ? 'pass' : 'fail', ...(result.error ? { error: result.error } : {}) });
  }
  await E.commit();
  return { commands };
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

/** Ship-ready: exclusions pinned, artifact digests and red_accepted derived; local proof run by the engine when it is all that is missing. */
async function shipReadyGate(E, input, candidate) {
  const S = E.S;
  const units = unitShipRefusal(E);
  if (units) return units;
  if (input.candidate_id !== undefined && input.candidate_id !== candidate) return gateNo('candidate_mismatch', [`input names ${input.candidate_id}, current is ${candidate}`]);
  if (input.risk_evidence !== undefined) S.risk_evidence = boundRiskEvidence(S, input.risk_evidence, io.evidenceExists(E.ctx.repoRoot));
  const current = { candidate_id: candidate, exclusions: input.exclusions ?? S.pinned_exclusions, artifact_digests: io.artifactDigests(E.ctx.repoRoot, input.artifacts) };
  let v = gateShipReady({ state: S, current });
  if (!v.ok && v.reasons.every(r => r === 'missing_local_proof') && !proven(S, candidate)) {
    const { refusal, commands } = await runProof(E);
    if (refusal) return refusal;
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
    const after = io.candidateId(E.ctx.repoRoot, S.config.base ?? 'HEAD', S.pinned_exclusions);
    S.local_proof = { candidate_id: after.candidate_id ?? null, commands, seq: S.seq }; // names the tree the proof actually left
    if (after.candidate_id !== candidate) return gateNo('candidate_mismatch', [`local proof changed the work tree: ${candidate} -> ${after.candidate_id ?? after.reason}`]);
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

export const GATES = { red: redGate, review: reviewGate, 'ship-ready': shipReadyGate, 'unit-review': unitReviewGate };
