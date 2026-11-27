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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, POSIX, codes } from './engine-test-fixture.mjs';
import { fakeHost } from './host-claims.test-helper.mjs';
import { validateEngineDag } from './engine-dag.mjs';

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
  assert.ok(codes(out).includes('host_held'), `the drive reports the hold: ${codes(out)}`);
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
