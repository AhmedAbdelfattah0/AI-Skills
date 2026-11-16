/**
 * R0-S repair batch 2: regression tests for the confirmation-round findings on 2cdc80a (items 1-7). Each test pins a refusal
 * (reason code) the vulnerable behaviour let through, under the STRICT (default) review policy. Drives the REAL engine CLI on
 * temp repos (engine-enroll.test-helper.mjs: fake provider, fake gh, fake reviewer relays and fake claude/codex CLIs, a local
 * bare remote behind a GitHub-style origin URL). No real claude, codex or gh runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, realpathSync, chmodSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, primaryReview, passReview } from './engine-test-fixture.mjs';
import { enrollFixture, GITHUB_SLUG } from './engine-enroll.test-helper.mjs';
import { finalMessage, reviewBody } from './engine-review.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';
import { policyApproval, policyLine, relaxedPolicy, visibleLines, narrativeListsDigest } from './engine-dag.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const ENGINE = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const authorize = (fx, stage, extra = {}) => fx.cli('authorize', { stage, ...extra });
const denied = (r, code, why = '') => {
  assert.equal(r.out?.allow ?? r.out?.ok, false, `${why}: ${r.stdout}${r.stderr}`);
  assert.equal(r.out?.code, code, `${why}: ${r.stdout}`);
};
const shippable = async (t, opts) => { const fx = enrollFixture(t, opts); await fx.toShipReady(); fx.commitAll(); return fx; };
const started = (fx) => { assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0); assert.equal(fx.cli('drive').status, 0); };
const reviewersDone = (fx) => waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'reviewer envelopes');
const relay = (fx, b) => writeFileSync(join(fx.root, 'relay-behaviour.json'), J(b));
const FAIL_PRIMARY = (c) => ({ 'claude-delegate': { final: finalMessage(reviewBody(primaryReview(c, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }] }))) } });
const next = (fx) => { const n = fx.cli('next'); return { ...n.out.next_action, stop: n.out.stop, status: n.status }; };
const PASS_RUN = { checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'completed', conclusion: 'success', started_at: 's', completed_at: 'c' }] }] };
const relayLog = (fx) => readFileSync(join(fx.root, 'relay.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
/** Move the configured base branch `trunk` forward (locally and on the remote: the upstream moved) with a commit outside the patch and fast-forward the ticket branch onto it (candidate id unchanged). */
const moveBase = (fx) => {
  fx.okGit(['checkout', '-q', 'trunk']);
  writeFileSync(join(fx.repo, 'trunk.txt'), 'upstream change outside the patch');
  fx.okGit(['add', 'trunk.txt']);
  fx.okGit(['commit', '-q', '-m', 'trunk']);
  fx.okGit(['push', '-q', 'origin', 'trunk']); // the upstream moved (round 3: the base is the remote's commit)
  fx.okGit(['checkout', '-q', 'T-1-work']);
  fx.okGit(['merge', '-q', '--ff-only', 'trunk']);
};

// ------------------------------------------------------------------ item 1: --base laundering

test('item 1: publish --base <a local ref at an unreviewed commit> is pr_base_unbound (it gave the reviewed merge base); a forged PUBLISH_INTENT base too', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  writeFileSync(join(fx.repo, 'docs', 'wip.txt'), 'UNREVIEWED');
  fx.okGit(['add', 'docs/wip.txt']);
  fx.okGit(['commit', '-q', '-m', 'unreviewed']);
  fx.okGit(['branch', 'wipbase', 'HEAD']);
  await fx.toShipReady();
  fx.commitAll();
  denied(authorize(fx, 'publish'), 'base_mismatch', 'the bound base (the remote default branch) sees the unreviewed commit');
  denied(authorize(fx, 'publish', { base: 'wipbase' }), 'pr_base_unbound', '--base at the WIP commit');
  const sha = fx.okGit(['rev-parse', 'wipbase']).stdout.trim();
  denied(authorize(fx, 'publish', { base: sha }), 'pr_base_unbound', '--base as a SHA');
  const p = fx.cli('publish', { base: 'wipbase' });
  assert.deepEqual([p.status, p.out.code, fx.remoteHead()], [2, 'pr_base_unbound', null], p.stdout);
  // The pre-push hook's authorize reads a recorded PUBLISH_INTENT base: a forged one is refused the same way.
  fx.editState(S => { S.publish_intent = { head: fx.head(), branch: 'T-1-work', base: 'wipbase', remote: 'origin' }; });
  denied(authorize(fx, 'publish'), 'pr_base_unbound', 'a recorded intent base');
});

