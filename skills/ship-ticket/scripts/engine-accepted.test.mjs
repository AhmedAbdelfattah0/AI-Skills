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
import { acceptedView, nextStep, readRun, PHASES } from './engine-accepted.mjs';
import { status } from './run-engine.mjs';
import * as SP from './security-plan.mjs';

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
  // PR-5 (S7a): a recorded repair owes its targeted confirmation, which next now names (dispatch), no longer a stop
  const conf = next(fx, { last: d2.file });
  assert.equal(conf.status, 0, conf.stdout + conf.stderr);
  assert.equal(conf.out?.action, 'dispatch', conf.stdout);
  assert.equal(conf.out?.phase, 'REVIEW');
  assert.equal(conf.out?.command?.cmd, 'gate review');
  assert.deepEqual(conf.out?.command?.input, { kind: 'confirmation', review_execution: 'rx-1' });

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
  const n = next(fx, { last: d.file });
  stopped(n, 'gate_refused', 'SHIP_READY');
  assert.deepEqual(n.out.facts.key, { candidate_id: c, gate: 'ship-ready', code: 'exclusions_altered', subject: 'run' });
});

// ------------------------------------------------------------------ refusals: first refusal stops, repeat is no_progress, only the gate's acceptance clears

test('T5 next never re-names a gate that refused; the same key twice with no progress is no_progress; unrelated notes never clear it; only the gate\'s own acceptance does', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const c = fx.candidate();
  ok(fx.gate('review', passReview('rx-1', c)));
  writeFileSync(fx.flag, '');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'missing_local_proof');
  let n = next(fx, { last: d.file });
  stopped(n, 'gate_refused', 'SHIP_READY');
  assert.equal(n.out.stop_class, 'refused');
  assert.deepEqual(n.out.facts.key, { candidate_id: c, gate: 'ship-ready', code: 'missing_local_proof', subject: 'run' });
  assert.match(n.out.facts.at[0], /engine\.jsonl:\d+$/, 'the key\'s candidate comes from the engine log row');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'missing_local_proof');
  assert.ok(fx.readState().events.some(e => e.type === 'LOCAL_PROOF'), 'each refused call noted LOCAL_PROOF between the refusals: it is not progress');
  n = next(fx, { last: d.file });
  stopped(n, 'no_progress', 'SHIP_READY');
  assert.deepEqual(n.out.facts.key, { candidate_id: c, gate: 'ship-ready', code: 'missing_local_proof', subject: 'run' });

  ok(fx.cli('resume')); // unrelated records: a RESUME note and another gate's refusal
  assert.equal(fx.gate('review', passReview('rx-2', c)).out?.ok, false);
  stopped(next(fx, { last: d.file }), 'no_progress', 'SHIP_READY');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'missing_local_proof');
  stopped(next(fx, { last: d.file }), 'no_progress', 'SHIP_READY');

  rmSync(fx.flag);
  ok(fx.gate('ship-ready', {}));
  stopped(next(fx, { last: d.file }), 'owner_publish', 'owner_publish');
});

test('T5 a refusal on another candidate is another key (gate_refused, not no_progress); the same candidate again is no_progress', { skip: WIN_SKIP }, async (t) => {
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
  let n = next(fx, { last: d.file });
  stopped(n, 'gate_refused', 'REVIEW');
  assert.equal(n.out.facts.key.candidate_id, c2);
  assert.equal(fx.gate('review', noSecond('rx-2', c2)).out?.code, 'missing_second_opinion');
  n = next(fx, { last: d.file });
  stopped(n, 'no_progress', 'REVIEW');
  assert.equal(n.out.facts.key.subject, '*');
});

test('T5 a caller-chosen review_execution is never the subject, with the audit record on too: another execution on the same candidate is still the same key', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t, { audit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const noSecond = (rx, c) => ({ ...passReview(rx, c), second_opinion: null });
  const c = fx.candidate();
  assert.equal(fx.gate('review', noSecond('rx-1', c)).out?.code, 'missing_second_opinion');
  assert.equal(fx.gate('review', noSecond('rx-2', c)).out?.code, 'missing_second_opinion');
  assert.ok(fx.readState().events.some(e => e.type === 'GATE' && e.review_execution === 'rx-2'), 'the audit record carries the execution');
  const n = next(fx, { last: d.file });
  stopped(n, 'no_progress', 'REVIEW');
  assert.deepEqual(n.out.facts.key, { candidate_id: c, gate: 'review', code: 'missing_second_opinion', subject: '*' });
});

