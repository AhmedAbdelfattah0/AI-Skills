/**
 * P0 slice E6-min: exact-head CI evidence (engine-ci.mjs, run-engine.mjs ci, authorize complete, the CI stage of
 * next). Deterministic: in-process collections use a fake provider object (ctx.ciProvider) and the test clock
 * (ctx.now); CLI collections use the fixture's fake `gh` on PATH (engine-enroll.test-helper.mjs), which serves
 * scripted JSON and exits 1 on any unscripted call. The real `gh` is never run. Every verdict and authorize check
 * is load-bearing: omitting any one changes a pinned outcome (mutation tests).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { POSIX } from './engine-test-fixture.mjs';
import { enrollFixture, GITHUB_SLUG } from './engine-enroll.test-helper.mjs';
import { ci } from './run-engine.mjs';
import { validateEngineDag } from './engine-dag.mjs';
import { verdict, ciAuthorize, parseCheckRuns, parseTriggers, globRe, filterVerdict, workflowDiagnostic, prNumberOf, ghProvider,
  VERDICT_CHECKS, AUTHORIZE_CHECKS, DEFAULT_NO_CHECKS_MINUTES } from './engine-ci.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const MIN = 60000;

// ------------------------------------------------------------------ the pure verdict

const run = (name, status, conclusion = null, over = {}) => ({ id: name, name, head_sha: SHA, status, conclusion,
  started_at: '2026-11-15T00:00:01.000Z', completed_at: status === 'completed' ? '2026-11-15T00:00:09.000Z' : null, ...over });
const V = (over = {}) => ({ sha: SHA, branch: 'T-1-work', checks: [run('test', 'completed', 'success')], required: undefined,
  windowMs: 5 * MIN, dispatchMs: 0, collectedMs: 10 * MIN, pr: null, ...over });

/** [name, input, [state, code]] — together they exercise every verdict check. */
const VERDICTS = [
  ['all green on the published head', V(), ['PASS', 'ci_passed']],
  ['the PR head moved past the published head', V({ pr: { number: 1, head_sha: OTHER, head_branch: 'T-1-work' } }), ['STALE', 'ci_head_moved']],
  ['the PR is another branch', V({ pr: { number: 1, head_sha: SHA, head_branch: 'other' } }), ['STALE', 'ci_pr_mismatch']],
  ['only a stale SHA is green', V({ checks: [run('test', 'completed', 'success', { head_sha: OTHER })] }), ['NO_CHECKS', 'ci_no_checks']],
  ['zero check runs inside the window', V({ checks: [], collectedMs: 2 * MIN }), ['PENDING', 'ci_no_checks_yet']],
  ['zero check runs after the window', V({ checks: [] }), ['NO_CHECKS', 'ci_no_checks']],
  ['a red check', V({ checks: [run('test', 'completed', 'success'), run('lint', 'completed', 'failure')] }), ['FAIL', 'ci_failed']],
  ['skipped is not success', V({ checks: [run('test', 'completed', 'skipped')] }), ['FAIL', 'ci_failed']],
  ['a check still running', V({ checks: [run('test', 'completed', 'success'), run('lint', 'in_progress')] }), ['PENDING', 'ci_pending']],
  // R0-S round 4 (D5): GitHub's check-runs `filter` defaults to `latest` (and the adapter passes it): a RETURNED red run is never erased by a
  // same-named success, whatever the start times or ids (pre-fix the engine collapsed them and a red run disappeared).
  ['a returned red run is not superseded by a later same-named success', V({ checks: [run('test', 'completed', 'failure', { id: 1 }), run('test', 'completed', 'success', { id: 2, started_at: '2026-11-15T00:01:00.000Z' })] }),
    ['FAIL', 'ci_failed']],
  ['a required check never started, inside the window', V({ required: ['build'], collectedMs: MIN }), ['PENDING', 'ci_required_pending']],
  ['a required check never ran, after the window', V({ required: ['build'] }), ['NO_CHECKS', 'ci_required_missing']],
  // R0-S: a configured set narrows what must PASS, never what may fail; a skipped check outside it is not a failure.
  ['a red check outside the required set still fails the head', V({ required: ['test'], checks: [run('test', 'completed', 'success'), run('bot', 'completed', 'failure')] }), ['FAIL', 'ci_failed']],
  ['a skipped check outside the required set does not block', V({ required: ['test'], checks: [run('test', 'completed', 'success'), run('bot', 'completed', 'skipped')] }), ['PASS', 'ci_passed']],
  ['a same-named check of another app or workflow is independent, never a re-run', V({ checks: [run('test', 'completed', 'failure', { id: 1, app: 'github-actions', check_suite: 11 }),
    run('test', 'completed', 'success', { id: 2, app: 'circleci', check_suite: 22, started_at: '2026-11-15T00:01:00.000Z' })] }), ['FAIL', 'ci_failed']],
  ['two returned runs of one name in one check suite: the red one fails the head (overlapping jobs, pre-fix PASS)', V({ checks: [run('test', 'completed', 'failure', { id: 1, app: 'github-actions', check_suite: 11, completed_at: '2026-11-15T00:00:30.000Z' }),
    run('test', 'completed', 'success', { id: 2, app: 'github-actions', check_suite: 11, started_at: '2026-11-15T00:00:02.000Z', completed_at: '2026-11-15T00:00:20.000Z' })] }), ['FAIL', 'ci_failed']],
  ['ids 9 and 10 with the same start: no ordering by id (pre-fix "9" > "10" as strings gave PASS)', V({ checks: [run('test', 'completed', 'success', { id: 9 }), run('test', 'completed', 'failure', { id: 10 })] }), ['FAIL', 'ci_failed']],
  ['the remote branch moved past the published head (no PR)', V({ remoteHead: OTHER }), ['STALE', 'ci_remote_moved']],
];

