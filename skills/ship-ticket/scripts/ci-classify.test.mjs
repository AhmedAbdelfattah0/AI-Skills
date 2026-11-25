// Advisory CI failure classifier (ASTF-39, S-05b), restart "validate first, classify second". Every snapshot here is SYNTHETIC
// (invented ids, repo acme/widgets); the one real input is the committed TICKET-B jobs fixture, used only to replay the R2
// threshold over observed durations. Tests assert a positive signal (an exact classification, state or reason code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, readSnapshot, CONCLUSIONS } from './ci-snapshot.mjs';
import { classifySnapshot, classifyNormal, validateSnapshot, durationSeconds, parseStrictJson, main, NOTE, BILLING_MAX_SECONDS, BILLING_ALLOWLIST_VERSION, BILLING_ANNOTATION_ALLOWLIST, CLASSIFICATIONS, CI_STATES, SCHEMA, INVALID_CODES, MAX_INPUT_BYTES, EMPTY_ANNOTATIONS_SHA256 } from './ci-classify.mjs';
import { classify as classifyMutant, loadMutationSource, runMutant as runTreeMutant } from './lib/mutation.test-helper.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, 'ci-classify.mjs');
const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input });
const REAL_FIXTURE = join(HERE, 'fixtures', 'ci-snapshot', 'ticket-b-abf4d7ea-actions-jobs.jsonl');
const REPLICA = join(HERE, 'fixtures', 'ci-classify', 'synthetic-linked-abf4d7ea');
const REPO = 'acme/widgets', ORIGIN = 'https://api.github.com', SHA = 'abf4d7ea' + 'ab'.repeat(16);
const BILL = BILLING_ANNOTATION_ALLOWLIST[0];
const BILL_TEXT = 'The job was not started because recent account payments have failed or your spending limit needs to be increased.';
const IN_CHILD = process.env.CLASSIFY_MUTANT_RUN === '1';
const url = (id) => `${ORIGIN}/repos/${REPO}/check-runs/${id}`;
const nl = (items) => [{ total_count: items.length }, ...items].map((x) => JSON.stringify(x)).join('\n') + '\n';
const ts = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString().replace('.000Z', 'Z');
const STEP = { name: 'run', status: 'completed', conclusion: 'success', number: 1 };
const SKIP = { name: 'skip', status: 'completed', conclusion: 'skipped', number: 1 };
const FAILSTEP = { name: 'test', status: 'completed', conclusion: 'failure', number: 2 };
const OK = { conclusion: 'success', steps: [STEP], ann: [], secs: 30 };
const EXT = { app: 'coderabbitai', steps: undefined, ann: [], secs: 3 };

/**
 * spec: { id, name, conclusion, steps, runner, secs, ann, run, attempt, app }. Defaults describe one billing-shaped failure.
 * -> the S-05a snapshot (the REAL builder, so every row carries the real derived fields).
 */
function snap(specs, over = {}) {
  const checks = [], jobs = {}, annotations = {};
  for (const sp of specs) {
    const s = { name: 'verify', conclusion: 'failure', steps: [], runner: '', secs: 2, ann: [BILL], run: 100, attempt: 1, app: 'github-actions', ...sp };
    checks.push({ id: s.id, name: s.name, head_sha: SHA, status: 'completed', conclusion: s.conclusion, started_at: ts(0), completed_at: ts(s.secs), url: url(s.id), app: { slug: s.app }, output: { annotations_count: s.ann.length } });
    if (s.app === 'github-actions') {
      const j = { id: s.id, name: s.name, run_id: s.run, run_attempt: s.attempt, head_sha: SHA, status: 'completed', conclusion: s.conclusion, started_at: ts(0), completed_at: ts(s.secs), runner_name: s.runner, check_run_url: url(s.id) };
      if (s.steps !== undefined) j.steps = s.steps;
      (jobs[`run${s.run}-${s.attempt}.jsonl`] ??= []).push(j);
    }
    if (s.ann.length) annotations[`${s.id}.jsonl`] = s.ann.map((message) => JSON.stringify({ message })).join('\n') + '\n';
    else if (s.emptyAnnFile) annotations[`${s.id}.jsonl`] = ''; // `gh api .../annotations --jq '.[]'` on a zero-annotation check writes an EMPTY file
  }
  const texts = { checkRuns: nl(checks), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, nl(v)])), annotations, problems: [] };
  return buildSnapshot({ texts: { ...texts, ...over }, repo: REPO, sha: SHA, origin: ORIGIN });
}
const six = () => [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, name: `job${i}` }));
const rowOf = (res, id) => res.rows.find((r) => r.id === String(id));
/** A structuredClone of `s` changed by `fn` (a forged snapshot: what a reviewer can hand classifySnapshot directly). */
const forge = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); /* a JSON round trip: no shared references, as the CLI sees it */ fn(c, (id) => c.check_runs.find((r) => r.id === String(id)), (id) => c.jobs.find((j) => j.id === String(id))); return c; };
const invalidCodes = (r) => r.reasons.map((x) => /^invalid:([a-z_]+)@/.exec(x)?.[1]).filter(Boolean);
const assertInvalid = (r, code, label = code) => {
  assert.equal(r.classification, 'unavailable', label);
  assert.equal(r.ci_state, 'UNAVAILABLE', label);
  assert.equal(r.snapshot_sha256, null, label);
  assert.deepEqual(r.rows, [], label);
  assert.ok(invalidCodes(r).every((c) => INVALID_CODES.includes(c)), `${label}: every code is listed: ${r.reasons}`);
  if (code) assert.ok(invalidCodes(r).includes(code), `${label}: ${JSON.stringify(r.reasons)}`);
};

test('the builders produce snapshot_valid snapshots that VALIDATE (baseline for every case below)', () => {
  const s = snap(six());
  assert.equal(s.state, 'snapshot_valid');
  assert.equal(s.check_runs.length, 6);
  const v = validateSnapshot(s);
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
  assert.ok(Object.isFrozen(v.normal) && Object.isFrozen(v.normal.rows[0]));
});

// ---- the 11-case table (package PLAN-S05bc, S-05b), restated under validate-first ----
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
    assert.ok(rowOf(r, 1).reasons.includes('R4_annotation_not_allowlisted'), label);
  }
  // R3: a non-empty runner_name means a runner picked the job up: never billing (the real builder, not a forged row)
  const ran = classifySnapshot(snap([{ id: 1, runner: 'GitHub Actions 7' }]));
  assert.equal(ran.classification, 'unavailable');
  assert.ok(rowOf(ran, 1).reasons.includes('R3_runner_name_not_empty'));
  // R3: steps that are all skipped count as zero executed; one executed (non-skipped) step is an executed failure
  assert.equal(classifySnapshot(snap([{ id: 1, steps: [SKIP] }])).classification, 'billing_blocked');
  assert.equal(classifySnapshot(snap([{ id: 1, steps: [SKIP, STEP] }])).classification, 'failed_code');
  // one job with a wrong annotation beside five genuine billing jobs: the whole result is unavailable, billing is not claimed
  const some = classifySnapshot(snap([{ id: 1, ann: ['other text'] }, ...six().slice(1)]));
  assert.equal(some.classification, 'unavailable');
  assert.equal(some.rows.filter((x) => x.verdict === 'billing').length, 5);
  // R1 is enforced by validation: a bound row whose app is not github-actions is not a valid snapshot
  assertInvalid(classifySnapshot(forge(snap(six()), (s) => { s.check_runs[0].app = 'other-app'; })), 'binding_app_mismatch');
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
  const ext = classifySnapshot(snap([{ id: 1, ...EXT, conclusion: 'cancelled', ann: [BILL], secs: 1 }]));
  assert.equal(ext.classification, 'unavailable');
  assert.equal(rowOf(ext, 1).verdict, 'outside_classifier');
  assert.deepEqual(rowOf(ext, 1).reasons, ['external_check_cancelled']);
  assert.ok(!ext.rows.some((x) => x.verdict === 'billing'));
  // alongside genuine billing jobs the cancelled / skipped / neutral / successful external check changes nothing
  for (const c of ['cancelled', 'success', 'neutral', 'skipped']) {
    const mixed = classifySnapshot(snap([...six(), { id: 7, name: 'review', ...EXT, conclusion: c }]));
    assert.equal(mixed.classification, 'billing_blocked', c);
  }
});

