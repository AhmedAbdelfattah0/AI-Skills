/**
 * S2 (P2) in the run engine: a DAG with `config.hostClaims: { version: 1, widthReason? }` takes a host claim (host-claims.mjs)
 * before it spawns any heavy node, binds it to the worker's pgid before the release byte and releases it once the group is
 * gone. P2-6: a lone heavy first node (width 1) is admitted THROUGH the claim: the frozen width-1 early return in fits()
 * (engine-attempts.mjs) launched it with no admission at all. Plus the width policy (explicit width; a reason for width 1)
 * and the per-operation class (`hostClass` per node, never ticket-wide; wave.mjs no longer marks every ticket heavy).
 * Temp repos, the fake provider and an injected host only; the claim store is a temp dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, POSIX, codes } from './engine-test-fixture.mjs';
import { fakeHost } from './host-claims.test-helper.mjs';
import { validateEngineDag } from './engine-dag.mjs';
import { acquireLock } from './lib/durable-io.mjs';

const SKIP = POSIX ? false : 'POSIX process groups (Windows quiescence is unknown, known limit D4)';
const engine = () => import('./run-engine.mjs');
const HC = { hostClaims: { version: 1, widthReason: 'one node: nothing to overlap' }, width: 1 };
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'engine-claims-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const rows = (dir) => { try { return readFileSync(join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const claimIds = (dir) => { try { return readdirSync(join(dir, 'claims')).filter(f => f.endsWith('.json')); } catch { return []; } };

test('P2-6 a lone heavy first node is held while the host has no free heavy slot (frozen: launched with no admission)', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: HC, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'heavy' }] });
  const dir = tmp(t), h = fakeHost();
  // Another operation already holds the host's one heavy slot (its claimer, this test process, is alive).
  const { claim } = await import('./host-claims.mjs');
  const other = await claim({ dir, opId: 'other-suite', cls: 'heavy', snapshot: h.snapshot, now: h.now });
  assert.equal(other.admit, true);
  const { init, drive } = await engine();
  await init(fx.ctx());
  const out = await drive(fx.ctx({ hostClaims: { dir, snapshot: h.snapshot, now: h.now } }));
  assert.equal(fx.runs('a').length, 0, 'the lone heavy node was not launched: the slot is taken');
  // Codex-3: a capacity hold is a WAITING diagnostic, never a judgment (so `next` says drive again, not owner).
  assert.ok(!codes(out).includes('host_held'), `no host_held judgment: ${codes(out)}`);
  assert.equal(out.outcome, 'waiting');
  assert.ok((out.waiting ?? []).some(w => w.code === 'host_held' && w.node === 'a'), `the hold is reported as waiting: ${JSON.stringify(out.waiting)}`);
  assert.equal(fx.readState().nodes.a.state, 'pending', 'it stays queued (no owner question, no failure)');
  assert.ok(rows(dir).some(r => r.kind === 'admission' && r.admit === false && r.reasons.includes('held_heavy') && r.op_id.startsWith('T-1.run-1.a.')), 'the hold is persisted with its sample');
});

test('P2-6 a lone heavy first node is admitted through a claim: claimed before spawn, bound before release, released after, sample and peak persisted', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: HC, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'heavy' }] });
  const dir = tmp(t), h = fakeHost();
  const seen = [];
  const hooks = { boundary: async (name) => {
    if (name === 'after-pid' || name === 'after-release') {
      const ids = claimIds(dir);
      const c = ids.length ? JSON.parse(readFileSync(join(dir, 'claims', ids[0]), 'utf8')) : null;
      seen.push([name, c?.pgid ?? null]);
    }
  } };
  const { init, drive } = await engine();
  await init(fx.ctx());
  const out = await drive(fx.ctx({ hooks, hostClaims: { dir, snapshot: h.snapshot, now: h.now } }));
  assert.equal(fx.runs('a').length, 1, `the node ran: ${codes(out)}`);
  const s = fx.readState();
  assert.equal(s.nodes.a.state, 'done');
  const a = s.attempts.find(x => x.node === 'a');
  assert.ok(a.host_claim?.op_id, 'the attempt records its claim');
  assert.equal(a.host_claim.released, true, 'released once the group was proven gone');
  assert.deepEqual(seen.map(([n]) => n), ['after-pid', 'after-release']);
  assert.ok(seen.every(([, pgid]) => pgid === a.pgid), 'the claim carried the pgid at the release byte');
  const r = rows(dir);
  assert.ok(r.some(x => x.kind === 'admission' && x.admit === true && x.op_id === a.host_claim.op_id && x.samples.length === 2), 'the admission sample is persisted');
  assert.ok(r.some(x => x.kind === 'peak' && x.op_id === a.host_claim.op_id && 'peak_rss_mb' in x), 'the post-admission peak is persisted');
  assert.deepEqual(claimIds(dir), [], 'nothing stays charged after the run');
});

test('P2-6 light nodes with no shared resource never sample; a legacy DAG (no hostClaims) keeps the frozen dispatch', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: { hostClaims: { version: 1 }, width: 2 }, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'light' }] });
  const dir = tmp(t);
  const { init, drive } = await engine();
  await init(fx.ctx());
  await drive(fx.ctx({ hostClaims: { dir, snapshot: async () => { throw new Error('a light node must not sample'); } } }));
  assert.equal(fx.runs('a').length, 1);
  assert.equal(existsSync(join(dir, 'claims')), false, 'no claim for a light node without shared resources');
  const legacy = fixture(t, { config: { width: 1 }, nodes: [{ id: 'a', writes: ['src/a.txt'] }] });
  await init(legacy.ctx());
  await drive(legacy.ctx());
  assert.equal(legacy.runs('a').length, 1, 'legacy runs are unchanged');
  assert.equal(legacy.readState().attempts[0].host_claim, undefined);
});

const dag = (config, nodes = [{ id: 'a', promptFile: 'p' }]) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 600000, ...config }, nodes });
test('width policy: hostClaims needs an explicit width, and width 1 needs a reason; hostClass is per node and explicit', () => {
  const bad = (doc, re) => assert.throws(() => validateEngineDag(doc), (e) => e.code === 'dag_invalid' && re.test(e.message), re.source);
  bad(dag({ hostClaims: { version: 1 } }, [{ id: 'a', promptFile: 'p', hostClass: 'light' }]), /explicit config\.width/);
  bad(dag({ hostClaims: { version: 1 }, width: 1 }, [{ id: 'a', promptFile: 'p', hostClass: 'light' }]), /widthReason/);
  bad(dag({ hostClaims: { version: 1, widthReason: '' }, width: 1 }, [{ id: 'a', promptFile: 'p', hostClass: 'light' }]), /widthReason/);
  bad(dag({ hostClaims: { version: 2 }, width: 2 }), /hostClaims/);
  bad(dag({ hostClaims: { version: 1 }, width: null }, [{ id: 'a', promptFile: 'p', hostClass: 'light' }]), /explicit config\.width/); // Codex-6
  bad(dag({ hostClaims: { version: 1 }, width: 2 }), /hostClass/);
  bad(dag({ width: 2 }, [{ id: 'a', promptFile: 'p', hostClass: 'heavy' }]), /config\.hostClaims/);
  bad(dag({ hostClaims: { version: 1 }, width: 2 }, [{ id: 'a', promptFile: 'p', hostClass: 'heavy', hostResources: [{ resource: 'x', mode: 'X' }] }]), /hostResources/);
  const ok = validateEngineDag(dag({ hostClaims: { version: 1, widthReason: 'shared generated output' }, width: 1 },
    [{ id: 'a', promptFile: 'p', hostClass: 'heavy', hostResources: [{ resource: '/opt/cache/node_modules', mode: 'R' }] }]));
  assert.equal(ok.nodes[0].hostClass, 'heavy');
  assert.equal(validateEngineDag(dag({ width: 3 })).nodes[0].hostClass, undefined, 'legacy DAGs carry no class');
});

test('wave.mjs: tickets are not ticket-wide heavy; heavy is a per-operation class taken through the claim store', async () => {
  const w = await import('./wave.mjs');
  assert.equal(typeof w.waveNodes, 'function');
  const m = { tickets: [{ key: 'A', deps: [], dep_mode: 'ship_ready', resources: [] }, { key: 'B', deps: ['A'], dep_mode: 'ship_ready', resources: [], priority: 3, owns: ['src'] }] };
  const nodes = w.waveNodes(m, { A: { state: 'pending' }, B: { state: 'pending' } });
  assert.deepEqual(nodes.map(n => n.class), ['light', 'light']);
  assert.deepEqual(nodes[1], { id: 'B', deps: ['A'], dep_mode: 'ship_ready', state: 'pending', owner_required: false, class: 'light', priority: 3, owns: ['src'] });
});

test('P2-6 hostClaims works on both placements: a durable-default run and the legacy escape hatch (durableRun: false)', { skip: SKIP }, async (t) => {
  for (const extra of [{}, { durableRun: false }]) {
    const fx = fixture(t, { config: { ...HC, ...extra }, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'heavy' }] });
    const dir = tmp(t), h = fakeHost();
    const { init, drive } = await engine();
    await init(fx.ctx());
    await drive(fx.ctx({ hostClaims: { dir, snapshot: h.snapshot, now: h.now } }));
    const s = fx.readState();
    assert.equal(fx.runs('a').length, 1, `ran (${JSON.stringify(extra)})`);
    assert.equal(s.attempts[0].host_claim?.released, true, `claimed and released (${JSON.stringify(extra)})`);
    assert.ok(rows(dir).some(r => r.kind === 'admission' && r.admit && r.op_id === s.attempts[0].host_claim.op_id));
    assert.deepEqual(claimIds(dir), []);
  }
});

// ---- S2 review round 1 repairs (Codex-1, Codex-2/F1, Codex-3, F5, F8) --------------------------------------------------
const label = { owner: 'ownr', run: 'run-c1' };
test('Codex-1 an engine heavy node carries its container labels: a surviving container keeps the claim charged until it is gone', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: HC, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'heavy', hostContainerLabel: label }] });
  const dir = tmp(t), h = fakeHost();
  let alive = true; const asked = [];
  const docker = (cmd, args) => { asked.push(args.join(' ')); return { status: 0, stdout: alive ? 'abcdef0123456789\n' : '', stderr: '' }; };
  const { init, drive, resume } = await engine();
  await init(fx.ctx());
  await drive(fx.ctx({ hostClaims: { dir, snapshot: h.snapshot, now: h.now, docker } }));
  assert.equal(fx.runs('a').length, 1);
  let a = fx.readState().attempts[0];
  assert.equal(a.host_claim.released, false, 'not released while its labelled container survives');
  assert.equal(a.host_claim.release_reason, 'container_alive');
  assert.equal(claimIds(dir).length, 1, 'still charged');
  assert.ok(asked.some(x => x.includes(`label=ai-skills.ship-ticket.owner=${label.owner}`) && x.includes(`label=ai-skills.ship-ticket.run=${label.run}`)));
  alive = false;
  await resume(fx.ctx({ hostClaims: { dir, docker } }));
  a = fx.readState().attempts[0];
  assert.equal(a.host_claim.released, true, 'released once no labelled container remains');
  assert.deepEqual(claimIds(dir), []);
});

/** A RED-gate fixture whose runner waits for `go` (after writing `started`) before running the TAP spec. */
function redFixture(t, unit) {
  const fx = fixture(t, { commit: true, config: { ...HC, testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'red.test.mjs'], format: 'tap', ...unit } } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], hostClass: 'light', redSpecs: [{ file: 'red.test.mjs', name: 'fails on assertion' }] }] });
  const started = join(fx.root, 'started'), go = join(fx.root, 'go');
  writeFileSync(join(fx.repo, 'red.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync, writeFileSync } from 'node:fs';\n`
    + `writeFileSync(${JSON.stringify(started)}, '');\nwhile (!existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 20));\n`
    + `test('fails on assertion', () => { assert.equal(1, 2); });\n`);
  return { fx, started, go };
}
async function until(pred, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { if (await pred()) return true; await new Promise(r => setTimeout(r, 20)); } return Boolean(await pred()); }

