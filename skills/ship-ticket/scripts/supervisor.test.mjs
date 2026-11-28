/**
 * PR-5 / S7a acceptance (CONSOLIDATED §8 P3; §14.4 #4, #8, #9, #10, #13). Fake providers only (supervisor.test-helper.mjs):
 * the engine commands and agent CLIs are fake, but they run as real processes under the real durable launcher, the journal
 * is the real one on lib/durable-io, and crashes are real SIGKILLs of a real tick process. No launchd, network or Docker.
 * NOT covered here (real-host work, H3/H4): launchd's own non-overlap, detached-child survival under launchd, credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tick, sweep, installPlan, engineArgv, failedRounds, plistXml, DRIVE_BOUND_MS, TICK_BOUND_MS, ENGINE_COMMANDS } from './supervisor.mjs';
import { withJournal, journalPaths, opId, assertNoAuthority, readJournal, MAX_PROBES } from './supervisor-journal.mjs';
import { AUTHORITY_EVENTS } from './run-state.mjs';
import { makeWorld, worldDeps, opts, effects, journal, readState, writeState, setClock, WAVE_ID } from './supervisor.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'supervisor.test-helper.mjs');
const POSIX = process.platform !== 'win32';
const SKIP = POSIX ? false : 'process groups and the durable launcher are POSIX here';

function world(t, tickets, o) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sup-')));
  t.after(() => { killWorld(dir); rmSync(dir, { recursive: true, force: true }); });
  return makeWorld(dir, tickets, o).dir;
}
/** Kill every fake process the world started (hung fakes must not outlive the test). */
function killWorld(dir) {
  try { for (const e of effects(dir)) if (e.pid) try { process.kill(e.pid, 'SIGKILL'); } catch { /* gone */ } } catch { /* no log */ }
  try { for (const o of Object.values(journal(dir)?.ops ?? {})) if (o.pgid) try { process.kill(-o.pgid, 'SIGKILL'); } catch { /* gone */ } } catch { /* no journal */ }
  const until = Date.now() + 5000; // the killed launchers' groups must be gone before their directory is removed
  for (const o of Object.values((() => { try { return journal(dir)?.ops ?? {}; } catch { return {}; } })())) while (o.pgid && alive(o.pgid) && Date.now() < until) spawnSync('sleep', ['0.05']);
}
const count = (dir, pred) => effects(dir).filter(pred).length;
const ticks = async (dir, n, over = {}) => { let r; for (let i = 0; i < n; i++) r = await tick(opts(dir), worldDeps(dir, over)); return r; };
/** Tick until nothing is live and nothing new happens (each tick waits for the detached work it started to finish). */
async function settleAll(dir, over = {}, max = 40) {
  let last = '';
  for (let i = 0; i < max; i++) {
    await waitLive(dir);
    await tick(opts(dir), worldDeps(dir, over));
    await waitLive(dir);
    const J = journal(dir);
    const sig = JSON.stringify([J?.ops && Object.values(J.ops).map((o) => [o.op_id, o.state, o.probes]), J?.blocked, J?.ship_ready, effects(dir).length]);
    if (sig === last) return J;
    last = sig;
  }
  throw new Error('world did not settle');
}
/** Wait until every acted/ambiguous launch op of the journal has written its envelope or its group is gone. */
async function waitLive(dir) {
  const J = journal(dir);
  if (!J) return;
  for (const o of Object.values(J.ops)) {
    if (o.kind !== 'launch' || o.state === 'recorded' || !o.pgid) continue;
    await waitFor(() => existsSync(o.files.envelope) || !alive(o.pgid), `op ${o.op_id}`);
  }
}
const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const child = (dir, cmd, spec) => spawnSync(process.execPath, [HELPER, cmd, dir, ...(spec ? [spec] : [])], { encoding: 'utf8', timeout: 60000, env: { ...process.env, SUP_WORLD: dir } });
const happyKinds = ['drive', 'agent:primary:original', 'agent:second:original', 'agent:reconcile:original', 'gate review', 'gate ship-ready'];
const kindOf = (e) => (e.kind === 'agent' ? `agent:${e.leg}:${e.review_kind}` : e.kind);