test('7: anything but a fully valid snapshot is refused as unavailable with typed reasons (never pass)', () => {
  const good = snap(six());
  for (const [label, s, code] of [
    ['incomplete state', { ...good, state: 'incomplete' }, 'shape_not_in_set'],
    ['invalid state', { ...good, state: 'invalid', provider_snapshot_sha256: null }, 'shape_not_in_set'],
    ['empty state', { ...good, state: 'empty' }, 'shape_not_in_set'],
    ['valid state but not internally_consistent', { ...good, internally_consistent: false }, 'not_internally_consistent'],
    ['unknown schema', { ...good, schema: 'ci-snapshot-v0' }, 'shape_not_in_set'],
    ['no check runs', { ...good, check_runs: [], jobs: [] }, 'no_check_runs'],
    ['check_runs not an array', { ...good, check_runs: null }, 'shape_not_array'],
    ['not an object', null, 'shape_not_object'],
    ['an array', [], 'shape_not_object'],
    ['a string', 'snapshot_valid', 'shape_not_object'],
    ['unbound row', forge(good, (s) => { Object.assign(s.check_runs[0], { binding: 'unbound', input_status: 'unbound' }); }), 'shape_not_in_set'],
    ['binding unbound alone', forge(good, (s) => { s.check_runs[0].binding = 'unbound'; }), 'shape_not_in_set'],
    ['input_status unknown', forge(good, (s) => { s.check_runs[0].input_status = 'unknown'; }), 'shape_not_in_set'],
    ['steps missing', forge(good, (s) => { Object.assign(s.check_runs[0].job_inputs, { steps_state: 'absent', steps: null }); }), 'steps_state_inconsistent'],
    ['steps null', forge(good, (s) => { Object.assign(s.check_runs[0].job_inputs, { steps_state: 'null', steps_type: 'null', steps: null }); }), 'input_status_mismatch'],
    ['runner_name null', forge(good, (s) => { Object.assign(s.check_runs[0].job_inputs, { runner_name_state: 'null', runner_name: null }); }), 'input_status_mismatch'],
    ['a row that is not an object', { ...good, check_runs: [...good.check_runs, 'x'] }, 'shape_not_object'],
    ['steps_state absent but an array present', forge(good, (s) => { s.check_runs[0].job_inputs.steps_state = 'absent'; }), 'steps_state_inconsistent'],
  ]) assertInvalid(classifySnapshot(s), code, label);
  // the real builder's own outputs: a job without steps is incomplete at S-05a, and is refused here
  const noSteps = snap([{ id: 1, steps: undefined }]);
  assert.equal(noSteps.state, 'incomplete');
  assertInvalid(classifySnapshot(noSteps), 'shape_not_in_set');
  const unbound = snap([{ id: 1 }], { jobs: { 'run100-1.jsonl': nl([]) } });
  assert.notEqual(unbound.state, 'snapshot_valid');
  assertInvalid(classifySnapshot(unbound));
  // a cross-run same-name row never supersedes
  const cross = snap([{ id: 1, run: 100 }, { id: 2, run: 200, ...OK }]);
  assert.equal(cross.check_runs[0].supersession, 'not_superseded');
  assert.equal(classifySnapshot(cross).classification, 'billing_blocked');
});

test('8: a skipped preview with runner null (outside_r3) is not billing and does not block billing_blocked; alone it is NOT no_failure_observed', () => {
  const preview = { id: 9, name: 'preview', conclusion: 'skipped', runner: null, secs: 0, ann: [], steps: [] };
  const withBilling = classifySnapshot(snap([...six(), preview]));
  assert.equal(rowOf(withBilling, 9).verdict, 'outside_r3');
  assert.equal(withBilling.classification, 'billing_blocked');
  // BEHAVIOUR CHANGE (restart): only `success` is benign; a latest skipped required check leaves the result unavailable
  const alone = classifySnapshot(snap([preview, { id: 10, name: 'unit', ...OK }]));
  assert.equal(alone.classification, 'unavailable');
  assert.ok(alone.reasons.includes('not_success:9'));
  const s = snap([preview]);
  assert.equal(s.check_runs[0].input_status, 'outside_r3');
  assertInvalid(classifySnapshot(forge(s, (c) => { c.check_runs[0].conclusion = 'failure'; })), 'conclusion_inconsistent');
});

test('9: annotations "none" on a failure job -> unavailable', () => {
  const s = snap([{ id: 1, ann: [] }]);
  assert.equal(s.check_runs[0].annotations.status, 'none');
  const r = classifySnapshot(s);
  assert.equal(r.classification, 'unavailable');
  assert.ok(rowOf(r, 1).reasons.includes('R4_annotation_not_allowlisted'));
});

test('10: a success-only snapshot -> no_failure_observed / NOT_CLASSIFIED; no billing label, no pass', () => {
  const r = classifySnapshot(snap([{ id: 1, ...OK }, { id: 2, name: 'lint', ...OK, secs: 12 }, { id: 3, name: 'review', ...EXT, conclusion: 'success' }]));
  assert.equal(r.classification, 'no_failure_observed');
  assert.equal(r.ci_state, 'NOT_CLASSIFIED');
  assert.equal(r.code, 'no_failure_observed');
  assert.deepEqual(r.reasons, []);
  assert.ok(!r.rows.some((x) => x.verdict === 'billing'));
  assert.ok(r.not_asserted.includes('required_check_policy') && r.not_asserted.includes('merge_basis'));
  assert.equal(r.note, NOTE);
  assert.equal(r.rows[0].verdict, 'not_failed');
});

test('11: a failed attempt followed by a SUCCESS attempt of the same run is cleared; a cross-run same-name success does not clear', () => {
  const retried = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, ...OK, secs: 70 }]);
  assert.equal(retried.check_runs[0].supersession, 'superseded');
  const r = classifySnapshot(retried);
  assert.equal(rowOf(r, 1).verdict, 'superseded');
  assert.deepEqual(rowOf(r, 1).reasons, ['cleared_by_success_attempt_2']);
  assert.equal(r.classification, 'no_failure_observed');
  const cross = snap([{ id: 1, run: 100, steps: [STEP], secs: 80 }, { id: 2, run: 200, ...OK, secs: 70 }]);
  assert.equal(cross.check_runs[0].supersession, 'not_superseded');
  assert.equal(classifySnapshot(cross).classification, 'failed_code');
  // order matters: a success BEFORE the failure clears nothing
  assert.equal(classifySnapshot(snap([{ id: 1, attempt: 1, ...OK }, { id: 2, attempt: 2, steps: [STEP], secs: 80 }])).classification, 'failed_code');
  // a success of ANOTHER job clears nothing
  assert.equal(classifySnapshot(snap([{ id: 1, name: 'unit', attempt: 1, steps: [STEP], secs: 80 }, { id: 2, name: 'lint', attempt: 2, ...OK }, { id: 3, name: 'lint', attempt: 1, ...OK }])).classification, 'failed_code');
});

// ---- explicit negatives: every Round-1 and Round-2 major, plus the restart list (RED first: see the PR body) ----
test('NEG R1-M1: an external failure-class check (failure, timed_out, action_required, startup_failure, stale) beside billing rows is never billing_blocked', () => {
  for (const c of ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    const r = classifySnapshot(snap([...six(), { id: 7, name: 'review', ...EXT, conclusion: c }]));
    assert.equal(r.classification, 'unavailable', c);
    assert.ok(r.reasons.includes('external_failure:7'), c);
    assert.deepEqual(rowOf(r, 7).reasons, [`external_check_${c}`], c);
    assert.equal(rowOf(r, 7).verdict, 'external_failure', c);
    assert.equal(classifySnapshot(snap([{ id: 7, name: 'review', ...EXT, conclusion: c }])).classification, 'unavailable', `${c} alone`);
  }
  // an executed Actions failure still decides FAIL over an external failure
  assert.equal(classifySnapshot(snap([{ id: 1, steps: [STEP], secs: 60 }, { id: 7, name: 'review', ...EXT, conclusion: 'failure' }])).classification, 'failed_code');
});

test('NEG R1-M2: an executed failure followed by a billing-shaped retry (billing retry after executed failure) is FAIL, never billing_blocked', () => {
  const hidden = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, secs: 2 }]);
  assert.equal(hidden.state, 'snapshot_valid');
  assert.equal(hidden.check_runs[0].supersession, 'superseded');
  const r = classifySnapshot(hidden);
  assert.equal(r.classification, 'ci_mixed_execution');
  assert.equal(rowOf(r, 1).verdict, 'executed_failure');
  // by a failing executed retry: failed_code; a billing attempt followed by a billing attempt: billing_blocked
  assert.equal(classifySnapshot(snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, steps: [FAILSTEP], secs: 70 }])).classification, 'failed_code');
  assert.equal(classifySnapshot(snap([{ id: 1, attempt: 1 }, { id: 2, attempt: 2 }])).classification, 'billing_blocked');
  // an unclassified failure followed by billing is not cleared: unavailable, never billing_blocked
  assert.equal(classifySnapshot(snap([{ id: 1, attempt: 1, secs: 40 }, { id: 2, attempt: 2 }])).classification, 'unavailable');
});

test('NEG R2-a: a skipped (or neutral) row retaining an executed-failure job is refused, never no_failure_observed', () => {
  for (const c of ['skipped', 'neutral', 'success']) {
    const f = forge(snap([{ id: 1, steps: [STEP], secs: 80 }]), (s, row) => { Object.assign(row(1), { conclusion: c, input_status: c === 'skipped' ? 'outside_r3' : 'ok', supersession: 'not_applicable' }); });
    assertInvalid(classifySnapshot(f), 'conclusion_inconsistent', c);
  }
});

test('NEG R2-b: a forged skipped/neutral superseder never clears an executed failure', () => {
  for (const c of ['skipped', 'neutral', 'cancelled']) {
    const real = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, conclusion: c, steps: [], ann: [] }]);
    assert.equal(real.state, 'snapshot_valid', c);
    assert.equal(real.check_runs[0].supersession, 'not_superseded', `${c}: the builder never lets it supersede`);
    assert.equal(classifySnapshot(real).classification, 'failed_code', c);
    assertInvalid(classifySnapshot(forge(real, (s, row) => { Object.assign(row(1), { supersession: 'superseded', superseded_by_attempt: 2 }); })), 'supersession_mismatch', c);
  }
});

test('NEG R2-c: the snapshot hash is a 64-lowercase-hex STRING (no coercion): number, array, uppercase, 63/65 chars, null, absent', () => {
  const s = snap([{ id: 1, ...OK }]), h = s.provider_snapshot_sha256;
  assert.equal(classifySnapshot(s).snapshot_sha256, h);
  for (const [v, code] of [[42, 'shape_bad_type'], [[h], 'shape_bad_type'], [h.toUpperCase().replace(/^[0-9]/, 'A'), 'hash_invalid'], [h.slice(1), 'hash_invalid'], [`${h}0`, 'hash_invalid'], [null, 'shape_bad_type'], ['', 'hash_invalid'], [{ toString: () => h }, 'shape_bad_type']]) {
    assertInvalid(classifySnapshot({ ...s, provider_snapshot_sha256: v }), code, JSON.stringify(v));
  }
  const { provider_snapshot_sha256, ...noHash } = s;
  assertInvalid(classifySnapshot(noHash), 'shape_missing');
});

