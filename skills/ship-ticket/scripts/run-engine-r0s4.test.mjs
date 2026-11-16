/**
 * R0-S round 4: one recorded release-identity tuple, verified by ONE authority (engine-identity.mjs verifyReleaseBinding).
 * The first six tests are the exploits reproduced on ea6cc9b (pre-fix outcome in each title), kept as regressions. Then the strict
 * stage x mutated-field matrix (a LITERAL table of expected codes; every refusal is followed by its restore and the normal successful
 * step), the combined identity changes, E-a (replacement objects) and E-b (receipt execution ids).
 * STRICT review policy; the REAL engine CLI on temp repos with fakes only (engine-enroll.test-helper.mjs). Every PR here is SIMULATED
 * (the fake gh serves REST pulls from what `pr create` recorded, or a script): nothing here qualifies live GitHub behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, passReview } from './engine-test-fixture.mjs';
import { enrollFixture, GITHUB_URL } from './engine-enroll.test-helper.mjs';
import { verdict, ghProvider } from './engine-ci.mjs';
import { candidateId } from './engine-io.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const FORK_URL = 'https://github.com/evil/fork.git';
const GREEN = { checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'completed', conclusion: 'success', started_at: '2026-11-15T00:00:01.000Z', completed_at: '2026-11-15T00:00:09.000Z' }] }] };
/** A SIMULATED PR override (gh pr view vocabulary; the fake serves it as a REST pull). */
const PR = (fx, over = {}) => ({ number: 1, headRefOid: '$HEAD', headRefName: 'T-1-work', baseRefName: fx.base ?? fx.defaultBranch, state: 'OPEN', ...over });
const code = (r) => r.out?.code;
const body = (fx) => { const f = join(fx.root, 'pr-body.md'); writeFileSync(f, 'body'); return f; };
const publishPr = (fx, extra = {}) => fx.cli('publish', { 'pr-title': 'T-1: ship', 'pr-body-file': body(fx), ...extra });
const authorize = (fx, stage, extra = {}) => fx.cli('authorize', { stage, ...extra });
const unreviewed = (fx) => { writeFileSync(join(fx.repo, 'docs', 'wip.txt'), 'UNREVIEWED'); fx.okGit(['add', 'docs/wip.txt']); fx.okGit(['commit', '-q', '-m', 'unreviewed']); };
/** A second remote `fork` (another repository, the same kind of local bare behind a GitHub URL). */
const addFork = (fx) => {
  const fork = join(fx.root, 'fork.git');
  fx.okGit(['init', '-q', '--bare', fork], { cwd: fx.root });
  fx.okGit(['remote', 'add', 'fork', FORK_URL]);
  fx.okGit(['config', '--local', `url.${fork}.insteadOf`, FORK_URL]);
  fx.okGit(['push', '-q', 'fork', `${fx.defaultBranch}:refs/heads/${fx.defaultBranch}`]);
  fx.okGit(['--git-dir', fork, 'symbolic-ref', 'HEAD', `refs/heads/${fx.defaultBranch}`], { cwd: fx.root });
  return fork;
};
/** origin re-pointed at another repository (its URL; the bytes stay the same bare, so only the identity differs). */
const OTHER_URL = 'https://github.com/evil/other.git';
// --add: the fixture's own insteadOf (GITHUB_URL -> the local bare) must survive, or git would reach the network.
const toFork = (fx) => { fx.okGit(['config', '--local', '--add', `url.${fx.remote}.insteadOf`, OTHER_URL]); fx.okGit(['remote', 'set-url', 'origin', OTHER_URL]); };
const fromFork = (fx) => { fx.okGit(['remote', 'set-url', 'origin', GITHUB_URL]); fx.okGit(['config', '--local', '--unset', `url.${fx.remote}.insteadOf`, '^https://github\\.com/evil/other\\.git$']); };
/** A commit A on the base (local and remote) the branch is built on, so the remote base can be rewound to its parent c0. */
const baseWithA = (fx, ref) => {
  const c0 = fx.head();
  writeFileSync(join(fx.repo, 'docs', 'a.txt'), 'A on base');
  fx.okGit(['add', 'docs/a.txt']); fx.okGit(['commit', '-q', '-m', 'A']);
  const A = fx.head();
  if (ref !== fx.defaultBranch) fx.okGit(['branch', '-f', ref, A]);
  fx.okGit(['push', '-q', 'origin', `${A}:refs/heads/${ref}`]);
  return { c0, A, rewind: () => fx.okGit(['push', '-q', '-f', 'origin', `${c0}:refs/heads/${ref}`]), restore: () => fx.okGit(['push', '-q', '-f', 'origin', `${A}:refs/heads/${ref}`]) };
};

