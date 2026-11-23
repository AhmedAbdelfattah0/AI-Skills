/**
 * S-14a (ASTF-8) `status` next_action through the REAL engine CLI (`node run-engine.mjs` on a temp git repo with a fake
 * provider). Tags [Nx] name the mutants of engine-next-mutation.test.mjs each test must kill.
 *   R13 [N11] status writes nothing (state, engine log, plan RUN-STATE, run log byte-identical) and every pre-existing key
 *       deep-equals the pre-14a golden (run-engine-next.golden.json, captured on main with S14A_GOLDEN_CAPTURE=<file>)
 *   R4 corrupt or unsupported state: exit 1 and the stderr line kept, plus a stdout FAIL JSON; no state: READY init
 *   R6 an attempt envelope on disk is unconsumed (resume); empty after resume
 *   R7/R8 [N7] AC3 orchestrator mode, in a LINKED worktree (the run log lives in the common dir): a bound review result with no
 *       chain record is unconsumed and answers gate_review with its path, never dispatch_review; empty after the gate; a forged
 *       binding is ignored; a damaged log sets unconsumed_complete false
 *   R9 [N8] ready_work: a pending node with done deps listed, a node with a LIVE attempt excluded, budget stop empties it
 *   R10 liveness of a recorded attempt: alive (equal start time), then dead with BLOCKED resume
 *   a throw while deriving never fails a working status (human stop, existing keys intact)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview, codes } from './engine-test-fixture.mjs';
import { processInfo } from './engine-quiesce.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (known limit N7)';
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, 'run-engine.mjs'), RUN_LOG = join(HERE, 'run-log.mjs');
const GOLDEN = join(HERE, 'run-engine-next.golden.json');
/** The keys S-14a adds to status; every other key is pre-existing. */
const NEW_KEYS = ['next_action', 'stages', 'unconsumed_results', 'unconsumed_complete', 'ready_work', 'ready_work_capacity', 'liveness'];
/** next_action of a status answer, asserted present first (RED on main is an assertion, never a TypeError). */
const NA = (r) => { assert.ok(r.out?.next_action, `status carries next_action: ${String(r.stdout).slice(0, 200)}`); return r.out.next_action; };
const LIVENESS = (r) => { assert.ok(Array.isArray(r.out?.liveness), 'status carries liveness'); return r.out.liveness; };
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const hash = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const commonLog = (repo) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'ai-skills', 'ship-ticket', 'T-1.jsonl');
const existing = (out, root) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k]) => !NEW_KEYS.includes(k)))).split(root).join('<root>'));

/** The R13 scenarios: each leaves the fixture in one state and returns its name. */
const R13_SCENARIOS = {
  after_init: (fx) => ok(fx.cli('init', { dag: fx.dagFile })),
  after_drive: (fx) => { ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); },
  node_failed: (fx) => { fx.behave({ a: { exit: 3 } }); ok(fx.cli('init', { dag: fx.dagFile })); fx.cli('drive'); },
  red_spec_changed: (fx) => {
    ok(fx.cli('init', { dag: fx.dagFile }));
    fx.editState(s => { s.nodes.a.state = 'done'; s.nodes.a.redSpecs = ['src/a.test.mjs']; s.gates.red.a = { spec_digests: { 'src/a.test.mjs': 'sha256:' + '0'.repeat(64) }, command: 'x' }; });
  },
  after_review_pass: (fx) => { ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('review', passReview('review-1', fx.candidate()))); },
};
const r13Fixture = (t) => fixture(t, { commit: true, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', deps: ['a'], writes: ['src/b.txt'] }],
  behaviour: { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } } } });

