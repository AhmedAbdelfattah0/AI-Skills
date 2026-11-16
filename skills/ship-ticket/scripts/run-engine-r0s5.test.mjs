/**
 * R0-S round 5: the confirmed defects of 0a9c748, reproduced first (pre-fix outcome in each title) and kept as regressions, with the
 * legitimate workflows that must stay green beside them.
 *   item 1  an ambiguous remote (several fetch URLs, several push URLs, a push URL of another repository) is remote_ambiguous at
 *           enroll, gate review, publish (before any push), the pre-push hook, ci and complete; one URL (and one equal push URL) ships
 *   item 2  the reviewer brief cannot be emptied by a textconv driver (or any other diff renderer setting): it is rendered from the
 *           candidate's own bytes and verified against the candidate inventory, or review_diff_unverified
 *   item 3  CI aggregation over every check run (filter=all), superseded only by a later attempt of the same workflow run
 * STRICT review policy; the REAL engine CLI on temp repos with fakes only. Every PR and CI answer here is SIMULATED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX } from './engine-test-fixture.mjs';
import { enrollFixture, GITHUB_URL } from './engine-enroll.test-helper.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const FORK_URL = 'https://github.com/evil/fork.git';
const GREEN = { checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'completed', conclusion: 'success', started_at: '2026-11-15T00:00:01.000Z', completed_at: '2026-11-15T00:00:09.000Z' }] }] };
const code = (r) => r.out?.code;
const body = (fx) => { const f = join(fx.root, 'pr-body.md'); writeFileSync(f, 'body'); return f; };
const publishPr = (fx, extra = {}) => fx.cli('publish', { 'pr-title': 'T-1: ship', 'pr-body-file': body(fx), ...extra });
const authorize = (fx, stage, extra = {}) => fx.cli('authorize', { stage, ...extra });
/** A bare repository `evil/fork` behind its GitHub URL (insteadOf), carrying the default branch. */
const addForkBare = (fx) => {
  const fork = join(fx.root, 'fork.git');
  fx.okGit(['init', '-q', '--bare', fork], { cwd: fx.root });
  fx.okGit(['config', '--local', `url.${fork}.insteadOf`, FORK_URL]);
  fx.okGit(['push', '-q', fork, `${fx.defaultBranch}:refs/heads/${fx.defaultBranch}`]);
  fx.okGit(['--git-dir', fork, 'symbolic-ref', 'HEAD', `refs/heads/${fx.defaultBranch}`], { cwd: fx.root });
  return fork;
};
const refIn = (fx, bare, ref = 'refs/heads/T-1-work') => {
  const r = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8', env: fx.env });
  return r.status === 0 ? r.stdout.trim() : null;
};
/** origin's fetch URLs become [the fork, the enrolled repository] (git fetch/ls-remote use the first; git push uses all). */
const twoUrls = (fx) => { fx.okGit(['config', '--local', '--replace-all', 'remote.origin.url', FORK_URL]); fx.okGit(['config', '--local', '--add', 'remote.origin.url', GITHUB_URL]); };
const oneUrl = (fx) => fx.okGit(['config', '--local', '--replace-all', 'remote.origin.url', GITHUB_URL]);
/** origin keeps one URL; its push URLs become [the fork, the enrolled repository] (git push uses every push URL). */
const twoPushUrls = (fx) => { fx.okGit(['config', '--local', '--add', 'remote.origin.pushurl', FORK_URL]); fx.okGit(['config', '--local', '--add', 'remote.origin.pushurl', GITHUB_URL]); };
const noPushUrl = (fx) => fx.okGit(['config', '--local', '--unset-all', 'remote.origin.pushurl']);

// ------------------------------------------------------------------ item 1: an ambiguous remote is never resolved to one of its values

test('R5-1a (pre-fix: published to BOTH the fork and the enrolled repository): two origin fetch URLs (fork first) are remote_ambiguous at authorize publish and publish; nothing is pushed anywhere; one URL restored, it publishes', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  const fork = addForkBare(h);
  await h.toShipReady();
  h.commitAll();
  twoUrls(h);
  assert.equal(code(authorize(h, 'publish')), 'remote_ambiguous');
  const p = publishPr(h);
  assert.equal(code(p), 'remote_ambiguous', p.stdout);
  assert.deepEqual([refIn(h, fork), h.remoteHead()], [null, null], 'nothing pushed to either repository');
  oneUrl(h);
  const ok = publishPr(h);
  assert.equal(code(ok), 'published', ok.stdout);
  assert.equal(refIn(h, fork), null);
});