test('verdict: every scenario yields its pinned state and code; PASS needs >=1 required check, all success, on exactly the published head', () => {
  for (const [name, input, want] of VERDICTS) {
    const v = verdict(input);
    assert.deepEqual([v.state, v.code], want, name);
    if (v.state !== 'PASS') assert.ok(v.reasons.length > 0, `${name}: a non-PASS carries reasons`);
  }
  const v = verdict(V({ checks: [run('test', 'completed', 'success'), run('lint', 'completed', 'success', { started_at: '2026-11-15T00:00:00.500Z', completed_at: '2026-11-15T00:00:20.000Z' })] }));
  assert.deepEqual(v.timing, { first_check_started_at: '2026-11-15T00:00:00.500Z', checks_completed_at: '2026-11-15T00:00:20.000Z' }, 'first start and completion are captured separately');
  assert.equal(verdict(V({ checks: [run('t', 'completed', 'success', { head_sha: OTHER })] })).ignored_other_sha, 1);
});

test('mutation: omitting any verdict check changes a pinned verdict, and each omission lets a non-PASS through as PASS', () => {
  for (const id of VERDICT_CHECKS) {
    const flipped = VERDICTS.filter(([, input, want]) => want[0] !== 'PASS' && verdict(input, { omit: [id] }).state === 'PASS').map(([n]) => n);
    assert.ok(flipped.length > 0, `omitting ${id} must let some non-PASS scenario pass (it is an enforcement)`);
  }
});

// ------------------------------------------------------------------ authorize complete's CI condition

const PUB = { head: SHA, branch: 'T-1-work', at: '2026-11-15T00:00:00.000Z' };
const EV = (over = {}) => ({ head_sha: SHA, state: 'PASS', code: 'ci_passed', reasons: [], remote_head: SHA, checks: [run('test', 'completed', 'success')], ...over });
const unverified = () => { const e = EV(); delete e.remote_head; return e; };
const AUTHS = [
  ['no evidence', { ci_evidence: [] }, 'ci_evidence_missing'],
  ['evidence of another head only', { ci_evidence: [EV({ head_sha: OTHER })] }, 'ci_evidence_missing'],
  ['latest is PENDING', { ci_evidence: [EV(), EV({ state: 'PENDING', code: 'ci_pending', reasons: ['r'], checks: [run('test', 'in_progress')] })] }, 'ci_pending'],
  ['NO_CHECKS', { ci_evidence: [EV({ state: 'NO_CHECKS', code: 'ci_no_checks', reasons: ['r'], checks: [] })] }, 'ci_no_checks'],
  ['state PASS but a recorded check is red', { ci_evidence: [EV({ checks: [run('test', 'completed', 'failure')] })] }, 'ci_evidence_inconsistent'],
  ['state PASS with no recorded check', { ci_evidence: [EV({ checks: [] })] }, 'ci_evidence_inconsistent'],
  ['PASS recorded before the bound config named a required check', { config: { ciRequiredChecks: ['build'] }, ci_evidence: [EV()] }, 'ci_evidence_inconsistent'],
  ['PASS whose recorded PR head moved', { ci_evidence: [EV({ pr_view: { number: 1, head_sha: OTHER, head_branch: 'T-1-work' } })] }, 'ci_evidence_inconsistent'],
  ['PASS that never verified the branch head (no PR, no remote read)', { ci_evidence: [unverified()] }, 'ci_head_unverified'],
  ['PASS whose recorded remote branch had moved (the PR head matched)', { ci_evidence: [EV({ remote_head: OTHER, pr_view: { number: 1, head_sha: SHA, head_branch: 'T-1-work' } })] }, 'ci_evidence_inconsistent'],
  ['evidence of another publication of the same head (round 4: publication_id)', { ci_evidence: [EV({ publication_id: 'sha256:another-publication' })] }, 'publication_mismatch'],
  ['PASS', { ci_evidence: [EV()] }, 'allow'],
];
const authCode = (S, opts) => { const r = ciAuthorize({ config: {}, ...S }, PUB, opts); return r.ok ? 'allow' : r.code; };