// ------------------------------------------------------------------ the six exploits of ea6cc9b, as regressions

test('X1 (pre-fix: published, gh pr create --base scratch): config.base HEAD, the local origin/HEAD symref repointed at an agent-pushed scratch branch; publish --base scratch is pr_base_unbound and the PR base stays the frozen default branch', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  unreviewed(h);
  const wip = h.head();
  await h.toShipReady();
  h.commitAll();
  h.okGit(['push', '-q', 'origin', `${wip}:refs/heads/scratch`]);
  h.okGit(['fetch', '-q', 'origin']);
  h.okGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/scratch']);
  assert.equal(code(publishPr(h, { base: 'scratch' })), 'pr_base_unbound');
  assert.equal(code(publishPr(h)), 'base_mismatch', 'measured against the frozen default branch on the remote: the unreviewed commit is under the range');
  assert.equal(h.remoteHead(), null, 'nothing pushed');
  assert.deepEqual(h.ghLog().filter(a => a[1] === 'create'), [], 'no PR opened');
  // A clean run: the REMOTE's own HEAD repointed after the freeze changes nothing (the ref was resolved once, at the freeze).
  const c = enrollFixture(t);
  await c.toShipReady();
  c.commitAll();
  c.okGit(['push', '-q', 'origin', `${c.defaultBranch}:refs/heads/scratch`]);
  c.okGit(['--git-dir', c.remote, 'symbolic-ref', 'HEAD', 'refs/heads/scratch'], { cwd: c.root });
  const p = publishPr(c);
  assert.deepEqual([code(p), p.out.base, p.out.pr?.base_ref], ['published', c.defaultBranch, c.defaultBranch], p.stdout);
  assert.equal(c.ghLog().find(a => a[1] === 'create')[c.ghLog().find(a => a[1] === 'create').indexOf('--base') + 1], c.defaultBranch);
});

test('X2 (pre-fix: published to github.com/evil/fork, CI from the fork, complete allow): config.base HEAD, publish --remote fork is identity_changed; nothing is published, collected or completed; the hook refuses a plain push to the fork', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  const fork = addFork(h);
  const p = publishPr(h, { remote: 'fork' });
  assert.equal(code(p), 'identity_changed', p.stdout);
  assert.equal(spawnSync('git', ['--git-dir', fork, 'rev-parse', '--verify', '--quiet', 'refs/heads/T-1-work'], { env: h.env }).status, 1, 'nothing pushed to the fork');
  h.scriptCi({ ...GREEN });
  assert.equal(code(h.cli('ci')), 'publish_evidence_missing');
  assert.equal(code(authorize(h, 'complete')), 'publish_evidence_missing');
  assert.equal(spawnSync(process.execPath, [GUARD, 'install', '--repo', h.repo], { encoding: 'utf8', env: h.env }).status, 0);
  const push = spawnSync('git', ['push', 'fork', 'T-1-work'], { cwd: h.repo, encoding: 'utf8', env: h.env });
  assert.notEqual(push.status, 0, 'E-e: the hook judges the actual push destination');
  assert.match(push.stderr, /identity_changed/);
  const ok = publishPr(h);
  assert.equal(code(ok), 'published', ok.stdout);
  assert.equal(ok.out.identity, 'github.com/acme/t-1');
});

test('X3 (pre-fix: complete allow after the remote base rewound): authorize complete is cumulative: base_moved_remote; restored, it allows', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t, { base: 'trunk' });
  h.base = 'trunk';
  const b = baseWithA(h, 'trunk');
  await h.toShipReady();
  h.commitAll();
  assert.equal(code(publishPr(h)), 'published');
  h.scriptCi({ ...GREEN });
  assert.equal(h.cli('ci').out.state, 'PASS');
  assert.equal(authorize(h, 'complete').out.allow, true);
  b.rewind();
  assert.equal(code(authorize(h, 'complete')), 'base_moved_remote');
  b.restore();
  assert.equal(authorize(h, 'complete').out.allow, true);
});

