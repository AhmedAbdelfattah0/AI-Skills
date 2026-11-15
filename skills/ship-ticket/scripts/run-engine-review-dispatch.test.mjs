/**
 * P0 slice E7: trusted reviewer dispatch and collection (engine-review-dispatch.mjs). Drives the REAL engine CLI on a
 * temp repo (engine-enroll.test-helper.mjs: fake provider, fake gh, local bare remote, a fake HOME). The reviewers are
 * FAKE relays installed by name under that HOME ($HOME/.agents/skills/<claude|codex>-delegate/scripts/relay.mjs):
 * they read the engine's brief on stdin, log one line per launch (with whether the receipt was already durable and
 * whether the brief is the one the receipt hashed), and write a relay result.json. No real claude or codex runs.
 *
 * The DAG carries no config.reviewProvenance, so the default ('engine') applies: gate review accepts a review only
 * when it is the collected output of an engine-dispatched reviewer for the candidate under review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { POSIX, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';
import { reviewDispatch } from './run-engine.mjs';
import { provenanceVerdict, PROVENANCE_CHECKS, contentDigest, canonical, owedReview, extractReview } from './engine-review-dispatch.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const J = JSON.stringify;
const sha = (b) => 'sha256:' + createHash('sha256').update(b).digest('hex');

/** The fake relay: one file serves both skills (its skill is its install directory's name). */
const FAKE_RELAY = (root) => `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const skill = basename(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const outDir = val('--out-dir'), cd = val('--cd');
const brief = readFileSync(0, 'utf8');
const rel = spawnSync('git', ['rev-parse', '--git-path', 'ai-skills/ship-ticket/T-1.state.json'], { cwd: cd, encoding: 'utf8' }).stdout.trim();
let receipt = null;
try { receipt = (JSON.parse(readFileSync(resolve(cd, rel), 'utf8')).review_dispatches ?? []).find(d => d.out_dir === outDir) ?? null; } catch {}
const briefSha = 'sha256:' + createHash('sha256').update(brief).digest('hex');
appendFileSync(${J(join(root, 'relay.log'))}, JSON.stringify({ skill, args, receipt_seen: Boolean(receipt), brief_matches: receipt?.prompt_sha256 === briefSha,
  brief_has_candidate: Boolean(receipt && brief.includes(receipt.candidate_id)) }) + '\\n');
let all = {};
try { all = JSON.parse(readFileSync(${J(join(root, 'relay-behaviour.json'))}, 'utf8')); } catch {}
const b = all[skill] ?? {};
if (b.sleep_ms) await new Promise(r => setTimeout(r, b.sleep_ms));
const exitCode = b.exit ?? 0;
writeFileSync(join(outDir, 'result.json'), JSON.stringify({ schema: 'delegate-relay.result.v1', status: b.status ?? 'completed', exitCode,
  finalMessage: b.final ?? '' }));
process.exit(exitCode);
`;

/** A primary review as the reviewer writes it (no engine fields). */
const primaryBody = (over = {}) => { const { reviewer_identity: _i, candidate_id: _c, ...p } = primaryReview('x', over); return p; };
const secondBody = (over = {}) => { const { reviewer_identity: _i, candidate_id: _c, route: _r, ...p } = secondOpinion('x', over); return p; };
const final = (obj) => 'Review done.\n```json\n' + J(obj, null, 2) + '\n```\n';
/** What the fake primary reviewer writes by default: its own evidence, so a hand-written fixture review differs in content. */
const RELAY_PRIMARY = () => primaryBody({ rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'relay read src/a.txt:1' }] });
/** A second opinion whose content no engine reviewer produced in these tests (gate matching is by content). */
const otherSecond = (c, over = {}) => secondOpinion(c, { findings: [{ id: 'X1', severity: 'minor', paths: ['src/a.txt'] }], ...over });

