/**
 * Stop hook script (stop-hook.mjs): real child process, real engine fixture state. Contract:
 * - block (with the step named) only when the engine names an allowed next step (run/dispatch) or a settle-able
 *   acceptance_unknown; every real stop, ambiguity, error, timeout and stop_hook_active ends in no output;
 * - READ-ONLY: engine files byte-identical around every call.
 * The run/dispatch classes cannot be reached by the hook's own invocation (no --last, so INIT is always unknown):
 * they are tested by feeding REAL `engine-accepted.mjs next --last` output to the exported pure `decide`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview } from './engine-test-fixture.mjs';
import { decide } from './stop-hook.mjs';

const HOOK = fileURLToPath(new URL('./stop-hook.mjs', import.meta.url));
const ACC = fileURLToPath(new URL('./engine-accepted.mjs', import.meta.url));
const WIN_SKIP = POSIX ? false : 'POSIX process groups';
const SPEC = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\n`
  + `test('fails on assertion', () => { assert.equal(existsSync('src/p.txt'), true); });\n`;
const TAP = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };
const digest = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const files = (fx) => [fx.stateFile(), fx.engineLog(), fx.planFile, fx.lockFile()];

function happy(t) {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: TAP } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
      { id: 'p', deps: ['r'], writes: ['src/p.txt'] }],
    behaviour: { r: { write: { 'src/r.txt': 'r1' } }, p: { write: { 'src/p.txt': 'p1' } } } });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), SPEC);
  return fx;
}

/** Run the hook as Claude Code does: JSON on stdin; assert it printed JSON-or-nothing, exited 0 and wrote no engine file. */
function hookRun(fx, input, { env = {}, raw } = {}) {
  const before = files(fx).map(digest);
  const r = spawnSync(process.execPath, [HOOK], { input: raw ?? JSON.stringify(input), encoding: 'utf8', env: { ...fx.env, ...env }, timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(files(fx).map(digest), before, 'the hook changed an engine file');
  assert.equal(r.stderr, '');
  const out = r.stdout === '' ? null : JSON.parse(r.stdout);
  return out;
}
const blocks = (out) => { assert.equal(out?.decision, 'block', JSON.stringify(out)); assert.equal(typeof out.reason, 'string'); return out.reason; };
const allows = (out) => assert.equal(out, null, JSON.stringify(out));
const nextOf = (fx, last) => JSON.parse(spawnSync(process.execPath, [ACC, 'next', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1', ...(last ? ['--last', last] : [])], { encoding: 'utf8', env: fx.env }).stdout);

test('H1 mid-run with an unsettled phase: blocks with "run drive then come back", naming the engine command', { skip: WIN_SKIP }, (t) => {
  const fx = happy(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const reason = blocks(hookRun(fx, { cwd: fx.repo, stop_hook_active: false, session_id: 's' }));
  assert.match(reason, /Run node run-engine\.mjs drive --repo <this repo> --ticket T-1 --run-id run-1 and then come back/);
  assert.match(reason, /phase INIT/);
  assert.ok(!reason.includes(fx.root) && !reason.includes('/'.concat('private')), 'no path of this machine in the reason');
});

test('H2 stop_hook_active true allows stopping even when the engine would continue (the loop bound)', { skip: WIN_SKIP }, (t) => {
  const fx = happy(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  allows(hookRun(fx, { cwd: fx.repo, stop_hook_active: true }));
  blocks(hookRun(fx, { cwd: fx.repo, stop_hook_active: false }));
  blocks(hookRun(fx, { cwd: fx.repo }));
});

test('H3 no run, two runs, malformed stdin, unreadable state, empty stdin and a non-repo cwd all allow stopping', { skip: WIN_SKIP }, (t) => {
  const fx = happy(t);
  allows(hookRun(fx, { cwd: fx.repo })); // no state yet
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  allows(hookRun(fx, null, { raw: '{not json' }));
  allows(hookRun(fx, null, { raw: '' }));
  allows(hookRun(fx, null, { raw: '[]' }));
  allows(hookRun(fx, { cwd: fx.root })); // not a git repository
  allows(hookRun(fx, { cwd: join(fx.root, 'missing') }));
  const state = fx.stateFile();
  const good = readFileSync(state, 'utf8');
  // two live runs: ambiguous
  const second = state.replace('T-1.state.json', 'T-2.state.json');
  writeFileSync(second, good.replace('"ticket": "T-1"', '"ticket": "T-2"'));
  allows(hookRun(fx, { cwd: fx.repo }));
  writeFileSync(second, '{ broken');
  allows(hookRun(fx, { cwd: fx.repo })); // an unreadable sibling makes it ambiguous too
  writeFileSync(second, good.replace('"ticket": "T-1"', '"ticket": "T-9"')); // ticket does not match its file name
  allows(hookRun(fx, { cwd: fx.repo }));
  writeFileSync(second, good.replace('"ticket": "T-1"', '"ticket": "T-2"'));
  writeFileSync(state, '{ unreadable');
  allows(hookRun(fx, { cwd: fx.repo }));
});

test('H4 a real stop allows: an engine judgment/blocker (a live attempt) is not a continuation', { skip: WIN_SKIP }, (t) => {
  const fx = happy(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const S = JSON.parse(readFileSync(fx.stateFile(), 'utf8'));
  writeFileSync(fx.stateFile(), JSON.stringify({ ...S, attempts: [{ node: 'r', status: 'running', id: 'a1' }] }, null, 1) + '\n');
  const n = nextOf(fx);
  assert.equal(n.action, 'stop');
  assert.notEqual(n.code, 'acceptance_unknown', 'the fixture must yield a real stop, not a settle-able one');
  assert.equal(n.facts?.settle_with ?? null, null);
  allows(hookRun(fx, { cwd: fx.repo }));
});

test('H5 timeout allows (engine killed at the limit), exception allows', { skip: WIN_SKIP }, (t) => {
  const fx = happy(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  blocks(hookRun(fx, { cwd: fx.repo })); // the control: the same input blocks with the normal limit
  allows(hookRun(fx, { cwd: fx.repo }, { env: { STOP_HOOK_TIMEOUT_MS: '1' } }));
});

test('H6 decide: run and dispatch block naming the step; owner_publish and every other stop allow (REAL engine next output)', { skip: WIN_SKIP }, (t) => {
  const fx = happy(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const d1 = join(fx.root, 'd1.json'); writeFileSync(d1, fx.cli('drive').stdout);
  let n = nextOf(fx, d1);
  assert.equal(n.action, 'run'); assert.equal(n.phase, 'RED');
  let d = decide(n, 'T-1', 'run-1');
  assert.equal(d.block, true);
  assert.match(d.reason, /exactly this step \(run\): node run-engine\.mjs gate red --repo <this repo> --ticket T-1 --run-id run-1 --input <file holding \{"node":"r","command":"unit"\}>/);
  fx.gate('red', n.command.input);
  const d2 = join(fx.root, 'd2.json'); writeFileSync(d2, fx.cli('drive').stdout);
  n = nextOf(fx, d2);
  assert.equal(n.action, 'dispatch');
  d = decide(n, 'T-1', 'run-1');
  assert.equal(d.block, true);
  assert.match(d.reason, /\(dispatch\): node run-engine\.mjs gate review/);
  fx.gate('review', passReview('rx-1', fx.candidate()));
  n = nextOf(fx, d2); assert.equal(n.phase, 'SHIP_READY');
  assert.equal(decide(n, 'T-1', 'run-1').block, true);
  fx.gate('ship-ready', n.command.input);
  n = nextOf(fx, d2);
  assert.equal(n.code, 'owner_publish');
  assert.equal(decide(n, 'T-1', 'run-1').block, false);
});

test('H7 decide: stops of every other class allow; a settle-less acceptance_unknown allows; malformed input allows', () => {
  const stop = (code, extra = {}) => ({ action: 'stop', phase: 'REVIEW', code, command: null, facts: {}, ...extra });
  for (const c of ['gate_refused', 'no_progress', 'identity_unavailable', 'state_moved', 'owner_publish', 'review_fail_no_repair', 'budget_spent', 'approval_mismatch', 'something_new'])
    assert.equal(decide(stop(c), 'T-1', 'r').block, false, c);
  assert.equal(decide(stop('gate_refused', { stop_class: 'refused', phase: 'REVIEW', reason: 'review refused' }), 'T-1', 'r').block, false, 'a refused gate is the orchestrator\'s to decide');
  assert.equal(decide(stop('acceptance_unknown', { facts: { settle_with: null } }), 'T-1', 'r').block, false);
  assert.equal(decide(stop('acceptance_unknown', { facts: { settle_with: { script: 'run-engine.mjs', cmd: 'drive' } } }), 'T-1', 'r').block, true);
  for (const bad of [null, undefined, 'x', [], {}, { action: 'run' }, { action: 'run', command: { script: 1 } }]) assert.equal(decide(bad, 'T-1', 'r').block, false);
  assert.equal(decide({ action: 'run', phase: 'BUILD', command: { script: 'run-engine.mjs', cmd: 'drive' } }, 'bad id;rm', 'r').block, false);
  // the reason is bounded and printable ASCII even for hostile input
  const evil = decide({ action: 'run', phase: 'BUILD', command: { script: 'run-engine.mjs', cmd: 'drive', input: { x: 'a'.repeat(5000) + '\u0000\n' } } }, 'T-1', 'r');
  assert.ok(evil.reason.length < 900 && /^[\x20-\x7e]+$/.test(evil.reason));
});