test('R5-1b (pre-fix: published to both): two origin push URLs (fork first, the enrolled one last) are remote_ambiguous at publish, before any push', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  const fork = addForkBare(h);
  await h.toShipReady();
  h.commitAll();
  twoPushUrls(h);
  const p = publishPr(h);
  assert.equal(code(p), 'remote_ambiguous', p.stdout);
  assert.deepEqual([refIn(h, fork), h.remoteHead()], [null, null], 'nothing pushed');
  // A push URL of ANOTHER repository (one value, a mismatched destination) is ambiguous too: fetch and push name different repositories.
  noPushUrl(h);
  h.okGit(['config', '--local', 'remote.origin.pushurl', FORK_URL]);
  assert.equal(code(publishPr(h)), 'remote_ambiguous');
  assert.equal(refIn(h, fork), null);
  noPushUrl(h);
  assert.equal(code(publishPr(h)), 'published');
});

test('R5-1c (pre-fix: the hook allowed and git pushed to both): a plain `git push origin` with two push URLs is refused by the pre-push hook (remote_ambiguous); neither repository received the branch', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  const fork = addForkBare(h);
  await h.toShipReady();
  h.commitAll();
  assert.equal(spawnSync(process.execPath, [GUARD, 'install', '--repo', h.repo], { encoding: 'utf8', env: h.env }).status, 0);
  twoPushUrls(h);
  const push = spawnSync('git', ['push', 'origin', 'T-1-work'], { cwd: h.repo, encoding: 'utf8', env: h.env });
  assert.notEqual(push.status, 0, push.stderr);
  assert.match(push.stderr, /remote_ambiguous/);
  assert.deepEqual([refIn(h, fork), h.remoteHead()], [null, null], 'neither repository received the branch');
  noPushUrl(h);
  const ok = spawnSync('git', ['push', 'origin', 'T-1-work'], { cwd: h.repo, encoding: 'utf8', env: h.env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(h.remoteHead(), h.head());
});

test('R5-1d (pre-fix: ci PASS and complete allow after a second push URL): ci records UNAVAILABLE remote_ambiguous and complete refuses it; restored, both pass', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  addForkBare(h);
  await h.toShipReady();
  h.commitAll();
  h.scriptCi(GREEN);
  assert.equal(code(publishPr(h)), 'published');
  assert.equal(h.cli('ci').out.state, 'PASS');
  twoPushUrls(h);
  const c = h.cli('ci');
  assert.deepEqual([c.out.state, c.out.code], ['UNAVAILABLE', 'remote_ambiguous'], c.stdout);
  assert.equal(code(authorize(h, 'complete')), 'remote_ambiguous');
  noPushUrl(h);
  assert.equal(h.cli('ci').out.state, 'PASS');
  assert.equal(authorize(h, 'complete').out.allow, true);
  // ...and at gate review time (the freeze is never captured on an ambiguous remote): a fresh run, two URLs before the review.
  const g = enrollFixture(t);
  addForkBare(g);
  assert.equal(g.cli('init', { dag: g.dagFile }).status, 0);
  assert.equal(g.cli('drive').status, 0);
  twoUrls(g);
  const d = g.dispatch('primary');
  assert.equal(d.out.code, 'remote_ambiguous', d.stdout);
});

test('R5-1e (pre-fix: enrolled the LAST URL as the identity): enroll refuses an ambiguous origin (remote_ambiguous) and records no enrollment; one URL, it enrolls', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t, { admit: false });
  addForkBare(h);
  assert.equal(h.cli('init', { dag: h.dagFile }).status, 0);
  twoUrls(h);
  const e = h.cli('enroll');
  assert.notEqual(e.status, 0, e.stdout);
  assert.match(e.stderr + e.stdout, /remote_ambiguous/);
  assert.equal(h.readState().enrollment ?? null, null, 'no enrollment recorded');
  oneUrl(h);
  const ok = h.cli('enroll');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(h.readState().enrollment.identity.slug, 'github.com/acme/t-1');
});

test('R5-1f legitimate: one fetch URL and one push URL naming the SAME repository (ssh spelling) publishes, ci passes and complete allows (no new false block)', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  const SSH = 'git@github.com:acme/t-1.git';
  // insteadOf (pushInsteadOf never rewrites an explicit pushurl): the ssh spelling stays on the local bare, never the network.
  h.okGit(['config', '--local', '--add', `url.${h.remote}.insteadOf`, SSH]);
  h.okGit(['config', '--local', 'remote.origin.pushurl', SSH]);
  h.scriptCi(GREEN);
  const p = publishPr(h);
  assert.equal(code(p), 'published', p.stdout);
  assert.equal(h.remoteHead(), h.head());
  assert.equal(h.cli('ci').out.state, 'PASS');
  assert.equal(authorize(h, 'complete').out.allow, true);
});
