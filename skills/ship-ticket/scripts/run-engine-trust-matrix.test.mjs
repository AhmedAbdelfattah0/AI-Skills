/**
 * R0-S trust-boundary qualification matrix (batch 2). One adversarial negative test per boundary, STRICT policy, each combining
 * previously confirmed vulnerabilities; every row names the attack, the refusal code it must meet, and (in the batch report) the
 * mutation that proves it: delete the fix and the row fails. Drives the REAL engine CLI on temp repos with fakes only
 * (engine-enroll.test-helper.mjs); no real claude, codex or gh runs.
 *
 *  row  boundary                                   attack (combination)                                        refusal
 *  M1   git: history, base, destination, candidate  --base laundering + a reverted out-of-candidate commit;       pr_base_unbound, history_outside_candidate,
 *                                                   one ticket's sha pushed to another ticket's branch           cross_ticket_push, candidate_stale
 *  M2   reviewer executable, receipts, result       a PATH stub claude after the pin + a valid receipt/pin;      (stub never runs), review_cli_drift,
 *                                                   then the pinned CLI replaced; result.json substituted        review_output_substituted
 *  M3   CI repository, check identity, exact head   GH_REPO at a fork + green answers of the fork; green runs     ci_repo_mismatch, (not PASS: ci_no_checks_yet)
 *                                                   of a stale SHA on the right repository
 *  M4   policy authority, downgrade                 a policy line hidden in a comment + a state downgrade        policy_unapproved, policy_drift
 *  M5   review-failure history, anti-shopping       a FAIL in flight + the base moved under the same id         review_dispatch_live, review_fail_unconsumed
 *  M6   recoverable refusals, bounded continuation  the shopping refusal + an owner RETRY; a repeated refusal    BLOCKED human (stop), then READY dispatch
 *  M7   strict end to end                           build -> FAIL -> repair -> confirmation -> publish -> CI     COMPLETED (allow at every gate)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, failReview, confirmReview, primaryReview, passReview } from './engine-test-fixture.mjs';
import { enrollFixture, GITHUB_SLUG } from './engine-enroll.test-helper.mjs';
import { finalMessage, reviewBody } from './engine-review.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';
import { policyLine } from './engine-dag.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const authorize = (fx, stage, extra = {}) => fx.cli('authorize', { stage, ...extra });
const code = (r) => r.out?.code;
const started = (fx) => { assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0); assert.equal(fx.cli('drive').status, 0); };
const reviewersDone = (fx) => waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review').every(a => existsSync(a.envelope_file)), 'reviewer envelopes');
const relay = (fx, b) => writeFileSync(join(fx.root, 'relay-behaviour.json'), J(b));
const failPrimary = (c, extra = {}) => ({ 'claude-delegate': { ...extra, final: finalMessage(reviewBody(primaryReview(c, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }] }))) } });
const next = (fx) => { const n = fx.cli('next'); return { ...n.out.next_action, stop: n.out.stop }; };
const PASS = (sha = '$SHA') => ({ checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: sha, status: 'completed', conclusion: 'success', started_at: 's', completed_at: 'c' }] }] });

test('M1 git: --base laundering combined with a reverted out-of-candidate commit, a cross-ticket destination and a changed candidate are each refused', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  writeFileSync(join(fx.repo, 'docs', 'wip.txt'), 'UNREVIEWED');
  fx.okGit(['add', 'docs/wip.txt']);
  fx.okGit(['commit', '-q', '-m', 'unreviewed']);
  fx.okGit(['branch', 'wipbase', 'HEAD']);
  await fx.toShipReady();
  fx.commitAll();
  writeFileSync(join(fx.repo, 'secret.txt'), 'token');
  fx.commitAll('smuggle');
  fx.okGit(['rm', '-q', 'secret.txt']);
  fx.commitAll('revert the smuggle');
  assert.equal(code(authorize(fx, 'publish', { base: 'wipbase' })), 'pr_base_unbound', 'the laundering base never reaches the history check');
  assert.equal(code(fx.cli('publish', { base: 'wipbase' })), 'pr_base_unbound');
  assert.equal(fx.remoteHead(), null, 'nothing pushed');
  // Without the laundering ref the smuggled path is caught by the history check from the frozen review base.
  const h = enrollFixture(t);
  await h.toShipReady();
  h.commitAll();
  writeFileSync(join(h.repo, 'secret.txt'), 'token');
  h.commitAll('smuggle');
  h.okGit(['rm', '-q', 'secret.txt']);
  h.commitAll('revert the smuggle');
  assert.equal(code(authorize(h, 'publish')), 'history_outside_candidate');
  assert.equal(code(authorize(h, 'publish', { base: h.defaultBranch })), 'history_outside_candidate', 'the bound base by name changes nothing');
  // Destination: one ticket's authorization never covers another ticket's branch (exact code: the destination is checked first).
  const g = spawnSync(process.execPath, [GUARD, 'install', '--repo', h.repo], { encoding: 'utf8', env: h.env });
  assert.equal(g.status, 0, g.stderr);
  const push = spawnSync('git', ['push', 'origin', 'T-1-work:refs/heads/T-2-work'], { cwd: h.repo, encoding: 'utf8', env: h.env });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /: cross_ticket_push:/);
  // Candidate identity: content changed after SHIP_READY.
  writeFileSync(join(h.repo, 'src', 'a.txt'), 'changed after ship-ready');
  h.commitAll('edit');
  assert.equal(code(authorize(h, 'publish')), 'candidate_stale');
});

test('M2 reviewer: a PATH stub claude after the pin, with a valid receipt and relay pin, never runs; the replaced pinned CLI is review_cli_drift; a substituted result.json is never collected', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  relay(fx, { 'claude-delegate': { status: 'failed', exit: 1 } });
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched'); // pins the claude relay and the claude CLI
  await reviewersDone(fx);
  assert.equal(fx.cli('review-collect').status, 0);
  const pin = fx.readState().review_cli_pins.claude;
  const stub = join(fx.root, 'stub-bin');
  mkdirSync(stub);
  writeFileSync(join(stub, 'claude'), `#!/bin/sh\ntouch ${J(join(fx.root, 'stub-ran'))}\n`);
  chmodSync(join(stub, 'claude'), 0o755);
  const path = fx.env.PATH;
  fx.env.PATH = `${stub}:${path}`;
  let receipt;
  try {
    receipt = fx.dispatch('primary').out.receipt;
    await reviewersDone(fx);
  } finally { fx.env.PATH = path; }
  assert.equal(receipt.cli.path, pin.path, 'the receipt names the pinned CLI');
  const log = readFileSync(join(fx.root, 'relay.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
  assert.equal(log.cli_path, pin.path, 'the relay resolved the pinned CLI through the engine shim');
  assert.equal(existsSync(join(fx.root, 'stub-ran')), false, 'the stub never ran');
  assert.equal(fx.cli('review-collect').status, 0);
  appendFileSync(pin.path, '\n# replaced\n');
  assert.equal(fx.dispatch('primary').out.code, 'review_cli_drift');
  // Result binding: result.json substituted between the reviewer exit and collection is never collected (B10).
  const r = enrollFixture(t);
  started(r);
  const rc = r.candidate();
  relay(r, failPrimary(rc));
  assert.equal(r.dispatch('primary', rc).out.code, 'review_dispatched');
  await reviewersDone(r);
  const d = r.readState().review_dispatches[0];
  writeFileSync(d.result_file, J({ schema: 'delegate-relay.result.v1', status: 'completed', exitCode: 0, finalMessage: finalMessage(reviewBody(primaryReview(rc))) }));
  assert.equal(r.cli('review-collect').status, 0);
  assert.match(r.readState().review_dispatches[0].collected.parse_error, /^review_output_substituted/);
});

test('M3 CI: GH_REPO at a fork plus green answers of the fork is ci_repo_mismatch; green runs of a stale SHA on the published repository never PASS', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  await fx.toShipReady();
  fx.commitAll();
  assert.equal(fx.cli('publish').out.code, 'published');
  Object.assign(fx.env, { GH_REPO: 'evil/fork', GH_HOST: 'github.com' });
  fx.scriptCi({ ...PASS(), htmlRepo: 'github.com/evil/fork' });
  const f = fx.cli('ci');
  assert.deepEqual([f.out.state, f.out.code], ['UNAVAILABLE', 'ci_repo_mismatch'], f.stdout);
  assert.equal(fx.ghEnvLog().at(-1).GH_REPO, undefined, 'GH_REPO never reaches gh');
  assert.equal(code(authorize(fx, 'complete')), 'ci_repo_mismatch');
  // The right repository, green, but for a stale SHA (the previous head): ignored, never this head's success.
  fx.scriptCi(PASS('0'.repeat(40)));
  const s = fx.cli('ci');
  assert.deepEqual([s.out.state, s.out.considered, s.out.ignored_other_sha, s.out.repository], ['PENDING', 0, 1, GITHUB_SLUG], s.stdout);
  assert.notEqual(authorize(fx, 'complete').out.allow, true);
});

test('M4 policy: a relaxed line hidden in an HTML comment is never approval, and a state downgrade after init is policy_drift', { skip: WIN_SKIP }, (t) => {
  const relaxed = { reviewProvenance: 'unbound' };
  const hidden = fixture(t, { commit: true, config: relaxed, approvePolicy: false, narrativeExtra: `<!-- approved:\n${policyLine(relaxed)}\n-->\n\n`, admit: false });
  const n = hidden.cli('next', { dag: hidden.dagFile }).out;
  assert.deepEqual([n.next_action.disposition, n.next_action.reason, n.stop], ['NEEDS_APPROVAL', 'policy_unapproved', true]);
  assert.equal(hidden.cli('init', { dag: hidden.dagFile }).status, 1);
  // A strict run, downgraded in state: refused everywhere (the bound DAG decides), labelled for the human.
  const fx = enrollFixture(t);
  started(fx);
  fx.editState(S => { S.config.reviewProvenance = 'unbound'; });
  const g = fx.gate('review', passReview('rx-1', fx.candidate()), { raw: true });
  assert.deepEqual([g.out.ok, g.out.code], [false, 'policy_drift']);
  assert.deepEqual((({ reason, owner, stop }) => [reason, owner, stop])(next(fx)), ['policy_drift', 'human', true]);
});

test('M5 anti-shopping: a FAIL still in flight while the base moves under the same candidate id: review_dispatch_live, then review_fail_unconsumed (dispatch, gate)', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { base: 'trunk' });
  started(fx);
  const c = fx.candidate();
  relay(fx, failPrimary(c, { sleep_ms: 5000 }));
  assert.equal(fx.dispatch('primary', c).out.code, 'review_dispatched');
  fx.okGit(['checkout', '-q', 'trunk']);
  writeFileSync(join(fx.repo, 'trunk.txt'), 'upstream');
  fx.okGit(['add', 'trunk.txt']);
  fx.okGit(['commit', '-q', '-m', 'trunk']);
  fx.okGit(['push', '-q', 'origin', 'trunk']); // the upstream moved (round 3: the base is the remote's commit)
  fx.okGit(['checkout', '-q', 'T-1-work']);
  fx.okGit(['merge', '-q', '--ff-only', 'trunk']);
  assert.equal(fx.candidate(), c);
  assert.equal(fx.dispatch('second', c).out.code, 'review_dispatch_live', 'a reviewer of the old base is still running');
  await reviewersDone(fx);
  assert.equal(fx.cli('review-collect').status, 0);
  relay(fx, { 'claude-delegate': { final: finalMessage(reviewBody(primaryReview(c))) }, 'codex-delegate': { final: finalMessage({ findings: [], overflow: false, outcome: 'PASS' }) } });
  for (const role of ['primary', 'second']) assert.equal(fx.dispatch(role, c).out.code, 'review_fail_unconsumed', role);
  assert.deepEqual((({ reason, owner, stop }) => [reason, owner, stop])(next(fx)), ['review_fail_unconsumed', 'human', true]);
});

test('M6 bounded continuation: the shopping refusal stops next for the human (no dispatch loop); an owner RETRY naming the FAIL makes the dispatch READY and it runs', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t);
  started(fx);
  const c1 = fx.candidate();
  relay(fx, failPrimary(c1));
  const p = fx.dispatch('primary', c1);
  await reviewersDone(fx);
  assert.equal(fx.cli('review-collect').status, 0);
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'edited to shop');
  const c2 = fx.candidate();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const n = next(fx);
    seen.push([n.reason, n.owner, n.stop]);
    if (!n.stop && n.action === 'review_dispatch') fx.dispatch('primary', c2);
  }
  assert.deepEqual(seen, Array(3).fill(['review_fail_unconsumed', 'human', true]), J(seen));
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-r', predecessor: p.out.receipt.attempt_id, authorized_by: 'owner' });
  const n = next(fx);
  assert.deepEqual([n.stage, n.action, n.disposition], ['REVIEW', 'review_dispatch', 'READY'], J(n));
  assert.equal(fx.dispatch('primary', c2).out.code, 'review_dispatched');
  await reviewersDone(fx);
});

test('M7 strict end to end: build -> engine-dispatched FAIL -> repair -> engine confirmation -> ship-ready -> publish -> CI -> complete', { skip: WIN_SKIP }, async (t) => {
  const fx = enrollFixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  started(fx);
  assert.equal(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))).out.code, 'review_accepted');
  assert.equal(fx.cli('drive').status, 0);
  const n = next(fx);
  assert.deepEqual([n.stage, n.action], ['CONFIRMATION', 'review_dispatch'], J(n));
  assert.equal(fx.gate('review', confirmReview('rx-1', n.candidate_id)).out.code, 'review_accepted');
  assert.equal(fx.gate('ship-ready', {}).out.ok, true);
  fx.commitAll();
  assert.equal(authorize(fx, 'publish').out.binding.assurance, 'STRICT');
  assert.equal(fx.cli('publish').out.code, 'published');
  fx.scriptCi(PASS());
  assert.equal(fx.cli('ci').out.state, 'PASS');
  const done = fx.cli('next');
  assert.deepEqual([done.out.disposition, done.status, done.out.assurance.level], ['COMPLETED', 0, 'STRICT'], done.stdout);
  assert.ok(fx.readState().review_bindings.filter(b => b.provenance && typeof b.provenance === 'object').every(b => Object.values(b.provenance).every(p => p.provenance === 'engine_relay')));
});
