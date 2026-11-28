/**
 * S-01b2 P5r: test-kind gates + policy (design rev 6 sections 1, 3, 5.1, 5.2 row P5r; owner decisions D-1, OD-2; AMD-P5r-1).
 * Drives the REAL engine (`node run-engine.mjs`, or the exported commands when a test injects ctx.platform) on a temp git repo
 * with a fake provider CLI and a fake runner at node_modules/.bin/vitest that writes a vitest-json report to the report
 * channel (`--outputFile=/dev/fd/3`) through the REAL FX sealed launcher. The seam rows import the REAL FX and P4r exports.
 *
 * ============================ CONTRACT (P5r) ============================
 * Declaration: DAG config.testKinds { policy: 1 } plus ONE config.testCommands entry with
 *   evidence { report:'fd', covers:[glob], files: bool, config_paths:[path] } (files true exactly when args hold {files}).
 * init: inactive (no carrier, no declaration, no config.testKinds) binds nothing and keeps policy_version 1; else
 *   test_kinds_policy_required | plan_tags_missing | test_kinds_needs_security_policy | requiredFor's first code |
 *   declaration_invalid | test_kinds_runner_missing | multi_entry_unsupported_v0 | runner_unsupported, or binds
 *   S.test_kinds with policy_version 2. A partial combination at load is test_kinds_state_missing.
 * Freeze points F1/F4 (gate review), S1 (ship-ready before the proof), S2 (after the proof): ensureEvidence. A call that
 *   ran the runner returns evidence_refreshed and decides nothing; the re-issued identical call decides from scratch.
 * Claim: L-ran (the runner executed the test and recorded its outcome); RED never counts.
 * =========================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, passReview, failReview, confirmReview, narrativeDigest, BEGIN, END } from './engine-test-fixture.mjs';
import { legacyPlacement } from './engine-test-fixture.mjs';
// S1: this file pins frozen bytes (goldens, policy version numbers, origin/main differentials): its runs use the
// documented legacy escape hatch (config.durableRun: false). The durable default is covered by run-engine-substrate.test.mjs.
legacyPlacement();
import * as SP from './security-plan.mjs';
import * as io from './engine-io.mjs';
import * as TKIO from './engine-test-kinds-io.mjs';
import * as TKR from './engine-test-kinds-reuse.mjs';
import { validateEngineDag, flatEntry } from './engine-dag.mjs';
import { sealedReport, evidenceCommand, TYPED_RUNNER_REFUSALS } from './engine-gates.mjs';
import { gate as gateCmd, status as statusCmd } from './run-engine.mjs';
import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';

const DARWIN = process.platform === 'darwin';
const NOT_DARWIN = DARWIN ? false : 'V0 evidence runs on darwin only (FX report channel); non-darwin is covered by the channel_unsupported rows';
const WIN_SKIP = process.platform === 'win32' ? 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)' : false;
const J = JSON.stringify;
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ok = (r, msg) => { assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`); return r; };
const refused = (r, code, msg) => { assert.equal(r.status, 2, `${msg ?? ''} want ${code}: ${r.stdout}${r.stderr}`); assert.equal(r.out?.code, code, `${msg ?? ''} ${r.stdout}`); return r; };
const initFails = (r, code) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, new RegExp(`run-engine: ${code}:`)); };

// ------------------------------------------------------------------ fixture

const CATALOG = SP.loadCatalog();
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
/** An evidenced empty security assessment (policy 2, no surface, no pair). */
const EMPTY_SEL = SP.selectControls(CATALOG, { security_policy: 2, surfaces: [], facts: Object.fromEntries(BOOLS.map(k => [k, false])),
  evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/x.ts:1'])) });
const ARGS = ['run', '--pool=forks', '--reporter=json', '--outputFile={report}'];
const ENTRY = { cmd: 'node_modules/.bin/vitest', args: [...ARGS, '{files}'], format: 'vitest-json',
  evidence: { report: 'fd', covers: ['test/**'], files: true, config_paths: ['vitest.config.ts'] } };
const NEG = "test('rejects a bad input [kind:negative]', () => {});\n";
const PLAIN = "test('accepts a good input', () => {});\n";
const FLOOR = (base) => `risk-floor: floor=STANDARD; classes=none; claimed=STANDARD; ai=STANDARD; final=STANDARD; paths=1; matched=0; base=${base.slice(0, 12)}; head=worktree; declaration=none`;

/**
 * The fake runner: the args of the qualified invocation; the files after the four fixed args (none: every test/ file). Titles
 * are `test('<title>'`; a title holding `[fails]` fails. Control file $FAKE_VITEST: commit (git commit --allow-empty during
 * the run), survivor (a detached child keeps fd 3 open), exit (forced exit code). Each run appends its args to <ctl>.log.
 */
const FAKE_VITEST = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process');
let ctl = {}; try { ctl = JSON.parse(fs.readFileSync(process.env.FAKE_VITEST, 'utf8')); } catch {}
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_VITEST + '.log', JSON.stringify(argv) + '\\n');
const out = argv.find(a => a.startsWith('--outputFile=')).slice('--outputFile='.length);
let files = argv.slice(4);
if (!files.length) files = fs.existsSync('test') ? fs.readdirSync('test').filter(f => /\\.test\\./.test(f)).map(f => 'test/' + f) : [];
const testResults = files.map(f => { const abs = path.resolve(f), text = fs.readFileSync(abs, 'utf8');
  const cases = [...text.matchAll(/test\\('([^']*)'/g)].map(m => ({ ancestorTitles: [], fullName: m[1], title: m[1], status: m[1].includes('[fails]') ? 'failed' : 'passed', duration: 1, failureMessages: [], meta: {} }));
  return { name: abs, status: cases.some(c => c.status === 'failed') ? 'failed' : 'passed', message: '', assertionResults: cases }; });
const failed = testResults.filter(s => s.status === 'failed').length;
if (ctl.commitEdit) { fs.appendFileSync('test/a.test.ts', '// edited by the runner\\n'); cp.execFileSync('git', ['add', '-A'], { stdio: 'ignore' }); }
if (ctl.commit || ctl.commitEdit) cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'runner commit'], { stdio: 'ignore' });
if (ctl.survivor) cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 3] }).unref();
fs.writeFileSync(out, JSON.stringify({ numTotalTestSuites: testResults.length, numFailedTestSuites: failed, numTotalTests: testResults.length, numFailedTests: failed, success: failed === 0, startTime: 1, testResults }));
process.exit(ctl.exit ?? (failed ? 1 : 0));
`;

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
function put(repo, rel, text) { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); }

/**
 * A policy-2 run with test kinds. The base commit holds the runner, `baseFiles` and everything the fixture wrote; the plan is
 * then rewritten with its risk-floor line on that base (the plan is a pinned exclusion, outside every identity).
 */
function tkFx(t, { triggers = 'input-path', testCommands = { unit: ENTRY }, testKinds = { policy: 1 }, securityPolicy = true, nodes, behaviour,
  baseFiles = {}, floor = true, extra = '', extraConfig = {} } = {}) {
  const config = { width: 1, testCommands, ...(securityPolicy ? { securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: [] } : {}), ...(testKinds ? { testKinds } : {}), ...extraConfig };
  const narrativeExtra = `${SP.renderSection3a(EMPTY_SEL)}\n\n${triggers ? `test-triggers: ${triggers}\n` : ''}${floor ? 'FLOOR_LINE\n' : ''}${extra}`;
  const fx = fixture(t, { commit: true, config, nodes: nodes ?? [{ id: 'a', writes: ['test', 'src'] }], behaviour: behaviour ?? { a: { write: { 'test/a.test.ts': NEG } } }, narrativeExtra });
  put(fx.repo, 'node_modules/.bin/vitest', FAKE_VITEST); chmodSync(join(fx.repo, 'node_modules/.bin/vitest'), 0o755);
  put(fx.repo, 'node_modules/vitest/package.json', '{"name":"vitest","version":"4.0.7"}\n');
  put(fx.repo, '.gitignore', 'node_modules/\n');
  for (const [p, c] of Object.entries(baseFiles)) put(fx.repo, p, c);
  git(fx.repo, 'add', '-A'); assert.equal(git(fx.repo, 'commit', '-q', '-m', 'base').status, 0);
  const base = git(fx.repo, 'rev-parse', 'HEAD').stdout.trim();
  const text = readFileSync(fx.planFile, 'utf8'), narrative = text.slice(0, text.indexOf(BEGIN)).replace('FLOOR_LINE', FLOOR(base));
  const start = { run_id: 'run-1', event: 'START', timestamp: '2026-11-05T00:00:00Z', approved_plan_digest: narrativeDigest(`${narrative}${BEGIN}\n${END}\n`) };
  writeFileSync(fx.planFile, `${narrative}${BEGIN}\n${J(start)}\n${END}\n`);
  fx.env.FAKE_VITEST = join(fx.root, 'vitest.json');
  return Object.assign(fx, { base, control: (c) => writeFileSync(fx.env.FAKE_VITEST, J(c)),
    runnerRuns: () => (existsSync(fx.env.FAKE_VITEST + '.log') ? readFileSync(fx.env.FAKE_VITEST + '.log', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    evidenceAttempts: () => fx.readState().attempts.filter(a => a.kind === 'evidence') });
}
/** init, drive, reassess: ready for review. */
function ready(fx) {
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  ok(fx.cli('drive'), 'drive');
  ok(fx.gate('reassess', {}), 'reassess');
  return fx;
}
/** The five protected fields (rev 5 section 1) and ship_ready. */
const protectedOf = (S) => J([S.freeze, S.frozen_candidate, S.confirmation, S.review_chain, S.test_kinds?.freeze_evidence, S.ship_ready]);
/** Gate twice: the first call runs the runner and returns evidence_refreshed with no protected write; returns the second. */
function refreshThen(fx, kind, input, msg) {
  const before = protectedOf(fx.readState()), runs = fx.evidenceAttempts().length;
  refused(fx.gate(kind, input), 'evidence_refreshed', `${msg}: the call that ran`);
  assert.equal(fx.evidenceAttempts().length, runs + 1, `${msg}: exactly one evidence run`);
  assert.equal(protectedOf(fx.readState()), before, `${msg}: the call that ran wrote no protected field`);
  return fx.gate(kind, input);
}

// ------------------------------------------------------------------ seams (REAL FX and P4r exports; never re-modelled)

test('[seam R5] the design declaration maps onto P4r readEntry, and the substituted command onto commandFor', () => {
  const entry = TKIO.readEntry(flatEntry('unit', ENTRY));
  assert.deepEqual(entry, { name: 'unit', format: 'vitest-json', cmd: ENTRY.cmd, args: ENTRY.args, covers: ['test/**'], config_paths: ['vitest.config.ts'] });
  const cmd = evidenceCommand(entry, ['test/a.test.ts']);
  assert.deepEqual(TKIO.commandFor(entry, cmd.cmd, cmd.args), cmd, 'P4r accepts exactly the command the engine runs');
  assert.equal(evidenceCommand(entry, []), null, '{files} with no file: nothing to run');
  const full = evidenceCommand(TKIO.readEntry(flatEntry('unit', { ...ENTRY, args: ARGS, evidence: { ...ENTRY.evidence, files: false } })), ['x']);
  assert.deepEqual(TKIO.commandFor(TKIO.readEntry(flatEntry('unit', { ...ENTRY, args: ARGS })), full.cmd, full.args), full);
  assert.throws(() => TKIO.readEntry(flatEntry('unit', { ...ENTRY, cmd: 'npx' })), (e) => e.code === 'runner_unsupported');
});

test('[seam R4] the typed refusals P5r keeps are exactly FX RUNNER_REFUSALS plus bad_input', () => {
  assert.deepEqual([...TYPED_RUNNER_REFUSALS].sort(), [...io.RUNNER_REFUSALS, 'bad_input'].sort());
  for (const c of ['runner_output_tampered', 'runner_survivor', 'channel_unsupported', 'bad_input']) assert.ok(TYPED_RUNNER_REFUSALS.has(c), c);
});

/** A temp repo with the fake runner, a base commit and one changed test file. */
function seamRepo(t, title = 'rejects [kind:negative]') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'p5r-seam-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'node_modules/.bin/vitest', FAKE_VITEST); chmodSync(join(dir, 'node_modules/.bin/vitest'), 0o755);
  put(dir, '.gitignore', 'node_modules/\n'); put(dir, 'README.md', 'r\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  put(dir, 'test/a.test.ts', `test('${title}', () => {});\n`);
  return { dir, base: git(dir, 'rev-parse', 'HEAD').stdout.trim() };
}
async function sealedRun(t, r, env = {}) {
  const entry = TKIO.readEntry(flatEntry('unit', ENTRY)), command = evidenceCommand(entry, ['test/a.test.ts']);
  const run = io.gateRunner({ repoRoot: r.dir, dir: join(r.dir, '.git', 'att'), platform: process.platform, env: { ...process.env, FAKE_VITEST: join(r.dir, '.git', 'ctl.json'), ...env },
    toSpec: (c, a) => ({ file: c, args: a, shell: false }), alive: (g) => io.groupAlive(g, process.platform) });
  const launch = await run({ attempt_id: 'att-seam', command, timeoutMs: WORKER_FAILURE_BOUND_MS, report: true });
  launch.release();
  return { entry, command, result: await launch.done };
}

test('[seam R5] the REAL gateRunner result maps through sealedReport onto P4r buildRecord, recordUsable and tkVerdict', { skip: NOT_DARWIN }, async (t) => {
  const r = seamRepo(t);
  const id = TKIO.evidenceIdentity({ repo: r.dir, baseSha: r.base });
  const { entry, command, result } = await sealedRun(t, r);
  assert.equal(result.exitCode, 0); assert.equal(result.report_eof, true); assert.ok(Buffer.isBuffer(result.report));
  const m = sealedReport(result, { attempt_id: 'att-seam', evidence_id_before: id.evidence_id, binding_verified: true, runner_version: '4.0.7' });
  assert.deepEqual(Object.keys(m.report).sort(), ['attempt_id', 'binding_verified', 'evidence_id_before', 'exit_code', 'quiesced', 'report_eof', 'report_sha256',
    'runner_id', 'runner_version', 'sealed', 'text'].sort(), 'exactly the provenance fields P4r reads');
  const dag = 'a'.repeat(64);
  const b = TKIO.buildRecord({ repo: r.dir, baseSha: r.base, entry, commandArgs: command.args, tests: { globs: [] }, dagDigest: dag, report: m.report });
  assert.equal(b.ok, true, J(b));
  assert.deepEqual(b.record.files.map(f => [f.file, f.credited]), [['test/a.test.ts', ['kind:negative']]]);
  assert.deepEqual(Object.keys(b.record.files[0]).sort(), ['credited', 'file', 'outcome', 'unknown'], 'the simplified P4r row (no R-3 fields)');
  assert.equal(b.record.claim, 'L-ran');
  const u = TKR.recordUsable(b.record, { repo: r.dir, baseSha: r.base, dagDigest: dag, entry, command, tests: { globs: [] } });
  assert.deepEqual(u.ok && u.evidence.kinds, ['negative']);
  // a single changed byte of the decoded text the engine hashed is refused by P4r (the hash is over exactly that text)
  assert.equal(TKIO.buildRecord({ repo: r.dir, baseSha: r.base, entry, commandArgs: command.args, tests: { globs: [] }, dagDigest: dag, report: { ...m.report, text: m.report.text + ' ' } }).code, 'runner_output_tampered');
  // FX's report_eof false, a timeout, truncation and invalid UTF-8 never reach a record
  assert.equal(TKIO.buildRecord({ repo: r.dir, baseSha: r.base, entry, commandArgs: command.args, tests: { globs: [] }, dagDigest: dag, report: { ...m.report, report_eof: false } }).code, 'runner_survivor');
  assert.equal(sealedReport({ ...result, timedOut: true, exitCode: null }, {}).code, 'evidence_run_failed');
  assert.equal(sealedReport({ ...result, report_truncated: true }, {}).code, 'evidence_budget_exceeded');
  assert.equal(sealedReport({ ...result, report: Buffer.from([0xff, 0xfe]) }, {}).code, 'evidence_unavailable');
});

test('[seam R4] a REAL detached survivor holding the report channel is FX runner_survivor (a typed rejection, not a result)', { skip: NOT_DARWIN }, async (t) => {
  const r = seamRepo(t);
  writeFileSync(join(r.dir, '.git', 'ctl.json'), J({ survivor: true }));
  await assert.rejects(sealedRun(t, r), (e) => e.code === 'runner_survivor' && TYPED_RUNNER_REFUSALS.has(e.code));
});

// ------------------------------------------------------------------ AC5: INIT rows 1-8, runner rows, DAG schema

test('[AC5] DAG: evidence needs config.testKinds, a format, report fd and files matching {files}; testKinds is exactly {policy:1}; a unit check is never an evidence runner', (t) => {
  const fx = fixture(t);
  const dag = JSON.parse(readFileSync(fx.dagFile, 'utf8'));
  const withCfg = (c, nodes) => ({ ...dag, config: { ...dag.config, ...c }, ...(nodes ? { nodes } : {}) });
  assert.equal(validateEngineDag(withCfg({ testKinds: { policy: 1 }, testCommands: { unit: ENTRY } })).config.testKinds.policy, 1);
  const bad = [{ testCommands: { unit: ENTRY } }, { testKinds: { policy: 2 } }, { testKinds: { policy: 1, x: 1 } },
    { testKinds: { policy: 1 }, testCommands: { unit: { ...ENTRY, format: undefined } } },
    { testKinds: { policy: 1 }, testCommands: { unit: { ...ENTRY, evidence: { ...ENTRY.evidence, report: 'file' } } } },
    { testKinds: { policy: 1 }, testCommands: { unit: { ...ENTRY, evidence: { ...ENTRY.evidence, files: false } } } },
    { testKinds: { policy: 1 }, testCommands: { unit: { ...ENTRY, evidence: { ...ENTRY.evidence, covers: [] } } } },
    { testKinds: { policy: 1 }, testCommands: { unit: { ...ENTRY, evidence: { ...ENTRY.evidence, extra: 1 } } } }];
  for (const c of bad) assert.throws(() => validateEngineDag(withCfg(c)), { code: 'dag_invalid' }, J(c));
  const node = { ...dag.nodes[0], unit: 'u1', checks: ['unit'] };
  assert.throws(() => validateEngineDag(withCfg({ testKinds: { policy: 1 }, testCommands: { unit: ENTRY } }, [node])), { code: 'dag_invalid' });
});

test('[AC5] INIT rows: opt-in without config, config without opt-in, without policy 2, requiredFor refused, bad declaration, runner missing/multiple/unsupported', (t) => {
  const init = (fx) => fx.cli('init', { dag: fx.dagFile });
  initFails(init(tkFx(t, { testKinds: null, testCommands: {} })), 'test_kinds_policy_required'); // row 2
  initFails(init(tkFx(t, { triggers: null, floor: false })), 'plan_tags_missing'); // row 3
  initFails(init(tkFx(t, { securityPolicy: false })), 'test_kinds_needs_security_policy'); // row 4
  initFails(init(tkFx(t, { triggers: 'no-such-tag' })), 'unknown_tag'); // row 5
  initFails(init(tkFx(t, { floor: false })), 'risk_floor_missing'); // row 5
  initFails(init(tkFx(t, { baseFiles: { '.ship-ticket/test-triggers.json': '{"tags":' } })), 'declaration_invalid'); // row 7
  initFails(init(tkFx(t, { testCommands: { other: { cmd: process.execPath, args: ['-e', ''] } } })), 'test_kinds_runner_missing');
  initFails(init(tkFx(t, { testCommands: { unit: ENTRY, unit2: ENTRY } })), 'multi_entry_unsupported_v0'); // R1
  initFails(init(tkFx(t, { testCommands: { unit: { ...ENTRY, cmd: 'node_modules/.bin/jest' } } })), 'runner_unsupported'); // R2
});

test('[AC5] row 2: every opt-in carrier, valid or near-miss, without config.testKinds is test_kinds_policy_required; a risk-floor line alone stays inactive (R8)', (t) => {
  const carriers = ['test-triggers: input-path', 'TEST-TRIGGERS input-path', 'lifecycle-item: L1 closes the banner', 'Lifecycle-Item: L1',
    'test-waiver: negative not needed', 'TEST-WAIVER: x'];
  for (const line of carriers) {
    const fx = fixture(t, { commit: true, narrativeExtra: `${line}\n` });
    initFails(fx.cli('init', { dag: fx.dagFile }), 'test_kinds_policy_required');
  }
  const fx = fixture(t, { commit: true, narrativeExtra: `${FLOOR('0'.repeat(40))}\n` });
  ok(fx.cli('init', { dag: fx.dagFile }), 'a risk-floor record line alone does not opt in');
  const S = fx.readState();
  assert.deepEqual([S.policy_version, S.test_kinds], [1, undefined]);
});

test('[AC5] active init binds S.test_kinds with policy_version 2; a partial activation state is test_kinds_state_missing (row 8)', (t) => {
  const fx = tkFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const S = fx.readState();
  assert.equal(S.policy_version, 2);
  assert.deepEqual(Object.keys(S.test_kinds).sort(), ['base_sha', 'bound', 'declaration', 'entry', 'floor', 'freeze_evidence', 'policy', 'records', 'refused', 'tests'].sort());
  assert.equal(S.test_kinds.base_sha, fx.base);
  assert.deepEqual(Object.keys(S.test_kinds.bound.kinds), ['negative']);
  assert.equal(S.test_kinds.entry, 'unit');
  const good = readFileSync(fx.stateFile());
  for (const edit of [(s) => { delete s.test_kinds; }, (s) => { s.policy_version = 1; }, (s) => { delete s.config.testKinds; }]) {
    writeFileSync(fx.stateFile(), good); fx.editState(edit);
    const st = fx.cli('status');
    assert.equal(st.status, 1); assert.match(st.stderr, /test_kinds_state_missing/);
    refused(fx.gate('review', {}), 'test_kinds_state_missing');
  }
});

// ------------------------------------------------------------------ R1: the V0 single-entry invariant (FND-003-1 round 2)
// P4r's verdict refuses two RECORDS, not two DECLARED entries (a declared entry without a record is skipped), so the engine
// enforces "exactly one declared evidence entry" itself: at init, and at every load of a persisted state.

test('[R1-1] INIT: two declared evidence entries are multi_entry_unsupported_v0, whatever their form (no record can exist yet)', (t) => {
  const init = (fx) => fx.cli('init', { dag: fx.dagFile });
  initFails(init(tkFx(t, { testCommands: { unit: ENTRY, unit2: ENTRY } })), 'multi_entry_unsupported_v0');
  const full = { ...ENTRY, args: ARGS, evidence: { ...ENTRY.evidence, files: false } };
  initFails(init(tkFx(t, { testCommands: { unit: ENTRY, unit2: full } })), 'multi_entry_unsupported_v0');
});

test('[R1-2/R1-4] RESUME: a persisted state declaring a second evidence entry (with or without records) is refused at every entry command', (t) => {
  const fx = tkFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const good = readFileSync(fx.stateFile());
  const edits = [
    ['second entry, no record for either', (s) => { s.config.testCommands.unit2 = ENTRY; }],
    ['second entry, a record for the second only', (s) => { s.config.testCommands.unit2 = ENTRY; s.test_kinds.records.unit2 = { forged: true }; }],
    ['second entry, records for both', (s) => { s.config.testCommands.unit2 = ENTRY; s.test_kinds.records.unit = { forged: true }; s.test_kinds.records.unit2 = { forged: true }; }],
    ['the bound entry renamed away', (s) => { s.config.testCommands.other = s.config.testCommands.unit; delete s.config.testCommands.unit; }],
  ];
  for (const [what, edit] of edits) {
    writeFileSync(fx.stateFile(), good); fx.editState(edit);
    const before = readFileSync(fx.stateFile());
    for (const cmd of ['status', 'resume', 'drive']) {
      const r = fx.cli(cmd);
      assert.equal(r.status, 1, `${what}: ${cmd} ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /multi_entry_unsupported_v0/, `${what}: ${cmd}`);
    }
    refused(fx.gate('review', passReview('rx-1', 'c')), 'multi_entry_unsupported_v0', what);
    refused(fx.gate('ship-ready', {}), 'multi_entry_unsupported_v0', what);
    assert.deepEqual(readFileSync(fx.stateFile()), before, `${what}: nothing written`);
  }
});