// ------------------------------------------------------------------ item 2: review shopping

test('item 2a: a live reviewer for c1 blocks dispatch (and gate) for c2 of the same owed review; next waits for it, never re-offers the dispatch', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  const c1 = fx.candidate();
  relay(fx, { 'claude-delegate': { sleep_ms: 6000, ...FAIL_PRIMARY(c1)['claude-delegate'] } });
  assert.equal(fx.dispatch('primary', c1).out.code, 'review_dispatched');
  writeFileSync(join(fx.repo, 'src', 'extra.txt'), 'variant');
  const c2 = fx.candidate();
  for (const role of ['primary', 'second']) {
    const d = fx.dispatch(role, c2);
    assert.deepEqual([d.status, d.out.code], [2, 'review_dispatch_live'], `${role}: ${d.stdout}`);
  }
  const n = next(fx);
  assert.deepEqual([n.stage, n.disposition, n.reason, n.action], ['REVIEW', 'WAITING', 'review_sibling_in_flight', 'wait'], J(n));
  await reviewersDone(fx);
  assert.deepEqual([next(fx).stage, fx.readState().review_dispatches[0].collected?.outcome], ['REVIEW', 'FAIL'], 'next collected c1 first');
  const after = next(fx);
  assert.deepEqual([after.reason, after.owner, after.stop], ['review_fail_unconsumed', 'human', true], J(after));
});

test('item 2b: a FAIL is not escaped by moving the base under an unchanged candidate id (dispatch, next); only the owner RETRY naming it releases', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  started(fx);
  const c = fx.candidate();
  relay(fx, FAIL_PRIMARY(c));
  const p = fx.dispatch('primary', c);
  assert.equal(p.out.code, 'review_dispatched');
  await reviewersDone(fx);
  assert.equal(fx.cli('review-collect').status, 0);
  moveBase(fx);
  assert.equal(fx.candidate(), c, 'the candidate id is unchanged against the new merge base');
  for (const role of ['primary', 'second']) {
    const d = fx.dispatch(role, c);
    assert.deepEqual([d.status, d.out.code], [2, 'review_fail_unconsumed'], `${role}: ${d.stdout}`);
  }
  const n = next(fx);
  assert.deepEqual([n.reason, n.owner, n.stop, n.status], ['review_fail_unconsumed', 'human', true, 2], J(n));
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-x', predecessor: p.out.receipt.attempt_id, authorized_by: 'owner' });
  assert.equal(fx.dispatch('primary', c).out.code, 'review_dispatched', 'the owner RETRY naming the FAIL releases it');
  await reviewersDone(fx);
});

/** Inject an ungated reviewer record of the first original (another candidate): what the dispatch guards keep out, the gates must refuse too. */
const inject = (fx, over) => fx.editState(S => { S.review_dispatches = [...(S.review_dispatches ?? []), { attempt_id: 'att-injected', role: 'primary', kind: 'original',
  requested_identity: 'claude:opus', provider: 'claude', candidate_id: 'C-OTHER', merge_base: 'M-OTHER', status: 'collected', collected: { outcome: 'FAIL' }, ...over }]; });

test('item 2c: an ungated FAIL (or a running reviewer) of the owed review is enforced at gate review, gate ship-ready and authorize publish; an owner RETRY releases it', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  const reviewed = fx.engineReview(passReview('rx-1', fx.candidate())).input;
  inject(fx);
  const g = fx.gate('review', reviewed, { raw: true });
  assert.deepEqual([g.out.ok, g.out.code], [false, 'review_fail_unconsumed'], g.stdout);
  fx.editState(S => { S.review_dispatches.at(-1).status = 'dispatched'; delete S.review_dispatches.at(-1).collected; });
  assert.equal(fx.gate('review', reviewed, { raw: true }).out.code, 'review_dispatch_live');
  fx.editState(S => { S.review_dispatches.pop(); });
  assert.equal(fx.gate('review', reviewed, { raw: true }).out.code, 'review_accepted');
  inject(fx);
  const sr = fx.gate('ship-ready', {});
  assert.deepEqual([sr.out.ok, sr.out.code], [false, 'review_fail_unconsumed'], sr.stdout);
  fx.editState(S => { S.review_dispatches.pop(); });
  assert.equal(fx.gate('ship-ready', {}).out.ok, true);
  fx.commitAll();
  assert.equal(authorize(fx, 'publish').out.allow, true);
  inject(fx);
  denied(authorize(fx, 'publish'), 'review_fail_unconsumed', 'authorize publish');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'att-injected', authorized_by: 'owner' });
  fx.commitAll('retry line');
  fx.cli('next'); // a locked command observes (trusts) the owner line
  assert.equal(authorize(fx, 'publish').out.allow, true, 'the owner RETRY naming it releases it');
});

