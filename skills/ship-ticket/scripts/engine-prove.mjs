/**
 * S5 (P5a, STAB stabilization): the pre-review `gate prove` and its early checks, active only with the digest-bound opt-in
 * `config.earlyChecks { version: 1 }` (engine-dag.mjs earlyChecksOn). A run without it never reaches this module's decisions.
 *
 * Old path replaced (CONSOLIDATED §6.1 P5 row / §14.1 S5): `runProof` was reachable only from ship-ready, after REVIEW
 * (engine-gates.mjs shipReadyGate), and repository checks ran only at commit time, so 342's secret surfaced after SHIP_READY and a
 * hung entry was bounded only by the run-wide timeout. `gate prove` runs, BEFORE REVIEW and in this order:
 *   1. the repository's declared working-tree early checks: the T0 declaration `.ship-ticket/t0.json` read from the trusted base
 *      (fast-checks.mjs prepare: the same declaration, scan set and argv as a builder's T0, no second format), each check under
 *      the engine's durable runner protocol with its declared `timeout_ms`. The record (S.early_checks) holds names, enums and
 *      numbers only, and each check's `.out` file is deleted after its group is proven gone: a secrets scanner echoes the secret;
 *   2. the bounded proof: the same runProof, each entry with its own deadline (`timeoutMs`, default config.timeoutMs), in the
 *      declaration order (never reordered: D8). A timed-out entry is named; the next prove re-runs only the entries whose earlier
 *      result is not a reusable pass, plus their declared `after` setups and the teardowns of their resources.
 * A proof row is reusable only while its inputs hold: the candidate id, the base commit, the environment identity and the entry's
 * command identity (proofInputs). Anything unknown or changed runs fresh. Gate-row input KEYS and any reuse across a rebase are
 * NOT here (S6); a changed base is simply "not equal".
 *
 * The early checks are WORKING-TREE checks (scope 'working-tree', replaces_final false). History and commit-range checks (a
 * `gitleaks git base..HEAD`) see nothing before the single SHIP commit, so the repository's final committed/range run is kept: no
 * record here satisfies it, and SHIP_READY of such a run says `final_gates: 'required'`.
 *
 * UNQUALIFIED environment identity: platform, arch, the engine's Node version and PATH, plus each command's resolved executable
 * (path, size, mtime, and sha256 up to 8 MiB). Not covered: scripts or configs a command reads through its arguments, other
 * environment variables, services, container images, network state, Windows PATHEXT resolution.
 */
import { statSync, readFileSync, accessSync, constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, checkInvocation } from './fast-checks.mjs';
import { note, sha, clampTimeout, securityOn, entryAncestors, earlyChecksOn, judgment } from './engine-dag.mjs';
import { baseCandidate, baseCommit, onBase } from './engine-base-read.mjs';
import { LIVE, retire, leaderStart } from './engine-quiesce.mjs';
import { armAttempt } from './lib/deadline.mjs';
import * as io from './engine-io.mjs';
import { runnerDeps, truncation } from './engine-units.mjs';
// No import of engine-gates.mjs (no cycle): it passes runProof and its control-pair predicate in as `hooks`.

const gateNo = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: false, reasons, ...extra });
const proven = (S, candidate) => S.local_proof?.candidate_id === candidate && S.local_proof.commands.length > 0
  && S.local_proof.commands.every(c => c.result === 'pass');
/** T0's own timeout domain (fast-checks.mjs validateDeclaration: 100 ms .. 30 min), kept as declared: never lengthened. */
const t0Timeout = (ms) => Math.min(1800000, Math.max(100, ms));
/** The runner environment of an early check: every inherited GIT_* variable removed, as standalone T0 runs it (fast-checks.mjs cleanEnv). */
const earlyEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));

const J = JSON.stringify;

/** An entry's deadline: its own timeoutMs with config.earlyChecks, else the run-wide config.timeoutMs (clamped as the carrier's). */
export const entryTimeout = (S, c) => clampTimeout(earlyChecksOn(S) && c.timeoutMs !== undefined ? c.timeoutMs : S.config.timeoutMs);

