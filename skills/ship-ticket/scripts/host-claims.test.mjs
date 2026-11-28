/**
 * S2 (P2 host claims): the §8 P2 negatives against the host-wide claim store (host-claims.mjs), plus their guards.
 *
 *   P2-1 last-slot race: N real processes race for the one free heavy slot -> exactly one is admitted (one launch).
 *   P2-2 claimer killed (-9) before the release byte -> its launcher child exits 125 without running the command, and the
 *        claim is reclaimed (bound to a pgid, and never bound at all).
 *   P2-3 dead claimer plus a live labelled container -> the claim is kept (still charged); once no labelled container
 *        remains it is reclaimed; a Docker failure proves nothing (unknown, charged).
 *   P2-4 two path spellings of one installation (a symlink): an active reader blocks the writer (`npm ci`); an unrelated
 *        resource proceeds.
 *   P2-5 unknown holder at capacity 1 -> ONE host-scoped Blocked is raised (not re-raised), the holder stays charged, and
 *        light work continues.
 *   P2-6 (run-engine-host-claims.test.mjs) a lone heavy first node is admitted through a claim.
 *
 * Every store is a temp dir (`dir`); the real ~/.ai-skills-state is never touched (pinned below). Host samples are
 * injected (fakeHost); process handshakes are polled with waitUntil, never slept on. No Docker (an injected fake), no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHost } from './host-claims.test-helper.mjs';

const POSIX = process.platform !== 'win32';
const SKIP = POSIX ? false : 'POSIX process groups (Windows quiescence is unknown, known limit D4)';
const HELPER = fileURLToPath(new URL('./host-claims.test-helper.mjs', import.meta.url));
/** Loaded dynamically so this file also runs (RED) against a tree without host-claims.mjs. */
const store = () => import('./host-claims.mjs');

