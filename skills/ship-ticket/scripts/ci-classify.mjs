#!/usr/bin/env node
/**
 * Advisory CI failure classifier (ASTF-39, S-05b). Maps ONE S-05a snapshot (ci-snapshot.mjs) to exactly one classification,
 * by the rules R1-R6 of cons:F 1.3. Pure: no fetching, no git, node built-ins plus lib/shape.mjs and ci-snapshot.mjs constants.
 *
 *   ci-classify.mjs classify --snapshot-json <file|->     (the JSON line printed by `ci-snapshot.mjs check`)
 *
 * ADVISORY, NOT A GATE. The output (schema `ci-classification-v1`, closed key set) is an INPUT to later slices, never a result:
 *   classification   failed_code | ci_mixed_execution | billing_blocked | unavailable | no_failure_observed
 *   ci_state         FAIL | UNAVAILABLE | NOT_CLASSIFIED   (nothing else, ever: no pass, no waive, no eligible)
 * This module NEVER emits CI_PASSED, a pass, a waiver or LOCAL_CI_VERIFIED, and carries no fallback-eligibility field. The
 * snapshot does not attest the required-check policy (ci-snapshot.mjs NOT_ATTESTED), so "CI passed" cannot be derived here and
 * EVERY check in the snapshot is treated as required. A failed required check classified billing_blocked stays UNAVAILABLE: the
 * only authorised fallback (merge basis CI_BILLING_BLOCKED + LOCAL_CI_VERIFIED) stays owned by references/ship.md and later slices.
 * Consumers act only on an exact expected classification and treat an unknown or missing field as not classified.
 *
 * ARCHITECTURE: VALIDATE FIRST, CLASSIFY SECOND (the S-05b restart). `classifySnapshot(raw)` = classifyNormal(validateSnapshot(raw)).
 *  1. validateSnapshot: ONE pass over the whole input; any problem => `unavailable` with typed reasons `invalid:<code>@<where>`
 *     (codes: INVALID_CODES). Closed shapes via lib/shape.mjs (no coercion: typeof checks, safe integers, ISO round trip; accessors,
 *     `__proto__` and unknown keys refused), then a structuredClone that is validated again (a getter or Proxy cannot answer twice).
 *     Every DERIVED field is RECOMPUTED with ci-snapshot.mjs's own rules and must be equal: input_status (classifyJob), supersession
 *     and superseded_by_attempt, slot uniqueness, attempt contiguity; every bound row agrees with exactly one jobs[] entry and every
 *     jobs[] entry is bound by exactly one row. The classifier reads only the normal form built here, never a claimed field.
 *  2. classifyNormal: pure and total. Every row is evaluated, then one precedence table decides (no early return):
 *       a non-success attempt is CLEARED only by a strictly later attempt of the same (run_id, name) whose conclusion is `success`;
 *       live executed failure            => failed_code, or ci_mixed_execution beside billing rows   (R5: FAIL dominates)
 *       external failure-class check     => unavailable   (cancelled excepted; R6: never billing)
 *       live unclassified failure        => unavailable
 *       live billing rows (R1-R4 each)   => billing_blocked   (beside success, skipped, neutral or a cancelled external check only)
 *       every check's latest attempt is `success`, every failure cleared => no_failure_observed / NOT_CLASSIFIED
 *       anything else (a latest skipped, neutral or cancelled check)      => unavailable
 * Rules: R1 app `github-actions`; R2 conclusion failure|startup_failure AND started_at..completed_at <= BILLING_MAX_SECONDS;
 * R3 steps an ARRAY, empty or all skipped, AND runner_name ''; R4 every annotation message EXACTLY in the versioned allowlist;
 * R5 a failure that EXECUTED a step is a code failure, billing never consulted; R6 non-Actions checks are never billing.
 *
 * PROVISIONAL PARAMETER: BILLING_MAX_SECONDS = 10 is an ESTIMATE (cons:F 1.3 "proposed threshold"). It rests on ONE
 * incident (SCRUM-202: 1-2 s, n = 1). Too low gives `unavailable` (fail-closed, the owner waits); too high is guarded by
 * R1, R3, R4 and R5, and a code failure always executes steps. Re-measure at the next real billing incident before
 * changing it; the test pins the value so a change is a deliberate edit.
 *
 * RESIDUAL: the snapshot's provider_snapshot_sha256 is checked for shape only; a fully self-consistent forgery of a
 * snapshot_valid object is trusted. S-05c recomputes the hash from the captured files.
 *
 * CLI exit: NEVER 0. Every classification exits 1 (so `ci-classify ... && next` can never proceed), 2 is usage, 3 is
 * unreadable input (not UTF-8, BOM, not JSON, duplicate keys, trailing text, too deep, too large) or an internal error; the
 * stdout line carries the data. Every output carries `note`: "Required checks unverified; no gate decision."
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isEntrypoint } from './harness.mjs';
import { CONCLUSIONS, NOT_ATTESTED, SCHEMA as SNAPSHOT_SCHEMA_ID, SHAPES as SNAPSHOT_SHAPES, normOrigin } from './ci-snapshot.mjs';
import { CODES as SHAPE_CODES, isTimestamp, validate } from './lib/shape.mjs';

export const SCHEMA = 'ci-classification-v1';
export const SNAPSHOT_SCHEMA = SNAPSHOT_SCHEMA_ID;
export const BILLING_MAX_SECONDS = 10;
export const BILLING_ALLOWLIST_VERSION = 'github-actions-billing-annotation-v1';
export const BILLING_ANNOTATION_ALLOWLIST = Object.freeze([
  'The job was not started because recent account payments have failed or your spending limit needs to be increased.',
]);
/** The single source of the classification -> (ci_state, code) mapping. */
export const CLASSIFICATIONS = Object.freeze({
  failed_code: Object.freeze({ ci_state: 'FAIL', code: 'ci_failed' }),
  ci_mixed_execution: Object.freeze({ ci_state: 'FAIL', code: 'ci_mixed_execution' }),
  billing_blocked: Object.freeze({ ci_state: 'UNAVAILABLE', code: 'ci_billing_blocked' }),
  unavailable: Object.freeze({ ci_state: 'UNAVAILABLE', code: 'ci_provider_unavailable' }),
  no_failure_observed: Object.freeze({ ci_state: 'NOT_CLASSIFIED', code: 'no_failure_observed' }),
});
export const CI_STATES = Object.freeze(['FAIL', 'UNAVAILABLE', 'NOT_CLASSIFIED']);
export const NOT_ASSERTED = Object.freeze(['required_check_policy', 'merge_basis', 'local_evidence', 'fallback_decision']);
export const NOTE = 'Required checks unverified; no gate decision.';
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/**
 * The annotation hash ci-snapshot.mjs records for a zero-annotation check whose annotation file EXISTS and is empty: its
 * sha256(JSON of the canonical parsed lines) over `[]` (no file at all records null). Derived the same way, never a literal;
 * the test proves it equals buildSnapshot's own output.
 */