// ------------------------------------------------------------------ item 3: CI repository

test('item 3: gh runs with GH_REPO / GH_HOST / tokens stripped and the published repository explicit; answers of another repository are ci_repo_mismatch (BLOCKED for the human)', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(fx.cli('publish').out.code, 'published');
  assert.equal(fx.readState().published.at(-1).repository.slug, GITHUB_SLUG);
  Object.assign(fx.env, { GH_REPO: 'evil/fork', GH_HOST: 'evil.example', GITHUB_TOKEN: 'token-of-another-account', GH_CONFIG_DIR: join(fx.root, 'evil-gh') });
  fx.scriptCi(PASS_RUN);
  const r = fx.cli('ci');
  assert.deepEqual([r.status, r.out.state, r.out.repository], [0, 'PASS', GITHUB_SLUG], r.stdout + r.stderr);
  const env = fx.ghEnvLog().at(-1);
  assert.deepEqual(Object.keys(env).filter(k => k !== 'HOME').sort(), ['GH_PROMPT_DISABLED'], `the gh child saw ${J(env)}`);
  assert.equal(env.HOME, userInfo().homedir, 'gh runs as the OS account (its stored login), never the caller HOME');
  const api = fx.ghLog().filter(a => a[0] === 'api').at(-1);
  assert.equal(api[3].startsWith('repos/acme/t-1/commits/'), true, J(api));
  assert.deepEqual(api.slice(-2), ['--hostname', 'github.com']);
  // A gh that answered for a fork (the same sha, green) is refused, and the human owns it.
  fx.scriptCi({ ...PASS_RUN, htmlRepo: 'github.com/evil/fork' });
  const f = fx.cli('ci');
  assert.deepEqual([f.status, f.out.state, f.out.code], [2, 'UNAVAILABLE', 'ci_repo_mismatch'], f.stdout);
  denied(authorize(fx, 'complete'), 'ci_repo_mismatch', 'complete');
  const n = next(fx);
  assert.deepEqual([n.stage, n.reason, n.owner, n.stop], ['CI', 'ci_repo_mismatch', 'human', true], J(n));
});

test('item 3: a remote URL changed after publish is ci_repo_mismatch at ci and at authorize complete', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(fx.cli('publish').out.code, 'published');
  fx.scriptCi(PASS_RUN);
  assert.equal(fx.cli('ci').out.state, 'PASS');
  assert.equal(authorize(fx, 'complete').out.allow, true);
  fx.okGit(['remote', 'set-url', 'origin', 'https://github.com/evil/fork.git']);
  fx.okGit(['config', '--local', `url.${fx.remote}.insteadOf`, 'https://github.com/evil/fork.git']);
  denied(authorize(fx, 'complete'), 'ci_repo_mismatch', 'complete re-reads the remote');
  const r = fx.cli('ci');
  assert.deepEqual([r.out.state, r.out.code], ['UNAVAILABLE', 'ci_repo_mismatch'], r.stdout);
});

// ------------------------------------------------------------------ item 4: reviewer executables

