/**
 * PR-2 (S2-min host admission, COMPLETION-PLAN-2026-11-28 row 4): host claims at the ENGINE-COMMAND process boundary.
 * The engine's internals are not touched: a heavy engine command (drive, gate red, gate prove, gate ship-ready) is claimed
 * by `host-admit.mjs run -- <engine command>`, and the run-engine CLI ENTRY refuses it (`host_claim_required`) when the
 * run's policy requires a claim (opt-in `config.hostClaimRequired`, a derived policy-version twin) and none is active.
 *
 *   A1  DETACHED-WORKER LIFETIME (owner acceptance 1): the driver is killed -9 while its detached inner worker group lives
 *       -> the claim stays charged (a foreign claim is held) until that inner group is gone, then it is reclaimed on proof;
 *       an attempt whose identity is unknown keeps the claim charged and raises the host-scoped Blocked.
 *   A2  DIRECT UNCLAIMED CLI INVOCATION (owner acceptance 2): a directly invoked lone-heavy-node drive is refused before
 *       anything is written or launched; gate red / ship-ready likewise; a claim of another process group, of too little
 *       weight or of another run does not satisfy the check.
 *   W   weight = min(config.width, DAG nodes) for drive (derived by host-admit, never caller-supplied); a DAG whose drive
 *       weight exceeds the host's maximum heavy slots is refused at preflight/init.
 *   P   policy: the hostClaimRequired twin is DERIVED from the merged table (durable rows only); the flag and the config
 *       come together on every load; a run without the flag is byte-for-byte the frozen engine (no claim, no store).
 * Temp git repositories and temp claim stores only (AI_SKILLS_HOST_RESOURCES_DIR); fake host samples; no Docker, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture } from './engine-test-fixture.mjs';
import { fakeHost } from './host-claims.test-helper.mjs';

const SKIP = POSIX ? false : 'POSIX process groups (Windows: host claims are unsupported, known limit D4)';
const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const REQUIRED = { hostClaimRequired: { version: 1 } };
const admitCli = () => import('./host-admit.mjs');
const store = () => import('./host-claims.mjs');

const tmpStore = (t) => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'host-admit-engine-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const claimIds = (dir) => { try { return readdirSync(join(dir, 'claims')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; } };
const rows = (dir) => (existsSync(join(dir, 'samples.jsonl')) ? readFileSync(join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killGroup = (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
async function waitUntil(pred, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await pred()) return true; await new Promise(r => setTimeout(r, 25)); }
  return Boolean(await pred());
}
const engineArgv = (fx, ...cmd) => [process.execPath, ENGINE_CLI, ...cmd, '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'];
/** `host-admit run` in-process (fake host samples, a temp store) wrapping `argv`; the command itself is a real process. */
async function admitRun(fx, dir, argv, { pressure = 1, flags = [], log = () => {} } = {}) {
  const { run } = await admitCli();
  const h = fakeHost({ pressure });
  return run(['run', ...flags, '--', ...argv], { platform: 'darwin', dir, snapshot: h.snapshot, now: h.now, env: fx.env, log, stdio: ['pipe', 'ignore', 'ignore'] });
}
const heavyClaim = async (dir, opId, pressure = 2) => { const { claim } = await store(); const h = fakeHost({ pressure }); return claim({ dir, opId, cls: 'heavy', snapshot: h.snapshot, now: h.now }); };

// ------------------------------------------------------------------ P: policy derivation and the frozen path

test('P policy: every durable row (core and early-checks twin) has a DERIVED hostClaimRequired twin; nothing else does', async () => {
  const P = await import('./engine-policy.mjs');
  assert.equal(typeof P.hostClaimVersion, 'function', 'the twin accessor exists');
  for (const [v, f] of Object.entries(P.POLICY_SEMANTICS)) {
    if (f.hostClaimRequired) continue;
    const twin = P.hostClaimVersion(Number(v));
    if (f.durableRun === true) {
      assert.equal(twin, Number(v) + P.HOST_CLAIM_OFFSET, `durable ${v} has its twin`);
      assert.deepEqual({ ...P.POLICY_SEMANTICS[twin] }, { ...f, hostClaimRequired: true }, `twin of ${v} = its flags + hostClaimRequired`);
    } else assert.equal(twin, null, `non-durable ${v} has no twin (the claim check needs the durable run directory)`);
  }
  assert.throws(() => P.withHostClaimTwins({ [P.HOST_CLAIM_OFFSET]: { durableRun: true } }), { code: 'policy_table_ceiling' });
});

