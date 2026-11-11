/**
 * AIS-HARNESS-3 Wave 4 finding (SCRUM-307): a hand edit to a done node's file between the last
 * `drive` and the review freeze is reported as post_freeze_drift, and the pending repair waits
 * behind it with no supported way forward (revert, or bypass the engine).
 *
 * Contract: `run-engine.mjs rebind --reason <text>` re-binds the fingerprints of drifted done nodes
 * to the work tree ONLY when that tree is exactly the frozen candidate (the review saw these bytes).
 * Refusals (exit 1, coded): rebind_no_freeze, rebind_not_frozen_tree, rebind_nothing_drifted,
 * rebind_attempts_live, rebind_units, rebind_refused (bad flags). It never loosens drift(),
 * startsFromFreeze or the ship-ready conjunction. A REBIND event with each node's path deltas and
 * the reason reaches RUN-STATE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSIX, fixture, runStateEvents, failReview } from './engine-test-fixture.mjs';
import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups';
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);

/**
 * Build a, hand-edit its file, freeze a FAIL review on the edited tree. The workers finish by
 * themselves, so timeoutMs is only a failure bound (#49: the fixture's 10 s expired under load).
 */
function handEditedThenFailed(t) {
  const fx = fixture(t, { commit: true, config: { timeoutMs: WORKER_FAILURE_BOUND_MS }, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'a1 + hand fix');
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  return fx;
}

test('a hand edit before the freeze stops the repair as post_freeze_drift; rebind lets it run', { skip: WIN_SKIP }, async (t) => {
  const fx = handEditedThenFailed(t);
  const stuck = fx.cli('drive');
  assert.equal(stuck.status, 2, stuck.stdout + stuck.stderr);
  assert.ok(stuck.out.judgments.some(j => j.code === 'post_freeze_drift' && j.node === 'a'), JSON.stringify(stuck.out.judgments));
  assert.equal(fx.runs('fix').length, 0);
  const frozen = fx.readState().freeze.candidate;

  const r = fx.cli('rebind', { reason: 'typecheck fix applied by hand before the review' });
  ok(r);
  assert.ok(!r.out.judgments.some(j => j.code === 'post_freeze_drift'), JSON.stringify(r.out.judgments));
  assert.equal(fx.readState().freeze.candidate, frozen, 'rebind never moves the freeze');
  const ev = runStateEvents(fx.planFile).filter(e => e.event === 'REBIND');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reason, 'typecheck fix applied by hand before the review');
  assert.equal(ev[0].candidate_id, frozen);
  assert.deepEqual(ev[0].nodes.map(n => n.node), ['a']);
  assert.ok(ev[0].nodes[0].paths.some(p => p.path === 'src/a.txt' && p.from !== p.to), JSON.stringify(ev[0]));

  const after = fx.cli('drive');
  ok(after);
  assert.equal(after.out.repairs[0].state, 'done');
  assert.equal(fx.runs('fix').length, 1, 'the repair ran after the rebind');
});

test('rebind is refused when the tree is not the frozen candidate (an edit after the freeze)', { skip: WIN_SKIP }, async (t) => {
  const fx = handEditedThenFailed(t);
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'edited again after the freeze');
  const r = fx.cli('rebind', { reason: 'try to absorb a post-freeze edit' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /rebind_not_frozen_tree/);
  assert.equal(runStateEvents(fx.planFile).filter(e => e.event === 'REBIND').length, 0);
  const d = fx.cli('drive');
  assert.ok(d.out.judgments.some(j => j.code === 'post_freeze_drift'), 'the drift still blocks');
});

test('rebind refusals: no freeze, nothing drifted, empty reason', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const noFreeze = fx.cli('rebind', { reason: 'x' });
  assert.equal(noFreeze.status, 1);
  assert.match(noFreeze.stderr, /rebind_no_freeze/);
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  const clean = fx.cli('rebind', { reason: 'nothing changed' });
  assert.equal(clean.status, 1);
  assert.match(clean.stderr, /rebind_nothing_drifted/);
  const noReason = fx.cli('rebind', { reason: '  ' });
  assert.equal(noReason.status, 1);
  assert.match(noReason.stderr, /rebind_refused/);
});

test('rebind never absorbs a drifted declared input the frozen candidate does not cover (Codex: excluded path)', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, nodes: [{ id: 'a', writes: ['src/a.txt'], reads: ['session-log.md'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  writeFileSync(join(fx.repo, 'session-log.md'), 'v1');
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  writeFileSync(join(fx.repo, 'session-log.md'), 'v2 changed after the node was built');
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  const r = fx.cli('rebind', { reason: 'accept' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /rebind_uncovered/);
  assert.equal(runStateEvents(fx.planFile).filter(e => e.event === 'REBIND').length, 0);
});
