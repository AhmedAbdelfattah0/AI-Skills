/**
 * Specs for AIS-HARNESS-3 Wave 3 (the final review on top of unit reviews). Threat model:
 * accidental or buggy workers; deliberately hostile dispatched code is out of scope. Rows drive the
 * REAL engine through the `node run-engine.mjs` CLI on a temp git repo with a fake provider CLI.
 *
 * ============================ CONTRACT ADDITIONS (Wave 3) =============================
 * Only with DAG `config.unitReview: true` (absent: `gate review` is byte-for-byte unchanged):
 * - `gate review` kind original refuses `acceptance_uncovered` unless every acceptance id mapped
 *   on a node (`nodes[].acceptance`, i.e. config.acceptanceIds) is the `criterion` (or `id`) of a
 *   row of `primary.acceptance_criteria`.
 * - `gate review` (original and confirmation) refuses `units_consumed_stale` unless the input's
 *   `units_consumed: [{ unit, evidence_id }]` names every unit exactly once with its CURRENT
 *   verified evidence id (`status.units.<u>.evidence.id`): a missing, unknown, duplicate or old
 *   entry is refused. Accepted records carry `units_consumed`.
 * Both run after the existing refusals (units_unverified, unit_reviews_missing) and the gate.mjs
 * contract checks; they only refuse more, never accept more.
 * =========================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview } from './engine-test-fixture.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); assert.equal(r.out.ok, false); };
const PASS = { cmd: process.execPath, args: ['-e', ''] };
const node = (id, extra = {}) => ({ id, writes: [`src/${id}.txt`], checks: ['ok'], ...extra });
const ROWS = (...ids) => ids.map(id => ({ criterion: id, outcome: 'PASS', evidence: `covers ${id}` }));

/** The units a final review consumed, read from status: every unit with its current evidence id. */
const consumed = (fx) => Object.entries(fx.cli('status').out.units).map(([unit, p]) => ({ unit, evidence_id: p.evidence.id }));

/** A unit review input (PASS, no second opinion: the units below are not risky). */
function unitPass(fx, u, rx) {
  const s = fx.readState(), ev = fx.cli('status').out.units[u].evidence;
  const { second_opinion: _so, ...r } = passReview(rx, ev.id);
  return { unit: u, approved_plan_digest: s.plan_digest, dag_digest: s.dag_digest, base_commit: ev.base_commit, ...r };
}

/** A final PASS review covering `ids` and consuming `units` (default: the current evidence). */
const finalPass = (fx, rx, ids, units = consumed(fx)) => passReview(rx, fx.candidate(),
  { primary: primaryReview(fx.candidate(), { acceptance_criteria: ROWS(...ids) }), units_consumed: units });

function twoUnits(t, config = {}) {
  return fixture(t, { commit: true, config: { acceptanceIds: ['AC1', 'AC2'], testCommands: { ok: PASS }, ...config },
    nodes: [node('api', { unit: 'u-api', acceptance: ['AC1'], reads: ['docs/in.txt'] }), node('web', { unit: 'u-web', acceptance: ['AC2'] })],
    behaviour: { api: { write: { 'src/api.txt': 'api' } }, web: { write: { 'src/web.txt': 'web' } }, fix: { write: { 'src/api.txt': 'fixed' } } } });
}

function reviewedUnits(t) {
  const fx = twoUnits(t, { unitReview: true });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitPass(fx, 'u-api', 'urx-api')));
  ok(fx.gate('unit-review', unitPass(fx, 'u-web', 'urx-web')));
  return fx;
}

test('acceptance: with unitReview the final review must cover every mapped acceptance id', { skip: WIN_SKIP }, (t) => {
  const fx = reviewedUnits(t);
  const r = fx.gate('review', finalPass(fx, 'rx-1', ['AC1']));
  refused(r, 'acceptance_uncovered');
  assert.match(r.out.reasons[0], /AC2/);
  refused(fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'covers AC2 in prose'])), 'acceptance_uncovered');
  const byId = passReview('rx-1', fx.candidate(), { units_consumed: consumed(fx), primary: primaryReview(fx.candidate(),
    { acceptance_criteria: [...ROWS('AC1'), { id: 'AC2', criterion: 'the web unit works', outcome: 'PASS', evidence: 'e2e' }] }) });
  const v = fx.gate('review', byId);
  ok(v, 'a row may name the id in `id` instead of `criterion`');
  assert.deepEqual(v.out.record.units_consumed, consumed(fx));
  assert.equal(fx.readState().review_chain.at(-1).units_consumed.length, 2, 'the chain record carries the consumed units');
});