test('X4 (pre-fix: ci --pr 7 targeting staging gave PASS and complete allow): --pr must satisfy every PR row (pr_base_mismatch), a branch-only publication never completes (pr_required), and a bound PR is never replaced (publication_mismatch)', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  assert.equal(code(h.cli('publish')), 'published');
  h.scriptCi({ ...GREEN, pr: PR(h, { number: 7, baseRefName: 'staging' }) });
  const c = h.cli('ci', { pr: '7' });
  assert.deepEqual([c.out.state, c.out.code], ['UNAVAILABLE', 'pr_base_mismatch'], c.stdout);
  assert.equal(code(authorize(h, 'complete')), 'pr_required');
  h.scriptCi({ ...GREEN });
  assert.equal(code(publishPr(h)), 'published', 'pr null -> one verified PR: the one permitted change of a publication');
  assert.equal(h.cli('ci').out.state, 'PASS');
  assert.equal(authorize(h, 'complete').out.allow, true);
  assert.equal(h.cli('ci', { pr: '7' }).out.code, 'publication_mismatch');
  assert.equal(code(authorize(h, 'complete')), 'publication_mismatch', 'the latest evidence of this publication is the refusal: collect again');
  assert.equal(h.cli('ci').out.state, 'PASS');
  assert.equal(authorize(h, 'complete').out.allow, true);
});

test('X5 (pre-fix: republish without --pr-title recorded pr null and complete still allowed on the old PASS): a republish of a head re-verifies and keeps its PR (same publication_id); a closed PR is pr_state at publish and complete', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  assert.equal(code(publishPr(h)), 'published');
  h.scriptCi({ ...GREEN });
  assert.equal(h.cli('ci').out.state, 'PASS');
  const first = h.readState().published.at(-1);
  const again = h.cli('publish');
  assert.equal(code(again), 'published', again.stdout);
  assert.deepEqual([again.out.pr.number, again.out.publication_id], [1, first.publication_id], 'the same tuple: never PR -> null');
  assert.equal(h.ghLog().filter(a => a[1] === 'create').length, 1, 'never a second PR');
  assert.equal(authorize(h, 'complete').out.allow, true);
  h.scriptCi({ ...GREEN, pr: PR(h, { state: 'CLOSED' }) });
  const n = h.readState().published.length;
  assert.equal(code(h.cli('publish')), 'pr_state');
  assert.equal(h.readState().published.length, n, 'nothing recorded');
  assert.equal(code(authorize(h, 'complete')), 'pr_state');
});

test('X6 (pre-fix: PASS for both): every returned check run counts (filter=latest is GitHub\'s default and passed explicitly): overlapping same-name runs with one red, and ids 9/10, are FAIL', () => {
  const SHA = 'a'.repeat(40);
  const r = (id, c, s, e) => ({ id, name: 'test', head_sha: SHA, status: 'completed', conclusion: c, started_at: s, completed_at: e, app: 'github-actions', check_suite: 11 });
  const b = { sha: SHA, branch: 'T-1-work', windowMs: 0, dispatchMs: 0, collectedMs: 0 };
  assert.equal(verdict({ ...b, checks: [r(1, 'failure', '2026-11-15T00:00:01Z', '2026-11-15T00:00:30Z'), r(2, 'success', '2026-11-15T00:00:02Z', '2026-11-15T00:00:20Z')] }).state, 'FAIL');
  assert.equal(verdict({ ...b, checks: [r(9, 'success', '2026-11-15T00:00:01Z', 'x'), r(10, 'failure', '2026-11-15T00:00:01Z', 'x')] }).state, 'FAIL');
  const calls = [];
  ghProvider({ repoRoot: '/nowhere', repository: { host: 'github.com', owner: 'acme', repo: 't-1', slug: 'github.com/acme/t-1' }, spawn: (...a) => { calls.push(a[1]); return { status: 1, stderr: 'x' }; } }).checkRuns(SHA);
  assert.ok(calls[0].join(' ').includes('-f filter=latest'), J(calls[0]));
});

// ------------------------------------------------------------------ the strict stage x mutated-field matrix (literal)