// ------------------------------------------------------------------------------------------------- journal

test('journal: fixed op ids, intent before effect, ambiguous never replayed, bounded probes, one lock', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'supj-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const P = journalPaths(dir, 'W-1');
  assert.equal(opId('r1', 'T-1', 'drive', 's3'), 'r1:T-1:drive:s3');
  assert.throws(() => opId('r1', 'T 1', 'drive', 's3'), /op_id_invalid/);
  assert.throws(() => opId('r1', 'T1', 'drive', ''), /op_id_invalid/);
  await withJournal(P, 'W-1', async (J) => {
    const a = await J.intent({ op_id: 'r1:T1:drive:s3', ticket: 'T1', kind: 'launch' });
    assert.equal(a.state, 'intent');
    const again = await J.intent({ op_id: 'r1:T1:drive:s3', ticket: 'T1', kind: 'launch', extra: 1 });
    assert.equal(again.extra, undefined, 'an existing op is returned untouched, never re-created');
    await J.move(a.op_id, 'ambiguous');
    for (const to of ['intent', 'acted']) await assert.rejects(J.move(a.op_id, to), /op_move_refused/, `ambiguous -> ${to}`);
    for (let i = 1; i < MAX_PROBES; i++) assert.equal(await J.probe(a.op_id, 'x'), false);
    assert.equal(await J.probe(a.op_id, 'x'), true, 'the probe budget is bounded');
    await J.move(a.op_id, 'recorded', { result: { outcome: 'ran' } });
    await assert.rejects(J.move(a.op_id, 'ambiguous'), /op_move_refused/, 'recorded is terminal');
    await assert.rejects(withJournal(P, 'W-1', async () => {}), /journal_busy/, 'one lock: a second holder is refused, never waited for');
  });
  assert.equal(readJournal(P, 'W-1').ops['r1:T1:drive:s3'].state, 'recorded', 'committed atomically, read lock-free');
});

test('journal: every authority event is refused anywhere in a record (§8 P3: SECURITY_WAIVER append refused)', async (t) => {
  assert.deepEqual(AUTHORITY_EVENTS, ['START', 'DAG_BOUND', 'RETRY', 'UNIT_CLEAR', 'SECURITY_ADDENDUM', 'SECURITY_WAIVER', 'TEST_KIND_WAIVER']);
  for (const ev of AUTHORITY_EVENTS) {
    assert.throws(() => assertNoAuthority({ a: [{ event: ev }] }), /authority_refused/, ev);
    assert.throws(() => assertNoAuthority({ kind: ev }), /authority_refused/, ev);
  }
  assert.doesNotThrow(() => assertNoAuthority({ event: 'DISPATCH', kind: 'launch', needs: 'SECURITY_WAIVER' }));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'supj-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withJournal(journalPaths(dir, 'W-1'), 'W-1', async (J) => {
    await assert.rejects(J.intent({ op_id: 'r1:T1:waiver:s1', ticket: 'T1', kind: 'SECURITY_WAIVER' }), /authority_refused/);
    await assert.rejects(J.intent({ op_id: 'r1:T1:x:s1', ticket: 'T1', kind: 'launch', append: { event: 'SECURITY_WAIVER', authorized_by: 'owner' } }), /authority_refused/);
    assert.equal(J.op('r1:T1:waiver:s1'), null, 'nothing was recorded');
  });
});

