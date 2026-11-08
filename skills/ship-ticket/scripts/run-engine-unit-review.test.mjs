/**
 * Specs for AIS-HARNESS-3 Wave 2b-ii (per-unit independent review + unit-scoped repair). Threat
 * model: accidental or buggy workers; deliberately hostile dispatched code is out of scope. Rows
 * drive the REAL engine through the `node run-engine.mjs` CLI on a temp git repo with a fake
 * provider CLI.
 *
 * ============================ CONTRACT ADDITIONS (Wave 2b-ii) =========================
 * Opt-in: DAG `config.unitReview` (boolean, needs a unit; never defaulted, so the DAG digest covers
 *   it only when set). Absent: no `unit_reviews` state, no `review` in the unit projection, no
 *   `unit_reviews_pending`, and `gate unit-review` refuses `unit_review_disabled`.
 * Gate: `run-engine.mjs gate unit-review --input <file> [--unit <u>]`. Input { unit, review_execution,
 *   kind: original|confirmation, approved_plan_digest, dag_digest, base_commit, primary,
 *   second_opinion?, reconciliation, graded_artifacts?, repair_ownership?, repair_prompt_file? }: the
 *   gate.mjs review contract with candidate_id = the unit's current evidence id
 *   (status.units.<u>.evidence.id). Refusals (nothing recorded): unit_review_disabled, unknown_unit,
 *   binding_mismatch (plan/DAG digest), attempts_live (not quiescent), unit_unverified, stale_base,
 *   stale_evidence, chain_broken (an execution id of another chain), unit_review_current (a current
 *   PASS), unit_review_open (a FAIL cycle in progress), retry_unauthorized (terminal unit without an
 *   owner RETRY), repair_outside_unit (write set beyond the unit's declared writes), parent_ceiling
 *   (durable judgment), and every gateReview refusal (reviewer_is_builder, reviewers_not_distinct,
 *   missing_second_opinion: a unit is risky when a member node has a risk label or the ticket has
 *   config.riskLabels, and then its review and its confirmation need the second opinion).
 * States: status.units.<u>.review.state unreviewed|pass|fail|stale (fail: awaiting
 *   repair|recheck|confirmation, or terminal: computed judgment unit_review_terminal), recomputed
 *   against the current evidence at every read; status.unit_reviews_pending lists units without a
 *   current PASS. `gate review` (original and confirmation) and `gate ship-ready` refuse
 *   unit_reviews_missing until every unit has a current PASS.
 * Repair: an accepted unit FAIL (before the freeze, with findings to fix) enqueues repair
 *   `repair-<rx>` (kind unit-review) through the review-repair authorization; drive dispatches it only
 *   while the unit's evidence is the reviewed one (else it is cancelled and the review is stale),
 *   re-checks the unit and binds the new evidence as the confirmation's candidate. One repair and one
 *   confirmation per unit review execution. A failed confirmation, an overflow FAIL, a FAIL with
 *   nothing to fix and a FAIL after the freeze are terminal (owner RETRY only).
 * Ceiling: a re-review, a unit repair (which reserves its re-check and confirmation: 3) and a
 *   confirmation spend the run-wide config.unitRecheckCeiling, recorded in UNIT_REVIEW_CYCLE with
 *   kind unit_rereview|unit_repair|unit_confirmation and its trigger.
 * =========================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { POSIX, fixture, passReview, failReview, confirmReview, waitUntil } from './engine-test-fixture.mjs';
import { validateEngineDag } from './engine-dag.mjs';
import { verifyReviewExecution } from './carrier.mjs';
import { evaluateRun } from './eval.mjs';
import { buildRun } from './run-summary.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const J = JSON.stringify;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); assert.equal(r.out.ok, false); };
const PASS = { cmd: process.execPath, args: ['-e', ''] };
const node = (id, extra = {}) => ({ id, writes: [`src/${id}.txt`], checks: ['ok'], ...extra });
const cycles = (fx) => fx.readState().events.filter(e => e.type === 'UNIT_REVIEW_CYCLE');
const reviewOf = (fx, u) => fx.cli('status').out.units[u].review;

/** The binding a unit review names: digests from engine state, base and evidence id from status. */
function bound(fx, u) {
  const s = fx.readState(), ev = fx.cli('status').out.units[u].evidence;
  return { unit: u, approved_plan_digest: s.plan_digest, dag_digest: s.dag_digest, base_commit: ev.base_commit, id: ev.id };
}

