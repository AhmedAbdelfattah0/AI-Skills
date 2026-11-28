/**
 * S5 (P5a, STAB stabilization): early checks and the bounded pre-review `gate prove` (engine-prove.mjs), behind the
 * digest-bound opt-in `config.earlyChecks { version: 1 }`. The §8 P5 negatives that belong to P5a:
 *   E1  342 shape: a secret in the working tree is found by the repository's declared early check BEFORE REVIEW, and no
 *       review is accepted (none recorded, no freeze) until a passing prove binds the current candidate.
 *   E2  secret added then removed: the working-tree early check cannot see it (scope 'working-tree'); the repository's final
 *       range run of the same scanner over base..HEAD still catches it; nothing records the early run as replacing the final one.
 *   E3  D8 order: the engine never reorders a digest-bound proof DAG. Legacy (no opt-in) keeps its order-dependent verdict
 *       (pinned); with the contract an order-swapped or undeclared setup/consumer pair is refused at preflight and init, and
 *       the declared order gives the setup-first verdict.
 *   E4  per-entry deadline: a hung entry is killed at ITS deadline, named, and the next prove re-runs only it (plus its
 *       declared setup); passing entries are reused.
 *   E5  no proof reuse when an input changed: tool bytes, PATH or the base; reuse only when every input still holds.
 *   E6  frozen semantics: without config.earlyChecks nothing changes (no prove gate, no entry fields, review as before).
 * Temp git repositories only; fake scanners and proof commands are node one-liners; no network, Docker or credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { POSIX, fixture, passReview, runStateEvents } from './engine-test-fixture.mjs';
import { preflight } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (proof runners end in quiescence_unknown judgments on Windows)';
const J = JSON.stringify;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(r.out?.code, code, r.stdout); };
const git = (repo, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const EARLY = { earlyChecks: { version: 1 } };

/** A proof entry: node -e that logs `name` to <root>/proof.log and then runs `body`. */
const entry = (root, name, body = '', extra = {}) => ({ cmd: process.execPath,
  args: ['-e', `require('fs').appendFileSync(${J(join(root, 'proof.log'))}, ${J(name + '\n')});${body}`], ...extra });
const proofLog = (fx) => (existsSync(join(fx.root, 'proof.log')) ? readFileSync(join(fx.root, 'proof.log'), 'utf8').split('\n').filter(Boolean) : []);

/** The repository's own secrets scanner: `scan.mjs <files...>` fails on a SECRET- literal; `scan.mjs --range <base>` scans base..HEAD history. */
const SCANNER = `import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const a = process.argv.slice(2);
const text = a[0] === '--range' ? execFileSync('git', ['log', '-p', a[1] + '..HEAD'], { encoding: 'utf8' }) : a.map(f => readFileSync(f, 'utf8')).join('\\n');
const hit = /SECRET-[A-Za-z0-9]+/.exec(text);
if (hit) { process.stdout.write('found ' + hit[0] + '\\n'); process.stderr.write('found ' + hit[0] + '\\n'); }
process.exit(hit ? 1 : 0);
`;

/** Commit the repository's T0 declaration and scanner at the base (the trusted place the engine reads it from). */
function declareEarlyChecks(fx) {
  mkdirSync(join(fx.repo, '.ship-ticket'), { recursive: true });
  mkdirSync(join(fx.repo, 'tools'), { recursive: true });
  writeFileSync(join(fx.repo, 'tools', 'scan.mjs'), SCANNER);
  writeFileSync(join(fx.repo, '.ship-ticket', 't0.json'), J({ checks: [{ name: 'secrets', kind: 'secrets',
    cmd: [process.execPath, 'tools/scan.mjs', '{files}'], files: true, timeout_ms: 30000 }] }));
  git(fx.repo, 'add', '-A');
  git(fx.repo, 'commit', '-q', '-m', 'declare early checks');
}

// ------------------------------------------------------------------ E1 (342): a secret is found before REVIEW