/** enrollFixture with the default (engine) review provenance, a mapped builder model (claude:sonnet) and fake relays. */
function e7Fixture(t, { relays = ['claude-delegate', 'codex-delegate'], config = {}, behaviour } = {}) {
  const fx = enrollFixture(t, { config: { reviewProvenance: undefined, modelMap: { inherit: 'sonnet' }, ...config }, ...(behaviour ? { behaviour } : {}) });
  const home = fx.env.HOME;
  fx.installRelay = (skill) => { const d = join(home, '.agents', 'skills', skill, 'scripts'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'relay.mjs'), FAKE_RELAY(fx.root)); };
  fx.removeRelay = (skill) => rmSync(join(home, '.agents', 'skills', skill), { recursive: true, force: true });
  for (const r of relays) fx.installRelay(r);
  fx.relayBehave = (b) => writeFileSync(join(fx.root, 'relay-behaviour.json'), J(b));
  fx.relayBehave({ 'claude-delegate': { final: final(RELAY_PRIMARY()) }, 'codex-delegate': { final: final(secondBody()) } });
  fx.relayLog = () => (existsSync(join(fx.root, 'relay.log')) ? readFileSync(join(fx.root, 'relay.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  fx.dispatch = (role, candidate = fx.candidate()) => fx.cli('review-dispatch', { role, candidate });
  fx.dispatches = () => fx.readState().review_dispatches ?? [];
  /** Wait for every dispatched reviewer's envelope, then review-collect. */
  fx.collectAll = async () => {
    await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review' && ['launched', 'running'].includes(a.status)).every(a => existsSync(a.envelope_file)), 'reviewer envelopes');
    const r = fx.cli('review-collect');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.out;
  };
  fx.parsed = (role) => JSON.parse(readFileSync(fx.dispatches().findLast(d => d.role === role).collected.parsed_file, 'utf8'));
  fx.original = (rx, over = {}) => ({ review_execution: rx, kind: 'original', primary: over.primary ?? fx.parsed('primary'),
    second_opinion: over.second_opinion ?? fx.parsed('second'), reconciliation: { dispositions: [] }, ...over });
  fx.built = () => {
    for (const [cmd, f] of [['init', { dag: fx.dagFile }], ['drive', {}]]) { const r = fx.cli(cmd, f); assert.equal(r.status, 0, `${cmd}: ${r.stdout.slice(0, 400)}${r.stderr}`); }
  };
  fx.reviewed = async () => {
    fx.built();
    for (const role of ['primary', 'second']) { const d = fx.dispatch(role); assert.equal(d.out.code, 'review_dispatched', d.stdout + d.stderr); }
    await fx.collectAll();
  };
  return fx;
}

const refused = (g, code, why) => assert.deepEqual([g.out?.ok, g.out?.code], [false, code], `${why}: ${g.stdout}${g.stderr}`);
const engineLog = (fx) => readFileSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'T-1.engine.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// ------------------------------------------------------------------ the supported path

test('dispatch -> collect -> gate PASS: the receipt is durable before launch, the argv and brief are the engine\'s, identities come from the receipt', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  fx.built();
  const c = fx.candidate();
  const p = fx.dispatch('primary', c);
  assert.deepEqual([p.status, p.out.code, p.out.receipt.requested_identity, p.out.receipt.candidate_id], [0, 'review_dispatched', 'claude:opus', c], p.stdout + p.stderr);
  const s = fx.dispatch('second', c);
  assert.deepEqual([s.status, s.out.code, s.out.receipt.requested_identity], [0, 'review_dispatched', 'codex:provider-default'], s.stdout + s.stderr);
  for (const k of ['attempt_id', 'role', 'requested_identity', 'candidate_id', 'argv_sha256', 'prompt_sha256', 'started_at']) assert.ok(p.out.receipt[k], `receipt.${k}`);
  await fx.collectAll(); // the second dispatch may already have collected a fast primary: what matters is that both are, once
  assert.deepEqual(fx.dispatches().map(x => [x.role, x.status]).sort(), [['primary', 'collected'], ['second', 'collected']]);
  const log = fx.relayLog();
  assert.deepEqual(log.map(l => l.skill).sort(), ['claude-delegate', 'codex-delegate'], 'one launch per role');
  assert.ok(log.every(l => l.receipt_seen && l.brief_matches && l.brief_has_candidate), `the receipt preceded each launch and hashed its brief: ${J(log)}`);
  assert.ok(log.every(l => l.args.includes('--read-only') && l.args.includes('--out-dir')), 'read-only relay, engine-chosen out-dir');
  assert.ok(log.find(l => l.skill === 'claude-delegate').args.join(' ').includes('--model opus'));
  const S = fx.readState();
  for (const d of S.review_dispatches) {
    assert.equal(d.argv_sha256, sha(J(d.argv)), 'argv_sha256 hashes the launched argv');
    assert.equal(d.prompt_sha256, sha(readFileSync(d.prompt_file)), 'prompt_sha256 hashes the brief file');
    assert.equal(d.collected.output_sha256, sha(readFileSync(d.result_file)), 'output_sha256 hashes the relay result');
    assert.equal(d.collected.parsed_result_sha256, sha(canonical(JSON.parse(readFileSync(d.collected.parsed_file, 'utf8')))));
    assert.ok(d.relay.startsWith(fx.env.HOME), 'the relay was found by name under $HOME');
  }
  assert.equal(fx.parsed('primary').reviewer_identity, 'claude:opus', 'identity written from the receipt');
  const g = fx.gate('review', fx.original('rx-1'));
  assert.deepEqual([g.status, g.out.code], [0, 'review_accepted'], g.stdout + g.stderr);
  const after = fx.readState();
  assert.deepEqual([after.review_chain[0].reviewer_identity, after.review_chain[0].second_opinion_route], ['claude:opus', 'codex']);
  assert.deepEqual(Object.values(after.review_bindings[0].provenance).map(x => [x.provenance, x.role]), [['engine_relay', 'primary'], ['engine_relay', 'second']]);
  assert.ok(after.review_dispatches.every(d => d.consumed_by === 'rx-1'), 'both receipts are consumed');
  const events = engineLog(fx).map(e => e.event);
  assert.deepEqual([events.filter(e => e === 'REVIEW_DISPATCHED').length, events.filter(e => e === 'REVIEW_COLLECTED').length], [2, 2]);
  const n = fx.cli('next').out;
  assert.deepEqual([n.stages.REVIEW.disposition, n.next_action.stage], ['COMPLETED', 'SHIP_READY']);
  assert.equal(fx.gate('ship-ready', {}).out.ok, true);
  const again = fx.dispatch('primary', c);
  assert.deepEqual([again.status, again.out.code], [2, 'review_not_owed'], 'a recorded PASS owes no review');
});

// ------------------------------------------------------------------ forged and edited review files

test('a hand-written review with a valid-looking identity, an edited collected file and the copied-candidate file (the pinned E3 residual) are refused review_unbound', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  await fx.reviewed();
  const c = fx.candidate();
  refused(fx.gate('review', { review_execution: 'rx-1', kind: 'original', primary: primaryReview(c, { reviewer_identity: 'claude:opus' }),
    second_opinion: secondOpinion(c, { reviewer_identity: 'codex:provider-default' }), reconciliation: { dispositions: [] } }), 'review_unbound', 'forged JSON naming the receipt identities');
  // The pinned residual of E3: a review file that merely copies the current candidate id.
  refused(fx.gate('review', { review_execution: 'rx-1', kind: 'original', primary: primaryReview(c), second_opinion: secondOpinion(c), reconciliation: { dispositions: [] } }),
    'review_unbound', 'copied candidate id');
  const edited = fx.parsed('primary');
  edited.rule_rows[0].evidence = 'edited after collection';
  refused(fx.gate('review', fx.original('rx-1', { primary: edited })), 'review_unbound', 'an edited collected review');
  refused(fx.gate('review', fx.original('rx-1', { second_opinion: otherSecond(c, { route: 'coderabbit', reviewer_identity: 'coderabbit:cli' }) })), 'review_unbound',
    'a CodeRabbit second opinion never substitutes for the engine\'s Codex relay');
  refused(fx.gate('review', fx.original('rx-1', { second_opinion: secondOpinion(c, { route: 'coderabbit', reviewer_identity: 'coderabbit:cli' }) })), 'review_identity_spoofed',
    'content equal to the Codex collection but naming another route and identity');
  assert.equal(fx.readState().review_chain.length, 0, 'nothing recorded');
  assert.equal(fx.gate('review', fx.original('rx-1')).out.code, 'review_accepted', 'the collected files are still accepted');
});

