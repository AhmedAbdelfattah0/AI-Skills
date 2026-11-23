/**
 * S-23-min lite: `engine-accepted.mjs view|next` (accepted-view + happy-path next). Read-only.
 *
 * Contract under test:
 * - `view` reports, for the CURRENT candidate, which phases have ACCEPTED, each with the durable record
 *   that proves it (`evidence`: file, line, JSON pointer, value), or `unknown` with the reason when the
 *   record is not durable (INIT/BUILD/RED/PROVE are settled only by a `drive` output passed with --last,
 *   used in-invocation only), or `not_accepted`.
 * - `next` prints ONE step {phase, action: run|dispatch|stop, command, role, reason, evidence} on the
 *   happy path INIT -> BUILD -> RED -> PROVE -> (REASSESS) -> REVIEW -> SHIP_READY -> owner_publish, and
 *   STOPs on owner-class state, an unknown phase, anything off the happy path, and a repeated refusal key
 *   (candidate, gate, code, subject) with no progress record in between. A stop clears only when the gate
 *   itself later accepts.
 * - Neither command writes: the state file, the engine log and the plan are byte-identical around EVERY
 *   call (asserted inside `call`, for every output path including stops and errors).
 * Every test drives the REAL engine CLI on the shared fixture (engine-test-fixture.mjs), except the block
 * marked "pure core", which feeds crafted states to the exported pure functions for classes a policy-1
 * fixture cannot reach (policy 2 reassess, spent budget, untrusted authority, live attempts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { acceptedView, nextStep, PHASES } from './engine-accepted.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment';
const CLI = fileURLToPath(new URL('./engine-accepted.mjs', import.meta.url));
const SPEC = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\n`
  + `test('fails on assertion', () => { assert.equal(existsSync('src/p.txt'), true); });\n`;
const RED_SPECS = [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }];
const TAP_RUNNER = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };

const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const digest = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const engineFiles = (fx) => [fx.stateFile(), fx.engineLog(), fx.planFile, fx.lockFile()];

/** Run `engine-accepted.mjs <cmd>` and assert it wrote none of the engine's files (every call, every path). */
function call(fx, cmd, { last, runId = 'run-1', extra = [] } = {}) {
  const before = engineFiles(fx).map(digest);
  const args = [CLI, cmd, '--repo', fx.repo, '--ticket', 'T-1', '--run-id', runId, ...(last ? ['--last', last] : []), ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: fx.env, timeout: 60000 });
  assert.deepEqual(engineFiles(fx).map(digest), before, `${cmd} changed an engine file: ${r.stdout}${r.stderr}`);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
}
const next = (fx, o) => call(fx, 'next', o);
const view = (fx, o) => call(fx, 'view', o);
let saved = 0;
/** Run the engine's drive and keep its stdout as the --last file. */
function drive(fx) {
  const r = fx.cli('drive');
  const file = join(fx.root, `drive-${++saved}.json`);
  writeFileSync(file, r.stdout);
  return { r, file };
}
const phaseOf = (v, p) => v.phases.find(x => x.phase === p);
const step = (n) => ({ phase: n.out?.phase, action: n.out?.action, cmd: n.out?.command?.cmd ?? null, role: n.out?.role ?? null });
/** A STOP: exit 2, action stop, the code, and no command. */
function stopped(n, code, phase) {
  assert.equal(n.status, 2, n.stdout + n.stderr);
  assert.equal(n.out?.action, 'stop', n.stdout);
  assert.equal(n.out?.code, code, n.stdout);
  if (phase) assert.equal(n.out?.phase, phase, n.stdout);
  assert.equal(n.out?.command, null);
}
/** Every state evidence item names a line of the state file that holds exactly that key and value. */
function evidenceHolds(fx, items) {
  const lines = readFileSync(fx.stateFile(), 'utf8').split('\n');
  const state = items.filter(e => e.source === 'state');
  assert.ok(state.length > 0, 'at least one state record is cited');
  for (const e of state) {
    assert.ok(Number.isInteger(e.line), JSON.stringify(e));
    const key = e.pointer.split('/').at(-1);
    assert.ok(lines[e.line - 1].includes(`${JSON.stringify(key)}: ${JSON.stringify(e.value)}`), `${e.at} is not ${key}=${JSON.stringify(e.value)}: ${lines[e.line - 1]}`);
    assert.equal(e.at, `${fx.stateFile()}:${e.line}`);
  }
}