test('E1 [342] the declared working-tree secrets check fails `gate prove` before REVIEW, and no review is accepted until prove passes', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: { unit: { cmd: process.execPath, args: ['-e', ''] } } },
    behaviour: { a: { write: { 'src/a.txt': 'token = SECRET-abc123\n' } } } });
  declareEarlyChecks(fx);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const cand = fx.candidate();
  const direct = spawnSync(process.execPath, ['tools/scan.mjs', 'src/a.txt'], { cwd: fx.repo, encoding: 'utf8' });
  assert.deepEqual([direct.status, direct.stdout], [1, 'found SECRET-abc123\n'], 'control: the fixture scanner itself detects and echoes the secret');
  const p = fx.gate('prove', {});
  refused(p, 'early_check_failed');
  assert.match(p.out.reasons.join(' '), /secrets/, 'the failing check is named');
  const S = fx.readState();
  assert.equal(S.early_checks.candidate_id, cand);
  assert.equal(S.early_checks.scope, 'working-tree');
  assert.deepEqual(S.early_checks.checks.map(c => [c.name, c.result]), [['secrets', 'fail']]);
  const att = S.attempts.find(x => x.attempt_id === S.early_checks.checks[0].attempt_id);
  assert.deepEqual([att?.kind, att?.node, att?.status, att?.envelope?.exitCode], ['proof', 'early-check:secrets', 'exited', 1], 'the scanner really ran and found it');
  // The scanner echoes the secret on stdout and stderr: nothing the engine keeps (state, logs, attempts/ outputs and envelopes) holds it.
  const kept = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? kept(join(dir, d.name)) : [join(dir, d.name)]);
  const files = kept(join(fx.repo, '.git', 'ai-skills'));
  assert.ok(files.some(f => f.endsWith('.envelope.json')), 'the attempt files were looked at');
  assert.deepEqual(files.filter(f => readFileSync(f, 'utf8').includes('SECRET-abc123')), [], 'scanner output (which echoes a secret) is never kept');
  // REVIEW is refused: no review record, no freeze.
  refused(fx.gate('review', passReview('rx-1', cand)), 'prove_required');
  assert.deepEqual(fx.readState().review_chain, []);
  assert.equal(fx.readState().freeze ?? null, null);
  // The builder removes the secret: prove passes on the new candidate, then REVIEW is accepted.
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'token = from-env\n');
  ok(fx.gate('prove', {}), 'prove passes once the tree is clean');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
});

// ------------------------------------------------------------------ E2: secret added then removed -> the final range run catches it

test('E2 a secret added then removed is invisible to the working-tree early check; the final range run still catches it', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, base: 'basebr', testCommands: { unit: { cmd: process.execPath, args: ['-e', ''] } } },
    behaviour: { a: { write: { 'src/a.txt': 'clean\n' } } } });
  declareEarlyChecks(fx);
  git(fx.repo, 'branch', 'basebr');
  const base = git(fx.repo, 'rev-parse', 'basebr');
  // Intermediate history on the ticket branch: one commit adds a secret, the next removes it.
  writeFileSync(join(fx.repo, 'src', 'leak.txt'), 'SECRET-added1\n');
  git(fx.repo, 'add', 'src/leak.txt'); git(fx.repo, 'commit', '-q', '-m', 'add');
  git(fx.repo, 'rm', '-q', 'src/leak.txt'); git(fx.repo, 'commit', '-q', '-m', 'remove');
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const p = fx.gate('prove', {});
  ok(p, 'the working tree holds no secret: the early check passes');
  const S = fx.readState();
  assert.deepEqual([S.early_checks.result, S.early_checks.scope, S.early_checks.replaces_final], ['pass', 'working-tree', false]);
  // The final committed/range run of the same declared scanner is kept and catches it.
  const final = spawnSync(process.execPath, ['tools/scan.mjs', '--range', base], { cwd: fx.repo, encoding: 'utf8' });
  assert.equal(final.status, 1, 'the final range scan over base..HEAD catches the removed secret');
  ok(fx.gate('review', passReview('rx-1', fx.candidate())));
  const sr = fx.gate('ship-ready', {});
  ok(sr);
  assert.equal(sr.out.final_gates, 'required', 'SHIP_READY names the final committed/range run as still required');
});

// ------------------------------------------------------------------ E3 (D8): order is digest-bound; the contract refuses undeclared interdependence

const db = (root) => join(root, 'db.txt');
const reset = (root, extra = {}) => entry(root, 'reset', `require('fs').writeFileSync(${J(db(root))}, 'clean')`, extra);
const reader = (root, extra = {}) => entry(root, 'read', `const fs=require('fs');const ok=fs.existsSync(${J(db(root))})&&fs.readFileSync(${J(db(root))},'utf8')==='clean';fs.writeFileSync(${J(db(root))},'dirty');process.exit(ok?0:4)`, extra);