test('supervisor source: no RUN-STATE writer, and only the allowed engine commands are ever launched (§14.4 #13)', () => {
  const src = readFileSync(join(HERE, 'supervisor.mjs'), 'utf8') + readFileSync(join(HERE, 'supervisor-journal.mjs'), 'utf8');
  for (const w of ['appendRunStateOnce', 'eventLine', 'runStateAppendOnly', 'workerRunStateAppend', 'appendFileSync']) assert.ok(!src.includes(w), `no RUN-STATE writer: ${w}`);
  assert.ok(!/spawnSync\(\s*'launchctl'|spawn\(\s*'launchctl'/.test(src), 'never runs launchctl');
  assert.deepEqual(ENGINE_COMMANDS, ['drive', 'gate red', 'gate ship-ready', 'gate review', 'reconcile']);
  const t = { key: 'T1', worktree: '/w', run_id: 'r' };
  for (const bad of ['init', 'mark', 'archive', 'adopt', 'rebind', 'clear-unit', 'resume', 'gate reassess', 'succeed']) assert.throws(() => engineArgv(bad, t), /command_refused/, bad);
  assert.deepEqual(engineArgv('drive', t).slice(2), ['drive', '--repo', '/w', '--ticket', 'T1', '--run-id', 'r']);
});

// ------------------------------------------------------------------------------------------------- happy path + routing

test('a ticket runs to SHIP_READY with every effect exactly once; Owner Merge never merges', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1' }]);
  const J = await settleAll(dir);
  assert.deepEqual(effects(dir).map(kindOf).sort(), [...happyKinds].sort());
  assert.match(J.ship_ready.T1.merge, /^awaiting_owner_merge$/);
  assert.deepEqual(J.blocked, {});
  assert.equal(J.tick, null, 'the tick cleared its record on exit');
  assert.equal(J.binding.merge_strategy, 'owner');
  const again = await ticks(dir, 3);
  assert.equal(again.code, 0);
  assert.equal(effects(dir).length, happyKinds.length, 'idempotent: later ticks add no effect');
});

test('Automatic Merge is persisted and enforced as never merged here (merge executor is PR-6b); a strategy change is refused as a plan change', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1' }], { merge_strategy: 'automatic' });
  const J = await settleAll(dir);
  assert.equal(J.binding.merge_strategy, 'automatic');
  assert.match(J.ship_ready.T1.merge, /prevented: merge executor not implemented/);
  assert.ok(!effects(dir).some((e) => /merge|push|pr/.test(e.kind)), 'no publication effect at all');
  const changed = await tick(opts(dir), worldDeps(dir, { readManifest: () => ({ ok: true, manifest: { ...JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), merge_strategy: 'owner' }, digest: worldDeps(dir).verifyWave().digest }) }));
  assert.equal(changed.code, 2);
  assert.equal(changed.out.code, 'wave_plan_changed');
});

test('routing: every review leg and the RCA run on modelMap[tier] of their route (tier strong); drive carries no model (the engine routes it)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { outcomes: { original: 'FAIL', confirmation: 'FAIL' }, rca: { hypothesis: 'h', evidence: ['e'], differs: 'd', path: 'succession' } } }]);
  await settleAll(dir);
  const agents = effects(dir).filter((e) => e.kind === 'agent');
  assert.deepEqual(agents.map((a) => a.leg).sort(), ['primary', 'primary', 'rca', 'reconcile', 'reconcile', 'second', 'second']);
  for (const a of agents) {
    if (a.leg === 'second') assert.deepEqual([a.provider, a.args.slice(-2)], ['codex', ['codex-strong-x', '-']], 'second opinion: its own route, modelMap.strong');
    else { assert.equal(a.provider, 'claude'); assert.deepEqual(a.args.slice(-2), ['--model', 'claude-strong-x'], `${a.leg}: modelMap.strong of the approved config`); }
    assert.ok(a.args.includes('dontAsk') || a.args.includes('read-only'), 'read-only agent task');
  }
  for (const d of effects(dir).filter((e) => e.kind === 'drive')) assert.ok(!d.argv.includes('--model') && !d.argv.includes('-m'), 'build/correction/resume are routed inside the engine (carrier), never by the supervisor');
  // an unresolved strong tier is refused, as the carrier always does: the ticket alone is Blocked, nothing launched
  const dir2 = world(t, [{ key: 'T1', phase: 'review_owed' }]);
  const S = readState(dir2, 'T1'); S.config.modelMap = {}; writeState(dir2, 'T1', S);
  const J = await settleAll(dir2);
  assert.equal(count(dir2, (e) => e.kind === 'agent'), 0, 'every route is resolved before any leg is launched');
  assert.equal(J.blocked.T1.code, 'review_route_refused');
  assert.match(J.blocked.T1.reason, /strong tier requires modelMap.strong/);
});