/** RED node r (spec fails until p exists), production node p, PROVE node q; optional audit record and proof flag. */
function happy(t, { audit = false, config = {} } = {}) {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: TAP_RUNNER }, ...(audit ? { auditRecord: true } : {}), ...config },
    nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: RED_SPECS }, { id: 'p', deps: ['r'], writes: ['src/p.txt'] },
      { id: 'q', deps: ['p'], phase: 'PROVE', writes: ['src/q.txt'] }],
    behaviour: { r: { write: { 'src/r.txt': 'r1' } }, p: { write: { 'src/p.txt': 'p1' } }, q: { write: { 'src/q.txt': 'q1' } } } });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), SPEC);
  return fx;
}

/** One node a; its proof command fails while the file named by PROOF_FLAG (<root>/proof-fails, outside the candidate) exists. */
function flagged(t, opts) {
  const fx = fixture(t, { commit: true, ...(opts?.behaviour ? { behaviour: opts.behaviour } : {}), config: { ...(opts?.audit ? { auditRecord: true } : {}),
    testCommands: { proof: { cmd: process.execPath, args: ['-e', 'process.exit(require("node:fs").existsSync(process.env.PROOF_FLAG ?? "") ? 1 : 0)'] } } } });
  fx.flag = join(fx.root, 'proof-fails');
  fx.env.PROOF_FLAG = fx.flag;
  return fx;
}

// ------------------------------------------------------------------ T1 happy path to owner_publish (audit record off and on)

for (const audit of [false, true]) {
  test(`T1 next names every happy-path step from INIT to owner_publish (auditRecord ${audit})`, { skip: WIN_SKIP }, async (t) => {
    const fx = happy(t, { audit });
    let n = next(fx);
    ok(n, 'no state yet');
    assert.deepEqual(step(n), { phase: 'INIT', action: 'run', cmd: 'init', role: null });
    ok(fx.cli('init', { dag: fx.dagFile }));

    stopped(next(fx), 'acceptance_unknown', 'INIT');
    assert.equal(next(fx).out.facts.settle_with.cmd, 'drive', 'the stop names the engine command whose output settles INIT');

    const d1 = drive(fx);
    ok(d1.r);
    n = next(fx, { last: d1.file });
    ok(n);
    assert.deepEqual(step(n), { phase: 'RED', action: 'run', cmd: 'gate red', role: null });
    assert.deepEqual(n.out.command.input, { node: 'r', command: 'unit' });
    ok(fx.gate('red', n.out.command.input));

    n = next(fx, { last: d1.file });
    ok(n);
    assert.deepEqual(step(n), { phase: 'BUILD', action: 'run', cmd: 'drive', role: 'builder' });
    const d2 = drive(fx);
    ok(d2.r);
    assert.equal(d2.r.out.outcome, 'done');

    n = next(fx, { last: d2.file });
    ok(n);
    assert.deepEqual(step(n), { phase: 'REVIEW', action: 'dispatch', cmd: 'gate review', role: 'reviewer' });
    const cand = fx.candidate();
    assert.equal(n.out.facts.candidate_id, cand);
    assert.ok(n.out.facts.excluded_reviewers.length > 0, 'the builder identities a reviewer must not be');
    ok(fx.gate('review', passReview('rx-1', cand)));

    n = next(fx, { last: d2.file });
    ok(n);
    assert.deepEqual(step(n), { phase: 'SHIP_READY', action: 'run', cmd: 'gate ship-ready', role: null });
    ok(fx.gate('ship-ready', n.out.command.input));

    n = next(fx, { last: d2.file });
    stopped(n, 'owner_publish', 'owner_publish');
    assert.equal(n.out.stop_class, 'owner');

    const v = view(fx, { last: d2.file });
    ok(v);
    assert.deepEqual(v.out.phases.map(p => [p.phase, p.state]), [['INIT', 'accepted'], ['BUILD', 'accepted'], ['RED', 'accepted'],
      ['PROVE', 'accepted'], ['REASSESS', 'not_applicable'], ['REVIEW', 'accepted'], ['SHIP_READY', 'accepted']]);
    assert.equal(v.out.candidate.id, cand);
    for (const p of ['RED', 'REVIEW', 'SHIP_READY']) evidenceHolds(fx, phaseOf(v.out, p).evidence);
    assert.ok(phaseOf(v.out, 'BUILD').evidence.some(e => e.source === 'last' && e.file === d2.file), 'BUILD cites the drive output it was settled by');
  });
}