/**
 * One early-check runner under the durable runner protocol: the same steps as one runProof entry (engine-gates.mjs), kept here
 * so the gate module stays unchanged apart from additive hooks. `{ a, result }`, or `{ refusal }` when the group cannot be proven
 * gone (the attempt stays 'unknown' with a quiescence_unknown judgment and nothing is recorded).
 */
async function runEarlyAttempt(E, node, command, timeoutMs) {
  const a = { attempt_id: 'att-' + randomUUID(), kind: 'proof', node, status: 'intent', started_at: new Date().toISOString() };
  E.S.attempts.push(a);
  await E.commit();
  let result;
  try {
    // forensic: false -> the launcher never writes the `.out` copy (a secrets scanner echoes the secret), so no refusal,
    // crash or interruption can leave scanner output on disk; the decision reads only the in-memory frame.
    const launch = await runnerDeps(E).spawnRunner({ attempt_id: a.attempt_id, command, timeoutMs, forensic: false, env: earlyEnv(E.ctx.env ?? process.env) });
    Object.assign(a, { pid: launch.pid, pgid: launch.pgid, leader_start: leaderStart(launch.pgid), status: 'running' });
    armAttempt(E.S, a, timeoutMs, E.ctx.deadlineClock); // S1: durable run only
    await E.commit();
    launch.release(a); // PR-1b: the runner's owner decides against this attempt's persisted deadline
    result = await launch.done;
  } catch (e) { result = { exitCode: null, timedOut: false, error: e.message, ...(io.RUNNER_REFUSALS.has(e?.code) ? { error_code: e.code } : {}), quiescent: true }; } // retire() decides
  if (result.quiescent !== true || !(await retire(E.S, a, E.alive, 'exited', { owned: true }))) {
    a.status = 'unknown';
    const reason = `cannot prove early-check runner group ${a.pgid ?? a.pid} (${node}) has exited; no early check recorded`;
    if (!E.S.judgments.some(j => j.code === 'quiescence_unknown' && j.node === node)) E.S.judgments.push(judgment('quiescence_unknown', node, reason));
    await E.commit();
    return { refusal: gateNo('quiescence_unknown', [reason], { judgment_point: true }) };
  }
  a.envelope = { exitCode: result.exitCode, timedOut: result.timedOut, ...truncation(result) };
  return { a, result };
}


/** After repository commands ran: the approval binding and the tree must still hold (ship-ready's same two checks). */
function proofDrift(E, candidate) {
  const unbound = E.verifyBinding();
  if (unbound.length) return { codes: unbound.map(j => j.code), refusal: gateNo(unbound[0].code, [`local proof drifted the approval binding: ${unbound.map(j => j.reason).join('; ')}`], { judgment_point: true }) };
  const after = baseCandidate(E.ctx.repoRoot, E.S, E.S.pinned_exclusions);
  return after.candidate_id !== candidate ? { codes: ['candidate_mismatch'], refusal: gateNo('candidate_mismatch', [`local proof changed the work tree: ${candidate} -> ${after.candidate_id ?? after.reason}`]) } : null;
}
const HASH_LIMIT = 8 * 1024 * 1024;
const EARLY_OK = ['pass', 'not_declared'];

/**
 * The ONE executable `cmd` names, resolved the way the runner's exec would resolve it, or null (unresolved). POSIX only: a name
 * with a slash is relative to the runner's cwd (the repository); a bare name is searched on PATH in order, each component
 * (an empty one is '.') relative to the repository, and a candidate counts only when it is a regular file with the execute bit
 * for this user. The engine then RUNS this resolved path (runProof `resolved`), so the fingerprinted file is the executed one.
 * Windows (PATHEXT, .cmd shims) is not modelled: unresolved there, never reusable.
 * LIMIT (stated): the file can still change between this fingerprint and its exec, and a script's interpreter (#!) and the files
 * it reads through its arguments are not fingerprinted.
 */