test('R13 [N11] status writes nothing and every pre-existing status key equals the pre-14a golden', { skip: WIN_SKIP }, async (t) => {
  const capture = process.env.S14A_GOLDEN_CAPTURE, golden = capture ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'));
  for (const [name, setup] of Object.entries(R13_SCENARIOS)) {
    const fx = r13Fixture(t);
    setup(fx);
    const files = [fx.stateFile(), fx.engineLog(), fx.planFile, fx.usageFile(), commonLog(fx.repo)];
    const before = files.map(hash);
    const r = fx.cli('status');
    ok(r, name);
    assert.deepEqual(files.map(hash), before, `${name}: status wrote nothing`);
    if (capture) { golden[name] = existing(r.out, fx.root); continue; }
    assert.deepEqual(existing(r.out, fx.root), golden[name], `${name}: pre-existing keys unchanged`);
    for (const k of NEW_KEYS) assert.ok(Object.hasOwn(r.out, k), `${name}: ${k} added`);
    if (name === 'red_spec_changed') {
      assert.deepEqual(r.out.red_pending, [], 'status never invalidates RED');
      assert.deepEqual(r.out.ready_work.filter(w => w.id === 'b'), [], 'b waits: RED of a no longer binds (read-only check)');
    }
  }
  if (capture) writeFileSync(capture, JSON.stringify(golden, null, 2) + '\n');
});

test('R4 corrupt or unsupported state: exit 1 and the same stderr line, plus a stdout FAIL JSON; no state: READY init', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true });
  let r = fx.cli('status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^run-engine: no_state: /);
  assert.deepEqual([NA(r).action, NA(r).disposition, NA(r).turn_end], ['init', 'READY', 'CONTINUE']);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const good = readFileSync(fx.stateFile(), 'utf8');
  for (const [name, bytes, code, action] of [['malformed JSON', '{"schema":', null, 'owner_decide'],
    ['unsupported policy version', JSON.stringify({ ...JSON.parse(good), policy_version: 999 }), 'policy_version_unsupported', 'authorize_fallback'],
    ['partial pin', JSON.stringify({ ...JSON.parse(good), base: null }), 'base_state_missing', 'owner_decide']]) {
    writeFileSync(fx.stateFile(), bytes);
    r = fx.cli('status');
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /^run-engine: /, name);
    const a = NA(r);
    assert.deepEqual([r.out.ticket, r.out.run_id], ['T-1', 'run-1'], name);
    assert.deepEqual([a.disposition, a.turn_end, a.action], ['FAILED', 'FAIL', action], name);
    if (code) assert.equal(a.code, code, name);
    assert.equal(readFileSync(fx.stateFile(), 'utf8'), bytes, `${name}: nothing written`);
  }
});

test('R6 an attempt envelope on disk is an unconsumed result owed to resume; empty after resume', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const env = join(dirname(fx.stateFile()), 'T-1.attempts', 'att-x.envelope.json');
  mkdirSync(dirname(env), { recursive: true });
  writeFileSync(env, JSON.stringify({ exit_code: 0, stdout_file: join(fx.root, 'none.out') }));
  fx.editState(s => { s.nodes.a.state = 'running'; s.attempts.push({ attempt_id: 'att-x', kind: 'node', node: 'a', phase: 'BUILD', provider: 'claude', status: 'launched',
    pid: 2147483000, pgid: 2147483000, leader_start: null, resources: [], allowed: ['src/a.txt'], excluded: [], envelope_file: env, started_at: new Date().toISOString() }); });
  let r = fx.cli('status');
  ok(r);
  assert.deepEqual(r.out.unconsumed_results, [{ kind: 'attempt_envelope', id: 'att-x', node: 'a', marker: env, action: 'resume' }]);
  assert.deepEqual([r.out.next_action.stage, r.out.next_action.action, r.out.next_action.code], ['BUILD', 'resume', 'attempt_uncollected']);
  fx.cli('resume');
  r = fx.cli('status');
  assert.deepEqual(r.out.unconsumed_results, [], 'resume consumed it');
});