test('Codex-2/F1 a claimed installer cannot overlap an active RED/proof reader of the same realpath', { skip: SKIP }, async (t) => {
  const shared = join(tmp(t), 'node_modules'); mkdirSync(shared);
  const { fx, started, go } = redFixture(t, { hostClass: 'light', hostResources: [{ resource: shared, mode: 'R' }] });
  const dir = tmp(t);
  const { init, gate } = await engine();
  assert.equal((await init(fx.ctx())).ok ?? true, true);
  const running = gate(fx.ctx({ gate: 'red', input: { node: 'r', command: 'unit' }, hostClaims: { dir } }));
  assert.ok(await until(() => existsSync(started)), 'the RED runner is running');
  const { claim } = await import('./host-claims.mjs');
  const npmCi = await claim({ dir, opId: 'npm-ci', cls: 'light', resources: [{ resource: shared, mode: 'W' }] });
  assert.equal(npmCi.admit, false, 'the installer is queued behind the active runner reader');
  assert.deepEqual(npmCi.reasons, ['held_resource']);
  assert.equal(npmCi.conflicts.length, 1);
  writeFileSync(go, '');
  const v = await running;
  assert.equal(v.code, 'red_accepted', JSON.stringify(v.reasons));
  assert.deepEqual(claimIds(dir), [], 'the runner claim is released after its group is gone');
  assert.ok(rows(dir).some(r => r.kind === 'peak' && r.op_id === npmCi.conflicts[0]), 'the runner\'s peak is persisted');
});