test('identity comes from the receipt: a spoofed identity, candidate or route in the review JSON, and a role swap, are refused with their own codes', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  fx.relayBehave({ 'claude-delegate': { final: final({ ...primaryBody(), reviewer_identity: 'codex:gpt-5' }) }, 'codex-delegate': { final: final(secondBody()) } });
  await fx.reviewed();
  const prim = fx.parsed('primary');
  assert.equal(prim.reviewer_identity, 'claude:opus', 'the reviewer\'s own identity claim is overwritten');
  assert.equal(fx.dispatches().find(d => d.role === 'primary').collected.claimed_reviewer_identity, 'codex:gpt-5', 'and kept as DETECTED');
  refused(fx.gate('review', fx.original('rx-1', { second_opinion: { ...fx.parsed('second'), reviewer_identity: 'opus:review' } })), 'review_identity_spoofed', 'second opinion identity');
  refused(fx.gate('review', fx.original('rx-1', { second_opinion: { ...fx.parsed('second'), route: 'claude' } })), 'review_identity_spoofed', 'route');
  refused(fx.gate('review', fx.original('rx-1', { primary: { ...prim, candidate_id: 'sha256:other' } })), 'review_identity_spoofed', 'candidate claim');
  refused(fx.gate('review', fx.original('rx-1', { primary: fx.parsed('second'), second_opinion: fx.parsed('second') })), 'review_role_mismatch', 'the second opinion\'s output as the primary');
  // Two roles launched with the same identity (the ledger says so): never two reviewers.
  fx.editState(S => { S.review_dispatches.find(d => d.role === 'second').requested_identity = 'claude:opus'; });
  refused(fx.gate('review', fx.original('rx-1')), 'review_identity_shared', 'shared identity');
  assert.equal(fx.readState().review_chain.length, 0);
});