const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'host-claims-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killGroup = (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
async function waitUntil(pred, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await pred()) return true; await new Promise(r => setTimeout(r, 20)); }
  return Boolean(await pred());
}
const claimIds = (dir) => { try { return readdirSync(join(dir, 'claims')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; } };
const { NODE_TEST_CONTEXT: _n, ...childEnv } = process.env;
/** One claimer process (host-claims.test-helper.mjs) with `o`; resolves its `out` JSON once written. */
function claimer(t, dir, o) {
  const out = join(dir, `${o.opId}.out.json`);
  const p = spawn(process.execPath, [HELPER, JSON.stringify({ dir, out, ...o })], { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv });
  let err = ''; p.stderr.on('data', c => { err += c; });
  const exited = new Promise(r => p.on('exit', (code, signal) => r({ code, signal })));
  t.after(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  return { p, out, exited, result: async () => { assert.ok(await waitUntil(() => existsSync(out)), `claimer ${o.opId} wrote its result (${err})`); return JSON.parse(readFileSync(out, 'utf8')); } };
}
/** An in-process heavy claim on the fake host (one heavy slot at pressure 2). */
const heavy = async (dir, opId, extra = {}) => { const { claim } = await store(); const h = fakeHost(); return claim({ dir, opId, cls: 'heavy', snapshot: h.snapshot, now: h.now, ...extra }); };
const light = async (dir, opId, resources, extra = {}) => { const { claim } = await store(); return claim({ dir, opId, cls: 'light', resources, ...extra }); };

test('P2-1 last-slot race: six processes race for the one free heavy slot, exactly one is admitted', { skip: SKIP }, async (t) => {
  const dir = tmp(t), barrier = join(dir, 'go');
  const racers = Array.from({ length: 6 }, (_, i) => claimer(t, dir, { mode: 'race', opId: `race-${i}`, barrier }));
  assert.ok(await waitUntil(() => racers.every(r => existsSync(r.out + '.ready'))), 'every racer reached the barrier'); // N6: no sleep
  writeFileSync(barrier, '');
  const results = await Promise.all(racers.map(r => r.result()));
  const admitted = results.filter(r => r.admit);
  assert.equal(admitted.length, 1, `exactly one launch: ${JSON.stringify(results.map(r => [r.op_id, r.reasons]))}`);
  for (const r of results.filter(x => !x.admit)) {
    assert.ok(r.reasons.includes('held_heavy'), `a loser is held by the slot it lost, not by sampling: ${r.reasons}`);
    assert.ok(!r.reasons.includes('held_resample') && !r.reasons.includes('held_hysteresis'), 'each racer had a fresh, admissible sample');
  }
  assert.deepEqual(claimIds(dir), [admitted[0].op_id], 'the store holds the winner alone');
});

test('P2-2 claimer killed -9 before the release byte: the child exits 125 without running and the bound claim is reclaimed', { skip: SKIP }, async (t) => {
  const dir = tmp(t), ranFile = join(dir, 'ran');
  const c = claimer(t, dir, { mode: 'bind-then-hang', opId: 'victim', ranFile });
  const r = await c.result();
  t.after(() => killGroup(r.pgid));
  assert.ok(groupAlive(r.pgid), 'the launcher waits in its own process group for the release byte');
  const bound = JSON.parse(readFileSync(join(dir, 'claims', 'victim.json'), 'utf8'));
  assert.equal(bound.pgid, r.pgid, 'the claim was rewritten with the pgid before any release byte');
  assert.ok(bound.leader_start, 'and with the leader start time');
  c.p.kill('SIGKILL');
  await c.exited;
  assert.ok(await waitUntil(() => !groupAlive(r.pgid)), 'the launcher exits (125) once its stdin closes without the byte');
  assert.equal(existsSync(ranFile), false, 'the command never ran');
  const next = await heavy(dir, 'next');
  assert.equal(next.admit, true, `the slot is free again: ${next.reasons}`);
  assert.deepEqual(claimIds(dir), ['next'], 'the killed claimer\'s claim was reclaimed (group proven gone, no container label)');
});

test('P2-2b claimer killed -9 before it bound any pgid: nothing can have run, the claim is reclaimed', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  const c = claimer(t, dir, { mode: 'claim-then-hang', opId: 'early' });
  await c.result();
  const held = await heavy(dir, 'second');
  assert.equal(held.admit, false, 'a live claimer keeps its unbound claim charged');
  assert.ok(held.reasons.includes('held_heavy'));
  c.p.kill('SIGKILL');
  await c.exited;
  const next = await heavy(dir, 'third');
  assert.equal(next.admit, true, `claimer proven dead and no pgid bound: reclaimed (${next.reasons})`);
  assert.deepEqual(claimIds(dir), ['third']);
});

test('P2-3 dead claimer plus a live labelled container: kept and charged; reclaimed only once no labelled container remains', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  const label = { owner: 'ownr', run: 'run-7' };
  const c = claimer(t, dir, { mode: 'bind-then-exit', opId: 'db-op', containerLabel: label });
  const r = await c.result();
  await c.exited;
  assert.ok(await waitUntil(() => !groupAlive(r.pgid)), 'the claimer and its process group are gone');
  const calls = [];
  let containers = 'abcdef0123456789\n', fail = false;
  const docker = (cmd, args) => { calls.push(args.join(' ')); return fail ? { status: 1, stdout: '', stderr: 'daemon down' } : { status: 0, stdout: containers, stderr: '' }; };
  const kept = await heavy(dir, 'next-1', { docker });
  assert.equal(kept.admit, false, 'a labelled container is still alive: the claim stays charged');
  assert.ok(kept.reasons.includes('held_heavy'));
  assert.ok(claimIds(dir).includes('db-op'), 'never released while a labelled container remains');
  assert.ok(calls.some(a => a.includes(`label=ai-skills.ship-ticket.owner=${label.owner}`) && a.includes(`label=ai-skills.ship-ticket.run=${label.run}`)), 'the exact owner/run labels were queried');
  fail = true;
  const unknown = await heavy(dir, 'next-2', { docker });
  assert.equal(unknown.admit, false, 'a Docker failure proves nothing');
  assert.ok(unknown.unknown.includes('db-op'), 'the holder is unknown and stays charged');
  fail = false; containers = '';
  const free = await heavy(dir, 'next-3', { docker });
  assert.equal(free.admit, true, `group gone and no labelled container remains: reclaimed (${free.reasons})`);
  assert.deepEqual(claimIds(dir), ['next-3']);
});