test('item 4: the reviewer CLI is pinned at its first dispatch; a stub claude put first on PATH later never runs (the relay resolves the pinned one); changed bytes are review_cli_drift', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  relay(fx, { 'claude-delegate': { status: 'failed', exit: 1 } });
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched');
  const pin = fx.readState().review_cli_pins.claude;
  assert.equal(pin.path, realpathSync(join(fx.root, 'bin', 'claude')));
  await reviewersDone(fx);
  assert.equal(fx.cli('review-collect').status, 0);
  const stub = join(fx.root, 'stub-bin');
  mkdirSync(stub);
  writeFileSync(join(stub, 'claude'), `#!/bin/sh\ntouch ${J(join(fx.root, 'stub-ran'))}\necho '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'\n`);
  chmodSync(join(stub, 'claude'), 0o755);
  const preload = join(fx.root, 'preload.cjs');
  writeFileSync(preload, `if (/relay\\.mjs$/.test(process.argv[1] ?? '')) require('fs').writeFileSync(${J(join(fx.root, 'preload-ran'))}, '1');\n`);
  const saved = { PATH: fx.env.PATH, NODE_OPTIONS: fx.env.NODE_OPTIONS };
  Object.assign(fx.env, { PATH: `${stub}:${saved.PATH}`, NODE_OPTIONS: `--require ${preload}` });
  try {
    assert.equal(fx.dispatch('primary').out.code, 'review_dispatched');
    await reviewersDone(fx);
  } finally { fx.env.PATH = saved.PATH; if (saved.NODE_OPTIONS === undefined) delete fx.env.NODE_OPTIONS; else fx.env.NODE_OPTIONS = saved.NODE_OPTIONS; }
  const last = relayLog(fx).at(-1);
  assert.deepEqual([last.cli_path, last.cli_status], [pin.path, 0], J(last));
  assert.equal(existsSync(join(fx.root, 'stub-ran')), false, 'the PATH stub never ran');
  assert.equal(existsSync(join(fx.root, 'preload-ran')), false, 'NODE_OPTIONS never reaches the relay');
  assert.ok(last.path_head.endsWith('.bin'), 'the engine shim is first on the relay PATH');
  assert.equal(fx.cli('review-collect').status, 0);
  const bytes = readFileSync(pin.path);
  appendFileSync(pin.path, '\n# replaced\n');
  const d = fx.dispatch('primary');
  assert.deepEqual([d.status, d.out.code, d.out.recorded], [2, 'review_cli_drift', true], d.stdout);
  const n = next(fx);
  assert.deepEqual([n.reason, n.owner, n.stop], ['review_cli_drift', 'human', true], J(n));
  writeFileSync(pin.path, bytes);
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched', 'the restored CLI dispatches again');
  await reviewersDone(fx);
});

// ------------------------------------------------------------------ item 5: plan-line placement

test('item 5: a policy line hidden in an HTML comment or a code fence is not approval (policy_unapproved at init); next --dag before init is NEEDS_APPROVAL naming the relaxed values', { skip: WIN_SKIP }, (t) => {
  const relaxed = { reviewProvenance: 'unbound' };
  const line = policyLine(relaxedPolicy(relaxed));
  for (const [how, extra] of [['comment', `<!--\n${line}\n-->\n\n`], ['unterminated comment', `<!-- note\n${line}\n\n`], ['fence', '```\n' + line + '\n```\n\n'], ['tilde fence', '~~~text\n' + line + '\n~~~\n\n'], ['indented', `  ${line}\n\n`]]) {
    const fx = fixture(t, { commit: true, config: relaxed, approvePolicy: false, narrativeExtra: extra, admit: false });
    const n = fx.cli('next', { dag: fx.dagFile });
    assert.deepEqual([n.status, n.out.next_action.disposition, n.out.next_action.reason, n.out.next_action.owner, n.out.stop], [2, 'NEEDS_APPROVAL', 'policy_unapproved', 'human', true], `${how}: ${n.stdout}`);
    assert.deepEqual([n.out.next_action.relaxed, n.out.next_action.required_line], [relaxed, line], how);
    const r = fx.cli('init', { dag: fx.dagFile });
    assert.equal(r.status, 1, `${how}: ${r.stdout}`);
    assert.match(r.stderr, /policy_unapproved/, how);
  }
  const ok = fixture(t, { commit: true, config: relaxed, admit: false });
  const n = ok.cli('next', { dag: ok.dagFile }).out.next_action;
  assert.deepEqual([n.action, n.assurance, n.relaxed], ['init', 'RELAXED', relaxed], 'a visible approved line: init is next, labelled RELAXED');
});

test('item 5: visible lines drop HTML comments and fences; the DAG digest must be on a visible line (pure)', () => {
  const d = 'sha256:' + 'a'.repeat(64);
  const relaxed = { acceptNativeReview: true };
  const line = policyLine(relaxed);
  assert.deepEqual(visibleLines(`a\n<!-- ${d} -->\nb\n\`\`\`\n${line}\n\`\`\`\nc`), ['a', '', 'b', 'c']);
  assert.equal(narrativeListsDigest(`<!-- Execution DAG digest: ${d} -->`, d), false);
  assert.equal(narrativeListsDigest(`Execution DAG digest: ${d.replace('sha256:', 'sha256-')}`, d), true);
  assert.equal(policyApproval({ config: relaxed, narrative: `<!-- ${d} -->\n${line}\n`, dagDigest: d }).ok, false, 'a hidden digest');
  assert.equal(policyApproval({ config: relaxed, narrative: `${d}\nsee ${line} above\n`, dagDigest: d }).ok, false, 'not a standalone line');
  assert.equal(policyApproval({ config: relaxed, narrative: `${d}\n${line}\n`, dagDigest: d }).ok, true);
});