test('E3a [D8, legacy pinned] without the opt-in the declaration order decides the verdict, exactly as before', { skip: WIN_SKIP }, async (t) => {
  const verdict = async (order) => {
    const holder = fixture(t, { commit: true }); // owns a fresh fake DB file (outside the repository under test)
    const cmds = order === 'reset-first' ? { reset: reset(holder.root), read: reader(holder.root) } : { read: reader(holder.root), reset: reset(holder.root) };
    const fx2 = fixture(t, { commit: true, config: { testCommands: cmds } });
    ok(fx2.cli('init', { dag: fx2.dagFile }));
    ok(fx2.cli('drive'));
    ok(fx2.gate('review', passReview('rx-1', fx2.candidate())));
    fx2.gate('ship-ready', {});
    return Object.fromEntries(fx2.readState().local_proof.commands.map(c => [c.name, c.result]));
  };
  assert.deepEqual(await verdict('reset-first'), { reset: 'pass', read: 'pass' });
  assert.deepEqual(await verdict('read-first'), { read: 'fail', reset: 'pass' }, 'legacy: the engine runs the declared order, no permutation');
});

test('E3b [D8] with the contract, an order-swapped or undeclared setup/consumer pair is refused at preflight and init', async (t) => {
  const cases = {
    'swapped: the consumer is declared before its setup': (r) => ({ read: reader(r, { resource: 'db', role: 'consumer', after: ['reset'] }), reset: reset(r, { resource: 'db', role: 'setup' }) }),
    'a setup (reset) declared after a reader, no order declared': (r) => ({ read: reader(r, { resource: 'db', role: 'consumer' }), reset: reset(r, { resource: 'db', role: 'setup' }) }),
    'a consumer that does not declare its setup': (r) => ({ reset: reset(r, { resource: 'db', role: 'setup' }), read: reader(r, { resource: 'db', role: 'consumer' }) }),
    'a teardown that does not declare the consumers': (r) => ({ reset: reset(r, { resource: 'db', role: 'setup' }), read: reader(r, { resource: 'db', role: 'consumer', after: ['reset'] }),
      drop: entry(r, 'drop', '', { resource: 'db', role: 'teardown', after: ['reset'] }) }),
  };
  for (const [why, make] of Object.entries(cases)) {
    const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: make('/tmp/never-run') } });
    const D8 = /undeclared interdependence on resource "db"|not an entry declared before it/;
    await assert.rejects(() => preflight({ repoRoot: fx.repo, ticket: 'T-1', dagFile: fx.dagFile }), (e) => e.code === 'dag_invalid' && D8.test(e.message), `preflight: ${why}`);
    const r = fx.cli('init', { dag: fx.dagFile });
    assert.equal(r.status, 1, `init: ${why}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /dag_invalid/, why);
    assert.match(r.stderr, D8, why);
    assert.equal(existsSync(fx.stateFile()), false, 'nothing was initialised');
  }
});

test('E3c [D8] the declared setup-first order runs as declared and gives the setup-first verdict', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: {} } });
  const fx2 = fixture(t, { commit: true, config: { ...EARLY, testCommands: {
    reset: reset(fx.root, { resource: 'db', role: 'setup' }), read: reader(fx.root, { resource: 'db', role: 'consumer', after: ['reset'] }) } } });
  ok(fx2.cli('init', { dag: fx2.dagFile }));
  ok(fx2.cli('drive'));
  ok(fx2.gate('prove', {}));
  assert.deepEqual(proofLog(fx), ['reset', 'read'], 'declaration order, unpermuted');
  assert.deepEqual(fx2.readState().local_proof.commands.map(c => [c.name, c.result]), [['reset', 'pass'], ['read', 'pass']]);
});

// ------------------------------------------------------------------ E4: per-entry deadline; only the hung entry re-runs

test('E4 a hung entry is killed at its own deadline and named; the next prove re-runs only it (and its declared setup)', { skip: WIN_SKIP }, async (t) => {
  const holder = fixture(t, { commit: true, config: { ...EARLY, testCommands: {} } });
  const release = join(holder.root, 'release');
  const hang = `require('fs').existsSync(${J(release)}) || setInterval(() => {}, 1000)`;
  const fx = fixture(t, { commit: true, config: { ...EARLY, timeoutMs: 120000, testCommands: {
    lint: entry(holder.root, 'lint'),
    seed: entry(holder.root, 'seed', '', { resource: 'db', role: 'setup' }),
    slow: entry(holder.root, 'slow', hang, { timeoutMs: 1500, resource: 'db', role: 'consumer', after: ['seed'] }),
    unit: entry(holder.root, 'unit') } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const started = Date.now();
  const p = fx.gate('prove', {});
  const took = Date.now() - started;
  refused(p, 'proof_entry_timeout');
  assert.match(p.out.reasons.join(' '), /slow/, 'the timed-out entry is named');
  assert.ok(took < 45000, `killed at its own 1.5 s deadline, not the run-wide 120 s (${took} ms)`);
  const lp = fx.readState().local_proof;
  const row = (n) => lp.commands.find(c => c.name === n);
  assert.deepEqual([row('slow').timed_out, row('slow').timeout_ms, row('slow').result], [true, 1500, 'fail']);
  assert.deepEqual(['lint', 'seed', 'unit'].map(n => row(n).result), ['pass', 'pass', 'pass'], 'the other entries ran to completion');
  assert.deepEqual(proofLog(holder), ['lint', 'seed', 'slow', 'unit']);
  writeFileSync(release, '');
  ok(fx.gate('prove', {}), 'the re-run passes');
  assert.deepEqual(proofLog(holder), ['lint', 'seed', 'slow', 'unit', 'seed', 'slow'], 'only the hung entry and its declared setup re-ran');
  const again = fx.readState().local_proof;
  assert.deepEqual(again.commands.map(c => [c.name, c.result, c.reused === true]),
    [['lint', 'pass', true], ['seed', 'pass', false], ['slow', 'pass', false], ['unit', 'pass', true]]);
});

// ------------------------------------------------------------------ E5: no proof reuse when an input changed

function toolFixture(t) {
  const fx = fixture(t, { commit: true, config: { ...EARLY, testCommands: {} } });
  const tool = join(fx.root, 'tool.sh');
  writeFileSync(tool, `#!/bin/sh\necho run >> ${J(join(fx.root, 'tool.log'))}\nexit 0\n`);
  chmodSync(tool, 0o755);
  const fx2 = fixture(t, { commit: true, config: { ...EARLY, testCommands: { tool: { cmd: tool, args: [] } } } });
  const runs = () => (existsSync(join(fx.root, 'tool.log')) ? readFileSync(join(fx.root, 'tool.log'), 'utf8').split('\n').filter(Boolean).length : 0);
  return { fx: fx2, tool, runs };
}