/** A unit review input: PASS, or FAIL with finding F1 on `fail`; the second opinion only when `second`. */
function unitReview(fx, u, rx, { fail, second = false, primary = {}, so = {}, input = {} } = {}) {
  const { id, ...b } = bound(fx, u);
  const { second_opinion, ...r } = fail ? failReview(rx, id, fail, fx.prompt('fix')) : passReview(rx, id);
  return { ...b, ...r, primary: { ...r.primary, ...primary }, ...(second ? { second_opinion: { ...second_opinion, ...so } } : {}), ...input };
}

/** A targeted unit confirmation of `rx` (on evidence `id`, default the current one). */
function unitConfirm(fx, u, rx, { second = false, outcome = 'PASS', id } = {}) {
  const { id: now, ...b } = bound(fx, u), cand = id ?? now;
  const c = confirmReview(rx, cand);
  c.primary.outcome = outcome;
  return { ...b, ...c, ...(second ? { second_opinion: { route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: cand,
    checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed' } } : {}) };
}

const dagOf = (nodes, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },
  nodes: nodes.map(n => ({ promptFile: '/p', ...n })) });

// ------------------------------------------------------------------ opt-in

test('DAG: config.unitReview is an optional boolean that needs a unit and is never defaulted', () => {
  const bad = (doc, re) => assert.throws(() => validateEngineDag(doc, { ticket: 'T-1' }), (e) => e.code === 'dag_invalid' && re.test(e.message));
  bad(dagOf([{ id: 'a' }], { unitReview: true }), /unitReview needs a node with a unit/);
  bad(dagOf([{ id: 'a', unit: 'u' }], { unitReview: 'yes' }), /unitReview must be a boolean/);
  assert.equal(validateEngineDag(dagOf([{ id: 'a', unit: 'u' }], { unitReview: true }), { ticket: 'T-1' }).config.unitReview, true);
  assert.equal('unitReview' in validateEngineDag(dagOf([{ id: 'a', unit: 'u' }]), { ticket: 'T-1' }).config, false);
});

test('disabled: units without config.unitReview keep the Wave 2a projection and refuse gate unit-review', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS } }, nodes: [node('a', { unit: 'api' })], behaviour: { a: { write: { 'src/a.txt': 'a' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  const s = fx.cli('status').out;
  assert.equal('review' in s.units.api, false);
  assert.equal('unit_reviews_pending' in s, false);
  assert.equal('unit_reviews' in fx.readState(), false);
  refused(fx.gate('unit-review', unitReview(fx, 'api', 'urx-1')), 'unit_review_disabled');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())), 'the final review is unchanged without unitReview');
});

// ------------------------------------------------------------------ recording and refusals

