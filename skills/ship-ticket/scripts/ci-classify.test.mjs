// Advisory CI failure classifier (ASTF-39, S-05b). Every snapshot here is SYNTHETIC (invented ids, repo acme/widgets); the one
// real input is the committed SCRUM-202 jobs fixture, used only to replay the R2 threshold over observed durations.
// Tests assert a positive signal (an exact classification, state or reason), never the absence of an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, readSnapshot } from './ci-snapshot.mjs';
import { classifySnapshot, durationSeconds, parseStrictJson, main, NOTE, BILLING_MAX_SECONDS, BILLING_ALLOWLIST_VERSION, BILLING_ANNOTATION_ALLOWLIST, CLASSIFICATIONS, CI_STATES, SCHEMA } from './ci-classify.mjs';
import { classify as classifyMutant, loadMutationSource, runMutant as runTreeMutant } from './lib/mutation.test-helper.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, 'ci-classify.mjs');
const REAL_FIXTURE = join(HERE, 'fixtures', 'ci-snapshot', 'scrum202-abf4d7ea-actions-jobs.jsonl');
const REPLICA = join(HERE, 'fixtures', 'ci-classify', 'synthetic-linked-abf4d7ea');
const REPO = 'acme/widgets', ORIGIN = 'https://api.github.com', SHA = 'abf4d7ea' + 'ab'.repeat(16);
const BILL = BILLING_ANNOTATION_ALLOWLIST[0];
const BILL_TEXT = 'The job was not started because recent account payments have failed or your spending limit needs to be increased.';
const url = (id) => `${ORIGIN}/repos/${REPO}/check-runs/${id}`;
const nl = (items) => [{ total_count: items.length }, ...items].map((x) => JSON.stringify(x)).join('\n') + '\n';
const ts = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString().replace('.000Z', 'Z');
const STEP = { name: 'run', status: 'completed', conclusion: 'success', number: 1 };

/**
 * spec: { id, name, conclusion, steps, runner, secs, ann, run, attempt, app, noJob }. Defaults describe one billing-shaped failure.
 * -> the S-05a snapshot (the real builder, so every row carries the real input_status / supersession / annotations fields).
 */
function snap(specs, over = {}) {
  const checks = [], jobs = {}, annotations = {};
  for (const sp of specs) {
    const s = { name: 'verify', conclusion: 'failure', steps: [], runner: '', secs: 2, ann: [BILL], run: 100, attempt: 1, app: 'github-actions', ...sp };
    const check = { id: s.id, name: s.name, head_sha: SHA, status: 'completed', conclusion: s.conclusion, started_at: ts(0), completed_at: ts(s.secs), url: url(s.id), app: { slug: s.app }, output: { annotations_count: s.ann.length } };
    checks.push(check);
    if (s.app === 'github-actions') {
      const j = { id: s.id, name: s.name, run_id: s.run, run_attempt: s.attempt, head_sha: SHA, status: 'completed', conclusion: s.conclusion, started_at: ts(0), completed_at: ts(s.secs), runner_name: s.runner, check_run_url: url(s.id) };
      if (s.steps !== undefined) j.steps = s.steps;
      (jobs[`run${s.run}-${s.attempt}.jsonl`] ??= []).push(j);
    }
    if (s.ann.length) annotations[`${s.id}.jsonl`] = s.ann.map((message) => JSON.stringify({ message })).join('\n') + '\n';
  }
  const texts = { checkRuns: nl(checks), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, nl(v)])), annotations, problems: [] };
  return buildSnapshot({ texts: { ...texts, ...over }, repo: REPO, sha: SHA, origin: ORIGIN });
}
const six = () => [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, name: `job${i}` }));
const rowOf = (res, id) => res.rows.find((r) => r.id === String(id));

test('the builders produce snapshot_valid snapshots (baseline for every case below)', () => {
  const s = snap(six());
  assert.equal(s.state, 'snapshot_valid');
  assert.equal(s.check_runs.length, 6);
});

// ---- the 11-case RED table (package PLAN-S05bc, S-05b) ----
test('1: six Actions jobs, steps [], runner "", 1-2 s, exact billing annotation -> billing_blocked (UNAVAILABLE, never pass)', () => {
  const r = classifySnapshot(snap(six().map((s, i) => ({ ...s, secs: 1 + (i % 2) }))));
  assert.equal(r.classification, 'billing_blocked');
  assert.equal(r.ci_state, 'UNAVAILABLE');
  assert.equal(r.code, 'ci_billing_blocked');
  assert.equal(r.schema, SCHEMA);
  assert.equal(r.advisory, true);
  assert.equal(r.rows.filter((x) => x.verdict === 'billing').length, 6);
  assert.deepEqual(rowOf(r, 1).evidence, { conclusion: 'failure', duration_seconds: 1, steps_total: 0, steps_executed: 0, runner_name: '', annotation_status: 'present', annotation_count: 1, annotation_sha256: rowOf(r, 1).evidence.annotation_sha256 });
  assert.match(rowOf(r, 1).evidence.annotation_sha256, /^[0-9a-f]{64}$/);
  assert.match(r.snapshot_sha256, /^[0-9a-f]{64}$/);
});

test('2: one job with steps > 0 and conclusion failure -> failed_code (FAIL), billing never consulted for it', () => {
  const r = classifySnapshot(snap([{ id: 1, steps: [STEP], secs: 90 }]));
  assert.equal(r.classification, 'failed_code');
  assert.equal(r.ci_state, 'FAIL');
  assert.equal(r.code, 'ci_failed');
  assert.equal(rowOf(r, 1).verdict, 'executed_failure');
  assert.equal(rowOf(r, 1).evidence.steps_executed, 1);
});