test('a relay output changed after collection is review_output_changed; a consumed receipt is review_receipt_spent', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  await fx.reviewed();
  const d = fx.dispatches().find(x => x.role === 'primary');
  const kept = readFileSync(d.result_file);
  writeFileSync(d.result_file, kept.toString().replace('"completed"', '"completed" '));
  refused(fx.gate('review', fx.original('rx-1')), 'review_output_changed', 'result.json rewritten');
  writeFileSync(d.result_file, kept);
  const input = fx.original('rx-1');
  assert.equal(fx.gate('review', input).out.code, 'review_accepted');
  // An owner RETRY of the same candidate: the consumed receipts never count again.
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  assert.equal(fx.cli('next').out.next_action.action, 'review_dispatch', 'the RETRY makes a new engine dispatch owed');
  refused(fx.gate('review', { ...input, review_execution: 'rx-2' }), 'review_receipt_spent', 'replayed receipts');
});

// ------------------------------------------------------------------ candidates (E3)

test('stale candidate after dispatch: the receipt is for another candidate (review_receipt_candidate); next owes a dispatch for the current one', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  await fx.reviewed();
  const c1 = fx.candidate();
  writeFileSync(join(fx.repo, 'src', 'late.txt'), 'changed after the dispatch');
  const c2 = fx.candidate();
  assert.notEqual(c1, c2);
  refused(fx.gate('review', fx.original('rx-1')), 'review_receipt_candidate', 'receipts of c1 for a review of c2');
  const n = fx.cli('next').out.next_action;
  assert.deepEqual([n.stage, n.action, n.candidate_id, n.roles], ['REVIEW', 'review_dispatch', c2, ['primary', 'second']], J(n));
  const old = fx.dispatch('primary', c1);
  assert.deepEqual([old.status, old.out.code], [2, 'review_candidate_mismatch'], 'a dispatch for a stale candidate is refused');
});

// ------------------------------------------------------------------ resume