test('record: units reviewed in any order; risky needs the second opinion; builders, stale evidence and bindings are refused; the final review stays mandatory', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, modelMap: { strong: 'claude-strong-test' }, testCommands: { ok: PASS } },
    nodes: [node('api', { unit: 'u-api', risk: ['shared-contract'] }), node('web', { unit: 'u-web' })],
    behaviour: { api: { write: { 'src/api.txt': 'api' } }, web: { write: { 'src/web.txt': 'web' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const early = { unit: 'u-web', approved_plan_digest: fx.readState().plan_digest, dag_digest: fx.readState().dag_digest, base_commit: 'x',
    ...passReview('urx-0', 'u-web@1') };
  refused(fx.gate('unit-review', early), 'unit_unverified');
  ok(fx.cli('drive'));
  const s = fx.cli('status').out;
  assert.deepEqual(s.unit_reviews_pending.sort(), ['u-api', 'u-web']);
  assert.deepEqual([s.units['u-api'].review.state, s.units['u-api'].review.risky, s.units['u-web'].review.risky], ['unreviewed', true, false]);
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'unit_reviews_missing');
  refused(fx.gate('unit-review', unitReview(fx, 'u-api', 'urx-api')), 'missing_second_opinion');
  refused(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-web', { primary: { reviewer_identity: 'claude:opus' } })), 'reviewer_is_builder');
  refused(fx.gate('unit-review', unitReview(fx, 'u-api', 'urx-api', { second: true, so: { reviewer_identity: 'opus:review' } })), 'reviewers_not_distinct');
  refused(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-web', { primary: { candidate_id: 'u-web@1' } })), 'stale_evidence');
  refused(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-web', { input: { dag_digest: 'sha256:' + '0'.repeat(64) } })), 'binding_mismatch');
  refused(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-web', { input: { base_commit: '0'.repeat(40) } })), 'stale_base');
  refused(fx.gate('unit-review', { ...unitReview(fx, 'u-web', 'urx-x'), unit: 'nope' }), 'unknown_unit');
  const api = fx.gate('unit-review', unitReview(fx, 'u-api', 'urx-api', { second: true }));
  ok(api, 'risky unit with its second opinion');
  assert.equal(api.out.code, 'unit_review_accepted');
  assert.deepEqual([api.out.record.unit, api.out.record.risky, api.out.record.second_opinion_route, api.out.record.second_opinion_identity],
    ['u-api', true, 'codex', 'codex:gpt']);
  assert.equal(api.out.record.evidence_id, s.units['u-api'].evidence.id);
  assert.equal(api.out.record.tree_candidate, s.units['u-api'].evidence.candidate_id);
  refused(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-api')), 'chain_broken');
  const file = join(fx.root, 'web-review.json');
  const { unit: _u, ...noUnit } = unitReview(fx, 'u-web', 'urx-web');
  writeFileSync(file, J(noUnit));
  const clash = fx.cli('gate unit-review', { input: file, unit: 'u-api' });
  writeFileSync(file, J({ ...noUnit, unit: 'u-web' }));
  assert.equal(fx.cli('gate unit-review', { input: file, unit: 'u-api' }).status, 1, '--unit must equal the input unit');
  refused(clash, 'stale_evidence'); // --unit u-api applied: the u-web evidence id is not u-api's
  writeFileSync(file, J(noUnit));
  const web = fx.cli('gate unit-review', { input: file, unit: 'u-web' });
  ok(web, 'a unit that is not risky needs no second opinion (unit named by --unit)');
  assert.equal(web.out.record.second_opinion_route, null);
  refused(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-web-2')), 'unit_review_current');
  const after = fx.cli('status').out;
  assert.deepEqual(after.unit_reviews_pending, []);
  assert.deepEqual([after.units['u-api'].review.state, after.units['u-web'].review.state], ['pass', 'pass']);
  assert.deepEqual(after.unit_ceiling, { limit: 4, used: 0 }, 'first reviews are free');
  refused(fx.gate('review', passReview('rx-urx', fx.candidate(), { review_execution: 'urx-web' })), 'chain_broken');
  refused(fx.gate('review', { ...passReview('rx-1', fx.candidate()), second_opinion: undefined }), 'missing_second_opinion');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())), 'the final review on the assembled candidate');
  ok(fx.gate('ship-ready', {}));
  const m = evaluateRun(buildRun('T-1', 'run-1', []), { state: fx.readState(), repoRoot: fx.repo });
  assert.deepEqual([m.units['u-api'].review.state, m.units['u-web'].review.state], ['pass', 'pass']);
});

// ------------------------------------------------------------------ staleness

function threeUnits(t, config = {}) {
  return fixture(t, { commit: true, config: { unitReview: true, testCommands: { ok: PASS }, ...config },
    nodes: [node('api', { unit: 'u-api', reads: ['docs/in.txt'] }), node('web', { deps: ['api'], unit: 'u-web', reads: ['src/api.txt'] }),
      node('other', { unit: 'u-other' })],
    behaviour: { api: { write: { 'src/api.txt': 'api' } }, web: { write: { 'src/web.txt': 'web' } }, other: { write: { 'src/other.txt': 'o' } } } });
}

test('stale: a shared-contract change makes only the reading unit and its dependents\' reviews stale; the old evidence id is refused; re-reviews spend the ceiling', { skip: WIN_SKIP }, (t) => {
  const fx = threeUnits(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  const old = {};
  for (const u of ['u-api', 'u-web', 'u-other']) { old[u] = bound(fx, u).id; ok(fx.gate('unit-review', unitReview(fx, u, `urx-${u}`)), u); }
  writeFileSync(`${fx.repo}/docs/in.txt`, 'contract v2');
  const s = fx.cli('status').out;
  assert.deepEqual(['u-api', 'u-web', 'u-other'].map(u => s.units[u].review.state), ['stale', 'stale', 'pass']);
  assert.deepEqual(s.unit_reviews_pending.sort(), ['u-api', 'u-web']);
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'units_unverified');
  ok(fx.cli('drive'));
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'unit_reviews_missing');
  refused(fx.gate('unit-review', unitReview(fx, 'u-api', 'urx-api-2', { primary: { candidate_id: old['u-api'] } })), 'stale_evidence');
  ok(fx.gate('unit-review', unitReview(fx, 'u-api', 'urx-api-2')));
  ok(fx.gate('unit-review', unitReview(fx, 'u-web', 'urx-web-2')));
  const after = fx.cli('status').out;
  assert.equal(after.units['u-other'].review.review_execution, 'urx-u-other', 'the unrelated unit keeps its review');
  assert.equal(after.units['u-other'].evidence.id, old['u-other']);
  assert.deepEqual(after.unit_ceiling, { limit: 4, used: 4 }, 'two re-checks and two re-reviews');
  const c = cycles(fx);
  assert.deepEqual(c.map(e => [e.unit, e.kind, e.trigger.cause]), [['u-api', 'unit_rereview', 'stale'], ['u-web', 'unit_rereview', 'stale']]);
  assert.deepEqual([c[0].trigger.predecessor, c[0].trigger.from_evidence, c[0].trigger.to_evidence], ['urx-u-api', old['u-api'], after.units['u-api'].evidence.id]);
  assert.deepEqual(c[0].trigger.invalidations, [{ changed: ['docs/in.txt'], rerun: ['api'] }]);
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
});

// ------------------------------------------------------------------ unit-scoped repair

test('repair: a risky unit FAIL opens a unit-scoped repair; drive repairs and re-checks only that unit; the confirmation needs both reviewers', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, modelMap: { strong: 'claude-strong-test' }, testCommands: { ok: PASS } },
    nodes: [node('a', { unit: 'api', risk: ['shared-contract'] }), node('c', { unit: 'cli' })],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, c: { write: { 'src/c.txt': 'c' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitReview(fx, 'cli', 'urx-cli')));
  refused(fx.gate('unit-review', unitReview(fx, 'api', 'urx-1', { fail: 'src/c.txt', second: true })), 'repair_outside_unit');
  refused(fx.gate('unit-review', unitReview(fx, 'api', 'urx-1', { fail: 'src/a.txt', second: true, input: { repair_prompt_file: undefined } })), 'repair_prompt_missing');
  const before = bound(fx, 'api').id;
  const f = fx.gate('unit-review', unitReview(fx, 'api', 'urx-1', { fail: 'src/a.txt', second: true }));
  ok(f);
  assert.deepEqual(f.out.repair, { id: 'repair-urx-1', write_set: ['src/a.txt'] });
  assert.equal(verifyReviewExecution(fx.repo, { ticket: 'T-1', run_id: 'run-1' }, 'urx-1'), 'engine', 'the carrier honours a unit FAIL');
  let s = fx.cli('status').out;
  assert.deepEqual([s.units.api.review.state, s.units.api.review.awaiting], ['fail', 'repair']);
  assert.deepEqual(s.repairs, [{ id: 'repair-urx-1', state: 'pending' }]);
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'unit_reviews_missing');
  refused(fx.gate('unit-review', unitReview(fx, 'api', 'urx-2', { second: true })), 'unit_review_open');
  ok(fx.cli('drive'));
  assert.equal(fx.runs('fix').length, 1);
  const st = fx.readState();
  assert.deepEqual([st.attempts.filter(a => a.kind === 'unit-check' && a.node === 'api').length, st.attempts.filter(a => a.kind === 'unit-check' && a.node === 'cli').length], [2, 1]);
  assert.deepEqual(st.rounds.unit_review_repairs, { 'urx-1': 1 });
  assert.equal(st.rounds.review_repairs['urx-1'], undefined, 'the final review rounds are untouched');
  s = fx.cli('status').out;
  assert.deepEqual([s.units.api.review.state, s.units.api.review.awaiting, s.units.cli.review.state], ['fail', 'confirmation', 'pass']);
  assert.notEqual(s.units.api.evidence.id, before);
  assert.equal(s.units.api.review.repaired_evidence, s.units.api.evidence.id);
  assert.deepEqual(s.unit_ceiling, { limit: 4, used: 2 }, 'the repair and its re-check');
  refused(fx.gate('unit-review', unitConfirm(fx, 'api', 'urx-1')), 'missing_second_opinion');
  refused(fx.gate('unit-review', unitConfirm(fx, 'api', 'urx-1', { second: true, id: before })), 'stale_evidence');
  const c = fx.gate('unit-review', unitConfirm(fx, 'api', 'urx-1', { second: true }));
  ok(c);
  assert.deepEqual([c.out.record.kind, c.out.record.outcome, c.out.record.second_opinion_identity], ['confirmation', 'PASS', 'codex:gpt']);
  assert.equal(fx.cli('status').out.units.api.review.state, 'pass');
  assert.deepEqual(cycles(fx).map(e => [e.kind, e.trigger.cause]), [['unit_repair', 'fail'], ['unit_confirmation', 'repair']]);
  assert.deepEqual(cycles(fx)[0].trigger.findings, ['F1']);
  refused(fx.gate('unit-review', unitConfirm(fx, 'api', 'urx-1', { second: true })), 'unit_review_open');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  ok(fx.gate('ship-ready', {}));
});