// ------------------------------------------------------------------ freshness: a stale --last never advances (Round 1 E1/E1b/E2/E3)

test('T9 after the drive, a moved plan narrative or DAG is an owner stop and a drifted node file is unknown (settle with drive): next never dispatches a reviewer or names ship-ready then', { skip: WIN_SKIP }, async (t) => {
  const fx = happy(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  drive(fx);
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const d = drive(fx);
  assert.equal(d.r.out.outcome, 'done');
  assert.equal(step(next(fx, { last: d.file })).action, 'dispatch', 'control: fresh, the reviewer dispatch is named');
  const edit = (file, from, to) => { const before = readFileSync(file); writeFileSync(file, before.toString('utf8').replace(from, to)); return () => writeFileSync(file, before); };
  for (const [name, apply, code] of [['E1 plan narrative edited after approval', () => edit(fx.planFile, 'Approved narrative.', 'Edited after approval.'), 'approval_mismatch'],
    ['E2 DAG bytes edited', () => edit(fx.dagFile, '"width": 2', '"width": 1'), 'dag_mismatch']]) {
    const undo = apply();
    const n = next(fx, { last: d.file });
    stopped(n, code, 'INIT');
    assert.equal(n.out.stop_class, 'owner', name);
    assert.equal(view(fx, { last: d.file }).out.last.usable, false, name);
    undo();
  }
  const undoDrift = edit(join(fx.repo, 'src', 'p.txt'), 'p1', 'hand edit'); // E3
  const drifted = next(fx, { last: d.file });
  stopped(drifted, 'acceptance_unknown', 'INIT');
  assert.match(drifted.out.reason, /changed since: node input\/output fingerprints drifted: p/);
  assert.equal(drifted.out.facts.settle_with.cmd, 'drive', 'node drift is settled by a drive (it re-runs the stale closure)');
  undoDrift();
  assert.equal(step(next(fx, { last: d.file })).action, 'dispatch', 'restored: fresh again');

  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  assert.equal(step(next(fx, { last: d.file })).cmd, 'gate ship-ready');
  const undo = edit(fx.planFile, 'Approved narrative.', 'Edited after review.'); // E1b
  stopped(next(fx, { last: d.file }), 'approval_mismatch', 'INIT');
  undo();
});

test('T9 --last hardening: oversize, malformed and inconsistent drive outputs are reported unusable (exit 0, never a crash)', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const real = JSON.parse(readFileSync(d.file, 'utf8'));
  const write = (name, value) => { const f = join(fx.root, name); writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return f; };
  const bad = {
    huge: write('huge.json', JSON.stringify({ ...real, pad: 'x'.repeat(300 * 1024) })),
    judgmentsString: write('j.json', { ...real, judgments: 'none' }),
    judgmentEntry: write('je.json', { ...real, judgments: [42] }),
    repairsObject: write('r.json', { ...real, repairs: {} }),
    nodeNoState: write('n.json', { ...real, nodes: { a: {} } }),
    nodesNull: write('nn.json', { ...real, nodes: null }),
    judgmentEntryConsistent: write('jc.json', { ...real, outcome: 'judgment', judgments: [42] }),
    outcomeOdd: write('o.json', { ...real, outcome: 'finished' }),
    judgmentNoJudgments: write('jn.json', { ...real, outcome: 'judgment', judgments: [] }),
    statusKeys: write('s.json', { ...real, base: {} }),
    otherRun: write('or.json', { ...real, run_id: 'run-2' }),
    notJson: write('x.json', '{'),
  };
  for (const [name, file] of Object.entries(bad)) {
    const v = view(fx, { last: file });
    assert.equal(v.status, 0, `${name}: ${v.stderr}`);
    assert.equal(v.out.last.usable, false, name);
    stopped(next(fx, { last: file }), 'acceptance_unknown', 'INIT');
  }
  assert.equal(view(fx, { last: d.file }).out.last.usable, true, 'control: the real drive output is usable');
});

// ------------------------------------------------------------------ hard stops on the real engine