// ------------------------------------------------------------------------------------------------- crash recovery

const BOUNDARIES = ['after-tick-start', 'after-intent', 'after-receipt', 'after-pid', 'after-release', 'after-acted', 'after-gate'];
test('kill -9 after each act: 0 duplicate effects, or the op is preserved ambiguous (never replayed)', { skip: SKIP, timeout: 600000 }, async (t) => {
  for (const b of BOUNDARIES) {
    for (const n of [1, 2, 3]) {
      const dir = world(t, [{ key: 'T1' }]);
      // drive the world to the n-th hit of boundary b, SIGKILLing the tick there (earlier ticks run whole)
      let killed = false;
      for (let i = 0; i < 12 && !killed; i++) {
        await waitLive(dir);
        const r = child(dir, 'tick', `${b}:${n} kill`);
        killed = r.signal === 'SIGKILL';
        assert.ok(killed || r.status === 0, `${b}:${n} tick ${i}: ${r.stderr}`);
        if (!killed) continue;
      }
      const J = await settleAll(dir);
      const byKind = {};
      for (const e of effects(dir)) byKind[kindOf(e)] = (byKind[kindOf(e)] ?? 0) + 1;
      const dup = Object.entries(byKind).filter(([, c]) => c > 1);
      assert.deepEqual(dup, [], `${b}:${n}: duplicate effects ${JSON.stringify(byKind)}`);
      if (!J.ship_ready.T1) {
        // the only acceptable non-completion: an ambiguous op preserved and the ticket Blocked naming it
        assert.equal(J.blocked.T1?.code, 'ambiguous_unresolved', `${b}:${n}: ${JSON.stringify(J.blocked)}`);
        assert.equal(J.ops[J.blocked.T1.op_id].state, 'ambiguous');
      }
    }
  }
});

test('a review in flight at session loss is collected exactly once from its receipt (§14.4 #4)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { slow: { primary: 1500, second: 1500 } } }]);
  const first = child(dir, 'tick'); // the session that dispatched the review ends here
  assert.equal(first.status, 0, first.stderr);
  const J0 = journal(dir);
  const legs = Object.values(J0.ops).filter((o) => /review\.(primary|second)/.test(o.op_id));
  assert.equal(legs.length, 2);
  for (const o of legs) { assert.equal(o.state, 'acted'); assert.ok(o.pgid && o.leader_start && o.deadline, 'pgid, leader_start and the deadline were persisted before release'); }
  assert.ok(legs.every((o) => alive(o.pgid)), 'the legs outlive the tick that launched them');
  const mid = await tick(opts(dir), worldDeps(dir));
  assert.equal(mid.out.tickets.T1?.skipped, 'op_live', 'no new effect while the review is live');
  const crashAtGate = child(dir, 'tick', 'after-gate:1 kill');
  void crashAtGate;
  const J = await settleAll(dir);
  assert.equal(count(dir, (e) => e.kind === 'gate review'), 1, 'gate review ran once');
  assert.equal(count(dir, (e) => e.kind === 'agent' && e.leg === 'primary'), 1);
  assert.equal(J.ops[`rtest:T1:review:rx-1`].state, 'recorded');
  assert.ok(J.ship_ready.T1);
});

test('a reconciler that alters a reviewer artifact is refused (no laundering); the ticket alone is Blocked', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { tamper: true, outcomes: { original: 'FAIL' } } }, { key: 'T2' }]);
  const J = await settleAll(dir);
  assert.equal(J.blocked.T1.code, 'review_input_invalid');
  assert.equal(count(dir, (e) => e.kind === 'gate review' && e.ticket === 'T1'), 0);
  assert.ok(J.ship_ready.T2, 'the independent ticket continued');
});

// ------------------------------------------------------------------------------------------------- isolation, authority, recovery