test('[R1-3 seam] P4r tkVerdict refuses two declared entries whatever records are present (P4r round 8, D3); the engine feeds it one entry and its own record only', { skip: NOT_DARWIN }, async (t) => {
  // the producer's guard, through its REAL export: two records refused, one record of two declared entries NOT refused
  const r = seamRepo(t);
  const { entry, command, result } = await sealedRun(t, r);
  const id = TKIO.evidenceIdentity({ repo: r.dir, baseSha: r.base }), dag = 'b'.repeat(64);
  const m = sealedReport(result, { attempt_id: 'att-seam', evidence_id_before: id.evidence_id, binding_verified: true, runner_version: '4.0.7' });
  const rec = TKIO.buildRecord({ repo: r.dir, baseSha: r.base, entry, commandArgs: command.args, tests: { globs: [] }, dagDigest: dag, report: m.report }).record;
  const second = { ...entry, name: 'unit2' };
  const E = (records, entries = [entry, second]) => ({ repo: r.dir, baseSha: r.base, dagDigest: dag, entries, commands: { unit: command, unit2: command }, records, tests: { globs: [] },
    bound: { tags: ['input-path'], items: [], kinds: { negative: ['tag:input-path'] }, protected: [] }, declaration: null, reassessed: [], S: { run_id: 'run-1', plan_digest: 'sha256:x' } });
  const two = TKR.tkVerdict(E({ unit: rec, unit2: { ...rec, entry: 'unit2' } }), 'F1');
  assert.deepEqual([two.code, two.detail], ['evidence_unavailable', 'multi_entry_unsupported_v0']);
  // P4r round 8 (D3) closed FND-003-1 on the producer side too: two DECLARED entries are refused with one record or none.
  // The engine's own init and load guard ([R1-1], [R1-2]) stays: the invariant holds even if a producer regresses.
  for (const records of [{ unit: rec }, { unit2: { ...rec, entry: 'unit2' } }, {}]) {
    const v = TKR.tkVerdict(E(records), 'F1');
    assert.deepEqual([v.code, v.detail], ['evidence_unavailable', 'multi_entry_unsupported_v0'], `records ${Object.keys(records)}`);
  }
  assert.equal(TKR.tkVerdict(E({ unit: rec }, [entry]), 'F1').status, 'pass', 'one declared entry with its record passes (the guard is not vacuous)');
  // the engine: a stray record under another name in state is never passed on (records reported: the bound entry only)
  const fx = ready(tkFx(t, { behaviour: { a: { write: { 'test/a.test.ts': PLAIN } } } }));
  refused(refreshThen(fx, 'review', passReview('rx-1', fx.candidate()), 'F1'), 'missing_test_kinds');
  fx.editState((s) => { s.test_kinds.records.ghost = { ...s.test_kinds.records.unit, entry: 'ghost' }; });
  const again = refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'missing_test_kinds');
  assert.match(again.out.reasons[0], /records \{"unit":"current"\};/, 'only the bound entry and its record reach P4r');
});