test('3: one executed failure plus five billing jobs -> ci_mixed_execution (FAIL)', () => {
  const r = classifySnapshot(snap([{ id: 1, name: 'unit', steps: [STEP], secs: 60 }, ...[2, 3, 4, 5, 6].map((i) => ({ id: i, name: `job${i}` }))]));
  assert.equal(r.classification, 'ci_mixed_execution');
  assert.equal(r.ci_state, 'FAIL');
  assert.equal(r.rows.filter((x) => x.verdict === 'billing').length, 5);
  assert.equal(rowOf(r, 1).verdict, 'executed_failure');
});

test('4: annotation text differing by one character, or with extra text, or CRLF-terminated -> unavailable', () => {
  for (const [label, ann] of [['one char', [BILL.replace('failed', 'faild')]], ['trailing dot dropped', [BILL.slice(0, -1)]], ['extra text', [`${BILL} Contact support.`]], ['CRLF suffix', [`${BILL}\r\n`]],
    ['second message extra', [BILL, 'something else']], ['upper-cased', [BILL.toUpperCase()]]]) {
    const r = classifySnapshot(snap([{ id: 1, ann }]));
    assert.equal(r.classification, 'unavailable', label);
    assert.equal(r.ci_state, 'UNAVAILABLE', label);
    assert.ok(rowOf(r, 1).reasons.includes('R4_annotation_not_allowlisted'), label);
  }
  // R1: a failure-class row whose app is not github-actions (forged binding fields) is never billing
  const g = snap(six());
  const notActions = classifySnapshot({ ...g, check_runs: [{ ...g.check_runs[0], app: 'other-app' }, ...g.check_runs.slice(1)] });
  assert.equal(notActions.classification, 'unavailable');
  assert.ok(notActions.rows[0].reasons.includes('R1_app_not_github_actions'));
  // R3: a non-empty runner_name means a runner picked the job up: never billing
  const ran = classifySnapshot({ ...g, check_runs: [{ ...g.check_runs[0], job_inputs: { ...g.check_runs[0].job_inputs, runner_name: 'GitHub Actions 7', runner_name_state: 'string' } }, ...g.check_runs.slice(1)] });
  assert.equal(ran.classification, 'unavailable');
  assert.ok(ran.rows[0].reasons.includes('R3_runner_name_not_empty'));
  // R3: steps that are all skipped count as zero executed; one executed (non-skipped) step is an executed failure
  const skipStep = { name: 'x', status: 'completed', conclusion: 'skipped', number: 1 };
  assert.equal(classifySnapshot(snap([{ id: 1, steps: [skipStep] }])).classification, 'billing_blocked');
  assert.equal(classifySnapshot(snap([{ id: 1, steps: [skipStep, STEP] }])).classification, 'failed_code');
  // one job with a wrong annotation beside five genuine billing jobs: the whole result is unavailable, billing is not claimed
  const some = classifySnapshot(snap([{ id: 1, ann: ['other text'] }, ...six().slice(1)]));
  assert.equal(some.classification, 'unavailable');
  assert.equal(some.rows.filter((x) => x.verdict === 'billing').length, 5);
});

test('5 (Neg1): a forged billing annotation on a job with steps > 0 -> failed_code, not billing', () => {
  const r = classifySnapshot(snap([{ id: 1, steps: [STEP], secs: 1, ann: [BILL] }]));
  assert.equal(r.classification, 'failed_code');
  assert.equal(rowOf(r, 1).verdict, 'executed_failure');
  assert.ok(!r.rows.some((x) => x.verdict === 'billing'));
});

test('6: duration 11 s is never billing; a non-Actions app (CodeRabbit cancelled) is never billing', () => {
  const slow = classifySnapshot(snap([{ id: 1, secs: BILLING_MAX_SECONDS + 1 }]));
  assert.equal(slow.classification, 'unavailable');
  assert.ok(rowOf(slow, 1).reasons.includes('R2_duration_over_threshold'));
  const ext = classifySnapshot(snap([{ id: 1, app: 'coderabbitai', conclusion: 'cancelled', steps: undefined, ann: [BILL], secs: 1 }]));
  assert.equal(ext.classification, 'unavailable');
  assert.equal(rowOf(ext, 1).verdict, 'outside_classifier');
  assert.ok(!ext.rows.some((x) => x.verdict === 'billing'));
  // alongside genuine billing jobs the cancelled external check is listed but changes nothing
  const mixed = classifySnapshot(snap([...six(), { id: 7, name: 'review', app: 'coderabbitai', conclusion: 'cancelled', steps: undefined, ann: [], secs: 3 }]));
  assert.equal(mixed.classification, 'billing_blocked');
  assert.ok(mixed.reasons.includes('outside_classifier:7'));
  for (const c of ['success', 'neutral', 'skipped']) assert.equal(classifySnapshot(snap([...six(), { id: 7, name: 'review', app: 'coderabbitai', conclusion: c, steps: undefined, ann: [], secs: 3 }])).classification, 'billing_blocked', c);
});

test('M1: a non-Actions check that FAILED beside billing rows is never billing_blocked (one case per failing conclusion)', () => {
  for (const c of ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    const r = classifySnapshot(snap([...six(), { id: 7, name: 'review', app: 'coderabbitai', conclusion: c, steps: undefined, ann: [], secs: 3 }]));
    assert.equal(r.classification, 'unavailable', c);
    assert.equal(r.ci_state, 'UNAVAILABLE', c);
    assert.ok(r.reasons.includes('not_classified:7'), c);
    assert.deepEqual(rowOf(r, 7).reasons, [`external_check_${c}`], c);
    assert.equal(classifySnapshot(snap([{ id: 7, name: 'review', app: 'coderabbitai', conclusion: c, steps: undefined, ann: [], secs: 3 }])).classification, 'unavailable', `${c} alone`);
  }
  // an executed Actions failure still decides FAIL
  assert.equal(classifySnapshot(snap([{ id: 1, steps: [STEP], secs: 60 }, { id: 7, name: 'review', app: 'coderabbitai', conclusion: 'failure', steps: undefined, ann: [], secs: 3 }])).classification, 'failed_code');
});