test('R7 R8 [N7] AC3 (orchestrator mode, linked worktree): a bound result yields gate_review with its path, never dispatch_review; empty after the gate', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t);
  git(fx.repo, 'add', '-A'); git(fx.repo, 'commit', '-q', '-m', 'base');
  const wt = join(fx.root, 'wt');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: fx.env, cwd: wt });
  const eng = (cmd, flags = {}) => { const r = run(ENGINE, [...cmd.split(' '), '--repo', wt, '--ticket', 'T-1', '--run-id', 'run-1', ...Object.entries(flags).flat()]);
    let out = null; try { out = JSON.parse(r.stdout); } catch { /* not JSON */ } return { ...r, out }; };
  const log = (...a) => { const r = run(RUN_LOG, [...a, '--repo', wt, '--ticket', 'T-1', '--run-id', 'run-1']); assert.equal(r.status, 0, r.stderr); };
  ok(eng('init', { '--dag': fx.dagFile }));
  ok(eng('drive'));
  let r = eng('status');
  assert.equal(NA(r).action, 'dispatch_review');
  const cand = r.out.next_action.detail.candidate_id;
  const res = { primary: join(fx.root, 'res-primary.json'), second_opinion: join(fx.root, 'res-second.json') };
  log('start', '--kind', 'activity', '--name', 'primary_review', '--event-id', 'ev-p', '--metric', `candidate_id=${cand}`, '--metric', 'review_execution=review-1', '--carrier-result', res.primary);
  log('start', '--kind', 'activity', '--name', 'optional_review', '--event-id', 'ev-s', '--metric', `candidate_id=${cand}`, '--metric', 'review_execution=review-1', '--carrier-result', res.second_opinion);
  assert.ok(existsSync(commonLog(wt)) && commonLog(wt) !== join(git(wt, 'rev-parse', '--path-format=absolute', '--git-dir'), 'ai-skills', 'ship-ticket', 'T-1.jsonl'), 'the run log is in the common dir, not the worktree git dir');
  r = eng('status');
  assert.deepEqual([r.out.next_action.action, r.out.next_action.disposition], ['wait', 'WAITING'], 'reviewers dispatched, no result yet');
  assert.ok(r.out.liveness.some(l => l.subject === 'review' && l.state === 'unknown' && l.reason === 'no_pid_recorded'), 'reviewer liveness is claimed only');
  // a forged binding (result_path not bound to the start's own candidate and execution) is never a result
  const forged = readFileSync(commonLog(wt), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.event_id === 'ev-p');
  writeFileSync(join(fx.root, 'forged.json'), '{}');
  appendFileSync(commonLog(wt), JSON.stringify({ ...forged, event_id: 'ev-f', metrics: { ...forged.metrics, review_execution: 'review-7' },
    carrier_binding: { ...forged.carrier_binding, result_path: join(fx.root, 'forged.json'), review_execution: 'review-6' } }) + '\n');
  // the reviewers finish, then the orchestrator dies before gate review: a fresh status
  writeFileSync(res.primary, '{}'); writeFileSync(res.second_opinion, '{}');
  r = eng('status');
  ok(r);
  const a = r.out.next_action;
  assert.deepEqual([a.stage, a.action, a.disposition, a.code], ['REVIEW', 'gate_review', 'READY', 'results_ready'], JSON.stringify(a));
  assert.deepEqual(a.detail.results.map(x => x.result_path).sort(), [res.primary, res.second_opinion].sort());
  assert.deepEqual(r.out.unconsumed_results.map(u => [u.kind, u.role, u.marker, u.action]).sort(),
    [['review_result', 'primary', res.primary, 'gate_review'], ['review_result', 'second_opinion', res.second_opinion, 'gate_review']]);
  assert.equal(r.out.unconsumed_complete, true);
  ok(eng('gate review', { '--input': (writeFileSync(join(fx.root, 'in.json'), JSON.stringify(passReview('review-1', cand))), join(fx.root, 'in.json')) }));
  r = eng('status');
  assert.deepEqual(r.out.unconsumed_results, [], 'the chain record consumed both results');
  assert.deepEqual([r.out.next_action.stage, r.out.next_action.action], ['SHIP_READY', 'gate_ship_ready']);
  appendFileSync(commonLog(wt), '{"torn":\n');
  assert.equal(eng('status').out.unconsumed_complete, false, 'a damaged log never reads as nothing owed');
});