/** [stage, field, mutate, restore, expected code]: after each restore the stage's normal step succeeds. */
const MATRIX = [
  // gate review (original): identity and the local base; success: review_accepted with the freeze base and execution id.
  ['review', 'identity (origin URL -> another repository)', toFork, fromFork, 'identity_changed'],
  ['review', 'merge base (local trunk moved onto a branch commit)', (fx) => { fx.okGit(['commit', '-q', '--allow-empty', '-m', 'e']); fx.okGit(['branch', '-f', 'trunk', 'HEAD']); },
    (fx) => fx.okGit(['branch', '-f', 'trunk', 'origin/trunk']), 'base_moved_local'],
  // gate ship-ready
  ['ship-ready', 'identity', toFork, fromFork, 'identity_changed'],
  ['ship-ready', 'freeze.base (record lost)', (fx) => fx.editState(S => { fx.saved = S.freeze.base; delete S.freeze.base; }), (fx) => fx.editState(S => { S.freeze.base = fx.saved; }), 'base_unverified'],
  ['ship-ready', 'base sha (remote base rewound)', (fx) => fx.b.rewind(), (fx) => fx.b.restore(), 'base_moved_remote'],
  // authorize publish (publish(), the hook and next call it)
  ['publish', 'identity', toFork, fromFork, 'identity_changed'],
  ['publish', 'push destination (--remote fork)', (fx) => { fx.extra = { remote: 'fork' }; }, (fx) => { fx.extra = {}; }, 'identity_changed'],
  ['publish', 'enrollment.identity (missing)', (fx) => fx.editState(S => { fx.saved = S.enrollment.identity; delete S.enrollment.identity; }), (fx) => fx.editState(S => { S.enrollment.identity = fx.saved; }), 'identity_unbound'],
  ['publish', 'ship_ready.base (missing)', (fx) => fx.editState(S => { fx.saved = S.ship_ready.base; delete S.ship_ready.base; }), (fx) => fx.editState(S => { S.ship_ready.base = fx.saved; }), 'base_unverified'],
  ['publish', 'base sha (remote base rewound)', (fx) => fx.b.rewind(), (fx) => fx.b.restore(), 'base_moved_remote'],
  ['publish', 'base ref (--base other)', (fx) => { fx.extra = { base: 'staging' }; }, (fx) => { fx.extra = {}; }, 'pr_base_unbound'],
  // ci (recorded as UNAVAILABLE evidence with the code)
  ['ci', 'gh pin (missing: no late pin)', (fx) => fx.editState(S => { fx.saved = S.enrollment.tools.gh; delete S.enrollment.tools.gh; }), (fx) => fx.editState(S => { S.enrollment.tools.gh = fx.saved; }), 'gh_unpinned'],
  ['ci', 'gh pin (other bytes)', (fx) => fx.editState(S => { fx.saved = S.enrollment.tools.gh.sha256; S.enrollment.tools.gh.sha256 = 'sha256:' + '0'.repeat(64); }), (fx) => fx.editState(S => { S.enrollment.tools.gh.sha256 = fx.saved; }), 'gh_drift'],
  ['ci', 'identity', toFork, fromFork, 'identity_changed'],
  ['ci', 'publication_id (missing)', (fx) => fx.editState(S => { fx.saved = S.published.at(-1).publication_id; delete S.published.at(-1).publication_id; }), (fx) => fx.editState(S => { S.published.at(-1).publication_id = fx.saved; }), 'identity_unbound'],
  ['ci', 'publication identity (edited)', (fx) => fx.editState(S => { S.published.at(-1).identity = 'github.com/evil/fork'; }), (fx) => fx.editState(S => { S.published.at(-1).identity = 'github.com/acme/t-1'; }), 'publication_mismatch'],
  ['ci', 'PR number (--pr other)', (fx) => { fx.extra = { pr: '9' }; }, (fx) => { fx.extra = {}; }, 'publication_mismatch'],
  ['ci', 'PR state (closed)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { state: 'CLOSED' }) }), (fx) => fx.scriptCi(GREEN), 'pr_state'],
  ['ci', 'PR base (retargeted)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { baseRefName: 'staging' }) }), (fx) => fx.scriptCi(GREEN), 'pr_base_mismatch'],
  ['ci', 'PR head repository (a fork)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { headRepo: 'evil/fork' }) }), (fx) => fx.scriptCi(GREEN), 'pr_repo_mismatch'],
  // authorize complete (cumulative; the PR read live)
  ['complete', 'identity', toFork, fromFork, 'identity_changed'],
  ['complete', 'enrollment.identity (missing)', (fx) => fx.editState(S => { fx.saved = S.enrollment.identity; delete S.enrollment.identity; }), (fx) => fx.editState(S => { S.enrollment.identity = fx.saved; }), 'identity_unbound'],
  ['complete', 'base sha (remote base rewound)', (fx) => fx.b.rewind(), (fx) => fx.b.restore(), 'base_moved_remote'],
  ['complete', 'gh pin (other bytes)', (fx) => fx.editState(S => { fx.saved = S.enrollment.tools.gh.sha256; S.enrollment.tools.gh.sha256 = 'sha256:' + '0'.repeat(64); }), (fx) => fx.editState(S => { S.enrollment.tools.gh.sha256 = fx.saved; }), 'gh_drift'],
  ['complete', 'publication_id (edited)', (fx) => fx.editState(S => { fx.saved = S.published.at(-1).publication_id; S.published.at(-1).publication_id = 'sha256:' + '1'.repeat(64); }), (fx) => fx.editState(S => { S.published.at(-1).publication_id = fx.saved; }), 'publication_mismatch'],
  ['complete', 'CI evidence of another publication', (fx) => fx.editState(S => { fx.saved = S.ci_evidence.at(-1).publication_id; S.ci_evidence.at(-1).publication_id = 'sha256:' + '2'.repeat(64); }), (fx) => fx.editState(S => { S.ci_evidence.at(-1).publication_id = fx.saved; }), 'publication_mismatch'],
  // cumulative: the publish conjunction itself is re-run (pre-fix authorize complete returned before it)
  ['complete', 'work tree (an uncommitted edit of a reviewed path)', (fx) => writeFileSync(join(fx.repo, 'src', 'a.txt'), 'edited after publish'),
    (fx) => fx.okGit(['checkout', '--', 'src/a.txt']), 'tree_dirty'],
  ['complete', 'review chain (a later FAIL accepted after publication)', (fx) => fx.editState(S => { S.review_chain.push({ review_execution: 'rx-9', kind: 'original', outcome: 'FAIL', candidate_id: 'x' }); }),
    (fx) => fx.editState(S => { S.review_chain.pop(); }), 'ship_ready_superseded'],
  ['complete', 'PR state (closed)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { state: 'CLOSED' }) }), (fx) => fx.scriptCi(GREEN), 'pr_state'],
  ['complete', 'PR state (merged)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { state: 'MERGED' }) }), (fx) => fx.scriptCi(GREEN), 'pr_state'],
  ['complete', 'PR base (retargeted)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { baseRefName: 'staging' }) }), (fx) => fx.scriptCi(GREEN), 'pr_base_mismatch'],
  ['complete', 'PR head repository (a fork)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { headRepo: 'evil/fork' }) }), (fx) => fx.scriptCi(GREEN), 'pr_repo_mismatch'],
  ['complete', 'PR base repository (another)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { baseRepo: 'evil/fork' }) }), (fx) => fx.scriptCi(GREEN), 'pr_repo_mismatch'],
  ['complete', 'PR head sha (moved)', (fx) => fx.scriptCi({ ...GREEN, pr: PR(fx, { headRefOid: 'f'.repeat(40) }) }), (fx) => fx.scriptCi(GREEN), 'pr_head_mismatch'],
];

/** The stage's step and whether it succeeded / its code. */
const STEP = {
  review: (fx) => { const g = fx.gate('review', passReview('rx-1', fx.candidate())); return { ok: g.out?.code === 'review_accepted', code: g.out?.code, out: g.stdout }; },
  'ship-ready': (fx) => { const g = fx.gate('ship-ready', {}); return { ok: g.out?.ok === true, code: g.out?.code, out: g.stdout }; },
  publish: (fx) => { const a = authorize(fx, 'publish', fx.extra); return { ok: a.out?.allow === true, code: a.out?.code, out: a.stdout }; },
  ci: (fx) => { const c = fx.cli('ci', fx.extra); return { ok: c.out?.state === 'PASS', code: c.out?.code, out: c.stdout }; },
  complete: (fx) => { const a = authorize(fx, 'complete'); return { ok: a.out?.allow === true, code: a.out?.code, out: a.stdout }; },
};

test('stage x mutated-field matrix (STRICT, config.base trunk): every mutation is refused with its literal code at its stage; restored, the normal step succeeds; the run then COMPLETES', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  fx.base = 'trunk';
  fx.b = baseWithA(fx, 'trunk');
  fx.extra = {};
  addFork(fx);
  fx.scriptCi(GREEN);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const seen = [];
  for (const stage of ['review', 'ship-ready', 'publish', 'ci', 'complete']) {
    if (stage === 'publish') fx.commitAll();
    if (stage === 'ci') assert.equal(code(publishPr(fx)), 'published');
    for (const [st, field, mutate, restore, want] of MATRIX.filter(r => r[0] === stage)) {
      mutate(fx);
      const r = STEP[st](fx);
      restore(fx);
      assert.deepEqual([r.ok, r.code], [false, want], `${st} / ${field}: ${r.out.slice(0, 600)}`);
      seen.push(`${st}:${want}`);
    }
    const ok = STEP[stage](fx);
    assert.equal(ok.ok, true, `${stage}: the normal step after every restore: ${ok.out.slice(0, 600)}`);
    if (stage === 'review') {
      const S = fx.readState();
      assert.deepEqual(Object.keys(S.freeze.base), ['remote', 'identity', 'ref', 'sha', 'merge_base']);
      assert.match(S.freeze.review_execution_id, /^rxe-/, 'the freeze carries the engine-minted execution id');
      assert.ok(S.review_dispatches.every(d => d.review_execution_id === S.freeze.review_execution_id && J(d.base) === J(S.freeze.base)), 'captured in each receipt BEFORE launch');
    }
  }
  assert.equal(seen.length, MATRIX.length);
  const n = fx.cli('next').out;
  assert.deepEqual([n.disposition, n.next_action.reason], ['COMPLETED', 'completed']);
});

test('the matrix in config.base HEAD mode: the base of record is the remote default branch (ls-remote --symref, frozen before launch); rewind, identity and PR rows refuse at publish and complete; the run completes', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  fx.b = baseWithA(fx, fx.defaultBranch);
  fx.extra = {};
  addFork(fx);
  fx.scriptCi(GREEN);
  await fx.toShipReady();
  assert.equal(fx.readState().freeze.base.ref, fx.defaultBranch);
  fx.commitAll();
  for (const [stage, field, mutate, restore, want] of MATRIX.filter(r => ['publish', 'complete'].includes(r[0]) && !/--base|missing/.test(r[1]))) {
    if (stage === 'complete' && !fx.readState().published) { assert.equal(code(publishPr(fx)), 'published'); assert.equal(fx.cli('ci').out.state, 'PASS'); }
    mutate(fx);
    const r = STEP[stage](fx);
    restore(fx);
    assert.deepEqual([r.ok, r.code], [false, want], `${stage} / ${field}: ${r.out.slice(0, 600)}`);
  }
  assert.equal(STEP.complete(fx).ok, true);
});

// ------------------------------------------------------------------ combined identity changes

test('combined: fork + republish (identity_changed both ways); symref repoint + base rewind (base_moved_remote on the frozen ref, never the repointed one); retarget + CI rerun (pr_base_mismatch at ci and complete)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  const b = baseWithA(fx, fx.defaultBranch);
  addFork(fx);
  fx.scriptCi(GREEN);
  await fx.toShipReady();
  fx.commitAll();
  // symref repoint + rewind before publish: the remote's HEAD now names scratch AND main is rewound
  fx.okGit(['push', '-q', 'origin', `${b.A}:refs/heads/scratch`]);
  fx.okGit(['--git-dir', fx.remote, 'symbolic-ref', 'HEAD', 'refs/heads/scratch'], { cwd: fx.root });
  b.rewind();
  assert.equal(code(authorize(fx, 'publish')), 'base_moved_remote', 'judged on the frozen ref (main), never the repointed default');
  b.restore();
  const a = authorize(fx, 'publish');
  assert.deepEqual([a.out.allow, a.out.binding.base], [true, fx.defaultBranch]);
  assert.equal(code(publishPr(fx)), 'published');
  assert.equal(fx.cli('ci').out.state, 'PASS');
  // a second publication of this head that differs from the recorded tuple is refused before any push (A1/A7)
  const pid = fx.readState().published.at(-1).publication_id;
  fx.editState(S => { S.published.at(-1).publication_id = 'sha256:' + '3'.repeat(64); });
  assert.equal(code(fx.cli('publish')), 'publication_mismatch');
  fx.editState(S => { S.published.at(-1).publication_id = pid; });
  // fork + republish
  assert.equal(code(fx.cli('publish', { remote: 'fork' })), 'identity_changed');
  toFork(fx);
  assert.equal(code(fx.cli('publish')), 'identity_changed');
  assert.equal(code(authorize(fx, 'complete')), 'identity_changed');
  fromFork(fx);
  assert.equal(code(fx.cli('publish')), 'published');
  assert.equal(authorize(fx, 'complete').out.allow, true);
  // retarget + CI rerun
  fx.scriptCi({ ...GREEN, pr: PR(fx, { baseRefName: 'scratch' }) });
  const c = fx.cli('ci');
  assert.deepEqual([c.out.state, c.out.code], ['UNAVAILABLE', 'pr_base_mismatch']);
  assert.equal(code(authorize(fx, 'complete')), 'pr_base_mismatch');
  fx.scriptCi(GREEN);
  assert.equal(code(authorize(fx, 'complete')), 'pr_base_mismatch', 'the PR is right again, but the latest evidence of this publication is the refusal');
  assert.equal(fx.cli('ci').out.state, 'PASS');
  assert.equal(authorize(fx, 'complete').out.allow, true);
});

test('combined E-b: execution replay after an owner RETRY (pre-fix: an unconsumed receipt of the earlier execution was accepted as the RETRY review) is review_receipt_execution; a fresh dispatch of the RETRY execution is accepted', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const c1 = fx.candidate();
  const { second_opinion: _s, ...primaryOnly } = passReview('rx-1', c1);
  const first = fx.engineReview(primaryOnly);
  assert.equal(first.dispatched[0].code, 'review_dispatched');
  writeFileSync(join(fx.repo, 'src', 'b.txt'), 'second candidate');
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).out.code, 'review_accepted');
  const E1 = fx.readState().freeze.review_execution_id;
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  rmSync(join(fx.repo, 'src', 'b.txt'));
  assert.equal(fx.candidate(), c1);
  // The primary slot is the c1 receipt of execution E1 (unconsumed, same content); only the second opinion is dispatched for rx-2.
  const { primary: _p, ...secondOnly } = passReview('rx-2', c1);
  const sec = fx.engineReview(secondOnly);
  assert.equal(sec.dispatched[0].code, 'review_dispatched');
  const replay = fx.gate('review', { ...passReview('rx-2', c1), primary: first.input.primary, second_opinion: sec.input.second_opinion }, { raw: true });
  assert.equal(replay.out.code, 'review_receipt_execution', replay.stdout);
  const S = fx.readState();
  const open = S.review_executions.find(x => x.review_execution === 'rx-2');
  assert.ok(open && open.id !== E1, 'the RETRY has its own execution id');
  const n = fx.cli('next').out;
  assert.equal(n.next_action.stage, 'REVIEW');
  const fresh = fx.gate('review', { ...passReview('rx-2', c1), second_opinion: sec.input.second_opinion });
  assert.equal(fresh.out.code, 'review_accepted', fresh.stdout);
  assert.equal(fx.readState().freeze.review_execution_id, open.id);
});

// ------------------------------------------------------------------ E-a: replacement objects

test('E-a: a `git replace` of the base commit never changes the candidate (authoritative git runs with --no-replace-objects)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r0s4-replace-'));
  try {
    const g = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    g('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a');
    g('add', '.'); g('commit', '-q', '-m', 'c0');
    const c0 = g('rev-parse', 'HEAD');
    g('branch', 'trunk');
    writeFileSync(join(dir, 'secret.txt'), 'token');
    g('add', '.'); g('commit', '-q', '-m', 'c1 adds secret');
    const fake = g('commit-tree', 'HEAD^{tree}', '-m', 'fake base carrying the secret');
    g('replace', c0, fake);
    const replaced = spawnSync('git', ['diff', '--name-only', 'trunk', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    assert.equal(replaced, '', 'with the replacement git itself no longer sees secret.txt as a change (the attack works on plain git)');
    const c = candidateId(dir, 'trunk', []);
    assert.deepEqual([c.merge_base, c.paths], [c0, ['secret.txt']], J(c));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