// ------------------------------------------------------------------ AC6: inactive differential against origin/main's engine

/** origin/main's skills/ directory extracted to a temp dir: the "before" engine (no golden file). */
function mainEngine(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'p5r-main-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const top = git(SCRIPTS, 'rev-parse', '--show-toplevel').stdout.trim();
  if (git(top, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}').status !== 0) return null; // a shallow CI checkout has no base ref
  const ar = spawnSync('sh', ['-c', `set -o pipefail; git -C "${top}" archive origin/main skills | tar -x -C "${dir}"`], { encoding: 'utf8', shell: false });
  assert.equal(ar.status, 0, ar.stderr);
  const cli = join(dir, 'skills', 'ship-ticket', 'scripts', 'run-engine.mjs');
  assert.ok(existsSync(cli), 'the extracted origin/main engine exists');
  return cli;
}
const VOLATILE = new Set(['dag_digest', 'plan_digest', 'approved_plan_digest', 'dag_file', 'created_at', 'timestamp', 'started_at', 'ended_at', 'pid', 'pgid', 'leader_start', 'skill_commit', 'at', 'duration_ms', 'event_id']);
function normal(v, root) {
  if (Array.isArray(v)) return v.map(x => normal(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE.has(k) ? '<v>' : normal(x, root)]));
  // sha256: digests hash path-dependent bytes (the DAG names absolute prompt files; the plan names the DAG digest), so they
  // differ between two temp roots; candidate ids (bare hex over repository bytes) and every other value are compared as is.
  return typeof v === 'string' ? v.split(root).join('<root>').replace(/sha256:[0-9a-f]{64}/g, '<sha256>').replace(/att-[0-9a-f-]{36}/g, '<att>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<ts>') : v;
}