test('an interrupted dispatch: next collects the finished reviewers exactly once; a dispatch that never launched is abandoned and owed again', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  fx.relayBehave({ 'claude-delegate': { final: final(primaryBody()), sleep_ms: 4000 }, 'codex-delegate': { final: final(secondBody()), sleep_ms: 4000 } });
  fx.built();
  // A dispatch that crashed after its receipt and before launch (in process: the boundary throws).
  await assert.rejects(reviewDispatch(fx.ctx({ role: 'primary', candidate: fx.candidate(), hooks: { boundary: (name) => { if (name === 'review-after-receipt') throw new Error('crash'); } } })), /crash/);
  assert.equal(fx.relayLog().length, 0, 'nothing launched');
  assert.equal(fx.readState().attempts.find(a => a.kind === 'review').status, 'intent');
  const n0 = fx.cli('next').out;
  assert.equal(fx.dispatches()[0].status, 'abandoned', 'the never-released dispatch is abandoned');
  assert.deepEqual([n0.next_action.action, n0.next_action.roles], ['review_dispatch', ['primary', 'second']], J(n0.next_action));
  for (const role of ['primary', 'second']) assert.equal(fx.dispatch(role).out.code, 'review_dispatched');
  const dup = fx.dispatch('primary');
  assert.deepEqual([dup.status, dup.out.code], [2, 'review_dispatch_live'], 'a second launch of a live role is refused');
  const waiting = fx.cli('next').out.next_action;
  assert.deepEqual([waiting.stage, waiting.disposition, waiting.reason], ['REVIEW', 'WAITING', 'review_in_flight'], J(waiting));
  // The orchestrator never calls review-collect (no notification): next finds the envelopes and collects.
  await waitFor(() => fx.readState().attempts.filter(a => a.kind === 'review' && a.status === 'running').every(a => existsSync(a.envelope_file)), 'envelopes');
  const n1 = fx.cli('next').out;
  assert.deepEqual(n1.collected.map(x => x.kind).sort(), ['review', 'review'], `next collected both: ${J(n1.collected)}`);
  assert.deepEqual([n1.next_action.action, n1.next_action.results.map(r => r.role)], ['gate_review', ['primary', 'second']]);
  assert.deepEqual(fx.cli('next').out.collected, [], 'a second next collects nothing');
  assert.deepEqual(fx.cli('review-collect').out.collected, [], 'review-collect after next collects nothing');
  assert.equal(fx.relayLog().length, 2, 'each reviewer launched once');
  assert.equal(engineLog(fx).filter(e => e.event === 'REVIEW_COLLECTED').length, 2, 'REVIEW_COLLECTED once per reviewer');
  assert.equal(fx.gate('review', fx.original('rx-1')).out.code, 'review_accepted');
});

// ------------------------------------------------------------------ unavailable relays

test('Codex unavailable => BLOCKED: no codex-delegate relay, or a relay that reports codex_unavailable; never waived, re-dispatch once fixed', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t, { relays: ['claude-delegate'] });
  fx.built();
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched');
  const s = fx.dispatch('second');
  assert.deepEqual([s.status, s.out.code, s.out.recorded], [2, 'review_relay_unavailable', true], s.stdout);
  await fx.collectAll();
  const n = fx.cli('next');
  assert.deepEqual([n.status, n.out.next_action.stage, n.out.next_action.disposition, n.out.next_action.reason, n.out.next_action.owner],
    [2, 'REVIEW', 'BLOCKED', 'review_relay_unavailable', 'human'], J(n.out.next_action));
  refused(fx.gate('review', { ...fx.original('rx-1', { second_opinion: secondOpinion(fx.candidate(), { route: 'coderabbit', reviewer_identity: 'coderabbit:cli' }) }) }),
    'review_unbound', 'the gate never waives the second opinion');
  fx.installRelay('codex-delegate');
  fx.relayBehave({ 'codex-delegate': { status: 'codex_unavailable', exit: 127 } });
  assert.equal(fx.dispatch('second').out.code, 'review_dispatched', 'a re-dispatch is allowed once a relay is installed');
  await fx.collectAll();
  assert.equal(fx.dispatches().findLast(d => d.role === 'second').status, 'unavailable');
  assert.equal(fx.cli('next').out.next_action.reason, 'review_relay_unavailable', 'a relay exit 127 is unavailable too');
  fx.relayBehave({ 'codex-delegate': { status: 'failed', exit: 1 } });
  assert.equal(fx.dispatch('second').out.code, 'review_dispatched');
  await fx.collectAll();
  assert.equal(fx.cli('next').out.next_action.reason, 'review_dispatch_failed', 'a failed relay is BLOCKED');
  fx.relayBehave({ 'codex-delegate': { final: final(secondBody()) } });
  assert.equal(fx.dispatch('second').out.code, 'review_dispatched');
  await fx.collectAll();
  assert.equal(fx.gate('review', fx.original('rx-1')).out.code, 'review_accepted');
});

// ------------------------------------------------------------------ dispatch refusals

