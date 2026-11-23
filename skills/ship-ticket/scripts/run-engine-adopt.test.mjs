/**
 * S-13a (ASTF-7) run adoption, same base, through the real engine CLI (PLAN-S13 §4, tests A1-A9).
 *
 * Flow: `archive --retire true` on the old run (copy, verify, then RENAME the live state, engine log and usage into
 * <archive>/retired/ so `init` of a new run is possible) -> the owner appends a new START for the same narrative -> `init` of
 * the new run -> `adopt --from <archive dir>` -> `drive`. `adopt` writes ONE atomic commit (adopted nodes done with their archived
 * fingerprints, RED evidence carried verbatim, an ADOPTED engine note) or nothing (a whole refusal throws, exit 1). A RED that
 * cannot be carried is the human-owned judgment `adopt_red_unverified` (exit 2), and `drive` then dispatches nothing.
 * Refusals: adopt_refused, adoption_window_closed, adopt_source_outside, adopt_archive_invalid, adopt_source_live,
 * adopt_plan_mismatch, adopt_policy_mismatch, adopt_units_unsupported; archive --retire: retire_live_attempts, retire_mismatch.
 * Tags [D#] name the mutant of engine-adopt-mutation.test.mjs each test kills.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, cpSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POSIX, fixture, narrativeDigest } from './engine-test-fixture.mjs';
import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';
import { archive } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups';
const ENGINE = pathToFileURL(fileURLToPath(new URL('./run-engine.mjs', import.meta.url))).href;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, new RegExp(code)); };
const digest = (f) => 'sha256:' + createHash('sha256').update(readFileSync(f)).digest('hex');
const sha = (b) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const R2 = { runId: 'run-2' };

const FAILING_SPEC = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails on assertion', () => { assert.equal(1, 2); });\n`;
const TAP = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/api.test.mjs'], format: 'tap' };
/** The archived SCRUM-202 run 1 shape (PLAN-S13 fact 6): api-red (32 specs there, 1 here) -> api-impl; web-red -> web-state -> web-ui. */
const ARC_NODES = [
  { id: 'api-red', writes: ['spec/api.test.mjs'], redSpecs: [{ file: 'spec/api.test.mjs', name: 'fails on assertion' }] },
  { id: 'api-impl', deps: ['api-red'], reads: ['spec/api.test.mjs'], writes: ['src/api.txt'] },
  { id: 'web-red', writes: ['src/web-red.txt'] },
  { id: 'web-state', deps: ['web-red'], reads: ['src/web-red.txt'], writes: ['src/web-state.txt'] },
  { id: 'web-ui', deps: ['web-state'], writes: ['src/web-ui.txt'] },
];
const ARC_BEHAVIOUR = { 'api-red': { write: { 'spec/api.test.mjs': FAILING_SPEC } }, 'api-impl': { write: { 'src/api.txt': 'impl' } },
  'web-red': { write: { 'src/web-red.txt': 'web red' } }, 'web-state': { write: { 'src/web-state.txt': 'state' } }, 'web-ui': { write: { 'src/web-ui.txt': 'ui' } } };

/** Run 1 to completion: drive, RED of api-red, drive again (api-impl waits behind the RED barrier). */
function completedRun(t, opts = {}) {
  const fx = fixture(t, { commit: true, nodes: ARC_NODES, behaviour: ARC_BEHAVIOUR, ...opts,
    config: { testCommands: { unit: TAP }, timeoutMs: WORKER_FAILURE_BOUND_MS, ...(opts.config ?? {}) } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  fx.cli('drive');
  ok(fx.gate('red', { node: 'api-red', command: 'unit' }));
  const d = fx.cli('drive');
  ok(d);
  assert.equal(d.out.outcome, 'done', JSON.stringify(d.out.judgments));
  return fx;
}

/** archive --retire run 1, append the owner's START of run 2 for the current narrative, init run 2. */
function retireAndStart(fx, { dag = fx.dagFile } = {}) {
  const r = fx.cli('archive', { retire: 'true' });
  ok(r);
  newStart(fx);
  ok(fx.cli('init', { dag }, R2));
  return r.out.archive;
}
function newStart(fx) {
  fx.appendRunState({ run_id: 'run-2', event: 'START', timestamp: '2026-11-05T00:00:00Z', approved_plan_digest: narrativeDigest(readFileSync(fx.planFile, 'utf8')) });
}
const adoptCli = (fx, from) => fx.cli('adopt', { from }, R2);
const events = (fx, type) => fx.readState().events.filter(e => e.type === type);
const codes = (r) => r.out.adoption.rejected.map(({ node, code }) => ({ node, code }));
const archivedState = (dir) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));