export const EMPTY_ANNOTATIONS_SHA256 = createHash('sha256').update(JSON.stringify([])).digest('hex');
/** Every semantic reason code validateSnapshot may raise; shape problems are `shape_<lib/shape.mjs code>`. */
export const INVALID_CODES = Object.freeze([
  'unreadable', 'not_internally_consistent', 'snapshot_reports_problems', 'not_attested_mismatch', 'hash_invalid', 'repo_invalid',
  'head_sha_invalid', 'origin_invalid', 'no_check_runs', 'row_id_invalid', 'row_id_duplicate', 'row_fields_malformed',
  'binding_app_mismatch', 'external_row_inconsistent', 'bound_row_inconsistent', 'job_not_completed', 'conclusion_inconsistent',
  'attempt_inconsistent', 'steps_state_inconsistent', 'runner_state_inconsistent', 'labels_state_inconsistent', 'input_status_mismatch',
  'annotations_inconsistent', 'supersession_mismatch', 'ambiguous_job_slot', 'attempt_gap', 'job_id_invalid', 'job_id_duplicate',
  'job_row_inconsistent', 'job_row_mismatch', 'job_not_bound_by_one_row', 'not_a_validated_normal_form',
  ...SHAPE_CODES.map((c) => `shape_${c}`),
]);