test('repair: a pending unit repair whose evidence changed is cancelled, never dispatched; the review is stale', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, testCommands: { ok: PASS } },
    nodes: [node('a', { unit: 'api', reads: ['docs/in.txt'] })],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitReview(fx, 'api', 'urx-1', { fail: 'src/a.txt' })));
  writeFileSync(`${fx.repo}/docs/in.txt`, 'contract v2');
  ok(fx.cli('drive'));
  assert.equal(fx.runs('fix').length, 0, 'the repair never ran against changed code');
  const s = fx.cli('status').out;
  assert.deepEqual(s.repairs, [{ id: 'repair-urx-1', state: 'cancelled' }]);
  assert.equal(s.units.api.review.state, 'stale');
  ok(fx.gate('unit-review', unitReview(fx, 'api', 'urx-2')), 'a fresh original review of the changed unit');
});

// ------------------------------------------------------------------ terminal, RETRY and the parent ceiling

test('ceiling: a failed confirmation is terminal (no automatic retry); only an owner RETRY re-reviews, and the shared ceiling then refuses another repair', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, testCommands: { ok: PASS } }, nodes: [node('a', { unit: 'api' })],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitReview(fx, 'api', 'urx-1', { fail: 'src/a.txt' })));
  ok(fx.cli('drive'));
  const c = fx.gate('unit-review', unitConfirm(fx, 'api', 'urx-1', { outcome: 'FAIL' }));
  assert.equal(c.status, 2, c.stdout);
  assert.deepEqual([c.out.ok, c.out.code, c.out.judgment_point], [true, 'unit_review_terminal', true]);
  const s = fx.cli('status').out;
  assert.ok(s.judgments.some(j => j.code === 'unit_review_terminal' && j.node === 'api' && /RETRY/.test(j.reason)), J(s.judgments));
  assert.equal(s.units.api.review.terminal, true);
  const d = fx.cli('drive');
  assert.equal(d.status, 2);
  assert.equal(fx.runs('fix').length, 1, 'no automatic second repair');
  assert.deepEqual(d.out.unit_ceiling, { limit: 4, used: 3 });
  refused(fx.gate('unit-review', unitReview(fx, 'api', 'urx-2', { fail: 'src/a.txt' })), 'retry_unauthorized');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'urx-2', predecessor: 'urx-1', authorized_by: 'owner' });
  const again = fx.gate('unit-review', unitReview(fx, 'api', 'urx-2', { fail: 'src/a.txt' }));
  refused(again, 'parent_ceiling');
  assert.equal(again.out.judgment_point, true);
  const after = fx.cli('status').out;
  assert.ok(after.judgments.some(j => j.code === 'parent_ceiling' && j.node === 'api' && /unitRecheckCeiling/.test(j.reason)), J(after.judgments));
  assert.deepEqual(after.unit_ceiling, { limit: 4, used: 3 }, 'a refusal spends nothing');
  assert.equal(after.repairs.length, 1);
  assert.equal(fx.cli('drive').status, 2, 'parent_ceiling is durable');
  assert.equal(fx.runs('fix').length, 1);
});

