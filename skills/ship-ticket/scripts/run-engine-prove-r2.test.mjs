/**
 * S5 repair round 2 (RCA-S5-ROUND2.md "Different path"). Behavioural negatives, each RED on 7deed12:
 *   G1  an interrupted prove (the engine killed while a re-run command runs) leaves NO generation eligible for REVIEW: the
 *       durable prove-generation marker is written before any command is released and survives the crash.
 *   G2  the same under security policy 2.
 *   X1  a non-executable file earlier on PATH is not the identity: the executable that actually runs is fingerprinted (and run).
 *   X2  a relative PATH component resolves against the repository (the runner's cwd), not the engine's cwd.
 *   K6  a REAL surviving launcher child: the engine process exits after recording the survivor (no ref'd pipe keeps it alive).
 *   B1  the policy table refuses, at load, a core version that would collide with the early-checks twins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POSIX, fixture, passReview, primaryReview, waitUntil } from './engine-test-fixture.mjs';
import * as POL from './engine-policy.mjs';
import * as SP from './security-plan.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (N7)';
const J = JSON.stringify;
const NODE = process.execPath;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); return r; };
const git = (repo, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const EARLY = { earlyChecks: { version: 1 } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Commit a T0 check `hold` that records it started and then hangs while <root>/hold exists. */
function declareHold(fx) {
  const started = join(fx.root, 'held'), hold = join(fx.root, 'hold');
  mkdirSync(join(fx.repo, '.ship-ticket'), { recursive: true });
  writeFileSync(join(fx.repo, '.ship-ticket', 't0.json'), J({ checks: [{ name: 'hold', kind: 'other', timeout_ms: 600000,
    cmd: [NODE, '-e', `const fs=require('fs');fs.writeFileSync(${J(started)}, '');fs.existsSync(${J(hold)}) && setInterval(() => {}, 1000)`] }] }));
  git(fx.repo, 'add', '-A'); git(fx.repo, 'commit', '-q', '-m', 'declare early checks');
  return { started, hold };
}

/** Run `gate prove` as a real CLI process, kill it (SIGKILL) while its early check runs, then kill the check's group. */
async function interruptedProve(fx, h) {
  writeFileSync(h.hold, '');
  rmSync(h.started, { force: true });
  const input = join(fx.root, 'prove-input.json');
  writeFileSync(input, '{}');
  const child = fx.spawnCli('gate prove', { input });
  await waitUntil(() => existsSync(h.started), 30000);
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  const a = fx.readState().attempts.find(x => x.node === 'early-check:hold' && x.status === 'running');
  assert.ok(a?.pgid, 'the interrupted early check was released and recorded running');
  try { process.kill(-a.pgid, 'SIGKILL'); } catch { /* gone */ }
  await waitUntil(() => !alive(a.pgid), 10000);
  return a;
}

// ------------------------------------------------------------------ G1 / G2 interrupted prove generation

test('G1 an engine killed while a prove re-run command runs leaves no proof or early-check record eligible for REVIEW', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { unit: { cmd: NODE, args: ['-e', ''] } } } });
  const h = declareHold(fx);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('prove', {}), 'generation 1 completes and passes');
  await interruptedProve(fx, h);
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'prove_required');
  assert.deepEqual(fx.readState().review_chain, []);
  assert.equal(fx.readState().prove_generation?.state, 'running', 'the in-progress marker was persisted before the command was released and survives the crash');
  // Recovery: resume settles the dead attempt (the invalidation survives it), then only a completed new generation makes REVIEW eligible.
  rmSync(h.hold, { force: true });
  fx.cli('resume');
  assert.notEqual(fx.readState().prove_generation.state, 'completed', 'recovery never completes the interrupted generation');
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'prove_required');
  ok(fx.gate('prove', {}));
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
});

const CATALOG = SP.loadCatalog();
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
const SPEC_FILE = 'spec/sec.test.mjs';
const specText = (ids) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `for (const id of ${J(ids)}) test(id, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;

test('G2 [security policy 2] an interrupted prove generation is not eligible for REVIEW either', { skip: WIN_SKIP }, async (t) => {
  const sel = SP.selectControls(CATALOG, { security_policy: 2, surfaces: [{ boundary_id: 'orders-api', kind: 'server-input', path: 'src/orders.ts', principals: ['service'] }],
    facts: Object.fromEntries(BOOLS.map(k => [k, false])), evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/orders.ts:handler'])) });
  const cov = sel.pairs.map(p => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC_FILE, name: p.pair_id }] }));
  const ids = sel.pairs.map(p => p.pair_id);
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(sel) + '\n\n',
    config: { ...EARLY, width: 1, testCommands: { unit: { cmd: NODE, args: ['--test', '--test-reporter=tap', SPEC_FILE], format: 'tap' } },
      securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: cov },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap(c => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }],
    behaviour: { api: { write: { [SPEC_FILE]: specText(ids) } }, impl: { write: { 'src/impl.txt': 'done' } } } });
  const h = declareHold(fx);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
  ok(fx.gate('prove', {}), 'generation 1 proves every pair');
  await interruptedProve(fx, h);
  ok(fx.gate('reassess', {}));
  const cand = fx.candidate();
  const review = passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' },
    ...ids.map(id => ({ subject_id: id, outcome: 'PASS', evidence: SPEC_FILE }))] }) });
  refused(fx.gate('review', review), 'prove_required');
  assert.deepEqual(fx.readState().review_chain, []);
});

// ------------------------------------------------------------------ X1 / X2 execution-equivalent resolution

/** A shell tool that logs each run (and exits 0) at `path`, optionally not executable. */
function tool(path, log, { exec = true, tag = 'v1' } = {}) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n# ${tag}\necho run >> ${J(log)}\nexit 0\n`);
  chmodSync(path, exec ? 0o755 : 0o644);
}
const runs = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

