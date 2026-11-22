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
 * CLI exit: 0 only for `no_failure_observed` (which is NOT a pass), 1 for every other classification or unreadable input,
 * 2 usage. The exit code is never a merge signal.
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
export const NOT_ASSERTED = Object.freeze(['CI_PASSED', 'required_check_policy', 'LOCAL_CI_VERIFIED', 'fallback_eligibility']);

const NOT_FAILURE = ['success', 'neutral', 'skipped'];
const BILLING_CONCLUSIONS = ['failure', 'startup_failure'];
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Seconds from started_at to completed_at, or null for anything but two strict UTC timestamps in order. */
export function durationSeconds(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string' || !TS.test(start) || !TS.test(end)) return null;
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

const verdictRow = (row, verdict, reasons = [], evidence = null) => ({ id: row?.id ?? null, name: row?.name ?? null, app: row?.app ?? null, verdict, reasons, evidence });

function evaluateRow(row) {
  if (!isObj(row)) return verdictRow(null, 'unknown', ['row_not_an_object']);
  if (row.binding === 'external') {
    return NOT_FAILURE.includes(row.conclusion) ? verdictRow(row, 'outside_classifier') : verdictRow(row, 'outside_classifier', ['external_check_not_success']);
  }
  if (row.binding !== 'bound') return verdictRow(row, 'unknown', ['row_not_bound']);
  if (row.input_status === 'outside_r3') return row.conclusion === 'skipped' ? verdictRow(row, 'outside_r3') : verdictRow(row, 'unknown', ['outside_r3_not_skipped']);
  if (row.input_status !== 'ok') return verdictRow(row, 'unknown', [`input_status_${String(row.input_status)}`]);
  if (typeof row.conclusion !== 'string') return verdictRow(row, 'unknown', ['conclusion_missing']);
  if (NOT_FAILURE.includes(row.conclusion)) return verdictRow(row, 'ok');
  if (row.supersession === 'superseded') {
    return Number.isSafeInteger(row.superseded_by_attempt) && Number.isSafeInteger(row.run_attempt) && row.superseded_by_attempt > row.run_attempt
      ? verdictRow(row, 'superseded') : verdictRow(row, 'unknown', ['supersession_unproven']);
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
    billing_allowlist_version: BILLING_ALLOWLIST_VERSION, billing_max_seconds: BILLING_MAX_SECONDS, not_asserted: NOT_ASSERTED.slice(), rows };
}

/** The pure core: one snapshot object -> one advisory classification. Anything but a snapshot_valid snapshot is `unavailable`. */
export function classifySnapshot(snapshot) {
  if (!isObj(snapshot)) return finish('unavailable', ['snapshot_not_an_object'], [], null);
  if (snapshot.schema !== SNAPSHOT_SCHEMA) return finish('unavailable', ['snapshot_schema_unknown'], [], snapshot);
  if (snapshot.state !== 'snapshot_valid' || snapshot.internally_consistent !== true) return finish('unavailable', [`snapshot_state_${String(snapshot.state)}`], [], snapshot);
  if (!Array.isArray(snapshot.check_runs) || snapshot.check_runs.length === 0) return finish('unavailable', ['snapshot_has_no_check_runs'], [], snapshot);
  const rows = snapshot.check_runs.map(evaluateRow);
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
  let snapshot = null, problem = null;
  try { snapshot = JSON.parse(file === '-' ? readStdin() : readFileSync(file, 'utf8')); } catch { problem = 'snapshot_json_unreadable'; }
  const result = problem ? finish('unavailable', [problem], [], null) : classifySnapshot(snapshot);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.classification === 'no_failure_observed' ? 0 : 1;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