export function resolveExecutable(cmd, env, cwd, platform = process.platform) {
  if (platform === 'win32' || typeof cmd !== 'string' || !cmd) return null;
  const candidates = cmd.includes('/') ? [resolve(cwd, cmd)] : (env.PATH ?? '').split(delimiter).map(d => resolve(cwd, d || '.', cmd));
  for (const p of candidates) {
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      accessSync(p, FS.X_OK);
      return { path: p, size: st.size, mtime_ms: st.mtimeMs, ...(st.size <= HASH_LIMIT ? { sha256: sha(readFileSync(p)) } : {}) };
    } catch { /* not this one */ }
  }
  return null;
}

/** The run's base commit, or null when it cannot be resolved (then nothing is ever reused). */
function baseOf(E) {
  try { return baseCommit(E.ctx.repoRoot, E.S) ?? null; } catch { return null; }
}

/**
 * The inputs a proof of `candidate` ran with: { candidate_id, base_commit, environment_digest, commands: { name: digest } }.
 * A command digest covers its cmd, args, deadline, evidence block and resolved executable identity.
 */
export function proofInputs(E, candidate) {
  const env = E.ctx.env ?? process.env, S = E.S;
  const environment = { platform: E.ctx.platform ?? process.platform, arch: process.arch, node: process.version, path: env.PATH ?? env.Path ?? null };
  const commands = {}, resolved = {}, unresolved = [];
  for (const [name, c] of Object.entries(S.config.testCommands ?? {})) {
    const exe = resolveExecutable(c.cmd, env, E.ctx.repoRoot, E.ctx.platform ?? process.platform);
    if (exe) resolved[name] = exe.path; else unresolved.push(name);
    commands[name] = sha(J({ cmd: c.cmd, args: c.args ?? [], timeout_ms: entryTimeout(S, c), evidence: c.evidence ?? null, exe }));
  }
  return { candidate_id: candidate, base_commit: baseOf(E), environment_digest: sha(J(environment)), commands, resolved, unresolved };
}

const sameRunContext = (a, b) => Boolean(a && b) && typeof a.base_commit === 'string' && a.candidate_id === b.candidate_id
  && a.base_commit === b.base_commit && a.environment_digest === b.environment_digest;
/** Whether two proof input records are equal (every global input and every command identity). */
export const sameInputs = (a, b) => sameRunContext(a, b) && J(Object.entries(a.commands ?? {})) === J(Object.entries(b.commands ?? {}))
  && Array.isArray(a.unresolved) && Array.isArray(b.unresolved) && !a.unresolved.length && !b.unresolved.length; // unresolved identity: never equal

/** The S5 fields of a proof record run with `inputs`: the inputs and one entry row per command. */
export const proofExtras = (commands, inputs, reused = new Set()) => ({ inputs, entries: Object.fromEntries(commands.map(c => [c.name,
  { result: c.result, timed_out: c.timed_out === true, command_digest: inputs.commands[c.name], ...(c.attempt_id ? { attempt_id: c.attempt_id } : {}), ...(reused.has(c.name) ? { reused: true } : {}) }])) });

/**
 * The entries a prove must run now (a Set; runProof keeps the declaration order). Seeds: every entry without a reusable earlier
 * pass under equal inputs. Closure, to a fixed point, so no verdict is assembled from incompatible executions:
 *   - an entry's declared `after` ancestors run with it (its setup);
 *   - an entry that declares `after` on a running entry runs again (its earlier result saw the earlier execution);
 *   - when any entry of a declared resource runs, every setup, consumer and teardown of that resource runs (shared state).
 * Under security policy 2 every entry runs (spec_results are computed over every run together).
 */
