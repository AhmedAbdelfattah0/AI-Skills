/**
 * S5 repair round 1 (PR #148 review: Codex 5 MAJOR + 1 MINOR, Opus MINOR-1/3/5). Behavioural negatives, each RED on 2cb42f1:
 *   P1  an opted-in run records an early-checks policy version (core + EARLY_CHECKS_OFFSET); an engine without S5 (its table is
 *       PRE_EARLY_CHECKS_SEMANTICS) refuses to resume it, and a version/config disagreement is never resumed.
 *   R2  re-running a declared setup re-runs every consumer of its resource: no verdict is assembled from two setup executions.
 *   S3  security policy 2: prove (and REVIEW) refuse while a pair spec is skipped, missing or truncated (control_unproven).
 *   F4  an early check's output is never written to disk, also when its runner ends in quiescence_unknown; the refusal unbinds
 *       the earlier passing records (MINOR-5) and blocks later work.
 *   K5  a timed-out runner whose kill fails is reported a survivor within a bounded time (no lock held forever).
 *   T6  a T0 timeout_ms below 1 s is kept as declared.
 *   M1  a proof entry that changes the tree or the approved plan during prove binds no proof (MINOR-1).
 *   M3  early checks run with every GIT_* variable removed, as standalone T0 (MINOR-3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { POSIX, fixture, passReview, primaryReview } from './engine-test-fixture.mjs';
import { gate as gateCmd } from './run-engine.mjs';
import * as POL from './engine-policy.mjs';
// Namespace import so this file also loads (and fails on its assertions) against the pre-repair engine (RED evidence).
const { POLICY_SEMANTICS } = POL, PRE_EARLY_CHECKS_SEMANTICS = POL.PRE_EARLY_CHECKS_SEMANTICS ?? POL.POLICY_SEMANTICS, EARLY_CHECKS_OFFSET = POL.EARLY_CHECKS_OFFSET ?? 100;
import * as SP from './security-plan.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (proof runners end in quiescence_unknown judgments on Windows)';
const J = JSON.stringify;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); return r; };
const git = (repo, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const EARLY = { earlyChecks: { version: 1 } };
const NODE = process.execPath;
const files = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]) : []);
const inProc = (fx, kind, input, extra = {}) => gateCmd({ ...fx.ctx(extra), gate: kind, input });

/** Commit a T0 declaration (and any tool files) at the base. */
function declare(fx, checks, tools = {}) {
  mkdirSync(join(fx.repo, '.ship-ticket'), { recursive: true });
  for (const [p, text] of Object.entries(tools)) { mkdirSync(join(fx.repo, p, '..'), { recursive: true }); writeFileSync(join(fx.repo, p), text); }
  writeFileSync(join(fx.repo, '.ship-ticket', 't0.json'), J({ checks }));
  git(fx.repo, 'add', '-A'); git(fx.repo, 'commit', '-q', '-m', 'declare early checks');
}
const ECHO_SCANNER = `import { readFileSync } from 'node:fs';
const hit = /SECRET-[A-Za-z0-9]+/.exec(process.argv.slice(2).map(f => readFileSync(f, 'utf8')).join('\\n'));
if (hit) { process.stdout.write('found ' + hit[0] + '\\n'); process.stderr.write('found ' + hit[0] + '\\n'); }
process.exit(hit ? 1 : 0);
`;

// ------------------------------------------------------------------ P1 policy version