test('[AC6] inactive differential: a run that declares nothing gives the same state, events and status as origin/main\'s engine; no identity, no run', { skip: NOT_DARWIN }, (t) => {
  const mainCli = mainEngine(t);
  if (mainCli === null) { t.skip('origin/main is not in this checkout (shallow CI): the differential needs the base engine and runs locally'); return; }
  const scenario = (cli) => {
    const fx = fixture(t, { commit: true, config: { width: 1, testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } } });
    const run = (cmd, flags = {}) => spawnSync(process.execPath, [cli, ...cmd.split(' '), '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1',
      ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { encoding: 'utf8', env: fx.env, timeout: 60000 });
    const outs = [];
    let n = 0;
    const gate = (kind, input) => { const f = join(fx.root, `in-${++n}.json`); writeFileSync(f, J(input)); return run(`gate ${kind}`, { input: f }); };
    for (const r of [run('init', { dag: fx.dagFile }), run('drive'), gate('review', passReview('rx-1', fx.candidate())), gate('ship-ready', {}), run('status')]) {
      assert.ok([0, 2].includes(r.status), r.stdout + r.stderr); outs.push(JSON.parse(r.stdout));
    }
    return { outs: normal(outs, fx.root), state: normal(fx.readState(), fx.root), log: normal(readFileSync(fx.engineLog(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), fx.root) };
  };
  const before = scenario(mainCli), after = scenario(join(SCRIPTS, 'run-engine.mjs'));
  assert.deepEqual(after.outs, before.outs, 'command outputs (status included)');
  assert.deepEqual(after.state, before.state, 'state: no test_kinds key, policy_version 1, the same attempts and events');
  assert.deepEqual(after.log, before.log, 'engine log');
  assert.equal(after.state.policy_version, 1);
  assert.equal(after.state.test_kinds, undefined);
  assert.equal(after.state.attempts.filter(a => a.kind === 'evidence').length, 0);
  assert.equal(after.outs.at(-1).test_kinds, undefined, 'no status field');
});

// ------------------------------------------------------------------ AC1/AC2: missing kinds refused at F1, F4, S1; recovery

test('[AC1] F1: a missing kind is refused after the evidence run, the five fields byte-identical; status reports it', { skip: NOT_DARWIN }, (t) => {
  const fx = ready(tkFx(t, { behaviour: { a: { write: { 'test/a.test.ts': PLAIN } } } }));
  const before = protectedOf(fx.readState());
  const r = refused(refreshThen(fx, 'review', passReview('rx-1', fx.candidate()), 'F1'), 'missing_test_kinds');
  assert.match(r.out.reasons[0], /kind:negative/);
  assert.doesNotMatch(r.out.reasons[0], /undefined/, 'every reason field the verdict reports is one the verdict has');
  assert.equal(protectedOf(fx.readState()), before, 'F1 refusal: five fields and ship_ready unchanged');
  assert.equal(fx.evidenceAttempts().length, 1, 'the re-issued call reused the record (no second run)');
  const st = ok(fx.cli('status')).out.test_kinds;
  assert.deepEqual([st.state, st.code, st.missing], ['current', 'missing_test_kinds', ['kind:negative']]);
  assert.equal(fx.readState().events.filter(e => e.type === 'RISK_REASSESSED').length, 2, 'RISK_REASSESSED at each F1 call');
});

test('[AC2] end to end: F1 passes; a repair deleting the test is refused at F4; RETRY + a new original passes after a restore', { skip: NOT_DARWIN }, (t) => {
  const fx = ready(tkFx(t, { behaviour: { a: { write: { 'test/a.test.ts': NEG } }, fix: { remove: ['test/a.test.ts'] } } }));
  const c0 = fx.candidate();
  ok(refreshThen(fx, 'review', failReview('rx-1', c0, 'test/a.test.ts', fx.prompt('fix')), 'F1'), 'F1 accepts the FAIL review');
  let S = fx.readState();
  assert.equal(S.freeze.candidate, c0);
  assert.match(S.test_kinds.freeze_evidence, /^e1:/);
  ok(fx.cli('drive'), 'the repair runs');
  ok(fx.gate('reassess', {}));
  const beforeF4 = protectedOf(fx.readState());
  const f4 = refused(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'missing_test_kinds', 'F4: the test is gone ({files} empty, nothing to run)');
  assert.match(f4.out.reasons[0], /kind:negative/);
  assert.equal(protectedOf(fx.readState()), beforeF4, 'F4 refusal: the five fields unchanged (no confirmation recorded)');
  // S1 runs before the proof and before gateShipReady: the same missing kind refuses ship-ready, no proof, ship_ready unchanged
  refused(fx.gate('ship-ready', {}), 'missing_test_kinds', 'S1');
  assert.equal(protectedOf(fx.readState()), beforeF4, 'S1 refusal: five fields and ship_ready unchanged');
  assert.equal(fx.readState().attempts.filter(a => a.kind === 'proof').length, 0, 'S1 refuses before the proof');
  // recovery (rev 5 section 1b): restore the test, owner RETRY, a new independent original review
  put(fx.repo, 'test/a.test.ts', NEG);
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  ok(fx.gate('reassess', {}));
  const runs = fx.evidenceAttempts().length;
  const r = fx.gate('review', passReview('rx-2', fx.candidate()));
  ok(r.out?.code === 'evidence_refreshed' ? fx.gate('review', passReview('rx-2', fx.candidate())) : r, 'the RETRY original passes');
  S = fx.readState();
  assert.equal(S.review_chain.at(-1).review_execution, 'rx-2');
  assert.ok(fx.evidenceAttempts().length <= runs + 1);
});

// ------------------------------------------------------------------ AC3: a call that ran never decides

test('[AC3] a runner that commits (config.base=HEAD) during the F1 run: that call decides nothing, and the re-issued call re-derives the units and is refused', { skip: NOT_DARWIN }, (t) => {
  const fx = tkFx(t, { testCommands: { unit: ENTRY, chk: { cmd: process.execPath, args: ['-e', ''] } }, nodes: [{ id: 'a', writes: ['test', 'src'], unit: 'u1', checks: ['chk'] }] });
  ready(fx);
  assert.equal(fx.cli('status').out.units.u1.state, 'verified', 'unit evidence verified before the gate');
  fx.control({ commit: true });
  const before = protectedOf(fx.readState());
  const r = refreshThen(fx, 'review', passReview('rx-1', fx.candidate()), 'F1 with a committing runner');
  refused(r, 'units_unverified', 'the re-issued call sees the moved config.base');
  assert.equal(protectedOf(fx.readState()), before);
});

// ------------------------------------------------------------------ AC4: reuse; S2; proof keeps the repository's own commands

test('[AC4] F1 -> F4 -> S1 on an unchanged identity runs the runner once; the proof still runs every command (R2), and S2 binds', { skip: NOT_DARWIN }, (t) => {
  const other = { cmd: process.execPath, args: ['-e', ''] };
  const fx = tkFx(t, { testCommands: { unit: ENTRY, other }, behaviour: { a: { write: { 'test/a.test.ts': NEG } }, fix: { write: { 'src/a.txt': 'same' } } } });
  put(fx.repo, 'src/a.txt', 'same'); // the repair rewrites identical bytes: the identity stays
  ready(fx);
  ok(refreshThen(fx, 'review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix')), 'F1'));
  ok(fx.cli('drive'), 'repair');
  ok(fx.gate('reassess', {}));
  ok(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'F4 reuses the record');
  const ship = ok(fx.gate('ship-ready', {}), 'S1 reuses the record; the proof runs; S2 holds');
  assert.equal(fx.evidenceAttempts().length, 1, 'one evidence run for F1, F4, S1 and S2');
  const S = fx.readState();
  assert.deepEqual(S.local_proof.commands.map(c => [c.name, c.result]), [['unit', 'pass'], ['other', 'pass']], 'the repository\'s own command is never dropped');
  assert.deepEqual(S.local_proof.commands[0].args, ARGS.map(a => a.replace('{report}', '/dev/fd/3')), 'the proof runs the evidence runner on the full suite through the report channel');
  assert.equal(S.ship_ready.candidate_id, ship.out.candidate_id);
});