function rerunSet(S, inputs, prior) {
  const cmds = S.config.testCommands ?? {}, names = Object.keys(cmds);
  const reusable = (n) => !securityOn(S) && !inputs.unresolved.includes(n) && prior?.candidate_id === inputs.candidate_id && sameRunContext(prior.inputs, inputs)
    && prior.inputs.commands?.[n] === inputs.commands[n] && prior.entries?.[n]?.result === 'pass' && prior.commands?.some(c => c.name === n && c.result === 'pass');
  const run = new Set(names.filter(n => !reusable(n)));
  for (let size = -1; size !== run.size;) {
    size = run.size;
    for (const n of [...run]) for (const a of entryAncestors(cmds, n)) run.add(a);
    for (const n of names) if ((cmds[n].after ?? []).some(a => run.has(a))) run.add(n);
    const touched = new Set([...run].map(n => cmds[n].resource).filter(r => r !== undefined));
    for (const n of names) if (cmds[n].resource !== undefined && touched.has(cmds[n].resource)) run.add(n);
  }
  return run;
}

/** The merge base of HEAD and the run's base (the base the candidate is measured from), or null. */
function mergeBase(E) {
  const b = baseOf(E);
  if (!b) return null;
  const r = onBase(E.S, () => spawnSync('git', ['merge-base', 'HEAD', b], { cwd: E.ctx.repoRoot, encoding: 'utf8', timeout: 60000 }));
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Run the repository's declared early checks on the working tree (T0 declaration from the merge base) and record S.early_checks.
 * Returns { record } or { refusal } (a runner whose group cannot be proven gone).
 */
async function runEarlyChecks(E, candidate, generation) {
  const S = E.S, base = mergeBase(E);
  const prep = base ? onBase(S, () => prepare(E.ctx.repoRoot, base)) : { stop: { code: 'base_invalid' } };
  let rec;
  if (prep.stop) rec = { declared: true, result: 'fail', code: prep.stop.code, checks: [] };
  else if (!prep.decl) rec = { declared: false, result: 'not_declared', code: 'not_declared', checks: [] };
  else {
    const checks = [];
    for (const c of prep.decl.checks) {
      const inv = checkInvocation(prep.repoReal, c, prep);
      const row = { name: c.name, kind: c.kind, files: inv.files, timeout_ms: t0Timeout(c.timeout_ms) };
      if (inv.skip) { checks.push({ ...row, result: inv.skip === 'skipped' ? 'skipped' : 'fail', ...(inv.skip === 'skipped' ? {} : { code: inv.skip }) }); continue; }
      const ran = await runEarlyAttempt(E, `early-check:${c.name}`, { cmd: inv.cmd, args: inv.args }, row.timeout_ms);
      if (ran.refusal) return ran;
      checks.push({ ...row, result: ran.result.exitCode === 0 && !ran.result.timedOut ? 'pass' : 'fail', exit_code: ran.result.exitCode ?? null,
        timed_out: ran.result.timedOut === true, attempt_id: ran.a.attempt_id });
    }
    const failed = checks.some(x => x.result === 'fail');
    rec = { declared: true, result: failed ? 'fail' : 'pass', code: failed ? 't0_failed' : 'ok', checks };
  }
  S.early_checks = { candidate_id: candidate, base_commit: base, scope: 'working-tree', replaces_final: false, ...rec, generation, seq: S.seq };
  note(S, 'EARLY_CHECKS', { candidate_id: candidate, result: rec.result, code: rec.code });
  await E.commit();
  return { record: S.early_checks };
}

const earlyReasons = (ec) => (ec.checks.length ? ec.checks.filter(c => c.result === 'fail')
  .map(c => `early check ${c.name} (${c.kind}) failed${c.timed_out ? ` at its ${c.timeout_ms} ms deadline` : ''}${c.code ? `: ${c.code}` : ''}`)
  : [`early checks could not run: ${ec.code}`]);

/**
 * gate prove (config.earlyChecks only; run-engine.mjs refuses it otherwise): early checks, then the bounded proof, both on the
 * current candidate, before REVIEW. Records S.early_checks and S.local_proof (bound to the candidate only after the binding, the
 * tree and the inputs are re-verified, as ship-ready does). ok only when both pass.
 */
export async function proveGate(E, input, candidate, hooks) {
  const S = E.S;
  if (S.attempts.some(a => LIVE.includes(a.status))) return gateNo('prove_unquiet', ['another attempt is live: prove runs only while nothing runs beside it']);
  const before = proofInputs(E, candidate);
  // Prove generations (RCA-S5-ROUND2 path 1). Per-entry reuse may draw only on the proof of the LAST generation, and only when
  // that generation completed (an interrupted or refused one invalidates reuse: its re-run commands may have changed shared state).
  const last = S.prove_generation;
  const prior = last?.state === 'completed' && S.local_proof?.generation === last.id ? S.local_proof : null;
  // The marker is durable BEFORE any command is released: from here until this generation completes, no earlier early-check or
  // proof record is bound to a candidate, so a crash, a kill or a refusal at any point leaves nothing eligible for REVIEW.
  const gen = { id: 'prove-' + randomUUID(), state: 'running', candidate_id: candidate, started_seq: S.seq ?? 0 };
  S.prove_generation = gen;
  if (S.early_checks) S.early_checks = { ...S.early_checks, candidate_id: null, superseded_by: gen.id };
  if (S.local_proof) S.local_proof = { ...S.local_proof, candidate_id: null, superseded_by: gen.id };
  note(S, 'PROVE_STARTED', { generation: gen.id, candidate_id: candidate });
  await E.commit();
  const fail = async (refusal) => { gen.state = 'failed'; gen.code = refusal.code; await E.commit(); return refusal; };
  const early = await runEarlyChecks(E, candidate, gen.id);
  if (early.refusal) return fail(early.refusal);
  const run = rerunSet(S, before, prior);
  const ran = await hooks.runProof(E, { only: run, resolved: before.resolved });
  if (ran.refusal) return fail(ran.refusal);
  E.baseCommit = undefined; // the commands may have moved config.base: nothing cached survives them
  const byName = new Map(ran.commands.map(c => [c.name, c]));
  const reused = new Set(Object.keys(S.config.testCommands ?? {}).filter(n => !run.has(n)));
  const commands = Object.keys(S.config.testCommands ?? {}).map(n => byName.get(n) ?? { ...prior.commands.find(c => c.name === n), reused: true });
  const drop = (codes) => { S.local_proof = { candidate_id: null, commands, seq: S.seq, phase: 'prove', generation: gen.id, dropped: codes }; };
  const drift = proofDrift(E, candidate);
  if (drift) { drop(drift.codes); return fail(drift.refusal); }
  if (!sameInputs(before, proofInputs(E, candidate)) && !before.unresolved.length) {
    drop(['proof_inputs_changed']);
    return fail(gateNo('proof_inputs_changed', ['the proof inputs (base, environment or a command identity) changed while prove ran']));
  }
  S.local_proof = { candidate_id: candidate, commands, seq: S.seq, phase: 'prove', generation: gen.id, ...(ran.spec_results ? { spec_results: ran.spec_results } : {}), ...proofExtras(commands, before, reused) };
  const passed = commands.length > 0 && commands.every(c => c.result === 'pass');
  note(S, 'LOCAL_PROOF', { candidate_id: candidate, passed, phase: 'prove', ran: [...run].sort(), reused: [...reused].sort() });
  const ec = early.record, reasons = [];
  if (!EARLY_OK.includes(ec.result)) reasons.push(...earlyReasons(ec));
  const timedOut = commands.filter(c => c.timed_out === true);
  for (const c of timedOut) reasons.push(`proof entry ${c.name} timed out at its ${c.timeout_ms} ms deadline: the next prove re-runs it with its dependency closure`);
  for (const c of commands.filter(x => x.result !== 'pass' && x.timed_out !== true)) reasons.push(`proof entry ${c.name} failed (exit ${c.exit_code})`);
  if (!commands.length) reasons.push('the DAG declares no testCommands entry: nothing proves the candidate');
  for (const n of before.unresolved) reasons.push(`proof entry ${n}: its executable did not resolve (missing, not executable, or Windows), so this proof cannot bind a REVIEW`);
  // Security policy 2: the same predicate ship-ready applies (control_unproven): every effective, unwaived pair spec must be
  // 'pass' in this proof with its RED still binding; a skipped, missing or truncated spec result is not a pass.
  const unproven = securityOn(S) ? await hooks.unprovenControls(E, candidate) : [];
  for (const p of unproven) reasons.push(`control ${p} is not proven by this proof (its spec is not 'pass', or its RED no longer binds)`);
  Object.assign(gen, { state: 'completed', ok: reasons.length === 0, completed_seq: S.seq });
  const summary = { generation: gen.id, early_checks: { result: ec.result, code: ec.code, scope: ec.scope, checks: ec.checks.map(c => ({ name: c.name, result: c.result })) },
    proof: { ran: [...run].sort(), reused: [...reused].sort(), commands: commands.map(c => ({ name: c.name, result: c.result, ...(c.timed_out ? { timed_out: true } : {}) })) } };
  if (!reasons.length) return { ok: true, code: 'proved', judgment_point: false, reasons: [], ...summary };
  const code = !EARLY_OK.includes(ec.result) ? 'early_check_failed' : timedOut.length ? 'proof_entry_timeout'
    : passed && unproven.length ? 'control_unproven' : 'proof_failed';
  return { ...gateNo(code, reasons), ...summary };
}

/** The current prove generation, when it COMPLETED successfully on `candidate` and both of its records are its own; else null. */
function completedGeneration(S, candidate) {
  const g = S.prove_generation;
  return g?.state === 'completed' && g.ok === true && g.candidate_id === candidate && S.early_checks?.generation === g.id
    && S.early_checks.candidate_id === candidate && S.local_proof?.generation === g.id ? g : null;
}

/** Review (original or confirmation): refused unless a prove of this candidate passed and its inputs still hold. Null when it did. */
export async function proveRefusal(E, candidate, hooks) {
  const S = E.S, ec = S.early_checks, why = [], g = S.prove_generation;
  if (!completedGeneration(S, candidate)) why.push(g?.state === 'running' ? `prove generation ${g.id} never completed (interrupted): run gate prove again`
    : g?.state === 'failed' ? `prove generation ${g.id} was refused (${g.code}): run gate prove again` : `no successfully completed prove generation of candidate ${candidate} (run gate prove)`);
  else if (!EARLY_OK.includes(ec.result)) why.push(...earlyReasons(ec));
  if (why.length) return gateNo('prove_required', [`config.earlyChecks: REVIEW needs a passing pre-review prove of this candidate: ${why.join('; ')}`]);
  if (!proven(S, candidate)) why.push(`no passing proof of candidate ${candidate} (run gate prove)`);
  else if (!sameInputs(S.local_proof.inputs, proofInputs(E, candidate))) why.push('the proof inputs (base, environment or a command identity) changed since prove: run gate prove again');
  else if (securityOn(S)) for (const p of await hooks.unprovenControls(E, candidate)) why.push(`control ${p} is not proven by the prove of this candidate`);
  return why.length ? gateNo('prove_required', [`config.earlyChecks: REVIEW needs a passing pre-review prove of this candidate: ${why.join('; ')}`]) : null;
}

/**
 * Ship-ready (config.earlyChecks): refuses unless the early checks of this candidate passed; a candidate-bound proof whose inputs
 * no longer hold is unbound (PROOF_INPUTS_CHANGED) so ship-ready re-runs it fresh. Null to continue.
 */
export function staleProofRefusal(E, candidate) {
  const S = E.S, ec = S.early_checks, g = S.prove_generation;
  if (!(g?.state === 'completed' && g.candidate_id === candidate && ec?.generation === g.id && ec.candidate_id === candidate) || !EARLY_OK.includes(ec.result)) {
    return gateNo('prove_required', [`config.earlyChecks: ship-ready needs passing early checks of candidate ${candidate} from a completed prove generation (run gate prove)`]);
  }
  const lp = S.local_proof;
  if (lp?.candidate_id === candidate && !sameInputs(lp.inputs, proofInputs(E, candidate))) {
    S.local_proof = { ...lp, candidate_id: null, dropped: ['proof_inputs_changed'] };
    note(S, 'PROOF_INPUTS_CHANGED', { candidate_id: candidate });
  }
  return null;
}