test('T6 hard stops: run mismatch, a candidate moved after review (RETRY authority), and the binding judgment of a FRESH drive output after a plan or DAG edit (an owner stop, never a drive loop)', { skip: WIN_SKIP }, async (t) => {
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

  for (const [file, from, to, code] of [[fx.planFile, 'Approved narrative.', 'Edited after approval.', 'approval_mismatch'], [fx.dagFile, '"width": 2', '"width": 1', 'dag_mismatch']]) {
    const before = readFileSync(file);
    writeFileSync(file, before.toString('utf8').replace(from, to));
    const unbound = drive(fx); // drive without --dag reads the bound DAG file
    assert.equal(unbound.r.out?.outcome, 'judgment');
    assert.ok(unbound.r.out.judgments.some(j => j.code === code), unbound.r.stdout);
    assert.equal(view(fx, { last: unbound.file }).out.last.usable, true, 'a refusal carrying a binding judgment is never read as stale');
    const n = next(fx, { last: unbound.file });
    stopped(n, code, 'INIT');
    assert.equal(n.out.stop_class, 'owner');
    writeFileSync(file, before);
  }
});

test('T6 a state committed between the two state reads (around status) is refused as state_moved, never mixed', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const control = await readRun({ repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1' });
  assert.equal(control.error, undefined, 'control: an undisturbed read');
  const racing = async (ctx) => { const out = await status(ctx); fx.editState((S) => { S.seq += 1; }); return out; };
  const v = await readRun({ repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1', statusFn: racing });
  assert.equal(v.error?.code, 'state_moved');
  assert.equal(nextStep(v).action, 'stop');
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

test('T6 an accepted FAIL original with no finding to fix opens no repair: an owner stop, not repair_owed', { skip: WIN_SKIP }, async (t) => {
  const fx = flagged(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = drive(fx);
  const c = fx.candidate();
  const { repair_prompt_file: _drop, ...deferred } = failReview('rx-1', c, 'src/a.txt', '/x');
  const r = fx.gate('review', { ...deferred, reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'defer' }] } });
  assert.equal(r.out?.code, 'review_accepted', r.stdout);
  assert.deepEqual(fx.readState().repairs, [], 'no repair opened');
  const n = next(fx, { last: d.file });
  stopped(n, 'review_fail_no_repair', 'REVIEW');
  assert.equal(n.out.stop_class, 'owner');
});

test('T6 a cancelled RED-bearing node owes no RED: next goes on to review instead of naming drive forever', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: TAP_RUNNER } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: RED_SPECS }, { id: 'a', writes: ['src/a.txt'] }] });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), SPEC);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('mark', { node: 'r', transition: 'pending->cancelled', reason: 'descoped by the owner' }));
  const d = drive(fx);
  assert.equal(d.r.out.outcome, 'done');
  assert.equal(phaseOf(view(fx, { last: d.file }).out, 'RED').state, 'not_applicable');
  assert.deepEqual(step(next(fx, { last: d.file })), { phase: 'REVIEW', action: 'dispatch', cmd: 'gate review', role: 'reviewer' });
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

// ------------------------------------------------------------------ policy 2 on the real engine (fixture shape of run-engine-security.test.mjs secFx)