test('P2-4 two spellings of one installation: an active reader blocks the writer (npm ci); an unrelated resource proceeds', async (t) => {
  const dir = tmp(t), root = tmp(t);
  mkdirSync(join(root, 'real', 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'other', 'node_modules'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'alias'), 'dir');
  const reader = await light(dir, 'build-reader', [{ resource: join(root, 'alias', 'node_modules'), mode: 'R' }]);
  assert.equal(reader.admit, true, `the reader is admitted: ${reader.reasons}`);
  const writer = await light(dir, 'npm-ci', [{ resource: join(root, 'real', 'node_modules'), mode: 'W' }]);
  assert.equal(writer.admit, false, 'the writer is queued behind the active reader of the same realpath');
  assert.deepEqual(writer.reasons, ['held_resource']);
  assert.deepEqual(writer.conflicts, ['build-reader']);
  const reader2 = await light(dir, 'test-reader', [{ resource: join(root, 'real', 'node_modules'), mode: 'R' }]);
  assert.equal(reader2.admit, true, 'readers share');
  const other = await light(dir, 'npm-ci-other', [{ resource: join(root, 'other', 'node_modules'), mode: 'W' }]);
  assert.equal(other.admit, true, `an unrelated installation proceeds: ${other.reasons}`);
  assert.deepEqual(claimIds(dir), ['build-reader', 'npm-ci-other', 'test-reader'], 'the unrelated writer really holds its claim');
  const { releaseClaim } = await store();
  for (const id of ['build-reader', 'test-reader']) assert.equal((await releaseClaim({ dir, opId: id })).released, true);
  const writerAgain = await light(dir, 'npm-ci', [{ resource: join(root, 'alias', 'node_modules'), mode: 'W' }]);
  assert.equal(writerAgain.admit, true, 'once the readers are released the writer is admitted');
  const stored = JSON.parse(readFileSync(join(dir, 'claims', 'npm-ci.json'), 'utf8'));
  assert.equal(stored.resources[0].resource, realpathSync.native(join(root, 'real', 'node_modules')), 'the claim binds the canonical realpath');
  assert.equal(stored.weight, 0, 'light claims carry weight 0');
});

test('P2-5 unknown holder at capacity 1: one host-scoped Blocked, the holder stays charged, light work continues', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  const c = claimer(t, dir, { mode: 'bind-then-exit', opId: 'mystery', hold: true, leaderStart: 'Thu Jan  1 00:00:00 1970' });
  const r = await c.result();
  t.after(() => killGroup(r.pgid));
  await c.exited;
  assert.ok(groupAlive(r.pgid), 'the bound group is alive, but its leader start does not match: identity unknown');
  const first = await heavy(dir, 'heavy-1');
  assert.equal(first.admit, false, 'the unknown holder stays charged at capacity 1');
  assert.ok(first.reasons.includes('held_heavy'));
  assert.deepEqual(first.unknown, ['mystery']);
  assert.equal(first.blocked?.raised, true, 'one host-scoped Blocked is raised');
  const blockedFile = join(dir, 'blocked.json');
  const raw = readFileSync(blockedFile, 'utf8'), rec = JSON.parse(raw);
  assert.equal(rec.code, 'host_claim_unknown');
  assert.deepEqual(rec.op_ids, ['mystery']);
  const again = await heavy(dir, 'heavy-2');
  assert.equal(again.admit, false);
  assert.equal(again.blocked?.raised, false, 'the same Blocked is not raised twice');
  assert.equal(readFileSync(blockedFile, 'utf8'), raw, 'the record is unchanged');
  const lightOp = await light(dir, 'docs-lint', [{ resource: join(dir, 'unrelated'), mode: 'W' }]);
  assert.equal(lightOp.admit, true, `light work continues beside the unknown holder: ${lightOp.reasons}`);
  assert.ok(claimIds(dir).includes('docs-lint'), 'the light claim was really taken');
  assert.ok(claimIds(dir).includes('mystery'), 'the unknown holder is never deleted');
  killGroup(r.pgid);
  assert.ok(await waitUntil(() => !groupAlive(r.pgid)));
  const after = await heavy(dir, 'heavy-3');
  assert.equal(after.admit, true, `the group is gone: the claim is reclaimed and the slot returns (${after.reasons})`);
  assert.equal(existsSync(blockedFile), false, 'the Blocked clears with its cause');
});

