/**
 * P0 slice E3: candidate-bound review freshness (engine-freshness.mjs). Drives the REAL engine CLI on a temp
 * repo with a fake provider, a fake `gh` and a local bare remote (engine-enroll.test-helper.mjs). A review is
 * valid only for the candidate bytes it covered against the merge base it was bound to: git events that leave
 * those bytes alone never invalidate it; any change does (review_stale, review_base_moved), `next` makes the
 * owner RETRY the next action, and gate ship-ready and authorize publish refuse until an accepted review of the
 * CURRENT candidate exists. The one-repair, one-confirmation semantics are unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSIX, passReview, failReview, confirmReview, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const nextOf = (fx) => fx.cli('next').out;
const brief = (n) => [n.next_action.stage, n.next_action.disposition, n.next_action.reason];

/** next says publish, the review is fresh, and authorize publish allows. */
function publishOwed(fx, why) {
  const n = nextOf(fx);
  assert.deepEqual(brief(n), ['PUBLISH', 'READY', 'publish_owed'], `${why}: ${J(n.next_action)}`);
  assert.equal(n.review_freshness.code, 'review_fresh', why);
  assert.equal(fx.cli('authorize', { stage: 'publish' }).out.allow, true, why);
}

/** The authorizing review is stale with `code`: next stops at the owner RETRY, and authorize publish refuses. */
function staleNow(fx, code, stage, why) {
  const n = nextOf(fx);
  assert.equal(n.review_freshness?.code, code, `${why}: ${J(n.review_freshness)}`);
  assert.deepEqual([...brief(n), n.next_action.action, n.next_action.owner], [stage, 'NEEDS_APPROVAL', code, 'owner_retry', 'human'], why);
  const a = fx.cli('authorize', { stage: 'publish' });
  assert.equal(a.out.allow, false, `${why}: ${a.stdout}`);
  return a.out.code;
}

const commitAs = (fx, msg, ...args) => fx.okGit(['commit', '-q', ...args, '-m', msg]);

test('git events that leave the candidate bytes alone never invalidate the review: push, amend of the message, fetch, excluded-path commit, a rebase that keeps base and tree, a branch rename', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  fx.commitAll();
  publishOwed(fx, 'after the commit (config.base HEAD: the bound merge base, not the new HEAD)');
  const S = fx.readState();
  assert.deepEqual(S.review_bindings.map(b => [b.review_execution, b.kind, b.candidate_id === S.review_chain[0].candidate_id, typeof b.merge_base]),
    [['rx-1', 'original', true, 'string']], 'the accepted review is bound to its candidate and merge base');
  assert.deepEqual(Object.keys(S.review_chain[0]).includes('merge_base'), false, 'the review_chain record is unchanged');
  commitAs(fx, 'reworded', '--amend');
  publishOwed(fx, 'amend that changes only the message');
  fx.okGit(['fetch', '-q', 'origin']);
  publishOwed(fx, 'fetch');
  writeFileSync(join(fx.repo, 'session-log.md'), 'excluded note');
  fx.okGit(['add', 'session-log.md']);
  commitAs(fx, 'log');
  publishOwed(fx, 'an excluded path edited and committed');
  fx.okGit(['rebase', '-q', '--force-rebase', fx.defaultBranch]);
  publishOwed(fx, 'a rebase that rewrites the commits but keeps the base and the tree');
  fx.okGit(['branch', '-m', 'T-1-work', 'T-1-renamed']);
  const renamed = nextOf(fx);
  assert.equal(renamed.review_freshness.code, 'review_fresh', 'a branch rename leaves the review fresh');
  assert.equal(renamed.stages.REVIEW.disposition, 'COMPLETED');
  assert.deepEqual(brief(renamed), ['PUBLISH', 'BLOCKED', 'branch_mismatch'], 'E1 still binds the enrolled branch');
  fx.okGit(['branch', '-m', 'T-1-renamed', 'T-1-work']);
  fx.okGit(['push', '-q', 'origin', 'T-1-work']); // a plain push (no guard installed here) of the reviewed commit
  publishOwed(fx, 'push after review');
  const p = fx.cli('publish');
  assert.equal(p.out.code, 'published', p.stdout + p.stderr);
  assert.equal(fx.remoteHead(), fx.head());
});