test('dispatch refusals: usage, wrong candidate, role not owed, already collected, live engine work, launch failure, shared identity', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t);
  fx.built();
  const c = fx.candidate();
  const bad = fx.cli('review-dispatch', { role: 'tertiary', candidate: c });
  assert.equal(bad.status, 1, 'an unknown role is a usage error');
  const code = (r) => [r.status, r.out?.code];
  assert.deepEqual(code(fx.dispatch('primary', 'sha256:not-current')), [2, 'review_candidate_mismatch']);
  assert.deepEqual(code(fx.dispatch('confirmation', c)), [2, 'review_role_mismatch'], 'no repair: a confirmation is not owed');
  // Launch failure (in process: the spawn never yields a pid): nothing ran, the dispatch can be retried.
  const fake = () => { const h = {}; return { pid: undefined, on: (e, f) => { (h[e] ??= []).push(f); if (e === 'exit') setTimeout(f, 0); }, stdin: { on() {}, end() {} }, unref() {} }; };
  const lf = await reviewDispatch(fx.ctx({ role: 'primary', candidate: c, spawn: fake }));
  assert.deepEqual([lf.dispatched, lf.code], [false, 'review_launch_failed']);
  assert.equal(fx.relayLog().length, 0);
  assert.equal(fx.dispatch('primary', c).out.code, 'review_dispatched');
  await fx.collectAll();
  assert.deepEqual(code(fx.dispatch('primary', c)), [2, 'review_already_collected']);
  // A receipt whose identity is the second opinion's (ledger edit): the engine never launches a role as the same identity.
  fx.editState(S => { S.review_dispatches.findLast(d => d.role === 'primary').requested_identity = 'codex:provider-default'; });
  assert.deepEqual(code(fx.dispatch('second', c)), [2, 'review_identity_shared']);
  // Live engine work (a running worker attempt): the candidate may still move.
  fx.editState(S => { S.attempts.push({ attempt_id: 'att-live', kind: 'node', node: 'a', status: 'running', pid: process.pid, pgid: process.pid, quiesced: false }); });
  assert.deepEqual(code(fx.dispatch('second', c)), [2, 'review_build_live']);
});

test('native Agent-tool reviews are refused unless the owner config accepts them; then the primary is labelled native_unbound and the second opinion still needs the Codex relay', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t, { config: { acceptNativeReview: true } });
  fx.built();
  const c = fx.candidate();
  assert.equal(fx.dispatch('second', c).out.code, 'review_dispatched');
  await fx.collectAll();
  refused(fx.gate('review', fx.original('rx-1', { primary: primaryReview(c, { reviewer_identity: 'claude:opus-native' }), second_opinion: otherSecond(c) })),
    'review_unbound', 'a native second opinion is never accepted');
  const g = fx.gate('review', { review_execution: 'rx-1', kind: 'original', primary: primaryReview(c, { reviewer_identity: 'claude:opus-native' }),
    second_opinion: fx.parsed('second'), reconciliation: { dispositions: [] } });
  assert.equal(g.out.code, 'review_accepted', g.stdout);
  const prov = fx.readState().review_bindings[0].provenance;
  assert.deepEqual([prov.primary.provenance, prov.primary.claimed_identity, prov.second_opinion.provenance], ['native_unbound', 'claude:opus-native', 'engine_relay']);
});

test('the confirmation is engine-dispatched too: role confirmation on the repaired candidate, a primary role refused', { skip: WIN_SKIP }, async (t) => {
  const fx = e7Fixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  fx.relayBehave({ 'claude-delegate': { final: final(primaryBody({ outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }],
    acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: 'src/a.txt' }] })) }, 'codex-delegate': { final: final(secondBody()) } });
  await fx.reviewed();
  const g = fx.gate('review', fx.original('rx-1', { reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] }, repair_prompt_file: fx.prompt('fix') }));
  assert.equal(g.out.code, 'review_accepted', g.stdout);
  assert.equal(fx.cli('drive').status, 0, 'the one repair runs');
  const c2 = fx.candidate();
  assert.deepEqual([fx.dispatch('primary', c2).out.code], ['review_role_mismatch']);
  writeFileSync(join(fx.repo, 'src', 'drift.txt'), 'after the repair');
  const drifted = fx.dispatch('confirmation');
  assert.deepEqual([drifted.status, drifted.out.code], [2, 'review_candidate_mismatch'], 'the confirmation reviews the repaired candidate only');
  rmSync(join(fx.repo, 'src', 'drift.txt'));
  const owed = fx.cli('next').out.next_action;
  assert.deepEqual([owed.stage, owed.action, owed.roles], ['CONFIRMATION', 'review_dispatch', ['confirmation']], J(owed));
  fx.relayBehave({ 'claude-delegate': { final: final({ checked_findings: ['F1'], outcome: 'PASS', evidence: 'src/a.txt:1 fixed' }) } });
  assert.equal(fx.dispatch('confirmation', c2).out.code, 'review_dispatched');
  await fx.collectAll();
  const conf = { review_execution: 'rx-1', kind: 'confirmation', primary: fx.parsed('confirmation') };
  refused(fx.gate('review', { ...conf, primary: { reviewer_identity: 'opus:review', candidate_id: c2, checked_findings: ['F1'], outcome: 'PASS', evidence: 'x' } }), 'review_unbound', 'a hand-written confirmation');
  assert.equal(fx.gate('review', conf).out.code, 'review_accepted');
  assert.equal(fx.readState().review_bindings.at(-1).provenance.primary.role, 'confirmation');
});