const OK_CONCLUSIONS = ['success', 'neutral', 'skipped']; // ci-snapshot.mjs: not a failed conclusion
const NOT_EXECUTED = ['skipped', 'neutral', 'cancelled']; // ci-snapshot.mjs: never a superseder
const BILLING_CONCLUSIONS = ['failure', 'startup_failure'];
const failedConclusion = (c) => !OK_CONCLUSIONS.includes(c);
const ID = /^(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isId = (v) => typeof v === 'string' && ID.test(v);
const STATE3 = ['array', 'absent', 'null'];

// ---- closed shapes of the snapshot as ci-snapshot.mjs buildSnapshot emits it (snapshot_valid only) ----
const STEP = { object: { name: 'string', status: { enum: SNAPSHOT_SHAPES.step.object.status.enum }, conclusion: { enum: CONCLUSIONS, nullable: true }, number: 'posint' } };
const JOB_INPUTS = { object: { status: 'string|null', conclusion: 'string|null', run_attempt: 'posint|null', started_at: 'ts|null', completed_at: 'ts|null',
  steps_state: { enum: STATE3 }, steps: { arrayOf: STEP, nullable: true }, steps_type: { enum: STATE3 },
  runner_name_state: { enum: ['string', 'absent', 'null'] }, runner_name: 'string|null', runner_group_name: 'string|null',
  labels_state: { enum: STATE3 }, labels: { arrayOf: 'string', nullable: true }, labels_type: { enum: STATE3 }, labels_problem: 'null' } };
const ROW = { object: { id: 'string', name: 'string', app: 'string', status: { enum: ['completed'] }, conclusion: { enum: CONCLUSIONS }, started_at: 'ts|null', completed_at: 'ts|null',
  fields_malformed: 'boolean', binding: { enum: ['bound', 'external'] }, reason: 'null', job_id: 'string|null', run_id: 'string|null', run_attempt: 'posint|null',
  job_inputs: { ...JOB_INPUTS, nullable: true }, input_status: { enum: ['ok', 'outside_r3', 'external'] },
  supersession: { enum: ['not_applicable', 'superseded', 'not_superseded'] }, superseded_by_attempt: '?posint',
  annotations: { object: { status: { enum: ['none', 'present'] }, messages: { arrayOf: 'string' }, count: 'uint', sha256: 'string|null' } } } };
const JOB_ROW = { object: { id: 'string', name: 'string', run_id: 'string', run_attempt: 'posint', fields_malformed: 'boolean', inputs: JOB_INPUTS,
  input_status: { enum: ['ok', 'outside_r3'] }, reason: 'null', bound: 'boolean' } };
export const SNAPSHOT_SHAPE = Object.freeze({ object: { schema: { enum: [SNAPSHOT_SCHEMA_ID] }, repo: 'string', head_sha: 'string', origin: 'string', state: { enum: ['snapshot_valid'] },
  not_attested: { arrayOf: 'string' }, failed_predicates: { arrayOf: 'string' }, reasons: { arrayOf: 'string' }, field_problems: { arrayOf: 'null' },
  internally_consistent: 'boolean', provider_snapshot_sha256: 'string', check_runs: { arrayOf: ROW }, jobs: { arrayOf: JOB_ROW },
  unbound_check_runs: { arrayOf: 'string' }, orphan_jobs: { arrayOf: 'string' } } });

/** ci-snapshot.mjs classifyJob, restated over the recorded job_inputs (its *_state markers). */
function expectedInputStatus(inp) {
  if (inp.conclusion === 'skipped') return inp.runner_name_state === 'null' ? 'outside_r3' : inp.runner_name_state === 'string' ? 'ok' : 'unknown';
  if (OK_CONCLUSIONS.includes(inp.conclusion)) return 'ok';
  return inp.steps_state === 'array' && inp.runner_name_state === 'string' ? 'ok' : 'unknown';
}

/** The semantic checks over a shape-valid clone; returns the list of [code, where]. */
function semanticProblems(s) {
  const out = [], bad = (code, where) => out.push([code, where]);
  if (s.internally_consistent !== true) bad('not_internally_consistent', 'internally_consistent');
  for (const k of ['failed_predicates', 'reasons', 'field_problems', 'unbound_check_runs', 'orphan_jobs']) if (s[k].length !== 0) bad('snapshot_reports_problems', k);
  if (!isDeepStrictEqual(s.not_attested, [...NOT_ATTESTED])) bad('not_attested_mismatch', 'not_attested');
  if (!HEX64.test(s.provider_snapshot_sha256)) bad('hash_invalid', 'provider_snapshot_sha256');
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(s.repo)) bad('repo_invalid', 'repo');
  if (!/^[0-9a-f]{40}$/.test(s.head_sha)) bad('head_sha_invalid', 'head_sha');
  if (normOrigin(s.origin) !== s.origin) bad('origin_invalid', 'origin');
  if (s.check_runs.length === 0) bad('no_check_runs', 'check_runs');

  const rowIds = new Set();
  for (const [i, r] of s.check_runs.entries()) {
    const at = `check_runs/${i}`;
    if (!isId(r.id)) bad('row_id_invalid', at);
    if (rowIds.has(r.id)) bad('row_id_duplicate', at);
    rowIds.add(r.id);
    if (r.fields_malformed !== false) bad('row_fields_malformed', at);
    if ((r.binding === 'bound') !== (r.app === 'github-actions') || r.app === '') bad('binding_app_mismatch', at);
    const a = r.annotations;
    // none: no file (null) or an EMPTY file (the builder's hash of []); present: a real hash, never the empty-list one
    if (a.status === 'none' ? !(a.count === 0 && a.messages.length === 0 && (a.sha256 === null || a.sha256 === EMPTY_ANNOTATIONS_SHA256)) : !(a.count >= 1 && a.messages.length === a.count && typeof a.sha256 === 'string' && a.sha256 !== EMPTY_ANNOTATIONS_SHA256 && HEX64.test(a.sha256))) bad('annotations_inconsistent', at);
    if (r.binding === 'external') {
      if (!(r.job_id === null && r.run_id === null && r.run_attempt === null && r.job_inputs === null && r.input_status === 'external')) bad('external_row_inconsistent', at);
      continue;
    }
    if (!(r.job_id === r.id && isId(r.run_id) && Number.isSafeInteger(r.run_attempt) && r.job_inputs !== null && r.input_status !== 'external')) { bad('bound_row_inconsistent', at); continue; }
    const inp = r.job_inputs;
    if (inp.status !== 'completed') bad('job_not_completed', at);
    if (inp.conclusion !== r.conclusion) bad('conclusion_inconsistent', at);
    if (inp.run_attempt !== r.run_attempt) bad('attempt_inconsistent', at);
    if (inp.steps_state !== inp.steps_type || (inp.steps_state === 'array') !== Array.isArray(inp.steps) || (inp.steps_state !== 'array' && inp.steps !== null)) bad('steps_state_inconsistent', at);
    if ((inp.runner_name_state === 'string') !== (typeof inp.runner_name === 'string')) bad('runner_state_inconsistent', at);
    if (inp.labels_state !== inp.labels_type || (inp.labels_state === 'array') !== Array.isArray(inp.labels) || (inp.labels_state !== 'array' && inp.labels !== null)) bad('labels_state_inconsistent', at);
    if (expectedInputStatus(inp) !== r.input_status) bad('input_status_mismatch', at);
  }

  // supersession, recomputed exactly as ci-snapshot.mjs does (same run_id and name; a higher attempt not skipped/neutral/cancelled)
  const bound = s.check_runs.filter((r) => r.binding === 'bound');
  const key = (r) => JSON.stringify([r.run_id, r.name]);
  const top = new Map();
  for (const r of bound) if (!NOT_EXECUTED.includes(r.conclusion)) top.set(key(r), Math.max(top.get(key(r)) ?? 0, r.run_attempt));
  for (const [i, r] of s.check_runs.entries()) {
    const best = r.binding === 'bound' ? top.get(key(r)) : undefined;
    const want = !failedConclusion(r.conclusion) ? 'not_applicable' : best !== undefined && r.run_attempt < best ? 'superseded' : 'not_superseded';
    const by = Object.hasOwn(r, 'superseded_by_attempt') ? r.superseded_by_attempt : undefined;
    if (r.supersession !== want || by !== (want === 'superseded' ? best : undefined)) bad('supersession_mismatch', `check_runs/${i}`);
  }
  const slots = new Set();
  for (const r of bound) { const k = JSON.stringify([r.run_id, r.run_attempt, r.name]); if (slots.has(k)) bad('ambiguous_job_slot', `check_runs/${r.id}`); slots.add(k); }

  // jobs[]: every entry bound by exactly one row and equal to it
  const jobsById = new Map();
  for (const [i, j] of s.jobs.entries()) {
    const at = `jobs/${i}`;
    if (!isId(j.id) || !isId(j.run_id)) bad('job_id_invalid', at);
    if (jobsById.has(j.id)) bad('job_id_duplicate', at);
    jobsById.set(j.id, j);
    if (j.bound !== true || j.fields_malformed !== false || j.run_attempt !== j.inputs.run_attempt) bad('job_row_inconsistent', at);
  }
  const uses = new Map();
  for (const r of bound) {
    const j = jobsById.get(r.job_id);
    uses.set(r.job_id, (uses.get(r.job_id) ?? 0) + 1);
    if (!j || j.name !== r.name || j.run_id !== r.run_id || j.run_attempt !== r.run_attempt || j.input_status !== r.input_status || !isDeepStrictEqual(j.inputs, r.job_inputs)) bad('job_row_mismatch', `check_runs/${r.id}`);
  }
  for (const j of s.jobs) if (uses.get(j.id) !== 1) bad('job_not_bound_by_one_row', `jobs/${j.id}`);
  const attempts = new Map();
  for (const j of s.jobs) attempts.set(j.run_id, new Set([...(attempts.get(j.run_id) ?? []), j.run_attempt]));
  for (const [run, set] of attempts) if (set.size !== Math.max(...set)) bad('attempt_gap', `run/${run}`);
  return out;
}

