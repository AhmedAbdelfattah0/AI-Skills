/**
 * Specs for the CodeRabbit PR #38 repair batch (bug fixes only: no new engine feature, state kind or
 * schema). Threat model: accidental or buggy workers; deliberately hostile dispatched code is out of
 * scope. Each test is named by the CodeRabbit comment id it covers. Engine rows drive the REAL
 * engine through the `node run-engine.mjs` CLI on a temp git repo with a fake provider CLI.
 *
 * ============================ CONTRACT ADDITIONS (PR #38 repair) ============================
 * - `gate ship-ready`: a local proof that changed the work tree is recorded with candidate_id null
 *   (`dropped: ['candidate_mismatch']`), so it never proves the tree it left (4505924540).
 * - `drive`/`status`: a failed review repair is a computed `repair_failed` judgment (never outcome
 *   done); an owner RETRY cancels it ('superseded by retry') with the pending ones (4505924571).
 * - `gate review` confirmation: a supplied second-opinion confirmation is validated and counted; it
 *   is required when the repair write set overlaps a node labelled concurrency or security
 *   (review.md Targeted confirmation) (4507607914).
 * ==============================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview, secondOpinion, runStateEvents } from './engine-test-fixture.mjs';
import { validateEngineDag } from './engine-dag.mjs';
import { gateRed, gateReview } from './gate.mjs';
import { snapshot, fingerprint, repoFileDigest } from './engine-io.mjs';
import { gitDirty, verifyReviewExecution } from './carrier.mjs';
import { addUsageRecords } from './usage.mjs';
import { suggest, evaluateRun } from './eval.mjs';
import { buildRun } from './run-summary.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); assert.equal(r.out.ok, false); };
const retry = (rx, predecessor) => ({ run_id: 'run-1', event: 'RETRY', review_execution: rx, predecessor, authorized_by: 'owner' });
const shipEvents = (fx) => runStateEvents(fx.planFile).filter(e => e.event === 'SHIP_READY');

// ------------------------------------------------------------------ MAJOR

test('4505924540 a proof that changed the work tree proves nothing: a RETRY review of the new tree still needs a proof of it', { skip: WIN_SKIP }, (t) => {
  // A testCommand that rewrites an undeclared file on EVERY run (codegen, --fix): the tree never holds still.
  const gen = { cmd: process.execPath, args: ['-e', "require('fs').writeFileSync('gen.txt', String(process.hrtime.bigint()))"] };
  const fx = fixture(t, { commit: true, config: { testCommands: { gen } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  refused(fx.gate('ship-ready', {}), 'candidate_mismatch');
  const lp = fx.readState().local_proof;
  assert.equal(lp.candidate_id, null, 'the proof is bound to no tree');
  assert.deepEqual(lp.dropped, ['candidate_mismatch']);
  fx.appendRunState(retry('rx-2', 'rx-1'));
  ok(fx.gate('review', passReview('rx-2', fx.candidate())), 'the owner retries the review on the tree the proof left');
  refused(fx.gate('ship-ready', {}), 'candidate_mismatch');
  assert.equal(fx.readState().attempts.filter(a => a.kind === 'proof').length, 2, 'the proof ran again for the reviewed tree');
  assert.deepEqual(shipEvents(fx), [], 'SHIP_READY is never granted for a tree no proof tested');
});

/** A run whose final-review repair worker hangs past the timeout (the repair fails, nothing written). */
function failedRepair(t) {
  const fx = fixture(t, { commit: true, config: { timeoutMs: 1000, testCommands: { ok: { cmd: process.execPath, args: ['-e', ''] } } }, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { hang: true } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  return fx;
}

test('4505924571 a failed review repair is a repair_failed judgment: drive never reports done (exit 0); an owner RETRY continues', { skip: WIN_SKIP }, (t) => {
  const fx = failedRepair(t);
  const r = fx.cli('drive');
  assert.equal(r.out.repairs[0].state, 'failed', r.stdout);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.out.outcome, 'judgment');
  assert.ok(r.out.judgments.some(j => j.code === 'repair_failed' && j.node === 'repair-rx-1'), JSON.stringify(r.out.judgments));
  assert.ok(fx.cli('status').out.judgments.some(j => j.code === 'repair_failed'), 'status reports it too');
  fx.appendRunState(retry('rx-2', 'rx-1'));
  ok(fx.gate('review', passReview('rx-2', fx.candidate())));
  const s = fx.readState().repairs[0];
  assert.deepEqual([s.state, s.reason], ['cancelled', 'superseded by retry']);
  const d = fx.cli('drive');
  ok(d);
  assert.equal(d.out.outcome, 'done');
  assert.equal(d.out.judgments.length, 0, d.stdout);
  ok(fx.gate('ship-ready', {}));
});

/** A final-review FAIL on `src/a.txt` repaired by `fix`; node a carries `risk`. */
function repaired(t, risk = []) {
  const fx = fixture(t, { commit: true, nodes: [{ id: 'a', writes: ['src/a.txt'], risk }], config: { modelMap: { strong: 'opus' } },
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  ok(fx.cli('drive'));
  return fx;
}
const confirmSo = (fx, outcome) => ({ route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: fx.candidate(), checked_findings: ['F1'],
  outcome, evidence: `F1 ${outcome}` });

test('4507607914 a supplied second-opinion confirmation is honoured: its FAIL makes the confirmation FAIL', { skip: WIN_SKIP }, (t) => {
  const fx = repaired(t);
  const c = fx.gate('review', { ...confirmReview('rx-1', fx.candidate()), second_opinion: confirmSo(fx, 'FAIL') });
  ok(c);
  assert.deepEqual([c.out.record.outcome, c.out.record.second_opinion_outcome], ['FAIL', 'FAIL']);
  const ship = fx.gate('ship-ready', {});
  assert.equal(ship.status, 2);
  assert.ok(ship.out.reasons.includes('review_not_accepted'), ship.stdout);
});

test('4507607914 an unusable supplied second-opinion confirmation is refused, not ignored', { skip: WIN_SKIP }, (t) => {
  const fx = repaired(t);
  const { route: _r, ...noRoute } = confirmSo(fx, 'PASS');
  refused(fx.gate('review', { ...confirmReview('rx-1', fx.candidate()), second_opinion: noRoute }), 'second_opinion_unusable');
  ok(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'without a risk label the second opinion stays optional');
});

for (const label of ['concurrency', 'security']) {
  test(`4507607914 a repair touching a ${label}-labelled node needs the second-opinion confirmation`, { skip: WIN_SKIP }, (t) => {
    const fx = repaired(t, [label]);
    refused(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'missing_second_opinion');
    assert.equal(fx.readState().review_chain.filter(r => r.kind === 'confirmation').length, 0, 'the refusal records nothing');
    const c = fx.gate('review', { ...confirmReview('rx-1', fx.candidate()), second_opinion: confirmSo(fx, 'PASS') });
    ok(c);
    assert.deepEqual([c.out.record.outcome, c.out.record.second_opinion_route], ['PASS', 'codex']);
  });
}


test('4507607934 a repair of a risk-labelled node is routed like it (strong), not inherit', { skip: WIN_SKIP }, (t) => {
  const fx = repaired(t, ['concurrency']);
  const b = fx.readState().builders.find(x => x.node === 'repair-rx-1');
  assert.equal(b?.model, 'opus', JSON.stringify(fx.readState().builders));
});

// ------------------------------------------------------------------ MINOR: DAG and gate input validation

const DAG = (node = {}, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000, ...config },
  nodes: [{ id: 'a', promptFile: '/p', writes: ['src/a.txt'], ...node }] });

test('4505920949 a DAG node with phase REPAIR is dag_invalid at init (repairs come from review records only)', () => {
  assert.throws(() => validateEngineDag(DAG({ phase: 'REPAIR' })), /dag_invalid: node a: phase must be BUILD\|PROVE\|SHIP/);
  assert.equal(validateEngineDag(DAG({ phase: 'PROVE' })).nodes[0].phase, 'PROVE');
});

test('4505924532 riskLabels null and a node redSpecs/evidence/othersOwned null are dag_invalid (they would throw later)', () => {
  assert.throws(() => validateEngineDag(DAG({}, { riskLabels: null })), /dag_invalid: config.riskLabels/);
  for (const k of ['redSpecs', 'evidence', 'othersOwned']) assert.throws(() => validateEngineDag(DAG({ [k]: null })), new RegExp(`dag_invalid: node a: ${k} must be an array`));
  assert.deepEqual(validateEngineDag(DAG()).config.riskLabels, [], 'absent stays defaulted');
});

test('4505924566 gate review repair_ownership must be paths (an object or a string is a usage error)', (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  for (const bad of [{}, 'src/b.js']) {
    const r = fx.gate('review', { ...failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix')), repair_ownership: bad });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /repair_ownership must be paths/);
  }
  assert.equal(fx.readState().review_chain.length, 0);
});

test('4505924561 reviewers sharing <provider>:<model> are not distinct, whatever their role suffix', () => {
  const state = { frozen_candidate: 'c1', builders: [], review_chain: [] };
  const so = secondOpinion('c1', { reviewer_identity: 'claude:opus:second', route: 'claude' });
  const v = gateReview({ ...passReview('rx-1', 'c1', { primary: primaryReview('c1', { reviewer_identity: 'claude:opus:primary' }), second_opinion: so }), state });
  assert.equal(v.code, 'reviewers_not_distinct');
  const other = gateReview({ ...passReview('rx-1', 'c1', { primary: primaryReview('c1', { reviewer_identity: 'claude:opus:primary' }),
    second_opinion: secondOpinion('c1', { reviewer_identity: 'claude:sonnet:second', route: 'claude' }) }), state });
  assert.equal(other.code, 'review_accepted', 'a different model of the same provider stays distinct');
  const chain = [{ review_execution: 'rx-1', kind: 'original', outcome: 'FAIL', fix_findings: ['F1'] }, { review_execution: 'rx-1', kind: 'repair', new_candidate: 'c1' }];
  const c = gateReview({ review_execution: 'rx-1', kind: 'confirmation', state: { ...state, review_chain: chain },
    primary: { reviewer_identity: 'claude:opus:primary', candidate_id: 'c1', checked_findings: ['F1'], outcome: 'PASS', evidence: 'e' },
    second_opinion: { route: 'claude', reviewer_identity: 'claude:opus:second', candidate_id: 'c1', checked_findings: ['F1'], outcome: 'PASS', evidence: 'e' } },
  { confirmationSecondOpinion: 'optional' });
  assert.equal(c.code, 'reviewers_not_distinct');
});

// ------------------------------------------------------------------ MINOR: RED

/** gateRed deps with a fake runner printing `stdout`; `digests` returns per-call spec digests (a rewrite shows as a change). */
function redDeps(stdout, digests = () => 'sha256:same') {
  let n = 0;
  return { platform: 'linux', newAttemptId: () => `att-${++n}`, commit: () => {}, digestFile: async (f) => digests(f), isGroupAlive: () => false,
    spawnRunner: () => { let go; const released = new Promise(r => { go = r; });
      return { pid: 4101, pgid: 4100, release: () => go(), done: released.then(() => ({ exitCode: 1, stdout, timedOut: false, quiescent: true })) }; } };
}
const redInput = (specs) => ({ state: { nodes: {} }, node: 'r', command: { cmd: 'x', args: [] }, format: 'tap', specs, baselineCandidate: 'sha256:base', timeoutMs: 1000 });
const tapFail = (name, location) => `# Subtest: ${name}\nnot ok 1 - ${name}\n  ---\n  duration_ms: 1\n${location ? `  location: '${location}:1:1'\n` : ''}`
  + "  failureType: 'testCodeFailure'\n  error: 'boom'\n  code: 'ERR_ASSERTION'\n  ...\n";

test('4505921014 a location-less same-named failure does not satisfy RED when failures carry locations (another file\'s)', async () => {
  const spec = [{ file: 'a.test.mjs', name: 'X' }];
  const mixed = `TAP version 13\n${tapFail('X', null)}${tapFail('Y', '/r/b.test.mjs')}1..2\n`;
  assert.equal((await gateRed(redInput(spec), redDeps(mixed))).code, 'spec_missing');
  const dup = `TAP version 13\n${tapFail('X', null)}${tapFail('X', null)}1..2\n`;
  assert.equal((await gateRed(redInput(spec), redDeps(dup))).code, 'spec_missing', 'two same-named results: the file decides');
  const bare = `TAP version 13\n${tapFail('X', null)}1..1\n`;
  assert.equal((await gateRed(redInput(spec), redDeps(bare))).code, 'red_accepted', 'output with no locations at all still binds by name');
  const located = `TAP version 13\n${tapFail('X', '/r/a.test.mjs')}${tapFail('Y', '/r/b.test.mjs')}1..2\n`;
  assert.equal((await gateRed(redInput(spec), redDeps(located))).code, 'red_accepted');
});

test('4505924556 a RED runner that rewrites a spec (snapshot update) is refused; evidence binds the bytes that failed', async () => {
  const spec = [{ file: 'a.test.mjs', name: 'X' }];
  const tap = `TAP version 13\n${tapFail('X', '/r/a.test.mjs')}1..1\n`;
  let calls = 0;
  const r = await gateRed(redInput(spec), redDeps(tap, () => (++calls === 1 ? 'sha256:before' : 'sha256:after')));
  assert.equal(r.code, 'spec_rewritten', JSON.stringify(r.reasons));
  assert.equal(r.state.gates.red.r, undefined, 'nothing is recorded');
  assert.ok(r.state.events.some(e => e.type === 'RED_REFUSED'));
  const fine = await gateRed(redInput(spec), redDeps(tap, () => 'sha256:before'));
  assert.deepEqual(fine.evidence.spec_digests, { 'a.test.mjs': 'sha256:before' });
});

// ------------------------------------------------------------------ MINOR: ship-ready re-derivation

const PASS = { cmd: process.execPath, args: ['-e', ''] };

test('4505924536 4507607918 stored risk evidence is re-derived on every ship-ready (a deleted git-ignored evidence file is missing)', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { riskLabels: ['ui'], testCommands: { ok: PASS } } });
  writeFileSync(join(fx.repo, '.gitignore'), 'ev.png\n');
  writeFileSync(join(fx.repo, 'ev.png'), 'parity');
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  const first = fx.gate('ship-ready', { risk_evidence: [{ kind: 'parity-measurements', path: 'ev.png' }] });
  assert.ok(first.out.reasons.includes('review_not_accepted'), first.stdout);
  assert.equal(fx.readState().risk_evidence[0].exists, true);
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  rmSync(join(fx.repo, 'ev.png')); // git-ignored: the candidate does not change
  const r = fx.gate('ship-ready', {});
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.out.reasons.includes('missing_risk_evidence'), r.stdout);
  assert.deepEqual(shipEvents(fx), []);
  writeFileSync(join(fx.repo, 'ev.png'), 'parity');
  ok(fx.gate('ship-ready', {}), 'restored evidence binds again');
});

