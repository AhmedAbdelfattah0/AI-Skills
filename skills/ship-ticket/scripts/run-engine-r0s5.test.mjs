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
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX } from './engine-test-fixture.mjs';
import { enrollFixture, GITHUB_URL } from './engine-enroll.test-helper.mjs';
import { candidateId } from './engine-io.mjs';
import { historyPaths } from './engine-enroll.mjs';
import { buildPrompt } from './engine-review-dispatch.mjs';
import { ghProvider } from './engine-ci.mjs';
import { waitFor } from './test-wait.test-helper.mjs';

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

// ------------------------------------------------------------------ item 2: the reviewer brief is the candidate's own bytes

/** A temp repo (isolated config): base commit c0 with src/{a,b,c,d}.txt = "old", HEAD = c0 (trunk), the work tree changed by `edit`. */
function briefRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r0s5-brief-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, '.home'); // outside the work tree? no: ignored below
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, '.gitconfig-none'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  writeFileSync(join(dir, '.gitconfig-none'), '');
  const g = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q');
  writeFileSync(join(dir, '.gitignore'), '.gitconfig-none\n.home\n');
  mkdirSync(join(dir, 'src'));
  for (const f of ['a', 'b', 'c', 'd']) writeFileSync(join(dir, 'src', `${f}.txt`), 'old\n');
  g('add', '.'); g('commit', '-q', '-m', 'c0'); g('branch', 'trunk');
  void home;
  const brief = (over = {}) => {
    const c = candidateId(dir, 'trunk', []);
    assert.ok(c.candidate_id, J(c));
    return buildPrompt({ S: { ticket: 'T-1', run_id: 'run-1', config: {} }, repoRoot: dir, planText: null, role: 'primary', owed: { kind: 'original' },
      candidate: c.candidate_id, mergeBase: c.merge_base, paths: c.paths, ...over });
  };
  return { dir, g, brief };
}
const J = JSON.stringify;

test('R5-2a (pre-fix: the brief carried NO content of src/a.txt while the candidate hashed its bytes): a SUCCESSFUL textconv (diff.hide.textconv=true via .git/info/attributes), a -diff attribute, core.bigFileThreshold and a clean filter never hide the changed bytes from the reviewer', (t) => {
  const r = briefRepo(t);
  for (const f of ['a', 'b', 'c', 'd']) writeFileSync(join(r.dir, 'src', `${f}.txt`), `SECRET-${f}\n`);
  writeFileSync(join(r.dir, '.git', 'info', 'attributes'), 'src/a.txt diff=hide\nsrc/b.txt -diff\nsrc/d.txt filter=blank\n');
  r.g('config', 'diff.hide.textconv', 'true');
  r.g('config', 'core.bigFileThreshold', '1');
  r.g('config', 'filter.blank.clean', 'cat >/dev/null');
  const b = r.brief();
  for (const f of ['a', 'b', 'c', 'd']) assert.match(b, new RegExp(`^\\+SECRET-${f}$`, 'm'), `src/${f}.txt's new line is in the brief`);
  for (const f of ['a', 'b', 'c', 'd']) assert.match(b, new RegExp(`^-old$`, 'm'));
  assert.doesNotMatch(b, /Binary files .* differ/, 'no text file is rendered as binary');
});