test('E5 a pre-review proof is reused at ship-ready only while candidate, base, environment and command inputs all hold', { skip: WIN_SKIP }, async (t) => {
  await t.test('positive control: nothing changed -> reused, the tool ran once', async (t) => {
    const { fx, runs } = toolFixture(t);
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
    ok(fx.gate('prove', {}));
    ok(fx.gate('review', passReview('rx-1', fx.candidate())));
    ok(fx.gate('ship-ready', {}));
    assert.equal(runs(), 1);
  });
  await t.test('the command tool bytes changed -> no reuse, the proof re-runs', async (t) => {
    const { fx, tool, runs } = toolFixture(t);
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
    ok(fx.gate('prove', {}));
    ok(fx.gate('review', passReview('rx-1', fx.candidate())));
    writeFileSync(tool, readFileSync(tool, 'utf8') + '# upgraded\n');
    ok(fx.gate('ship-ready', {}));
    assert.equal(runs(), 2, 'the changed tool ran again');
    assert.ok(fx.readState().events.some(e => e.type === 'PROOF_INPUTS_CHANGED'), 'the stale proof is recorded as dropped');
  });
  await t.test('PATH changed -> review refuses the stale prove (prove_required)', async (t) => {
    const { fx } = toolFixture(t);
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
    ok(fx.gate('prove', {}));
    fx.env.PATH = join(fx.root, 'other-bin') + (POSIX ? ':' : ';') + fx.env.PATH;
    refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'prove_required');
  });
  await t.test('the base moved (an empty commit on config.base HEAD) -> review refuses the stale prove', async (t) => {
    const { fx } = toolFixture(t);
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
    ok(fx.gate('prove', {}));
    git(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'base moves');
    refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'prove_required');
  });
});

// ------------------------------------------------------------------ E6: frozen semantics without the opt-in

test('E6 without config.earlyChecks: no prove gate, no per-entry fields, review accepted without a prove (unchanged)', async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { unit: { cmd: process.execPath, args: ['-e', ''] } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const p = fx.gate('prove', {});
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /bad_input/);
  ok(fx.gate('review', passReview('rx-1', fx.candidate())), 'a legacy run reviews without a prove');
  assert.equal(fx.readState().early_checks, undefined);
  const withField = fixture(t, { commit: true, config: { testCommands: { unit: { cmd: process.execPath, args: ['-e', ''], timeoutMs: 5000 } } } });
  const r = withField.cli('init', { dag: withField.dagFile });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dag_invalid/, 'a per-entry field needs the opt-in');
  assert.deepEqual(runStateEvents(fx.planFile).filter(e => e.event === 'SHIP_READY'), []);
});