test('P1 an opted-in run records an early-checks policy version; an engine without S5 refuses to resume it; a disagreement is never resumed', async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { unit: { cmd: NODE, args: ['-e', ''] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const v = fx.readState().policy_version;
  assert.ok(v > EARLY_CHECKS_OFFSET && POLICY_SEMANTICS[v].earlyChecks === true, `recorded ${v}`);
  // The frozen engine (origin/main before S5) has exactly the core table: its resume logic must refuse the run.
  const old = await inProc(fx, 'review', passReview('rx-1', fx.candidate()), { policy: { current: 1, semantics: PRE_EARLY_CHECKS_SEMANTICS } });
  assert.equal(old.code, 'policy_version_unsupported', J(old));
  assert.deepEqual(fx.readState().review_chain, [], 'no review was recorded by the older engine');
  // A state whose version and config disagree (either way) is never resumed.
  fx.editState((S) => { S.policy_version = v - EARLY_CHECKS_OFFSET; });
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'early_checks_state_missing');
  const legacy = fixture(t, { commit: true, config: { testCommands: { unit: { cmd: NODE, args: ['-e', ''] } } } });
  ok(legacy.cli('init', { dag: legacy.dagFile }));
  const lv = legacy.readState().policy_version;
  assert.ok(lv < EARLY_CHECKS_OFFSET, 'a run without the opt-in keeps its core version');
  legacy.editState((S) => { S.config.earlyChecks = { version: 1 }; });
  refused(legacy.gate('review', passReview('rx-1', legacy.candidate())), 'early_checks_state_missing');
});

// ------------------------------------------------------------------ R2 setup re-run re-runs every consumer