test('Codex-2/F1 a heavy suite cannot start while capacity is exhausted; the held runner leaves RED unchanged and is retried', { skip: SKIP }, async (t) => {
  const { fx, started, go } = redFixture(t, {}); // no hostClass: a runner is heavy by default
  writeFileSync(go, '');
  const dir = tmp(t), h = fakeHost();
  const { claim, releaseClaim } = await import('./host-claims.mjs');
  assert.equal((await claim({ dir, opId: 'other-suite', cls: 'heavy', snapshot: h.snapshot, now: h.now })).admit, true);
  const { init, gate } = await engine();
  await init(fx.ctx());
  const held = await gate(fx.ctx({ gate: 'red', input: { node: 'r', command: 'unit' }, hostClaims: { dir, snapshot: h.snapshot, now: h.now } }));
  assert.equal(held.code, 'host_held', JSON.stringify(held));
  assert.equal(held.judgment_point, false, 'a hold is pending work, never a judgment');
  assert.equal(existsSync(started), false, 'the suite never started');
  const s = fx.readState();
  assert.equal(s.gates.red.r, undefined, 'no RED evidence recorded');
  assert.ok(!s.events.some(e => e.type === 'RED_REFUSED'), 'and no refused RED');
  assert.ok(!s.attempts.some(a => a.kind === 'gate-red'), 'no runner attempt was started');
  assert.equal((await releaseClaim({ dir, opId: 'other-suite' })).released, true);
  const again = await gate(fx.ctx({ gate: 'red', input: { node: 'r', command: 'unit' }, hostClaims: { dir, snapshot: h.snapshot, now: h.now } }));
  assert.equal(again.code, 'red_accepted', 'retried once capacity returns');
  assert.ok(rows(dir).some(r => r.kind === 'admission' && r.admit && r.op_id.includes('.gate-red.')), 'the runner admission is persisted');
});