test('NEG billing retry of a skipped superseder: executed failure, skipped retry, billing retry -> FAIL', () => {
  const s = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, conclusion: 'skipped', steps: [], ann: [] }, { id: 3, attempt: 3 }]);
  assert.equal(s.state, 'snapshot_valid');
  const r = classifySnapshot(s);
  assert.equal(r.classification, 'ci_mixed_execution');
  assert.equal(rowOf(r, 1).verdict, 'executed_failure');
});

test('NEG forged superseder chain: a superseder forged to success in its row AND job_inputs disagrees with jobs[]; forged attempts are refused', () => {
  const s = snap([{ id: 1, attempt: 1, steps: [STEP], secs: 80 }, { id: 2, attempt: 2, steps: [FAILSTEP], secs: 70 }]);
  assertInvalid(classifySnapshot(forge(s, (c, row) => { Object.assign(row(2), { conclusion: 'success', supersession: 'not_applicable' }); row(2).job_inputs.conclusion = 'success'; })), 'job_row_mismatch');
  // the same forgery carried into jobs[] too: the earlier row's recorded supersession target no longer matches nothing else; still FAIL or refused, never benign
  const deep = forge(s, (c, row, job) => { Object.assign(row(2), { conclusion: 'success', supersession: 'not_applicable' }); row(2).job_inputs.conclusion = 'success'; job(2).inputs.conclusion = 'success'; });
  assert.equal(classifySnapshot(deep).classification, 'no_failure_observed', 'a FULLY self-consistent forgery is the documented residual (the hash is not recomputed here; S-05c does)');
  // a superseded_by_attempt pointing past the last attempt, or at itself
  for (const by of [3, 1]) assertInvalid(classifySnapshot(forge(s, (c, row) => { row(1).superseded_by_attempt = by; })), 'supersession_mismatch', `by ${by}`);
});

test('NEG missing check: a bound row removed while its job stays in jobs[] is refused; a duplicated row is refused', () => {
  const s = snap([{ id: 1, ...OK }, { id: 2, name: 'unit', steps: [STEP], secs: 80 }]);
  assertInvalid(classifySnapshot(forge(s, (c) => { c.check_runs = c.check_runs.filter((r) => r.id !== '2'); })), 'job_not_bound_by_one_row');
  assertInvalid(classifySnapshot(forge(s, (c) => { c.check_runs.push(structuredClone(c.check_runs[0])); })), 'row_id_duplicate');
});

test('NEG missing steps / runner: removed keys and absent markers are refused, on a success row too', () => {
  const s = snap([{ id: 1, ...OK }, { id: 2, name: 'unit', steps: [STEP], secs: 80 }]);
  assert.equal(s.state, 'snapshot_valid');
  for (const k of ['steps_state', 'steps', 'runner_name_state', 'runner_name', 'labels_state']) {
    assertInvalid(classifySnapshot(forge(s, (c, row) => { delete row(1).job_inputs[k]; })), 'shape_missing', k);
  }
  assertInvalid(classifySnapshot(forge(s, (c, row, job) => { Object.assign(row(2).job_inputs, { steps_state: 'absent', steps_type: 'absent', steps: null }); Object.assign(job(2).inputs, { steps_state: 'absent', steps_type: 'absent', steps: null }); })), 'input_status_mismatch');
  assertInvalid(classifySnapshot(forge(s, (c, row, job) => { Object.assign(row(2).job_inputs, { runner_name_state: 'absent', runner_name: null }); Object.assign(job(2).inputs, { runner_name_state: 'absent', runner_name: null }); })), 'input_status_mismatch');
  assert.equal(snap([{ id: 1, runner: null }]).state, 'incomplete', 'the builder itself refuses a failure without runner_name');
});

test('NEG status != completed: on the row, on the job, or a step status outside the closed set', () => {
  const s = snap([{ id: 1, ...OK }]);
  assertInvalid(classifySnapshot(forge(s, (c, row) => { row(1).status = 'in_progress'; })), 'shape_not_in_set');
  assertInvalid(classifySnapshot(forge(s, (c, row, job) => { row(1).job_inputs.status = 'in_progress'; job(1).inputs.status = 'in_progress'; })), 'job_not_completed');
  assertInvalid(classifySnapshot(forge(s, (c, row) => { row(1).job_inputs.steps[0].status = 'done'; })), 'shape_not_in_set');
});

test('NEG prototype-pollution keys (__proto__, constructor, prototype) anywhere are refused, in-process and through the CLI', () => {
  const s = snap([{ id: 1, ...OK }]);
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    for (const [where, pick] of [['top', (c) => c], ['row', (c) => c.check_runs[0]], ['job_inputs', (c) => c.check_runs[0].job_inputs], ['step', (c) => c.check_runs[0].job_inputs.steps[0]], ['annotations', (c) => c.check_runs[0].annotations]]) {
      const f = forge(s, (c) => { Object.defineProperty(pick(c), k, { value: { conclusion: 'failure' }, enumerable: true, writable: true, configurable: true }); });
      assertInvalid(classifySnapshot(f), 'shape_unknown_key', `${k} on ${where}`);
    }
  }
  const text = JSON.stringify(s).replace('{"id":"1"', '{"__proto__":{"conclusion":"failure"},"id":"1"');
  assert.notEqual(text, JSON.stringify(s));
  assertInvalid(classifySnapshot(parseStrictJson(text)), 'shape_unknown_key');
  assert.equal({}.conclusion, undefined, 'Object.prototype untouched');
});

test('NEG cancelled beside billing: only a cancelled EXTERNAL check may coexist; a cancelled Actions job is unclassified', () => {
  assert.equal(classifySnapshot(snap([...six(), { id: 7, name: 'review', ...EXT, conclusion: 'cancelled' }])).classification, 'billing_blocked');
  const actions = classifySnapshot(snap([...six(), { id: 7, name: 'deploy', conclusion: 'cancelled', steps: [], ann: [] }]));
  assert.equal(actions.classification, 'unavailable');
  assert.ok(rowOf(actions, 7).reasons.includes('R2_conclusion_not_failure_or_startup_failure'));
  assert.equal(classifySnapshot(snap([{ id: 1, ...OK }, { id: 7, name: 'review', ...EXT, conclusion: 'cancelled' }])).classification, 'unavailable', 'cancelled without billing: not benign');
});

test('NEG non-success states: for EVERY required check and every conclusion but success, the result is never no_failure_observed', () => {
  for (const c of CONCLUSIONS.filter((x) => x !== 'success')) {
    for (const [label, spec] of [['actions', { name: 'unit', conclusion: c, steps: [], ann: [] }], ['actions executed', { name: 'unit', conclusion: c, steps: [STEP], ann: [], secs: 40 }], ['external', { name: 'review', ...EXT, conclusion: c }]]) {
      for (const pos of [0, 1]) {
        const specs = [{ id: 1, name: 'lint', ...OK }];
        specs.splice(pos, 0, { id: 2, ...spec });
        const s = snap(specs.map((x, i) => ({ ...x, id: i + 1 })));
        assert.equal(s.state, 'snapshot_valid', `${label} ${c}`);
        const r = classifySnapshot(s);
        assert.notEqual(r.classification, 'no_failure_observed', `${label} ${c} at ${pos}`);
        assert.ok(CI_STATES.includes(r.ci_state));
      }
    }
  }
});

test('NEG duplicate keys at nested depth are refused by the parser (CLI exit 3), never classified', () => {
  const s = JSON.stringify(snap([{ id: 1, steps: [STEP], secs: 80 }]));
  for (const [label, text] of [['top', s.replace('"schema":', '"schema":"x","schema":')], ['row', s.replace('"conclusion":"failure"', '"conclusion":"failure","conclusion":"success"')],
    ['job_inputs', s.replace('"steps_state":"array"', '"steps_state":"array","steps_state":"array"')], ['step', s.replace('"name":"run"', '"name":"run","name":"run"')], ['annotations', s.replace('"messages":', '"count":1,"messages":')]]) {
    assert.notEqual(text, s, label);
    assert.throws(() => parseStrictJson(text), /duplicate_key/, label);
  }
});

test('the classifier entry is sealed: classifyNormal refuses anything validateSnapshot did not produce', () => {
  const v = validateSnapshot(snap([{ id: 1, steps: [STEP], secs: 80 }]));
  assert.equal(classifyNormal(v.normal).classification, 'failed_code');
  const fake = { hash: 'a'.repeat(64), rows: [{ id: '1', name: 'x', app: 'github-actions', external: false, conclusion: 'success', key: '["1","x"]', attempt: 1, steps: [], runner_name: '', annotation: { status: 'none', messages: [], count: 0, sha256: null } }] };
  for (const f of [fake, structuredClone(v.normal), { ...v.normal }, null, undefined]) {
    const r = classifyNormal(f);
    assert.equal(r.classification, 'unavailable');
    assert.deepEqual(r.reasons, ['invalid:not_a_validated_normal_form@/']);
  }
  assert.throws(() => { v.normal.rows[0].conclusion = 'success'; }, TypeError, 'the normal form is frozen');
});

test('a Proxy or a getter cannot answer validation and classification differently', () => {
  const s = snap([{ id: 1, ...OK }]);
  assertInvalid(classifySnapshot(new Proxy(s, {})), 'unreadable');
  let n = 0;
  const g = forge(s, (c) => { Object.defineProperty(c.check_runs[0], 'conclusion', { get: () => (n++ ? 'failure' : 'success'), enumerable: true, configurable: true }); });
  assertInvalid(classifySnapshot(g), 'shape_accessor');
});