test('owner stop on X while Y and Z continue; a Blocked ticket holds only its dependents (§14.4 #8)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'X', phase: 'owner_stop' }, { key: 'Y' }, { key: 'Z' }, { key: 'B', phase: 'judgment' }, { key: 'D', deps: ['B'] }, { key: 'E', deps: ['Y'] }]);
  const J = await settleAll(dir);
  assert.ok(J.ship_ready.Y && J.ship_ready.Z && J.ship_ready.E, JSON.stringify(J.ship_ready));
  assert.equal(J.blocked.X, undefined, 'an owner stop parks X (recomputed every tick), it is not a failure');
  assert.equal(count(dir, (e) => e.ticket === 'X'), 0);
  assert.equal(J.blocked.B.code, 'node_failed');
  assert.equal(count(dir, (e) => e.ticket === 'D'), 0, 'the dependent of a Blocked ticket never starts');
});

test('authority: a terminal review needs an owner RETRY -> refused, Blocked; an RCA proposing SECURITY_WAIVER -> refused, Blocked; others continue', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'terminal' },
    { key: 'T2', phase: 'confirmation_fail', chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'FAIL' }, { review_execution: 'rx-1', kind: 'repair' }, { review_execution: 'rx-1', kind: 'confirmation', outcome: 'FAIL' }],
      behaviour: { rca: { hypothesis: 'h', evidence: ['e'], differs: 'd', path: 'succession', authority: ['SECURITY_WAIVER'] } } },
    { key: 'T3' }]);
  const J = await settleAll(dir);
  assert.equal(J.blocked.T1.code, 'authority_required');
  assert.equal(J.blocked.T1.needs, 'RETRY');
  assert.equal(J.blocked.T2.code, 'authority_required');
  assert.equal(J.blocked.T2.needs, 'SECURITY_WAIVER');
  assert.ok(J.ship_ready.T3);
  assert.ok(!JSON.stringify(J).match(/"event":"(START|DAG_BOUND|RETRY|UNIT_CLEAR|SECURITY_ADDENDUM|SECURITY_WAIVER|TEST_KIND_WAIVER)"/), 'no authority event in the journal');
});

test('two failed rounds -> RCA -> a different evidence-backed path (succession, PR-4b refused -> Blocked); no third review (§14.4 #9)', { skip: SKIP }, async (t) => {
  const different = { hypothesis: 'the fixture seeds stale data', evidence: ['log line 12'], differs: 'reseed the fixture instead of patching the parser', path: 'succession' };
  const dir = world(t, [{ key: 'T1', behaviour: { outcomes: { original: 'FAIL', confirmation: 'FAIL' }, rca: different } }, { key: 'T2' }]);
  const J = await settleAll(dir);
  assert.equal(failedRounds(readState(dir, 'T1')), 2);
  assert.equal(count(dir, (e) => e.ticket === 'T1' && e.kind === 'agent' && e.leg === 'primary'), 2, 'original + confirmation: no third review');
  assert.equal(count(dir, (e) => e.ticket === 'T1' && e.kind === 'agent' && e.leg === 'rca'), 1, 'one RCA');
  assert.equal(J.blocked.T1.code, 'succession_unavailable');
  assert.deepEqual(J.blocked.T1.rca, different, 'the RCA record (what differs and why) is attached');
  assert.ok(J.ship_ready.T2, 'independent ticket continued, no owner interruption');
  // with a succession executor (PR-4b) the different path proceeds; a same-approach RCA is Blocked instead
  const dir2 = world(t, [{ key: 'T1', behaviour: { outcomes: { original: 'FAIL', confirmation: 'FAIL' }, rca: different } }]);
  const calls = [];
  const J2 = await settleAll(dir2, { succeed: async (tk, rec) => { calls.push([tk.key, rec.differs]); return { generation: 2 }; } });
  assert.deepEqual(calls, [['T1', different.differs]]);
  assert.equal(J2.blocked.T1, undefined);
  const dir3 = world(t, [{ key: 'T1', behaviour: { outcomes: { original: 'FAIL', confirmation: 'FAIL' }, rca: { hypothesis: 'h', evidence: [], differs: 'retry the same patch', path: 'succession' } } }]);
  assert.equal((await settleAll(dir3)).blocked.T1.code, 'recovery_no_different_path');
});

