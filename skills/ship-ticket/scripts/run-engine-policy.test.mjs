/**
 * S-27-min (ASTF-21): policy-version pinning minimum. Threat model: accidental upgrades and
 * downgrades of the installed skill under a live run; a process that rewrites state.json is out of
 * scope (it is the trust anchor, run-engine.mjs).
 *
 * ============================ CONTRACT (S-27-min) ============================
 * Record: `init` writes `policy_version` (this engine's ENGINE_POLICY_VERSION, 1 = the semantics
 *   that existed before the field) and `skill_commit` (git HEAD of the repository that tracks the
 *   running run-engine.mjs, else the literal 'unknown': a copy install, a copy nested untracked in
 *   another repository, no git) into the state, written atomically with every other init field.
 * Legacy: a state WITHOUT the key is version 1 and is never back-filled (byte-identical behaviour).
 * Pinning: the semantics a command applies are those of the RUN's version (policySemantics), never
 *   the newest the engine knows; no command rewrites the recorded version.
 * Refusal: every command that loads an existing state (status, resume, drive, mark, clear-unit,
 *   rebind, every gate) refuses a version this engine does not support with
 *   `policy_version_unsupported` (naming both versions), before any other check and without
 *   writing. A present but malformed value (null, string, 0, fraction) is unsupported, not legacy.
 *   `gate` reports it as a gate refusal (exit 2); the others throw (exit 1). `archive` copies bytes
 *   and applies no semantics, so it stays open: the rescue path for a run no engine can resume.
 * Not executable pinning: the scripts still run from disk as installed (execution-harness.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, POSIX } from './engine-test-fixture.mjs';
import * as engine from './run-engine.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ENGINE_URL = pathToFileURL(join(SCRIPTS, 'run-engine.mjs')).href;
const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown (known limit N7)';
const policy = () => import('./engine-policy.mjs');
const head = (cwd) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();

/** A committed fixture with one node, initialised through the real CLI. */
function initialised(t) {
  const fx = fixture(t, { commit: true });
  const r = fx.cli('init', { dag: fx.dagFile });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return fx;
}

// ------------------------------------------------------------------ AC3: what init records

test('[AC3] init records policy_version 1 and the commit of the skill repository that tracks the engine (not the target repo)', (t) => {
  const fx = initialised(t);
  const S = fx.readState();
  assert.equal(S.policy_version, 1);
  const skill = head(SCRIPTS);
  assert.match(skill, /^[0-9a-f]{40}$/, 'this test runs from a git checkout of the skill');
  assert.equal(S.skill_commit, skill, 'the HEAD of the checkout run-engine.mjs is tracked in');
  assert.notEqual(S.skill_commit, head(fx.repo), 'never the target repository HEAD');
});