test('M2: an executed failure superseded by a billing-shaped retry is never hidden behind billing_blocked', () => {
  const hidden = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, secs: 2 }]);
  assert.equal(hidden.state, 'snapshot_valid');
  assert.equal(hidden.check_runs[0].supersession, 'superseded');
  const r = classifySnapshot(hidden);
  assert.equal(r.classification, 'ci_mixed_execution');
  assert.equal(r.ci_state, 'FAIL');
  assert.equal(rowOf(r, 1).verdict, 'executed_failure');
  assert.deepEqual(rowOf(r, 1).reasons, ['superseded_executed_failure_not_cleared']);
  // superseded by a failing executed retry: still failed_code
  assert.equal(classifySnapshot(snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, steps: [STEP], secs: 70 }])).classification, 'failed_code');
  // a zero-step billing attempt superseded by another billing attempt: the earlier one is excluded, the latest decides
  const twice = classifySnapshot(snap([{ id: 1, attempt: 1 }, { id: 2, attempt: 2 }]));
  assert.equal(twice.classification, 'billing_blocked');
  assert.equal(rowOf(twice, 1).verdict, 'superseded');
  // steps of the superseded failure not listed: unknown, never superseded
  const s = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, secs: 2 }]);
  const noSteps = { ...s, check_runs: [{ ...s.check_runs[0], job_inputs: { ...s.check_runs[0].job_inputs, steps_state: 'null', steps: null } }, s.check_runs[1]] };
  assert.equal(classifySnapshot(noSteps).classification, 'unavailable');
  assert.deepEqual(rowOf(classifySnapshot(noSteps), 1).reasons, ['superseded_failure_steps_unknown']);
  const gone = { ...s, check_runs: [s.check_runs[0]] };
  assert.deepEqual(rowOf(classifySnapshot(gone), 1).reasons, ['superseding_row_missing']);
});

test('defence in depth: duplicate row ids, a missing or malformed snapshot hash, inconsistent rows and an external row claiming github-actions are unavailable', () => {
  const g = snap(six());
  const dup = classifySnapshot({ ...g, check_runs: [...g.check_runs, g.check_runs[0]] });
  assert.deepEqual(dup.reasons, ['snapshot_duplicate_row_id']);
  assert.equal(dup.classification, 'unavailable');
  for (const h of [null, 'abc', 'A'.repeat(64), 'g'.repeat(64), undefined]) assert.deepEqual(classifySnapshot({ ...g, provider_snapshot_sha256: h }).reasons, ['snapshot_hash_invalid']);
  const patch = (o) => classifySnapshot({ ...g, check_runs: [{ ...g.check_runs[0], ...o }, ...g.check_runs.slice(1)] }).rows[0].reasons;
  assert.deepEqual(patch({ conclusion: 'success' }), ['conclusion_inconsistent']);
  assert.deepEqual(patch({ status: 'in_progress' }), ['row_not_completed']);
  assert.deepEqual(patch({ id: '007' }), ['row_id_invalid']);
  assert.deepEqual(patch({ id: 7 }), ['row_id_invalid']);
  assert.deepEqual(patch({ binding: 'external', app: 'github-actions' }), ['external_app_invalid']);
  assert.deepEqual(patch({ binding: 'external', app: null }), ['external_app_invalid']);
});

test('impossible calendar dates are not durations (30 Feb, month 13, hour 24)', () => {
  for (const [a, b] of [['2026-02-30T00:00:00Z', '2026-02-30T00:00:05Z'], ['2026-13-01T00:00:00Z', '2026-13-01T00:00:05Z'], ['2026-01-01T24:00:00Z', '2026-01-01T24:00:05Z'], ['2026-02-29T00:00:00Z', '2026-02-29T00:00:05Z']]) assert.equal(durationSeconds(a, b), null, a);
  assert.equal(durationSeconds('2028-02-29T00:00:00Z', '2028-02-29T00:00:05Z'), 5);
});