// ------------------------------------------------------------------ unknown => stop; a stale --last is never acceptance

test('T2 INIT, BUILD, RED and PROVE are unknown from state alone, and a --last that no longer matches the state settles nothing', { skip: WIN_SKIP }, async (t) => {
  const fx = happy(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d1 = drive(fx);
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const d2 = drive(fx);
  assert.equal(d2.r.out.outcome, 'done');

  const v = view(fx);
  ok(v);
  assert.deepEqual(['INIT', 'BUILD', 'RED', 'PROVE'].map(p => phaseOf(v.out, p).state), ['unknown', 'unknown', 'unknown', 'unknown']);
  for (const p of ['INIT', 'BUILD', 'RED', 'PROVE']) assert.ok(phaseOf(v.out, p).reason.length > 0);
  stopped(next(fx), 'acceptance_unknown', 'INIT');

  // d1 was printed while p and q were pending: the state has moved on, so it is stale and settles nothing
  const stale = view(fx, { last: d1.file });
  assert.equal(stale.out.last.usable, false);
  assert.match(stale.out.last.reason, /node/);
  assert.equal(phaseOf(stale.out, 'INIT').state, 'unknown');
  stopped(next(fx, { last: d1.file }), 'acceptance_unknown', 'INIT');

  // an unreadable or non-drive --last is reported, never trusted
  const missing = view(fx, { last: join(fx.root, 'nope.json') });
  ok(missing);
  assert.equal(missing.out.last.usable, false);
  const statusOut = join(fx.root, 'status.json');
  writeFileSync(statusOut, fx.cli('status').stdout);
  assert.equal(view(fx, { last: statusOut }).out.last.usable, false, 'a status (or resume) output is not a drive output');
  stopped(next(fx, { last: statusOut }), 'acceptance_unknown', 'INIT');
});

test('T2 when the last BUILD node owes RED and only a PROVE node waits on it, the unknown BUILD stop is settled by gate red, not by a drive that cannot finish', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: TAP_RUNNER } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: RED_SPECS }, { id: 'q', deps: ['r'], phase: 'PROVE', writes: ['src/p.txt'] }],
    behaviour: { r: { write: { 'src/r.txt': 'r1' } }, q: { write: { 'src/p.txt': 'q1' } } } });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), SPEC);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d1 = drive(fx);
  assert.equal(d1.r.out.outcome, 'waiting');
  assert.deepEqual(d1.r.out.red_pending, ['r']);
  const n = next(fx, { last: d1.file });
  stopped(n, 'acceptance_unknown', 'BUILD');
  assert.equal(n.out.facts.settle_with.cmd, 'gate red');
  assert.deepEqual(n.out.facts.settle_with.input, { node: 'r', command: 'unit' });
  ok(fx.gate('red', n.out.facts.settle_with.input));
  const after = next(fx, { last: d1.file });
  stopped(after, 'acceptance_unknown', 'BUILD');
  assert.equal(after.out.facts.settle_with.cmd, 'drive', 'RED is no longer owed: a drive can now finish');
  const d2 = drive(fx);
  assert.equal(d2.r.out.outcome, 'done');
  assert.deepEqual(step(next(fx, { last: d2.file })), { phase: 'REVIEW', action: 'dispatch', cmd: 'gate review', role: 'reviewer' });
});