test('authorize complete (CI): only the latest evidence of the published head counts, and its checks are re-judged under the bound config', () => {
  for (const [name, S, want] of AUTHS) assert.equal(authCode(S), want, name);
});

test('mutation: omitting any authorize-complete CI check changes a pinned outcome; omitting all of them would allow a red head', () => {
  for (const id of AUTHORIZE_CHECKS) {
    const changed = AUTHS.filter(([, S, want]) => authCode(S, { omit: [id] }) !== want).map(([n]) => n);
    assert.ok(changed.length > 0, `omitting ${id} changes nothing`);
  }
  assert.equal(authCode({ ci_evidence: [EV({ state: 'FAIL', code: 'ci_failed', checks: [run('test', 'completed', 'failure')] })] }, { omit: [...AUTHORIZE_CHECKS] }), 'allow',
    'the checks are the whole enforcement (sanity of the mutation)');
});

// ------------------------------------------------------------------ provider parsing and the DETECTED diagnostic

test('parseCheckRuns: page totals must add up; non-JSON or a missing total is a provider failure, never zero checks', () => {
  const ok = parseCheckRuns(`${J({ total_count: 1 })}\n${J({ id: 1, name: 't', head_sha: SHA, status: 'completed', conclusion: 'success' })}\n`);
  assert.deepEqual([ok.ok, ok.runs.length, ok.total], [true, 1, 1]);
  assert.deepEqual([parseCheckRuns(J({ total_count: 0 })).ok, parseCheckRuns(J({ total_count: 0 })).runs], [true, []]);
  assert.equal(parseCheckRuns(`${J({ total_count: 3 })}\n${J({ id: 1, name: 't' })}`).code, 'ci_provider_incomplete');
  assert.equal(parseCheckRuns('not json').code, 'ci_provider_unavailable');
  assert.equal(parseCheckRuns('').code, 'ci_provider_unavailable', 'an empty answer has no total: never read as zero checks');
  assert.deepEqual([prNumberOf('https://github.com/o/r/pull/12'), prNumberOf('https://example.invalid/pr/1'), prNumberOf('x')], [12, 1, null]);
});

test('ghProvider: an invalid SHA is never interpolated; a gh failure is ci_provider_unavailable (spawn seam, no gh run)', () => {
  const calls = [];
  const repository = { host: 'github.com', owner: 'acme', repo: 't-1', slug: 'github.com/acme/t-1' };
  const p = ghProvider({ repoRoot: '/nowhere', repository, env: { GH_REPO: 'evil/fork', GH_HOST: 'evil.example', GITHUB_TOKEN: 'x', PATH: '/bin' },
    spawn: (...a) => { calls.push(a); return { status: 1, stderr: 'HTTP 401' }; } });
  assert.equal(ghProvider({ repoRoot: '/nowhere', spawn: () => assert.fail('no repository: never spawned') }).checkRuns(SHA).code, 'ci_repo_unknown');
  assert.equal(p.checkRuns('HEAD; rm -rf /').code, 'ci_provider_unavailable');
  assert.equal(calls.length, 0, 'refused before any spawn');
  const r = p.checkRuns(SHA);
  assert.deepEqual([r.ok, r.code, r.error], [false, 'ci_provider_unavailable', 'HTTP 401']);
  assert.deepEqual(calls[0].slice(0, 1), ['gh']);
  assert.ok(calls[0][1].includes(`repos/acme/t-1/commits/${SHA}/check-runs`), J(calls[0][1]));
  assert.deepEqual(calls[0][1].slice(-2), ['--hostname', 'github.com'], 'the host is explicit');
  assert.deepEqual(Object.keys(calls[0][2].env).filter(k => /^(GH|GITHUB)_/.test(k)), ['GH_PROMPT_DISABLED'], 'every GH_/GITHUB_ selector and token is stripped');
  assert.equal(p.pullRequest(3).code, 'ci_provider_unavailable');
});