test('[AC1] an unchanged run-1794841415-shaped run: adopt then drive dispatches no builder, RED is byte-equal to the archive', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const runsBefore = fx.runs().length;
  const dir = retireAndStart(fx);
  const a = adoptCli(fx, dir);
  ok(a);
  assert.equal(a.out.outcome, 'adopted');
  assert.deepEqual(a.out.adoption.adopted, ['api-impl', 'api-red', 'web-red', 'web-state', 'web-ui']);
  const s = fx.readState();
  assert.equal(s.run_id, 'run-2');
  assert.equal(JSON.stringify(s.gates.red['api-red']), JSON.stringify(archivedState(dir).gates.red['api-red']), 'historic RED kept verbatim');
  assert.equal(events(fx, 'ADOPTED').length, 1);
  assert.equal(events(fx, 'ADOPTED')[0].from_run, 'run-1');
  const d = fx.cli('drive', {}, R2);
  ok(d);
  assert.equal(d.out.outcome, 'done');
  assert.equal(fx.runs().length, runsBefore, 'no builder re-dispatched');
  assert.equal(fx.readState().attempts.length, 0, 'no RED re-run either');
});

test('[D1] [AC2] an edited write rejects that node and its dependents; drive re-dispatches exactly them', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  writeFileSync(join(fx.repo, 'src', 'web-state.txt'), 'hand edit');
  const a = adoptCli(fx, dir);
  ok(a);
  assert.deepEqual(codes(a), [{ node: 'web-state', code: 'node_files_changed' }, { node: 'web-ui', code: 'dep_not_adopted' }]);
  const before = fx.runs().length;
  ok(fx.cli('drive', {}, R2));
  assert.deepEqual(fx.runs().slice(before).sort(), ['web-state', 'web-ui']);
});

test('[D8] [AC2] a changed node definition (writes) under a dag_bound plan is node_scope_changed', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t, { bind: 'dag_bound' });
  const doc = JSON.parse(readFileSync(fx.dagFile, 'utf8'));
  doc.nodes.find(n => n.id === 'web-ui').writes = ['src/web-ui.txt', 'src/web-ui-extra.txt'];
  const dag2 = join(fx.root, 'dag-2.json'), text = JSON.stringify(doc, null, 2);
  writeFileSync(dag2, text);
  const r = fx.cli('archive', { retire: 'true' });
  ok(r);
  const dir = r.out.archive;
  newStart(fx);
  fx.appendRunState({ run_id: 'run-2', event: 'DAG_BOUND', dag_digest: sha(text) });
  ok(fx.cli('init', { dag: dag2 }, R2));
  const a = adoptCli(fx, dir);
  ok(a);
  assert.deepEqual(codes(a), [{ node: 'web-ui', code: 'node_scope_changed' }]);
  assert.deepEqual(a.out.adoption.rejected[0].fields, ['writes']);
});

test('[D3] [AC2] a different plan narrative refuses the whole adoption (adopt_plan_mismatch), nothing written', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const r = fx.cli('archive', { retire: 'true' });
  ok(r);
  const dir = r.out.archive;
  writeFileSync(fx.planFile, readFileSync(fx.planFile, 'utf8').replace('Approved narrative.', 'Approved narrative, revised.'));
  newStart(fx);
  ok(fx.cli('init', { dag: fx.dagFile }, R2));
  const before = digest(fx.stateFile());
  refused(adoptCli(fx, dir), 'adopt_plan_mismatch');
  assert.equal(digest(fx.stateFile()), before);
});

test('[D6] [AC3] a corrupt manifest fails safe: adopt_archive_invalid, state bytes unchanged', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  const before = digest(fx.stateFile());
  const bad = join(dir, '..', 'run-1-7');
  cpSync(dir, bad, { recursive: true });
  appendFileSync(join(bad, 'engine.jsonl'), '{"event":"FORGED"}\n');
  refused(adoptCli(fx, bad), 'adopt_archive_invalid');
  rmSync(join(bad, 'manifest.json'));
  refused(adoptCli(fx, bad), 'adopt_archive_invalid');
  assert.equal(digest(fx.stateFile()), before);
  ok(adoptCli(fx, dir), 'the intact archive still adopts afterwards');
});

