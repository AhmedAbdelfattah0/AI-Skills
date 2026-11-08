#!/usr/bin/env node
/**
 * Gate verifier for ship-ticket (AIS-HARNESS-2 plan P0-2, P1-5). Node built-ins only.
 *
 * Gate decisions never throw for a refusal: they RETURN `{ ok, code, ... }`.
 * Only programmer errors (an unknown risk label) throw. The full API contract
 * is the comment block at the top of gate.test.mjs.
 */
import { requiredEvidence } from './harness.mjs';
import { retire, leaderStart } from './engine-quiesce.mjs';

export { requiredEvidence };

// ---------------------------------------------------------------------------
// Runner adapters

const LOAD_TEXT = /ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find module|Failed to load|Transform failed|Test suite failed to run|unexpected token/i;
const fileOf = (location) => (typeof location === 'string' ? location.replace(/:\d+:\d+$/, '') : null);
const unquote = (v) => {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};

/** Parse `node --test` TAP (nested subtests by indentation) into results. */
function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const stack = []; // stack[level] = subtest name announced at that level
  const results = [];
  let diag = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^ */)[0].length;
    const body = line.slice(indent);
    const level = Math.floor(indent / 4);
    const sub = body.match(/^# Subtest: (.*)$/);
    if (sub) { stack.length = level; stack[level] = sub[1]; continue; }
    const res = body.match(/^(not )?ok \d+(?: - (.*))?$/);
    if (!res) {
      if (level === 0 && body.startsWith('#')) diag.push(body.replace(/^# ?/, ''));
      continue;
    }
    const [title, directive = ''] = (res[2] ?? '').split(/(?<!\\) # /);
    const name = [...stack.slice(0, level), title.replace(/\\([\\#])/g, '$1')].join(' > ');
    stack.length = level;
    const yaml = {};
    if (lines[i + 1]?.trim() === '---') {
      const pad = indent + 2;
      for (i += 2; i < lines.length && lines[i].trim() !== '...'; i++) {
        const kv = lines[i].length > pad && lines[i][pad] !== ' ' ? lines[i].slice(pad).match(/^(\w+): ?(.*)$/) : null;
        if (kv) yaml[kv[1]] = unquote(kv[2]);
      }
    }
    let status = res[1] ? 'fail' : 'pass';
    if (/^(SKIP|TODO)\b/i.test(directive)) status = 'skip';
    let failure_kind = null;
    let detail = null;
    if (status === 'fail') {
      const dtext = diag.join('\n');
      if (yaml.failureType === 'subtestsFailed') failure_kind = 'subtests';
      else if (yaml.code === 'ERR_ASSERTION' || yaml.name === 'AssertionError') failure_kind = 'assertion';
      else if (level === 0 && ('exitCode' in yaml || LOAD_TEXT.test(dtext)) && !yaml.name) { failure_kind = 'load'; detail = dtext; }
      else failure_kind = 'runtime';
      if (failure_kind !== 'load') detail = yaml.error ?? null;
    }
    results.push({ name, file: fileOf(yaml.location), status, failure_kind, detail });
    diag = [];
  }
  if (!results.length) return null;
  // Results without a location inherit the file of the nearest ancestor that has one.
  for (const r of results) {
    if (r.file) continue;
    const parts = r.name.split(' > ');
    for (let n = parts.length - 1; n > 0 && !r.file; n--) {
      r.file = results.find((x) => x.file && x.name === parts.slice(0, n).join(' > '))?.file ?? null;
    }
  }
  return results;
}

/** Parse jest `--json` or vitest `--reporter=json` (jest-shaped testResults). */
function parseJestLike(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || !Array.isArray(doc.testResults)) return null;
  const results = [];
  for (const suite of doc.testResults) {
    if (!suite || typeof suite.name !== 'string') return null;
    const cases = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    if (!cases.length && suite.status === 'failed') {
      const msg = String(suite.message ?? '');
      results.push({ name: suite.name, file: suite.name, status: 'fail', failure_kind: 'load', detail: msg });
      continue;
    }
    for (const c of cases) {
      const name = [...(c.ancestorTitles ?? []), c.title].join(' > ');
      const status = c.status === 'passed' ? 'pass' : c.status === 'failed' ? 'fail' : 'skip';
      let failure_kind = null;
      const msgs = (c.failureMessages ?? []).join('\n');
      if (status === 'fail') {
        const matcher = (c.failureDetails ?? []).some((d) => d && d.matcherResult);
        failure_kind = matcher || /^(AssertionError|Error: expect\()/m.test(msgs) ? 'assertion' : 'runtime';
      }
      results.push({ name, file: suite.name, status, failure_kind, detail: status === 'fail' ? msgs : null });
    }
  }
  return results;
}

const ADAPTERS = { tap: parseTap, 'vitest-json': parseJestLike, 'jest-json': parseJestLike };

/** Parse runner output (`tap`, `vitest-json`, `jest-json`) into per-spec results. Never throws. */
export function parseRunnerOutput(format, text) {
  const adapter = Object.hasOwn(ADAPTERS, format) ? ADAPTERS[format] : null;
  if (!adapter) return { supported: false, reason: `unsupported runner format: ${String(format)}` };
  if (typeof text !== 'string') return { supported: false, reason: 'runner output is not text' };
  let results = null;
  try { results = adapter(text); } catch (err) { return { supported: false, reason: `unparseable ${format} output: ${err.message}` }; }
  return results ? { supported: true, results } : { supported: false, reason: `output is not valid ${format}` };
}

// ---------------------------------------------------------------------------
// gateRed

const norm = (p) => String(p).replace(/\\/g, '/');
const sameFile = (resultFile, specFile) => {
  if (!resultFile) return false;
  const r = norm(resultFile); const s = norm(specFile).replace(/^\.\//, '');
  return r === s || r.endsWith(`/${s}`);
};

/** Classify one named spec against parsed results: null when it is an assertion failure. */
function specVerdict(spec, results) {
  const hit = results.find((r) => r.name === spec.name && (sameFile(r.file, spec.file) || !r.file));
  const load = results.find((r) => r.failure_kind === 'load' && sameFile(r.file, spec.file));
  if (!hit) return load ? ['non_assertion_failure', `${spec.file}: failed to load (${spec.name})`] : ['spec_missing', `${spec.file}: no result named "${spec.name}"`];
  if (hit.status !== 'fail') return ['spec_not_failing', `${spec.name}: ${hit.status}`];
  if (hit.failure_kind !== 'assertion') return ['non_assertion_failure', `${spec.name}: ${hit.failure_kind} failure`];
  return null;
}

const refuse = (state, code, reasons, extra = {}) => ({ ok: false, code, judgment_point: false, degraded: false, reasons, state, ...extra });

/**
 * Run the RED command under the durable attempt protocol and accept RED only
 * when every named spec fails with an assertion. See gate.test.mjs for `deps`.
 * Attempts left at `intent` (no pgid) were never released by their launcher, so
 * they never ran the command; their locks are reclaimed.
 */
export async function gateRed(input, deps) {
  const state = structuredClone(input.state);
  state.attempts ??= []; state.locks ??= {}; state.events ??= []; state.gates ??= {}; state.gates.red ??= {};
  const { node, command, format, specs = [], baselineCandidate, timeoutMs, resources = [] } = input;
  const snapshot = () => structuredClone(state);

  if (!baselineCandidate) return refuse(state, 'no_baseline', ['RED evidence must be bound to a tested baseline candidate']);
  if (!Array.isArray(specs) || !specs.length) return refuse(state, 'spec_missing', ['no specs named']);
  const dependents = Object.entries(state.nodes ?? {}).filter(([, n]) => (n.deps ?? []).includes(node)).map(([id]) => id);
  // Dispatches before the engine dropped this node's RED evidence (RED_INVALIDATED) are not "before RED".
  const reset = Math.max(0, ...state.events.filter((e) => e.type === 'RED_INVALIDATED' && e.node === node).map((e) => e.seq ?? 0));
  const early = state.events.find((e) => e.type === 'DISPATCH' && dependents.includes(e.node) && (e.seq ?? 0) > reset);
  if (early) {
    return refuse(state, 'dispatched_before_red', [`${early.node} was dispatched at seq ${early.seq} before RED was accepted`], { judgment_point: true });
  }

  // Reconcile earlier attempts with no envelope on their process group.
  for (const a of state.attempts) {
    if (a.envelope || a.status === 'exited' || a.status === 'abandoned') continue;
    const relevant = (a.kind === 'gate-red' && a.node === node) || (a.resources ?? []).some((r) => resources.includes(r));
    if (!relevant) continue;
    const alive = a.pgid === undefined ? false : deps.isGroupAlive(a.pgid);
    if (alive === null) {
      return refuse(state, 'quiescence_unknown', [`cannot tell whether process group ${a.pgid} of ${a.attempt_id} has exited (${deps.platform})`], { judgment_point: true });
    }
    if (alive) {
      if (a.kind === 'gate-red' && a.node === node) return refuse(state, 'runner_alive', [`runner ${a.attempt_id} (pgid ${a.pgid}) is still running`]);
      return refuse(state, 'resource_locked', [`${a.attempt_id} is live and holds ${(a.resources ?? []).filter((r) => resources.includes(r)).join(', ')}`]);
    }
    // A worker keeps its status for the engine's own reconcile; only its locks are reclaimed.
    if (!(await retire(state, a, deps.isGroupAlive, a.kind === 'gate-red' ? 'abandoned' : null))) {
      return refuse(state, 'quiescence_unknown', [`cannot prove process group ${a.pgid} of ${a.attempt_id} has exited`], { judgment_point: true });
    }
  }
  const held = resources.filter((r) => state.locks[r] !== undefined);
  if (held.length) return refuse(state, 'resource_locked', held.map((r) => `${r} is held by ${state.locks[r]}`));

  // Durable attempt protocol: intent -> spawn -> pid/pgid -> release -> envelope.
  const attempt = { attempt_id: deps.newAttemptId(), kind: 'gate-red', node, status: 'intent', resources: [...resources] };
  state.attempts.push(attempt);
  for (const r of resources) state.locks[r] = attempt.attempt_id;
  await deps.commit(snapshot());
  // The only way to 'exited': retire() proves the whole group gone (or that it was never released).
  const finish = async (envelope) => {
    if (!(await retire(state, attempt, deps.isGroupAlive, 'exited'))) return false;
    attempt.envelope = envelope;
    return true;
  };
  const unquiet = async () => {
    attempt.status = 'unknown'; // not proven gone: not exited, keeps its locks (reconciled later), no verdict
    await deps.commit(snapshot());
    return refuse(state, 'quiescence_unknown', [`cannot prove runner group ${attempt.pgid ?? attempt.pid} of ${attempt.attempt_id} has exited; nothing recorded`], { judgment_point: true });
  };
  let run;
  try {
    const launch = await deps.spawnRunner({ attempt_id: attempt.attempt_id, command, timeoutMs, resources: [...resources] });
    attempt.pid = launch.pid; attempt.pgid = launch.pgid; attempt.leader_start = leaderStart(launch.pgid); attempt.status = 'running';
    await deps.commit(snapshot());
    launch.release();
    run = await launch.done;
  } catch (err) {
    if (!(await finish({ exitCode: null, timedOut: false, error: String(err?.message ?? err) }))) return unquiet();
    await deps.commit(snapshot());
    return refuse(state, 'runner_failed', [`gate runner failed to launch or complete: ${err?.message ?? err}`], { judgment_point: true });
  }
  if (run?.quiescent !== true || !(await finish({ exitCode: run.exitCode ?? null, timedOut: Boolean(run.timedOut),
    ...(run.truncated === true ? { truncated: true, stdout_bytes: run.stdout_bytes } : {}) }))) return unquiet();

  // The runner ran repository code: the approval binding must still hold before any evidence is committed.
  const drift = (await deps.verifyBinding?.()) ?? [];
  if (drift.length) {
    state.seq = Math.max(state.seq ?? 0, ...state.events.map((e) => e.seq ?? 0)) + 1;
    state.events.push({ seq: state.seq, type: 'RED_DROPPED', node, attempt_id: attempt.attempt_id, binding: drift.map((j) => j.code) });
    await deps.commit(snapshot());
    return refuse(state, drift[0].code, [`the RED runner drifted the approval binding: ${drift.map((j) => j.reason).join('; ')}`], { judgment_point: true });
  }

  let verdict;
  const parsed = run.timedOut ? null : parseRunnerOutput(format, run.stdout ?? '');
  if (run.timedOut) verdict = refuse(state, 'runner_timeout', [`runner exceeded ${timeoutMs} ms; a timeout is never re-run automatically`], { judgment_point: true });
  else if (!parsed.supported) verdict = refuse(state, 'unsupported_output', [parsed.reason, 'RED cannot be established; use the documented manual flow (degraded)'], { judgment_point: true, degraded: true });
  else {
    const failures = specs.map((s) => specVerdict(s, parsed.results)).filter(Boolean);
    if (failures.length) verdict = refuse(state, failures[0][0], failures.map((f) => f[1]));
  }
  state.seq = Math.max(state.seq ?? 0, ...state.events.map((e) => e.seq ?? 0)) + 1;
  state.events.push({ seq: state.seq, type: verdict ? 'RED_REFUSED' : 'RED_ACCEPTED', node, attempt_id: attempt.attempt_id });
  if (!verdict) {
    const spec_digests = {};
    for (const s of specs) spec_digests[s.file] ??= await deps.digestFile(s.file);
    const evidence = { node, attempt_id: attempt.attempt_id, seq: state.seq, format, baseline_candidate: baselineCandidate, spec_digests, specs: structuredClone(specs) };
    state.gates.red[node] = evidence;
    verdict = { ok: true, code: 'red_accepted', judgment_point: false, degraded: false, reasons: [], evidence, state };
  }
  await deps.commit(snapshot());
  return verdict;
}

// ---------------------------------------------------------------------------
// gateReview

const CONTRACT = ['reviewer_identity', 'candidate_id', 'reviewed_paths', 'reasoned_exclusions', 'coverage_partitions',
  'acceptance_criteria', 'rule_rows', 'parity_outcome', 'attack_review_outcome', 'security_outcome', 'findings', 'overflow', 'outcome'];
const ARRAYS = new Set(['reviewed_paths', 'reasoned_exclusions', 'coverage_partitions', 'acceptance_criteria', 'rule_rows', 'findings']);
const OUTCOMES = new Set(['PASS', 'FAIL']);
const TRIGGERED = new Set(['PASS', 'FAIL', 'NOT_TRIGGERED']);
const ROW_OUTCOMES = new Set(['PASS', 'FAIL', 'NOT_APPLICABLE']);
const no = (code, reasons) => ({ ok: false, code, reasons });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
/** A finding's paths: `paths[]`, or the review.md single `path`. */
const pathsOf = (f) => (Array.isArray(f?.paths) ? f.paths : nonEmpty(f?.path) ? [f.path] : []);
/** review.md rows: non-empty, each an object with the named non-empty fields and an outcome from `outcomes`. */
const rowsOk = (rows, keys, outcomes) => rows.length > 0 && rows.every((r) => isObj(r) && keys.every((k) => nonEmpty(r[k])) && outcomes.has(r.outcome));

/** Contract gaps of an original primary review (the review.md output contract, nested rows and enums included). */
function contractGaps(p) {
  if (!isObj(p)) return ['missing primary review artifact (counts or a route name are not a review)'];
  const gaps = [];
  for (const f of CONTRACT) {
    if (p[f] === undefined || p[f] === null) gaps.push(`missing primary.${f}`);
    else if (ARRAYS.has(f) && !Array.isArray(p[f])) gaps.push(`primary.${f} must be an array`);
  }
  if (gaps.length) return gaps;
  if (!nonEmpty(p.reviewer_identity) || !nonEmpty(p.candidate_id)) gaps.push('primary.reviewer_identity and primary.candidate_id must be non-empty');
  if (typeof p.overflow !== 'boolean') gaps.push('primary.overflow must be boolean');
  if (!OUTCOMES.has(p.outcome)) gaps.push('primary.outcome must be PASS or FAIL');
  for (const k of ['parity_outcome', 'attack_review_outcome', 'security_outcome']) if (!TRIGGERED.has(p[k])) gaps.push(`primary.${k} must be PASS, FAIL or NOT_TRIGGERED`);
  if (!p.reviewed_paths.length || !p.reviewed_paths.every(nonEmpty)) gaps.push('primary.reviewed_paths must name at least one path');
  if (!p.reasoned_exclusions.every((x) => nonEmpty(x) || (isObj(x) && nonEmpty(x.path) && nonEmpty(x.reason)))) gaps.push('primary.reasoned_exclusions entries need a path and a reason');
  if (!(p.coverage_partitions.length > 0 && p.coverage_partitions.every((c) => isObj(c) && nonEmpty(c.identity) && Array.isArray(c.owned)
    && c.owned.length > 0 && c.owned.every(nonEmpty) && OUTCOMES.has(c.outcome)))) gaps.push('primary.coverage_partitions must be non-empty [{ identity, owned: [path], outcome: PASS|FAIL }]');
  if (!rowsOk(p.acceptance_criteria, ['criterion', 'evidence'], ROW_OUTCOMES)) gaps.push('primary.acceptance_criteria must be non-empty [{ criterion, outcome: PASS|FAIL|NOT_APPLICABLE, evidence }]');
  if (!rowsOk(p.rule_rows, ['subject_id', 'evidence'], ROW_OUTCOMES)) gaps.push('primary.rule_rows must be non-empty [{ subject_id, outcome: PASS|FAIL|NOT_APPLICABLE, evidence }]');
  if (!p.findings.every((f) => isObj(f) && nonEmpty(f.id))) gaps.push('primary.findings need ids');
  else if (!p.findings.every((f) => nonEmpty(f.severity))) gaps.push('primary.findings need a severity (review.md findings[]: id · severity · path)');
  return gaps;
}

/**
 * Identities are '<provider>:<model>' (builders, from the engine's real dispatches); a reviewer
 * identity that equals a builder identity or extends it with ':<suffix>' is that builder.
 */
const sameIdentity = (a, b) => nonEmpty(a) && nonEmpty(b) && (a === b || a.startsWith(b + ':') || b.startsWith(a + ':'));
const DEFAULT_MODEL = ':provider-default';
/**
 * The builder `identity` names, if any. A builder recorded as '<provider>:provider-default' ran the
 * CLI's unresolved default model, which may be any model of that provider: it matches EVERY
 * '<provider>:...' reviewer (independence unknown is refused, never assumed).
 */
const builderOf = (state, identity) => (state.builders ?? []).find((b) => sameIdentity(identity, b?.identity)
  || (nonEmpty(identity) && nonEmpty(b?.identity) && b.identity.endsWith(DEFAULT_MODEL)
    && identity.startsWith(b.identity.slice(0, -DEFAULT_MODEL.length) + ':')));

/**
 * Accept an original review (primary + second opinion + reconciliation) or a confirmation of its repair.
 * `policy` is set by the engine, never by an input: `secondOpinion` 'required' (default) or 'optional'
 * (validated when present: a unit review of a unit that is not risky), and `confirmationSecondOpinion`
 * 'none' (default: not read), 'optional' or 'required' (a risky unit's targeted confirmation).
 */
export function gateReview(input, policy = {}) {
  const state = input?.state ?? {};
  const rx = input?.review_execution;
  const chain = state.review_chain ?? [];
  if (!nonEmpty(rx)) return no('incomplete_contract', ['missing review_execution']);
  if (input.kind === 'confirmation') return confirm(input, state, rx, chain, policy.confirmationSecondOpinion ?? 'none');
  if (input.kind !== 'original') return no('incomplete_contract', [`unknown review kind: ${String(input.kind)}`]);

  const p = input.primary;
  const gaps = contractGaps(p);
  if (gaps.length) return no('incomplete_contract', gaps);
  if (p.parity_outcome !== 'NOT_TRIGGERED' && !nonEmpty(input.graded_artifacts?.parity)) {
    return no('incomplete_contract', ['graded_artifacts.parity: the digest of the graded parity artifact is required when parity is triggered']);
  }
  if (chain.some((r) => r.review_execution === rx)) return no('chain_broken', [`review_execution ${rx} already has records; start a new execution`]);
  const b = builderOf(state, p.reviewer_identity);
  if (b) return no('reviewer_is_builder', [`${p.reviewer_identity} built ${b.node}`]);
  if (p.candidate_id !== state.frozen_candidate) return no('stale_candidate', [`primary reviewed ${p.candidate_id}, frozen is ${state.frozen_candidate}`]);

  const so = input.second_opinion;
  const hasSo = so !== undefined && so !== null;
  if (!hasSo && policy.secondOpinion !== 'optional') return no('missing_second_opinion', ['no second-opinion artifact']);
  if (hasSo) {
    const soOk = isObj(so) && nonEmpty(so.route) && nonEmpty(so.reviewer_identity) && nonEmpty(so.candidate_id) && Array.isArray(so.findings)
      && so.findings.every((f) => isObj(f) && nonEmpty(f.id)) && typeof so.overflow === 'boolean' && OUTCOMES.has(so.outcome)
      && !(so.outcome === 'FAIL' && !so.findings.length) && !(so.outcome === 'PASS' && so.overflow);
    if (!soOk) return no('second_opinion_unusable', ['second opinion must carry route, reviewer_identity, candidate_id, findings, overflow and a consistent outcome']);
    const sb = builderOf(state, so.reviewer_identity);
    if (sb) return no('reviewer_is_builder', [`second opinion ${so.reviewer_identity} built ${sb.node}`]);
    if (sameIdentity(p.reviewer_identity, so.reviewer_identity)) {
      return no('reviewers_not_distinct', [`primary and second opinion are the same reviewer (${p.reviewer_identity})`]);
    }
    if (so.candidate_id !== state.frozen_candidate) return no('stale_candidate', [`second opinion reviewed ${so.candidate_id}, frozen is ${state.frozen_candidate}`]);
  }

  const dispositions = input.reconciliation?.dispositions;
  if (!Array.isArray(dispositions)) return no('missing_reconciliation', ['no reconciliation record']);
  const dispOf = (id, fromPrimary) => dispositions.find((d) => isObj(d) && d.finding_id === id
    && (fromPrimary ? d.source === 'primary' : d.source !== 'primary') && nonEmpty(d.disposition));
  const all = [...p.findings.map((f) => [f, true]), ...(hasSo ? so.findings : []).map((f) => [f, false])];
  const undisposed = all.filter(([f, pr]) => !dispOf(f.id, pr)).map(([f, pr]) => `${pr ? 'primary' : so.route}:${f.id}`);
  if (undisposed.length) return no('missing_reconciliation', undisposed.map((x) => `no disposition for ${x}`));
  const fixes = all.filter(([f, pr]) => dispOf(f.id, pr).disposition === 'fix').map(([f]) => f);

  const failed = [['parity_outcome', p.parity_outcome], ['attack_review_outcome', p.attack_review_outcome], ['security_outcome', p.security_outcome],
    ...['coverage_partitions', 'acceptance_criteria', 'rule_rows'].flatMap((k) => p[k].map((row, i) => [`${k}[${i}]`, row?.outcome]))]
    .filter(([, o]) => o === 'FAIL').map(([k]) => k);
  // Overflow (either reviewer) means unlisted material findings: the review cannot PASS, and a FAIL is terminal.
  const overflow = p.overflow || (hasSo && so.overflow);
  if (p.outcome === 'PASS' && (failed.length || overflow || fixes.length)) {
    return no('outcome_inconsistent', [...failed.map((k) => `PASS with ${k} FAIL`), ...(overflow ? ['PASS with overflow'] : []), ...(fixes.length ? ['PASS with findings to fix'] : [])]);
  }
  const unbound = fixes.filter((f) => { const ps = pathsOf(f); return !ps.length || !ps.every(nonEmpty); });
  if (unbound.length) return no('incomplete_contract', unbound.map((f) => `finding ${f.id} to fix has no path`));

  // Canonical review-chain record: the engine's finding-bound REPAIR authorization and eval read exactly this.
  // A terminal (overflow) FAIL opens no ordinary repair: only an explicitly authorized retry continues.
  const repairs = p.outcome === 'FAIL' && fixes.length > 0 && !overflow;
  const write_set = repairs ? [...new Set([...fixes.flatMap(pathsOf), ...(input.repair_ownership ?? [])])].sort() : [];
  const findings = all.map(([f, pr]) => ({ id: f.id, source: pr ? 'primary' : so.route, severity: nonEmpty(f.severity) ? f.severity : 'unknown',
    paths: [...pathsOf(f)], disposition: dispOf(f.id, pr).disposition }));
  const record = { review_execution: rx, kind: 'original', outcome: p.outcome, candidate_id: p.candidate_id, reviewer_identity: p.reviewer_identity,
    second_opinion_route: hasSo ? so.route : null, graded_artifacts: { ...(input.graded_artifacts ?? {}) }, fix_findings: fixes.map((f) => f.id), findings, write_set, overflow };
  if (overflow) {
    return { ok: true, code: 'review_terminal', judgment_point: true, terminal: true, record,
      reasons: ['overflow FAIL is terminal: no repair opens; continuing needs an explicitly authorized retry (RUN-STATE RETRY linked to this execution)'] };
  }
  const out = { ok: true, code: 'review_accepted', reasons: [], record };
  if (repairs) out.repair = { review_execution: rx, write_set: [...write_set] };
  return out;
}

const confirmationOk = (c) => isObj(c) && nonEmpty(c.reviewer_identity) && nonEmpty(c.candidate_id) && Array.isArray(c.checked_findings)
  && OUTCOMES.has(c.outcome) && nonEmpty(c.evidence);

/**
 * Targeted confirmation of a repair within the same review_execution. With `secondOpinion`
 * 'required' (or 'optional' and present) a second confirmation of the same shape plus `route`, by a
 * different non-builder reviewer on the same candidate, is validated too; the record's outcome is
 * PASS only when both are.
 */
function confirm(input, state, rx, chain, secondOpinion = 'none') {
  const p = input.primary;
  if (!confirmationOk(p)) {
    return no('incomplete_contract', ['confirmation needs reviewer_identity, candidate_id, checked_findings, outcome and evidence']);
  }
  const mine = chain.filter((r) => r.review_execution === rx);
  const original = mine.find((r) => r.kind === 'original' && r.outcome === 'FAIL');
  const repair = original && mine.find((r) => r.kind === 'repair' && chain.indexOf(r) > chain.indexOf(original));
  if (!original || !repair) return no('chain_broken', [`review_execution ${rx} has no original FAIL followed by a repair`]);
  if (mine.some((r) => r.kind === 'confirmation')) return no('confirmation_spent', [`review_execution ${rx} already has its confirmation`]);
  const unchecked = (original.fix_findings ?? []).filter((id) => !p.checked_findings.includes(id));
  if (!p.checked_findings.length || unchecked.length) return no('incomplete_contract', [`confirmation must check every fixed finding: ${unchecked.join(', ') || '(none listed)'}`]);
  const b = builderOf(state, p.reviewer_identity);
  if (b) return no('reviewer_is_builder', [`${p.reviewer_identity} built ${b.node}`]);
  if (p.candidate_id !== state.frozen_candidate || p.candidate_id !== repair.new_candidate) {
    return no('stale_candidate', [`confirmation reviewed ${p.candidate_id}; repaired candidate is ${repair.new_candidate}, frozen is ${state.frozen_candidate}`]);
  }
  const so = input.second_opinion;
  const hasSo = secondOpinion !== 'none' && so !== undefined && so !== null;
  if (secondOpinion === 'required' && !hasSo) return no('missing_second_opinion', ['this confirmation needs a second-opinion confirmation']);
  if (hasSo) {
    if (!confirmationOk(so) || !nonEmpty(so.route)) return no('second_opinion_unusable', ['second-opinion confirmation needs route, reviewer_identity, candidate_id, checked_findings, outcome and evidence']);
    const sUnchecked = (original.fix_findings ?? []).filter((id) => !so.checked_findings.includes(id));
    if (sUnchecked.length) return no('incomplete_contract', [`second-opinion confirmation must check every fixed finding: ${sUnchecked.join(', ')}`]);
    const sb = builderOf(state, so.reviewer_identity);
    if (sb) return no('reviewer_is_builder', [`second opinion ${so.reviewer_identity} built ${sb.node}`]);
    if (sameIdentity(p.reviewer_identity, so.reviewer_identity)) return no('reviewers_not_distinct', [`primary and second opinion are the same reviewer (${p.reviewer_identity})`]);
    if (so.candidate_id !== p.candidate_id) return no('stale_candidate', [`second-opinion confirmation reviewed ${so.candidate_id}, the primary ${p.candidate_id}`]);
  }
  const record = { review_execution: rx, kind: 'confirmation', outcome: p.outcome, candidate_id: p.candidate_id,
    reviewer_identity: p.reviewer_identity, checked_findings: [...p.checked_findings] };
  if (hasSo) Object.assign(record, { outcome: p.outcome === 'PASS' && so.outcome === 'PASS' ? 'PASS' : 'FAIL',
    second_opinion_route: so.route, second_opinion_identity: so.reviewer_identity, second_opinion_outcome: so.outcome });
  return { ok: true, code: 'review_accepted', reasons: [], record };
}

// ---------------------------------------------------------------------------
// gateShipReady

/** True when `list` is exactly the pinned pair for `ticket` (order-insensitive, byte-exact). */
export function exactExclusions(list, ticket) {
  const want = [`.specs/plans/${ticket}.md`, 'session-log.md'];
  return Array.isArray(list) && list.length === 2 && new Set(list).size === 2 && want.every((w) => list.includes(w));
}

/** Ticket-level `config.riskLabels` (any evidence label, incl. `ui`) united with recorded and node risk labels. */
function riskLabels(state) {
  const nodeRisk = isObj(state.nodes) ? Object.values(state.nodes).flatMap((n) => (Array.isArray(n?.risk) ? n.risk : [])) : [];
  return [...new Set([...(state.risk_labels ?? []), ...(state.config?.riskLabels ?? []), ...nodeRisk])];
}

/**
 * Emit SHIP_READY only when candidate, exclusions, review chain, artifacts, completeness (nodes,
 * attempts, repairs, judgments), risk evidence and local proof all bind. Local proof is the record
 * the engine wrote by running the DAG's bound testCommands; it is never taken from an input.
 */
export function gateShipReady({ state = {}, current = {} } = {}) {
  const reasons = [];
  const add = (r) => { if (!reasons.includes(r)) reasons.push(r); };
  if (!nonEmpty(state.ticket) || !exactExclusions(state.pinned_exclusions, state.ticket) || !exactExclusions(current.exclusions, state.ticket)) add('exclusions_altered');

  const chain = state.review_chain ?? [];
  const last = chain.at(-1);
  const accepted = last && (last.kind === 'original' || last.kind === 'confirmation') && last.outcome === 'PASS';
  if (!accepted) add('review_not_accepted');
  if (accepted && current.candidate_id !== last.candidate_id) add('candidate_mismatch');
  if (accepted) {
    const graded = last.graded_artifacts ?? chain.find((r) => r.review_execution === last.review_execution && r.kind === 'original')?.graded_artifacts ?? {};
    for (const [k, digest] of Object.entries(graded)) if (current.artifact_digests?.[k] !== digest) add('artifact_changed');
  }

  // Completeness: every required node finished, nothing in flight, no open repair, no open judgment.
  const nodes = isObj(state.nodes) ? Object.values(state.nodes) : [];
  if (nodes.some((n) => !['done', 'cancelled'].includes(n?.state))) add('nodes_unfinished');
  if ((state.attempts ?? []).some((a) => ['intent', 'launched', 'running', 'unknown'].includes(a?.status))) add('attempts_live'); // unknown: quiescence unproven
  if ((state.repairs ?? []).some((r) => ['pending', 'running'].includes(r?.state))) add('repairs_open');
  if ((state.judgments ?? []).length) add('judgments_unresolved');

  const missing = [];
  for (const kind of requiredEvidence(riskLabels(state))) {
    // spec kinds need accepted RED; other kinds an existing artifact (the engine binds `exists`; false is refused)
    const ok = (state.risk_evidence ?? []).some((e) => e?.kind === kind && nonEmpty(e.path) && (kind.endsWith('-spec') ? e.red_accepted === true : e.exists !== false));
    if (!ok) missing.push(kind);
  }
  if (missing.length) add('missing_risk_evidence');

  const lp = state.local_proof;
  const proofOk = isObj(lp) && lp.candidate_id === current.candidate_id && Array.isArray(lp.commands) && lp.commands.length > 0
    && lp.commands.every((c) => nonEmpty(c?.cmd) && c.result === 'pass');
  if (!proofOk) add('missing_local_proof');

  if (reasons.length) return { ok: false, code: reasons[0], reasons, missing };
  return { ok: true, code: 'ship_ready', reasons, missing, event: { type: 'SHIP_READY', candidate_id: current.candidate_id } };
}