test('workflow triggers (DETECTED heuristic): on: forms, branch and path filters, globs', () => {
  assert.deepEqual(parseTriggers('name: x\non: push\njobs: {}\n'), { push: {} });
  assert.deepEqual(parseTriggers('on: [push, pull_request]\n'), { push: {}, pull_request: {} });
  assert.deepEqual(parseTriggers('on:\n  - push\n  - workflow_dispatch\njobs:\n'), { push: {}, workflow_dispatch: {} });
  assert.deepEqual(parseTriggers([
    'on:', '  push:', '    branches: [main]', '    paths-ignore:', "      - 'docs/**'", '      - "*.md"  # prose', '  pull_request:', '    types: [opened]', '    paths:', '      - src/**',
    'jobs:', '  a: {}'].join('\n')),
  { push: { branches: ['main'], 'paths-ignore': ['docs/**', '*.md'] }, pull_request: { types: ['opened'], paths: ['src/**'] } });
  assert.equal(parseTriggers('jobs: {}\n'), null);
  assert.ok(globRe('docs/**').test('docs/a/b.md') && !globRe('*.md').test('docs/a.md') && globRe('**/*.md').test('a.md') && globRe('src/?.js').test('src/a.js'));
  assert.deepEqual(filterVerdict({ 'paths-ignore': ['docs/**'] }, 'T-1', ['docs/a.md']).would_trigger, false);
  assert.deepEqual(filterVerdict({ 'paths-ignore': ['docs/**'] }, 'T-1', ['docs/a.md', 'src/a.js']).would_trigger, true);
  assert.deepEqual(filterVerdict({ paths: ['src/**', '!src/gen/**'] }, 'T-1', ['src/gen/x.js']).would_trigger, false);
  assert.deepEqual(filterVerdict({ branches: ['main'] }, 'T-1-work', ['src/a.js']).would_trigger, false);
  assert.deepEqual(filterVerdict({ 'branches-ignore': ['T-*'] }, 'T-1-work', []).would_trigger, false);
  assert.deepEqual(filterVerdict({}, 'T-1', null).would_trigger, true);
  assert.deepEqual(filterVerdict({ paths: ['src/**'] }, 'T-1', null).would_trigger, null, 'unknown changed files: no claim');
});

test('workflowDiagnostic reads the workflows at the published head against the files changed since the merge base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wf-'));
  try {
    const g = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    g('init', '-q');
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), "on:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\njobs: {}\n");
    writeFileSync(join(dir, '.github', 'workflows', 'odd.yaml'), 'jobs: {}\n');
    g('add', '.'); g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), 'x');
    g('add', '.'); g('commit', '-q', '-m', 'docs only');
    const d = workflowDiagnostic(dir, { head: g('rev-parse', 'HEAD'), mergeBase: base, branch: 'T-1-work', prBase: 'main' });
    assert.deepEqual(d.changed_files, ['docs/a.md']);
    assert.deepEqual(d.workflows.map(w => [w.file, w.parsed, w.pull_request?.would_trigger ?? null]),
      [['.github/workflows/ci.yml', true, false], ['.github/workflows/odd.yaml', false, null]], J(d));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DAG config: ciRequiredChecks and ciNoChecksMinutes are validated and never defaulted', () => {
  const doc = (c) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, ...c }, nodes: [{ id: 'a', promptFile: 'p.md' }] });
  for (const c of [{ ciRequiredChecks: [] }, { ciRequiredChecks: ['a', 'a'] }, { ciRequiredChecks: [''] }, { ciRequiredChecks: 'a' }, { ciNoChecksMinutes: 0 }, { ciNoChecksMinutes: 1.5 }, { ciNoChecksMinutes: 121 }])
    assert.throws(() => validateEngineDag(doc(c), { ticket: 'T-1' }), (e) => e.code === 'dag_invalid', J(c));
  const ok = validateEngineDag(doc({ ciRequiredChecks: ['build', 'test'], ciNoChecksMinutes: 10 }), { ticket: 'T-1' });
  assert.deepEqual([ok.config.ciRequiredChecks, ok.config.ciNoChecksMinutes], [['build', 'test'], 10]);
  const plain = validateEngineDag(doc({}), { ticket: 'T-1' }).config;
  assert.ok(!('ciRequiredChecks' in plain) && !('ciNoChecksMinutes' in plain), 'absent stays absent (the DAG digest covers it only when set)');
  assert.equal(DEFAULT_NO_CHECKS_MINUTES, 5);
});

// ------------------------------------------------------------------ the engine command (in-process fake provider)