test('never drive or repair while a review op of that ticket is live', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { slow: { primary: 'hang' } } }]);
  await tick(opts(dir), worldDeps(dir));
  const S = readState(dir, 'T1'); S.phase = 'repair_owed'; writeState(dir, 'T1', S); // the engine would now ask for a drive
  for (let i = 0; i < 3; i++) assert.equal((await tick(opts(dir), worldDeps(dir))).out.tickets.T1.skipped, 'op_live');
  assert.equal(count(dir, (e) => e.kind === 'drive'), 0);
});

// ------------------------------------------------------------------------------------------------- deadlines, sweep, non-overlap

test('a hung drive is killed at its persisted bound by the sweep; the next tick records it timed out and does not re-run it', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'hang' } }]);
  await tick(opts(dir), worldDeps(dir));
  const op = Object.values(journal(dir).ops).find((o) => o.op === 'drive');
  await waitFor(() => count(dir, (e) => e.kind === 'drive') === 1, 'drive started');
  assert.ok(alive(op.pgid));
  const within = await sweep(opts(dir), worldDeps(dir));
  assert.equal(within.out.ops[op.op_id], 'within_bound');
  setClock(dir, 1000000000 + (DRIVE_BOUND_MS + 1) * 1e6);
  const s = await sweep(opts(dir), worldDeps(dir));
  assert.equal(s.out.ops[op.op_id], 'killed');
  assert.equal(s.out.settlement, 'recorded');
  assert.equal(alive(op.pgid), false);
  await tick(opts(dir), worldDeps(dir));
  const J = journal(dir);
  assert.equal(J.ops[op.op_id].result.outcome, 'timed_out');
  await ticks(dir, 2);
  assert.equal(count(dir, (e) => e.kind === 'drive'), 1, 'no blind re-run: the same engine state is no progress');
  assert.equal(journal(dir).blocked.T1.code, 'no_progress');
});

test('the sweep runs and enforces while a tick hangs holding the journal lock; it kills the tick at its bound; ticks never overlap', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1' }]);
  const hung = spawn(process.execPath, [HELPER, 'tick', dir, 'after-tick-start:1 hang'], { env: { ...process.env, SUP_WORLD: dir }, stdio: 'ignore' });
  t.after(() => { try { hung.kill('SIGKILL'); } catch { /* gone */ } });
  await waitFor(() => existsSync(join(dir, 'hung')), 'tick hung');
  const busy = await tick(opts(dir), worldDeps(dir));
  assert.equal(busy.out.outcome, 'busy', 'a second tick while one runs does nothing');
  assert.equal(effects(dir).length, 0);
  const s1 = await sweep(opts(dir), worldDeps(dir));
  assert.equal(s1.out.tick, 'within_bound');
  assert.deepEqual(Object.keys(s1.out.reconcile), ['T1'], 'reconcile --deadlines ran per run while the tick held the lock');
  setClock(dir, 1000000000 + (TICK_BOUND_MS + 1) * 1e6);
  const s2 = await sweep(opts(dir), worldDeps(dir));
  assert.equal(s2.out.tick, 'killed');
  await waitFor(() => hung.exitCode !== null || hung.signalCode !== null, 'hung tick gone');
  setClock(dir, 1000000000);
  const J = await settleAll(dir); // the dead tick's lock is recovered (dead pid); the wave resumes from persisted state
  assert.ok(J.ship_ready.T1);
});

test('production sweep: the D5 measurement is unqualified, so nothing is measured or signalled (no clock is accepted)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'hang' } }]);
  await tick(opts(dir), worldDeps(dir, { armClock: undefined }));
  const s = await sweep(opts(dir), worldDeps(dir, { sweepClock: undefined }));
  assert.match(s.out.measurement, /^unqualified/);
  assert.deepEqual(Object.values(s.out.ops), ['unmeasured']);
  await assert.rejects(sweep(opts(dir), worldDeps(dir, { sweepClock: { bootId: 'x', nowNs: () => 0n } })), /deadline_clock_refused/);
});