test('a candidate change after review invalidates it (amend that adds an unreviewed file): review_stale, publish refused, restored bytes are fresh again', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  fx.commitAll();
  writeFileSync(join(fx.repo, 'src', 'extra.txt'), 'never reviewed');
  fx.okGit(['add', 'src/extra.txt']);
  commitAs(fx, 'ship', '--amend');
  assert.equal(staleNow(fx, 'review_stale', 'REVIEW', 'amend that changes the tree'), 'candidate_stale');
  fx.okGit(['rm', '-q', 'src/extra.txt']);
  commitAs(fx, 'ship', '--amend');
  publishOwed(fx, 'the reviewed bytes restored');
});

test('a config.base branch rebased onto, or merged into the branch, changes the shipped tree: review_base_moved; gate ship-ready can no longer re-record SHIP_READY on the new base', { skip: WIN_SKIP }, (t) => {
  for (const how of ['rebase', 'merge']) {
    const fx = enrollFixture(t, { base: 'trunk' });
    fx.toShipReady();
    fx.commitAll();
    publishOwed(fx, `${how}: before`);
    fx.okGit(['checkout', '-q', 'trunk']);
    writeFileSync(join(fx.repo, 'trunk.txt'), 'trunk moved');
    fx.okGit(['add', 'trunk.txt']);
    commitAs(fx, 'trunk');
    fx.okGit(['checkout', '-q', 'T-1-work']);
    fx.okGit(how === 'rebase' ? ['rebase', '-q', 'trunk'] : ['merge', '-q', '--no-edit', 'trunk']);
    const code = staleNow(fx, 'review_base_moved', 'REVIEW', how);
    assert.equal(code, 'base_mismatch', `${how}: authorize refuses`);
    // Against the new merge base the candidate id is unchanged, so before E3 this re-recorded SHIP_READY on the new base.
    const sr = fx.gate('ship-ready', {});
    assert.deepEqual([sr.out.ok, sr.out.code], [false, 'review_base_moved'], `${how}: ${sr.stdout}`);
    // authorize publish's own check: a SHIP_READY bound to the new merge base (one recorded before E3) still cannot ship the unreviewed tree.
    const mb = fx.okGit(['merge-base', 'HEAD', 'trunk']).stdout.trim();
    fx.editState(S => { S.ship_ready.merge_base = mb; });
    assert.equal(fx.cli('authorize', { stage: 'publish' }).out.code, 'review_base_moved', `${how}: authorize backstop`);
  }
});

test('forged candidate ids and a confirmation of an older candidate are refused; the lifecycle repair -> confirmation -> publication holds, and a stale confirmation blocks publish until the bytes are restored', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const c1 = fx.candidate();
  const fail = failReview('rx-1', c1, 'src/a.txt', fx.prompt('fix'));
  for (const [name, input] of [['primary', { ...fail, primary: { ...fail.primary, candidate_id: 'sha256:forged' } }],
    ['second opinion', { ...fail, second_opinion: { ...fail.second_opinion, candidate_id: 'sha256:forged' } }]]) {
    const g = fx.gate('review', input);
    assert.deepEqual([g.out.ok, g.out.code], [false, 'stale_candidate'], `${name}: ${g.stdout}`);
  }
  assert.deepEqual([fx.readState().review_chain.length, fx.readState().review_bindings ?? []], [0, []], 'nothing recorded or bound');
  assert.equal(fx.gate('review', fail).out.code, 'review_accepted');
  assert.equal(fx.cli('drive').status, 0, 'the one repair runs');
  const c2 = fx.candidate();
  assert.notEqual(c2, c1);
  for (const [name, input] of [['older candidate', confirmReview('rx-1', c1)], ['forged id', confirmReview('rx-1', 'sha256:forged')]]) {
    const g = fx.gate('review', input);
    assert.deepEqual([g.out.ok, g.out.code], [false, 'stale_candidate'], `${name}: ${g.stdout}`);
  }
  const owed = nextOf(fx).next_action;
  assert.deepEqual([owed.stage, owed.action, owed.candidate_id], ['CONFIRMATION', 'dispatch_review', c2], 'the confirmation of the CURRENT candidate is owed');
  assert.equal(fx.gate('review', confirmReview('rx-1', c2)).out.code, 'review_accepted');
  assert.equal(fx.gate('review', confirmReview('rx-1', c2)).out.code, 'confirmation_spent', 'one targeted confirmation');
  const S = fx.readState();
  assert.deepEqual(S.review_bindings.map(b => [b.kind, b.candidate_id]), [['original', c1], ['repair', c2], ['confirmation', c2]]);
  assert.equal(S.review_bindings[2].merge_base, S.review_bindings[1].merge_base, 'the confirmation is bound to the merge base its candidate was frozen at');
  assert.equal(fx.gate('ship-ready', {}).out.ok, true);
  fx.commitAll();
  publishOwed(fx, 'confirmed and committed');
  writeFileSync(join(fx.repo, 'src', 'extra.txt'), 'never reviewed');
  fx.okGit(['add', 'src/extra.txt']);
  commitAs(fx, 'ship', '--amend');
  assert.equal(staleNow(fx, 'review_stale', 'CONFIRMATION', 'a change after the confirmation'), 'candidate_stale');
  fx.okGit(['rm', '-q', 'src/extra.txt']);
  commitAs(fx, 'ship', '--amend');
  const p = fx.cli('publish');
  assert.equal(p.out.code, 'published', p.stdout + p.stderr);
  assert.deepEqual(brief(nextOf(fx)), ['CI', 'BLOCKED', 'ci_evidence_unavailable']);
});

