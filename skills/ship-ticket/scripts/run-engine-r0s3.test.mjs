/**
 * R0-S repair round 3, defect N-BASE: the base the reviewed range is measured from is the commit the REMOTE names for the base
 * branch (engine-base.mjs), recorded at the review freeze with the repository identity and re-verified at ship-ready and at
 * authorize publish; a local ref (a config.base branch, or the remote-tracking origin/<default>) is never the authority.
 * Codes: base_unverified, base_remote_unavailable, base_moved_local, base_moved_remote. STRICT review policy; the REAL engine CLI
 * on temp repos with fakes only (engine-enroll.test-helper.mjs: the remote is a local bare repository behind a GitHub-style URL).
 *
 * The first test is the reproduction on c1fec76 (pre-fix: gate review accepted, ship-ready recorded, authorize publish allowed and
 * publish pushed a commit no review covered); it is kept as the regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, passReview } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const authorize = (fx, extra = {}) => fx.cli('authorize', { stage: 'publish', ...extra });
const code = (r) => r.out?.code;
const started = (fx) => { assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0); assert.equal(fx.cli('drive').status, 0); };
const review = (fx, rx = 'rx-1') => fx.gate('review', passReview(rx, fx.candidate()));
const shipReady = (fx) => fx.gate('ship-ready', {});
const next = (fx) => { const n = fx.cli('next'); return { ...n.out.next_action, stop: n.out.stop }; };
const sha = (fx, ref) => fx.okGit(['rev-parse', ref]).stdout.trim();
const remoteSha = (fx, b) => fx.remoteHead(b);
/** Commit an unreviewed file on the ticket branch. */
const unreviewed = (fx, file = 'docs/wip.txt') => { writeFileSync(join(fx.repo, file), 'UNREVIEWED'); fx.okGit(['add', file]); fx.okGit(['commit', '-q', '-m', 'unreviewed']); };
/** Advance the REMOTE trunk with an unrelated commit from another clone (the local repository never sees it until a fetch). */
const advanceRemote = (fx, file = 'upstream.txt') => {
  const other = join(fx.root, `other-${file}`);
  fx.okGit(['clone', '-q', '--branch', 'trunk', fx.remote, other], { cwd: fx.root });
  writeFileSync(join(other, file), 'upstream');
  fx.okGit(['add', file], { cwd: other });
  fx.okGit(['commit', '-q', '-m', 'upstream'], { cwd: other });
  fx.okGit(['push', '-q', 'origin', 'trunk'], { cwd: other });
  return sha({ okGit: (a) => fx.okGit(a, { cwd: other }) }, 'HEAD');
};

test('N-BASE reproduction (a): an unreviewed commit, then `git branch -f trunk HEAD`, then review: base_moved_local at gate review (pre-fix: authorize publish allowed and publish pushed it); restored, the full candidate ships', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  started(fx);
  const remoteTrunk = remoteSha(fx, 'trunk');
  unreviewed(fx);
  fx.okGit(['branch', '-f', 'trunk', 'HEAD']);
  const g = review(fx);
  assert.deepEqual([g.out.ok, g.out.code], [false, 'base_moved_local'], g.stdout);
  assert.match(g.out.reasons[0], new RegExp(`origin/trunk = ${remoteTrunk}`));
  const S = fx.readState();
  assert.deepEqual([S.review_chain.length, S.freeze], [0, null], 'nothing accepted, nothing frozen');
  const n = next(fx);
  assert.deepEqual([n.reason, n.owner, n.stop], ['base_moved_local', 'human', true], J(n));
  assert.equal(fx.remoteHead(), null, 'nothing pushed');
  // Restored to the remote's base commit, the candidate includes the commit and its review authorizes exactly it.
  fx.okGit(['branch', '-f', 'trunk', remoteTrunk]);
  assert.equal(review(fx).out.code, 'review_accepted');
  assert.equal(fx.readState().freeze.base.sha, remoteTrunk, 'the freeze records the remote base commit');
  assert.equal(shipReady(fx).out.ok, true);
  fx.commitAll();
  const a = authorize(fx);
  assert.deepEqual([a.out.allow, a.out.binding.base_sha, a.out.binding.merge_base], [true, remoteTrunk, remoteTrunk], a.stdout);
  assert.equal(code(fx.cli('publish')), 'published');
});