test('ceiling: a second unit gets no fresh allowance (unit count cannot multiply repairs)', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, unitRecheckCeiling: 3, testCommands: { ok: PASS } },
    nodes: [node('a', { unit: 'u1' }), node('b', { unit: 'u2' })], behaviour: { a: { write: { 'src/a.txt': 'a' } }, b: { write: { 'src/b.txt': 'b' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitReview(fx, 'u1', 'urx-1', { fail: 'src/a.txt' })), 'the first repair reserves 3 of 3');
  const second = fx.gate('unit-review', unitReview(fx, 'u2', 'urx-2', { fail: 'src/b.txt' }));
  refused(second, 'parent_ceiling');
  assert.match(second.out.reasons[0], /needs 3 of the run's unit allowance.*1 of 3 are spent/);
  assert.deepEqual(fx.cli('status').out.units.u2.review.state, 'unreviewed', 'nothing recorded');
});

// ------------------------------------------------------------------ resume

test('resume: units reviewed before a crash keep their reviews; a review waits for quiescence; the rest is reviewed after resume', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, width: 1, testCommands: { ok: PASS } },
    nodes: [node('n1', { unit: 'u1' }), node('n2', { unit: 'u2' }), node('n3', { unit: 'u3' })],
    behaviour: { n1: { write: { 'src/n1.txt': '1' } }, n2: { write: { 'src/n2.txt': '2' } }, n3: { write: { 'src/n3.txt': '3' }, waitFor: '../go-n3' } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const engine = fx.spawnCli('drive');
  const verified = () => Object.values(fx.readState().unit_checks).filter(r => r.evidence?.state === 'verified').length;
  assert.ok(await waitUntil(() => fx.runs('n3').length === 1 && verified() === 2, 20000));
  engine.kill('SIGKILL');
  await new Promise(r => engine.on('exit', r));
  refused(fx.gate('unit-review', unitReview(fx, 'u1', 'urx-1')), 'attempts_live');
  writeFileSync(join(fx.root, 'go-n3'), '');
  const n3 = fx.readState().attempts.find(a => a.node === 'n3');
  assert.ok(await waitUntil(() => existsSync(n3.envelope_file), 10000));
  ok(fx.cli('resume'));
  const ids = { u1: bound(fx, 'u1').id, u2: bound(fx, 'u2').id };
  ok(fx.gate('unit-review', unitReview(fx, 'u1', 'urx-1')));
  ok(fx.gate('unit-review', unitReview(fx, 'u2', 'urx-2')));
  ok(fx.cli('resume'));
  const d = fx.cli('drive');
  ok(d);
  assert.deepEqual(['u1', 'u2', 'u3'].map(u => d.out.units[u].review.state), ['pass', 'pass', 'unreviewed']);
  assert.deepEqual([d.out.units.u1.evidence.id, d.out.units.u2.evidence.id], [ids.u1, ids.u2], 'resume and drive kept the reviewed evidence');
  assert.deepEqual(d.out.unit_reviews_pending, ['u3']);
  ok(fx.gate('unit-review', unitReview(fx, 'u3', 'urx-3'), {}), 'unit u3 (built after the crash)');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
});