/** Run `init` through a copy of the scripts directory placed at `dir`. */
function initFromCopy(fx, dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(SCRIPTS, dir, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
  return spawnSync(process.execPath, [join(dir, 'run-engine.mjs'), 'init', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1', '--dag', fx.dagFile],
    { encoding: 'utf8', env: fx.env, timeout: 60000 });
}

test('[AC3] a copy install outside any git repository records skill_commit "unknown", never a fabricated value', (t) => {
  const fx = fixture(t, { commit: true });
  const r = initFromCopy(fx, join(fx.root, 'copy-install', 'scripts'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fx.readState().skill_commit, 'unknown');
  assert.equal(fx.readState().policy_version, 1);
});

test('[AC3] a copy nested UNTRACKED inside another git repository records "unknown", not that repository\'s HEAD', (t) => {
  const fx = fixture(t, { commit: true });
  const r = initFromCopy(fx, join(fx.repo, 'vendor', 'ship-ticket', 'scripts'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fx.readState().skill_commit, 'unknown');
});

test('[AC3] skillCommit: a git checkout tracking the engine gives its HEAD; a plain or untracked directory gives "unknown"', async (t) => {
  const { skillCommit } = await policy();
  assert.equal(skillCommit(SCRIPTS), head(SCRIPTS));
  const fx = fixture(t, { commit: true });
  assert.equal(skillCommit(fx.root), 'unknown', 'not a git work tree');
  assert.equal(skillCommit(fx.repo), 'unknown', 'a git repository that does not track run-engine.mjs');
  assert.equal(skillCommit(join(fx.root, 'does-not-exist')), 'unknown');
});

test('[AC3] skillCommit ignores an inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE: never a foreign repository\'s HEAD', async (t) => {
  const { skillCommit } = await policy();
  const fx = fixture(t, { commit: true });
  const expected = head(SCRIPTS);
  // A foreign repository whose root index tracks a file named run-engine.mjs.
  const foreign = join(fx.root, 'foreign');
  mkdirSync(foreign);
  spawnSync('git', ['init', '-q'], { cwd: foreign });
  writeFileSync(join(foreign, 'run-engine.mjs'), '// not the engine\n');
  spawnSync('git', ['add', 'run-engine.mjs'], { cwd: foreign });
  const c = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'foreign'], { cwd: foreign, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const foreignHead = head(foreign);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  Object.assign(process.env, { GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, '.git', 'index') });
  let got;
  try { got = [skillCommit(fx.root), skillCommit(SCRIPTS)]; } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.notEqual(got[0], foreignHead, 'a plain directory never reports the redirected repository\'s HEAD');
  assert.equal(got[0], 'unknown');
  assert.equal(got[1], expected, 'the installed checkout\'s own HEAD, not the redirected one');
});

// ------------------------------------------------------------------ the semantics seam

test('[seam] policySemantics maps supported versions to frozen capability flags; v1 is today\'s (no flags); anything else is policy_version_unsupported', async () => {
  const { policySemantics, ENGINE_POLICY_VERSION, POLICY_SEMANTICS } = await policy();
  assert.equal(ENGINE_POLICY_VERSION, 1);
  assert.deepEqual(Object.keys(POLICY_SEMANTICS), ['1', '2']);
  assert.deepEqual(policySemantics(1), {});
  assert.deepEqual(policySemantics(2), { testKinds: true }, 'v2 (S-01b2 P5r) adds the test-kind freeze gate');
  assert.ok(Object.isFrozen(policySemantics(1)) && Object.isFrozen(policySemantics(2)) && Object.isFrozen(POLICY_SEMANTICS));
  for (const v of [3, 0, -1, 1.5, '1', null, undefined]) {
    assert.throws(() => policySemantics(v), (e) => e.code === 'policy_version_unsupported', `version ${JSON.stringify(v)}`);
  }
});

test('[seam] runPolicy: a missing key is version 1 (oldest); a present key is taken as is; the run\'s version wins over a newer engine\'s', async () => {
  const { runPolicy } = await policy();
  const newer = { current: 2, semantics: { 1: Object.freeze({}), 2: Object.freeze({ strictThing: true }) } };
  assert.deepEqual(runPolicy({}), { version: 1, semantics: {} });
  assert.deepEqual(runPolicy({}, newer), { version: 1, semantics: {} }, 'legacy state under a v2 engine keeps v1 semantics');
  assert.deepEqual(runPolicy({ policy_version: 1 }, newer), { version: 1, semantics: {} });
  assert.deepEqual(runPolicy({ policy_version: 2 }, newer), { version: 2, semantics: { strictThing: true } });
  for (const v of [3, null, '1', 0, 1.5]) {
    assert.throws(() => runPolicy({ policy_version: v }), (e) => e.code === 'policy_version_unsupported'
      && e.message.includes(JSON.stringify(v)) && /supports policy_version 1\b/.test(e.message), `state version ${JSON.stringify(v)}`);
  }
});

// ------------------------------------------------------------------ AC1: a run keeps its version across an upgrade

test('[AC1] a v1 run driven, resumed and read by an upgraded engine (v2 injected) stays v1: never re-stamped, and v1 semantics are resolved (no v1/v2 behaviour differs yet, so this pins the version, not a behaviour)', { skip: WIN_SKIP }, async (t) => {
  const fx = initialised(t);
  const v2 = { current: 2, semantics: { 1: Object.freeze({}), 2: Object.freeze({ strictThing: true }) } };
  const ctx = fx.ctx({ policy: v2 });
  const d = await engine.drive(ctx);
  assert.equal(d.outcome, 'done', JSON.stringify(d.judgments));
  await engine.resume(ctx);
  await engine.status(ctx);
  const S = fx.readState();
  assert.equal(S.policy_version, 1, 'the upgraded engine never rewrites the run\'s version');
  const { runPolicy } = await policy();
  assert.deepEqual(runPolicy(S, v2).semantics, {}, 'the run resolves to v1 semantics, not v2\'s flags');
});

test('[AC1] a NEW run initialised by the upgraded engine records the upgraded version', async (t) => {
  const fx = fixture(t, { commit: true });
  await engine.init(fx.ctx({ policy: { current: 2, semantics: { 1: {}, 2: {} } } }));
  assert.equal(fx.readState().policy_version, 2);
});

// ------------------------------------------------------------------ AC2: downgrade refuses, fail closed, at every entry command

/** Every command that loads an existing run's state, with arguments valid enough that only the load can refuse. */
const ENTRY = [
  ['status', (fx) => fx.cli('status'), 1],
  ['resume', (fx) => fx.cli('resume'), 1],
  ['drive', (fx) => fx.cli('drive'), 1],
  ['mark', (fx) => fx.cli('mark', { node: 'a', transition: 'pending->cancelled', reason: 'policy test' }), 1],
  ['clear-unit', (fx) => fx.cli('clear-unit', { unit: 'u1' }), 1],
  ['rebind', (fx) => fx.cli('rebind', { reason: 'policy test' }), 1],
  ['gate red', (fx) => fx.gate('red', { node: 'a' }), 2],
  ['gate review', (fx) => fx.gate('review', {}), 2],
  ['gate ship-ready', (fx) => fx.gate('ship-ready', {}), 2],
  ['gate unit-review', (fx) => fx.gate('unit-review', { unit: 'u1', approved_plan_digest: 'x', dag_digest: 'x', base_commit: 'x' }), 2],
  ['gate reassess', (fx) => fx.gate('reassess', {}), 2],
  ['eval report', (fx) => evalReport(fx), 1],
];

/** `eval.mjs report --ticket T-1`: the read-only report also interprets the run's state. */
function evalReport(fx) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'eval.mjs'), 'report', '--repo', fx.repo, '--ticket', 'T-1'], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  return { status: r.status, out: null, stderr: r.stderr, stdout: r.stdout };
}