test('4505924538 a proof that rewrites a git-ignored graded artifact is seen: artifact digests are taken after the proof', { skip: WIN_SKIP }, (t) => {
  const regen = { cmd: process.execPath, args: ['-e', "require('fs').writeFileSync('shot.png', 'regenerated')"] };
  const fx = fixture(t, { commit: true, config: { testCommands: { visual: regen } } });
  writeFileSync(join(fx.repo, '.gitignore'), 'shot.png\n');
  writeFileSync(join(fx.repo, 'shot.png'), 'graded');
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', passReview('rx-1', fx.candidate(), { graded_artifacts: { shot: repoFileDigest(fx.repo, 'shot.png') } })));
  const r = fx.gate('ship-ready', { artifacts: { shot: 'shot.png' } });
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.out.reasons.includes('artifact_changed'), r.stdout);
  assert.deepEqual(shipEvents(fx), []);
});

// ------------------------------------------------------------------ MINOR: work-tree parsing, fingerprints, carrier authority

function gitRepo(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cr38-git-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  writeFileSync(join(repo, 'old.txt'), 'x');
  git('add', 'old.txt'); git('commit', '-q', '-m', 'init');
  return { repo, git };
}

test('4507604537 a work-tree rename (after git add -N) records both paths in the engine snapshot and the carrier dirty map', { skip: POSIX ? false : 'POSIX paths' }, (t) => {
  const { repo, git } = gitRepo(t);
  renameSync(join(repo, 'old.txt'), join(repo, 'new.txt'));
  git('add', '-N', 'new.txt');
  const st = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: repo, encoding: 'utf8' }).stdout;
  assert.match(st, /^ R new\.txt\0old\.txt\0/, 'git reports a work-tree rename');
  assert.deepEqual(Object.keys(snapshot(repo)).sort(), ['new.txt', 'old.txt']);
  assert.deepEqual([...gitDirty(repo).keys()].sort(), ['new.txt', 'old.txt']);
});