// ------------------------------------------------------------------ the verdict, in process (mutation)

const D = (over = {}) => ({ attempt_id: 'att-p', role: 'primary', kind: 'original', requested_identity: 'claude:opus', provider: 'claude', candidate_id: 'C1', status: 'collected',
  result_file: '/r/p.json', collected: { content_sha256: contentDigest(primaryReview('x')), output_sha256: sha('OUT-p'), parsed_file: '/r/p.parsed', parsed_result_sha256: null }, ...over });
const P_OBJ = { ...primaryReview('C1'), reviewer_identity: 'claude:opus' };
const S_OBJ = { ...secondOpinion('C1'), reviewer_identity: 'codex:provider-default', route: 'codex' };
const SECOND = (over = {}) => D({ attempt_id: 'att-s', role: 'second', requested_identity: 'codex:provider-default', provider: 'codex', result_file: '/r/s.json',
  collected: { content_sha256: contentDigest(S_OBJ), output_sha256: sha('OUT-s'), parsed_file: '/r/s.parsed', parsed_result_sha256: sha(canonical(S_OBJ)) }, ...over });
const files = { '/r/p.json': 'OUT-p', '/r/s.json': 'OUT-s', '/r/p.parsed': J(P_OBJ), '/r/s.parsed': J(S_OBJ) };
const read = (f) => (Object.hasOwn(files, f) ? Buffer.from(files[f]) : null);
const prim = (over = {}) => { const d = D(over); d.collected.parsed_result_sha256 = sha(canonical(P_OBJ)); return d; };
const input = (over = {}) => ({ review_execution: 'rx', kind: 'original', primary: P_OBJ, second_opinion: S_OBJ, ...over });
const S0 = (dispatches, config = {}) => ({ run_id: 'r', config, review_dispatches: dispatches });

/** [name, S, input, frozen, expected code, the check that decides it] */
const VERDICTS = [
  ['bound pair', S0([prim(), SECOND()]), input(), 'C1', 'ok', null],
  ['hand-written primary', S0([SECOND()]), input(), 'C1', 'review_unbound', 'bound'],
  ['native primary without the owner key', S0([SECOND()]), input(), 'C1', 'review_unbound', 'native_key'],
  ['native second opinion with the owner key', S0([prim()], { acceptNativeReview: true }), input(), 'C1', 'review_unbound', 'second_native'],
  ['the second opinion\'s output as the primary', S0([prim({ role: 'second' }), SECOND()]), input(), 'C1', 'review_role_mismatch', 'role'],
  ['a confirmation output in an original', S0([prim({ kind: 'confirmation' }), SECOND()]), input(), 'C1', 'review_role_mismatch', 'kind'],
  ['receipt for another candidate', S0([prim({ candidate_id: 'C0' }), SECOND()]), input(), 'C1', 'review_receipt_candidate', 'candidate'],
  ['consumed receipt', S0([prim({ consumed_by: 'rx-0' }), SECOND()]), input(), 'C1', 'review_receipt_spent', 'spent'],
  ['two roles, one identity', S0([prim({ requested_identity: 'codex:provider-default' }), SECOND()]), input({ primary: { ...P_OBJ, reviewer_identity: undefined } }), 'C1', 'review_identity_shared', 'shared_identity'],
  ['spoofed identity', S0([prim(), SECOND()]), input({ second_opinion: { ...S_OBJ, reviewer_identity: 'opus:review' } }), 'C1', 'review_identity_spoofed', 'identity_claim'],
  ['output changed', S0([prim(), SECOND({ collected: { ...SECOND().collected, output_sha256: sha('other') } })]), input(), 'C1', 'review_output_changed', 'output_integrity'],
];