test('[AC2] an engine without v3 (it supports 1 and 2) refuses a v3 run at EVERY entry command with policy_version_unsupported naming both versions, writing nothing', async (t) => {
  // The v3 run is created by an injected v3 engine (a real upgrade), then every command runs through the installed v1/v2 CLI (the downgrade).
  const fx = fixture(t, { commit: true });
  await engine.init(fx.ctx({ policy: { current: 3, semantics: { 1: {}, 2: {}, 3: {} } } }));
  const before = readFileSync(fx.stateFile());
  assert.equal(JSON.parse(before).policy_version, 3);
  for (const [name, run, exit] of ENTRY) {
    const r = run(fx);
    assert.equal(r.status, exit, `${name}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    const text = r.stderr + (r.out ? JSON.stringify(r.out) : '');
    assert.match(text, /policy_version_unsupported/, `${name}: coded refusal\n${r.stdout}${r.stderr}`);
    assert.match(text, /policy_version 3/, `${name}: names the run's version`);
    assert.match(text, /supports policy_version 1\b/, `${name}: names the engine's version`);
    if (exit === 2) assert.deepEqual([r.out.ok, r.out.code, r.out.judgment_point], [false, 'policy_version_unsupported', true], name);
    assert.deepEqual(readFileSync(fx.stateFile()), before, `${name}: state bytes unchanged`);
  }
  assert.equal(existsSync(fx.lockFile()), false, 'every refusal released the ticket lock');
});

test('[AC2] a present but malformed policy_version is refused, never read as legacy', (t) => {
  const fx = initialised(t);
  for (const v of [null, '1', 0, 1.5, -1, 99]) {
    fx.editState((s) => { s.policy_version = v; });
    for (const r of [fx.cli('resume'), evalReport(fx)]) {
      assert.equal(r.status, 1, `${JSON.stringify(v)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /policy_version_unsupported/, JSON.stringify(v));
    }
  }
});

test('[AC2] archive stays open for an unsupported run (it copies bytes and applies no semantics: the rollback rescue path)', (t) => {
  const fx = initialised(t);
  fx.editState((s) => { s.policy_version = 3; });
  const r = fx.cli('archive');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(join(r.out.archive, 'state.json'), 'utf8')).policy_version, 3);
});

test('[AC2] the carrier refuses to authorize a REPAIR from the engine state of an unsupported run', async (t) => {
  const { verifyReviewExecution } = await import('./carrier.mjs');
  const fx = initialised(t);
  fx.editState((s) => { s.policy_version = 3; s.review_chain = [{ review_execution: 'rx-1', kind: 'original', outcome: 'FAIL', write_set: ['src/a.txt'] }]; });
  assert.throws(() => verifyReviewExecution(fx.repo, { ticket: 'T-1', run_id: 'run-1' }, 'rx-1', ['src/a.txt']), /policy_version_unsupported/);
  fx.editState((s) => { delete s.policy_version; });
  assert.equal(verifyReviewExecution(fx.repo, { ticket: 'T-1', run_id: 'run-1' }, 'rx-1', ['src/a.txt']), 'engine', 'a legacy state still authorizes');
});

// ------------------------------------------------------------------ legacy: a missing key is version 1, never back-filled

test('[Neg] a state without policy_version (every existing run) keeps working as version 1 and is never back-filled', { skip: WIN_SKIP }, (t) => {
  const fx = initialised(t);
  fx.editState((s) => { delete s.policy_version; delete s.skill_commit; });
  const d = fx.cli('drive');
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.equal(d.out.outcome, 'done');
  for (const cmd of ['resume', 'status']) assert.equal(fx.cli(cmd).status, 0, cmd);
  const S = fx.readState();
  assert.equal(Object.hasOwn(S, 'policy_version'), false, 'no command adds the key to a legacy state');
  assert.equal(Object.hasOwn(S, 'skill_commit'), false);
});

// ------------------------------------------------------------------ crash: the fields are part of the one atomic init write

/** Run `init` in a child that SIGKILLs itself at the first hit of boundary `name` (writes `marker` first). */
async function initKilledAt(fx, name) {
  const marker = join(fx.root, `killed-${name}`);
  const driver = join(fx.root, 'init-crash-driver.mjs');
  writeFileSync(driver, `import { writeFileSync } from 'node:fs';
import { init } from ${JSON.stringify(ENGINE_URL)};
const hooks = { boundary: async (n) => { if (n !== ${JSON.stringify(name)}) return; writeFileSync(${JSON.stringify(marker)}, n); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); } };
await init({ repoRoot: ${JSON.stringify(fx.repo)}, ticket: 'T-1', runId: 'run-1', dagFile: ${JSON.stringify(fx.dagFile)}, handleSignals: false, hooks });
`);
  const child = spawn(process.execPath, [driver], { env: fx.env, stdio: 'ignore' });
  const signal = await new Promise((r) => child.on('exit', (_c, s) => r(s)));
  assert.equal(signal, 'SIGKILL');
  assert.ok(existsSync(marker), `died at ${name}`);
}

test('[crash] SIGKILL before the init rename leaves no state; SIGKILL after it leaves the state WITH both fields; resume keeps the version', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  await initKilledAt(fx, 'rename');
  assert.equal(existsSync(fx.stateFile()), false, 'nothing was installed before the rename');
  rmSync(join(fx.root, 'init-crash-driver.mjs'));
  await initKilledAt(fx, 'dir-fsync'); // the stale lock of the first kill is recovered by acquireLock
  const S = fx.readState();
  assert.deepEqual([S.policy_version, S.skill_commit], [1, head(SCRIPTS)], 'the installed snapshot carries both fields');
  const r = fx.cli('resume');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([fx.readState().policy_version, fx.readState().skill_commit], [1, head(SCRIPTS)], 'resume after the kill keeps them');
});