const NORMAL = new WeakSet();
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); } return v; };
// An unknown key is input text: its name is never echoed (the reason names only the parent path), so no input can plant a word in the output.
const shapeReasons = (res) => res.problems.map((p) => `invalid:shape_${p.code}@${(p.code === 'unknown_key' ? `${p.path.replace(/\/[^/]*$/, '')}/*` : p.path) || '/'}`);

/**
 * Validate ONE snapshot completely. -> { ok: true, normal } (a frozen normal form the classifier accepts) or
 * { ok: false, reasons: ['invalid:<code>@<where>', ...] }. Never throws.
 */
export function validateSnapshot(raw) {
  try {
    const first = validate(raw, SNAPSHOT_SHAPE, { maxProblems: 20 });
    if (!first.ok) return { ok: false, reasons: shapeReasons(first) };
    let s;
    try { s = structuredClone(raw); } catch { return { ok: false, reasons: ['invalid:unreadable@/'] }; }
    const second = validate(s, SNAPSHOT_SHAPE, { maxProblems: 20 });
    if (!second.ok) return { ok: false, reasons: shapeReasons(second) };
    const problems = semanticProblems(s);
    if (problems.length) return { ok: false, reasons: problems.slice(0, 50).map(([c, w]) => `invalid:${c}@${w}`) };
    const normal = deepFreeze({
      hash: s.provider_snapshot_sha256,
      rows: s.check_runs.map((r) => ({ id: r.id, name: r.name, app: r.app, external: r.binding === 'external', conclusion: r.conclusion, started_at: r.started_at, completed_at: r.completed_at,
        key: r.binding === 'bound' ? JSON.stringify([r.run_id, r.name]) : null, attempt: r.run_attempt, outside_r3: r.input_status === 'outside_r3',
        steps: r.job_inputs?.steps_state === 'array' ? r.job_inputs.steps.map((x) => ({ conclusion: x.conclusion })) : null, runner_name: r.job_inputs ? r.job_inputs.runner_name : null,
        annotation: { status: r.annotations.status, messages: r.annotations.messages.slice(), count: r.annotations.count, sha256: r.annotations.sha256 } })),
    });
    NORMAL.add(normal);
    return { ok: true, normal };
  } catch { return { ok: false, reasons: ['invalid:unreadable@/'] }; }
}

/** Seconds from started_at to completed_at, or null for anything but two strict UTC timestamps (real instants) in order. */
export function durationSeconds(start, end) {
  if (!isTimestamp(start) || !isTimestamp(end)) return null;
  const d = Date.parse(end) - Date.parse(start);
  return Number.isFinite(d) && d >= 0 ? d / 1000 : null;
}

/** JSON.parse that THROWS on a BOM, a duplicate object key (at any depth), depth > 64 and trailing text. */
export function parseStrictJson(text) {
  let i = 0;
  const fail = (m) => { throw new Error(m); };
  if (typeof text !== 'string') fail('not_text');
  if (text.charCodeAt(0) === 0xfeff) fail('bom');
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= text.length) fail('unterminated_string');
    return JSON.parse(text.slice(start, ++i));
  };
  const value = (depth) => {
    if (depth > 64) fail('too_deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      const o = {}, seen = new Set();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('key_expected');
        const k = str();
        if (seen.has(k)) fail('duplicate_key');
        seen.add(k); ws();
        if (text[i++] !== ':') fail('colon_expected');
        Object.defineProperty(o, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        const d = text[i++];
        if (d === '}') return o;
        if (d !== ',') fail('comma_expected');
      }
    }
    if (c === '[') {
      i++; ws();
      const a = [];
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value(depth + 1)); ws();
        const d = text[i++];
        if (d === ']') return a;
        if (d !== ',') fail('comma_expected');
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail('value_expected');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail('trailing_text');
  return v;
}