test('provenance verdict: every pinned case decides by its check, and deleting any check changes a pinned verdict (mutation)', () => {
  const codeOf = (v) => (v.ok ? 'ok' : v.code);
  for (const [name, S, inp, frozen, want] of VERDICTS) assert.equal(codeOf(provenanceVerdict({ S, input: JSON.parse(J(inp)), frozen, read })), want, name);
  for (const id of PROVENANCE_CHECKS) {
    const flipped = VERDICTS.filter(([, S, inp, frozen, want]) => codeOf(provenanceVerdict({ S, input: JSON.parse(J(inp)), frozen, read }, { omit: [id] })) !== want);
    assert.ok(flipped.length > 0, `omitting ${id} changes no pinned verdict`);
    assert.ok(flipped.some(([, , , , , by]) => by === id), `omitting ${id} flips its own case`);
  }
  const ok = provenanceVerdict({ S: S0([prim(), SECOND()]), input: input({ primary: { ...P_OBJ, reviewer_identity: undefined } }), frozen: 'C1', read });
  assert.equal(ok.input.primary.reviewer_identity, 'claude:opus', 'the gate judges the receipt identity, not the file\'s');
  assert.deepEqual(ok.used.sort(), ['att-p', 'att-s']);
});

test('owedReview and extractReview: the engine decides what is owed; the reviewer JSON is the last fenced block', () => {
  assert.deepEqual(owedReview({ review_chain: [] }), { kind: 'original' });
  assert.equal(owedReview({ run_id: 'r', review_chain: [{ review_execution: 'rx', kind: 'original', outcome: 'PASS' }], authority: { trusted: [] } }).code, 'review_not_owed');
  assert.equal(owedReview({ review_chain: [{ review_execution: 'rx', kind: 'original', outcome: 'FAIL', fix_findings: ['F1'] },
    { review_execution: 'rx', kind: 'repair', new_candidate: 'C2', write_set: ['a'] }] }).kind, 'confirmation');
  assert.deepEqual(extractReview('x\n```json\n{"a":1}\n```\nthen\n```json\n{"b":2}\n```').value, { b: 2 });
  assert.match(extractReview('no json').error, /not JSON/);
  assert.match(extractReview('```json\n[1]\n```').error, /not a JSON object/);
});

test('more refusals: unmapped builders make the opus primary a builder (refused before launch); bad DAG keys; review-collect under binding drift; a reviewer that dies without an envelope', { skip: WIN_SKIP }, async (t) => {
  const plain = e7Fixture(t, { config: { modelMap: {} } });
  plain.built();
  const b = plain.dispatch('primary');
  assert.deepEqual([b.status, b.out.code], [2, 'reviewer_is_builder'], b.stdout);
  assert.equal(plain.relayLog().length, 0, 'nothing launched');
  for (const [cfg, why] of [[{ reviewProvenance: 'sometimes' }, 'reviewProvenance'], [{ acceptNativeReview: 'yes' }, 'acceptNativeReview']]) {
    const fx = e7Fixture(t, { config: cfg });
    const r = fx.cli('init', { dag: fx.dagFile });
    assert.equal(r.status, 1, why);
    assert.match(r.stderr, new RegExp(`dag_invalid.*${why}`), why);
  }
  const fx = e7Fixture(t);
  fx.relayBehave({ 'claude-delegate': { final: final(RELAY_PRIMARY()), sleep_ms: 60000 } });
  fx.built();
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched');
  const a = fx.readState().attempts.find(x => x.kind === 'review');
  await waitFor(() => fx.relayLog().length === 1, 'the reviewer started');
  process.kill(-a.pgid, 'SIGKILL'); // the whole reviewer group dies: no envelope is ever written
  await waitFor(() => { try { process.kill(-a.pgid, 0); return false; } catch { return true; } }, 'group gone');
  const text = readFileSync(fx.planFile, 'utf8');
  writeFileSync(fx.planFile, text.replace('Approved narrative.', 'Edited narrative.'));
  const drift = fx.cli('review-collect');
  assert.deepEqual([drift.status, drift.out.code], [2, 'approval_mismatch'], drift.stdout);
  writeFileSync(fx.planFile, text);
  const r = fx.cli('review-collect');
  assert.deepEqual([r.status, r.out.collected.map(x => [x.status, x.parse_error])], [0, [['failed', 'the reviewer died without an envelope']]], r.stdout);
  assert.equal(fx.cli('next').out.next_action.reason, 'review_dispatch_failed');
  fx.relayBehave({ 'claude-delegate': { final: final(RELAY_PRIMARY()) } });
  assert.equal(fx.dispatch('primary').out.code, 'review_dispatched', 'a failed reviewer may be dispatched again');
});