// ------------------------------------------------------------------ ok:true is not acceptance

test('T3 an ok:true review_terminal is not REVIEW acceptance: next stops for the owner', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const c = fx.candidate();
  const terminal = fx.gate('review', { review_execution: 'rx-1', kind: 'original',
    primary: primaryReview(c, { outcome: 'FAIL', overflow: true, findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }],
      acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: 'src/a.txt' }] }),
    second_opinion: secondOpinion(c), reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] } });
  assert.equal(terminal.out?.ok, true, terminal.stdout);
  assert.equal(terminal.out?.code, 'review_terminal');
  const v = view(fx, { last: d.file });
  assert.equal(phaseOf(v.out, 'REVIEW').state, 'not_accepted');
  assert.equal(phaseOf(v.out, 'REVIEW').code, 'review_terminal');
  evidenceHolds(fx, phaseOf(v.out, 'REVIEW').evidence);
  const n = next(fx, { last: d.file });
  stopped(n, 'review_terminal', 'REVIEW');
  assert.equal(n.out.stop_class, 'owner');
});

test('T3 an accepted FAIL original is not acceptance; the repair and its confirmation are off the happy path until a PASS confirmation', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } },
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d1 = drive(fx);
  const c1 = fx.candidate();
  const fail = fx.gate('review', failReview('rx-1', c1, 'src/a.txt', fx.prompt('fix')));
  assert.equal(fail.out?.ok, true);
  assert.equal(fail.out?.code, 'review_accepted', 'the gate accepted the FAIL record');
  const owed = view(fx, { last: d1.file }).out;
  assert.equal(phaseOf(owed, 'REVIEW').state, 'not_accepted');
  assert.equal(phaseOf(owed, 'REVIEW').code, 'repair_owed');
  evidenceHolds(fx, phaseOf(owed, 'REVIEW').evidence);
  // the enqueued repair changed the state after d1: d1 settles nothing, so the first phase in order is unknown
  assert.equal(owed.last.usable, false);
  stopped(next(fx, { last: d1.file }), 'acceptance_unknown', 'INIT');

  const d2 = drive(fx); // dispatches the finding-bound repair
  ok(d2.r);
  assert.equal(phaseOf(view(fx, { last: d2.file }).out, 'REVIEW').code, 'confirmation_owed');
  stopped(next(fx, { last: d2.file }), 'confirmation_owed', 'REVIEW');

  const c2 = fx.candidate();
  ok(fx.gate('review', confirmReview('rx-1', c2)));
  const v = view(fx, { last: d2.file });
  assert.equal(phaseOf(v.out, 'REVIEW').state, 'accepted');
  assert.equal(v.out.candidate.id, c2);
  evidenceHolds(fx, phaseOf(v.out, 'REVIEW').evidence);
  assert.deepEqual(step(next(fx, { last: d2.file })), { phase: 'SHIP_READY', action: 'run', cmd: 'gate ship-ready', role: null });
});

// ------------------------------------------------------------------ SHIP_READY ordering trap