test('P frozen: a run WITHOUT config.hostClaimRequired drives through the CLI with no claim and no store, as before', { skip: SKIP }, async (t) => {
  const fx = fixture(t);
  const dir = tmpStore(t);
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = dir;
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.readState().policy_version, 13, 'the durable core version, no twin');
  const r = fx.cli('drive');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fx.readState().nodes.a.state, 'done');
  assert.equal(existsSync(join(dir, 'claims')), false, 'the store is never touched');
});

test('P init records the twin; the flag and config.hostClaimRequired must come together on every load', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: REQUIRED });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.readState().policy_version, 213, 'durable 13 + HOST_CLAIM_OFFSET 200');
  fx.editState((s) => { delete s.config.hostClaimRequired; });
  const r = fx.cli('status');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /host_claims_state_missing/);
});

test('W a DAG whose drive weight exceeds the host maximum (2 heavy slots) or omits config.width is refused at init; legacy placement too', async (t) => {
  const three = fixture(t, { config: { ...REQUIRED, width: 3 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', writes: ['src/b.txt'] }, { id: 'c', writes: ['src/c.txt'] }] });
  const r3 = three.cli('init', { dag: three.dagFile });
  assert.notEqual(r3.status, 0); assert.match(r3.stderr, /width_exceeds_host_capacity/);
  const ok3 = fixture(t, { config: { ...REQUIRED, width: 3 } }); // one node: weight min(3, 1) = 1
  assert.equal(ok3.cli('init', { dag: ok3.dagFile }).status, 0, 'a lone node is weight 1 whatever the width');
  const legacy = fixture(t, { config: { ...REQUIRED, durableRun: false } });
  const rl = legacy.cli('init', { dag: legacy.dagFile });
  assert.notEqual(rl.status, 0); assert.match(rl.stderr, /hostClaimRequired/);
  const nw = fixture(t, { config: { ...REQUIRED, width: undefined } }); // JSON drops it: no explicit config.width
  const rw = nw.cli('init', { dag: nw.dagFile });
  assert.notEqual(rw.status, 0); assert.match(rw.stderr, /config\.width/);
});

// ------------------------------------------------------------------ A2: direct unclaimed CLI invocation

test('A2 a directly invoked lone-heavy-node drive is refused (host_claim_required): nothing written, nothing launched', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: REQUIRED });
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = tmpStore(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const before = readFileSync(fx.stateFile(), 'utf8');
  const r = fx.cli('drive');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /host_claim_required/);
  assert.equal(readFileSync(fx.stateFile(), 'utf8'), before, 'the state is byte-identical');
  assert.deepEqual(fx.runs(), [], 'the worker never ran');
  for (const kind of ['red', 'ship-ready', 'prove']) {
    const g = fx.gate(kind, kind === 'red' ? { node: 'a' } : {});
    assert.equal(g.status, 2, `${kind}: ${g.stdout}${g.stderr}`);
    assert.equal(g.out?.code, 'host_claim_required', kind);
  }
  assert.equal(readFileSync(fx.stateFile(), 'utf8'), before, 'no gate wrote either');
  const s = fx.cli('status');
  assert.equal(s.status, 0, 'light commands are never refused');
});

