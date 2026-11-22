#!/usr/bin/env node
/**
 * Advisory CI failure classifier (ASTF-39, S-05b). Maps ONE `snapshot_valid` S-05a snapshot (ci-snapshot.mjs) to exactly
 * one classification, by the rules R1-R6 of cons:F 1.3. Pure: no fetching, no git, node built-ins only.
 *
 *   ci-classify.mjs classify --snapshot-json <file|->     (the JSON line printed by `ci-snapshot.mjs check`)
 *
 * ADVISORY, NOT A GATE. The output (schema `ci-classification-v1`) is an INPUT to later slices, never a result:
 *   classification   failed_code | ci_mixed_execution | billing_blocked | unavailable | no_failure_observed
 *   ci_state         FAIL | UNAVAILABLE | NOT_CLASSIFIED   (nothing else, ever: no pass, no waive, no eligible)
 * This module NEVER emits CI_PASSED, a pass, a waiver or LOCAL_CI_VERIFIED, and carries no fallback-eligibility field.
 * A snapshot without a failure is `no_failure_observed` / NOT_CLASSIFIED: the snapshot does not attest the required-check
 * policy (ci-snapshot.mjs NOT_ATTESTED), so "CI passed" cannot be derived here. A failed required check classified
 * billing_blocked stays `ci_state: UNAVAILABLE`: the only authorised fallback (complete local CI evidence, merge basis
 * CI_BILLING_BLOCKED + LOCAL_CI_VERIFIED) remains owned by the existing rule (references/ship.md) and its later slices.
 * Consumers act only on an exact expected classification and treat an unknown or missing field as not classified.
 *
 * Rules (a positive conjunction, fail-closed; a code failure can never be reclassified as billing):
 *   R5 (first)  any non-superseded Actions job with a failure-class conclusion that EXECUTED a step => FAIL / ci_failed;
 *               billing is not consulted for that job. Together with billing jobs: ci_mixed_execution (FAIL).
 *   R1  the producing app is GitHub Actions (`github-actions`).
 *   R2  conclusion is failure or startup_failure AND started_at..completed_at <= BILLING_MAX_SECONDS.
 *   R3  steps is an ARRAY that is empty or all skipped AND runner_name is the empty string; missing/null/unbound is UNKNOWN.
 *   R4  every annotation message is EXACTLY a member of the versioned allowlist (no trimming, no substring match).
 *   R6  non-Actions checks (a cancelled CodeRabbit, a skipped preview) are outside the classifier and never billing.
 * Any row that fails a rule without being an executed failure makes the whole result `unavailable`.
 *
 * PROVISIONAL PARAMETER: BILLING_MAX_SECONDS = 10 is an ESTIMATE (cons:F 1.3 "proposed threshold"). It rests on ONE
 * incident (SCRUM-202: 1-2 s, n = 1). Too low gives `unavailable` (fail-closed, the owner waits); too high is guarded by
 * R1, R3, R4 and R5, and a code failure always executes steps. Re-measure at the next real billing incident before
 * changing it; the test pins the value so a change is a deliberate edit.
 *
 * CLI exit: NEVER 0. Every ci-classification-v1 classification exits 1 (so `ci-classify ... && next` can never proceed), 2 is
 * usage, 3 is unreadable input (not JSON, duplicate JSON keys, too deep) or an internal error; the stdout line carries the data.
 * Every output carries `note`: "Required checks unverified; no gate decision." The exit code is never a merge signal.
 * Input hardening: JSON text is parsed by parseStrictJson, which refuses duplicate keys at parse time; rows with a duplicate
 * or malformed id, a status other than completed, a conclusion that disagrees with their job, or a snapshot without a 64-hex
 * provider_snapshot_sha256 are `unavailable`. A non-Actions check beside billing rows may only be cancelled or non-failing;
 * a failed, timed_out, action_required, startup_failure or stale one makes the result `unavailable`. A failure that EXECUTED
 * steps and was superseded by a failing attempt is still reported (it is never hidden behind a billing-shaped retry).
 */
import { readFileSync } from 'node:fs';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'ci-classification-v1';
export const SNAPSHOT_SCHEMA = 'ci-snapshot-v1';
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

const NOT_FAILURE = ['success', 'neutral', 'skipped'];
const BILLING_CONCLUSIONS = ['failure', 'startup_failure'];
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Seconds from started_at to completed_at, or null for anything but two strict UTC timestamps in order. */
export function durationSeconds(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string' || !TS.test(start) || !TS.test(end)) return null;
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0, 19) !== start.slice(0, 19) || new Date(b).toISOString().slice(0, 19) !== end.slice(0, 19)) return null;
  return b >= a ? (b - a) / 1000 : null;
}