test('R9 [N8] ready_work: a pending node with done deps is listed, a node with a LIVE attempt is not; budget stop empties it', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', deps: ['a'], writes: ['src/b.txt'] }, { id: 'c', writes: ['src/c.txt'] }] });
  ok(fx.cli('init', { dag: fx.dagFile }));
  fx.editState(s => { s.nodes.a.state = 'done'; s.nodes.c.state = 'running';
    s.attempts.push({ attempt_id: 'att-c', kind: 'node', node: 'c', phase: 'BUILD', provider: 'claude', status: 'intent', resources: [], started_at: new Date().toISOString() }); });
  let r = fx.cli('status');
  ok(r);
  assert.deepEqual(r.out.ready_work, [{ kind: 'node', id: 'b', action: 'drive', fits: true, admission: 'at_dispatch' }]);
  assert.equal(r.out.ready_work_capacity, 'open');
  fx.editState(s => { s.config.budget = { ticket_tokens: 1 }; s.usage.push({ provider: 'claude', run_id: 'run-1', source: 'engine', source_execution_id: 'u1', input_tokens: 5, output_tokens: 0 }); });
  r = fx.cli('status');
  assert.deepEqual([r.out.ready_work, r.out.ready_work_capacity], [[], 'budget_stop']);
});

test('R10 liveness of a recorded attempt is verified: alive with an equal start time, then dead and BLOCKED resume', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const start = processInfo(child.pid).startTime;
  fx.editState(s => { s.nodes.a.state = 'running'; s.attempts.push({ attempt_id: 'att-l', kind: 'node', node: 'a', phase: 'BUILD', provider: 'claude', status: 'launched',
    pid: child.pid, pgid: child.pid, leader_start: start, resources: [], envelope_file: join(fx.root, 'none.envelope.json'), started_at: new Date().toISOString() }); });
  let r = fx.cli('status');
  assert.deepEqual(LIVENESS(r).find(l => l.id === 'att-l'), { subject: 'attempt', id: 'att-l', pid: child.pid, method: 'kill0+start_time', state: 'alive', reason: 'start_time_equal' });
  assert.deepEqual([r.out.next_action.action, r.out.next_action.disposition], ['wait', 'WAITING']);
  fx.editState(s => { s.attempts[0].leader_start = 'Mon Jan  1 00:00:00 2001'; });
  assert.equal(fx.cli('status').out.liveness.find(l => l.id === 'att-l').reason, 'pid_reused', 'a different start time is never alive');
  fx.editState(s => { s.attempts[0].leader_start = start; });
  process.kill(-child.pid, 'SIGKILL');
  await new Promise(res => child.on('exit', res));
  r = fx.cli('status');
  assert.equal(r.out.liveness.find(l => l.id === 'att-l').state, 'dead');
  assert.deepEqual([r.out.next_action.action, r.out.next_action.code, r.out.next_action.turn_end], ['resume', 'attempt_dead_unreconciled', 'CONTINUE']);
});

test('a throw while deriving never fails a working status: a human stop, existing keys intact', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  fx.editState(s => { s.nodes.a.deps = ['ghost']; });
  const r = fx.cli('status');
  ok(r);
  assert.deepEqual(Object.keys(r.out.nodes), ['a']);
  assert.deepEqual([NA(r).code, NA(r).owner, NA(r).turn_end], ['next_underived', 'human', 'WAIT_FOR_USER']);
  assert.equal(r.out.unconsumed_complete, false);
  assert.deepEqual(codes(r.out), []);
});