test('7: refuse and report unavailable (never pass) for a snapshot that is not snapshot_valid, or a row that is not fully known', () => {
  const good = snap(six());
  for (const [label, s] of [
    ['incomplete state', { ...good, state: 'incomplete', internally_consistent: false }],
    ['invalid state', { ...good, state: 'invalid', internally_consistent: false, provider_snapshot_sha256: null }],
    ['empty state', { ...good, state: 'empty', internally_consistent: false }],
    ['valid state but not internally_consistent', { ...good, internally_consistent: false }],
    ['unknown schema', { ...good, schema: 'ci-snapshot-v0' }],
    ['no check runs', { ...good, check_runs: [] }],
    ['check_runs not an array', { ...good, check_runs: null }],
    ['not an object', null],
    ['an array', []],
    ['unbound row', { ...good, check_runs: [{ ...good.check_runs[0], binding: 'unbound', input_status: 'unbound' }, ...good.check_runs.slice(1)] }],
    ['input_status unknown', { ...good, check_runs: [{ ...good.check_runs[0], input_status: 'unknown' }, ...good.check_runs.slice(1)] }],
    ['steps missing', { ...good, check_runs: [{ ...good.check_runs[0], job_inputs: { ...good.check_runs[0].job_inputs, steps_state: 'absent', steps: null } }, ...good.check_runs.slice(1)] }],
    ['steps null', { ...good, check_runs: [{ ...good.check_runs[0], job_inputs: { ...good.check_runs[0].job_inputs, steps_state: 'null', steps: null } }, ...good.check_runs.slice(1)] }],
    ['runner_name null', { ...good, check_runs: [{ ...good.check_runs[0], job_inputs: { ...good.check_runs[0].job_inputs, runner_name_state: 'null', runner_name: null } }, ...good.check_runs.slice(1)] }],
    ['a row that is not an object', { ...good, check_runs: [...good.check_runs, 'x'] }],
    ['steps_state absent but an array present', { ...good, check_runs: [{ ...good.check_runs[0], job_inputs: { ...good.check_runs[0].job_inputs, steps_state: 'absent' } }, ...good.check_runs.slice(1)] }],
  ]) {
    const r = classifySnapshot(s);
    assert.equal(r.classification, 'unavailable', label);
    assert.equal(r.ci_state, 'UNAVAILABLE', label);
    assert.ok(r.reasons.length > 0, label);
  }
  const reasonOf = (patch) => classifySnapshot({ ...good, check_runs: [{ ...good.check_runs[0], ...patch(good.check_runs[0]) }, ...good.check_runs.slice(1)] }).rows[0].reasons;
  assert.deepEqual(reasonOf(() => ({ binding: 'unbound', input_status: 'unbound' })), ['row_not_bound']);
  assert.deepEqual(reasonOf(() => ({ input_status: 'unknown' })), ['input_status_unknown']);
  assert.deepEqual(reasonOf((r) => ({ job_inputs: { ...r.job_inputs, steps_state: 'null', steps: null } })), ['steps_unknown']);
  assert.deepEqual(reasonOf((r) => ({ job_inputs: { ...r.job_inputs, runner_name_state: 'null', runner_name: null } })), ['runner_name_unknown']);
  // the real builder's own outputs: a job without steps is incomplete at S-05a, and is refused here
  const noSteps = snap([{ id: 1, steps: undefined }]);
  assert.equal(noSteps.state, 'incomplete');
  assert.equal(classifySnapshot(noSteps).classification, 'unavailable');
  // an unbound check (no job names it) and a cross-run "supersession"
  const unbound = snap([{ id: 1 }], { jobs: { 'run100-1.jsonl': nl([]) } });
  assert.notEqual(unbound.state, 'snapshot_valid');
  assert.equal(classifySnapshot(unbound).classification, 'unavailable');
  const cross = snap([{ id: 1, run: 100 }, { id: 2, run: 200, conclusion: 'success', steps: [STEP], ann: [] }]);
  assert.equal(cross.check_runs[0].supersession, 'not_superseded');
  assert.equal(classifySnapshot(cross).classification, 'billing_blocked');
});

test('7b: an unproven supersession claim is not trusted', () => {
  const s = snap(six());
  const forged = { ...s, check_runs: [{ ...s.check_runs[0], supersession: 'superseded' }, ...s.check_runs.slice(1)] };
  assert.equal(classifySnapshot(forged).classification, 'unavailable');
  assert.ok(classifySnapshot(forged).rows[0].reasons.includes('supersession_unproven'));
});

test('8: a skipped preview with runner null (outside_r3) is not UNKNOWN, not billing, and does not block', () => {
  const preview = { id: 9, name: 'preview', conclusion: 'skipped', runner: null, secs: 0, ann: [], steps: [] };
  const withBilling = classifySnapshot(snap([...six(), preview]));
  assert.equal(rowOf(withBilling, 9).verdict, 'outside_r3');
  assert.equal(withBilling.classification, 'billing_blocked');
  const alone = classifySnapshot(snap([preview, { id: 10, name: 'unit', conclusion: 'success', steps: [STEP], ann: [], secs: 40 }]));
  assert.equal(alone.classification, 'no_failure_observed');
  const s = snap([preview]);
  assert.equal(s.check_runs[0].input_status, 'outside_r3');
  const forged = { ...s, check_runs: [{ ...s.check_runs[0], conclusion: 'failure' }] };
  assert.equal(classifySnapshot(forged).classification, 'unavailable');
  assert.deepEqual(classifySnapshot(forged).rows[0].reasons, ['outside_r3_not_skipped']);
});

test('9: annotations "none" on a failure job -> unavailable', () => {
  const s = snap([{ id: 1, ann: [] }]);
  assert.equal(s.check_runs[0].annotations.status, 'none');
  const r = classifySnapshot(s);
  assert.equal(r.classification, 'unavailable');
  assert.ok(rowOf(r, 1).reasons.includes('R4_annotation_not_allowlisted'));
});

test('10: a success-only snapshot -> no_failure_observed / NOT_CLASSIFIED; no billing label, no pass', () => {
  const r = classifySnapshot(snap([{ id: 1, conclusion: 'success', steps: [STEP], ann: [], secs: 30 }, { id: 2, name: 'lint', conclusion: 'success', steps: [STEP], ann: [], secs: 12 }]));
  assert.equal(r.classification, 'no_failure_observed');
  assert.equal(r.ci_state, 'NOT_CLASSIFIED');
  assert.equal(r.code, 'no_failure_observed');
  assert.deepEqual(r.reasons, []);
  assert.ok(!r.rows.some((x) => x.verdict === 'billing'));
  assert.ok(r.not_asserted.includes('required_check_policy') && r.not_asserted.includes('merge_basis'));
  assert.equal(r.note, NOTE);
  assert.equal(r.rows[0].verdict, 'not_failed');
});

test('11: a failed attempt superseded by a later attempt of the SAME run is excluded; a cross-run same-name success does not supersede', () => {
  const retried = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, conclusion: 'success', steps: [STEP], ann: [], secs: 70 }]);
  assert.equal(retried.check_runs[0].supersession, 'superseded');
  const r = classifySnapshot(retried);
  assert.equal(rowOf(r, 1).verdict, 'superseded');
  assert.equal(r.classification, 'no_failure_observed');
  const cross = snap([{ id: 1, run: 100, steps: [STEP], secs: 80 }, { id: 2, run: 200, conclusion: 'success', steps: [STEP], ann: [], secs: 70 }]);
  assert.equal(cross.check_runs[0].supersession, 'not_superseded');
  assert.equal(classifySnapshot(cross).classification, 'failed_code');
});