test('T4 SHIP_READY reads the LATEST ship-ready GATE note: a later refusal un-accepts it although S.ship_ready still names the candidate', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const c = fx.candidate();
  ok(fx.gate('review', passReview('rx-1', c)));
  ok(fx.gate('ship-ready', {}));
  ok(fx.gate('ship-ready', {}), 'a repeated success writes no second SHIP_READY note');
  let v = view(fx, { last: d.file });
  assert.equal(phaseOf(v.out, 'SHIP_READY').state, 'accepted');
  evidenceHolds(fx, phaseOf(v.out, 'SHIP_READY').evidence);
  const shipNotes = fx.readState().events.filter(e => e.type === 'SHIP_READY');
  assert.equal(shipNotes.length, 1);
  const latestGate = fx.readState().events.filter(e => e.type === 'GATE' && e.gate === 'ship-ready').at(-1);
  assert.ok(phaseOf(v.out, 'SHIP_READY').evidence.some(e => e.pointer.endsWith('/ok') && e.seq === latestGate.seq), 'cites the latest GATE note, not the SHIP_READY note');

  const altered = fx.gate('ship-ready', { exclusions: ['.specs/plans/T-1.md'] });
  assert.equal(altered.out?.code, 'exclusions_altered');
  assert.equal(fx.readState().ship_ready.candidate_id, c, 'the trap: the state record still names the candidate');
  v = view(fx, { last: d.file });
  assert.equal(phaseOf(v.out, 'SHIP_READY').state, 'not_accepted');
  assert.equal(phaseOf(v.out, 'SHIP_READY').code, 'exclusions_altered');
  assert.deepEqual(step(next(fx, { last: d.file })), { phase: 'SHIP_READY', action: 'run', cmd: 'gate ship-ready', role: null });
});

// ------------------------------------------------------------------ repeat-no-progress

test('T5 the same ship-ready refusal twice with no progress record STOPs; unrelated notes never clear it; only the gate\'s own acceptance does', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const c = fx.candidate();
  ok(fx.gate('review', passReview('rx-1', c)));
  writeFileSync(fx.flag, '');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'missing_local_proof');
  assert.deepEqual(step(next(fx, { last: d.file })), { phase: 'SHIP_READY', action: 'run', cmd: 'gate ship-ready', role: null }, 'one refusal is not a repeat');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'missing_local_proof');
  assert.ok(fx.readState().events.some(e => e.type === 'LOCAL_PROOF'), 'each refused call noted LOCAL_PROOF between the refusals: it is not progress');
  let n = next(fx, { last: d.file });
  stopped(n, 'no_progress', 'SHIP_READY');
  assert.deepEqual(n.out.facts.key, { candidate_id: c, gate: 'ship-ready', code: 'missing_local_proof', subject: 'run' });

  // unrelated records: a RESUME note and another gate's refusal
  ok(fx.cli('resume'));
  assert.equal(fx.gate('review', passReview('rx-2', c)).out?.ok, false);
  stopped(next(fx, { last: d.file }), 'no_progress', 'SHIP_READY');
  // a third refusal of the same key keeps it stopped
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'missing_local_proof');
  stopped(next(fx, { last: d.file }), 'no_progress', 'SHIP_READY');

  rmSync(fx.flag);
  ok(fx.gate('ship-ready', {}));
  n = next(fx, { last: d.file });
  stopped(n, 'owner_publish', 'owner_publish');
});

test('T5 a different candidate is a different key; the same candidate again STOPs (review gate, audit record off: wildcard subject)', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const noSecond = (rx, c) => ({ ...passReview(rx, c), second_opinion: null });
  const c1 = fx.candidate();
  assert.equal(fx.gate('review', noSecond('rx-1', c1)).out?.code, 'missing_second_opinion');
  writeFileSync(join(fx.repo, 'src', 'extra.txt'), 'x'); // owned by no node: no drift, a new candidate
  const c2 = fx.candidate();
  assert.notEqual(c2, c1);
  assert.equal(fx.gate('review', noSecond('rx-1', c2)).out?.code, 'missing_second_opinion');
  assert.deepEqual(step(next(fx, { last: d.file })), { phase: 'REVIEW', action: 'dispatch', cmd: 'gate review', role: 'reviewer' },
    'the same code on another candidate is no repeat');
  assert.equal(fx.gate('review', noSecond('rx-2', c2)).out?.code, 'missing_second_opinion');
  const n = next(fx, { last: d.file });
  stopped(n, 'no_progress', 'REVIEW');
  assert.equal(n.out.facts.key.subject, '*', 'without the audit record the subject is unavailable: wildcard');
});