test('X1 a non-executable file earlier on PATH is not the identity: the executable that runs is fingerprinted', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { tool: { cmd: 's5tool', args: [] } } } });
  const log = join(fx.root, 'tool.log'), a = join(fx.root, 'binA', 's5tool'), b = join(fx.root, 'binB', 's5tool');
  tool(a, join(fx.root, 'never.log'), { exec: false });
  tool(b, log);
  fx.env.PATH = `${join(fx.root, 'binA')}:${join(fx.root, 'binB')}:${fx.env.PATH}`;
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('prove', {}));
  assert.equal(runs(log), 1, 'binB/s5tool ran');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  tool(b, log, { tag: 'v2-upgraded' }); // the executable that runs changed; the non-executable binA file did not
  ok(fx.gate('ship-ready', {}));
  assert.equal(runs(log), 2, 'the changed executable was not reused: the proof re-ran');
});

test('X2 a relative PATH component resolves against the repository (the runner cwd), not the engine cwd', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { tool: { cmd: 's5tool', args: [] } } } });
  const log = join(fx.root, 'tool.log'), p = join(fx.root, 'toolbin', 's5tool');
  tool(p, log);
  const rel = relative(fx.repo, join(fx.root, 'toolbin')); // '../toolbin': exists from the repository, not from the engine's cwd
  assert.equal(existsSync(join(process.cwd(), rel, 's5tool')), false, 'control: the relative component names nothing from the engine cwd');
  fx.env.PATH = `${rel}:${fx.env.PATH}`;
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('prove', {}));
  assert.equal(runs(log), 1);
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  tool(p, log, { tag: 'v2-upgraded' });
  ok(fx.gate('ship-ready', {}));
  assert.equal(runs(log), 2, 'the changed repository-relative executable was not reused');
});

// ------------------------------------------------------------------ K6 real surviving child: the engine process exits

test('K6 with a REAL launcher child that survives its deadline kill, the engine process records the survivor and exits', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, timeoutMs: 120000, testCommands: { hang: { cmd: NODE, args: ['-e', ''], timeoutMs: 1000 } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  const pidFile = join(fx.root, 'survivor.pid'), script = join(fx.root, 'k6.mjs');
  const engine = pathToFileURL(fileURLToPath(new URL('./run-engine.mjs', import.meta.url))).href;
  // The injected launcher is a real process in the engine's own process group (so the group kill of its pid finds nothing),
  // that ignores SIGTERM, never reads its release byte and never writes a frame: it outlives the deadline and the grace.
  writeFileSync(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const { gate } = await import(${J(engine)});
const ctx = { repoRoot: ${J(fx.repo)}, ticket: 'T-1', runId: 'run-1', dagFile: ${J(fx.dagFile)}, env: process.env, verifySubscription: () => true,
  handleSignals: false, groupAlive: () => true, killGraceMs: 300,
  spawn: () => { const c = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'ignore'] });
    writeFileSync(${J(pidFile)}, String(c.pid)); return c; } };
const r = await gate({ ...ctx, gate: 'prove', input: {} });
process.stdout.write(JSON.stringify(r) + '\\n');
`);
  const started = Date.now();
  const r = spawnSync(NODE, [script], { encoding: 'utf8', env: fx.env, timeout: 60000 });
  const took = Date.now() - started;
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
  t.after(() => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.notEqual(r.signal, 'SIGTERM', `the engine process did not exit by itself (killed at the 60 s test timeout): ${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(pid && alive(pid), 'control: the real child is still alive when the engine process has exited');
  assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).code, 'quiescence_unknown', r.stdout);
  assert.ok(took < 45000, `exited after ${took} ms`);
  const a = fx.readState().attempts.find(x => x.node === 'hang');
  assert.equal(a.status, 'unknown', 'the survivor stays durably unknown');
});

// ------------------------------------------------------------------ B1 policy-table ceiling

test('B1 a core policy version at or above the early-checks offset is refused when the table is built', () => {
  assert.equal(typeof POL.withEarlyChecksTwins, 'function', 'the twin derivation is exported for this guard');
  assert.throws(() => POL.withEarlyChecksTwins({ 1: Object.freeze({}), [POL.EARLY_CHECKS_OFFSET]: Object.freeze({}) }), /policy_table_ceiling/);
  assert.throws(() => POL.withEarlyChecksTwins({ 1: Object.freeze({}), 2: Object.freeze({ earlyChecks: true }) }), /policy_table_ceiling/);
  const t2 = POL.withEarlyChecksTwins({ 1: Object.freeze({}), 2: Object.freeze({ testKinds: true }) });
  assert.deepEqual(Object.keys(t2), ['1', '2', String(1 + POL.EARLY_CHECKS_OFFSET), String(2 + POL.EARLY_CHECKS_OFFSET)]);
  assert.deepEqual(POL.POLICY_SEMANTICS, POL.withEarlyChecksTwins(POL.PRE_EARLY_CHECKS_SEMANTICS));
});