test('[AC S2] a proof that edits and commits a covered file (config.base=HEAD: the legacy candidate does not move) is caught by S2; the proof binds to nothing', { skip: NOT_DARWIN }, (t) => {
  const fx = tkFx(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  git(fx.repo, 'add', '-A'); assert.equal(git(fx.repo, 'commit', '-q', '-m', 'built').status, 0); // the candidate is committed: base=HEAD sees no diff
  ok(fx.gate('reassess', {}));
  ok(refreshThen(fx, 'review', passReview('rx-1', fx.candidate()), 'F1'));
  fx.control({ commitEdit: true });
  const c0 = fx.candidate();
  const r = refused(fx.gate('ship-ready', {}), 'candidate_moved', 'S2');
  assert.equal(fx.candidate(), c0, 'the legacy candidate (base=HEAD) did not move: only the evidence identity shows the edit');
  const S = fx.readState();
  assert.deepEqual([S.local_proof.candidate_id, S.local_proof.dropped], [null, ['candidate_moved']]);
  assert.equal(S.ship_ready, undefined);
  void r;
});

test('[R4 AMD-P5r-1] a live attempt refuses the evidence run (evidence_unquiet, nothing runs); after a crash resume reconciles an evidence attempt as a runner and the gate proceeds', { skip: NOT_DARWIN }, (t) => {
  const fx = ready(tkFx(t));
  fx.editState((s) => { s.attempts.push({ attempt_id: 'att-crashed', kind: 'evidence', node: 'unit', status: 'running', pid: 999999, pgid: 999999, quiesced: false }); });
  const before = protectedOf(fx.readState());
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'evidence_unquiet');
  assert.equal(fx.runnerRuns().length, 0, 'nothing ran beside a live attempt');
  assert.equal(protectedOf(fx.readState()), before);
  ok(fx.cli('resume'), 'resume settles the crashed evidence attempt through the runner path (RUNNER_KINDS)');
  const a = fx.readState().attempts.find((x) => x.attempt_id === 'att-crashed');
  assert.deepEqual([a.status, a.quiesced], ['abandoned', true]);
  ok(refreshThen(fx, 'review', passReview('rx-1', fx.candidate()), 'after resume'));
});