test('T5 with the audit record the review_execution is the subject: another execution is no repeat, the same one is', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t, { audit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const noSecond = (rx, c) => ({ ...passReview(rx, c), second_opinion: null });
  const c = fx.candidate();
  assert.equal(fx.gate('review', noSecond('rx-1', c)).out?.code, 'missing_second_opinion');
  assert.equal(fx.gate('review', noSecond('rx-2', c)).out?.code, 'missing_second_opinion');
  assert.deepEqual(step(next(fx, { last: d.file })), { phase: 'REVIEW', action: 'dispatch', cmd: 'gate review', role: 'reviewer' });
  assert.equal(fx.gate('review', noSecond('rx-2', c)).out?.code, 'missing_second_opinion');
  const n = next(fx, { last: d.file });
  stopped(n, 'no_progress', 'REVIEW');
  assert.deepEqual(n.out.facts.key, { candidate_id: c, gate: 'review', code: 'missing_second_opinion', subject: 'rx-2' });
});

// ------------------------------------------------------------------ hard stops on the real engine

test('T6 hard stops: run mismatch, a binding judgment in the drive output, an engine judgment, and a candidate moved after review (RETRY authority)', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const n0 = next(fx, { runId: 'run-2' });
  stopped(n0, 'run_mismatch');
  assert.equal(n0.out.stop_class, 'owner');

  const d = drive(fx);
  const c = fx.candidate();
  ok(fx.gate('review', passReview('rx-1', c)));
  writeFileSync(join(fx.repo, 'src', 'extra.txt'), 'moved');
  const moved = next(fx, { last: d.file });
  stopped(moved, 'candidate_moved', 'REVIEW');
  assert.equal(moved.out.stop_class, 'owner');
  rmSync(join(fx.repo, 'src', 'extra.txt'));

  writeFileSync(fx.planFile, readFileSync(fx.planFile, 'utf8').replace('Approved narrative.', 'Edited after approval.'));
  const unbound = drive(fx);
  assert.equal(unbound.r.out?.outcome, 'judgment');
  const n1 = next(fx, { last: unbound.file });
  stopped(n1, 'approval_mismatch', 'INIT');
  assert.equal(n1.out.stop_class, 'owner');
});