test('A2 the claim must be ACTIVE for this process: another group, too little weight, another run or a forged op id are refused', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: REQUIRED, nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', writes: ['src/b.txt'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } } } });
  const dir = tmpStore(t);
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = dir;
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  // (a) a live claim of ANOTHER process group (a sleeper), its op id handed to a direct drive
  const { run } = await admitCli();
  const h = fakeHost({ pressure: 1 });
  const sleeper = run(['run', '--class', 'heavy', '--weight', '2', '--op-id', 'other-group', '--', process.execPath, '-e', 'setTimeout(() => {}, 4000)'],
    { platform: 'darwin', dir, snapshot: h.snapshot, now: h.now, env: fx.env, log: () => {}, stdio: ['pipe', 'ignore', 'ignore'] });
  assert.ok(await waitUntil(() => { try { return JSON.parse(readFileSync(join(dir, 'claims', 'other-group.json'), 'utf8')).pgid !== null; } catch { return false; } }));
  const { spawnSync } = await import('node:child_process');
  const drive = (op) => spawnSync(process.execPath, engineArgv(fx, 'drive').slice(1), { encoding: 'utf8', env: { ...fx.env, AI_SKILLS_HOST_CLAIM_OP: op } });
  const unbound = drive('other-group');
  assert.equal(unbound.status, 1); assert.match(unbound.stderr, /host_claim_required/); assert.match(unbound.stderr, /bound to no run/, 'not bound to this run');
  // the same claim hand-bound to THIS run (an out-of-protocol same-user edit): still not this process's group
  const f = join(dir, 'claims', 'other-group.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), run_state: realpathSync(fx.stateFile()) }));
  const other = drive('other-group');
  assert.equal(other.status, 1); assert.match(other.stderr, /host_claim_required/); assert.match(other.stderr, /not in claim other-group's process group/);
  const forged = drive('no-such-op');
  assert.equal(forged.status, 1); assert.match(forged.stderr, /no readable claim no-such-op/);
  assert.deepEqual(fx.runs(), [], 'nothing ran');
  await sleeper;
  // (b) weight 1 for a 2-node width-2 drive (a plain `--class heavy` wrapper): refused inside the claim, nothing runs
  const weak = await admitRun(fx, dir, ['/bin/sh', '-c', `exec "${process.execPath}" "${ENGINE_CLI}" drive --repo "${fx.repo}" --ticket T-1 --run-id run-1`],
    { flags: ['--class', 'heavy', '--op-id', 'weak'] });
  assert.equal(weak.code, 1, JSON.stringify(weak.line));
  assert.deepEqual(fx.runs(), [], 'refused: weight 1 < required 2, and no run_state binding');
  // (c) the right command wrapped: admitted with the derived weight and run binding, and it runs
  const seen = [];
  const good = await admitRun(fx, dir, engineArgv(fx, 'drive'), { log: (l) => seen.push(l) });
  assert.equal(good.code, 0, JSON.stringify(seen));
  assert.deepEqual(Object.values(fx.readState().nodes).map(n => n.state), ['done', 'done']);
  const adm = rows(dir).find(x => x.kind === 'admission' && x.admit && x.op_id === seen[0].op_id);
  assert.equal(adm.weight, 2, 'weight = min(config.width 2, nodes 2), derived by host-admit');
  assert.ok(rows(dir).some(x => x.kind === 'peak' && x.op_id === adm.op_id), 'a post-admission peak is persisted');
  assert.deepEqual(claimIds(dir), [], 'released once the group was gone and every attempt settled');
});

test('A2 host-admit refuses caller-supplied --class/--weight for an engine command (weight is derived, never trusted)', async (t) => {
  const fx = fixture(t, { config: REQUIRED });
  const dir = tmpStore(t);
  const r = await admitRun(fx, dir, engineArgv(fx, 'drive'), { flags: ['--class', 'heavy', '--weight', '1'] });
  assert.equal(r.code, 2); assert.equal(r.line.reason, 'usage');
  assert.deepEqual(claimIds(dir), []);
});

// ------------------------------------------------------------------ A1: detached-worker lifetime

test('A1 driver killed -9 while its DETACHED worker group lives: capacity stays charged until that group is gone, then reclaimed on proof', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: REQUIRED, behaviour: { a: { hang: true } } });
  const dir = tmpStore(t);
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = dir;
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const lines = [];
  const driving = admitRun(fx, dir, engineArgv(fx, 'drive'), { log: (l) => lines.push(l) });
  let inner = null;
  assert.ok(await waitUntil(() => { try { const a = fx.readState().attempts.find(x => x.node === 'a' && x.pgid); inner = a?.pgid ?? null; return inner !== null && fx.runs().length === 1; } catch { return false; } }),
    'the worker was released and runs');
  t.after(() => killGroup(inner));
  const opId = lines[0].op_id;
  const outer = JSON.parse(readFileSync(join(dir, 'claims', `${opId}.json`), 'utf8')).pgid;
  assert.notEqual(outer, inner, 'the inner worker group is detached from the claimed outer group');
  killGroup(outer); // the driver (and its launcher) die; the detached worker lives on
  const done = await driving;
  assert.ok(await waitUntil(() => !groupAlive(outer)), 'the outer group is gone');
  assert.ok(groupAlive(inner), 'the detached inner group still lives');
  assert.equal(done.line.released, false, `the owner did not release: ${JSON.stringify(done.line)}`);
  assert.equal(done.line.release_reason, 'attempt_live');
  const held = await heavyClaim(dir, 'foreign-1');
  assert.equal(held.admit, false, 'a foreign heavy claim at one slot is held: the capacity is still charged');
  assert.ok(held.reasons.includes('held_heavy'), `${held.reasons}`);
  assert.ok(claimIds(dir).includes(opId), 'the outer claim is NOT reclaimed by the foreign reconcile');
  killGroup(inner);
  assert.ok(await waitUntil(() => !groupAlive(inner)));
  const free = await heavyClaim(dir, 'foreign-2');
  assert.equal(free.admit, true, `outer group gone AND every attempt's group gone: reclaimed (${free.reasons})`);
  assert.deepEqual(claimIds(dir), ['foreign-2']);
  const rec = rows(dir).find(x => x.kind === 'reclaimed' && x.op_id === opId);
  assert.ok(rec, 'the reclaim is recorded');
  assert.equal(rec.peak, 'unobserved', 'the interval after the owner stopped observing is an explicit gap, not a fabricated peak');
});