test('R2 a re-run setup re-runs every consumer of its resource, so both consumers see the same setup execution', { skip: WIN_SKIP }, async (t) => {
  const holder = fixture(t, { commit: true });
  const R = holder.root, log = join(R, 'proof.log'), dbf = join(R, 'db.txt'), seen = join(R, 'seen.log'), release = join(R, 'release');
  const step = (name, body) => ({ cmd: NODE, args: ['-e', `const fs=require('fs');fs.appendFileSync(${J(log)}, ${J(name + '\n')});${body}`] });
  const consumer = (name, hang) => step(name, `const tok=fs.readFileSync(${J(dbf)},'utf8');fs.appendFileSync(${J(seen)}, ${J(name)}+':'+tok+'\\n');`
    + (hang ? `fs.existsSync(${J(release)}) || setInterval(() => {}, 1000)` : ''));
  const fx = fixture(t, { commit: true, config: { ...EARLY, timeoutMs: 120000, testCommands: {
    seed: { ...step('seed', `fs.writeFileSync(${J(dbf)}, String(Math.random()))`), resource: 'db', role: 'setup' },
    c1: { ...consumer('c1', false), resource: 'db', role: 'consumer', after: ['seed'] },
    c2: { ...consumer('c2', true), timeoutMs: 1500, resource: 'db', role: 'consumer', after: ['seed'] },
    lint: step('lint', '') } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  refused(fx.gate('prove', {}), 'proof_entry_timeout');
  writeFileSync(release, '');
  ok(fx.gate('prove', {}));
  assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['seed', 'c1', 'c2', 'lint', 'seed', 'c1', 'c2'], 'the setup re-ran with BOTH consumers; lint was reused');
  const last = readFileSync(seen, 'utf8').split('\n').filter(Boolean).slice(-2).map(l => l.split(':')[1]);
  assert.equal(last[0], last[1], 'the accepted c1 and c2 verdicts read the same setup execution');
  assert.equal(last[0], readFileSync(dbf, 'utf8'));
});

// ------------------------------------------------------------------ S3 security policy 2: spec results gate prove

const CATALOG = SP.loadCatalog();
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
const SPEC_FILE = 'spec/sec.test.mjs';
/** One test per pair: fails until src/impl.txt exists; src/skip.txt names a skipped pair, src/omit.txt an undefined one, src/flood.txt floods stdout past the cap. */
const specText = (ids) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `const rd = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';\nconst skip = rd('src/skip.txt'), omit = rd('src/omit.txt');\n`
  + `if (rd('src/flood.txt')) { const chunk = 'x'.repeat(1024 * 1024) + '\\n'; for (let i = 0; i < 34; i++) process.stdout.write(chunk); }\n`
  + `for (const id of ${J(ids)}) if (id !== omit) test(id, { skip: id === skip }, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
function secFx(t) {
  const sel = SP.selectControls(CATALOG, { security_policy: 2, surfaces: [{ boundary_id: 'orders-api', kind: 'server-input', path: 'src/orders.ts', principals: ['service'] }],
    facts: Object.fromEntries(BOOLS.map(k => [k, false])), evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/orders.ts:handler'])) });
  assert.equal(sel.ok, true);
  const cov = sel.pairs.map(p => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC_FILE, name: p.pair_id }] }));
  const ids = sel.pairs.map(p => p.pair_id);
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(sel) + '\n\n',
    config: { ...EARLY, width: 1, testCommands: { unit: { cmd: NODE, args: ['--test', '--test-reporter=tap', SPEC_FILE], format: 'tap' } },
      securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: cov },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap(c => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }],
    behaviour: { api: { write: { [SPEC_FILE]: specText(ids) } }, impl: { write: { 'src/impl.txt': 'done' } } } });
  git(fx.repo, 'add', '-A'); git(fx.repo, 'commit', '-q', '-m', 'base');
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
  return Object.assign(fx, { ids });
}
const secReview = (fx) => { const cand = fx.candidate();
  return passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' },
    ...fx.ids.map(id => ({ subject_id: id, outcome: 'PASS', evidence: SPEC_FILE }))] }) }); };

test('S3 [security policy 2] prove and REVIEW refuse while a pair spec is skipped, missing or truncated; all pass -> proved', { skip: WIN_SKIP }, async (t) => {
  for (const [file, label] of [['src/skip.txt', 'skipped'], ['src/omit.txt', 'missing'], ['src/flood.txt', 'truncated']]) {
    const fx = secFx(t);
    writeFileSync(join(fx.repo, file), file === 'src/flood.txt' ? 'yes' : fx.ids[2]);
    const p = refused(fx.gate('prove', {}), 'control_unproven');
    assert.ok(fx.readState().local_proof.commands.every(c => c.result === 'pass') || label === 'truncated', `${label}: the command itself passed`);
    assert.match(p.out.reasons.join(' '), /is not proven by this proof/, label);
    ok(fx.gate('reassess', {}), 'reassess');
    refused(fx.gate('review', secReview(fx)), 'prove_required');
    assert.deepEqual(fx.readState().review_chain, [], `${label}: no review accepted`);
  }
  const good = secFx(t);
  ok(good.gate('prove', {}), 'every pair spec passes');
  ok(good.gate('reassess', {}));
  ok(good.gate('review', secReview(good)));
});

// ------------------------------------------------------------------ F4 + MINOR-5: no forensic copy; refusal unbinds and blocks

test('F4 an early check whose runner ends in quiescence_unknown leaves no scanner output on disk, unbinds the earlier passing records and blocks', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { unit: { cmd: NODE, args: ['-e', ''] } } }, behaviour: { a: { write: { 'src/a.txt': 'clean\n' } } } });
  declare(fx, [{ name: 'secrets', kind: 'secrets', cmd: [NODE, 'tools/scan.mjs', '{files}'], files: true, timeout_ms: 30000 }], { 'tools/scan.mjs': ECHO_SCANNER });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('prove', {}), 'a clean tree proves');
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'token = SECRET-zzz999\n');
  // The scanner runs and echoes the secret, but its group is never proven gone: quiescence_unknown.
  const r = await inProc(fx, 'prove', {}, { groupAlive: () => true });
  assert.equal(r.code, 'quiescence_unknown', J(r));
  const S = fx.readState();
  assert.equal(S.early_checks.candidate_id, null, 'the earlier passing early checks are unbound');
  assert.equal(S.local_proof.candidate_id, null, 'the earlier passing proof is unbound');
  const kept = files(join(fx.repo, '.git', 'ai-skills'));
  assert.ok(kept.some(f => f.endsWith('.envelope.json')), 'the attempt files were examined');
  assert.deepEqual(kept.filter(f => /\.out(\.tmp)?$/.test(f) && S.attempts.some(a => a.node.startsWith('early-check:') && f.includes(a.attempt_id))), [], 'no .out or .out.tmp for an early check');
  assert.deepEqual(kept.filter(f => readFileSync(f).includes('SECRET-zzz999')), [], 'the echoed secret is nowhere on disk');
  refused(fx.gate('prove', {}), 'prove_unquiet');
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'prove_required');
});

// ------------------------------------------------------------------ K5 unkillable runner: bounded survivor outcome

/** A launcher child that never exits, whatever it is sent (its pid names no process, so no real signal lands). */
function unkillable() {
  const child = new EventEmitter();
  child.pid = 4194000 + Math.floor(Math.random() * 1000);
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

test('K5 a timed-out runner whose kill fails is reported a survivor in bounded time; the attempt stays unknown and blocks later work', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, timeoutMs: 120000, testCommands: { hang: { cmd: NODE, args: ['-e', ''], timeoutMs: 1000 } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  const started = Date.now();
  const r = await inProc(fx, 'prove', {}, { spawn: () => unkillable(), groupAlive: () => true, killGraceMs: 200 });
  const took = Date.now() - started;
  assert.equal(r.code, 'quiescence_unknown', J(r));
  assert.ok(took < 30000, `returned in bounded time (${took} ms), the lock released`);
  const S = fx.readState();
  const a = S.attempts.find(x => x.node === 'hang');
  assert.equal(a.status, 'unknown', 'the live attempt record is preserved as unknown');
  assert.ok(S.judgments.some(j => j.code === 'quiescence_unknown' && j.node === 'hang'));
  refused(fx.gate('prove', {}), 'prove_unquiet');
});

// ------------------------------------------------------------------ T6 T0 timeout domain

test('T6 a T0 timeout_ms below 1 s is kept as declared (300 ms), not lengthened to 1 s', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { unit: { cmd: NODE, args: ['-e', ''] } } } });
  declare(fx, [{ name: 'slow', kind: 'other', cmd: [NODE, '-e', 'setInterval(() => {}, 1000)'], timeout_ms: 300 }]);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  refused(fx.gate('prove', {}), 'early_check_failed');
  const c = fx.readState().early_checks.checks[0];
  assert.deepEqual([c.timeout_ms, c.timed_out], [300, true]);
});

// ------------------------------------------------------------------ M1 drift during prove

test('M1 a proof entry that changes the tree, or the approved plan, during prove binds no proof and REVIEW stays refused', { skip: WIN_SKIP }, async (t) => {
  const tree = fixture(t, { commit: true, config: { ...EARLY, testCommands: { gen: { cmd: NODE, args: ['-e', "require('fs').writeFileSync('src/gen.txt', 'x')"] } } } });
  ok(tree.cli('init', { dag: tree.dagFile })); ok(tree.cli('drive'));
  refused(tree.gate('prove', {}), 'candidate_mismatch');
  assert.equal(tree.readState().local_proof.candidate_id, null);
  refused(tree.gate('review', passReview('rx-1', tree.candidate())), 'prove_required');
  const plan = fixture(t, { commit: true, config: { ...EARLY, testCommands: { edit: { cmd: NODE, args: ['-e',
    "const fs=require('fs');const p='.specs/plans/T-1.md';fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace('Approved narrative.','Forged narrative.'))"] } } } });
  ok(plan.cli('init', { dag: plan.dagFile })); ok(plan.cli('drive'));
  const r = plan.gate('prove', {});
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.out.ok, false);
  assert.equal(plan.readState().local_proof?.candidate_id ?? null, null, 'a proof that drifted the binding is bound to no candidate');
});

// ------------------------------------------------------------------ M3 GIT_* stripped

test('M3 early checks run with every GIT_* variable removed, as standalone T0', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { unit: { cmd: NODE, args: ['-e', ''] } } } });
  declare(fx, [{ name: 'env', kind: 'other', cmd: [NODE, '-e', 'process.exit(Object.keys(process.env).some(k => /^GIT_/i.test(k)) ? 1 : 0)'] }]);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  fx.env.GIT_S5_PROBE = 'set';
  ok(fx.gate('prove', {}), 'the check saw no GIT_* variable');
  assert.equal(fx.readState().early_checks.checks[0].result, 'pass');
});