// ------------------------------------------------------------------ item 6: refusals never loop

test('item 6: gh_unpinned after a no-PR publish: ci pins gh at first use when the published head verifies; with no gh at all ci records gh_unpinned and next stops for the human', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  fx.editState(S => { S.enrollment.tools = { gh: null }; });
  assert.equal(fx.cli('publish').out.code, 'published', 'a no-PR publish needs no gh');
  fx.scriptCi(PASS_RUN);
  const r = fx.cli('ci');
  assert.deepEqual([r.out.state, fx.readState().enrollment.tools.gh.pinned_at], ['PASS', 'ci'], r.stdout);
  assert.equal(fx.readState().enrollment.tools.gh.path, realpathSync(join(fx.root, 'bin', 'gh')));

  const g = await shippable(t);
  g.editState(S => { S.enrollment.tools = { gh: null }; });
  assert.equal(g.cli('publish').out.code, 'published');
  const bare = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const real = bare.split(':').some(d => existsSync(join(d, 'gh')));
  if (!real) {
    const saved = g.env.PATH;
    g.env.PATH = bare; g.env.Path = bare;
    try {
      const c = g.cli('ci');
      assert.deepEqual([c.status, c.out.state, c.out.code], [2, 'UNAVAILABLE', 'gh_unpinned'], c.stdout + c.stderr);
      for (let i = 0; i < 2; i++) {
        const n = next(g);
        assert.deepEqual([n.stage, n.reason, n.owner, n.stop], ['CI', 'gh_unpinned', 'human', true], J(n));
      }
    } finally { g.env.PATH = saved; g.env.Path = saved; }
  }
  // The late pin is refused while the published branch is not at the published head (nothing pinned).
  const h = await shippable(t);
  h.editState(S => { S.enrollment.tools = { gh: null }; });
  assert.equal(h.cli('publish').out.code, 'published');
  h.okGit(['push', '-q', 'origin', `${h.okGit(['rev-parse', 'HEAD~1']).stdout.trim()}:refs/heads/T-1-work`, '--force']);
  const c = h.cli('ci');
  assert.deepEqual([c.out.code, h.readState().enrollment.tools.gh], ['ci_head_unverified', null], c.stdout);
});

test('item 6: dispatch refusals the orchestrator cannot correct (review_relay_drift, reviewer_is_builder, review_diff_unavailable before any receipt) are recorded and stop next for the human', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  const stopsFor = (code) => { for (let i = 0; i < 2; i++) assert.deepEqual((({ reason, owner, stop }) => [reason, owner, stop])(next(fx)), [code, 'human', true], `${code} (ask ${i + 1})`); };
  // review_relay_drift: the codex relay pinned by a failed second, then changed.
  relay(fx, { 'codex-delegate': { status: 'failed', exit: 1 } });
  assert.equal(fx.dispatch('second').out.code, 'review_dispatched');
  await reviewersDone(fx);
  assert.equal(fx.cli('review-collect').status, 0);
  appendFileSync(join(fx.relayHome, '.agents', 'skills', 'codex-delegate', 'scripts', 'relay.mjs'), '\n// replaced\n');
  const r = fx.dispatch('second');
  assert.deepEqual([r.out.code, r.out.recorded], ['review_relay_drift', true], r.stdout);
  stopsFor('review_relay_drift');
  // reviewer_is_builder
  fx.editState(S => { S.builders.push({ identity: 'claude:opus', node: 'a' }); });
  const b = fx.dispatch('primary');
  assert.deepEqual([b.out.code, b.out.recorded], ['reviewer_is_builder', true], b.stdout);
  stopsFor('reviewer_is_builder');
  fx.editState(S => { S.builders.pop(); });
  // review_diff_unavailable: a textconv that fails breaks the content diff (the brief) while the candidate (name-only) still computes.
  mkdirSync(join(fx.repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(fx.repo, '.git', 'info', 'attributes'), '* diff=boom\n');
  fx.okGit(['config', '--local', 'diff.boom.textconv', 'false']);
  fx.okGit(['add', '-N', 'src/a.txt']); // tracked (intent to add): its content diff runs the failing textconv
  const before = fx.readState();
  const d = fx.dispatch('primary');
  assert.deepEqual([d.out.code, d.out.recorded], ['review_diff_unavailable', true], d.stdout);
  const after = fx.readState();
  assert.deepEqual([after.review_dispatches.length, after.attempts.length], [before.review_dispatches.length, before.attempts.length], 'no receipt, no attempt');
  stopsFor('review_diff_unavailable');
});