test('liveness on realistic provider lines: labels, runner groups, null steps/labels and extra provider fields validate; the documented pipe works', () => {
  const step = { name: 'a', status: 'completed', conclusion: 'success', number: 1, started_at: ts(1), completed_at: ts(2) };
  const job = (id, extra) => ({ id, name: `j${id}`, run_id: 100, run_attempt: 1, head_sha: SHA, status: 'completed', conclusion: 'success', started_at: ts(0), completed_at: ts(30), runner_name: 'GitHub Actions 2', check_run_url: url(id), html_url: 'h', node_id: 'n', workflow_name: 'ci', runner_id: 5, ...extra });
  const jobs = [job(1, { labels: ['ubuntu-latest'], runner_group_name: 'GitHub Actions', steps: [step] }), job(2, { steps: null, labels: null, runner_group_name: null }), job(3, { labels: [] })];
  const checks = jobs.map((j) => ({ id: j.id, name: j.name, head_sha: SHA, status: 'completed', conclusion: 'success', started_at: j.started_at, completed_at: j.completed_at, url: url(j.id), app: { slug: 'github-actions', id: 15368 }, output: { annotations_count: 0, title: null }, details_url: 'd', check_suite: { id: 1 } }));
  const s = buildSnapshot({ texts: { checkRuns: nl(checks), jobs: { 'a.jsonl': nl(jobs) }, annotations: {}, problems: [] }, repo: REPO, sha: SHA, origin: ORIGIN });
  assert.equal(s.state, 'snapshot_valid');
  assert.equal(validateSnapshot(s).ok, true, JSON.stringify(validateSnapshot(s).reasons));
  assert.equal(classifySnapshot(s).classification, 'no_failure_observed');
  // ci-snapshot.mjs check ... | ci-classify.mjs classify --snapshot-json -
  const snapOut = spawnSync(process.execPath, [join(HERE, 'ci-snapshot.mjs'), 'check', '--snapshot', REPLICA, '--repo', REPO, '--sha', SHA, '--origin', ORIGIN], { encoding: 'utf8' });
  assert.equal(snapOut.status, 0);
  const piped = cli(['classify', '--snapshot-json', '-'], snapOut.stdout);
  assert.equal(piped.status, 1);
  assert.equal(JSON.parse(piped.stdout).classification, 'billing_blocked');
});

test('an unknown key is never echoed into the output (no input can plant a word in the reasons)', () => {
  const r = classifySnapshot(forge(snap([{ id: 1, ...OK }]), (s) => { s.check_runs[0].passed_LOCAL_CI_VERIFIED = true; }));
  assertInvalid(r, 'shape_unknown_key');
  assert.deepEqual(r.reasons, ['invalid:shape_unknown_key@/check_runs/0/*']);
});