test('A1 unknown identity: an unsettled attempt whose group cannot be attributed keeps the claim charged and raises the host Blocked; light work continues', { skip: SKIP }, async (t) => {
  const dir = tmpStore(t), runDir = tmpStore(t);
  const { spawn } = await import('node:child_process');
  const { leaderStart } = await import('./engine-quiesce.mjs');
  const { hostname } = await import('node:os');
  // An attempt in the run's EXISTING S1 records: launched, its leader start recorded wrong (a reused or unreadable identity).
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  t.after(() => killGroup(p.pid));
  const stateFile = join(runDir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ attempts: [{ attempt_id: 'att-x', status: 'launched', pgid: p.pid, leader_start: 'Thu Jan  1 00:00:00 1970' }] }));
  // The outer claim: bound to a group that is gone, claimer dead, bound to the run's state file.
  const gone = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await new Promise(r => gone.on('exit', r));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'claims'), { recursive: true });
  writeFileSync(join(dir, 'claims', 'drv.json'), JSON.stringify({ schema: 'ship-ticket-host-claim-v1', op_id: 'drv', class: 'heavy', weight: 1, resources: [],
    container_label: null, pgid: gone.pid, leader_start: leaderStart(process.pid), claimer: { pid: 999999, process_start_time: 'x', host: hostname() },
    run_state: stateFile, claimed_at: 'x', bound_at: 'x' }));
  const r = await heavyClaim(dir, 'h1');
  assert.equal(r.admit, false, 'still charged');
  assert.deepEqual(r.unknown, ['drv'], 'unknown, never reclaimable without proof');
  assert.equal(r.blocked?.raised, true, 'one host-scoped Blocked');
  const { claim } = await store();
  const l = await claim({ dir, opId: 'docs', cls: 'light', resources: [{ resource: join(dir, 'unrelated'), mode: 'W' }] });
  assert.equal(l.admit, true, 'light work continues');
  writeFileSync(stateFile, '{ torn');
  const torn = await heavyClaim(dir, 'h2');
  assert.deepEqual(torn.unknown, ['drv'], 'an unreadable run record proves nothing: still unknown');
  writeFileSync(stateFile, JSON.stringify({ attempts: [{ attempt_id: 'att-x', status: 'exited', quiesced: true, pgid: p.pid, leader_start: 'x' }] }));
  const settled = await heavyClaim(dir, 'h3');
  assert.equal(settled.admit, true, `every attempt settled and the outer group gone: reclaimed (${settled.reasons})`);
  assert.ok(!claimIds(dir).includes('drv'));
});

// ------------------------------------------------------------------ PR-2 review round 1 repairs (tests first)