test('N-BASE (b): the local base moved at any later point is base_moved_local: before ship-ready, after it (authorize publish, the pre-push hook), and onto a branch commit before review (merge bases compared, not ref positions)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  started(fx);
  const remoteTrunk = remoteSha(fx, 'trunk');
  assert.equal(review(fx).out.code, 'review_accepted');
  fx.commitAll('reviewed bytes');
  fx.okGit(['branch', '-f', 'trunk', 'HEAD']);
  assert.equal(code(shipReady(fx)), 'base_moved_local', 'ship-ready re-verifies the freeze base');
  fx.okGit(['branch', '-f', 'trunk', remoteTrunk]);
  assert.equal(shipReady(fx).out.ok, true);
  assert.equal(fx.readState().ship_ready.base.sha, remoteTrunk, 'SHIP_READY binds the verified base commit');
  unreviewed(fx);
  fx.okGit(['branch', '-f', 'trunk', 'HEAD']);
  assert.equal(code(authorize(fx)), 'base_moved_local');
  assert.equal(code(fx.cli('publish')), 'base_moved_local');
  assert.equal(spawnSync(process.execPath, [GUARD, 'install', '--repo', fx.repo], { encoding: 'utf8', env: fx.env }).status, 0);
  const push = spawnSync('git', ['push', 'origin', 'T-1-work'], { cwd: fx.repo, encoding: 'utf8', env: fx.env });
  assert.notEqual(push.status, 0, 'the pre-push hook refuses');
  assert.match(push.stderr, /base_moved_local/);
  assert.equal(fx.remoteHead(), null);
  // The policy compares MERGE BASES, not ref positions: a local base moved to a commit the branch does not contain leaves the merge
  // base (and so the candidate) unchanged, and is accepted; one the branch contains is base_moved_local even before any commit of its own.
  const h = enrollFixture(t, { base: 'trunk' });
  started(h);
  h.okGit(['checkout', '-q', '-b', 'side', 'trunk']);
  writeFileSync(join(h.repo, 'docs', 'side.txt'), 'side');
  h.okGit(['add', 'docs/side.txt']);
  h.okGit(['commit', '-q', '-m', 'side']);
  h.okGit(['checkout', '-q', 'T-1-work']);
  h.okGit(['branch', '-f', 'trunk', 'side']);
  assert.equal(code(review(h)), 'review_accepted', 'a local base the branch does not contain: same merge base, nothing omitted');
  const k = enrollFixture(t, { base: 'trunk' });
  started(k);
  k.okGit(['commit', '-q', '--allow-empty', '-m', 'empty, on the branch']);
  k.okGit(['branch', '-f', 'trunk', 'HEAD']);
  assert.equal(code(review(k)), 'base_moved_local', 'a local base the branch contains, past the remote base');
});