test('4505924550 a symlinked declared path is fingerprinted by its target bytes too', { skip: POSIX ? false : 'POSIX symlinks' }, (t) => {
  const { repo } = gitRepo(t);
  writeFileSync(join(repo, 'target.txt'), 'v1');
  symlinkSync('target.txt', join(repo, 'link.txt'));
  const before = fingerprint(repo, 'link.txt');
  writeFileSync(join(repo, 'target.txt'), 'v2');
  assert.notEqual(fingerprint(repo, 'link.txt'), before, 'the target changed: the read is stale');
  symlinkSync('nowhere', join(repo, 'dangling'));
  assert.match(fingerprint(repo, 'dangling'), /^l:nowhere:missing$/);
});

test('4505924499 with engine state the carrier refuses a REPAIR whose writes leave the FAIL write set, or whose repair already ran', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  const approval = { ticket: 'T-1', run_id: 'run-1' };
  assert.equal(verifyReviewExecution(fx.repo, approval, 'rx-1', ['src/a.txt']), 'engine');
  assert.throws(() => verifyReviewExecution(fx.repo, approval, 'rx-1', ['src/a.txt', 'src/b.txt']), /exceed the write set/);
  ok(fx.cli('drive'));
  assert.throws(() => verifyReviewExecution(fx.repo, approval, 'rx-1', ['src/a.txt']), /already had its repair/);
});