// ------------------------------------------------------------------ R4/R7: typed refusals are stored and never retried; RED never substitutes

test('[R4] a detached survivor holding the report channel: runner_survivor reaches the gate and state (judgment point) and is never retried on the same bytes', { skip: NOT_DARWIN }, (t) => {
  const fx = ready(tkFx(t));
  fx.control({ survivor: true });
  const before = protectedOf(fx.readState());
  const r = refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'runner_survivor');
  assert.equal(r.out.judgment_point, true);
  let S = fx.readState();
  assert.equal(S.test_kinds.refused.code, 'runner_survivor');
  assert.equal(S.attempts.find(a => a.kind === 'evidence').envelope.error_code, 'runner_survivor');
  assert.deepEqual(S.test_kinds.records, {}, 'no record');
  fx.control({});
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'runner_survivor', 'the same bytes are not re-run');
  assert.equal(fx.runnerRuns().length, 1);
  assert.equal(protectedOf(fx.readState()), before);
  S = fx.readState();
  assert.equal(S.events.filter(e => e.type === 'TEST_KINDS_REFUSED').length, 1);
});

test('[R4] non-darwin: channel_unsupported is a typed, stored refusal (native on Linux, ctx.platform linux on darwin); nothing is accepted and nothing re-runs', { skip: WIN_SKIP }, async (t) => {
  const fx = ready(tkFx(t));
  const call = () => gateCmd({ ...fx.ctx(DARWIN ? { platform: 'linux' } : {}), gate: 'review', input: passReview('rx-1', fx.candidate()) });
  const r = await call();
  assert.deepEqual([r.ok, r.code, r.judgment_point], [false, 'channel_unsupported', true]);
  const S = fx.readState();
  assert.equal(S.test_kinds.refused.code, 'channel_unsupported');
  assert.equal(S.attempts.filter(a => a.kind === 'evidence').length, 1);
  assert.equal(fx.runnerRuns().length, 0, 'FX refused before anything started');
  assert.equal((await call()).code, 'channel_unsupported');
  assert.equal(fx.readState().attempts.filter(a => a.kind === 'evidence').length, 1, 'never retried');
  assert.equal(fx.readState().review_chain.length, 0);
});