test('[D4] [Neg] a RED spec edited after RED: adopt_red_unverified (exit 2); drive stops with no RED re-run and no dispatch', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  appendFileSync(join(fx.repo, 'spec', 'api.test.mjs'), '// edited after RED\n');
  const a = adoptCli(fx, dir);
  assert.equal(a.status, 2, a.stdout + a.stderr);
  assert.ok(a.out.judgments.some(j => j.code === 'adopt_red_unverified' && j.node === 'api-red'), JSON.stringify(a.out.judgments));
  assert.deepEqual(a.out.adoption.adopted, ['web-red', 'web-state', 'web-ui']);
  assert.equal(fx.readState().gates.red['api-red'], undefined);
  const before = fx.runs().length;
  const d = fx.cli('drive', {}, R2);
  assert.equal(d.status, 2, d.stdout + d.stderr);
  assert.equal(d.out.outcome, 'judgment');
  assert.equal(fx.runs().length, before, 'nothing dispatched');
  assert.equal(fx.readState().attempts.length, 0, 'no RED re-run (it would be spec_not_failing on the implemented tree)');
  assert.equal(events(fx, 'RED_RERUN').length, 0);
});

test('[D5] base moved since RED: adopt_red_unverified (moved) in 13a', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base moves'], { cwd: fx.repo, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const a = adoptCli(fx, dir);
  assert.equal(a.status, 2, a.stdout + a.stderr);
  const rej = a.out.adoption.rejected.find(r => r.node === 'api-red');
  assert.equal(rej.code, 'adopt_red_unverified');
  assert.equal(rej.moved, true);
  assert.equal(fx.readState().gates.red['api-red'], undefined);
});