test('units_consumed: missing, partial, unknown, duplicate or old evidence is refused as stale; current evidence is accepted', { skip: WIN_SKIP }, (t) => {
  const fx = reviewedUnits(t);
  const now = consumed(fx);
  const { units_consumed: _u, ...without } = finalPass(fx, 'rx-1', ['AC1', 'AC2']);
  refused(fx.gate('review', without), 'units_consumed_stale');
  refused(fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'AC2'], now.slice(0, 1))), 'units_consumed_stale');
  refused(fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'AC2'], [...now, { unit: 'u-nope', evidence_id: 'x' }])), 'units_consumed_stale');
  refused(fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'AC2'], [...now, now[0]])), 'units_consumed_stale');
  refused(fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'AC2'], 'all')), 'units_consumed_stale');
  // An input change re-checks u-api: its evidence id moves, so the old list is stale even after its re-review.
  writeFileSync(`${fx.repo}/docs/in.txt`, 'contract v2');
  ok(fx.cli('drive'));
  ok(fx.gate('unit-review', unitPass(fx, 'u-api', 'urx-api-2')));
  const after = consumed(fx);
  assert.notEqual(after.find(c => c.unit === 'u-api').evidence_id, now.find(c => c.unit === 'u-api').evidence_id);
  assert.equal(after.find(c => c.unit === 'u-web').evidence_id, now.find(c => c.unit === 'u-web').evidence_id, 'the unrelated unit keeps its evidence');
  const old = fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'AC2'], now));
  refused(old, 'units_consumed_stale');
  assert.match(old.out.reasons.join(' '), /u-api/);
  assert.equal(fx.readState().review_chain.length, 0, 'refusals record nothing');
  ok(fx.gate('review', finalPass(fx, 'rx-1', ['AC1', 'AC2'])));
});

test('confirmation: after a final-review repair the confirmation must consume the re-reviewed unit evidence', { skip: WIN_SKIP }, (t) => {
  const fx = reviewedUnits(t);
  const fail = failReview('rx-1', fx.candidate(), 'src/api.txt', fx.prompt('fix'));
  fail.primary.acceptance_criteria = [{ criterion: 'AC1', outcome: 'FAIL', evidence: 'src/api.txt' }, ...ROWS('AC2')];
  const before = consumed(fx);
  ok(fx.gate('review', { ...fail, units_consumed: before }));
  ok(fx.cli('drive'));
  const freeze = fx.readState().freeze;
  assert.ok(freeze, 'the original froze the candidate');
  // The repair changed u-api; it is re-checked and its unit review is stale until re-reviewed (after an owner RETRY: post-freeze unit FAILs are terminal, a PASS is not).
  ok(fx.gate('unit-review', unitPass(fx, 'u-api', 'urx-api-2')));
  refused(fx.gate('review', { ...confirmReview('rx-1', fx.candidate()), units_consumed: before }), 'units_consumed_stale');
  refused(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'units_consumed_stale');
  const c = fx.gate('review', { ...confirmReview('rx-1', fx.candidate()), units_consumed: consumed(fx) });
  ok(c);
  assert.deepEqual(c.out.record.units_consumed, consumed(fx));
});

test('disabled: units with acceptance but without config.unitReview keep gate review unchanged (no coverage or units_consumed demand)', { skip: WIN_SKIP }, (t) => {
  const fx = twoUnits(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  const extra = fx.gate('review', passReview('rx-1', fx.candidate(), { units_consumed: [] }));
  assert.equal(extra.status, 1, 'units_consumed without config.unitReview stays a usage error');
  assert.match(extra.stderr, /units_consumed needs a DAG with config\.unitReview/);
  const v = fx.gate('review', passReview('rx-1', fx.candidate()));
  ok(v, 'the fixture review covers only AC1 and names no units');
  assert.equal('units_consumed' in v.out.record, false);
  assert.equal('units_consumed' in fx.readState().review_chain[0], false);
});