/** A fake provider whose answers the test changes between collections; `calls` records every request. */
function fakeProvider() {
  const w = { runs: [], pr: null, fail: null, recent: [{ id: 9, head_sha: OTHER, status: 'completed', conclusion: 'success', event: 'push', workflow: 'ci', created_at: 't' }], calls: [] };
  w.provider = { name: 'fake',
    checkRuns: (sha) => { w.calls.push(['checkRuns', sha]); return w.fail ? { ok: false, code: 'ci_provider_unavailable', error: w.fail } : { ok: true, runs: w.runs.map(r => ({ ...r, head_sha: r.head_sha === '$SHA' ? sha : r.head_sha })), total: w.runs.length }; },
    // The engine's PR view (engine-ci.mjs prFromRest shape; SIMULATED): repositories default to the fixture's, state lower-cased.
    pullRequest: (n) => { w.calls.push(['pr', n]); return w.pr ? { ok: true, pr: { number: n, merged: false, head_repo: GITHUB_SLUG, base_repo: GITHUB_SLUG, ...w.pr,
      head_ref: w.pr.head_branch, base_ref: w.pr.base, state: String(w.pr.state ?? 'OPEN').toLowerCase() } } : { ok: false, code: 'ci_provider_unavailable', error: 'no such PR' }; },
    recentRuns: (b) => { w.calls.push(['recentRuns', b]); return { ok: true, runs: w.recent }; } };
  return w;
}

/** A published run (ship-ready, committed, pushed by run-engine.mjs publish without a PR). */
function published(t, opts) {
  const fx = enrollFixture(t, opts);
  fx.toShipReady();
  fx.commitAll();
  const p = fx.cli('publish');
  assert.equal(p.out?.code, 'published', p.stdout + p.stderr);
  return fx;
}
const pubAt = (fx) => Date.parse(fx.readState().published.at(-1).at);
const collectAt = (fx, w, minutes, extra = {}) => ci({ ...fx.ctx(), ciProvider: w.provider, now: () => new Date(pubAt(fx) + minutes * MIN).toISOString(), ...extra });
const complete = (fx) => fx.cli('authorize', { stage: 'complete' });
const nextCi = (fx) => { const n = fx.cli('next').out; return [n.next_action.stage, n.disposition, n.next_action.reason, n.next_action.action]; };
const R = (name, status, conclusion = null) => run(name, status, conclusion, { head_sha: '$SHA' });

test('ci refuses with a reason code and records nothing: before publish, without the ship context, on binding drift, on a moved HEAD; bad --pr', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  const w = fakeProvider();
  fx.toShipReady();
  fx.commitAll();
  const before = await ci({ ...fx.ctx(), ciProvider: w.provider });
  assert.deepEqual([before.recorded, before.code], [false, 'publish_evidence_missing'], 'nothing published');
  assert.equal(fx.cli('publish').out.code, 'published');
  const ship = fx.readState().contexts.ship;
  fx.editState(S => { delete S.contexts.ship; });
  assert.deepEqual([(await ci({ ...fx.ctx(), ciProvider: w.provider })).code], ['context_missing'], 'no ship context: no evidence');
  fx.editState(S => { S.contexts.ship = ship; });
  const dag = readFileSync(fx.dagFile, 'utf8');
  writeFileSync(fx.dagFile, dag + ' ');
  assert.equal((await ci({ ...fx.ctx(), ciProvider: w.provider })).code, 'dag_mismatch', 'binding drift: no evidence');
  writeFileSync(fx.dagFile, dag);
  writeFileSync(join(fx.repo, 'session-log.md'), 'after publish');
  fx.okGit(['add', 'session-log.md']);
  fx.okGit(['commit', '-q', '-m', 'unpublished head']);
  assert.equal((await ci({ ...fx.ctx(), ciProvider: w.provider })).code, 'publish_evidence_missing', 'HEAD is not the published head');
  assert.equal(complete(fx).out.code, 'publish_evidence_missing');
  assert.deepEqual([w.calls, fx.readState().ci_evidence ?? []], [[], []], 'no refusal asked the provider or recorded evidence');
  await assert.rejects(ci({ ...fx.ctx(), ciProvider: w.provider, pr: 0 }), (e) => e.code === 'bad_input');
  const usage = fx.cli('ci', { pr: 'abc' });
  assert.equal(usage.status, 1, usage.stderr);
});