test('zero annotations with an EMPTY annotation file (the common real case): the builder hashes [] and the snapshot is classified, never refused', () => {
  const green = snap([{ id: 1, ...OK, emptyAnnFile: true }, { id: 2, name: 'lint', ...OK, emptyAnnFile: true }, { id: 3, name: 'review', ...EXT, conclusion: 'success', emptyAnnFile: true }]);
  assert.equal(green.state, 'snapshot_valid');
  const empty = green.check_runs[0].annotations;
  assert.equal(empty.status, 'none');
  assert.match(empty.sha256, /^[0-9a-f]{64}$/, 'the REAL builder records a hash for an empty annotation file');
  assert.equal(empty.sha256, EMPTY_ANNOTATIONS_SHA256, 'the accepted value is exactly what buildSnapshot emits');
  assert.equal(snap([{ id: 1, ...OK }]).check_runs[0].annotations.sha256, null, 'no file: null');
  // (a) a green run: classified per precedence, not invalid
  assert.equal(validateSnapshot(green).ok, true, JSON.stringify(validateSnapshot(green).reasons));
  assert.equal(classifySnapshot(green).classification, 'no_failure_observed');
  // (b) a failed check with zero annotations (empty file): R4 fails, unavailable by precedence; executed: failed_code
  const zeroAnn = classifySnapshot(snap([{ id: 1, ann: [], emptyAnnFile: true }]));
  assert.equal(zeroAnn.classification, 'unavailable');
  assert.ok(rowOf(zeroAnn, 1).reasons.includes('R4_annotation_not_allowlisted'));
  assert.equal(invalidCodes(zeroAnn).length, 0);
  assert.equal(classifySnapshot(snap([{ id: 1, ann: [], emptyAnnFile: true, steps: [STEP], secs: 80 }])).classification, 'failed_code');
  // (c) a failed check with annotations beside zero-annotation green checks
  assert.equal(classifySnapshot(snap([...six(), { id: 7, name: 'lint', ...OK, emptyAnnFile: true }])).classification, 'billing_blocked');
  // (d) the empty-list hash where annotations exist, any other hash on status none, or null-ness swapped: invalid
  const withAnn = snap(six());
  assertInvalid(classifySnapshot(forge(withAnn, (s) => { s.check_runs[0].annotations.sha256 = EMPTY_ANNOTATIONS_SHA256; })), 'annotations_inconsistent');
  assertInvalid(classifySnapshot(forge(withAnn, (s) => { s.check_runs[0].annotations.sha256 = null; })), 'annotations_inconsistent');
  assertInvalid(classifySnapshot(forge(green, (s) => { s.check_runs[0].annotations.sha256 = withAnn.check_runs[0].annotations.sha256; })), 'annotations_inconsistent');
  assertInvalid(classifySnapshot(forge(green, (s) => { s.check_runs[0].annotations.sha256 = 'f'.repeat(64); })), 'annotations_inconsistent');
  assertInvalid(classifySnapshot(forge(green, (s) => { s.check_runs[0].annotations.sha256 = EMPTY_ANNOTATIONS_SHA256.toUpperCase(); })), 'annotations_inconsistent');
  assertInvalid(classifySnapshot(forge(green, (s) => { s.check_runs[0].annotations.sha256 = 0; })), 'shape_bad_type');
  // through the documented CLI pipe: a real snapshot directory whose zero-annotation checks have empty annotation files
  const dir = mkdtempSync(join(tmpdir(), 'ci-classify-emptyann-'));
  try {
    for (const rel of ['check-runs.jsonl', ...readdirSync(join(REPLICA, 'jobs')).map((n) => join('jobs', n)), ...readdirSync(join(REPLICA, 'annotations')).map((n) => join('annotations', n))]) {
      mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), readFileSync(join(REPLICA, rel)));
    }
    const zero = readFileSync(join(REPLICA, 'check-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.output?.annotations_count === 0);
    assert.ok(zero.length >= 1);
    for (const c of zero) writeFileSync(join(dir, 'annotations', `${c.id}.jsonl`), '');
    const out = spawnSync(process.execPath, [join(HERE, 'ci-snapshot.mjs'), 'check', '--snapshot', dir, '--repo', REPO, '--sha', SHA, '--origin', ORIGIN], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    const piped = cli(['classify', '--snapshot-json', '-'], out.stdout);
    assert.equal(JSON.parse(piped.stdout).classification, 'billing_blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- every typed reason code fires (the INVALID_CODES table; a code without a breaking case fails the suite) ----
const BASE = () => snap([{ id: 1, ...OK }, { id: 2, name: 'unit', attempt: 1, steps: [STEP], secs: 80 }, { id: 3, name: 'unit', attempt: 2, ...OK }, { id: 4, name: 'review', ...EXT, conclusion: 'success' }]);
const CODE_CASES = [
  ['not_internally_consistent', (s) => { s.internally_consistent = false; }],
  ['snapshot_reports_problems', (s) => { s.reasons = ['x']; }],
  ['not_attested_mismatch', (s) => { s.not_attested = s.not_attested.slice(1); }],
  ['hash_invalid', (s) => { s.provider_snapshot_sha256 = 'g'.repeat(64); }],
  ['repo_invalid', (s) => { s.repo = 'Acme/Widgets'; }],
  ['head_sha_invalid', (s) => { s.head_sha = 'ABF4' + s.head_sha.slice(4); }],
  ['origin_invalid', (s) => { s.origin = 'http://api.github.com'; }],
  ['no_check_runs', (s) => { s.check_runs = []; s.jobs = []; }],
  ['row_id_invalid', (s, row) => { row(4).id = '04'; }],
  ['row_id_duplicate', (s) => { s.check_runs.push(structuredClone(s.check_runs[3])); }],
  ['row_fields_malformed', (s, row) => { row(1).fields_malformed = true; }],
  ['binding_app_mismatch', (s, row) => { row(4).app = 'github-actions'; }],
  ['external_row_inconsistent', (s, row) => { row(4).input_status = 'ok'; }],
  ['bound_row_inconsistent', (s, row) => { row(1).job_inputs = null; }],
  ['job_not_completed', (s, row, job) => { row(1).job_inputs.status = 'queued'; job(1).inputs.status = 'queued'; }],
  ['conclusion_inconsistent', (s, row, job) => { row(1).job_inputs.conclusion = 'neutral'; job(1).inputs.conclusion = 'neutral'; }],
  ['attempt_inconsistent', (s, row, job) => { row(1).job_inputs.run_attempt = 2; job(1).inputs.run_attempt = 2; }],
  ['steps_state_inconsistent', (s, row, job) => { row(1).job_inputs.steps_type = 'null'; job(1).inputs.steps_type = 'null'; }],
  ['runner_state_inconsistent', (s, row, job) => { row(1).job_inputs.runner_name_state = 'null'; job(1).inputs.runner_name_state = 'null'; }],
  ['labels_state_inconsistent', (s, row, job) => { row(1).job_inputs.labels_state = 'array'; job(1).inputs.labels_state = 'array'; }],
  ['input_status_mismatch', (s, row, job) => { row(1).input_status = 'outside_r3'; job(1).input_status = 'outside_r3'; }],
  ['annotations_inconsistent', (s, row) => { row(1).annotations.count = 1; }],
  ['supersession_mismatch', (s, row) => { row(2).supersession = 'not_superseded'; delete row(2).superseded_by_attempt; }],
  ['ambiguous_job_slot', (s, row, job) => { s.check_runs.push({ ...structuredClone(row(1)), id: '9', job_id: '9' }); s.jobs.push({ ...structuredClone(job(1)), id: '9' }); }],
  ['attempt_gap', (s, row, job) => { for (const [r, j] of [[row(1), job(1)]]) { r.run_attempt = 5; r.job_inputs.run_attempt = 5; j.run_attempt = 5; j.inputs.run_attempt = 5; } }],
  ['job_id_invalid', (s, row, job) => { job(1).run_id = '0100'; }],
  ['job_id_duplicate', (s, row, job) => { s.jobs.push(structuredClone(job(1))); }],
  ['job_row_inconsistent', (s, row, job) => { job(1).bound = false; }],
  ['job_row_mismatch', (s, row, job) => { job(1).inputs.runner_group_name = 'forged'; }],
  ['job_not_bound_by_one_row', (s, row, job) => { s.jobs.push({ ...structuredClone(job(1)), id: '99' }); }],
  ['shape_unknown_key', (s, row) => { row(1).passed = true; }],
  ['shape_missing', (s, row) => { delete row(1).annotations; }],
  ['shape_bad_type', (s, row) => { row(1).run_attempt = '1'; }],
  ['shape_not_in_set', (s) => { s.state = 'incomplete'; }],
  ['shape_not_object', (s) => { s.check_runs[0] = 'x'; }],
  ['shape_not_array', (s) => { s.jobs = {}; }],
  ['shape_accessor', (s, row) => { Object.defineProperty(row(1), 'id', { get: () => '1', enumerable: true, configurable: true }); }],
];
test('INVALID_CODES: every semantic reason code has a breaking case and fires, with the classification unavailable', () => {
  const base = BASE();
  assert.equal(base.state, 'snapshot_valid');
  assert.equal(base.check_runs[1].supersession, 'superseded');
  assert.equal(classifySnapshot(base).classification, 'no_failure_observed');
  for (const [code, fn] of CODE_CASES) {
    assert.ok(INVALID_CODES.includes(code), `${code} is listed`);
    assertInvalid(classifySnapshot(forge(base, fn)), code);
  }
  const covered = new Set([...CODE_CASES.map(([c]) => c), 'unreadable', 'not_a_validated_normal_form']);
  assert.deepEqual(INVALID_CODES.filter((c) => !c.startsWith('shape_') && !covered.has(c)), [], 'every semantic code has a case');
  assertInvalid(classifySnapshot(new Proxy(base, {})), 'unreadable');
});

// ---- GENERATED differential/property test: an INDEPENDENT oracle over the planted spec (imports nothing from ci-classify.mjs) ----
const mulberry32 = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ORACLE_BILL = BILL_TEXT; // the oracle's own copy of the allowlist
const ORACLE_MAX = 10; // the oracle's own copy of the provisional threshold
function generate(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const specs = [];
  let id = 1;
  // widened grammar: several run ids (incl. a max safe integer), names with spaces/slashes, several external apps
  const RUNS = [100, 200, 300, 7000000001, 9007199254740991];
  const NAMES = ['build', 'unit', 'lint', 'e2e', 'sast', 'deploy preview', 'node 18 / ubuntu'];
  const APPS = ['coderabbitai', 'vercel', 'codecov', 'sonarcloud'];
  const sample = (a, n) => { const c = a.slice(); const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return out; };
  for (const run of sample(RUNS, rnd() < 0.6 ? 1 : rnd() < 0.7 ? 2 : 3)) {
    for (const name of sample(NAMES, 1 + Math.floor(rnd() * 3))) {
      const k = rnd() < 0.55 ? 1 : rnd() < 0.6 ? 2 : 3;
      for (let attempt = 1; attempt <= k; attempt++) {
        const conclusion = pick(['success', 'success', 'success', 'failure', 'failure', 'failure', 'startup_failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale']);
        const steps = rnd() < 0.03 ? undefined : pick([[], [], [SKIP], [STEP], [FAILSTEP], [SKIP, STEP]]);
        const runner = rnd() < 0.03 ? null : conclusion === 'skipped' && rnd() < 0.5 ? null : pick(['', '', 'gh-runner-1']);
        specs.push({ id: id++, name, run, attempt, app: 'github-actions', conclusion, steps, runner, secs: Math.floor(rnd() * 15), ann: pick([[BILL], [BILL], [], [], ['other'], [BILL, BILL], [`${BILL} `]]), emptyAnnFile: rnd() < 0.5 });
      }
    }
  }
  const ext = rnd() < 0.5 ? 0 : rnd() < 0.6 ? 1 : 2;
  for (let i = 0; i < ext; i++) specs.push({ id: id++, name: `ext${i}`, run: 100, attempt: 1, app: pick(APPS), conclusion: pick(['success', 'success', ...CONCLUSIONS]), steps: undefined, runner: '', secs: Math.floor(rnd() * 5), ann: pick([[], [], [BILL]]), emptyAnnFile: rnd() < 0.5 });
  return specs;
}
const FAILED = (c) => !['success', 'neutral', 'skipped'].includes(c);
/** The oracle: no_failure_observed iff every check's latest attempt is success and every failure has a later success; any live executed failure is FAIL. */
function oracle(specs) {
  const acts = specs.filter((s) => s.app === 'github-actions'), ext = specs.filter((s) => s.app !== 'github-actions');
  const cleared = (s) => acts.some((o) => o.run === s.run && o.name === s.name && o.attempt > s.attempt && o.conclusion === 'success');
  const live = acts.filter((s) => FAILED(s.conclusion) && !cleared(s));
  const executed = live.filter((s) => s.steps.some((st) => st.conclusion !== 'skipped'));
  const billing = live.filter((s) => !executed.includes(s) && ['failure', 'startup_failure'].includes(s.conclusion) && s.secs <= ORACLE_MAX && s.runner === '' && s.ann.length > 0 && s.ann.every((m) => m === ORACLE_BILL));
  const extFail = ext.filter((s) => FAILED(s.conclusion) && s.conclusion !== 'cancelled');
  const latestOk = [...new Set(acts.map((s) => `${s.run}/${s.name}`))].every((k) => { const a = acts.filter((s) => `${s.run}/${s.name}` === k); return a.reduce((m, s) => (s.attempt > m.attempt ? s : m)).conclusion === 'success'; });
  const benign = latestOk && live.length === 0 && ext.every((s) => s.conclusion === 'success');
  const expected = executed.length ? (billing.length ? 'ci_mixed_execution' : 'failed_code') : extFail.length || live.length > billing.length ? 'unavailable' : billing.length ? 'billing_blocked' : benign ? 'no_failure_observed' : 'unavailable';
  return { expected, benign, liveExecuted: executed.length > 0, extFail: extFail.length > 0 };
}
/** Malforming operators: each one changes the snapshot in a way a validator applying ci-snapshot's rules MUST refuse. Returns false if not applicable. */
const MALFORM = {
  hash: (s, rnd) => { const h = s.provider_snapshot_sha256; s.provider_snapshot_sha256 = [42, [h], h.slice(1), `${h}0`, null, '', h.replace(/[0-9a-f]$/, 'G')][Math.floor(rnd() * 7)]; return true; },
  row_conclusion: (s, rnd, b) => { if (!b) return false; b.conclusion = CONCLUSIONS.filter((c) => c !== b.conclusion)[Math.floor(rnd() * 8)]; return true; },
  supersession: (s, rnd, b, any) => { any.supersession = ['not_applicable', 'superseded', 'not_superseded'].filter((v) => v !== any.supersession)[Math.floor(rnd() * 2)]; return true; },
  input_status: (s, rnd, b, any) => { any.input_status = ['ok', 'outside_r3', 'external'].filter((v) => v !== any.input_status)[Math.floor(rnd() * 2)]; return true; },
  drop_bound_row: (s, rnd, b) => { if (!b) return false; s.check_runs.splice(s.check_runs.indexOf(b), 1); return true; },
  delete_key: (s, rnd, b, any) => { const ks = Object.keys(any); delete any[ks[Math.floor(rnd() * ks.length)]]; return true; },
  unknown_key: (s, rnd, b, any) => { const target = [s, any, any.annotations, any.job_inputs].filter(Boolean)[Math.floor(rnd() * 3)]; Object.defineProperty(target, ['extra', '__proto__', 'constructor', 'passed'][Math.floor(rnd() * 4)], { value: 1, enumerable: true, writable: true, configurable: true }); return true; },
  type_change: (s, rnd, b, any) => { const k = Math.floor(rnd() * 3); if (k === 0 && b) b.run_attempt = String(b.run_attempt); else if (k === 1) any.id = Number(any.id); else any.annotations.count = String(any.annotations.count); return true; },
  job_conclusion: (s, rnd, b) => { if (!b) return false; b.job_inputs.conclusion = CONCLUSIONS.filter((c) => c !== b.job_inputs.conclusion)[Math.floor(rnd() * 8)]; return true; },
  jobs_inputs: (s, rnd, b) => { if (!b) return false; const j = s.jobs.find((x) => x.id === b.job_id); if (Array.isArray(j.inputs.steps)) j.inputs.steps.push({ ...STEP, number: 9 }); else j.inputs.runner_group_name = 'forged'; return true; },
  state: (s, rnd) => { s.state = ['incomplete', 'invalid', 'empty'][Math.floor(rnd() * 3)]; return true; },
  duplicate_row: (s, rnd, b, any) => { s.check_runs.push(structuredClone(any)); return true; },
  job_status: (s, rnd, b) => { if (!b) return false; b.job_inputs.status = 'in_progress'; return true; },
  annotation_count: (s, rnd, b, any) => { any.annotations.count += 1; return true; },
  reported_problem: (s) => { s.failed_predicates.push('annotations_complete'); return true; },
  forge_superseded: (s, rnd, b) => { if (!b || b.supersession !== 'not_superseded') return false; Object.assign(b, { supersession: 'superseded', superseded_by_attempt: b.run_attempt + 1 }); return true; },
  forge_skipped: (s, rnd, b) => { if (!b || !FAILED(b.conclusion)) return false; Object.assign(b, { conclusion: 'skipped', input_status: 'outside_r3', supersession: 'not_applicable' }); delete b.superseded_by_attempt; return true; },
  forge_success_superseder: (s, rnd, b) => { if (!b || b.conclusion === 'success') return false; Object.assign(b, { conclusion: 'success', supersession: 'not_applicable' }); b.job_inputs.conclusion = 'success'; delete b.superseded_by_attempt; return true; },
  not_consistent: (s) => { s.internally_consistent = false; return true; },
};
const MALFORM_NAMES = Object.keys(MALFORM);
function runProperty(seeds, perSeed) {
  const stats = { total: 0, empty_annotation_files: 0, valid: 0, malformed: 0, builder_refused: 0, by: Object.fromEntries(Object.keys(CLASSIFICATIONS).map((k) => [k, 0])), ops: Object.fromEntries(MALFORM_NAMES.map((k) => [k, 0])) };
  for (const seed of seeds) {
    const rnd = mulberry32(seed);
    for (let i = 0; i < perSeed; i++) {
      const specs = generate(rnd);
      const s = snap(specs);
      stats.empty_annotation_files += specs.filter((x) => x.emptyAnnFile && x.ann.length === 0).length;
      const where = `seed ${seed.toString(16)} #${i}`;
      stats.total++;
      if (s.state !== 'snapshot_valid') {
        stats.builder_refused++;
        assert.equal(classifySnapshot(s).classification, 'unavailable', `${where}: builder state ${s.state}`);
        continue;
      }
      const o = oracle(specs);
      if (rnd() < 0.35) {
        const f = JSON.parse(JSON.stringify(s));
        const bound = f.check_runs.filter((r) => r.binding === 'bound');
        let op;
        for (let t = 0; t < 20; t++) {
          const name = MALFORM_NAMES[Math.floor(rnd() * MALFORM_NAMES.length)];
          if (MALFORM[name](f, rnd, bound[Math.floor(rnd() * bound.length)], f.check_runs[Math.floor(rnd() * f.check_runs.length)])) { op = name; break; }
        }
        stats.malformed++; stats.ops[op]++;
        const r = classifySnapshot(f);
        assert.equal(r.classification, 'unavailable', `${where}: malformed by ${op} must be unavailable, got ${r.classification}`);
        assert.ok(r.reasons.length > 0 && r.reasons.every((x) => /^invalid:[a-z_]+@/.test(x)), `${where}: ${op}: ${r.reasons}`);
        assert.ok(invalidCodes(r).every((c) => INVALID_CODES.includes(c)), `${where}: ${op}: a code outside INVALID_CODES: ${r.reasons}`);
        assert.equal(r.snapshot_sha256, null);
        continue;
      }
      stats.valid++;
      const v = validateSnapshot(s);
      assert.equal(v.ok, true, `${where}: LIVENESS: a builder-valid snapshot must validate: ${v.reasons}`);
      const r = classifySnapshot(s);
      stats.by[r.classification]++;
      // safety, both directions that matter: never benign / billing when the oracle says not
      if (r.classification === 'no_failure_observed') assert.ok(o.benign, `${where}: benign but the oracle says not`);
      if (r.classification === 'billing_blocked') assert.ok(!o.liveExecuted && !o.extFail, `${where}: billing masks a failure`);
      if (o.liveExecuted) assert.equal(r.ci_state, 'FAIL', `${where}: a live executed failure must be FAIL`);
      assert.equal(r.classification, o.expected, `${where}: differential ${JSON.stringify(specs)}`);
      assert.equal(r.snapshot_sha256, s.provider_snapshot_sha256);
      assert.deepEqual(classifySnapshot(JSON.parse(JSON.stringify(s))), r, `${where}: the CLI's view (a JSON round trip) classifies identically`);
    }
  }
  return stats;
}
const PROPERTY_SEEDS = [0x5eed0001, 0x5eed0002, 0x5eed0003, 0x5eed0004, 0x5eed0005, 0x5eed0006];
const PER_SEED = IN_CHILD ? 300 : 5000;
test(`property: ${PROPERTY_SEEDS.length * PER_SEED} generated snapshots (seeds ${PROPERTY_SEEDS.map((x) => x.toString(16)).join(',')}) agree with the independent oracle; liveness and coverage asserted`, () => {
  const stats = runProperty(PROPERTY_SEEDS, PER_SEED);
  console.log(`# property ${JSON.stringify(stats)}`);
  assert.equal(stats.total, PROPERTY_SEEDS.length * PER_SEED);
  const floor = IN_CHILD ? 5 : 100;
  for (const [k, n] of Object.entries(stats.by)) assert.ok(n >= floor, `classification ${k} reached ${n} times (< ${floor})`);
  assert.ok(stats.builder_refused >= floor && stats.malformed >= floor * 5, JSON.stringify(stats));
  if (!IN_CHILD) for (const [k, n] of Object.entries(stats.ops)) assert.ok(n >= 50, `malform op ${k} applied ${n} times`);
  assert.ok(stats.empty_annotation_files >= (IN_CHILD ? 20 : 1000), `zero-annotation checks with an EMPTY annotation file generated: ${stats.empty_annotation_files}`);
});

// ---- advisory guarantee ----
const ALL_CASES = () => [
  snap(six()), snap([{ id: 1, steps: [STEP], secs: 90 }]), snap([{ id: 1, steps: [STEP] }, ...six().slice(1)]), snap([{ id: 1, ann: ['other'] }]),
  snap([{ id: 1, ...OK }]), snap([{ id: 1, steps: undefined }]), null, { schema: 'x' },
  snap([{ id: 1, conclusion: 'failure', steps: [SKIP] }]), forge(snap(six()), (s) => { s.provider_snapshot_sha256 = [s.provider_snapshot_sha256]; }),
  forge(snap([{ id: 1, ...OK }]), (s) => { s.passed_LOCAL_CI_VERIFIED = true; s.check_runs[0].eligible_waived = 1; }),
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
    assert.ok(!/pass|waive|eligib|CI_PASSED|LOCAL_CI_VERIFIED/i.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
    assert.equal(r.note, 'Required checks unverified; no gate decision.');
  }
});

test('negative: a failed required check classified billing_blocked yields a non-pass status; only the existing fallback rule may waive it', () => {
  const overall = (r) => (r.ci_state === 'FAIL' ? 'FAIL' : r.ci_state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NOT_PASSED_UNTIL_REQUIRED_CHECK_POLICY');
  const r = classifySnapshot(snap(six()));
  assert.equal(r.classification, 'billing_blocked');
  assert.equal(overall(r), 'UNAVAILABLE');
  assert.ok(!Object.hasOwn(r, 'eligible') && !Object.hasOwn(r, 'waived') && !Object.hasOwn(r, 'passed') && !Object.hasOwn(r, 'fallback_eligible'));
  for (const s of ALL_CASES()) assert.notEqual(overall(classifySnapshot(s)), 'PASS');
  assert.equal(overall(classifySnapshot(snap([{ id: 1, ...OK }]))), 'NOT_PASSED_UNTIL_REQUIRED_CHECK_POLICY');
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
test('R2 boundary: 10 s is billing, 11 s is not; missing, malformed, impossible or reversed timestamps are not durations', () => {
  assert.equal(classifySnapshot(snap([{ id: 1, secs: 10 }])).classification, 'billing_blocked');
  assert.equal(classifySnapshot(snap([{ id: 1, secs: 11 }])).classification, 'unavailable');
  assert.equal(classifySnapshot(snap([{ id: 1, secs: 0 }])).classification, 'billing_blocked');
  assert.equal(durationSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:00:10.500Z'), 10.5);
  assert.equal(durationSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'), 10);
  assert.equal(durationSeconds('2028-02-29T00:00:00Z', '2028-02-29T00:00:05Z'), 5);
  for (const [a, b] of [[null, ts(1)], [ts(1), null], [undefined, undefined], ['yesterday', ts(1)], [ts(5), ts(1)], ['2026-01-01 00:00:00', ts(1)], [1, 2],
    ['2026-02-30T00:00:00Z', '2026-02-30T00:00:05Z'], ['2026-13-01T00:00:00Z', '2026-13-01T00:00:05Z'], ['2026-01-01T24:00:00Z', '2026-01-01T24:00:05Z'], ['2026-02-29T00:00:00Z', '2026-02-29T00:00:05Z']]) assert.equal(durationSeconds(a, b), null, String(a));
  // a null check-run timestamp is builder-legal and validates; it is never billing
  const s = buildSnapshot({ texts: { checkRuns: nl([{ id: 1, name: 'verify', head_sha: SHA, status: 'completed', conclusion: 'failure', started_at: ts(0), completed_at: null, url: url(1), app: { slug: 'github-actions' }, output: { annotations_count: 1 } }]),
    jobs: { 'run100-1.jsonl': nl([{ id: 1, name: 'verify', run_id: 100, run_attempt: 1, head_sha: SHA, status: 'completed', conclusion: 'failure', started_at: ts(0), completed_at: ts(1), runner_name: '', steps: [], check_run_url: url(1) }]) },
    annotations: { '1.jsonl': JSON.stringify({ message: BILL }) + '\n' }, problems: [] }, repo: REPO, sha: SHA, origin: ORIGIN });
  assert.equal(s.state, 'snapshot_valid');
  const r = classifySnapshot(s);
  assert.equal(r.classification, 'unavailable');
  assert.ok(rowOf(r, 1).reasons.includes('R2_duration_unknown'));
  for (const c of ['cancelled', 'timed_out', 'action_required', 'stale']) assert.equal(classifySnapshot(snap([{ id: 1, conclusion: c }])).classification, 'unavailable', c);
  assert.equal(classifySnapshot(snap([{ id: 1, conclusion: 'startup_failure' }])).classification, 'billing_blocked');
});
test('R2 replay over the corpus: every observed duration (real TICKET-B jobs, synthetic replica) is within the threshold with margin', () => {
  const real = readFileSync(REAL_FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const zeroStep = real.filter((j) => j.conclusion === 'failure' && Array.isArray(j.steps) && j.steps.length === 0 && j.runner_name === '');
  assert.equal(zeroStep.length, 6);
  const durations = real.map((j) => durationSeconds(j.started_at, j.completed_at));
  assert.ok(durations.every((d) => d !== null));
  assert.equal(Math.max(...durations), 2);
  assert.ok(Math.max(...durations) <= BILLING_MAX_SECONDS / 2, 'margin: the observed maximum is at most half the threshold');
  const replica = readSnapshot({ dir: REPLICA, repo: REPO, sha: SHA, origin: ORIGIN });
  assert.ok(Math.max(...replica.check_runs.map((r) => durationSeconds(r.started_at, r.completed_at))) <= BILLING_MAX_SECONDS / 2);
  assert.ok(Math.max(...durations) * 5 >= BILLING_MAX_SECONDS, 'the threshold is not more than 5x the observed maximum (an unvalidated estimate, n=1)');
});

// ---- synthetic linked replica (NOT H AC1: the real fixture has no head_sha / check runs / annotations) ----
test('synthetic replica: labelled synthetic on every check-run and job line; snapshot_valid; validates; classifies billing_blocked', () => {
  for (const f of ['check-runs.jsonl', ...readdirSync(join(REPLICA, 'jobs')).map((n) => join('jobs', n))]) {
    const lines = readFileSync(join(REPLICA, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => !Object.hasOwn(l, 'total_count'));
    assert.ok(lines.length > 0, f);
    assert.ok(lines.every((l) => l.synthetic === true), `${f}: every line carries "synthetic": true`);
    assert.ok(lines.every((l) => !/ticket|scrum/i.test(JSON.stringify(l))), `${f}: no ticket data`);
  }
  const s = readSnapshot({ dir: REPLICA, repo: REPO, sha: SHA, origin: ORIGIN });
  assert.equal(s.state, 'snapshot_valid');
  assert.equal(validateSnapshot(s).ok, true);
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

// ---- strict parse and CLI ----
test('parseStrictJson: equals JSON.parse on valid text and refuses BOM, duplicate keys (also nested), trailing text, depth and broken text', () => {
  const ok = '{"a":[1,2.5,-3e2,true,false,null,"x\\"y\\\\"],"b":{"c":{}},"d":[],"__proto__":{"k":1}}';
  assert.deepEqual(parseStrictJson(ok), JSON.parse(ok));
  assert.equal(Object.keys(parseStrictJson(ok)).includes('__proto__'), true);
  for (const bad of ['{"a":1,"a":2}', '{"x":{"a":1,"b":2,"a":3}}', '[{"a":1,"a":1}]', '{"a":1} x', '{"a":1', '{"a" 1}', '[1,]', '{"a":01}', '"abc', '{a:1}', '', '['.repeat(70) + ']'.repeat(70), '﻿{}']) assert.throws(() => parseStrictJson(bad), undefined, bad);
  assert.throws(() => parseStrictJson('﻿{}'), /^Error: bom$/);
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
    const b = cli(['classify', '--snapshot-json', '-'], JSON.stringify(snap([{ id: 1, ...OK }])));
    assert.equal(b.status, 1);
    assert.equal(JSON.parse(b.stdout).classification, 'no_failure_observed');
    for (const [name, bytes, reason] of [['bad.json', '{not json', /^snapshot_json_unreadable:/], ['bom.json', `﻿${JSON.stringify(snap([{ id: 1, ...OK }]))}`, /^snapshot_json_unreadable:bom$/],
      ['latin1.json', Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d]), /^snapshot_json_unreadable:not_utf8$/],
      ['dup.json', JSON.stringify(snap(six())).replace('"conclusion":"failure"', '"conclusion":"failure","conclusion":"success"'), /^snapshot_json_unreadable:duplicate_key$/]]) {
      writeFileSync(join(dir, name), bytes);
      const c = cli(['classify', '--snapshot-json', join(dir, name)]);
      assert.equal(c.status, 3, name);
      const out = JSON.parse(c.stdout);
      assert.equal(out.classification, 'unavailable', name);
      assert.equal(out.reasons.length, 1, name);
      assert.match(out.reasons[0], reason, name);
    }
    const m = cli(['classify', '--snapshot-json', join(dir, 'missing.json')]);
    assert.equal(m.status, 3);
    assert.equal(JSON.parse(m.stdout).classification, 'unavailable');
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, '{}');
    assert.equal(cli(['classify', '--snapshot-json', ok]).status, 1, 'a parsed but invalid snapshot is a classification (unavailable), exit 1');
    for (const args of [[], ['classify'], ['classify', '--snapshot-json'], ['check', '--snapshot-json', ok], ['classify', '--snapshot-json', ok, 'extra']]) assert.equal(cli(args).status, 2, args.join(' '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI main(): the injected stdin reader is used for "-", oversized input is refused (exit 3), and the status is never 0', () => {
  const orig = process.stdout.write;
  const run = (bytes) => { let out = ''; process.stdout.write = (c) => { out += c; return true; }; let status; try { status = main(['classify', '--snapshot-json', '-'], { readStdin: () => bytes }); } finally { process.stdout.write = orig; } return { status, out: JSON.parse(out) }; };
  const a = run(Buffer.from(JSON.stringify(snap(six()))));
  assert.equal(a.status, 1);
  assert.equal(a.out.classification, 'billing_blocked');
  const big = run(Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20));
  assert.equal(big.status, 3);
  assert.deepEqual(big.out.reasons, ['snapshot_json_unreadable:too_large']);
});

// ---- mutation (the shared harness, lib/mutation.test-helper.mjs): each mutant must be KILLED by an assertion ----
const SRC = loadMutationSource(join(HERE, 'ci-classify.mjs'));
const MUTANTS = [
  // classification rules (kept from the 41 where the code still exists, re-anchored)
  ['R5 ordering dropped: billing consulted before executed failures', "if (executed.length) return [billing.length ? 'ci_mixed_execution' : 'failed_code', all];", "if (executed.length && !billing.length) return ['failed_code', all];"],
  ['threshold 10 -> 60', 'export const BILLING_MAX_SECONDS = 10;', 'export const BILLING_MAX_SECONDS = 60;'],
  ['R2 bound made exclusive (10 s no longer billing)', 'else if (seconds > BILLING_MAX_SECONDS) failed.push', 'else if (seconds >= BILLING_MAX_SECONDS) failed.push'],
  ['R2 duration check dropped', "  else if (seconds > BILLING_MAX_SECONDS) failed.push('R2_duration_over_threshold');\n", ''],
  ['R2 unknown duration accepted', "  if (seconds === null) failed.push('R2_duration_unknown');\n  else if", '  if'],
  ['R4 allowlist becomes substring match', 'ann.messages.every((m) => BILLING_ANNOTATION_ALLOWLIST.includes(m))', 'ann.messages.every((m) => BILLING_ANNOTATION_ALLOWLIST.some((a) => m.includes(a)))'],
  ['R4 accepts when only one message matches', 'ann.messages.every((m) =>', 'ann.messages.some((m) =>'],
  ['R4 accepts annotation status none', "ann.status !== 'present' || ann.messages.length === 0 || ", ''],
  ['R3 runner_name not required empty', "  if (row.runner_name !== '') failed.push('R3_runner_name_not_empty');\n", ''],
  ['executed-step count counts skipped steps too', "row.steps.filter((x) => x.conclusion !== 'skipped').length", 'row.steps.length'],
  ['executed failure not decisive (billing consulted for it)', "  if (executed > 0) return { ...verdictRow(row, 'executed_failure', ['steps_executed'], evidence), executed: true };\n", ''],
  ['billing conclusion list widened to cancelled', "const BILLING_CONCLUSIONS = ['failure', 'startup_failure'];", "const BILLING_CONCLUSIONS = ['failure', 'startup_failure', 'cancelled'];"],
  ['M1: external failure tolerated beside billing', "return { ...verdictRow(row, 'external_failure', [`external_check_${c}`]), external_failure: true };", "return { ...verdictRow(row, 'external_failure', [`external_check_${c}`]), tolerated: true };"],
  ['M1: external timed_out and others treated as cancelled', 'if (NOT_EXECUTED.includes(c)) return { ...verdictRow(row, \'outside_classifier\'', 'if (c !== \'success\') return { ...verdictRow(row, \'outside_classifier\''],
  ['external failure ignored when nothing else fails', "  if (external.length) return ['unavailable', all];\n", ''],
  ['unclassified rows ignored beside billing', "  if (unclassified.length) return ['unavailable', all];\n", ''],
  ['mixed execution reported as plain failed_code', "billing.length ? 'ci_mixed_execution' : 'failed_code'", "'failed_code'"],
  // the restart's clearing and benign rules
  ['clearing: any later attempt clears (not only success)', "r.attempt > row.attempt && r.conclusion === 'success')", 'r.attempt > row.attempt)'],
  ['clearing: a skipped/neutral retry clears', "r.attempt > row.attempt && r.conclusion === 'success')", 'r.attempt > row.attempt && OK_CONCLUSIONS.includes(r.conclusion))'],
  ['clearing: attempt order ignored', 'r.key === row.key && r.attempt > row.attempt', 'r.key === row.key && r.attempt !== row.attempt'],
  ['clearing: another job can clear', "rows.filter((r) => r.key === row.key && r.attempt", 'rows.filter((r) => r.attempt'],
  ['latest skipped/neutral treated as benign', "[`latest_conclusion_${c}`]), tolerated: true };", '[`latest_conclusion_${c}`]), benign: true };'],
  ['external skipped/neutral/cancelled treated as benign', "[`external_check_${c}`]), tolerated: true };", '[`external_check_${c}`]), benign: true };'],
  ['benign requirement dropped', "if (evaluated.length > 0 && evaluated.every((r) => r.benign === true)) return ['no_failure_observed', all];", "return ['no_failure_observed', all];"],
  ['classifier entry not sealed', "  if (!NORMAL.has(normal)) return finish('unavailable', ['invalid:not_a_validated_normal_form@/'], [], null);\n", ''],
  // validation: the envelope
  ['snapshot state refusal dropped', "state: { enum: ['snapshot_valid'] },", "state: 'string',"],
  ['schema refusal dropped', 'schema: { enum: [SNAPSHOT_SCHEMA_ID] },', "schema: 'string',"],
  ['internally_consistent not required', "  if (s.internally_consistent !== true) bad('not_internally_consistent', 'internally_consistent');\n", ''],
  ['reported snapshot problems ignored', "if (s[k].length !== 0) bad('snapshot_reports_problems', k);", ''],
  ['not_attested not compared', "  if (!isDeepStrictEqual(s.not_attested, [...NOT_ATTESTED])) bad('not_attested_mismatch', 'not_attested');\n", ''],
  ['R2-c: hash shape not required', "  if (!HEX64.test(s.provider_snapshot_sha256)) bad('hash_invalid', 'provider_snapshot_sha256');\n", ''],
  ['R2-c: hash type coerced', "provider_snapshot_sha256: 'string',", "provider_snapshot_sha256: 'string|number|null',"],
  ['identity fields not checked', "  if (!/^[0-9a-f]{40}$/.test(s.head_sha)) bad('head_sha_invalid', 'head_sha');\n", ''],
  ['closed row shape opened (unknown keys accepted)', "const ROW = { object: {", 'const ROW = { open: true, object: {'],
  ['row status not required completed (successor of the old row)', "status: { enum: ['completed'] },", "status: 'string',"],
  ['unbound rows admitted by the binding enum (successor of "unbound treated as bound")', "binding: { enum: ['bound', 'external'] },", "binding: { enum: ['bound', 'external', 'unbound'] },"],
  ['unknown input_status admitted by the enum (successor of "unknown input_status treated as ok")', "input_status: { enum: ['ok', 'outside_r3', 'external'] },", "input_status: { enum: ['ok', 'outside_r3', 'external', 'unknown'] },"],
  ['impossible calendar dates accepted as durations (successor of the old row)', '  if (!isTimestamp(start) || !isTimestamp(end)) return null;', "  if (typeof start !== 'string' || typeof end !== 'string') return null;"],
  ['unknown key names echoed into the reasons', "(p.code === 'unknown_key' ? `${p.path.replace(/\\/[^/]*$/, '')}/*` : p.path)", '(p.path)'],
  // validation: rows
  ['row id shape not required', "    if (!isId(r.id)) bad('row_id_invalid', at);\n", ''],
  ['duplicate row ids accepted', "    if (rowIds.has(r.id)) bad('row_id_duplicate', at);\n", ''],
  ['fields_malformed ignored', "    if (r.fields_malformed !== false) bad('row_fields_malformed', at);\n", ''],
  ['binding/app agreement not required', "    if ((r.binding === 'bound') !== (r.app === 'github-actions') || r.app === '') bad('binding_app_mismatch', at);\n", ''],
  ['external row fields not checked', "bad('external_row_inconsistent', at);", ';'],
  ['bound row fields not checked', "{ bad('bound_row_inconsistent', at); continue; }", '{ continue; }'],
  ['empty-annotation hash: ANY hash accepted on status none', "(a.sha256 === null || a.sha256 === EMPTY_ANNOTATIONS_SHA256)", "(a.sha256 === null || typeof a.sha256 === 'string')"],
  ['empty-annotation hash accepted where annotations exist', "a.sha256 !== EMPTY_ANNOTATIONS_SHA256 && HEX64.test(a.sha256)", 'HEX64.test(a.sha256)'],
  ['annotation consistency not checked', "bad('annotations_inconsistent', at);", ';'],
  ['R2-a: row/job conclusion disagreement ignored', "    if (inp.conclusion !== r.conclusion) bad('conclusion_inconsistent', at);\n", ''],
  ['job status not required completed', "    if (inp.status !== 'completed') bad('job_not_completed', at);\n", ''],
  ['job attempt disagreement ignored', "    if (inp.run_attempt !== r.run_attempt) bad('attempt_inconsistent', at);\n", ''],
  ['steps_state marker not checked', "bad('steps_state_inconsistent', at);", ';'],
  ['runner_name_state marker not checked', "bad('runner_state_inconsistent', at);", ';'],
  ['labels_state marker not checked', "bad('labels_state_inconsistent', at);", ';'],
  ['input_status not recomputed', "    if (expectedInputStatus(inp) !== r.input_status) bad('input_status_mismatch', at);\n", ''],
  ['input_status: missing runner_name on a failure treated as ok', "return inp.steps_state === 'array' && inp.runner_name_state === 'string' ? 'ok' : 'unknown';", "return inp.steps_state === 'array' ? 'ok' : 'unknown';"],
  // validation: supersession and the jobs[] cross-check
  ['R2-b: supersession not recomputed', "    if (r.supersession !== want || by !== (want === 'superseded' ? best : undefined)) bad('supersession_mismatch', `check_runs/${i}`);\n", ''],
  ['R2-b: superseded_by_attempt not compared', " || by !== (want === 'superseded' ? best : undefined)) bad('supersession_mismatch'", ") bad('supersession_mismatch'"],
  ['supersession: skipped/neutral/cancelled may supersede', 'for (const r of bound) if (!NOT_EXECUTED.includes(r.conclusion)) top.set', 'for (const r of bound) top.set'],
  ['ambiguous slots accepted', "if (slots.has(k)) bad('ambiguous_job_slot', `check_runs/${r.id}`);", ';'],
  ['jobs[] ids not checked', "    if (!isId(j.id) || !isId(j.run_id)) bad('job_id_invalid', at);\n", ''],
  ['duplicate jobs[] ids accepted', "    if (jobsById.has(j.id)) bad('job_id_duplicate', at);\n", ''],
  ['jobs[] entry flags not checked', "bad('job_row_inconsistent', at);", ';'],
  ['jobs[] cross-check dropped', " || !isDeepStrictEqual(j.inputs, r.job_inputs)) bad('job_row_mismatch'", ") bad('job_row_mismatch'"],
  ['missing check: unbound jobs[] entries accepted', "  for (const j of s.jobs) if (uses.get(j.id) !== 1) bad('job_not_bound_by_one_row', `jobs/${j.id}`);\n", ''],
  ['attempt gaps accepted', "if (set.size !== Math.max(...set)) bad('attempt_gap', `run/${run}`);", ';'],
  // parse, envelope and CLI
  ['M3: duplicate JSON keys accepted', "if (seen.has(k)) fail('duplicate_key');", ''],
  ['BOM accepted silently', "  if (text.charCodeAt(0) === 0xfeff) fail('bom');\n", ''],
  ['invalid UTF-8 replaced instead of refused', "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", "new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })"],
  ['input size not capped', "  if (buf.length > MAX_INPUT_BYTES) throw new Error('too_large');\n", ''],
  ['M4: every output without the no-gate note', 'not_asserted: NOT_ASSERTED.slice(), note: NOTE, rows };', 'not_asserted: NOT_ASSERTED.slice(), rows };'],
  ['classification FAIL mapped to a pass-like state', "failed_code: Object.freeze({ ci_state: 'FAIL'", "failed_code: Object.freeze({ ci_state: 'PASS'"],
  ['billing_blocked mapped to NOT_CLASSIFIED', "billing_blocked: Object.freeze({ ci_state: 'UNAVAILABLE'", "billing_blocked: Object.freeze({ ci_state: 'NOT_CLASSIFIED'"],
  ['an eligibility field added to the output', 'advisory: true, classification,', "advisory: true, eligible: classification === 'billing_blocked', classification,"],
  ['invalid snapshot still reports its hash', "if (!v.ok) return finish('unavailable', v.reasons, [], null);", "if (!v.ok) return finish('unavailable', v.reasons, [], raw?.provider_snapshot_sha256 ?? null);"],
  ['M4: CLI exits 0 for no_failure_observed', '  return status;\n}', "  return result.classification === 'no_failure_observed' ? 0 : status;\n}"],
  ['M4: unreadable input exits 1 instead of 3', "e.message : 'invalid_json'}`], [], null); status = 3; }", "e.message : 'invalid_json'}`], [], null); status = 1; }"],
];
// Equivalent by construction (no mutant listed): R1 (`row.app !== 'github-actions'` in evaluateRow) is unreachable for a bound row once
// binding_app_mismatch holds, and is kept as defence in depth; the structuredClone try/catch is subsumed by the outer catch (same reason code);
// the second shape validation of the clone is subsumed by the first (lib/shape refuses accessors, structuredClone refuses a Proxy), kept against exotic inputs.
const CHILD_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), CLASSIFY_MUTANT_RUN: '1' };
const runMutant = (src) => runTreeMutant({ root: HERE, testRel: 'ci-classify.test.mjs', env: CHILD_ENV, timeout: 120000, overrides: { 'ci-classify.mjs': src } });
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