test('a stale review needs the owner: an owner RETRY makes the new original review owed, and its PASS of the current candidate re-authorizes ship', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  writeFileSync(join(fx.repo, 'src', 'extra.txt'), 'added after the review');
  staleNow(fx, 'review_stale', 'REVIEW', 'an edit after ship-ready');
  const sr = fx.gate('ship-ready', {});
  assert.equal(sr.out.ok, false, 'no SHIP_READY for unreviewed bytes');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  const owed = nextOf(fx).next_action;
  assert.deepEqual([owed.stage, owed.disposition, owed.action, owed.review_execution], ['REVIEW', 'READY', 'dispatch_review', 'rx-2']);
  const c = fx.candidate();
  assert.equal(fx.gate('review', passReview('rx-2', c)).out.code, 'review_accepted');
  assert.equal(nextOf(fx).review_freshness.code, 'review_fresh');
  assert.equal(fx.gate('ship-ready', {}).out.ok, true);
  fx.commitAll();
  publishOwed(fx, 'the RETRY review of the current candidate');
});

test('residual (slice E7): a review file that names the current candidate id is accepted whatever its reviewer read', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const copied = fx.candidate(); // e.g. copied from status, not computed by the reviewer
  const g = fx.gate('review', { review_execution: 'rx-1', kind: 'original', primary: primaryReview(copied), second_opinion: secondOpinion(copied), reconciliation: { dispositions: [] } });
  assert.equal(g.out.code, 'review_accepted', 'freshness binds the record to the candidate; it cannot prove what the reviewer saw');
});

test('a confirmation is judged against the merge base its repaired candidate was frozen at: the base branch merged in after the repair is review_base_moved', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { base: 'trunk', behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.equal(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))).out.code, 'review_accepted');
  assert.equal(fx.cli('drive').status, 0);
  const repaired = fx.candidate();
  fx.okGit(['checkout', '-q', 'trunk']);
  writeFileSync(join(fx.repo, 'trunk.txt'), 'trunk moved');
  fx.okGit(['add', 'trunk.txt']);
  commitAs(fx, 'trunk');
  fx.okGit(['checkout', '-q', 'T-1-work']);
  fx.okGit(['merge', '-q', '--no-edit', 'trunk']);
  assert.equal(fx.candidate(), repaired, 'against the new merge base the candidate id is the repaired one');
  const g = fx.gate('review', confirmReview('rx-1', repaired));
  assert.deepEqual([g.out.ok, g.out.code], [false, 'review_base_moved'], g.stdout);
  assert.equal(fx.readState().review_chain.filter(r => r.kind === 'confirmation').length, 0, 'nothing recorded');
});
