/**
 * R0-S repair batch: regression tests for the release-blocking findings (A) and the hardening batch (B) of the
 * frozen 7fed867 candidate. Each test pins a refusal (with its reason code) that the vulnerable behaviour let
 * through. Drives the REAL engine CLI on temp repos (engine-enroll.test-helper.mjs: fake provider, fake gh,
 * fake reviewer relays under the fixture's relay home, a local bare remote); no real claude, codex or gh runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';
import { finalMessage, reviewBody } from './engine-review.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';
import { ci, context } from './run-engine.mjs';
import { historyPaths } from './engine-enroll.mjs';
import { briefGit, buildPrompt, relayHome, relayPath } from './engine-review-dispatch.mjs';
import { policyLine, relaxedPolicy } from './engine-dag.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const authorize = (fx, stage) => fx.cli('authorize', { stage });
const denied = (r, code, why = '') => {
  assert.equal(r.out?.allow ?? r.out?.ok, false, `${why}: ${r.stdout}${r.stderr}`);
  assert.equal(r.out?.code, code, `${why}: ${r.stdout}`);
};
const shippable = async (t, opts) => { const fx = enrollFixture(t, opts); await fx.toShipReady(); fx.commitAll(); return fx; };

// ------------------------------------------------------------------ A1 (C1): history inspection never fails open

test('A1: more than 1 MiB of history is inspected (never read as empty); a git log that fails is history_unavailable', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(authorize(fx, 'publish').out.allow, true);
  // One commit adds 4000 files with long paths outside the candidate, the next removes them: the final tree is the reviewed one.
  const dir = join(fx.repo, 'h'.repeat(100), 'i'.repeat(100));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4000; i++) writeFileSync(join(dir, `${'x'.repeat(80)}-${i}.txt`), 'unreviewed');
  fx.commitAll('bulk');
  rmSync(join(fx.repo, 'h'.repeat(100)), { recursive: true, force: true });
  fx.commitAll('bulk reverted');
  const size = spawnSync('git', ['log', '--format=', '--name-only', '--no-renames', 'HEAD~2..HEAD'], { cwd: fx.repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.length;
  assert.ok(size > 1024 * 1024, `the history listing is ${size} bytes`);
  const r = authorize(fx, 'publish');
  denied(r, 'history_outside_candidate', 'a >1 MiB history listing');
  // A git log that fails (a repository config git log rejects) is a refusal of its own, never an empty history.
  const g = await shippable(t);
  g.okGit(['config', '--local', 'log.date', 'bogus']);
  denied(authorize(g, 'publish'), 'history_unavailable', 'git log failed');
  assert.equal(g.cli('publish').out.code, 'history_unavailable');
  assert.equal(g.remoteHead(), null, 'nothing pushed');
});

// ------------------------------------------------------------------ A2 (C2): the destination ref is authorized

test('A2: the guard validates the destination: T-1\'s sha to T-2\'s branch, to main and to HEAD:refs/heads/x are refused; the bound branch passes', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  const g = spawnSync(process.execPath, [GUARD, 'install', '--repo', fx.repo], { encoding: 'utf8', env: fx.env });
  assert.equal(g.status, 0, g.stderr);
  const push = (args) => spawnSync('git', ['push', ...args], { cwd: fx.repo, encoding: 'utf8', env: fx.env });
  const blocked = (r, code, why) => { assert.notEqual(r.status, 0, `${why}: ${r.stderr}`); assert.match(r.stderr, new RegExp(code), why); };
  blocked(push(['origin', 'T-1-work:refs/heads/T-2-work']), 'not_enrolled|cross_ticket_push', 'T-1 sha to the unenrolled T-2 branch');
  assert.equal(fx.remoteHead('T-2-work'), null);
  blocked(push(['origin', `T-1-work:refs/heads/${fx.defaultBranch}`]), 'push_to_default_branch', 'T-1 sha to the default branch');
  blocked(push(['origin', `HEAD:refs/heads/${fx.defaultBranch}`]), 'push_to_default_branch', 'HEAD to the default branch');
  blocked(push(['origin', 'HEAD:refs/heads/x']), 'push_destination_mismatch', 'HEAD to a branch naming no ticket');
  fx.okGit(['branch', 'copy']);
  blocked(push(['origin', `copy:refs/heads/${fx.defaultBranch}`]), 'push_to_default_branch', 'a copy branch at the ticket HEAD to the default branch');
  assert.equal(fx.remoteHead('x'), null, 'the authorized commit never reached the remote under another name');
  const ok = push(['origin', 'HEAD:refs/heads/T-1-work']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fx.remoteHead(), fx.head());
});

// ------------------------------------------------------------------ A3 (C5): a missing freshness binding refuses

test('A3: an authorizing review with no freshness binding (pre-E3) is review_binding_missing at ship-ready, authorize and next (owner RETRY)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  await fx.toShipReady();
  fx.editState(S => { delete S.review_bindings; });
  const sr = fx.gate('ship-ready', {});
  assert.deepEqual([sr.out.ok, sr.out.code], [false, 'review_binding_missing'], sr.stdout);
  fx.commitAll();
  denied(authorize(fx, 'publish'), 'review_binding_missing', 'authorize publish');
  const n = fx.cli('next').out;
  assert.deepEqual([n.review_freshness.fresh, n.next_action.reason, n.next_action.action, n.next_action.owner], [false, 'review_binding_missing', 'owner_retry', 'human'], J(n.next_action));
  // A binding with no merge base is the same refusal.
  fx.editState(S => { S.review_bindings = [{ review_execution: 'rx-1', kind: 'original', candidate_id: S.review_chain[0].candidate_id, merge_base: null }]; });
  denied(authorize(fx, 'publish'), 'review_binding_missing', 'null merge base');
  assert.equal(fx.cli('next').out.review_freshness.code, 'review_binding_missing');
});

test('A1: the reviewer brief never launches on a failed or overflowing git call (review_diff_unavailable, before any receipt)', () => {
  const fail = (r) => () => r;
  for (const r of [{ status: 128, stdout: '', stderr: 'fatal: bad config' }, { status: null, stdout: '', error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }) }])
    assert.throws(() => briefGit('/repo', ['diff', 'M'], fail(r)), (e) => e.code === 'review_diff_unavailable', J(r));
  assert.equal(briefGit('/repo', ['diff', 'M'], fail({ status: 0, stdout: 'diff' })), 'diff');
  assert.throws(() => buildPrompt({ S: { config: {}, nodes: {} }, repoRoot: '/repo', planText: null, role: 'primary', owed: { kind: 'original' }, candidate: 'C', mergeBase: null, paths: [] }),
    (e) => e.code === 'review_diff_unavailable', 'no merge base: no brief');
  const h = historyPaths('/repo', 'a..b', { spawn: fail({ status: null, stdout: '', error: Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS' }) }) });
  assert.deepEqual([h.ok, h.reason], [false, 'ENOBUFS'], 'an overflowing history listing is a failure, never empty');
});

// ------------------------------------------------------------------ A4 (N1 + Codex HIGH 1): no policy downgrade

test('A4: relaxed assurance needs the human-approved plan binding AND the policy line; a DAG_BOUND or line-less relaxed DAG is refused at init (policy_unapproved)', { skip: WIN_SKIP }, (t) => {
  for (const config of [{ reviewProvenance: 'unbound' }, { acceptNativeReview: true }, { ciRequiredChecks: ['build'] }, { ciNoChecksMinutes: 60 }]) {
    const noLine = enrollFixture(t, { config, approvePolicy: false, admit: false });
    const r = noLine.cli('init', { dag: noLine.dagFile });
    assert.equal(r.status, 1, `${J(config)}: ${r.stdout}`);
    assert.match(r.stderr, /policy_unapproved/, J(config));
  }
  // The line in the narrative is not enough when the DAG is bound by an orchestrator-written DAG_BOUND line.
  const relaxed = { reviewProvenance: 'unbound' };
  const fx = fixture(t, { commit: true, bind: 'dag_bound', config: relaxed, narrativeExtra: `${policyLine(relaxedPolicy(relaxed))}\n\n`, admit: false });
  const r = fx.cli('init', { dag: fx.dagFile });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /policy_unapproved.*not bound by the approved plan narrative/);
  // An approved relaxed run inits, and every answer labels it RELAXED.
  const ok = enrollFixture(t, { config: { acceptNativeReview: true } });
  assert.equal(ok.cli('init', { dag: ok.dagFile }).status, 0);
  const n = ok.cli('next').out;
  assert.deepEqual([n.assurance.level, n.assurance.relaxed, n.next_action.assurance], ['RELAXED', { acceptNativeReview: true }, 'RELAXED'], J(n.assurance));
  assert.equal(ok.cli('status').out.assurance.level, 'RELAXED', 'status too');
});

test('A4: a downgrade after enrollment and after plan approval (state edit of any assurance key) is policy_drift at every gate, authorize and next; other config edits are config_drift', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const c = fx.candidate();
  for (const [key, value] of [['reviewProvenance', 'unbound'], ['acceptNativeReview', true], ['ciRequiredChecks', ['lint']], ['ciNoChecksMinutes', 120]]) {
    fx.editState(S => { S.config[key] = value; });
    const g = fx.gate('review', passReview('rx-1', c), { raw: true }); // the forged review the downgrade would let through
    assert.deepEqual([g.out.ok, g.out.code], [false, 'policy_drift'], `${key}: ${g.stdout}`);
    const n = fx.cli('next');
    assert.deepEqual([n.out.next_action.stage, n.out.next_action.disposition, n.out.next_action.reason, n.out.next_action.owner, n.status], ['APPROVAL', 'NEEDS_APPROVAL', 'policy_drift', 'human', 2], key);
    assert.equal(authorize(fx, 'build').out.code, 'policy_drift', key);
    assert.equal(fx.cli('drive').out.judgments.some(j => j.code === 'policy_drift'), true, `${key}: drive`);
    fx.editState(S => { delete S.config[key]; });
  }
  fx.editState(S => { S.pinned_exclusions = [...S.pinned_exclusions, 'src']; });
  assert.equal(fx.gate('ship-ready', {}).out.code, 'config_drift', 'widened candidate exclusions are detected');
  fx.editState(S => { S.pinned_exclusions = S.pinned_exclusions.filter(e => e !== 'src'); });
  fx.editState(S => { S.config.testCommands = { ok: { cmd: 'true' } }; });
  assert.equal(fx.gate('ship-ready', {}).out.code, 'config_drift', 'a swapped proof command is detected too');
  fx.editState(S => { S.config.testCommands = { ok: { cmd: process.execPath, args: ['-e', ''] } }; });
  assert.equal(fx.gate('review', passReview('rx-1', c)).out.code, 'review_accepted', 'with state and DAG agreeing the strict review passes');
  assert.equal(fx.readState().review_chain.length, 1);
});

test('A4: under the strict policy a review the engine did not dispatch never authorizes ship (review_provenance_unbound); an approved native primary ships labelled RELAXED', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(authorize(fx, 'publish').out.binding.assurance, 'STRICT');
  fx.editState(S => { S.review_bindings[0].provenance.primary = { provenance: 'native_unbound', claimed_identity: 'x' }; });
  denied(authorize(fx, 'publish'), 'review_provenance_unbound', 'a native primary under strict');
  const n = fx.cli('next').out.next_action;
  assert.deepEqual([n.reason, n.action, n.owner], ['review_provenance_unbound', 'owner_retry', 'human']);
  fx.editState(S => { S.review_bindings[0].provenance = 'unbound'; });
  denied(authorize(fx, 'publish'), 'review_provenance_unbound', 'a pre-E7 unbound label under strict');
  // The owner-approved opt-out: a native primary is accepted and every answer says RELAXED.
  const nat = enrollFixture(t, { config: { acceptNativeReview: true } });
  assert.equal(nat.cli('init', { dag: nat.dagFile }).status, 0);
  assert.equal(nat.cli('drive').status, 0);
  const c = nat.candidate();
  assert.equal(nat.dispatch('second', c).out.code, 'review_dispatched');
  const collected = nat.engineReview({ review_execution: 'rx-1', kind: 'original', second_opinion: secondOpinion(c) }).input; // collects the second
  const g = nat.gate('review', { review_execution: 'rx-1', kind: 'original', primary: primaryReview(c, { reviewer_identity: 'claude:native' }),
    second_opinion: collected.second_opinion ?? JSON.parse(readFileSync(nat.readState().review_dispatches[0].collected.parsed_file, 'utf8')), reconciliation: { dispositions: [] } }, { raw: true });
  assert.equal(g.out.code, 'review_accepted', g.stdout);
  assert.equal(nat.gate('ship-ready', {}).out.ok, true);
  nat.commitAll();
  const a = authorize(nat, 'publish');
  assert.deepEqual([a.out.allow, a.out.binding.assurance], [true, 'RELAXED'], a.stdout);
  assert.deepEqual(nat.cli('next').out.assurance.unbound_reviews, ['original rx-1'], 'the native review is named');
});

// ------------------------------------------------------------------ B6 (Codex HIGH 2): the receipt's base

test('B6: an old receipt after the base moved under an unchanged candidate id is review_receipt_base; the binding never takes the new base', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const c = fx.candidate();
  const input = passReview('rx-1', c);
  const reviewed = fx.engineReview(input).input; // dispatched and collected against the current merge base
  fx.okGit(['checkout', '-q', 'trunk']);
  writeFileSync(join(fx.repo, 'trunk.txt'), 'upstream change outside the patch');
  fx.okGit(['add', 'trunk.txt']);
  fx.okGit(['commit', '-q', '-m', 'trunk']);
  fx.okGit(['checkout', '-q', 'T-1-work']);
  fx.okGit(['merge', '-q', '--ff-only', 'trunk']);
  assert.equal(fx.candidate(), c, 'the candidate id is unchanged against the new merge base');
  const g = fx.gate('review', reviewed, { raw: true });
  assert.deepEqual([g.out.ok, g.out.code], [false, 'review_receipt_base'], g.stdout);
  assert.equal((fx.readState().review_bindings ?? []).length, 0, 'nothing bound');
  // Not a dead end: next owes a dispatch for the new base, and the old receipt does not block it.
  const n = fx.cli('next').out.next_action;
  assert.deepEqual([n.stage, n.action], ['REVIEW', 'review_dispatch'], J(n));
  const again = fx.engineReview(input).input;
  assert.equal(fx.gate('review', again, { raw: true }).out.code, 'review_accepted', 'a review dispatched against the new base is accepted');
  assert.equal(fx.readState().review_bindings[0].merge_base, fx.okGit(['merge-base', 'HEAD', 'trunk']).stdout.trim(), 'bound to the base its receipts reviewed');
});

// ------------------------------------------------------------------ N3: complete re-verifies the remote head

test('N3: with no PR, complete needs the remote branch at the published head: a later push is ci_remote_moved at collection and at authorize complete', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(fx.cli('publish').out.code, 'published');
  const head = fx.head();
  const provider = { name: 'fake', checkRuns: (sha) => ({ ok: true, runs: [{ id: 1, name: 'test', head_sha: sha, status: 'completed', conclusion: 'success', started_at: 't', completed_at: 't' }], total: 1 }),
    pullRequest: () => ({ ok: false, error: 'none' }), recentRuns: () => ({ ok: true, runs: [] }) };
  const ev = await ci({ ...fx.ctx(), ciProvider: provider });
  assert.deepEqual([ev.state, ev.remote_head], ['PASS', head]);
  assert.equal(authorize(fx, 'complete').out.allow, true);
  // Someone pushes another commit to the published branch (no guard here): the PR would ship it, the CI evidence is of the old head.
  fx.okGit(['checkout', '-q', '-b', 'other']);
  writeFileSync(join(fx.repo, 'later.txt'), 'pushed after the CI');
  fx.commitAll('later');
  fx.okGit(['push', '-q', 'origin', 'HEAD:refs/heads/T-1-work']);
  fx.okGit(['checkout', '-q', 'T-1-work']);
  denied(authorize(fx, 'complete'), 'ci_remote_moved', 'authorize complete re-reads the remote branch');
  const again = await ci({ ...fx.ctx(), ciProvider: provider });
  assert.deepEqual([again.state, again.code], ['STALE', 'ci_remote_moved']);
});

// ------------------------------------------------------------------ N4: pinned relay and gh

test('N4: the relay home is the OS account home, never $HOME; the first dispatch pins the relay, and changed relay bytes are review_relay_drift', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  const saved = process.env.HOME;
  try {
    process.env.HOME = fx.relayHome; // a HOME override that holds a (fake) relay
    assert.equal(relayHome(), userInfo().homedir, 'the home comes from the OS account');
    assert.ok(!String(relayPath('claude-delegate') ?? '').startsWith(fx.relayHome), 'an overridden HOME never selects the relay');
  } finally { process.env.HOME = saved; }
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  writeFileSync(join(fx.root, 'relay-behaviour.json'), J({ 'claude-delegate': { status: 'failed', exit: 1 } }));
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched');
  const pin = fx.readState().relay_pins['claude-delegate'];
  assert.ok(pin.path.startsWith(fx.relayHome) && pin.sha256.startsWith('sha256:'), J(pin));
  await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'envelope');
  assert.equal(fx.cli('review-collect').status, 0);
  const relay = join(fx.relayHome, '.agents', 'skills', 'claude-delegate', 'scripts', 'relay.mjs');
  const bytes = readFileSync(relay);
  writeFileSync(relay, Buffer.concat([bytes, Buffer.from('\n// replaced\n')]));
  const d = fx.dispatch('primary');
  assert.deepEqual([d.status, d.out.code], [2, 'review_relay_drift'], d.stdout);
  writeFileSync(relay, bytes);
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched', 'the pinned bytes dispatch again');
  await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'envelope');
});

test('N4: ci runs the gh pinned at enroll: a stub gh put first on PATH later is never run; changed gh bytes are gh_drift', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(fx.cli('publish').out.code, 'published');
  const pin = fx.readState().enrollment.tools.gh;
  assert.equal(pin.path, realpathSync(join(fx.root, 'bin', 'gh')));
  const stub = join(fx.root, 'stub-bin');
  mkdirSync(stub);
  writeFileSync(join(stub, 'gh'), `#!/bin/sh\ntouch ${JSON.stringify(join(fx.root, 'stub-ran'))}\necho '{"total_count":1}'\necho '{"id":1,"name":"test","head_sha":"x","status":"completed","conclusion":"success"}'\n`);
  chmodSync(join(stub, 'gh'), 0o755);
  const path = fx.env.PATH;
  fx.env.PATH = `${stub}:${path}`;
  fx.env.Path = fx.env.PATH;
  try {
    fx.scriptCi({ checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'in_progress', conclusion: null, started_at: 't' }] }] });
    const r = fx.cli('ci');
    assert.equal(r.out?.state, 'PENDING', r.stdout + r.stderr);
    assert.equal(existsSync(join(fx.root, 'stub-ran')), false, 'the PATH stub never ran');
    assert.ok(fx.ghLog().some(a => a[0] === 'api'), 'the pinned (fixture) gh answered');
  } finally { fx.env.PATH = path; fx.env.Path = path; }
  appendFileSync(pin.path, '\n# changed\n');
  const d = fx.cli('ci');
  assert.deepEqual([d.status, d.out?.code], [2, 'gh_drift'], d.stdout);
});

// ------------------------------------------------------------------ N2: no review shopping

test('N2: a collected FAIL (or a failed reviewer) for a prior candidate blocks later dispatches until it is gated or the owner RETRY names it', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const c1 = fx.candidate();
  writeFileSync(join(fx.root, 'relay-behaviour.json'), J({ 'claude-delegate': { final: finalMessage(reviewBody(primaryReview(c1, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }] }))) } }));
  const p = fx.dispatch('primary', c1);
  assert.equal(p.out.code, 'review_dispatched');
  await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'envelope');
  assert.equal(fx.cli('review-collect').status, 0);
  assert.equal(fx.readState().review_dispatches[0].collected.outcome, 'FAIL');
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'a1 '); // a trivial edit: a new candidate
  const c2 = fx.candidate();
  for (const role of ['primary', 'second']) {
    const d = fx.dispatch(role, c2);
    assert.deepEqual([d.status, d.out.code], [2, 'review_fail_unconsumed'], `${role}: ${d.stdout}`);
  }
  const n = fx.cli('next');
  assert.deepEqual([n.out.next_action.reason, n.out.next_action.owner, n.out.stop, n.status], ['review_fail_unconsumed', 'human', true, 2], 'next stops for the owner (no dispatch livelock)');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-x', predecessor: p.out.receipt.attempt_id, authorized_by: 'owner' });
  assert.equal(fx.dispatch('primary', c2).out.code, 'review_dispatched', 'the owner RETRY naming the FAIL releases it');
  await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'envelope');
});

// ------------------------------------------------------------------ B10: result.json substituted before collection

test('B10: a result.json replaced between the reviewer exit and collection is never collected (review_output_substituted); next blocks the stage', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  const c = fx.candidate();
  writeFileSync(join(fx.root, 'relay-behaviour.json'), J({ 'claude-delegate': { final: finalMessage(reviewBody(primaryReview(c, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }] }))) } }));
  assert.equal(fx.dispatch('primary', c).out.code, 'review_dispatched');
  await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'envelope');
  const d = fx.readState().review_dispatches[0];
  assert.match(JSON.parse(readFileSync(fx.readState().attempts.find(a => a.kind === 'review').envelope_file, 'utf8')).file_digests[d.result_file], /^sha256:/, 'hashed at exit');
  writeFileSync(d.result_file, J({ schema: 'delegate-relay.result.v1', status: 'completed', exitCode: 0, finalMessage: finalMessage(reviewBody(primaryReview(c))) }));
  assert.equal(fx.cli('review-collect').status, 0);
  const after = fx.readState().review_dispatches[0];
  assert.deepEqual([after.status, after.collected.parsed_file], ['failed', null]);
  assert.match(after.collected.parse_error, /^review_output_substituted/);
  assert.equal(fx.cli('next').out.next_action.reason, 'review_dispatch_failed');
});

// ------------------------------------------------------------------ C6: content, not commit metadata

test('C6: with config.base HEAD, committing the reviewed bytes before ship-ready, and the repaired bytes before the confirmation, keeps the candidate (content, not commits)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).out.code, 'review_accepted');
  fx.commitAll('reviewed bytes, before ship-ready');
  const sr = fx.gate('ship-ready', {});
  assert.equal(sr.out.ok, true, sr.stdout);
  assert.equal(authorize(fx, 'publish').out.allow, true);
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'changed content');
  fx.commitAll('a content change');
  assert.equal(fx.cli('next').out.review_freshness.code, 'review_stale', 'content still decides');

  const r = enrollFixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  assert.equal(r.cli('init', { dag: r.dagFile }).status, 0);
  assert.equal(r.cli('drive').status, 0);
  assert.equal(r.gate('review', failReview('rx-1', r.candidate(), 'src/a.txt', r.prompt('fix'))).out.code, 'review_accepted');
  assert.equal(r.cli('drive').status, 0, 'the repair');
  r.commitAll('repaired bytes, before the confirmation');
  const c = r.cli('next').out.next_action;
  assert.deepEqual([c.stage, c.action], ['CONFIRMATION', 'review_dispatch'], J({ c, freeze: r.readState().freeze, rc: r.readState().review_chain }));
  assert.equal(r.gate('review', confirmReview('rx-1', c.candidate_id)).out.code, 'review_accepted');
  assert.equal(r.gate('ship-ready', {}).out.ok, true);
  assert.equal(authorize(r, 'publish').out.allow, true);
});

// ------------------------------------------------------------------ C4, N7

test('C4: a context whose bytes could not be written is not recorded (context_emit_failed)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  fx.editState(S => { delete S.contexts.ship; });
  const r = await context({ ...fx.ctx(), phase: 'ship', emit: async () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); } });
  assert.deepEqual([r.delivered, r.recorded, r.code], [false, false, 'context_emit_failed']);
  assert.equal(fx.readState().contexts.ship, undefined, 'nothing recorded');
  let got = '';
  const ok = await context({ ...fx.ctx(), phase: 'ship', emit: async (text) => { got = text; } });
  assert.deepEqual([ok.recorded, got.includes('references/ship.md')], [true, true]);
});

test('N7: an enrollment with no captured repository or branch never authorizes publish', { skip: WIN_SKIP }, async (t) => {
  const fx = await shippable(t);
  assert.equal(authorize(fx, 'publish').out.allow, true);
  fx.editState(S => { S.enrollment.repo = null; });
  denied(authorize(fx, 'publish'), 'enrollment_repo_unknown');
  fx.editState(S => { S.enrollment.repo = fx.okGit(['rev-parse', '--show-toplevel']).stdout.trim(); S.enrollment.branch = null; });
  denied(authorize(fx, 'publish'), 'enrollment_branch_unknown');
});