test('guard: no age-based deletion, release only when the group is gone, persisted admission sample and post-admission peak', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  const { claim, bindClaim, releaseClaim } = await store();
  const h = fakeHost();
  const r = await claim({ dir, opId: 'suite', cls: 'heavy', snapshot: h.snapshot, now: h.now });
  assert.equal(r.admit, true);
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  t.after(() => killGroup(p.pid));
  const { leaderStart } = await import('./engine-quiesce.mjs');
  await bindClaim({ dir, opId: 'suite', pgid: p.pid, leaderStart: leaderStart(p.pid) });
  const file = join(dir, 'claims', 'suite.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  c.claimed_at = '2001-01-01T00:00:00.000Z'; // ancient: age alone must never free it
  writeFileSync(file, JSON.stringify(c));
  const refused = await releaseClaim({ dir, opId: 'suite', peak: { peak_rss_mb: 10 } });
  assert.deepEqual([refused.released, refused.reason], [false, 'group_alive'], 'never released while its group lives');
  const held = await heavy(dir, 'other');
  assert.equal(held.admit, false, 'an old but live claim is still charged');
  killGroup(p.pid);
  assert.ok(await waitUntil(() => !groupAlive(p.pid)));
  const ok = await releaseClaim({ dir, opId: 'suite', peak: { peak_rss_mb: 10, peak_cpu_pct: 5 } });
  assert.equal(ok.released, true);
  const rows = readFileSync(join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const adm = rows.find(x => x.kind === 'admission' && x.op_id === 'suite');
  assert.ok(adm && adm.admit === true && adm.samples.length === 2 && adm.heavy_slots === 1 && adm.occupancy === 0, 'the admission sample is persisted');
  const peak = rows.find(x => x.kind === 'peak' && x.op_id === 'suite');
  assert.ok(peak && peak.peak_rss_mb === 10 && Number.isFinite(peak.host_load1_at_release), 'the post-admission peak is persisted');
  assert.ok(rows.some(x => x.kind === 'admission' && x.op_id === 'other' && x.admit === false), 'a hold is persisted too');
});

test('guard: the store is overridable, and the real ~/.ai-skills-state is never used under the test runner', async () => {
  const { storeDir, STORE_ENV } = await store();
  const real = join(homedir(), '.ai-skills-state', 'host-resources');
  const before = existsSync(real) ? statSync(real).mtimeMs : null;
  assert.equal(storeDir({ [STORE_ENV]: resolve('/tmp/x-store') }), resolve('/tmp/x-store'));
  assert.throws(() => storeDir({ NODE_TEST_CONTEXT: 'child' }), { code: 'host_store_default_in_test' });
  assert.equal(storeDir({ HOME: '/home/u' }, { home: '/home/u' }), join('/home/u', '.ai-skills-state', 'host-resources'));
  assert.equal(existsSync(real) ? statSync(real).mtimeMs : null, before, 'the real store is untouched');
});

// ---- S2 review round 1 repairs (Codex-4, Codex-5, F2, F3, F6, F7) ------------------------------------------------------
/** A claim bound to a group that is already gone, carrying container labels (its claimer process has exited). */
async function deadLabelled(t, dir, opId, label = { owner: 'ownr', run: 'run-9' }) {
  const c = claimer(t, dir, { mode: 'bind-then-exit', opId, containerLabel: label });
  const r = await c.result(); await c.exited;
  assert.ok(await waitUntil(() => !groupAlive(r.pgid)));
  return label;
}

test('Codex-4 Docker is probed OUTSIDE the claim mutation lock; a record changed meanwhile stays charged', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  await deadLabelled(t, dir, 'db-op');
  const lockSeen = [];
  const docker = (cmd, args) => { lockSeen.push(existsSync(join(dir, 'claims.lock'))); return { status: 0, stdout: '', stderr: '' }; };
  const r = await heavy(dir, 'next', { docker });
  assert.ok(lockSeen.length > 0, 'Docker was asked');
  assert.deepEqual([...new Set(lockSeen)], [false], 'never while the store lock is held');
  assert.equal(r.admit, true, `the probed claim was reclaimed: ${r.reasons}`);
  assert.deepEqual(claimIds(dir), ['next']);
});