const SP_MOD = () => import('./security-plan.mjs');
/** A config.hostClaimRequired + config.testKinds run (the real test-kinds fixture shape: fake vitest, empty §3a), driven and reassessed. */
async function testKindsRun(t) {
  const { mkdirSync, chmodSync } = await import('node:fs');
  const { dirname: dn } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { narrativeDigest, BEGIN, END } = await import('./engine-test-fixture.mjs');
  const SP = await SP_MOD();
  const CATALOG = SP.loadCatalog();
  const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
  const EMPTY_SEL = SP.selectControls(CATALOG, { security_policy: 2, surfaces: [], facts: Object.fromEntries(BOOLS.map(k => [k, false])),
    evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/x.ts:1'])) });
  const ENTRY = { cmd: 'node_modules/.bin/vitest', args: ['run', '--pool=forks', '--reporter=json', '--outputFile={report}', '{files}'], format: 'vitest-json',
    evidence: { report: 'fd', covers: ['test/**'], files: true, config_paths: ['vitest.config.ts'] } };
  const FAKE_VITEST = readFileSync(fileURLToPath(new URL('./run-engine-test-kinds.test.mjs', import.meta.url)), 'utf8').split('const FAKE_VITEST = `')[1].split('`;\n')[0].replace(/\\\\/g, '\\');
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
  const put = (repo, rel, text) => { mkdirSync(dn(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  const config = { width: 1, testCommands: { unit: ENTRY }, securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: [], testKinds: { policy: 1 }, ...REQUIRED };
  const fx = fixture(t, { commit: true, config, nodes: [{ id: 'a', writes: ['test', 'src'] }], behaviour: { a: { write: { 'test/a.test.ts': "test('ok', () => {});\n" } } },
    narrativeExtra: `${SP.renderSection3a(EMPTY_SEL)}\n\ntest-triggers: input-path\nFLOOR_LINE\n` });
  put(fx.repo, 'node_modules/.bin/vitest', FAKE_VITEST); chmodSync(join(fx.repo, 'node_modules/.bin/vitest'), 0o755);
  put(fx.repo, 'node_modules/vitest/package.json', '{"name":"vitest","version":"4.0.7"}\n');
  put(fx.repo, '.gitignore', 'node_modules/\n');
  git(fx.repo, 'add', '-A'); assert.equal(git(fx.repo, 'commit', '-q', '-m', 'base').status, 0);
  const base = git(fx.repo, 'rev-parse', 'HEAD').stdout.trim();
  const floor = `risk-floor: floor=STANDARD; classes=none; claimed=STANDARD; ai=STANDARD; final=STANDARD; paths=1; matched=0; base=${base.slice(0, 12)}; head=worktree; declaration=none`;
  const text = readFileSync(fx.planFile, 'utf8'), narrative = text.slice(0, text.indexOf(BEGIN)).replace('FLOOR_LINE', floor);
  const start = { run_id: 'run-1', event: 'START', timestamp: '2026-11-05T00:00:00Z', approved_plan_digest: narrativeDigest(`${narrative}${BEGIN}\n${END}\n`) };
  writeFileSync(fx.planFile, `${narrative}${BEGIN}\n${JSON.stringify(start)}\n${END}\n`);
  fx.env.FAKE_VITEST = join(fx.root, 'vitest.json');
  const dir = tmpStore(t);
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = dir;
  const init = fx.cli('init', { dag: fx.dagFile });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const d = await admitRun(fx, dir, engineArgv(fx, 'drive'));
  assert.equal(d.code, 0, JSON.stringify(d.line));
  assert.equal(fx.gate('reassess', {}).status, 0);
  return { fx, dir };
}
const NOT_DARWIN = process.platform === 'darwin' ? false : 'the test-kinds fixture runner is exercised on darwin (as run-engine-test-kinds.test.mjs)';

test('R1 (Opus MAJOR-1) testKinds run: `gate review` runs the evidence suite, so it is HEAVY: unclaimed it is refused and no runner starts; claimed it runs', { skip: NOT_DARWIN }, async (t) => {
  const { requiredWeight, heavyCommand } = await import('./engine-host-claim.mjs');
  assert.equal(heavyCommand('gate', 'review', { config: { testKinds: { policy: 1 } } }), true);
  assert.equal(heavyCommand('gate', 'review', { config: {} }), false, 'without test kinds a review gate stays light');
  assert.equal(requiredWeight({ config: { testKinds: { policy: 1 } }, nodes: {} }, 'gate', 'review'), 1);
  const { fx, dir } = await testKindsRun(t);
  const { passReview } = await import('./engine-test-fixture.mjs');
  const evidence = () => fx.readState().attempts.filter(a => a.kind === 'evidence').length;
  const runs = () => (existsSync(fx.env.FAKE_VITEST + '.log') ? readFileSync(fx.env.FAKE_VITEST + '.log', 'utf8').split('\n').filter(Boolean).length : 0);
  const [e0, r0] = [evidence(), runs()];
  const g = fx.gate('review', passReview('rx-1', fx.candidate()));
  assert.equal(g.out?.code, 'host_claim_required', g.stdout + g.stderr);
  assert.deepEqual([evidence(), runs()], [e0, r0], 'no evidence attempt, no runner invocation');
  const input = join(fx.root, 'review-in.json');
  writeFileSync(input, JSON.stringify(passReview('rx-1', fx.candidate())));
  const seen = [];
  const claimed = await admitRun(fx, dir, [...engineArgv(fx, 'gate', 'review').slice(0, 4), ...engineArgv(fx, 'gate', 'review').slice(4), '--input', input], { log: (l) => seen.push(l) });
  assert.equal(seen[0].weight, 1, 'host-admit derives weight 1 for a test-kinds review');
  assert.notEqual(claimed.code, 1, JSON.stringify(seen));
});

test('R2 (Codex MAJOR-1) the claim check binds to the LOCKED snapshot: a run whose flagged state appears after the command starts is still refused', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: REQUIRED });
  fx.env.AI_SKILLS_HOST_RESOURCES_DIR = tmpStore(t);
  const RE = await import('./run-engine.mjs');
  assert.equal(typeof RE.hostClaimAuthorizer, 'function');
  const authorize = RE.hostClaimAuthorizer('drive'); // built when the command starts: no state exists yet
  assert.equal(existsSync(fx.stateFile()), false);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0); // a concurrent init publishes the flagged state
  const before = readFileSync(fx.stateFile(), 'utf8');
  await assert.rejects(RE.drive({ ...fx.ctx(), authorize }), { code: 'host_claim_required' });
  assert.equal(readFileSync(fx.stateFile(), 'utf8'), before, 'nothing written');
  assert.deepEqual(fx.runs(), [], 'no worker launched');
  const unflagged = fixture(t);
  assert.equal(unflagged.cli('init', { dag: unflagged.dagFile }).status, 0);
  const out = await RE.drive({ ...unflagged.ctx(), authorize: RE.hostClaimAuthorizer('drive') });
  assert.equal(unflagged.readState().nodes.a.state, 'done', `an unflagged run is unaffected: ${JSON.stringify(out?.outcome)}`);
});

test('R3 (Codex MAJOR-2) a deferred claim of a run retired by `archive --retire` is reclaimed by proof from the archive; a missing proof stays unknown', { skip: SKIP }, async (t) => {
  const fx = fixture(t);
  const dir = tmpStore(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('drive').status, 0); // the engine finished; every attempt settled
  const runState = realpathSync(fx.stateFile());
  const { spawn } = await import('node:child_process');
  const { hostname } = await import('node:os');
  const { mkdirSync } = await import('node:fs');
  const gone = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await new Promise(r => gone.on('exit', r));
  mkdirSync(join(dir, 'claims'), { recursive: true });
  // the wrapper died before its own release: its claim names the run, its group is gone, its claimer dead
  const orphan = (id, extra) => writeFileSync(join(dir, 'claims', `${id}.json`), JSON.stringify({ schema: 'ship-ticket-host-claim-v1', op_id: id, class: 'heavy', weight: 1,
    resources: [], container_label: null, pgid: gone.pid, leader_start: 'x', claimer: { pid: 999999, process_start_time: 'x', host: hostname() },
    run_state: runState, run_id: 'run-1', claimed_at: 'x', bound_at: 'x', ...extra }));
  orphan('drv');
  const r = fx.cli('archive', { retire: 'true' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(runState), false, 'the state was moved into the archive');
  orphan('missing', { run_state: join(dirname(runState), '..', 'NOPE', 'state.json'), run_id: 'run-9' });
  orphan('other-run', { run_id: 'run-2' }); // same path, but no archive of run-2 exists: absence alone is never proof
  const h = await heavyClaim(dir, 'next', 1);
  assert.ok(!claimIds(dir).includes('drv'), 'the retired run is proven settled from its archived final state: reclaimed');
  assert.deepEqual(h.unknown.sort(), ['missing', 'other-run'], 'a missing or unattributable proof stays unknown (charged, Blocked)');
});