test('[R7] a failing runner is evidence_run_failed (never "missing"), stored per identity, and RED refuses an evidence runner (it never substitutes)', { skip: NOT_DARWIN }, (t) => {
  const fx = ready(tkFx(t, { behaviour: { a: { write: { 'test/a.test.ts': "test('rejects [kind:negative] [fails]', () => {});\n" } } } }));
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'evidence_run_failed');
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'evidence_run_failed', 'no redundant run on the same bytes');
  assert.equal(fx.runnerRuns().length, 1);
  refused(fx.gate('red', { node: 'a', command: 'unit' }), 'runner_unsupported');
  // a changed candidate runs again (the stored refusal is bound to the identity)
  put(fx.repo, 'test/a.test.ts', NEG);
  ok(fx.gate('reassess', {}));
  ok(refreshThen(fx, 'review', passReview('rx-1', fx.candidate()), 'after the fix'));
});

test('[V] status never runs the runner and reports not_computed while an attempt is live', { skip: NOT_DARWIN }, async (t) => {
  const fx = ready(tkFx(t));
  assert.deepEqual(ok(fx.cli('status')).out.test_kinds.state, 'none');
  assert.equal(fx.runnerRuns().length, 0);
  fx.editState((s) => { s.attempts.push({ attempt_id: 'att-x', kind: 'evidence', node: 'unit', status: 'running', pgid: 999999 }); });
  assert.equal((await statusCmd(fx.ctx())).test_kinds.state, 'not_computed');
});