test('T6 an open engine judgment (a failed node) STOPs with its code', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t, { behaviour: { a: { exit: 1 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const n = next(fx, { last: d.file });
  stopped(n, 'node_failed');
  assert.equal(n.out.stop_class, 'judgment');
  assert.ok(n.out.facts.judgments.some(j => j.code === 'node_failed' && j.node === 'a'));
});

test('T7 usage errors exit 1 and write nothing; view always exits 0', async (t) => {
  const fx = flagged(t);
  const bad = call(fx, 'next', { extra: ['--bogus', 'x'] });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /engine-accepted: /);
  assert.equal(call(fx, 'frobnicate').status, 1);
  ok(view(fx), 'view with no state');
  assert.equal(view(fx).out.phases.find(p => p.phase === 'INIT').state, 'not_accepted');
});

// ------------------------------------------------------------------ pure core: classes a policy-1 fixture cannot reach

const X = 'c'.repeat(64);
/** A crafted run whose every phase up to REVIEW is settled; `over` edits it. */
function crafted(over = {}) {
  const S = { schema: 'ship-ticket-engine-state-v1', ticket: 'T-1', run_id: 'run-1', plan_digest: 'sha256:p', config: {}, seq: 0,
    nodes: { a: { phase: 'BUILD', state: 'done', redSpecs: [] } }, attempts: [], events: [], judgments: [], outbox: [], repairs: [],
    review_chain: [], freeze: null, gates: { red: {} }, builders: [{ identity: 'claude:m', node: 'a' }] };
  const statusOut = { schema: 'ship-ticket-engine-status-v1', judgments: [], authority_untrusted: [], budget: null, red_pending: [] };
  const last = { schema: 'ship-ticket-engine-status-v1', ticket: 'T-1', run_id: 'run-1', nodes: { a: { state: 'done' } }, repairs: [], judgments: [], outcome: 'done' };
  const input = { ticket: 'T-1', runId: 'run-1', S, raw: null, statusOut, candidate: { candidate_id: X }, logText: '', last: { file: '/l.json', value: last },
    files: { state: '/s.json', log: '/l.jsonl' } };
  over(input);
  return input;
}
const pureNext = (over) => nextStep(acceptedView(crafted(over)));

test('T8 pure core: the crafted baseline names the review dispatch (control for every stop below)', () => {
  const n = pureNext(() => {});
  assert.equal(n.action, 'dispatch');
  assert.equal(n.phase, 'REVIEW');
  assert.deepEqual(PHASES, ['INIT', 'BUILD', 'RED', 'PROVE', 'REASSESS', 'REVIEW', 'SHIP_READY']);
});

test('T8 pure core: policy 2 reassess is named when absent or stale, and is UNKNOWN (a stop) when only its candidate and plan digest match', () => {
  const on = (i) => { i.S.config.securityPolicy = 2; };
  const absent = pureNext(on);
  assert.equal(absent.phase, 'REASSESS');
  assert.equal(absent.command.cmd, 'gate reassess');
  const stale = pureNext((i) => { on(i); i.S.security = { reassessed: { candidate_id: 'd'.repeat(64), plan_digest: 'sha256:p' } }; });
  assert.equal(stale.command?.cmd, 'gate reassess');
  const current = pureNext((i) => { on(i); i.S.security = { reassessed: { candidate_id: X, plan_digest: 'sha256:p', catalog_digest: 'sha256:c', addendum_set: [] } }; });
  assert.equal(current.action, 'stop');
  assert.equal(current.code, 'acceptance_unknown');
  assert.equal(current.phase, 'REASSESS');
});

test('T8 pure core: owner-class and unreadable states all STOP', () => {
  const cases = [
    ['budget_spent', 'owner', (i) => { i.statusOut.budget = { ticket: { state: 'stop_dispatch', used: 10, limit: 10 }, phase: null, flags: [] }; }],
    ['budget_unknown', 'unknown', (i) => { i.statusOut.budget = { ticket: { state: 'ok' }, phase: null, flags: ['budget_unenforceable'] }; }],
    ['authority_untrusted', 'owner', (i) => { i.statusOut.authority_untrusted = [{ event: 'RETRY' }]; }],
    ['security_reapproval', 'judgment', (i) => { i.statusOut.judgments = [{ code: 'security_reapproval', node: null, reason: 'r' }]; }],
    ['attempts_live', 'unknown', (i) => { i.S.attempts = [{ attempt_id: 'x', status: 'running' }]; }],
    ['unit_review_owed', 'off_happy_path', (i) => { i.statusOut.unit_reviews_pending = ['u1']; }],
    ['candidate_unavailable', 'unknown', (i) => { i.candidate = { candidate_id: null, reason: 'git failed' }; }],
    ['drive_judgment', 'judgment', (i) => { i.last.value.outcome = 'judgment'; i.last.value.judgments = [{ code: 'budget_stop', node: null }]; }],
    ['state_unreadable', 'unknown', (i) => { i.statusError = { code: 'legacy_state', message: 'm' }; }],
  ];
  for (const [code, cls, over] of cases) {
    const n = pureNext(over);
    assert.equal(n.action, 'stop', code);
    assert.equal(n.code, code === 'state_unreadable' ? 'legacy_state' : code, JSON.stringify(n));
    assert.equal(n.stop_class, cls, code);
    assert.equal(n.command, null, code);
  }
});

test('T8 pure core: a refusal whose GATE event (candidate identity) is in neither the engine log nor the outbox STOPs conservatively', () => {
  const refused = (i) => { i.S.events = [{ seq: 1, type: 'GATE', gate: 'review', ok: false, code: 'missing_second_opinion' }]; i.S.seq = 1; };
  const n = pureNext(refused);
  assert.equal(n.action, 'stop');
  assert.equal(n.code, 'identity_unavailable');
  const known = pureNext((i) => { refused(i); i.S.outbox = [{ event: 'GATE', event_id: 'gate-run-1-1', candidate_id: X }]; });
  assert.equal(known.action, 'dispatch', 'one refusal with a known candidate is no repeat');
  const nul = pureNext((i) => { refused(i); i.logText = JSON.stringify({ event: 'GATE', event_id: 'gate-run-1-1', candidate_id: null }) + '\n'; });
  assert.equal(nul.code, 'identity_unavailable', 'a null candidate on the GATE event is unavailable');
});

test('T8 pure core: SHIP_READY needs every leg on the current candidate: the latest note, S.ship_ready and S.local_proof', () => {
  const shipped = (i) => {
    i.S.review_chain = [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: X }];
    i.S.freeze = { candidate: X, seq: 1 };
    i.S.events = [{ seq: 2, type: 'SHIP_READY', candidate_id: X }, { seq: 3, type: 'GATE', gate: 'ship-ready', ok: true, code: 'ship_ready' }];
    i.S.ship_ready = { candidate_id: X, seq: 2 };
    i.S.local_proof = { candidate_id: X, commands: [], seq: 1 };
  };
  assert.equal(pureNext(shipped).code, 'owner_publish', 'control: every leg names X');
  const other = 'e'.repeat(64);
  for (const [leg, over] of [['ship_ready', (i) => { i.S.ship_ready.candidate_id = other; }], ['local_proof', (i) => { i.S.local_proof.candidate_id = other; }],
    ['latest note', (i) => { i.S.events.push({ seq: 4, type: 'GATE', gate: 'ship-ready', ok: false, code: 'exclusions_altered' });
      i.S.outbox = [{ event: 'GATE', event_id: 'gate-run-1-4', candidate_id: X }]; }]]) {
    const n = pureNext((i) => { shipped(i); over(i); });
    assert.equal(n.action, 'run', leg);
    assert.equal(n.command.cmd, 'gate ship-ready', leg);
  }
});