// ------------------------------------------------------------------ MINOR: attempts, scope, unit checks

test('4505924504 a released attempt that settles without an envelope counts as unknown usage (budget_unenforceable)', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { config: { timeoutMs: 1000, budget: { ticket_tokens: 1000000 } }, behaviour: { a: { hang: true } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.out.nodes.a.state, 'failed', r.stdout);
  const a = fx.readState().attempts.find(x => x.kind === 'node');
  assert.equal(a.status, 'timed_out');
  assert.ok(fx.readState().usage.some(u => u.source_execution_id === a.attempt_id), 'the attempt has a usage record');
  assert.deepEqual(fx.cli('status').out.budget.flags, ['budget_unenforceable']);
});

const unitNode = (id, extra = {}) => ({ id, writes: [`src/${id}.txt`], checks: ['ok'], ...extra });

test('4507607910 drive --until a node whose dependency is in another unit also runs that unit\'s other members', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS } },
    nodes: [unitNode('a', { unit: 'u1' }), unitNode('a2', { unit: 'u1' }), unitNode('b', { unit: 'u2', deps: ['a'] }), unitNode('c', { unit: 'u3' })],
    behaviour: { a: { write: { 'src/a.txt': 'a' } }, a2: { write: { 'src/a2.txt': 'a2' } }, b: { write: { 'src/b.txt': 'b' } }, c: { write: { 'src/c.txt': 'c' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive', { until: 'b' });
  ok(r);
  assert.deepEqual(['a', 'a2', 'b', 'c'].map(id => r.out.nodes[id].state), ['done', 'done', 'done', 'pending'], r.stdout);
  assert.equal(r.out.units.u1.state, 'verified');
});

test('4507607938 unit checks that drift the approval binding record no evidence and release no dependent', { skip: WIN_SKIP }, (t) => {
  const forge = { cmd: process.execPath, args: ['-e', "const f='.specs/plans/T-1.md',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('Approved narrative.','Forged narrative.'))"] };
  const fx = fixture(t, { commit: true, config: { testCommands: { forge } },
    nodes: [{ id: 'a', writes: ['src/a.txt'], unit: 'u1', checks: ['forge'] }, { id: 'b', deps: ['a'], writes: ['src/b.txt'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a' } }, b: { write: { 'src/b.txt': 'b' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(j => j.code === 'approval_mismatch'), JSON.stringify(r.out.judgments));
  assert.equal(fx.runs('b').length, 0, 'no dependent dispatched on evidence recorded after the drift');
  const s = fx.readState();
  assert.equal(s.unit_checks.u1.evidence, null);
  assert.ok(s.events.some(e => e.type === 'UNIT_CHECK_DROPPED' && e.unit === 'u1'));
});

test('4507607938 a drop at the same idle point stops the drive: no dependent of a unit verified just before is dispatched', { skip: WIN_SKIP }, (t) => {
  // u1 passes, then u2's check rewrites the plan narrative: c (released by u1) must not run under the differing binding.
  const forge = { cmd: process.execPath, args: ['-e', "const f='.specs/plans/T-1.md',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('Approved narrative.','Forged narrative.'))"] };
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS, forge } },
    nodes: [unitNode('a', { unit: 'u1' }), unitNode('b', { unit: 'u2', checks: ['forge'] }), { id: 'c', deps: ['a'], writes: ['src/c.txt'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a' } }, b: { write: { 'src/b.txt': 'b' } }, c: { write: { 'src/c.txt': 'c' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.out.outcome, 'judgment');
  assert.ok(r.out.judgments.some(j => j.code === 'approval_mismatch'), JSON.stringify(r.out.judgments));
  const s = fx.readState();
  assert.equal(s.unit_checks.u1.evidence?.state, 'verified', 'u1 was checked first, before the drift');
  assert.ok(s.events.some(e => e.type === 'UNIT_CHECK_DROPPED' && e.unit === 'u2'));
  assert.equal(fx.runs('c').length, 0, 'nothing is dispatched after the drift in that drive');
  assert.equal(r.out.nodes.c.state, 'pending');
  assert.equal(s.attempts.filter(a => a.kind === 'node').length, 2, 'only a and b ran');
});

// ------------------------------------------------------------------ MINOR: usage and eval

test('4505921051 a re-imported execution with strictly larger counters replaces the earlier reading; a smaller or equal one is refused', () => {
  const rec = (n, over = {}) => ({ provider: 'claude', run_id: 'r1', source: 'session', source_execution_id: 's1', input_tokens: n, output_tokens: n, ...over });
  const first = addUsageRecords([], [rec(10)]).records;
  const again = addUsageRecords(first, [rec(25)]);
  assert.deepEqual(again.replaced, ['s1']);
  assert.equal(again.records.length, 1);
  assert.equal(again.records[0].input_tokens, 25);
  assert.deepEqual(addUsageRecords(again.records, [rec(25)]).refused, ['s1'], 'an equal reading is a duplicate');
  assert.deepEqual(addUsageRecords(again.records, [rec(5)]).refused, ['s1']);
  assert.deepEqual(addUsageRecords(again.records, [rec(30, { source: 'codex' })]).refused, ['s1'], 'another source never replaces');
});

test('4505920974 suggestions compare the unrounded values (50.04 and 1.2004 fire)', () => {
  const m = { orchestrator_share_pct: 50, ui_ticket: true, review_to_build_ratio: 1.2, review_repairs: 0 };
  assert.deepEqual(suggest(m).map(s => s.rule), []);
  assert.deepEqual(suggest(m, { orchestrator_share_pct: 50.04, review_to_build_ratio: 1.2004 }).map(s => s.rule), ['split_session', 'parity_probe_first']);
});

test('4505920963 eval counts a done review repair whose record is missing (candidate_unavailable)', () => {
  const run = buildRun('T-1', 'r1', []);
  const state = { run_id: 'r1', review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'FAIL' }],
    repairs: [{ id: 'repair-rx-1', kind: 'review', review_execution: 'rx-1', state: 'done' }] };
  assert.equal(evaluateRun(run, { state }).review_repairs, 1);
  state.review_chain.push({ review_execution: 'rx-1', kind: 'repair' });
  assert.equal(evaluateRun(run, { state }).review_repairs, 1, 'a recorded repair is counted once');
});

const EVAL_CLI = fileURLToPath(new URL('./eval.mjs', import.meta.url));
function evalRepo(t) {
  const { repo } = gitRepo(t);
  const dir = join(repo, '.git', 'ai-skills', 'ship-ticket');
  mkdirSync(dir, { recursive: true });
  return { repo, dir, report: (...a) => spawnSync(process.execPath, [EVAL_CLI, 'report', '--repo', repo, ...a], { encoding: 'utf8' }) };
}

/** One BUILD phase interval of run r1 in T-1's timing log; `metrics` undefined writes rows without them. */
const timingRows = (dir, metrics) => {
  const row = { ticket: 'T-1', run_id: 'r1', kind: 'phase', name: 'BUILD', event_id: 'e1', ...(metrics ? { metrics } : {}) };
  writeFileSync(join(dir, 'T-1.jsonl'), [{ ...row, event: 'start', timestamp: '2026-11-08T00:00:00Z' },
    { ...row, event: 'end', timestamp: '2026-11-08T00:00:01Z', duration_ms: 1000, outcome: 'ok' }].map(r => JSON.stringify(r)).join('\n') + '\n');
};

test('4505920994 eval finds a run through its engine state alone (its timing log failed)', (t) => {
  const { dir, report } = evalRepo(t);
  writeFileSync(join(dir, 'T-1.state.json'), JSON.stringify({ run_id: 'r1', ticket: 'T-1' }));
  const r = report('--all');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).runs.map(x => [x.ticket, x.run_id]), [['T-1', 'r1']]);
});

test('4505921008 eval counts the same execution in overlapping --usage files once', (t) => {
  const { repo, dir, report } = evalRepo(t);
  timingRows(dir, {});
  const row = JSON.stringify({ provider: 'claude', run_id: 'r1', role: 'builder', source: 'engine', source_execution_id: 'att-1', input_tokens: 10, output_tokens: 0 });
  for (const f of ['u1.jsonl', 'u2.jsonl']) writeFileSync(join(repo, f), row + '\n');
  const r = report('--ticket', 'T-1', '--usage', join(repo, 'u1.jsonl'), join(repo, 'u2.jsonl'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).runs[0].tokens_by_role.builder.processed_tokens, 10);
});

test('4505921000 eval skips a parseable timing row without metrics instead of crashing', (t) => {
  const { dir, report } = evalRepo(t);
  timingRows(dir);
  const r = report('--ticket', 'T-1');
  assert.equal(r.status, 0, r.stderr);
});

test('4505921034 run-log refuses a ticket id ending in .engine (its timing log would be another ticket\'s engine file)', (t) => {
  const { repo } = gitRepo(t);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./run-log.mjs', import.meta.url)), 'start', '--repo', repo, '--ticket', 'T-1.engine',
    '--run-id', 'r1', '--kind', 'phase', '--name', 'BUILD', '--event-id', 'e1'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must not end in \.engine/);
});