test('[S2 evidence] hostClaims: a held evidence run creates no attempt and no record; once admitted the evidence attempt persists and releases its claim', { skip: NOT_DARWIN }, async (t) => {
  const store = mkdtempSync(join(tmpdir(), 'tk-claims-'));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  const shared = join(store, 'shared-node_modules'); mkdirSync(shared);
  const fx = tkFx(t, { behaviour: { a: { write: { 'test/a.test.ts': PLAIN } } },
    testCommands: { unit: { ...ENTRY, hostClass: 'light', hostResources: [{ resource: shared, mode: 'R' }] } },
    extraConfig: { hostClaims: { version: 1, widthReason: 'one node' } }, nodes: [{ id: 'a', writes: ['test', 'src'], hostClass: 'light' }] });
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = store;
  ready(fx);
  const { claim, releaseClaim } = await import('./host-claims.mjs');
  assert.equal((await claim({ dir: store, opId: 'npm-ci', cls: 'light', resources: [{ resource: shared, mode: 'W' }] })).admit, true);
  const held = fx.gate('review', passReview('rx-1', fx.candidate()));
  refused(held, 'host_held', 'an installer holds the shared installation');
  assert.equal(held.out.judgment_point, false);
  assert.equal(fx.evidenceAttempts().length, 0, 'no evidence attempt');
  assert.equal(fx.runnerRuns().length, 0, 'the runner never ran');
  assert.equal((await releaseClaim({ dir: store, opId: 'npm-ci' })).released, true);
  refused(fx.gate('review', passReview('rx-1', fx.candidate())), 'evidence_refreshed', 'admitted: the evidence ran');
  const ev = fx.evidenceAttempts();
  assert.equal(ev.length, 1);
  assert.ok(ev[0].host_claim?.op_id, 'the evidence attempt persisted its claim identity before launch');
  assert.equal(ev[0].host_claim.released, true);
});