const CATALOG = SP.loadCatalog();
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
const SEC_SPEC = 'spec/sec.test.mjs';
/** A policy-2 run: node api writes one spec per pair (fails until src/impl.txt exists), node impl writes it; node extra owns spec2/ (addenda). */
function secFx(t) {
  const sel = SP.selectControls(CATALOG, { security_policy: 2,
    surfaces: [{ boundary_id: 'orders-api', kind: 'server-input', path: 'src/orders.ts', principals: ['service'] }],
    facts: Object.fromEntries(BOOLS.map(k => [k, false])), evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/orders.ts:handler'])) });
  assert.equal(sel.ok, true);
  const ids = sel.pairs.map(p => p.pair_id);
  const cov = sel.pairs.map(p => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SEC_SPEC, name: p.pair_id }] }));
  const spec = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
    + `for (const id of ${JSON.stringify(ids)}) test(id, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(sel) + '\n\n',
    config: { width: 1, testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SEC_SPEC], format: 'tap' } },
      securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: cov },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap(c => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }, { id: 'extra', writes: ['spec2'] }],
    behaviour: { api: { write: { [SEC_SPEC]: spec } }, impl: { write: { 'src/impl.txt': 'done' } }, extra: { write: { 'spec2/added.test.mjs': '// added\n' } } } });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: fx.repo, encoding: 'utf8' });
  g('add', '-A'); assert.equal(g('commit', '-q', '-m', 'base').status, 0);
  fx.review = (rx) => { const c = fx.candidate(); return passReview(rx, c, { primary: primaryReview(c, { rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' },
    ...cov.map(p => ({ subject_id: `${p.boundary}:${p.control}`, outcome: 'PASS', evidence: SEC_SPEC }))] }) }); };
  return fx;
}

test('T10 policy 2: next walks RED, drive, gate reassess, review and ship-ready to owner_publish', { skip: WIN_SKIP }, async (t) => {
  const fx = secFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d1 = drive(fx);
  let n = next(fx, { last: d1.file });
  assert.deepEqual(step(n), { phase: 'RED', action: 'run', cmd: 'gate red', role: null });
  ok(fx.gate('red', n.out.command.input));
  const d2 = drive(fx);
  assert.equal(d2.r.out.outcome, 'done', d2.r.stdout);
  n = next(fx, { last: d2.file });
  assert.deepEqual(step(n), { phase: 'REASSESS', action: 'run', cmd: 'gate reassess', role: null });
  ok(fx.gate('reassess', n.out.command.input));
  const v = view(fx, { last: d2.file }).out;
  assert.equal(phaseOf(v, 'REASSESS').state, 'accepted');
  evidenceHolds(fx, phaseOf(v, 'REASSESS').evidence);
  n = next(fx, { last: d2.file });
  assert.deepEqual(step(n), { phase: 'REVIEW', action: 'dispatch', cmd: 'gate review', role: 'reviewer' });
  ok(fx.gate('review', fx.review('rx-1')));
  n = next(fx, { last: d2.file });
  assert.deepEqual(step(n), { phase: 'SHIP_READY', action: 'run', cmd: 'gate ship-ready', role: null });
  ok(fx.gate('ship-ready', {}));
  stopped(next(fx, { last: d2.file }), 'owner_publish', 'owner_publish');
});

test('T10 policy 2: a reassessment of another candidate, or one taken before a trusted addendum, is owed again: next names gate reassess', { skip: WIN_SKIP }, async (t) => {
  const fx = secFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  drive(fx);
  ok(fx.gate('red', { node: 'api' }));
  const d = drive(fx);
  ok(fx.gate('reassess', {}));
  assert.equal(step(next(fx, { last: d.file })).cmd, 'gate review');

  writeFileSync(join(fx.repo, 'docs', 'note.txt'), 'moved'); // owned by no node: a new candidate, no drift
  let v = view(fx, { last: d.file }).out;
  assert.equal(phaseOf(v, 'REASSESS').code, 'reassess_owed');
  assert.match(phaseOf(v, 'REASSESS').reason, /candidate_id/);
  assert.equal(step(next(fx, { last: d.file })).cmd, 'gate reassess');
  rmSync(join(fx.repo, 'docs', 'note.txt'));

  const id = 'orders-api:VAPT-API-01';
  fx.appendRunState({ run_id: 'run-1', event: 'SECURITY_ADDENDUM', addendum_id: 'add-1', authorized_by: 'owner', reason: 'more controls',
    pairs: [{ boundary: 'added', control: id.split(':')[1], node: 'extra', specs: [{ file: 'spec2/added.test.mjs', name: 'added:VAPT-API-01' }] }] });
  ok(fx.cli('resume')); // an engine command observes (trusts) the line
  v = view(fx).out;
  assert.equal(phaseOf(v, 'REASSESS').code, 'reassess_owed', JSON.stringify(phaseOf(v, 'REASSESS')));
  assert.match(phaseOf(v, 'REASSESS').reason, /addendum_set/);
  const d2 = drive(fx);
  const n = next(fx, { last: d2.file });
  assert.ok(n.out.command?.cmd === 'gate reassess' || n.out.code === 'red_runner_ambiguous' || n.out.action === 'stop', n.stdout);
  assert.notEqual(n.out.action, 'dispatch', 'never a reviewer dispatch on a stale reassessment');
});

// ------------------------------------------------------------------ pure core: classes a policy-1 fixture cannot reach

const X = 'c'.repeat(64);
/** A crafted run whose every phase up to REVIEW is settled; `over` edits it. */
function crafted(over = () => {}) {
  const S = { schema: 'ship-ticket-engine-state-v1', ticket: 'T-1', run_id: 'run-1', plan_digest: 'sha256:p', config: {}, seq: 0,
    nodes: { a: { phase: 'BUILD', state: 'done', redSpecs: [] } }, attempts: [], events: [], judgments: [], outbox: [], repairs: [],
    review_chain: [], freeze: null, gates: { red: {} }, builders: [{ identity: 'claude:m', node: 'a' }] };
  const statusOut = { schema: 'ship-ticket-engine-status-v1', judgments: [], authority_untrusted: [], budget: null, red_pending: [] };
  const last = { schema: 'ship-ticket-engine-status-v1', ticket: 'T-1', run_id: 'run-1', nodes: { a: { state: 'done' } }, repairs: [], judgments: [], outcome: 'done' };
  const input = { ticket: 'T-1', runId: 'run-1', S, raw: null, statusOut, candidate: { candidate_id: X }, logText: '', last: { file: '/l.json', value: last },
    freshness: { plan: true, dag: true, drifted: [] }, sec: null, files: { state: '/s.json', log: '/l.jsonl' } };
  over(input);
  return input;
}
const pureNext = (over) => nextStep(acceptedView(crafted(over)));
const refusal = (seq, gate, code, cand = X) => (i) => { i.S.events.push({ seq, type: 'GATE', gate, ok: false, code }); i.S.outbox.push({ event: 'GATE', event_id: `gate-run-1-${seq}`, candidate_id: cand }); };

test('T8 pure core: the crafted baseline names the review dispatch (control for every stop below)', () => {
  const n = pureNext();
  assert.equal(n.action, 'dispatch');
  assert.equal(n.phase, 'REVIEW');
  assert.deepEqual(PHASES, ['INIT', 'BUILD', 'RED', 'PROVE', 'REASSESS', 'REVIEW', 'SHIP_READY']);
});

test('T8 pure core (PR-5): repair_owed names drive (the engine runs the finding-bound repair); confirmation_owed names the confirmation dispatch', () => {
  const FAIL = { review_execution: 'rx-1', kind: 'original', outcome: 'FAIL', candidate_id: X, fix_findings: [{ id: 'f1' }] };
  const owed = pureNext((i) => { i.S.review_chain = [FAIL]; i.S.freeze = { candidate: X }; });
  assert.equal(owed.action, 'run', JSON.stringify(owed));
  assert.equal(owed.phase, 'REVIEW');
  assert.equal(owed.command.cmd, 'drive');
  assert.equal(owed.role, 'repair');
  assert.equal(owed.facts.owed, 'repair_owed');
  const conf = pureNext((i) => { i.S.review_chain = [FAIL, { review_execution: 'rx-1', kind: 'repair', candidate_id: X }]; i.S.freeze = { candidate: X }; });
  assert.equal(conf.action, 'dispatch', JSON.stringify(conf));
  assert.equal(conf.phase, 'REVIEW');
  assert.equal(conf.command.cmd, 'gate review');
  assert.deepEqual(conf.command.input, { kind: 'confirmation', review_execution: 'rx-1' });
  assert.equal(conf.role, 'reviewer');
  assert.equal(conf.facts.owed, 'confirmation_owed');
  assert.equal(conf.facts.candidate_id, X);
  // a refused review gate since its last acceptance still stops: next never re-names a refusing gate
  const refused = pureNext((i) => { i.S.review_chain = [FAIL, { review_execution: 'rx-1', kind: 'repair', candidate_id: X }]; i.S.freeze = { candidate: X }; refusal(1, 'review', 'stale_candidate')(i); });
  assert.equal(refused.action, 'stop');
  assert.equal(refused.code, 'gate_refused');
  // the terminal stops are unchanged: a failed confirmation, a terminal FAIL and a FAIL with nothing to fix stay owner stops
  const cfail = pureNext((i) => { i.S.review_chain = [FAIL, { review_execution: 'rx-1', kind: 'repair' }, { review_execution: 'rx-1', kind: 'confirmation', outcome: 'FAIL', candidate_id: X }]; i.S.freeze = { candidate: X }; });
  assert.equal(cfail.code, 'confirmation_fail');
  assert.equal(cfail.stop_class, 'owner');
  assert.equal(pureNext((i) => { i.S.review_chain = [{ ...FAIL, overflow: true }]; }).code, 'review_terminal');
  assert.equal(pureNext((i) => { i.S.review_chain = [{ ...FAIL, fix_findings: [] }]; }).code, 'review_fail_no_repair');
});

test('T8 pure core: REASSESS is accepted only on the whole tuple (candidate, plan, catalog, addenda); an unreadable catalog is an owner stop', () => {
  const on = (sec) => (i) => { i.S.config.securityPolicy = 2; i.sec = sec; };
  const SEC = { catalog_digest: 'sha256:c', addendum_set: [] };
  const rec = (over) => (i) => { i.S.security = { reassessed: { candidate_id: X, plan_digest: 'sha256:p', catalog_digest: 'sha256:c', addendum_set: [], ...over } }; };
  const both = (...fs) => (i) => fs.forEach(f => f(i));
  assert.equal(pureNext(on(SEC)).command.cmd, 'gate reassess', 'absent');
  assert.equal(pureNext(both(on(SEC), rec({}))).action, 'dispatch', 'whole tuple matches');
  for (const [k, val] of [['candidate_id', 'd'.repeat(64)], ['plan_digest', 'sha256:q'], ['catalog_digest', 'sha256:old'], ['addendum_set', ['add-1']]]) {
    const n = pureNext(both(on(SEC), rec({ [k]: val })));
    assert.equal(n.command?.cmd, 'gate reassess', k);
  }
  const unread = pureNext(on({ error: 'catalog catalog_missing' }));
  assert.equal(unread.code, 'catalog_unavailable');
  assert.equal(unread.stop_class, 'owner');
  const refused = pureNext(both(on(SEC), refusal(1, 'reassess', 'reassess_unclassified')));
  assert.equal(refused.code, 'gate_refused');
  assert.equal(refused.phase, 'REASSESS');
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

test('T8 pure core: blockers are ordered owner > judgment > unknown > off_happy_path', () => {
  const all = (i) => { i.runId = 'run-2'; i.S.attempts = [{ attempt_id: 'x', status: 'running' }]; i.statusOut.unit_reviews_pending = ['u1'];
    i.statusOut.judgments = [{ code: 'node_failed', node: 'a', reason: 'r' }]; };
  assert.equal(pureNext(all).code, 'run_mismatch');
  assert.equal(pureNext((i) => { all(i); i.runId = 'run-1'; i.last.value.run_id = 'run-1'; }).code, 'node_failed');
  assert.equal(pureNext((i) => { all(i); i.runId = 'run-1'; i.statusOut.judgments = []; }).code, 'attempts_live');
});

test('T8 pure core: a drive output of another run or ticket, drifted nodes or unread freshness settle nothing; a moved plan or DAG is an owner stop', () => {
  for (const over of [(i) => { i.last.value.run_id = 'run-2'; }, (i) => { i.last.value.ticket = 'T-2'; },
    (i) => { i.freshness = { plan: true, dag: true, drifted: ['a'] }; }, (i) => { i.freshness = undefined; }]) {
    const n = pureNext(over);
    assert.equal(n.code, 'acceptance_unknown', String(over));
    assert.equal(n.phase, 'INIT');
  }
  for (const [code, freshness] of [['approval_mismatch', { plan: false, dag: true, drifted: [] }], ['dag_mismatch', { plan: true, dag: false, drifted: [] }]]) {
    for (const last of [true, false]) {
      const n = pureNext((i) => { i.freshness = freshness; if (!last) i.last = null; });
      assert.equal(n.code, code, `${code} with${last ? '' : 'out'} --last`);
      assert.equal(n.stop_class, 'owner');
    }
  }
  const stale = pureNext((i) => { i.freshness = { plan: false, dag: false, drifted: ['a'] }; i.last.value.outcome = 'judgment'; i.last.value.judgments = [{ code: 'dag_mismatch', node: null }]; });
  assert.equal(stale.code, 'dag_mismatch', 'a binding judgment is taken even when freshness also fails');
});

test('T8 pure core: a RED slot owed by an addendum is unknown with NO settle_with (no drive settles it); a refused RED gate is a stop', () => {
  const n = pureNext((i) => { i.S.nodes.a.redSpecs = [{ file: 's', name: 'n' }]; i.S.gates.red.a = { seq: 1, baseline_candidate: X }; i.S.gates.red_addendum = { 'add-1/a': {} }; });
  assert.equal(n.code, 'acceptance_unknown');
  assert.equal(n.phase, 'RED');
  assert.equal(n.facts.settle_with, null);
  const owed = (i) => { i.S.nodes.a.redSpecs = [{ file: 's', name: 'n' }]; i.statusOut.red_pending = ['a']; i.S.config.testCommands = { unit: { cmd: 'x', format: 'tap' } }; };
  assert.equal(pureNext(owed).command.cmd, 'gate red', 'control: RED owed is named');
  const r = pureNext((i) => { owed(i); refusal(1, 'red', 'spec_not_failing')(i); });
  assert.equal(r.code, 'gate_refused');
  assert.equal(r.phase, 'RED');
});

test('T8 pure core: the refusal key\'s identity: an unjoinable or null candidate STOPs as identity_unavailable; a known one as gate_refused', () => {
  const n = pureNext((i) => { i.S.events = [{ seq: 1, type: 'GATE', gate: 'review', ok: false, code: 'missing_second_opinion' }]; });
  assert.equal(n.code, 'identity_unavailable');
  const known = pureNext(refusal(1, 'review', 'missing_second_opinion'));
  assert.equal(known.code, 'gate_refused');
  assert.deepEqual(known.facts.key, { candidate_id: X, gate: 'review', code: 'missing_second_opinion', subject: '*' });
  const nul = pureNext((i) => { i.S.events = [{ seq: 1, type: 'GATE', gate: 'review', ok: false, code: 'c' }]; i.logText = JSON.stringify({ event: 'GATE', event_id: 'gate-run-1-1', candidate_id: null }) + '\n'; });
  assert.equal(nul.code, 'identity_unavailable');
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
  for (const [leg, over] of [['ship_ready', (i) => { i.S.ship_ready.candidate_id = other; }], ['local_proof', (i) => { i.S.local_proof.candidate_id = other; }]]) {
    const n = pureNext((i) => { shipped(i); over(i); });
    assert.equal(n.command?.cmd, 'gate ship-ready', leg);
  }
  const refused = pureNext((i) => { shipped(i); refusal(4, 'ship-ready', 'exclusions_altered')(i); });
  assert.equal(refused.code, 'gate_refused', 'latest note refused');
});

test('T8 pure core: two consecutive refusals are no_progress only with the same key and no progress record between', () => {
  const two = (between, code2 = 'missing_second_opinion', cand2 = X) => (i) => {
    refusal(1, 'review', 'missing_second_opinion')(i); i.S.events.push(...between); refusal(3, 'review', code2, cand2)(i);
  };
  assert.equal(pureNext(two([{ seq: 2, type: 'DISPATCH', node: 'a' }])).code, 'gate_refused', 'a DISPATCH is progress');
  assert.equal(pureNext(two([{ seq: 2, type: 'GATE', gate: 'red', ok: true, code: 'red_accepted' }])).code, 'gate_refused', 'any gate acceptance is progress');
  assert.equal(pureNext(two([], 'reviewer_is_builder')).code, 'gate_refused', 'another code is another key');
  assert.equal(pureNext(two([], 'missing_second_opinion', 'd'.repeat(64))).code, 'gate_refused', 'another candidate is another key');
  assert.equal(pureNext(two([{ seq: 2, type: 'RESUME', outcome: 'reconciled' }])).code, 'no_progress');
  assert.equal(pureNext(two([{ seq: 2, type: 'GATE', gate: 'red', ok: false, code: 'spec_missing' }])).code, 'no_progress');
  assert.equal(pureNext(two([{ seq: 2, type: 'LOCAL_PROOF', passed: false }])).code, 'no_progress');
  // only the gate's own acceptance code clears: a later ok:true review_terminal note of the same gate does not
  assert.equal(pureNext((i) => { two([])(i); i.S.events.push({ seq: 4, type: 'GATE', gate: 'review', ok: true, code: 'review_terminal' }); }).code, 'no_progress');
  assert.equal(pureNext((i) => { two([])(i); i.S.events.push({ seq: 4, type: 'GATE', gate: 'review', ok: true, code: 'review_accepted' }); }).action, 'dispatch', 'the gate\'s own acceptance clears');
});

test('T8 pure core: a binding judgment in a fresh drive output is an owner stop at INIT', () => {
  const n = pureNext((i) => { i.last.value.outcome = 'judgment'; i.last.value.judgments = [{ code: 'approval_mismatch', node: null }]; });
  assert.equal(n.code, 'approval_mismatch');
  assert.equal(n.phase, 'INIT');
  assert.equal(n.stop_class, 'owner');
});