/** JSON.parse that THROWS on a duplicate object key (checked while parsing the raw text, which JSON.parse cannot do), on depth > 64 and on trailing text. */
export function parseStrictJson(text) {
  let i = 0;
  const fail = (m) => { throw new Error(m); };
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

const verdictRow = (row, verdict, reasons = [], evidence = null) => ({ id: row?.id ?? null, name: row?.name ?? null, app: row?.app ?? null, verdict, reasons, evidence });

function evaluateRow(row, all) {
  if (!isObj(row)) return verdictRow(null, 'unknown', ['row_not_an_object']);
  if (typeof row.id !== 'string' || !/^(0|[1-9]\d*)$/.test(row.id)) return verdictRow(row, 'unknown', ['row_id_invalid']);
  if (row.status !== 'completed') return verdictRow(row, 'unknown', ['row_not_completed']);
  if (row.binding === 'external') {
    if (typeof row.app !== 'string' || row.app === '' || row.app === 'github-actions') return verdictRow(row, 'unknown', ['external_app_invalid']);
    if (NOT_FAILURE.includes(row.conclusion)) return verdictRow(row, 'outside_classifier');
    if (row.conclusion === 'cancelled') return verdictRow(row, 'outside_classifier', ['external_check_cancelled']);
    return verdictRow(row, 'unclassified_failure', [`external_check_${String(row.conclusion)}`]);
  }
  if (row.binding !== 'bound') return verdictRow(row, 'unknown', ['row_not_bound']);
  if (row.input_status === 'outside_r3') return row.conclusion === 'skipped' ? verdictRow(row, 'outside_r3') : verdictRow(row, 'unknown', ['outside_r3_not_skipped']);
  if (row.input_status !== 'ok') return verdictRow(row, 'unknown', [`input_status_${String(row.input_status)}`]);
  if (typeof row.conclusion !== 'string') return verdictRow(row, 'unknown', ['conclusion_missing']);
  if (!isObj(row.job_inputs) || row.job_inputs.conclusion !== row.conclusion) return verdictRow(row, 'unknown', ['conclusion_inconsistent']);
  if (NOT_FAILURE.includes(row.conclusion)) return verdictRow(row, 'not_failed');
  if (row.supersession === 'superseded') {
    if (!(Number.isSafeInteger(row.superseded_by_attempt) && Number.isSafeInteger(row.run_attempt) && row.superseded_by_attempt > row.run_attempt)) return verdictRow(row, 'unknown', ['supersession_unproven']);
    const by = all.find((r) => isObj(r) && r.binding === 'bound' && r.run_id === row.run_id && r.name === row.name && r.run_attempt === row.superseded_by_attempt);
    if (!by) return verdictRow(row, 'unknown', ['superseding_row_missing']);
    if (NOT_FAILURE.includes(by.conclusion)) return verdictRow(row, 'superseded');
    const old = row.job_inputs, listed = isObj(old) && old.steps_state === 'array' && Array.isArray(old.steps) && old.steps.every((s) => isObj(s) && s.malformed !== true);
    if (!listed) return verdictRow(row, 'unknown', ['superseded_failure_steps_unknown']);
    return old.steps.some((s) => s.conclusion !== 'skipped') ? verdictRow(row, 'executed_failure', ['superseded_executed_failure_not_cleared']) : verdictRow(row, 'superseded');
  }
  const inp = row.job_inputs;
  if (!isObj(inp) || inp.steps_state !== 'array' || !Array.isArray(inp.steps) || inp.steps.some((s) => !isObj(s) || s.malformed === true)) return verdictRow(row, 'unknown', ['steps_unknown']);
  if (inp.runner_name_state !== 'string' || typeof inp.runner_name !== 'string') return verdictRow(row, 'unknown', ['runner_name_unknown']);
  const executed = inp.steps.filter((s) => s.conclusion !== 'skipped').length;
  const seconds = durationSeconds(row.started_at, row.completed_at);
  const ann = isObj(row.annotations) ? row.annotations : {};
  const evidence = { conclusion: row.conclusion, duration_seconds: seconds, steps_total: inp.steps.length, steps_executed: executed, runner_name: inp.runner_name,
    annotation_status: typeof ann.status === 'string' ? ann.status : null, annotation_count: Number.isSafeInteger(ann.count) ? ann.count : null, annotation_sha256: typeof ann.sha256 === 'string' ? ann.sha256 : null };
  if (executed > 0) return verdictRow(row, 'executed_failure', ['steps_executed'], evidence);
  const failed = [];
  if (row.app !== 'github-actions') failed.push('R1_app_not_github_actions');
  if (!BILLING_CONCLUSIONS.includes(row.conclusion)) failed.push('R2_conclusion_not_failure_or_startup_failure');
  if (seconds === null) failed.push('R2_duration_unknown');
  else if (seconds > BILLING_MAX_SECONDS) failed.push('R2_duration_over_threshold');
  if (inp.runner_name !== '') failed.push('R3_runner_name_not_empty');
  if (ann.status !== 'present' || !Array.isArray(ann.messages) || ann.messages.length === 0 || !ann.messages.every((m) => BILLING_ANNOTATION_ALLOWLIST.includes(m))) failed.push('R4_annotation_not_allowlisted');
  return failed.length ? verdictRow(row, 'unclassified_failure', failed, evidence) : verdictRow(row, 'billing', ['R1', 'R2', 'R3', 'R4'], evidence);
}

function finish(classification, reasons, rows, snapshot) {
  const { ci_state, code } = CLASSIFICATIONS[classification];
  return { schema: SCHEMA, advisory: true, classification, ci_state, code, reasons, snapshot_sha256: typeof snapshot?.provider_snapshot_sha256 === 'string' ? snapshot.provider_snapshot_sha256 : null,
    billing_allowlist_version: BILLING_ALLOWLIST_VERSION, billing_max_seconds: BILLING_MAX_SECONDS, not_asserted: NOT_ASSERTED.slice(), note: NOTE, rows };
}

/** The pure core: one snapshot object -> one advisory classification. Anything but a snapshot_valid snapshot is `unavailable`. */
export function classifySnapshot(snapshot) {
  if (!isObj(snapshot)) return finish('unavailable', ['snapshot_not_an_object'], [], null);
  if (snapshot.schema !== SNAPSHOT_SCHEMA) return finish('unavailable', ['snapshot_schema_unknown'], [], snapshot);
  if (snapshot.state !== 'snapshot_valid' || snapshot.internally_consistent !== true) return finish('unavailable', [`snapshot_state_${String(snapshot.state)}`], [], snapshot);
  if (!Array.isArray(snapshot.check_runs) || snapshot.check_runs.length === 0) return finish('unavailable', ['snapshot_has_no_check_runs'], [], snapshot);
  if (!/^[0-9a-f]{64}$/.test(String(snapshot.provider_snapshot_sha256))) return finish('unavailable', ['snapshot_hash_invalid'], [], snapshot);
  const ids = snapshot.check_runs.map((r) => (isObj(r) ? r.id : null));
  if (new Set(ids).size !== ids.length) return finish('unavailable', ['snapshot_duplicate_row_id'], [], snapshot);
  const rows = snapshot.check_runs.map((r) => evaluateRow(r, snapshot.check_runs));
  const by = (v) => rows.filter((r) => r.verdict === v);
  const executed = by('executed_failure'), billing = by('billing');
  const bad = rows.filter((r) => r.verdict === 'unknown' || r.verdict === 'unclassified_failure');
  const external = rows.filter((r) => r.verdict === 'outside_classifier' && r.reasons.length > 0);
  const note = (label, list) => list.map((r) => `${label}:${r.id}`);
  if (executed.length) {
    return finish(billing.length ? 'ci_mixed_execution' : 'failed_code', [...note('executed_failure', executed), ...note('billing', billing), ...note('not_classified', bad)], rows, snapshot);
  }
  if (bad.length) return finish('unavailable', note('not_classified', bad), rows, snapshot);
  if (billing.length) return finish('billing_blocked', [...note('billing', billing), ...note('outside_classifier', external)], rows, snapshot);
  if (external.length) return finish('unavailable', note('external_check_not_success', external), rows, snapshot);
  return finish('no_failure_observed', [], rows, snapshot);
}

export function main(argv, { readStdin = () => readFileSync(0, 'utf8') } = {}) {
  const [cmd, flag, file, ...rest] = argv;
  if (cmd !== 'classify' || flag !== '--snapshot-json' || !file || rest.length) {
    process.stderr.write('Usage: ci-classify.mjs classify --snapshot-json <file|->\n');
    return 2;
  }
  let result, status = 1;
  try {
    let snapshot = null;
    try { snapshot = parseStrictJson(file === '-' ? readStdin() : readFileSync(file, 'utf8')); } catch (e) { result = finish('unavailable', [`snapshot_json_unreadable:${/^[a-z_]+$/.test(String(e?.message)) ? e.message : 'invalid_json'}`], [], null); status = 3; }
    result ??= classifySnapshot(snapshot);
  } catch { result = finish('unavailable', ['classifier_internal_error'], [], null); status = 3; }
  process.stdout.write(JSON.stringify(result) + '\n');
  return status;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