test('N-BASE (c): the remote base advanced with commits the branch lacks is accepted (same merge base, fetched); force-pushed off the reviewed base it is base_moved_remote; merged into the branch it needs the owner re-freeze', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  started(fx);
  const reviewedBase = remoteSha(fx, 'trunk');
  assert.equal(review(fx).out.code, 'review_accepted');
  const advanced = advanceRemote(fx);
  assert.equal(code(shipReady(fx)), 'base_remote_unavailable', 'the advanced remote commit is not local: never assumed to descend');
  fx.okGit(['fetch', '-q', 'origin']);
  assert.equal(shipReady(fx).out.ok, true, 'fetched: it descends from the reviewed base and the merge base is unchanged');
  assert.equal(fx.readState().ship_ready.base.sha, reviewedBase, 'the base of record stays the reviewed commit');
  fx.commitAll();
  const a = authorize(fx);
  assert.deepEqual([a.out.allow, a.out.binding.base_sha, a.out.binding.merge_base], [true, advanced, reviewedBase], a.stdout);
  // Force-pushed onto a history that does not contain the reviewed base commit.
  const orphan = fx.okGit(['commit-tree', `${sha(fx, 'HEAD')}^{tree}`, '-m', 'rewritten'], { env: fx.env }).stdout.trim();
  fx.okGit(['push', '-q', '-f', 'origin', `${orphan}:refs/heads/trunk`]);
  assert.equal(code(authorize(fx)), 'base_moved_remote');
  assert.equal(code(fx.cli('publish')), 'base_moved_remote');
  assert.equal(fx.remoteHead(), null);
  // The owner merges the advanced base into the branch: the merge base moves, so only a re-freeze (RETRY) authorizes it.
  const m = enrollFixture(t, { base: 'trunk' });
  started(m);
  assert.equal(review(m).out.code, 'review_accepted');
  m.commitAll('reviewed bytes');
  const up = advanceRemote(m);
  m.okGit(['fetch', '-q', 'origin']);
  m.okGit(['branch', '-f', 'trunk', 'origin/trunk']);
  m.okGit(['merge', '-q', '--no-edit', 'trunk']);
  assert.equal(code(shipReady(m)), 'review_base_moved', 'the merged base changed the merge base: the review is not of this tree');
  m.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  m.commitAll('retry line');
  assert.equal(review(m, 'rx-2').out.code, 'review_accepted', 'the owner re-freeze');
  assert.equal(m.readState().freeze.base.sha, up, 'the re-freeze records the new remote base commit');
  assert.equal(shipReady(m).out.ok, true);
  assert.equal(authorize(m).out.allow, true);
});

test('N-BASE (d): missing or unavailable base evidence fails closed: no remote, a deleted or unreachable remote branch, a lost record, another repository', { skip: WIN_SKIP }, async (t) => {
  const none = enrollFixture(t, { base: 'trunk' });
  started(none);
  none.okGit(['remote', 'remove', 'origin']);
  assert.equal(code(review(none)), 'identity_changed', 'no remote (round 4: the enrolled identity is gone): a local ref is never the base authority');

  const fx = enrollFixture(t, { base: 'trunk' });
  started(fx);
  assert.equal(review(fx).out.code, 'review_accepted');
  fx.okGit(['--git-dir', fx.remote, 'branch', '-D', 'trunk'], { cwd: fx.root });
  assert.equal(code(shipReady(fx)), 'base_remote_unavailable', 'the remote has no base branch');
  fx.okGit(['push', '-q', 'origin', 'trunk']);
  fx.okGit(['config', '--local', '--unset-all', `url.${fx.remote}.insteadOf`]);
  fx.okGit(['config', '--local', `url.${join(fx.root, 'nowhere.git')}.insteadOf`, 'https://github.com/acme/t-1.git']);
  assert.equal(code(shipReady(fx)), 'base_remote_unavailable', 'ls-remote fails: same identity, unreachable');
  fx.okGit(['config', '--local', '--unset-all', `url.${join(fx.root, 'nowhere.git')}.insteadOf`]);
  fx.okGit(['config', '--local', `url.${fx.remote}.insteadOf`, 'https://github.com/acme/t-1.git']);
  const record = fx.readState().freeze.base;
  assert.deepEqual(record, { remote: 'origin', identity: 'github.com/acme/t-1', ref: 'trunk', sha: remoteSha(fx, 'trunk'), merge_base: remoteSha(fx, 'trunk') });
  fx.editState(S => { delete S.freeze.base; });
  assert.equal(code(shipReady(fx)), 'base_unverified', 'a freeze without a verified base is never grandfathered');
  fx.editState(S => { S.freeze.base = record; });
  assert.equal(shipReady(fx).out.ok, true);
  fx.commitAll();
  assert.equal(authorize(fx).out.allow, true);
  fx.editState(S => { delete S.ship_ready.base; });
  assert.equal(code(authorize(fx)), 'base_unverified', 'SHIP_READY without a verified base');
  fx.editState(S => { S.ship_ready.base = structuredClone(S.freeze.base); });
  assert.equal(authorize(fx).out.allow, true);
  // Another repository behind the same name (the fork maps to the same bare remote): the run enrolled github.com/acme/t-1 (round 4: identity_changed).
  fx.okGit(['remote', 'set-url', 'origin', 'https://github.com/evil/fork.git']);
  fx.okGit(['config', '--local', `url.${fx.remote}.insteadOf`, 'https://github.com/evil/fork.git']);
  assert.equal(code(authorize(fx)), 'identity_changed');
  assert.equal(code(shipReady(fx)), 'identity_changed');
});