test('admission held: nothing ran, re-tried under a derived generation (not a duplicate effect, not no-progress)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'held' } }]);
  await settleAll(dir, {}, 4).catch(() => {});
  const ops = Object.values(journal(dir).ops).filter((o) => o.op === 'drive');
  assert.ok(ops.length >= 2 && ops.every((o) => o.result?.outcome === 'held' || o.state !== 'recorded'), JSON.stringify(ops.map((o) => [o.gen, o.result])));
  assert.deepEqual(ops.map((o) => o.gen).slice(0, 2), ['s1', 's1.h1']);
});

// ------------------------------------------------------------------------------------------------- launchd templates

test('install/uninstall: print by default; --write touches only two LaunchAgents plists; no KeepAlive, no log paths, never launchctl', { skip: SKIP }, (t) => {
  const dir = world(t, [{ key: 'T1' }]);
  const home = join(dir, 'home & <h>');
  const d = installPlan({ manifestPath: join(dir, 'manifest.json'), stateDir: join(dir, 'journal'), home }, worldDeps(dir));
  assert.equal(d.out.outcome, 'dry_run');
  assert.equal(existsSync(join(home, 'Library')), false, 'a dry run writes nothing');
  assert.deepEqual(d.out.jobs.map((j) => j.label), [`com.ai-skills.ship-ticket.supervisor.${WAVE_ID}.tick`, `com.ai-skills.ship-ticket.supervisor.${WAVE_ID}.sweep`]);
  for (const j of d.out.jobs) {
    assert.ok(!j.xml.includes('KeepAlive') && !j.xml.includes('StandardOutPath') && !j.xml.includes('StandardErrorPath'));
    assert.match(j.xml, /<key>StartInterval<\/key><integer>\d+<\/integer>/);
    assert.match(j.xml, /<key>AbandonProcessGroup<\/key><true\/>/);
    assert.ok(j.xml.includes(`<string>${process.execPath}</string>`), 'absolute node path');
    assert.ok(j.xml.includes('home &amp; &lt;h&gt;') && !j.xml.includes('home & <h>'), 'XML-escaped HOME');
    assert.match(j.xml, /<key>PATH<\/key><string>[^<]*\/usr\/bin/);
    assert.match(j.xml, /<key>WorkingDirectory<\/key>/);
    assert.ok(j.xml.includes(`<string>${j.job}</string>`) && j.xml.includes('<string>--state-dir</string>'));
  }
  assert.ok(d.out.owner_commands.every((c) => c.startsWith('launchctl bootstrap gui/')), 'the bootstrap is printed for the owner, not run');
  const w = installPlan({ manifestPath: join(dir, 'manifest.json'), stateDir: join(dir, 'journal'), home, write: true }, worldDeps(dir));
  assert.equal(w.out.outcome, 'written');
  assert.deepEqual(readdirSync(join(home, 'Library', 'LaunchAgents')).sort(), d.out.jobs.map((j) => `${j.label}.plist`).sort());
  const plutil = spawnSync('plutil', ['-lint', ...w.out.jobs.map((j) => j.path)], { encoding: 'utf8' });
  if (plutil.status !== null && process.platform === 'darwin') assert.equal(plutil.status, 0, plutil.stdout + plutil.stderr);
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'other.plist'), 'x');
  installPlan({ manifestPath: join(dir, 'manifest.json'), stateDir: join(dir, 'journal'), home, remove: true, write: true }, worldDeps(dir));
  assert.deepEqual(readdirSync(join(home, 'Library', 'LaunchAgents')), ['other.plist'], 'uninstall removes only its own two labels');
  assert.ok(plistXml({ waveId: 'W', job: 'tick', manifestPath: '/m', stateDir: '/s', home: '/h', workdir: '/w' }).includes('<string>/m</string>'));
});