test('[D7] concurrency: two adopt processes at once give one ADOPTED; the other is adoption_window_closed', { skip: WIN_SKIP }, async (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  const one = () => new Promise((res) => {
    const c = spawn(process.execPath, [fileURLToPath(ENGINE), 'adopt', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-2', '--from', dir], { env: fx.env });
    let err = '';
    c.stderr.on('data', (b) => { err += b; });
    c.on('close', (status) => res({ status, err }));
  });
  const rs = await Promise.all([one(), one()]);
  assert.deepEqual(rs.map(r => r.status).sort(), [0, 1], JSON.stringify(rs));
  assert.match(rs.find(r => r.status === 1).err, /adoption_window_closed/);
  assert.equal(events(fx, 'ADOPTED').length, 1);
  refused(adoptCli(fx, dir), 'adoption_window_closed');
  assert.equal(events(fx, 'ADOPTED').length, 1, 'a sequential second adopt is refused too');
});

/** Run adopt in a child that SIGKILLs itself at the first hit of boundary `at` (the engine-crash technique). */
function crashAdopt(fx, dir, at) {
  const marker = join(fx.root, `crash-${at}`);
  const code = `const job = JSON.parse(process.argv.at(-1));
const { writeFileSync } = await import('node:fs');
const { adopt } = await import(job.engine);
const hooks = { boundary: async (name) => { if (name !== job.at) return; writeFileSync(job.marker, name); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); } };
await adopt({ repoRoot: job.repo, ticket: 'T-1', runId: 'run-2', from: job.from, env: process.env, handleSignals: false, hooks });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ engine: ENGINE, repo: fx.repo, from: dir, at, marker })], { env: fx.env, encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  assert.ok(existsSync(marker), `the crash point ${at} was reached`);
}

test('crash: a kill before the atomic rename leaves nothing; a kill after it leaves everything (none or all)', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  const before = digest(fx.stateFile());
  crashAdopt(fx, dir, 'rename');
  assert.equal(digest(fx.stateFile()), before, 'killed before the rename: state unchanged');
  assert.equal(events(fx, 'ADOPTED').length, 0);
  crashAdopt(fx, dir, 'dir-fsync');
  assert.equal(events(fx, 'ADOPTED').length, 1, 'killed after the rename: the whole adoption is there');
  assert.equal(Object.values(fx.readState().nodes).filter(n => n.state === 'done').length, 5);
  refused(adoptCli(fx, dir), 'adoption_window_closed'); // the stale lock of the killed process is recovered first
});

test('[D10] [D11] source refusals through the CLI: a LIVE archived attempt, a path outside the archive root, a missing --from', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const dir = retireAndStart(fx);
  const live = join(dir, '..', 'run-1-8');
  cpSync(dir, live, { recursive: true });
  const S = archivedState(live);
  S.attempts[0].status = 'running';
  const bytes = Buffer.from(JSON.stringify(S));
  writeFileSync(join(live, 'state.json'), bytes);
  const m = JSON.parse(readFileSync(join(live, 'manifest.json'), 'utf8'));
  m.files['state.json'] = sha(bytes);
  writeFileSync(join(live, 'manifest.json'), JSON.stringify(m));
  refused(adoptCli(fx, live), 'adopt_source_live');
  const outside = mkdtempSync(join(tmpdir(), 'adopt-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  cpSync(dir, outside, { recursive: true });
  refused(adoptCli(fx, outside), 'adopt_source_outside');
  refused(fx.cli('adopt', {}, R2), 'adopt_refused');
  assert.equal(events(fx, 'ADOPTED').length, 0);
});

// ------------------------------------------------------------------ archive --retire (OD-1)

test('[AC-OD1] archive --retire moves the live files into <archive>/retired/ after verifying them; init of a new run then succeeds', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const live = { 'state.json': readFileSync(fx.stateFile()), 'engine.jsonl': readFileSync(fx.engineLog()) };
  refused(fx.cli('init', { dag: fx.dagFile }, R2), 'state_exists');
  const r = fx.cli('archive', { retire: 'true' });
  ok(r);
  assert.deepEqual(r.out.retired, Object.keys(r.out.files).sort().filter(n => n !== 'state.json').concat('state.json'));
  assert.equal(existsSync(fx.stateFile()), false);
  assert.equal(existsSync(fx.engineLog()), false);
  for (const [name, bytes] of Object.entries(live)) {
    assert.ok(readFileSync(join(r.out.archive, 'retired', name)).equals(bytes), `${name} renamed, never rewritten`);
    assert.ok(readFileSync(join(r.out.archive, name)).equals(bytes), `${name} archived copy`);
  }
  newStart(fx);
  ok(fx.cli('init', { dag: fx.dagFile }, R2));
  refused(fx.cli('archive', { retire: 'yes' }, R2), 'archive_refused');
});

test('archive --retire is refused while an attempt is live; the live files stay', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  fx.editState((s) => { s.attempts[0].status = 'running'; });
  refused(fx.cli('archive', { retire: 'true' }), 'retire_live_attempts');
  assert.ok(existsSync(fx.stateFile()));
});

test('[D12] archive --retire is refused when the live bytes differ from the archived copy; nothing is renamed', { skip: WIN_SKIP }, async (t) => {
  const fx = completedRun(t);
  const hooks = { boundary: async (name) => { if (name === 'retire-check') appendFileSync(fx.engineLog(), '{"event":"LATE"}\n'); } };
  await assert.rejects(archive(fx.ctx({ retire: true, hooks })), (e) => e.code === 'retire_mismatch');
  assert.ok(existsSync(fx.stateFile()));
  assert.ok(existsSync(fx.engineLog()));
});

test('archive --retire after a crash between renames: the state stays live, a retry completes it, nothing is lost', { skip: WIN_SKIP }, async (t) => {
  const fx = completedRun(t);
  const state = readFileSync(fx.stateFile()), log = readFileSync(fx.engineLog());
  const hooks = { boundary: async (name, info) => { if (name === 'retire-rename' && info?.name === 'state.json') throw new Error('crash'); } };
  await assert.rejects(archive(fx.ctx({ retire: true, hooks })), /crash/);
  assert.ok(readFileSync(fx.stateFile()).equals(state), 'the state, renamed last, is still live: retry is possible');
  const r = await archive(fx.ctx({ retire: true }));
  assert.ok(readFileSync(join(r.archive, 'retired', 'state.json')).equals(state));
  const first = join(r.archive, '..', 'run-1-1');
  assert.ok(readFileSync(join(first, 'retired', 'engine.jsonl')).equals(log), 'the engine log retired by the first attempt is kept');
  newStart(fx);
  ok(fx.cli('init', { dag: fx.dagFile }, R2));
});

test('[A9] a run that never adopts carries no adoption trace, and archive without --retire still changes nothing', { skip: WIN_SKIP }, (t) => {
  const fx = completedRun(t);
  const s = fx.readState();
  assert.ok(Object.values(s.nodes).every(n => !Object.hasOwn(n, 'adopted')));
  assert.equal(s.events.filter(e => e.type === 'ADOPTED').length, 0);
  const before = digest(fx.stateFile());
  const r = fx.cli('archive');
  ok(r);
  assert.equal(r.out.retired, undefined);
  assert.equal(digest(fx.stateFile()), before);
});