test('R5-2b the brief is bound to the frozen candidate and its COMPLETE inventory: a candidate id other than the bytes now, or an inventory missing a changed path, is review_diff_unverified (no reviewer launches)', (t) => {
  const r = briefRepo(t);
  writeFileSync(join(r.dir, 'src', 'a.txt'), 'new a\n');
  writeFileSync(join(r.dir, 'src', 'b.txt'), 'new b\n');
  const c = candidateId(r.dir, 'trunk', []);
  const ok = r.brief();
  assert.match(ok, new RegExp(`candidate ${c.candidate_id}`));
  assert.match(ok, /## Candidate inventory/);
  const unverified = (e) => e.code === 'review_diff_unverified';
  assert.throws(() => r.brief({ candidate: 'f'.repeat(64) }), unverified, 'another candidate id');
  assert.throws(() => r.brief({ paths: ['src/a.txt'] }), unverified, 'src/b.txt left out of the inventory');
  // the work tree moving after the candidate was frozen (the bytes the reviewer would read are not the candidate's)
  const frozen = candidateId(r.dir, 'trunk', []);
  writeFileSync(join(r.dir, 'src', 'a.txt'), 'moved after the freeze\n');
  assert.throws(() => buildPrompt({ S: { ticket: 'T-1', run_id: 'run-1', config: {} }, repoRoot: r.dir, planText: null, role: 'primary', owed: { kind: 'original' },
    candidate: frozen.candidate_id, mergeBase: frozen.merge_base, paths: frozen.paths }), unverified);
});

test('R5-2c legitimate candidates render without a new false block: a new untracked file, a deletion, a mode-only change, a symlink, a real binary (declared with its digest), CRLF and a file with no final newline', { skip: POSIX ? false : 'symlink and mode bits' }, (t) => {
  const r = briefRepo(t);
  writeFileSync(join(r.dir, 'src', 'new.txt'), 'brand new\n');
  rmSync(join(r.dir, 'src', 'b.txt'));
  chmodSync(join(r.dir, 'src', 'c.txt'), 0o755);
  symlinkSync('a.txt', join(r.dir, 'src', 'link'));
  writeFileSync(join(r.dir, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(r.dir, 'src', 'a.txt'), 'line1\r\nline2');
  r.g('add', '-N', 'src/blob.bin', 'src/link');
  const b = r.brief();
  assert.match(b, /## Untracked file src\/new\.txt\n```\nbrand new\n/, 'untracked content, whole');
  assert.match(b, /deleted file mode 100644/);
  assert.match(b, /old mode 100644\nnew mode 100755/);
  assert.match(b, /new file mode 120000/);
  assert.match(b, /binary content \(6 bytes, sha256:[0-9a-f]{64}\)/);
  assert.match(b, /^\+line1\r$/m);
  assert.match(b, /\\ No newline at end of file/);
});

test('R5-2d (pre-fix: the reviewer prompt omitted src/a.txt): engine review-dispatch with a successful textconv hiding src/a.txt writes a prompt carrying its bytes; the receipt binds the inventory digest', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  mkdirSync(join(fx.repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(fx.repo, '.git', 'info', 'attributes'), 'src/a.txt diff=hide\n');
  fx.okGit(['config', '--local', 'diff.hide.textconv', 'true']);
  fx.okGit(['add', '-N', 'src/a.txt']);
  const d = fx.dispatch('primary');
  assert.equal(d.out.code, 'review_dispatched', d.stdout);
  const prompt = readFileSync(d.out.receipt.prompt_file, 'utf8');
  assert.match(prompt, /^\+a1$/m, 'the reviewer sees the bytes the candidate covers');
  assert.match(d.out.receipt.inventory_sha256 ?? '', /^sha256:[0-9a-f]{64}$/);
  // the detached fake reviewer finishes and is collected before the fixture is removed
  await waitFor(() => (fx.cli('review-collect').out?.live ?? ['?']).length === 0, 'the dispatched reviewer to be collected', { ms: 60000, every: 200 });
});

test('R5-2e (pre-fix: a submodule bump was NOT a candidate path, so neither reviewed nor caught by the history check): diff.ignoreSubmodules=all never hides a changed submodule from the candidate inventory or the publish history listing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'r0s5-sub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'none.gitconfig'), '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'none.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const inner = join(root, 'inner'), main = join(root, 'main');
  mkdirSync(inner); mkdirSync(main);
  g(inner, 'init', '-q'); writeFileSync(join(inner, 'f'), '1'); g(inner, 'add', 'f'); g(inner, 'commit', '-q', '-m', 'i1');
  g(main, 'init', '-q'); writeFileSync(join(main, 'x'), 'x'); g(main, 'add', 'x'); g(main, 'commit', '-q', '-m', 'c0');
  g(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'); g(main, 'commit', '-q', '-m', 'sub');
  g(main, 'branch', 'trunk');
  writeFileSync(join(main, 'sub', 'f'), '2'); g(join(main, 'sub'), 'commit', '-q', '-a', '-m', 'i2');
  g(main, 'add', 'sub'); g(main, 'commit', '-q', '-m', 'bump the submodule');
  g(main, 'config', 'diff.ignoreSubmodules', 'all');
  const c = candidateId(main, 'trunk', []);
  assert.deepEqual(c.paths, ['sub'], J(c));
  const h = historyPaths(main, 'trunk..HEAD');
  assert.deepEqual([h.ok, h.paths], [true, ['sub']], J(h));
  const b = buildPrompt({ S: { ticket: 'T-1', run_id: 'run-1', config: {} }, repoRoot: main, planText: null, role: 'primary', owed: { kind: 'original' },
    candidate: c.candidate_id, mergeBase: c.merge_base, paths: c.paths });
  assert.match(b, /Subproject commit [0-9a-f]{40} -> [0-9a-f]{40}/);
});

// ------------------------------------------------------------------ item 3: CI over every check run; supersession only by a later attempt

/** A check run on the published head (SIMULATED GitHub answer). */
const cr = (id, conclusion, over = {}) => ({ id, name: 'test', head_sha: '$SHA', status: conclusion ? 'completed' : 'in_progress', conclusion: conclusion ?? null,
  started_at: `2026-11-15T00:00:0${id % 10}.000Z`, completed_at: conclusion ? `2026-11-15T00:01:0${id % 10}.000Z` : null, app: 'github-actions', check_suite: 11, ...over });
/** One collection's script: what filter=latest returns (`latest`), what filter=all returns (`all`), and the Actions workflow runs. */
const ciScript = (latest, all, workflowRuns = []) => ({ checkRuns: [{ runs: latest, all }], workflowRuns });
/** A published, ship-ready fixture with a PR. */
const published = async (t) => {
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  h.scriptCi(GREEN);
  assert.equal(code(publishPr(h)), 'published');
  return h;
};

test('R5-3a (pre-fix: PASS and complete allow, the failed attempt hidden by filter=latest): a failed run of workflow run 500 and a green run of ANOTHER workflow run 501 of the same name: no verified supersession, FAIL', { skip: WIN_SKIP }, async (t) => {
  const h = await published(t);
  h.scriptCi(ciScript([cr(2, 'success')], [cr(1, 'failure'), cr(3, 'cancelled'), cr(2, 'success')], [
    { id: 500, run_attempt: 1, jobs: { 1: [{ id: 1, name: 'test', conclusion: 'failure', check_run_id: 1 }] } },
    // run 501 was itself re-run (attempt 2): a HIGHER attempt of ANOTHER workflow run never supersedes run 500's failure
    { id: 501, run_attempt: 2, jobs: { 1: [{ id: 3, name: 'test', conclusion: 'cancelled', check_run_id: 3 }], 2: [{ id: 2, name: 'test', conclusion: 'success', check_run_id: 2 }] } }]));
  const c = h.cli('ci');
  assert.deepEqual([c.out.state, c.out.code], ['FAIL', 'ci_failed'], c.stdout);
  assert.deepEqual(c.out.failed, ['test'], c.stdout);
  assert.match(c.out.reasons.join(' '), /failure/, 'run 500\'s failure is the one reported');
  assert.equal(code(authorize(h, 'complete')), 'ci_failed');
});

test('R5-3b legitimate green rerun: attempt 1 of workflow run 500 failed, attempt 2 of the SAME run passed: verified supersession, PASS (the superseded run is recorded), and complete allows on the recorded evidence', { skip: WIN_SKIP }, async (t) => {
  const h = await published(t);
  h.scriptCi(ciScript([cr(2, 'success')], [cr(1, 'failure'), cr(2, 'success')], [
    { id: 500, run_attempt: 2, jobs: { 1: [{ id: 1, name: 'test', conclusion: 'failure', check_run_id: 1 }], 2: [{ id: 2, name: 'test', conclusion: 'success', check_run_id: 2 }] } }]));
  const c = h.cli('ci');
  assert.deepEqual([c.out.state, c.out.code], ['PASS', 'ci_passed'], c.stdout);
  assert.deepEqual(c.out.superseded.map(x => [x.id, x.run_attempt, x.superseded_by_attempt]), [[1, 1, 2]]);
  assert.deepEqual(c.out.checks.map(x => [x.id, x.workflow_run, x.run_attempt]), [[1, 500, 1], [2, 500, 2]], 'the attempt identity is recorded with the evidence');
  const a = authorize(h, 'complete');
  assert.equal(a.out.allow, true, a.stdout);
});

test('R5-3c (pre-fix: PASS): a third-party app\'s same-named failed and green runs have no attempt identity: UNAVAILABLE ci_rerun_unverified with the recovery; complete refuses', { skip: WIN_SKIP }, async (t) => {
  const h = await published(t);
  const ext = { app: 'circleci', check_suite: 77 };
  h.scriptCi(ciScript([cr(2, 'success', ext)], [cr(1, 'failure', ext), cr(2, 'success', ext)]));
  const c = h.cli('ci');
  assert.deepEqual([c.out.state, c.out.code], ['UNAVAILABLE', 'ci_rerun_unverified'], c.stdout);
  assert.match(c.out.reasons.join(' '), /circleci/);
  assert.match(c.out.reasons.join(' '), /re-run/);
  assert.equal(code(authorize(h, 'complete')), 'ci_rerun_unverified');
  const n = h.cli('next').out.next_action;
  assert.equal(n.owner, 'human', JSON.stringify(n));
});

test('R5-3d an Actions rerun still running (attempt 2 in progress) is PENDING, never PASS on attempt 1; an Actions check run no job maps, beside a same-named failure, is ci_rerun_unverified; an incomplete jobs listing is ci_provider_incomplete', { skip: WIN_SKIP }, async (t) => {
  const h = await published(t);
  h.scriptCi(ciScript([cr(2, null)], [cr(1, 'failure'), cr(2, null)], [
    { id: 500, run_attempt: 2, jobs: { 1: [{ id: 1, name: 'test', conclusion: 'failure', check_run_id: 1 }], 2: [{ id: 2, name: 'test', status: 'in_progress', check_run_id: 2 }] } }]));
  assert.deepEqual([h.cli('ci').out.state, h.cli('ci').out.code], ['PENDING', 'ci_pending']);
  h.scriptCi(ciScript([cr(2, 'success')], [cr(1, 'failure'), cr(2, 'success')], [
    { id: 500, run_attempt: 1, jobs: { 1: [{ id: 1, name: 'test', conclusion: 'failure', check_run_id: 1 }] } }]));
  const u = h.cli('ci');
  assert.deepEqual([u.out.state, u.out.code], ['UNAVAILABLE', 'ci_rerun_unverified'], u.stdout);
  h.scriptCi(ciScript([cr(2, 'success')], [cr(1, 'failure'), cr(2, 'success')], [
    { id: 500, run_attempt: 2, jobsTotal: { 2: 5 }, jobs: { 1: [{ id: 1, name: 'test', conclusion: 'failure', check_run_id: 1 }], 2: [{ id: 2, name: 'test', conclusion: 'success', check_run_id: 2 }] } }]));
  const i = h.cli('ci');
  assert.deepEqual([i.out.state, i.out.code], ['UNAVAILABLE', 'ci_provider_incomplete'], i.stdout);
});

test('R5-3e the collection reads EVERY check run (filter=all), never the provider\'s opaque latest selection', () => {
  const calls = [];
  ghProvider({ repoRoot: '/nowhere', repository: { host: 'github.com', owner: 'acme', repo: 't-1', slug: 'github.com/acme/t-1' }, spawn: (...a) => { calls.push(a[1]); return { status: 1, stderr: 'x' }; } }).checkRuns('a'.repeat(40));
  assert.ok(calls[0].includes('filter=all') && !calls[0].includes('filter=latest'), JSON.stringify(calls[0]));
});