test('F5 a busy claim store (lock timeout) holds the node; the drive does not throw', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: HC, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'heavy' }] });
  const dir = tmp(t), h = fakeHost();
  mkdirSync(dir, { recursive: true });
  const lock = await acquireLock({ lockFile: join(dir, 'claims.lock'), runId: 'other' });
  t.after(() => lock.release());
  const { init, drive } = await engine();
  await init(fx.ctx());
  const out = await drive(fx.ctx({ hostClaims: { dir, snapshot: h.snapshot, now: h.now, waitMs: 50 } }));
  assert.equal(out.outcome, 'waiting');
  assert.ok((out.waiting ?? []).some(w => w.code === 'host_held' && /busy|lock/.test(w.reason)), JSON.stringify(out.waiting));
  assert.equal(fx.runs('a').length, 0);
});

test('F8 a dispatch that throws after its claim and before the attempt is recorded releases the claim', { skip: SKIP }, async (t) => {
  const fx = fixture(t, { config: HC, nodes: [{ id: 'a', writes: ['src/a.txt'], hostClass: 'heavy' }] });
  const dir = tmp(t), h = fakeHost();
  const { init, drive } = await engine();
  await init(fx.ctx());
  const att = fx.placement().attempts;
  rmSync(att, { recursive: true, force: true }); mkdirSync(join(att, '..'), { recursive: true }); writeFileSync(att, 'not a directory');
  await assert.rejects(drive(fx.ctx({ hostClaims: { dir, snapshot: h.snapshot, now: h.now } })));
  assert.deepEqual(claimIds(dir), [], 'the claim did not leak for the engine\'s lifetime');
});