test('Codex-5 an unbound claim whose live claimer has no recorded start identity is UNKNOWN (charged, Blocked), never live', async (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'claims'), { recursive: true });
  writeFileSync(join(dir, 'claims', 'nostart.json'), JSON.stringify({ schema: 'ship-ticket-host-claim-v1', op_id: 'nostart', class: 'heavy', weight: 1, resources: [],
    container_label: null, pgid: null, leader_start: null, claimer: { pid: process.pid, process_start_time: null, host: hostname() }, claimed_at: 'x', bound_at: null }));
  const r = await heavy(dir, 'h');
  assert.equal(r.admit, false, 'still charged');
  assert.deepEqual(r.unknown, ['nostart'], 'an unproven identity is unknown, not live');
  assert.equal(r.blocked?.raised, true, 'and raises the host-scoped Blocked');
});

test('F2 a claim reclaimed by another claimer before its owner releases it: the owner still persists the post-admission peak', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  const c = claimer(t, dir, { mode: 'bind-then-exit', opId: 'quick' });
  const r = await c.result(); await c.exited;
  assert.ok(await waitUntil(() => !groupAlive(r.pgid)));
  await light(dir, 'other', [{ resource: join(dir, 'x'), mode: 'W' }]); // its reconcile reclaims `quick`
  assert.ok(!claimIds(dir).includes('quick'));
  const { releaseClaim } = await store();
  const rel = await releaseClaim({ dir, opId: 'quick', peak: { peak_rss_mb: 7 } });
  assert.equal(rel.reason, 'absent');
  const rows = readFileSync(join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(rows.some(x => x.kind === 'peak' && x.op_id === 'quick' && x.peak_rss_mb === 7), 'the peak row is not lost');
});

test('F3 a holder of weight 2 is charged 2 and the next heavy is held_heavy (never invalid_args)', async (t) => {
  const dir = tmp(t);
  const { claim } = await store();
  const h = fakeHost({ pressure: 1 }); // healthy: two heavy slots
  const big = await claim({ dir, opId: 'big', cls: 'heavy', weight: 2, snapshot: h.snapshot, now: h.now });
  assert.equal(big.admit, true, `${big.reasons}`);
  const h2 = fakeHost({ pressure: 1 });
  const next = await claim({ dir, opId: 'next', cls: 'heavy', snapshot: h2.snapshot, now: h2.now });
  assert.equal(next.admit, false);
  assert.ok(next.reasons.includes('held_heavy') && !next.reasons.includes('invalid_args'), `${next.reasons}`);
});

test('F6 an unreadable holder is charged its resources too: it conflicts with every resource claim', async (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'claims'), { recursive: true });
  writeFileSync(join(dir, 'claims', 'garbled.json'), '{ not json');
  const r = await light(dir, 'npm-ci', [{ resource: join(dir, 'node_modules'), mode: 'W' }]);
  assert.equal(r.admit, false);
  assert.ok(r.reasons.includes('held_resource'));
  assert.deepEqual(r.conflicts, ['garbled']);
  const bare = await light(dir, 'no-resources', []);
  assert.equal(bare.admit, true, 'a claim with no resources is not blocked by it');
});

test('F7 only STOPPED labelled containers remain: the holder is unknown (charged, Blocked), not silently live', { skip: SKIP }, async (t) => {
  const dir = tmp(t);
  await deadLabelled(t, dir, 'stopped');
  const docker = (cmd, args) => ({ status: 0, stdout: args.includes('status=running') ? '' : 'abcdef0123456789\n', stderr: '' });
  const r = await heavy(dir, 'h', { docker });
  assert.equal(r.admit, false, 'still charged');
  assert.deepEqual(r.unknown, ['stopped']);
  assert.equal(r.blocked?.raised, true);
});