// ---- advisory guarantee ----
const ALL_CASES = () => [
  snap(six()), snap([{ id: 1, steps: [STEP], secs: 90 }]), snap([{ id: 1, steps: [STEP] }, ...six().slice(1)]), snap([{ id: 1, ann: ['other'] }]),
  snap([{ id: 1, conclusion: 'success', steps: [STEP], ann: [] }]), snap([{ id: 1, steps: undefined }]), null, { schema: 'x' },
  snap([{ id: 1, conclusion: 'failure', steps: [{ ...STEP, conclusion: 'skipped' }] }]),
];
test('advisory: over every case ci_state is in {FAIL, UNAVAILABLE, NOT_CLASSIFIED}; the key set is closed and has no pass/waive/eligible field', () => {
  assert.deepEqual([...CI_STATES], ['FAIL', 'UNAVAILABLE', 'NOT_CLASSIFIED']);
  assert.deepEqual(Object.keys(CLASSIFICATIONS).sort(), ['billing_blocked', 'ci_mixed_execution', 'failed_code', 'no_failure_observed', 'unavailable']);
  const keys = ['advisory', 'billing_allowlist_version', 'billing_max_seconds', 'ci_state', 'classification', 'code', 'not_asserted', 'note', 'reasons', 'rows', 'schema', 'snapshot_sha256'];
  for (const s of ALL_CASES()) {
    const r = classifySnapshot(s);
    assert.ok(CI_STATES.includes(r.ci_state));
    assert.deepEqual(Object.keys(r).sort(), keys);
    assert.equal(r.ci_state, CLASSIFICATIONS[r.classification].ci_state);
    const text = JSON.stringify(r);
    // the FULL serialized output (keys, values, rows, not_asserted, note) names none of the forbidden words
    assert.ok(!/pass|waive|eligib|CI_PASSED|LOCAL_CI_VERIFIED/i.test(text), text.slice(0, 200));
    assert.equal(r.note, 'Required checks unverified; no gate decision.');
  }
});