const verdictRow = (row, verdict, reasons, evidence = null) => ({ id: row.id, name: row.name, app: row.app, verdict, reasons, evidence });

/** One row of a normal form -> its verdict (+ the internal facts the fold needs). Total: every row gets one. */
function evaluateRow(row, rows) {
  const c = row.conclusion;
  if (row.external) {
    if (c === 'success') return { ...verdictRow(row, 'outside_classifier', []), benign: true };
    if (NOT_EXECUTED.includes(c)) return { ...verdictRow(row, 'outside_classifier', [`external_check_${c}`]), tolerated: true };
    return { ...verdictRow(row, 'external_failure', [`external_check_${c}`]), external_failure: true };
  }
  if (c === 'success') return { ...verdictRow(row, 'not_failed', []), benign: true };
  // any other outcome is CLEARED only by a strictly later attempt of the same (run_id, name) that succeeded
  const clearer = rows.filter((r) => r.key === row.key && r.attempt > row.attempt && r.conclusion === 'success').map((r) => r.attempt).sort((a, b) => a - b)[0];
  if (clearer !== undefined) return { ...verdictRow(row, 'superseded', [`cleared_by_success_attempt_${clearer}`]), benign: true };
  if (!failedConclusion(c)) return { ...verdictRow(row, row.outside_r3 ? 'outside_r3' : 'not_failed', [`latest_conclusion_${c}`]), tolerated: true };
  const executed = row.steps.filter((x) => x.conclusion !== 'skipped').length;
  const seconds = durationSeconds(row.started_at, row.completed_at);
  const ann = row.annotation;
  const evidence = { conclusion: c, duration_seconds: seconds, steps_total: row.steps.length, steps_executed: executed, runner_name: row.runner_name,
    annotation_status: ann.status, annotation_count: ann.count, annotation_sha256: ann.sha256 };
  if (executed > 0) return { ...verdictRow(row, 'executed_failure', ['steps_executed'], evidence), executed: true };
  const failed = [];
  if (row.app !== 'github-actions') failed.push('R1_app_not_github_actions');
  if (!BILLING_CONCLUSIONS.includes(c)) failed.push('R2_conclusion_not_failure_or_startup_failure');
  if (seconds === null) failed.push('R2_duration_unknown');
  else if (seconds > BILLING_MAX_SECONDS) failed.push('R2_duration_over_threshold');
  if (row.runner_name !== '') failed.push('R3_runner_name_not_empty');
  if (ann.status !== 'present' || ann.messages.length === 0 || !ann.messages.every((m) => BILLING_ANNOTATION_ALLOWLIST.includes(m))) failed.push('R4_annotation_not_allowlisted');
  return failed.length ? { ...verdictRow(row, 'unclassified_failure', failed, evidence), unclassified: true } : { ...verdictRow(row, 'billing', ['R1', 'R2', 'R3', 'R4'], evidence), billing: true };
}