test('item 6: the same gate refusal twice in a row is the human\'s (gate review, gate ship-ready); a repeated provider failure at ci too', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  const c = fx.candidate();
  const reviewed = fx.engineReview(passReview('rx-1', c)).input;
  const forged = { ...reviewed, primary: { ...reviewed.primary, findings: [{ id: 'X', severity: 'minor', paths: ['src/a.txt'], evidence: 'e', fix: 'f' }] } };
  assert.equal(fx.gate('review', forged, { raw: true }).out.code, 'review_unbound');
  let n = next(fx);
  assert.deepEqual([n.action, n.reason, n.owner, n.stop], ['gate_review', 'review_unbound', 'orchestrator', false], `first refusal: the orchestrator may correct the input ${J(n)}`);
  assert.equal(fx.gate('review', forged, { raw: true }).out.code, 'review_unbound');
  n = next(fx);
  assert.deepEqual([n.reason, n.owner, n.stop], ['review_unbound', 'human', true], 'the same refusal again: the human owns it');
  assert.equal(fx.gate('review', reviewed, { raw: true }).out.code, 'review_accepted');
  for (let i = 1; i <= 2; i++) {
    assert.equal(fx.gate('ship-ready', { candidate_id: 'not-the-candidate' }).out.code, 'candidate_mismatch');
    n = next(fx);
    assert.deepEqual([n.reason, n.owner], ['candidate_mismatch', i === 1 ? 'orchestrator' : 'human'], `ship-ready refusal ${i}`);
  }
  assert.equal(fx.gate('ship-ready', {}).out.ok, true);
  fx.commitAll();
  assert.equal(fx.cli('publish').out.code, 'published');
  fx.scriptCi({ checkRuns: [{ fail: 'HTTP 502' }] });
  for (let i = 1; i <= 2; i++) {
    assert.equal(fx.cli('ci').out.code, 'ci_provider_unavailable');
    n = next(fx);
    assert.deepEqual([n.reason, n.owner, n.stop], ['ci_provider_unavailable', i === 1 ? 'engine' : 'human', i !== 1], `ci failure ${i}`);
  }
});

// ------------------------------------------------------------------ item 7: coverage

test('item 7: an envelope with no result.json digest (an old launcher) is review_output_unverified, never collected', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  const c = fx.candidate();
  relay(fx, { 'claude-delegate': { final: finalMessage(reviewBody(primaryReview(c))) } });
  assert.equal(fx.dispatch('primary', c).out.code, 'review_dispatched');
  await reviewersDone(fx);
  const a = fx.readState().attempts.find(x => x.kind === 'review');
  const env = JSON.parse(readFileSync(a.envelope_file, 'utf8'));
  delete env.file_digests;
  writeFileSync(a.envelope_file, J(env));
  assert.equal(fx.cli('review-collect').status, 0);
  const d = fx.readState().review_dispatches[0];
  assert.deepEqual([d.status, d.collected.parsed_file], ['failed', null]);
  assert.match(d.collected.parse_error, /^review_output_unverified/);
});

test('item 7: CI evidence that verified neither the remote branch nor a PR head is ci_head_unverified at authorize complete', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(fx.cli('publish').out.code, 'published');
  fx.scriptCi(PASS_RUN);
  assert.equal(fx.cli('ci').out.state, 'PASS');
  assert.equal(authorize(fx, 'complete').out.allow, true);
  fx.editState(S => { delete S.ci_evidence.at(-1).remote_head; });
  denied(authorize(fx, 'complete'), 'ci_head_unverified');
});

test('item 7: the CLI context path records nothing when stdout is closed (context_emit_failed, EPIPE)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  fx.editState(S => { delete S.contexts.ship; });
  const child = spawn(process.execPath, [ENGINE, 'context', '--phase', 'ship', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'], { env: fx.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy(); // the reader is gone before the references are written
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 2, err);
  assert.match(err, /context_emit_failed/);
  assert.equal(fx.readState().contexts.ship, undefined, 'nothing recorded');
});

// item 7's STRICT end to end (repair -> confirmation -> publish -> CI -> complete) is row M7 of run-engine-trust-matrix.test.mjs.