test('ci: exact-head evidence through PENDING, NO_CHECKS (with diagnostic), stale SHA, provider failure, FAIL and PASS; authorize complete and next follow the latest record', { skip: WIN_SKIP }, async (t) => {
  const fx = published(t);
  const w = fakeProvider();
  const head = fx.head();
  assert.deepEqual(nextCi(fx), ['CI', 'READY', 'ci_owed', 'collect_ci']);
  // Round 4: a branch-only publication never completes (pr_required); the CI evidence below is still collected and judged per publication.
  assert.equal(complete(fx).out.code, 'pr_required');

  let e = await collectAt(fx, w, 1);
  assert.deepEqual([e.recorded, e.head_sha, e.state, e.code], [true, head, 'PENDING', 'ci_no_checks_yet'], 'zero checks inside the window');
  assert.deepEqual(w.calls, [['checkRuns', head]], 'asked for exactly the published head; no PR known, so no PR view');
  assert.deepEqual(nextCi(fx), ['CI', 'WAITING', 'ci_no_checks_yet', 'collect_ci']);
  assert.equal(complete(fx).out.code, 'pr_required');

  w.runs = [run('test', 'completed', 'success', { head_sha: OTHER })];
  e = await collectAt(fx, w, DEFAULT_NO_CHECKS_MINUTES + 1);
  assert.deepEqual([e.state, e.code, e.ignored_other_sha, e.checks], ['NO_CHECKS', 'ci_no_checks', 1, []], 'a green stale SHA is never success');
  assert.deepEqual(e.diagnostic.pr, { number: null, reason: 'no PR recorded for this publish: pass --pr <n>' });
  assert.equal(e.diagnostic.workflow_filters.ok, true);
  assert.match(e.diagnostic.workflow_filters.reason, /no workflow file/);
  assert.deepEqual(e.diagnostic.recent_runs, w.recent);
  assert.match(e.diagnostic.label, /^DETECTED/);
  const n = fx.cli('next').out;
  assert.deepEqual([n.next_action.stage, n.disposition, n.next_action.reason, n.next_action.owner], ['CI', 'BLOCKED', 'ci_no_checks', 'human']);
  assert.deepEqual(n.next_action.diagnostic.recent_runs, w.recent, 'next carries the diagnostic');
  assert.equal(complete(fx).out.code, 'pr_required');

  w.fail = 'HTTP 502';
  e = await collectAt(fx, w, 7);
  assert.deepEqual([e.state, e.code, e.reasons], ['UNAVAILABLE', 'ci_provider_unavailable', ['HTTP 502']]);
  assert.deepEqual(nextCi(fx), ['CI', 'BLOCKED', 'ci_provider_unavailable', 'collect_ci']);
  assert.equal(complete(fx).out.code, 'pr_required');
  w.fail = null;

  w.runs = [R('test', 'completed', 'success'), R('lint', 'completed', 'failure')];
  e = await collectAt(fx, w, 8);
  assert.deepEqual([e.state, e.code, e.failed], ['FAIL', 'ci_failed', ['lint']]);
  assert.deepEqual(nextCi(fx), ['CI', 'FAILED', 'ci_failed', 'none']);
  assert.equal(complete(fx).out.code, 'pr_required');

  w.runs = [R('test', 'completed', 'success'), { ...R('lint', 'in_progress'), id: 'lint-2', started_at: '2026-11-15T00:05:00.000Z' }];
  e = await collectAt(fx, w, 9);
  assert.deepEqual([e.state, e.code], ['PENDING', 'ci_pending'], 'the re-run of lint is running');
  assert.deepEqual(nextCi(fx), ['CI', 'WAITING', 'ci_pending', 'collect_ci']);

  w.runs = [R('test', 'completed', 'success'), { ...R('lint', 'completed', 'success'), id: 'lint-2', started_at: '2026-11-15T00:05:00.000Z', completed_at: '2026-11-15T00:06:00.000Z' }];
  e = await collectAt(fx, w, 10);
  assert.deepEqual([e.state, e.code, e.required, e.required_source], ['PASS', 'ci_passed', ['test', 'lint'], 'all_on_sha']);
  assert.deepEqual(e.timing, { dispatched_at: fx.readState().published.at(-1).at, first_check_started_at: '2026-11-15T00:00:01.000Z',
    checks_completed_at: '2026-11-15T00:06:00.000Z', collected_at: new Date(pubAt(fx) + 10 * MIN).toISOString() }, 'dispatch, first start, completion, collection: separately');
  assert.equal(complete(fx).out.code, 'pr_required', 'PASS of a branch-only publication: never COMPLETE');
  // Bind the PR (ci --pr: the one permitted change, pr null -> a verified PR; SIMULATED PR view): a NEW publication_id, so the PASS above
  // (of the branch-only publication) does not count until collected for it.
  w.pr = { head_sha: head, head_branch: 'T-1-work', base: fx.defaultBranch, mergeable: 'MERGEABLE', merge_state: 'CLEAN', state: 'OPEN' };
  e = await collectAt(fx, w, 10, { pr: 1 });
  assert.deepEqual([e.state, e.pr], ['PASS', 1]);
  assert.equal(fx.readState().published.at(-1).pr.number, 1);
  assert.notEqual(fx.readState().published.at(-1).publication_id, fx.readState().published.at(-2).publication_id);
  // authorize complete (CLI) reads the PR LIVE through the pinned (fake) gh: the SIMULATED REST pull of PR #1.
  fx.scriptCi({ pr: { number: 1, headRefOid: '$HEAD', headRefName: 'T-1-work', baseRefName: fx.defaultBranch, state: 'OPEN' } });
  const a = complete(fx);
  assert.equal(a.status, 0, a.stdout);
  assert.deepEqual([a.out.allow, a.out.binding.head, a.out.binding.ci.state, a.out.binding.pr], [true, head, 'PASS', 1]);
  assert.deepEqual(nextCi(fx), [null, 'COMPLETED', 'completed', 'none']);

  // The engine log carries each collection; RUN-STATE never does.
  const log = readFileSync(fx.engineLog(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.event === 'CI_EVIDENCE');
  assert.deepEqual(log.map(x => x.state), ['PENDING', 'NO_CHECKS', 'UNAVAILABLE', 'FAIL', 'PENDING', 'PASS', 'PASS']);
  assert.ok(log.every(x => x.head_sha === head && x.timing?.dispatched_at));
  assert.doesNotMatch(readFileSync(fx.planFile, 'utf8'), /CI_EVIDENCE/);

  // A later collection supersedes the PASS; a tampered PASS record is re-judged from its checks.
  w.runs = [R('test', 'completed', 'failure')];
  await collectAt(fx, w, 11);
  assert.equal(complete(fx).out.code, 'ci_failed', 'the latest collection decides');
  fx.editState(S => { const last = S.ci_evidence.at(-1); Object.assign(last, { state: 'PASS', code: 'ci_passed', reasons: [] }); });
  assert.equal(complete(fx).out.code, 'ci_evidence_inconsistent', 'a state edited to PASS over red checks does not authorize');
  assert.deepEqual(nextCi(fx), ['CI', 'BLOCKED', 'ci_evidence_inconsistent', 'resolve']);
});

test('ci with a PR: a --pr whose head moved or is another branch is never bound (pr_head_mismatch); the PR view feeds the NO_CHECKS diagnostic; a newly published head needs its own evidence', { skip: WIN_SKIP }, async (t) => {
  const fx = published(t);
  const w = fakeProvider();
  const head = fx.head();
  w.runs = [R('test', 'completed', 'success')];
  w.pr = { head_sha: OTHER, head_branch: 'T-1-work', base: fx.defaultBranch, mergeable: 'MERGEABLE', merge_state: 'CLEAN', state: 'OPEN' };
  // Round 4 (D4): `--pr` must satisfy every PR row before it is bound (pre-round-4 the verdict's STALE ci_head_moved / ci_pr_mismatch judged it).
  let e = await collectAt(fx, w, 1, { pr: 4 });
  assert.deepEqual([e.state, e.code, e.pr], ['UNAVAILABLE', 'pr_head_mismatch', 4], 'green checks of the published head, but the PR now points elsewhere');
  assert.deepEqual(w.calls, [['pr', 4]], 'no check run is collected for a PR that is not this publication\'s');
  assert.deepEqual(nextCi(fx), ['CI', 'BLOCKED', 'pr_head_mismatch', 'collect_ci']);
  assert.equal(complete(fx).out.code, 'pr_required');
  w.pr = { ...w.pr, head_sha: head, head_branch: 'someone-else' };
  assert.equal((await collectAt(fx, w, 2, { pr: 4 })).code, 'pr_head_mismatch');
  w.pr = { ...w.pr, head_branch: 'T-1-work', mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  w.runs = [];
  e = await collectAt(fx, w, 6, { pr: 4 });
  assert.deepEqual([e.state, e.diagnostic.pr], ['NO_CHECKS', { number: 4, mergeable: 'CONFLICTING', merge_state: 'DIRTY', state: 'open', base: fx.defaultBranch }],
    'a conflicting PR runs no pull_request workflow: the diagnostic says so');
  assert.equal(fx.readState().published.at(-1).pr.number, 4, 'every PR row held: PR #4 is bound to the publication');
  w.pr = null;
  assert.equal((await collectAt(fx, w, 7)).code, 'pr_unavailable', 'a PR view failure: the PR rows cannot be verified');
  w.pr = { head_sha: head, head_branch: 'T-1-work', base: fx.defaultBranch, mergeable: 'MERGEABLE', merge_state: 'CLEAN', state: 'OPEN' };
  w.runs = [R('test', 'completed', 'success')];
  assert.equal((await collectAt(fx, w, 8, { pr: 5 })).code, 'publication_mismatch', 'a PR is bound once: --pr naming another is refused');
  assert.equal((await collectAt(fx, w, 8, { pr: 4 })).state, 'PASS');
  fx.scriptCi({ pr: { number: 4, headRefOid: '$HEAD', headRefName: 'T-1-work', baseRefName: fx.defaultBranch, state: 'OPEN' } }); // the live read (SIMULATED)
  assert.equal(complete(fx).out.allow, true);
  // A new head published after the PASS (an excluded-path commit keeps the reviewed candidate) has no evidence yet; publish looks up the
  // branch's bound PR and re-verifies it read-only (SIMULATED gh REST pull).
  writeFileSync(join(fx.repo, 'session-log.md'), 'after the first publish');
  fx.okGit(['add', 'session-log.md']);
  fx.okGit(['commit', '-q', '-m', 'session log']);
  assert.equal(fx.cli('publish').out.code, 'published');
  assert.equal(fx.readState().published.at(-1).pr.number, 4);
  assert.notEqual(fx.head(), head);
  assert.equal(complete(fx).out.code, 'ci_evidence_missing', 'the earlier head\'s PASS never covers the new head');
  assert.deepEqual(nextCi(fx), ['CI', 'READY', 'ci_owed', 'collect_ci']);
});

test('ci with config.ciRequiredChecks and ciNoChecksMinutes (approved in the plan): a missing required check is PENDING then NO_CHECKS; a red check outside the set still fails, a skipped one does not block', { skip: WIN_SKIP }, async (t) => {
  const fx = published(t, { config: { ciRequiredChecks: ['build'], ciNoChecksMinutes: 2 } });
  const w = fakeProvider();
  w.runs = [R('lint', 'completed', 'success')];
  assert.deepEqual([(await collectAt(fx, w, 1)).code], ['ci_required_pending']);
  const e = await collectAt(fx, w, 2);
  assert.deepEqual([e.state, e.code, e.missing], ['NO_CHECKS', 'ci_required_missing', ['build']], 'the configured 2-minute window');
  assert.ok(e.diagnostic, 'a missing required check carries the diagnostic too');
  assert.deepEqual(nextCi(fx), ['CI', 'BLOCKED', 'ci_required_missing', 'resolve']);
  w.runs = [R('lint', 'completed', 'failure'), R('build', 'completed', 'success')];
  assert.deepEqual([(await collectAt(fx, w, 3)).code], ['ci_failed'], 'R0-S: a red check outside the configured set still fails the head');
  w.runs = [R('lint', 'completed', 'skipped'), R('build', 'completed', 'success')];
  const p = await collectAt(fx, w, 3);
  assert.deepEqual([p.state, p.required, p.required_source], ['PASS', ['build'], 'config']);
  // Owner decision (round 4): a RELAXED run (ciRequiredChecks / ciNoChecksMinutes are relaxed assurance settings) never completes.
  assert.equal(complete(fx).out.code, 'assurance_relaxed');
});

// ------------------------------------------------------------------ the CLI through the fake gh

test('CLI ci through the fake gh: the published head is queried, a short page is ci_provider_incomplete, and NO_CHECKS carries mergeable state and recent runs (exit 2)', { skip: WIN_SKIP }, (t) => {
  const fx = published(t);
  const head = fx.head();
  fx.scriptCi({ checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'completed', conclusion: 'success' }], total: 3 }] });
  let r = fx.cli('ci');
  assert.deepEqual([r.status, r.out.state, r.out.code], [2, 'UNAVAILABLE', 'ci_provider_incomplete'], r.stdout + r.stderr);
  const calls = fx.ghLog().filter(a => a[0] === 'api');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], `repos/acme/t-1/commits/${head}/check-runs`, 'the exact published head, by commit SHA, in the published repository');
  assert.ok(calls[0].includes('--paginate'));
  fx.editState(S => { S.published.at(-1).at = new Date(Date.now() - 10 * MIN).toISOString(); });
  fx.scriptCi({ checkRuns: [{ runs: [] }], pr: { number: 1, headRefOid: '$HEAD', headRefName: 'T-1-work', baseRefName: fx.defaultBranch, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', state: 'OPEN' },
    runs: [{ databaseId: 5, headSha: head, status: 'completed', conclusion: 'skipped', event: 'push', workflowName: 'ci', createdAt: 't' }] });
  r = fx.cli('ci', { pr: '1' });
  assert.deepEqual([r.status, r.out.state, r.out.code], [2, 'NO_CHECKS', 'ci_no_checks'], r.stdout + r.stderr);
  assert.deepEqual([r.out.diagnostic.pr.mergeable, r.out.diagnostic.pr.merge_state], ['CONFLICTING', 'dirty'], 'REST mergeable_state (round 4: the REST pull)');
  assert.deepEqual(r.out.diagnostic.recent_runs.map(x => [x.id, x.conclusion]), [[5, 'skipped']]);
  fx.scriptCi({ checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'completed', conclusion: 'success', started_at: 's', completed_at: 'c' }] }],
    pr: { number: 1, headRefOid: '$HEAD', headRefName: 'T-1-work', baseRefName: fx.defaultBranch, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN' } });
  r = fx.cli('ci', { pr: '1' });
  assert.deepEqual([r.status, r.out.state], [0, 'PASS'], r.stdout + r.stderr);
  assert.equal(complete(fx).status, 0);
});