// ------------------------------------------------------------------ after the freeze

test('freeze: a final-review repair stales the unit review; a unit FAIL after the freeze is terminal; the final confirmation waits for a current unit PASS', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { unitReview: true, testCommands: { ok: PASS } }, nodes: [node('a', { unit: 'api' })],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitReview(fx, 'api', 'urx-1')));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  ok(fx.cli('drive'));
  assert.equal(fx.cli('status').out.units.api.review.state, 'stale');
  refused(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'unit_reviews_missing');
  const f = fx.gate('unit-review', unitReview(fx, 'api', 'urx-2', { fail: 'src/a.txt' }));
  assert.equal(f.status, 2, f.stdout);
  assert.equal(f.out.code, 'unit_review_terminal');
  assert.match(f.out.reasons[0], /after the REVIEW freeze/);
  assert.deepEqual(fx.cli('status').out.repairs.map(r => r.id), ['repair-rx-1'], 'no unit repair opens after the freeze');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'urx-3', predecessor: 'urx-2', authorized_by: 'owner' });
  ok(fx.gate('unit-review', unitReview(fx, 'api', 'urx-3')));
  assert.deepEqual(cycles(fx).map(e => [e.kind, e.trigger.cause]), [['unit_rereview', 'stale'], ['unit_rereview', 'retry']]);
  ok(fx.gate('review', confirmReview('rx-1', fx.candidate())));
  ok(fx.gate('ship-ready', {}));
});