test('negative: a failed required check classified billing_blocked yields a non-pass status; only the existing fallback rule may waive it', () => {
  // The consumer-side fold documented in the header: anything but a proven pass is not a pass; the classifier supplies no proof.
  const overall = (r) => (r.ci_state === 'FAIL' ? 'FAIL' : r.ci_state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NOT_PASSED_UNTIL_REQUIRED_CHECK_POLICY');
  const r = classifySnapshot(snap(six()));
  assert.equal(r.classification, 'billing_blocked');
  assert.equal(overall(r), 'UNAVAILABLE');
  assert.ok(!Object.hasOwn(r, 'eligible') && !Object.hasOwn(r, 'waived') && !Object.hasOwn(r, 'passed') && !Object.hasOwn(r, 'fallback_eligible'));
  for (const s of ALL_CASES()) assert.notEqual(overall(classifySnapshot(s)), 'PASS');
  // a success-only snapshot is still not a pass
  assert.equal(overall(classifySnapshot(snap([{ id: 1, conclusion: 'success', steps: [STEP], ann: [] }]))), 'NOT_PASSED_UNTIL_REQUIRED_CHECK_POLICY');
});

test('the classification vocabulary contains no pass-like member', () => {
  for (const [name, v] of Object.entries(CLASSIFICATIONS)) {
    assert.ok(!/pass|waive|eligible|verified|success|ok/i.test(`${name} ${v.ci_state} ${v.code}`.replace(/no_failure_observed/, '')), name);
  }
});

// ---- R2: the provisional 10 s threshold ----
test('R2 parameter: BILLING_MAX_SECONDS is pinned at 10 (a provisional ESTIMATE; changing it is a deliberate edit of this test and the header)', () => {
  assert.equal(BILLING_MAX_SECONDS, 10);
  assert.equal(BILLING_ALLOWLIST_VERSION, 'github-actions-billing-annotation-v1');
  assert.deepEqual([...BILLING_ANNOTATION_ALLOWLIST], [BILL_TEXT]);
  assert.match(readFileSync(join(HERE, 'ci-classify.mjs'), 'utf8'), /PROVISIONAL PARAMETER[\s\S]*ESTIMATE[\s\S]*n = 1/);
});
test('R2 boundary: 10 s is billing, 11 s is not, 10.5 s is not; missing, malformed or reversed timestamps are not billing', () => {
  assert.equal(classifySnapshot(snap([{ id: 1, secs: 10 }])).classification, 'billing_blocked');
  assert.equal(classifySnapshot(snap([{ id: 1, secs: 11 }])).classification, 'unavailable');
  assert.equal(classifySnapshot(snap([{ id: 1, secs: 0 }])).classification, 'billing_blocked');
  assert.equal(durationSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:00:10.500Z'), 10.5);
  assert.equal(durationSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'), 10);
  for (const [a, b] of [[null, ts(1)], [ts(1), null], [undefined, undefined], ['yesterday', ts(1)], [ts(5), ts(1)], ['2026-01-01 00:00:00', ts(1)], [1, 2]]) assert.equal(durationSeconds(a, b), null);
  const s = snap(six());
  const noTime = { ...s, check_runs: [{ ...s.check_runs[0], completed_at: null }, ...s.check_runs.slice(1)] };
  assert.ok(classifySnapshot(noTime).rows[0].reasons.includes('R2_duration_unknown'));
  assert.equal(classifySnapshot(noTime).classification, 'unavailable');
  for (const c of ['cancelled', 'timed_out', 'action_required', 'stale']) assert.equal(classifySnapshot(snap([{ id: 1, conclusion: c }])).classification, 'unavailable', c);
  assert.equal(classifySnapshot(snap([{ id: 1, conclusion: 'startup_failure' }])).classification, 'billing_blocked');
});
test('R2 replay over the corpus: every observed duration (real SCRUM-202 jobs, synthetic replica) is within the threshold with margin', () => {
  const real = readFileSync(REAL_FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const zeroStep = real.filter((j) => j.conclusion === 'failure' && Array.isArray(j.steps) && j.steps.length === 0 && j.runner_name === '');
  assert.equal(zeroStep.length, 6);
  const durations = real.map((j) => durationSeconds(j.started_at, j.completed_at));
  assert.ok(durations.every((d) => d !== null));
  assert.equal(Math.max(...durations), 2);
  assert.ok(Math.max(...durations) <= BILLING_MAX_SECONDS / 2, 'margin: the observed maximum is at most half the threshold');
  const replica = readSnapshot({ dir: REPLICA, repo: REPO, sha: SHA, origin: ORIGIN });
  const rep = replica.check_runs.map((r) => durationSeconds(r.started_at, r.completed_at));
  assert.ok(Math.max(...rep) <= BILLING_MAX_SECONDS / 2);
  assert.ok(Math.max(...real.map((j) => durationSeconds(j.started_at, j.completed_at))) * 5 >= BILLING_MAX_SECONDS, 'the threshold is not more than 5x the observed maximum (an unvalidated estimate, n=1)');
});

// ---- synthetic linked replica (NOT H AC1: the real fixture has no head_sha / check runs / annotations) ----
test('synthetic replica: labelled synthetic on every check-run and job line; snapshot_valid; classifies billing_blocked', () => {
  for (const f of ['check-runs.jsonl', ...readdirSync(join(REPLICA, 'jobs')).map((n) => join('jobs', n))]) {
    const lines = readFileSync(join(REPLICA, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => !Object.hasOwn(l, 'total_count'));
    assert.ok(lines.length > 0, f);
    assert.ok(lines.every((l) => l.synthetic === true), `${f}: every line carries "synthetic": true`);
    assert.ok(lines.every((l) => !/ticket|scrum/i.test(JSON.stringify(l))), `${f}: no ticket data`);
  }
  const s = readSnapshot({ dir: REPLICA, repo: REPO, sha: SHA, origin: ORIGIN });
  assert.equal(s.state, 'snapshot_valid');
  const r = classifySnapshot(s);
  assert.equal(r.classification, 'billing_blocked');
  assert.equal(r.rows.filter((x) => x.verdict === 'billing').length, 6);
  assert.equal(r.rows.find((x) => x.name === 'preview').verdict, 'outside_r3');
  assert.equal(r.rows.find((x) => x.name === 'review').verdict, 'outside_classifier');
});
test('synthetic replica with CRLF line endings (a Windows checkout) classifies identically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-classify-crlf-'));
  try {
    const copy = (rel) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), readFileSync(join(REPLICA, rel), 'utf8').replace(/\r?\n/g, '\r\n')); };
    copy('check-runs.jsonl');
    for (const n of readdirSync(join(REPLICA, 'jobs'))) copy(join('jobs', n));
    for (const n of readdirSync(join(REPLICA, 'annotations'))) copy(join('annotations', n));
    assert.ok(readFileSync(join(dir, 'check-runs.jsonl'), 'utf8').includes('\r\n'));
    const s = readSnapshot({ dir, repo: REPO, sha: SHA, origin: ORIGIN });
    assert.equal(s.state, 'snapshot_valid');
    assert.equal(classifySnapshot(s).classification, 'billing_blocked');
    assert.equal(s.provider_snapshot_sha256, readSnapshot({ dir: REPLICA, repo: REPO, sha: SHA, origin: ORIGIN }).provider_snapshot_sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- CLI ----
const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input });
test('parseStrictJson: equals JSON.parse on valid text and refuses duplicate keys (also nested), trailing text, depth and broken text', () => {
  const ok = '{"a":[1,2.5,-3e2,true,false,null,"x\\"y\\\\"],"b":{"c":{}},"d":[],"__proto__":{"k":1}}';
  assert.deepEqual(parseStrictJson(ok), JSON.parse(ok));
  assert.equal(Object.keys(parseStrictJson(ok)).includes('__proto__'), true);
  for (const bad of ['{"a":1,"a":2}', '{"x":{"a":1,"b":2,"a":3}}', '[{"a":1,"a":1}]', '{"a":1} x', '{"a":1', '{"a" 1}', '[1,]', '{"a":01}', '"abc', '{a:1}', '', '[' .repeat(70) + ']'.repeat(70)]) assert.throws(() => parseStrictJson(bad), undefined, bad);
  assert.equal(JSON.parse('{"conclusion":"failure","conclusion":"success"}').conclusion, 'success', 'JSON.parse silently takes the last duplicate: the reason this parser exists');
});
test('CLI: every classification exits 1 (never 0), with the data and the note on one stdout line; usage 2; unreadable input 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-classify-cli-'));
  try {
    const seen = new Set();
    ALL_CASES().forEach((c, i) => {
      const f = join(dir, `c${i}.json`);
      writeFileSync(f, JSON.stringify(c));
      const a = cli(['classify', '--snapshot-json', f]);
      assert.equal(a.status, 1, `case ${i}`);
      assert.equal(a.stdout.trim().split('\n').length, 1);
      const out = JSON.parse(a.stdout);
      assert.equal(out.note, 'Required checks unverified; no gate decision.');
      seen.add(out.classification);
    });
    assert.deepEqual([...seen].sort(), ['billing_blocked', 'ci_mixed_execution', 'failed_code', 'no_failure_observed', 'unavailable']);
    // stdin
    const b = cli(['classify', '--snapshot-json', '-'], JSON.stringify(snap([{ id: 1, conclusion: 'success', steps: [STEP], ann: [] }])));
    assert.equal(b.status, 1);
    assert.equal(JSON.parse(b.stdout).classification, 'no_failure_observed');
    // unreadable input and duplicate keys: exit 3 with an unavailable line
    writeFileSync(join(dir, 'bad.json'), '{not json');
    const c = cli(['classify', '--snapshot-json', join(dir, 'bad.json')]);
    assert.equal(c.status, 3);
    assert.equal(JSON.parse(c.stdout).classification, 'unavailable');
    assert.match(JSON.parse(c.stdout).reasons[0], /^snapshot_json_unreadable:/);
    const dupText = JSON.stringify(snap(six())).replace('"conclusion":"failure"', '"conclusion":"failure","conclusion":"success"');
    assert.notEqual(dupText, JSON.stringify(snap(six())));
    writeFileSync(join(dir, 'dup.json'), dupText);
    const d = cli(['classify', '--snapshot-json', join(dir, 'dup.json')]);
    assert.equal(d.status, 3);
    assert.deepEqual(JSON.parse(d.stdout).reasons, ['snapshot_json_unreadable:duplicate_key']);
    assert.equal(JSON.parse(d.stdout).classification, 'unavailable');
    const m = cli(['classify', '--snapshot-json', join(dir, 'missing.json')]);
    assert.equal(m.status, 3);
    assert.equal(JSON.parse(m.stdout).classification, 'unavailable');
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, '{}');
    for (const args of [[], ['classify'], ['classify', '--snapshot-json'], ['check', '--snapshot-json', ok], ['classify', '--snapshot-json', ok, 'extra']]) assert.equal(cli(args).status, 2, args.join(' '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI main(): the injected stdin reader is used for "-" and the status is 1, never 0', () => {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (c) => { out += c; return true; };
  let status;
  try { status = main(['classify', '--snapshot-json', '-'], { readStdin: () => JSON.stringify(snap(six())) }); } finally { process.stdout.write = orig; }
  assert.equal(status, 1);
  assert.equal(JSON.parse(out).classification, 'billing_blocked');
});