test('N-BASE (e): the unchanged-base workflows still pass: named base (review -> ship-ready -> publish, base commit bound) and config.base HEAD', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  await fx.toShipReady();
  fx.commitAll();
  const p = fx.cli('publish');
  assert.deepEqual([p.out.code, p.out.base, p.out.base_sha, fx.remoteHead()], ['published', 'trunk', remoteSha(fx, 'trunk'), fx.head()], p.stdout);
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  const q = h.cli('publish');
  assert.deepEqual([q.out.code, q.out.base, q.out.base_sha], ['published', h.defaultBranch, remoteSha(h, h.defaultBranch)], q.stdout);
  // R0-S round 4 (D2): config.base HEAD records the base too: the remote's default branch, resolved once with ls-remote --symref.
  assert.deepEqual(h.readState().freeze.base, { remote: 'origin', identity: 'github.com/acme/t-1', ref: h.defaultBranch, sha: remoteSha(h, h.defaultBranch), merge_base: remoteSha(h, h.defaultBranch) });
});

test('N-BASE (f): laundering through base changes stays refused in combination: --base (pr_base_unbound), the moved local base, the history check, and the remote-tracking ref under config.base HEAD', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  await fx.toShipReady();
  fx.commitAll();
  const remoteTrunk = remoteSha(fx, 'trunk');
  writeFileSync(join(fx.repo, 'secret.txt'), 'token');
  fx.commitAll('smuggle');
  fx.okGit(['rm', '-q', 'secret.txt']);
  fx.commitAll('revert the smuggle');
  fx.okGit(['branch', 'wipbase', 'HEAD']);
  fx.okGit(['branch', '-f', 'trunk', 'HEAD']);
  assert.equal(code(authorize(fx, { base: 'wipbase' })), 'pr_base_unbound', '--base first');
  assert.equal(code(authorize(fx, { base: 'trunk' })), 'base_moved_local', 'the bound name over a moved local ref');
  assert.equal(code(authorize(fx)), 'base_moved_local');
  fx.okGit(['branch', '-f', 'trunk', remoteTrunk]);
  assert.equal(code(authorize(fx)), 'history_outside_candidate', 'restored: the reverted smuggle is still caught from the frozen base');
  // config.base HEAD: the PR base's commit is the remote's, never the remote-tracking ref (`git update-ref refs/remotes/origin/<default>`).
  const h = enrollFixture(t);
  unreviewed(h);
  const wip = h.head();
  await h.toShipReady();
  h.commitAll();
  assert.equal(code(authorize(h)), 'base_mismatch', 'the unreviewed commit is under the reviewed range');
  h.okGit(['update-ref', `refs/remotes/origin/${h.defaultBranch}`, wip]);
  // Round 4: the remote-tracking ref is never read at all; the remote's commit gives the true merge base (was base_moved_local in round 3).
  assert.equal(code(authorize(h)), 'base_mismatch', 'pre-fix (c1fec76): allow (the tracking ref gave the reviewed merge base)');
  assert.equal(code(authorize(h, { base: wip })), 'pr_base_unbound');
  assert.equal(code(h.cli('publish')), 'base_mismatch');
  assert.equal(h.remoteHead(), null, 'nothing pushed');
});