/** The precedence table, over EVERY evaluated row (see the header). */
function decide(evaluated) {
  const pick = (f) => evaluated.filter((r) => r[f] === true);
  const executed = pick('executed'), billing = pick('billing'), external = pick('external_failure'), unclassified = pick('unclassified'), tolerated = pick('tolerated');
  const note = (label, list) => list.map((r) => `${label}:${r.id}`);
  const all = [...note('executed_failure', executed), ...note('external_failure', external), ...note('not_classified', unclassified), ...note('billing', billing), ...note('not_success', tolerated)];
  if (executed.length) return [billing.length ? 'ci_mixed_execution' : 'failed_code', all];
  if (external.length) return ['unavailable', all];
  if (unclassified.length) return ['unavailable', all];
  if (billing.length) return ['billing_blocked', all];
  if (evaluated.length > 0 && evaluated.every((r) => r.benign === true)) return ['no_failure_observed', all];
  return ['unavailable', all];
}

function finish(classification, reasons, rows, hash) {
  const { ci_state, code } = CLASSIFICATIONS[classification];
  return { schema: SCHEMA, advisory: true, classification, ci_state, code, reasons, snapshot_sha256: hash,
    billing_allowlist_version: BILLING_ALLOWLIST_VERSION, billing_max_seconds: BILLING_MAX_SECONDS, not_asserted: NOT_ASSERTED.slice(), note: NOTE, rows };
}