// ---- mutation (the shared harness, lib/mutation.test-helper.mjs): each mutant must be KILLED by an assertion ----
const SRC = loadMutationSource(join(HERE, 'ci-classify.mjs'));
const MUTANTS = [
  ['R5 ordering dropped: billing consulted before executed failures', "  if (executed.length) {\n    return finish(billing.length ? 'ci_mixed_execution' : 'failed_code'", "  if (executed.length && !billing.length) {\n    return finish('failed_code'"],
  ['threshold 10 -> 60', 'export const BILLING_MAX_SECONDS = 10;', 'export const BILLING_MAX_SECONDS = 60;'],
  ['R2 bound made exclusive (10 s no longer billing)', "else if (seconds > BILLING_MAX_SECONDS) failed.push", "else if (seconds >= BILLING_MAX_SECONDS) failed.push"],
  ['R2 duration check dropped', "  else if (seconds > BILLING_MAX_SECONDS) failed.push('R2_duration_over_threshold');\n", ''],
  ['R1 dropped', "  if (row.app !== 'github-actions') failed.push('R1_app_not_github_actions');\n", ''],
  ['R4 allowlist becomes substring match', 'ann.messages.every((m) => BILLING_ANNOTATION_ALLOWLIST.includes(m))', 'ann.messages.every((m) => BILLING_ANNOTATION_ALLOWLIST.some((a) => m.includes(a)))'],
  ['R4 accepts when only one message matches', 'ann.messages.every((m) =>', 'ann.messages.some((m) =>'],
  ['R4 accepts annotation status none', "ann.status !== 'present' || !Array.isArray(ann.messages) || ann.messages.length === 0 || ", ''],
  ['R3 runner_name not required empty', "  if (inp.runner_name !== '') failed.push('R3_runner_name_not_empty');\n", ''],
  ['steps_state marker ignored', "inp.steps_state !== 'array' || ", ''],
  ['R3 missing runner_name treated as empty', "if (inp.runner_name_state !== 'string' || typeof inp.runner_name !== 'string') return", "if (false) return"],
  ['unknown input_status treated as ok', "if (row.input_status !== 'ok') return verdictRow(row, 'unknown', [`input_status_${String(row.input_status)}`]);", ''],
  ['unbound row treated as bound', "if (row.binding !== 'bound') return verdictRow(row, 'unknown', ['row_not_bound']);", ''],
  ['snapshot state refusal dropped', "if (snapshot.state !== 'snapshot_valid' || snapshot.internally_consistent !== true) return finish('unavailable', [`snapshot_state_${String(snapshot.state)}`], [], snapshot);\n", ''],
  ['schema refusal dropped', "if (snapshot.schema !== SNAPSHOT_SCHEMA) return finish('unavailable', ['snapshot_schema_unknown'], [], snapshot);\n", ''],
  ['executed-step count counts skipped steps too', "inp.steps.filter((s) => s.conclusion !== 'skipped').length", 'inp.steps.length'],
  ['supersession trusted without proof', "if (!(Number.isSafeInteger(row.superseded_by_attempt) && Number.isSafeInteger(row.run_attempt) && row.superseded_by_attempt > row.run_attempt)) return verdictRow(row, 'unknown', ['supersession_unproven']);\n", ''],
  ['M2: superseded executed failure hidden behind the retry', "return old.steps.some((s) => s.conclusion !== 'skipped') ? verdictRow(row, 'executed_failure', ['superseded_executed_failure_not_cleared']) : verdictRow(row, 'superseded');", "return verdictRow(row, 'superseded');"],
  ['M2: a failing superseder treated as clearing', "if (NOT_FAILURE.includes(by.conclusion)) return verdictRow(row, 'superseded');\n", "return verdictRow(row, 'superseded');\n"],
  ['M2: superseding row not required', "if (!by) return verdictRow(row, 'unknown', ['superseding_row_missing']);\n", "if (!by) return verdictRow(row, 'superseded');\n"],
  ['M1: external failure tolerated beside billing', "return verdictRow(row, 'unclassified_failure', [`external_check_${String(row.conclusion)}`]);", "return verdictRow(row, 'outside_classifier', ['external_check_failed']);"],
  ['M1: external timed_out and others treated as cancelled', "if (row.conclusion === 'cancelled') return", "if (row.conclusion !== 'success') return"],
  ['M3: duplicate JSON keys accepted', "if (seen.has(k)) fail('duplicate_key');", ''],
  ['M3: duplicate row ids accepted', "  if (new Set(ids).size !== ids.length) return finish('unavailable', ['snapshot_duplicate_row_id'], [], snapshot);\n", ''],
  ['M3: snapshot hash not required', "  if (!/^[0-9a-f]{64}$/.test(String(snapshot.provider_snapshot_sha256))) return finish('unavailable', ['snapshot_hash_invalid'], [], snapshot);\n", ''],
  ['M3: row/job conclusion disagreement ignored', "  if (!isObj(row.job_inputs) || row.job_inputs.conclusion !== row.conclusion) return verdictRow(row, 'unknown', ['conclusion_inconsistent']);\n", ''],
  ['M3: row status not required completed', "  if (row.status !== 'completed') return verdictRow(row, 'unknown', ['row_not_completed']);\n", ''],
  ['M3: external row may claim github-actions', "typeof row.app !== 'string' || row.app === '' || row.app === 'github-actions'", "typeof row.app !== 'string'"],
  ['M3: row id shape not required', "typeof row.id !== 'string' || !/^(0|[1-9]\\d*)$/.test(row.id)", 'false'],
  ['M4: every output without the no-gate note', 'not_asserted: NOT_ASSERTED.slice(), note: NOTE, rows };', 'not_asserted: NOT_ASSERTED.slice(), rows };'],
  ['outside_r3 accepted for any conclusion', "return row.conclusion === 'skipped' ? verdictRow(row, 'outside_r3') : verdictRow(row, 'unknown', ['outside_r3_not_skipped']);", "return verdictRow(row, 'outside_r3');"],
  ['external failure ignored when nothing else fails', "  if (external.length) return finish('unavailable', note('external_check_not_success', external), rows, snapshot);\n", ''],
  ['bad rows ignored when billing exists', "  if (bad.length) return finish('unavailable', note('not_classified', bad), rows, snapshot);\n", ''],
  ['mixed execution reported as plain failed_code', "billing.length ? 'ci_mixed_execution' : 'failed_code'", "'failed_code'"],
  ['classification FAIL mapped to a pass-like state', "failed_code: Object.freeze({ ci_state: 'FAIL'", "failed_code: Object.freeze({ ci_state: 'PASS'"],
  ['billing_blocked mapped to NOT_CLASSIFIED', "billing_blocked: Object.freeze({ ci_state: 'UNAVAILABLE'", "billing_blocked: Object.freeze({ ci_state: 'NOT_CLASSIFIED'"],
  ['an eligibility field added to the output', "advisory: true, classification,", "advisory: true, eligible: classification === 'billing_blocked', classification,"],
  // Equivalent by design, no mutant listed: the typeof guard and TS regex are redundant with the calendar round-trip for every shape Date.parse accepts (date-only, offsets, spaces, non-strings), kept as defence in depth.
  ['impossible calendar dates accepted', "new Date(a).toISOString().slice(0, 19) !== start.slice(0, 19) || new Date(b).toISOString().slice(0, 19) !== end.slice(0, 19)", 'false'],
  ['M4: CLI exits 0 for no_failure_observed', "  return status;\n}", "  return result.classification === 'no_failure_observed' ? 0 : status;\n}"],
  ['M4: unreadable input exits 1 instead of 3', "snapshot_json_unreadable:${/^[a-z_]+$/.test(String(e?.message)) ? e.message : 'invalid_json'}`], [], null); status = 3; }", "snapshot_json_unreadable:${/^[a-z_]+$/.test(String(e?.message)) ? e.message : 'invalid_json'}`], [], null); status = 1; }"],
  ['billing conclusion list widened to cancelled', "const BILLING_CONCLUSIONS = ['failure', 'startup_failure'];", "const BILLING_CONCLUSIONS = ['failure', 'startup_failure', 'cancelled'];"],
];
const CHILD_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), CLASSIFY_MUTANT_RUN: '1' };
const runMutant = (src) => runTreeMutant({ root: HERE, testRel: 'ci-classify.test.mjs', env: CHILD_ENV, timeout: 120000, overrides: { 'ci-classify.mjs': src } });
const IN_CHILD = process.env.CLASSIFY_MUTANT_RUN === '1';
test('mutation harness self-test: a broken module is INVALID, an identical copy SURVIVES, a real mutant is KILLED', { skip: IN_CHILD }, () => {
  assert.equal(classifyMutant(runMutant(`${SRC}\nexport const = ;`)).verdict, 'invalid');
  assert.equal(classifyMutant(runMutant(SRC)).verdict, 'survived');
  assert.equal(classifyMutant(runMutant(SRC.replace(MUTANTS[1][1], MUTANTS[1][2]))).verdict, 'killed');
});
test('mutation: every mutant of ci-classify.mjs is killed by a real assertion failure (never a load error, crash or timeout)', { skip: IN_CHILD }, () => {
  const bad = [];
  for (const [name, from, to] of MUTANTS) {
    assert.equal(SRC.split(from).length - 1, 1, `mutant "${name}": anchor must occur exactly once`);
    const c = classifyMutant(runMutant(SRC.replace(from, to)));
    console.log(`# mutant ${c.verdict}: ${name} <- ${c.failing.slice(0, 2).map((n) => n.slice(0, 60)).join(' | ')}`);
    if (c.verdict !== 'killed') bad.push(`${name}: ${c.verdict} ${c.why ?? ''}`);
  }
  assert.deepEqual(bad, [], 'mutants not killed by an assertion');
});
test('mutation anchors are CRLF-independent (a Windows checkout): the shared loader yields the same LF source', { skip: IN_CHILD }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-classify-src-'));
  try {
    writeFileSync(join(dir, 'x.mjs'), SRC.replace(/\n/g, '\r\n'));
    assert.equal(loadMutationSource(join(dir, 'x.mjs')), SRC);
    for (const [name, from] of MUTANTS) assert.equal(SRC.split(from).length - 1, 1, `${name}: anchor`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