test('T8 pure core: progress between two refusals (a DISPATCH) means no repeat; a RESUME or an ok:false of another gate does not', () => {
  const two = (between) => (i) => {
    i.S.events = [{ seq: 1, type: 'GATE', gate: 'review', ok: false, code: 'missing_second_opinion' }, ...between,
      { seq: 3, type: 'GATE', gate: 'review', ok: false, code: 'missing_second_opinion' }];
    i.S.outbox = [1, 3].map(s => ({ event: 'GATE', event_id: `gate-run-1-${s}`, candidate_id: X }));
  };
  assert.equal(pureNext(two([{ seq: 2, type: 'DISPATCH', node: 'a' }])).action, 'dispatch');
  assert.equal(pureNext(two([{ seq: 2, type: 'GATE', gate: 'red', ok: true, code: 'red_accepted' }])).action, 'dispatch', 'any gate acceptance is progress');
  assert.equal(pureNext(two([{ seq: 2, type: 'RESUME', outcome: 'reconciled' }])).code, 'no_progress');
  assert.equal(pureNext(two([{ seq: 2, type: 'GATE', gate: 'red', ok: false, code: 'spec_missing' }])).code, 'no_progress');
  assert.equal(pureNext(two([{ seq: 2, type: 'LOCAL_PROOF', passed: false }])).code, 'no_progress');
  // only the gate's own acceptance code clears a stop: a later ok:true review_terminal note of the same gate does not
  const terminalAfter = pureNext((i) => { two([])(i); i.S.events.push({ seq: 4, type: 'GATE', gate: 'review', ok: true, code: 'review_terminal' }); });
  assert.equal(terminalAfter.code, 'no_progress');
});