/** Classify a VALIDATED normal form. Anything validateSnapshot did not produce is refused (`unavailable`). */
export function classifyNormal(normal) {
  if (!NORMAL.has(normal)) return finish('unavailable', ['invalid:not_a_validated_normal_form@/'], [], null);
  const evaluated = normal.rows.map((r) => evaluateRow(r, normal.rows));
  const [classification, reasons] = decide(evaluated);
  return finish(classification, reasons, evaluated.map(({ id, name, app, verdict, reasons: why, evidence }) => ({ id, name, app, verdict, reasons: why, evidence })), normal.hash);
}

/** The pure core: one snapshot (any value) -> one advisory classification. Validate first, classify second. */
export function classifySnapshot(raw) {
  const v = validateSnapshot(raw);
  if (!v.ok) return finish('unavailable', v.reasons, [], null);
  try { return classifyNormal(v.normal); } catch { return finish('unavailable', ['classifier_internal_error'], [], null); }
}

function readInput(file, readStdin) {
  const bytes = file === '-' ? readStdin() : readFileSync(file);
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  if (buf.length > MAX_INPUT_BYTES) throw new Error('too_large');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { throw new Error('not_utf8'); }
  return parseStrictJson(text);
}

export function main(argv, { readStdin = () => readFileSync(0) } = {}) {
  const [cmd, flag, file, ...rest] = argv;
  if (cmd !== 'classify' || flag !== '--snapshot-json' || !file || rest.length) {
    process.stderr.write('Usage: ci-classify.mjs classify --snapshot-json <file|->\n');
    return 2;
  }
  let result, status = 1;
  try {
    let snapshot;
    try { snapshot = readInput(file, readStdin); } catch (e) { result = finish('unavailable', [`snapshot_json_unreadable:${/^[a-z0-9_]+$/.test(String(e?.message)) ? e.message : 'invalid_json'}`], [], null); status = 3; }
    result ??= classifySnapshot(snapshot);
  } catch { result = finish('unavailable', ['classifier_internal_error'], [], null); status = 3; }
  process.stdout.write(JSON.stringify(result) + '\n');
  return status;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
