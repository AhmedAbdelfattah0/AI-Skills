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
import { makeWorld, worldDeps, opts, effects, journal, readState, writeState, setClock, WAVE_ID, CODEX_ROUTE, FABLE_ROUTE } from './supervisor.test-helper.mjs';
import * as SUP from './supervisor.mjs';
import { prepareAgentTask } from './carrier.mjs';
import { startLauncher as realStartLauncher } from './engine-io.mjs';
import { waitFor } from './test-wait.test-helper.mjs';
import { fixture, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { acquireLock } from './lib/durable-io.mjs';

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
const live = (o) => o.state !== 'recorded';
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
  assert.deepEqual(ENGINE_COMMANDS, ['drive', 'gate red', 'gate reassess', 'gate ship-ready', 'gate review', 'reconcile']);
  const t = { key: 'T1', worktree: '/w', run_id: 'r' };
  for (const bad of ['init', 'mark', 'archive', 'adopt', 'rebind', 'clear-unit', 'resume', 'gate unit-review', 'gate prove', 'succeed']) assert.throws(() => engineArgv(bad, t), /command_refused/, bad);
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
  // original: primary, second, reconcile; confirmation: primary, second (no reconciliation); then one RCA
  assert.deepEqual(agents.map((a) => a.leg).sort(), ['primary', 'primary', 'rca', 'reconcile', 'second', 'second']);
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

const BOUNDARIES = ['after-tick-start', 'after-intent', 'after-receipt', 'after-pid', 'after-release', 'after-acted'];
/** A wave whose run reaches every op kind: T1 drive -> review (FAIL) -> repair drive -> confirmation (FAIL) -> RCA -> succeed; T2 the PASS path to gate ship-ready. */
const FULL = () => [{ key: 'T1', behaviour: { outcomes: { original: 'FAIL', confirmation: 'FAIL' }, rca: { hypothesis: 'h', evidence: ['e'], differs: 'd', path: 'succession' } } }, { key: 'T2' }];
const tally = (dir) => { const m = {}; for (const e of effects(dir)) { const k = `${e.ticket}:${kindOf(e)}`; m[k] = (m[k] ?? 0) + 1; } return m; };
test('kill -9 at every hit of every act boundary across a full wave: 0 duplicate effects, or the op is preserved ambiguous (never replayed)', { skip: SKIP, timeout: 1800000 }, async (t) => {
  const base = world(t, FULL());
  const B = await settleAll(base);
  const baseline = tally(base);
  assert.equal(B.blocked.T1.code, 'succession_unavailable');
  assert.ok(B.ship_ready.T2);
  const kinds = new Set(Object.values(B.ops).map((o) => o.op));
  for (const k of ['drive', 'review.primary', 'review.second', 'review.reconcile', 'review', 'confirmation.primary', 'confirmation.second', 'confirmation', 'rca', 'succeed', 'gate.ship-ready'])
    assert.ok(kinds.has(k), `the wave reaches op ${k}`);
  const landed = {};
  for (const b of BOUNDARIES) {
    for (let n = 1; ; n++) {
      const dir = world(t, FULL());
      let killed = false;
      for (let i = 0; i < 30 && !killed; i++) {
        await waitLive(dir);
        const r = child(dir, 'tick', `${b}:${n} kill`);
        killed = r.signal === 'SIGKILL';
        assert.ok(killed || r.status === 0, `${b}:${n} tick ${i}: ${r.status} ${r.stderr}`);
        if (!killed && journal(dir) && (() => { const J = journal(dir); return J.ship_ready.T2 && J.blocked.T1 && !Object.values(J.ops).some(live); })()) break;
      }
      if (!killed) { assert.ok(n > 1, `${b} is never reached`); landed[b] = n - 1; rmSync(dir, { recursive: true, force: true }); break; }
      const J = await settleAll(dir);
      const got = tally(dir);
      for (const [k, c] of Object.entries(got)) assert.ok(c <= (baseline[k] ?? 0), `${b}:${n}: ${k} ran ${c} times, ${baseline[k] ?? 0} without a crash`);
      for (const key of ['T1', 'T2']) {
        const same = key === 'T2' ? Boolean(J.ship_ready.T2) : J.blocked.T1?.code === 'succession_unavailable';
        if (same) continue;
        assert.equal(J.blocked[key]?.code, 'ambiguous_unresolved', `${b}:${n} ${key}: ${JSON.stringify(J.blocked[key] ?? J.ship_ready[key])}`);
        assert.equal(J.ops[J.blocked[key].op_id].state, 'ambiguous', 'the uncertain op is preserved, never replayed');
      }
      killWorld(dir); rmSync(dir, { recursive: true, force: true });
    }
  }
  // every boundary was killed at least once, at every one of its hits
  for (const b of BOUNDARIES) assert.ok(landed[b] >= 1, `${b}: ${landed[b]}`);
  t.diagnostic(`kills landed per boundary: ${JSON.stringify(landed)}`);
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
  // later sessions: the one that releases the collect (`gate review`, a detached launch) dies before recording it.
  // only these hooked sessions count release hits: the reconcile leg's release is hit 1, the collect's hit 2.
  let killed = false;
  for (let i = 0; i < 10 && !killed; i++) { await waitLive(dir); killed = child(dir, 'tick', 'after-release:2 kill').signal === 'SIGKILL'; }
  assert.ok(killed, 'a session died between releasing gate review and its record');
  const c = journal(dir).ops['rtest:T1:review:rx-1'];
  assert.equal(c.state, 'intent', 'released, pid persisted, never recorded');
  assert.ok(c.pid && c.pgid && c.leader_start && c.deadline && c.collect);
  const J = await settleAll(dir);
  assert.equal(count(dir, (e) => e.kind === 'gate review'), 1, 'gate review ran once');
  assert.equal(J.ops['rtest:T1:review:rx-1'].result.outcome, 'collected', 'settled from the engine chain, never re-run');
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
  assert.equal(J.blocked.B, undefined, 'an engine judgment is parked (the engine owns it), not journal-Blocked');
  assert.equal(count(dir, (e) => e.ticket === 'D'), 0, 'the dependent of a parked ticket never starts');
  // a journal-Blocked ticket (the supervisor's own dead end) also holds only its dependents
  const dir2 = world(t, [{ key: 'A', phase: 'review_owed', behaviour: { fail_primary: true } }, { key: 'C', deps: ['A'] }, { key: 'F' }]);
  const J2 = await settleAll(dir2);
  assert.equal(J2.blocked.A.code, 'review_leg_failed');
  assert.equal(count(dir2, (e) => e.ticket === 'C'), 0);
  assert.ok(J2.ship_ready.F);
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
  const t2 = await tick(opts(dir), worldDeps(dir));
  const J = journal(dir);
  // the killed drive recorded nothing in the engine: nothing ran, so it is re-tried under a derived generation (bounded)
  assert.equal(J.ops[op.op_id].result.outcome, 'nothing_ran');
  assert.ok(J.ops[op.op_id].result.timed_out, 'the bound that killed it is kept');
  assert.equal(t2.out.tickets.T1.launched.op_id, `${op.op_id}.r1`);
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

test('admission held: nothing ran, re-tried under a derived generation (not a duplicate effect, not no-progress); a hold never Blocks', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'held' } }, { key: 'T2', phase: 'review_owed', behaviour: { 'gate review': 'held' } }, { key: 'T3' }]);
  let now = 1e12;
  const over = { now: () => now };
  // far more holds than any count limit: every attempt is paced, none is final, no ticket is Blocked
  // each tick 31 minutes later (above the longest pacing wait): a hold is settled on one tick and re-attempted on the next
  for (let i = 0; i < 70; i++) { await waitLive(dir); await tick(opts(dir), worldDeps(dir, over)); await waitLive(dir); now += 31 * 60 * 1000; }
  const J = journal(dir);
  const drives = Object.values(J.ops).filter((o) => o.ticket === 'T1' && o.op === 'drive');
  assert.deepEqual(drives.map((o) => o.gen).slice(0, 2), ['s1', 's1.r1']);
  assert.ok(drives.length > 31 && drives.every((o) => o.result?.outcome === 'held' || o.state !== 'recorded'), JSON.stringify(drives.map((o) => [o.gen, o.result])));
  // a held `gate review` (collect) is `held`, never counted as nothing-ran
  const collects = Object.values(J.ops).filter((o) => o.ticket === 'T2' && o.op === 'review');
  assert.ok(collects.length > 4, `${collects.length} collect attempts`);
  assert.ok(collects.every((o) => o.result?.outcome === 'held' || o.state !== 'recorded'), JSON.stringify(collects.map((o) => o.result)));
  assert.deepEqual(J.blocked, {}, 'an admission hold is never a Block');
  assert.ok(J.ship_ready.T3, 'independent work continued');
  // pacing bounds the journal: once a hold is settled, ticks at the same instant add no attempt (and never Block)
  for (let i = 0; i < 2; i++) { await waitLive(dir); await tick(opts(dir), worldDeps(dir, over)); await waitLive(dir); }
  const n = Object.keys(journal(dir).ops).length;
  for (let i = 0; i < 3; i++) {
    const r = await tick(opts(dir), worldDeps(dir, over));
    assert.equal(r.out.tickets.T1?.held, 'admission', JSON.stringify(r.out.tickets.T1));
    assert.equal(r.out.tickets.T1.long_hold, true, 'a day-long hold is flagged for the owner, still not Blocked');
    assert.ok(r.out.tickets.T1.retry_after_ms > 0 && r.out.tickets.T1.retry_after_ms <= SUP.HOLD_RETRY_MAX_MS);
  }
  assert.equal(Object.keys(journal(dir).ops).length, n, 'one paced attempt per wait, not one per tick');
  assert.deepEqual(journal(dir).blocked, {});
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

// ------------------------------------------------------------------------------------------------- the real defaults

test('real engine smoke: real next/readRun, state, readTicket, run dir and repo id; the drive output closes the --last loop to REVIEW', { skip: SKIP, timeout: 300000 }, async (t) => {
  const fx = fixture(t, { commit: true, config: { modelMap: { strong: 'claude-strong-x' }, testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } } });
  const init = fx.cli('init', { dag: fx.dagFile });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const manifest = { schema: 'ship-ticket-wave-v1', wave_id: 'W-R', endpoint: 'SHIP_READY', heavy_slots: 1, review_routes: [CODEX_ROUTE],
    tickets: [{ key: 'T-1', plan: '.specs/plans/T-1.md', run_id: 'run-1', worktree: fx.repo, branch: 'main', deps: [], dep_mode: 'ship_ready', resources: [] }] };
  const D = 'sha256:' + '1'.repeat(64);
  const deps = { verifyWave: () => ({ ok: true, digest: D }), readManifest: () => ({ ok: true, manifest, digest: D, problems: [] }),
    admitted: (argv) => ({ file: argv[0], args: argv.slice(1), shell: false }), // PR-2 seam re-pointed: the engine itself, no host-admit
    env: fx.env, verifySubscription: () => true,
    agentSpec: () => ({ file: process.execPath, args: ['-e', ''], shell: false }) };
  const o = { manifestPath: join(fx.root, 'W-R.wave.json'), stateDir: join(fx.root, 'journal') };
  const J = () => JSON.parse(readFileSync(join(o.stateDir, 'W-R', 'journal.json'), 'utf8'));
  const seq0 = JSON.parse(readFileSync(fx.stateFile(), 'utf8')).seq;
  const t1 = await tick(o, deps);
  assert.equal(t1.code, 0, JSON.stringify(t1.out));
  const drive = Object.values(J().ops).find((x) => x.op === 'drive');
  assert.ok(drive, `the real next named drive: ${JSON.stringify(t1.out.tickets)}`);
  assert.equal(drive.gen, `s${seq0}`, 'the op id generation is the real engine seq');
  await waitFor(() => existsSync(drive.files.envelope), 'the real drive finished');
  const t2 = await tick(o, deps);
  assert.equal(J().ops[drive.op_id].result.outcome, 'ran');
  assert.ok(JSON.parse(readFileSync(fx.stateFile(), 'utf8')).seq > seq0, 'the real drive moved the engine seq');
  assert.deepEqual(t2.out.tickets['T-1'].dispatched?.map((x) => x.op_id.split(':')[2]), ['review.primary', 'review.second'],
    `the drive output was accepted as --last and the next step is the review: ${JSON.stringify(t2.out.tickets)}`);
  for (const leg of Object.values(J().ops).filter((x) => x.op.startsWith('review.'))) await waitFor(() => existsSync(leg.files.envelope), leg.op_id);
  await tick(o, deps);
  assert.equal(J().blocked['T-1'].code, 'second_opinion_unavailable', 'the stand-in reviewers wrote nothing (the only approved route is unusable): Blocked, never a gate call');
});

// ------------------------------------------------------------------------------------------------- PR-5 review round 1 repairs

test('nothing ran is never final: a lock_held drive is re-tried (derived generation) and completes; a persistent one Blocks naming the op', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'lock_once' } }, { key: 'T2', behaviour: { drive: 'lock' } }, { key: 'T3' }]);
  const J = await settleAll(dir);
  assert.ok(J.ship_ready.T1, 'the collision is retried, not parked no_progress');
  assert.equal(J.ops['rtest:T1:drive:s1'].result.outcome, 'nothing_ran');
  assert.equal(J.ops['rtest:T1:drive:s1.r1'].result.outcome, 'ran');
  assert.equal(J.blocked.T2.code, 'retries_exhausted');
  assert.match(J.blocked.T2.op_id, /drive:s1\.r3$/);
  assert.ok(J.ship_ready.T3);
});

test('the reconciled input is restricted to the review gate fields; an actionable FAIL carries the supervisor-owned repair brief', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { extra_key: true, outcomes: { original: 'FAIL' } } }]);
  const J = await settleAll(dir);
  const S = readState(dir, 'T1');
  assert.deepEqual(S.review_chain.map((r) => [r.kind, r.outcome]).slice(0, 1), [['original', 'FAIL']], 'no bad_input, no repair_prompt_missing');
  const input = JSON.parse(readFileSync(J.ops['rtest:T1:review:rx-1'].files.input, 'utf8'));
  assert.equal(input.notes, undefined, 'an unknown key never reaches the gate');
  assert.match(readFileSync(input.repair_prompt_file, 'utf8'), /^NODE=repair-rx-1\n[\s\S]*primary f1/);
});

test('a ticket whose plan binding fails later is parked alone; a wave never STARTS partially bound', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1' }, { key: 'T2' }]);
  const base = worldDeps(dir);
  const partial = { verifyWave: () => ({ ok: false, code: 'wave_unapproved', digest: base.verifyWave().digest, unlisted: [], tickets: { T1: { ok: false, reason: 'plan_unreadable' }, T2: { ok: true } } }) };
  const first = await tick(opts(dir), worldDeps(dir, partial));
  assert.equal(first.out.code, 'wave_unapproved', 'the first tick needs the whole wave bound');
  await tick(opts(dir), worldDeps(dir)); // a fully bound first tick
  const J = await settleAll(dir, partial);
  assert.ok(J.ship_ready.T2, 'the bound ticket continued');
  assert.equal(J.ship_ready.T1, undefined);
  assert.equal(count(dir, (e) => e.ticket === 'T1' && e.kind !== 'drive'), 0, 'the unbound ticket took no new step');
});

test('an envelope alone is not terminal: a launch whose group still has a live member stays unsettled, then Blocks (bounded)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'linger' } }, { key: 'T2' }]);
  const J = await settleAll(dir);
  const d = J.ops['rtest:T1:drive:s1'];
  assert.ok(existsSync(d.files.envelope));
  assert.notEqual(d.state, 'recorded');
  assert.equal(J.blocked.T1.code, 'group_not_quiescent');
  assert.ok(J.ship_ready.T2);
});

test('install --write says the written plists activate at the next login', { skip: SKIP }, (t) => {
  const dir = world(t, [{ key: 'T1' }]);
  const home = join(dir, 'h');
  const o = { manifestPath: join(dir, 'manifest.json'), stateDir: join(dir, 'journal'), home };
  assert.match(installPlan(o, worldDeps(dir)).out.note, /activates the jobs at the next login/);
  assert.match(installPlan({ ...o, write: true }, worldDeps(dir)).out.note, /NEXT LOGIN/);
});

// real engine: the run lock and the real review gate (the fake engine models neither)
function realWave(t, config = {}, behaviour = undefined) {
  const fx = fixture(t, { commit: true, config: { modelMap: { strong: 'claude-strong-x' }, testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } }, ...config },
    ...(behaviour ? { behaviour } : {}) });
  const init = fx.cli('init', { dag: fx.dagFile });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const manifest = { schema: 'ship-ticket-wave-v1', wave_id: 'W-R', endpoint: 'SHIP_READY', heavy_slots: 1, review_routes: [CODEX_ROUTE],
    tickets: [{ key: 'T-1', plan: '.specs/plans/T-1.md', run_id: 'run-1', worktree: fx.repo, branch: 'main', deps: [], dep_mode: 'ship_ready', resources: [] }] };
  const D = 'sha256:' + '1'.repeat(64);
  const arts = join(fx.root, 'arts');
  spawnSync('mkdir', ['-p', arts]);
  const agent = join(fx.root, 'agent.cjs');
  writeFileSync(agent, `const fs = require('node:fs'); let p = ''; process.stdin.on('data', (c) => { p += c; }); process.stdin.on('end', () => {
    const leg = /leg (\\w+)/.exec(p)?.[1] || 'rca', kind = /# ship-ticket (\\w+) review/.exec(p)?.[1] || 'rca';
    const f = ${JSON.stringify(arts)} + '/' + leg + '-' + kind + '.json';
    const out = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : JSON.stringify({ hypothesis: 'h', evidence: [], differs: '', path: 'blocked' });
    // each provider's final-message shape (the second opinion runs on the manifest's codex route)
    process.stdout.write(process.argv[2] === 'codex' ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: out } }) + '\\n'
      : JSON.stringify({ type: 'result', is_error: false, result: out })); });`);
  const deps = { verifyWave: () => ({ ok: true, digest: D }), readManifest: () => ({ ok: true, manifest, digest: D, problems: [] }),
    admitted: (argv) => ({ file: argv[0], args: argv.slice(1), shell: false }), env: fx.env, verifySubscription: () => true,
    agentSpec: (plan) => ({ file: process.execPath, args: [agent, plan.provider], shell: false }) };
  const o = { manifestPath: join(fx.root, 'W-R.wave.json'), stateDir: join(fx.root, 'journal') };
  const J = () => JSON.parse(readFileSync(join(o.stateDir, 'W-R', 'journal.json'), 'utf8'));
  const S = () => JSON.parse(readFileSync(fx.stateFile(), 'utf8'));
  const art = (name, v) => writeFileSync(join(arts, `${name}.json`), JSON.stringify(v));
  /** Tick, then wait until no launched op is running; `until(J)` ends it. */
  const run = async (until, max = 30) => {
    let lastOut = null;
    for (let i = 0; i < max; i++) {
      const r = await tick(o, deps);
      lastOut = r.out.tickets;
      for (const x of Object.values(J().ops)) if (x.kind === 'launch' && x.state !== 'recorded' && x.pgid) await waitFor(() => existsSync(x.files.envelope) || !alive(x.pgid), x.op_id);
      if (until(J(), r)) return r;
    }
    throw new Error(`not reached: ${JSON.stringify({ gates: S().events.filter((e) => e.type === 'GATE'), chain: S().review_chain, blocked: J().blocked, last: lastOut, ops: Object.values(J().ops).map((x) => [x.op_id, x.state, x.result, x.last_probe]) })}`);
  };
  return { fx, deps, o, J, S, art, run };
}
const lockOf = (fx) => acquireLock({ lockFile: fx.lockFile(), runId: 'run-1', repoRoot: fx.repo, ticket: 'T-1' });

test('real run lock held (as the sweep reconcile holds it): the drive records nothing_ran, is re-tried after release, and the loop reaches the review', { skip: SKIP, timeout: 300000 }, async (t) => {
  const w = realWave(t);
  const held = await lockOf(w.fx);
  await w.run((J) => Object.values(J.ops).some((x) => x.op === 'drive' && x.state === 'recorded'));
  const first = Object.values(w.J().ops).find((x) => x.op === 'drive');
  assert.equal(first.result.outcome, 'nothing_ran', JSON.stringify(first.result));
  await held.release();
  const r = await w.run((J) => Object.values(J.ops).some((x) => x.op === 'review.primary'));
  assert.ok(Object.values(w.J().ops).some((x) => x.op === 'drive' && x.result?.outcome === 'ran'), 'the retried drive ran');
  assert.equal(w.J().blocked['T-1'], undefined);
  void r;
});

test('real gate: FAIL -> supervisor repair brief -> repair_owed -> repair -> confirmation FAIL -> RCA; a collect under a held run lock is re-collected once', { skip: SKIP, timeout: 600000 }, async (t) => {
  const w = realWave(t, {}, { a: { write: { 'src/a.txt': 'a1' } }, 'repair-rx-1': { write: { 'src/a.txt': 'fixed' } } });
  await w.run((J) => Object.values(J.ops).some((x) => x.op === 'drive')); // returns once the drive has finished, before its settle
  const c1 = w.fx.candidate();
  const p1 = primaryReview(c1, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }], acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: 'src/a.txt' }] });
  const s1 = secondOpinion(c1);
  w.art('primary-original', p1);
  w.art('second-original', s1);
  // the supervisor stamps the second opinion's route and identity from what it launched: the reconciler echoes the stamped artifact
  const s1Stamped = { ...s1, route: 'codex:codex-strong-x', reviewer_identity: 'codex:codex-strong-x' };
  w.art('reconcile-original', { kind: 'original', review_execution: 'rx-1', primary: p1, second_opinion: s1Stamped, reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] } });
  await w.run((J) => Object.values(J.ops).some((x) => x.op === 'review.reconcile'));
  const held = await lockOf(w.fx); // the collect launches while the run lock is held
  await w.run((J) => Object.values(J.ops).some((x) => x.op === 'review' && x.state === 'recorded'));
  const firstCollect = Object.values(w.J().ops).find((x) => x.op === 'review');
  assert.equal(firstCollect.result.outcome, 'nothing_ran', `a lock_held gate review is not a refusal: ${JSON.stringify(firstCollect.result)}`);
  assert.equal(w.S().review_chain.length, 0);
  await held.release();
  await w.run((J) => Object.values(J.ops).some((x) => x.op === 'review' && x.result?.outcome === 'collected'));
  assert.deepEqual(w.S().review_chain.filter((r) => r.kind === 'original').map((r) => [r.review_execution, r.outcome]), [['rx-1', 'FAIL']], 'collected exactly once, accepted by the REAL gate (repair brief present)');
  assert.equal(w.S().events.filter((e) => e.type === 'GATE' && e.gate === 'review' && e.ok === false).length, 0, 'never refused (no repair_prompt_missing)');
  // the collect run returned after the next tick's repair drive finished (each tick waits for what it launched)
  if (!w.S().review_chain.some((r) => r.kind === 'repair')) await w.run(() => w.S().review_chain.some((r) => r.kind === 'repair'));
  assert.ok(Object.values(w.J().ops).every((x) => !x.op.startsWith('confirmation')), 'no confirmation leg yet');
  assert.equal(readFileSync(join(w.fx.repo, 'src', 'a.txt'), 'utf8'), 'fixed', 'the repair writer ran from the supervisor brief');
  const c2 = w.fx.candidate();
  w.art('primary-confirmation', { reviewer_identity: 'opus:review', candidate_id: c2, checked_findings: ['F1'], outcome: 'FAIL', evidence: 'F1 still reproduces' });
  w.art('second-confirmation', { route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: c2, checked_findings: ['F1'], outcome: 'FAIL', evidence: 'x' });
  await w.run((J) => Object.values(J.ops).some((x) => x.op === 'rca'));
  assert.deepEqual(w.S().review_chain.map((r) => [r.kind, r.outcome ?? null]), [['original', 'FAIL'], ['repair', null], ['confirmation', 'FAIL']]);
  assert.equal(Object.values(w.J().ops).filter((x) => x.op === 'review.primary' || x.op === 'confirmation.primary').length, 2, 'no third review');
});

// ------------------------------------------------------------------------------------------------- PR-5b: second-opinion routes (S7 Option A)

const routesOf = (dir) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).review_routes;
const secondLegs = (dir, key = 'T1') => effects(dir).filter((e) => e.kind === 'agent' && e.leg === 'second' && e.ticket === key);

test('second opinion: the first manifest route runs (Codex), stamped from the launch, recorded cross-provider; its bound is the 10-minute budget', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed' }]);
  const J = await settleAll(dir);
  assert.ok(J.ship_ready.T1, JSON.stringify(J.blocked));
  assert.equal(SUP.SECOND_OPINION_BUDGET_MS, 10 * 60 * 1000);
  const so = J.ops['rtest:T1:review.second:rx-1'];
  assert.equal(so.bound_ms, SUP.SECOND_OPINION_BUDGET_MS, 'one attempt, on the policy budget');
  assert.deepEqual(so.requested, { provider: 'codex', model: 'codex-strong-x' });
  assert.deepEqual(so.launched, { provider: 'codex', model: 'codex-strong-x' }, 'what the carrier adapter actually built');
  const c = J.ops['rtest:T1:review:rx-1'];
  assert.equal(c.second_opinion, 'codex:codex-strong-x');
  assert.equal(c.same_provider, false);
  const input = JSON.parse(readFileSync(c.files.input, 'utf8'));
  assert.equal(input.second_opinion.reviewer_identity, 'codex:codex-strong-x', 'identity stamped from the launch, not self-reported');
  assert.equal(input.second_opinion.route, 'codex:codex-strong-x');
  assert.equal(secondLegs(dir).length, 1);
  // a budget_ms in the route is that route's per-attempt bound (at most the policy figure)
  const dir2 = world(t, [{ key: 'T1', phase: 'review_owed' }], { routes: [{ ...CODEX_ROUTE, budget_ms: 120000 }] });
  assert.equal((await settleAll(dir2)).ops['rtest:T1:review.second:rx-1'].bound_ms, 120000);
});

test('second opinion: Codex unavailable (nonexistent binary; a usage-limit reply) -> exactly ONE attempt on the next route (Fable), recorded same-provider', { skip: SKIP }, async (t) => {
  const routes = [CODEX_ROUTE, FABLE_ROUTE];
  const dir = world(t, [{ key: 'T1', phase: 'review_owed' }], { routes });
  const base = worldDeps(dir);
  const noCodex = { agentSpec: (plan, env) => (plan.provider === 'codex' ? { file: join(dir, 'no-such-codex-binary'), args: plan.args, shell: false } : base.agentSpec(plan, env)) };
  const J = await settleAll(dir, noCodex);
  const codex = J.ops['rtest:T1:review.second:rx-1'];
  assert.equal(codex.result.outcome, 'failed');
  assert.match(String(codex.result.spawn_error), /ENOENT/, 'the launcher reports the missing provider binary (a spawn error, launcher exit 127)');
  const fable = J.ops['rtest:T1:review.second-2:rx-1'];
  assert.equal(fable.result.outcome, 'ran');
  assert.deepEqual(fable.launched, { provider: 'claude', model: 'claude-fable-x' });
  assert.deepEqual(secondLegs(dir).map((e) => [e.provider, e.args.slice(-2)]), [['claude', ['--model', 'claude-fable-x']]], 'one fallback attempt');
  const c = J.ops['rtest:T1:review:rx-1'];
  assert.equal(c.second_opinion, 'claude:claude-fable-x');
  assert.equal(c.same_provider, true, 'recorded as a same-provider independent review, never as cross-provider agreement');
  assert.ok(J.ship_ready.T1);
  // a usage-limit reply (no agent message) is unusable too: one fallback attempt
  const dir2 = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { second_provider: { codex: 'usage_limit' } } }], { routes });
  const J2 = await settleAll(dir2);
  assert.deepEqual(secondLegs(dir2).map((e) => e.provider), ['codex', 'claude']);
  assert.equal(J2.ops['rtest:T1:review:rx-1'].same_provider, true);
  assert.ok(J2.ship_ready.T1);
  // the confirmation round takes the same route order
  const dir3 = world(t, [{ key: 'T1', phase: 'confirmation_owed', behaviour: { second_provider: { codex: 'fail' } } }], { routes });
  const J3 = await settleAll(dir3);
  assert.deepEqual(secondLegs(dir3).map((e) => [e.review_kind, e.provider]), [['confirmation', 'codex'], ['confirmation', 'claude']]);
  assert.equal(J3.ops['rtest:T1:confirmation:rx-1'].same_provider, true);
});

test('second opinion: both routes unusable -> ONLY that ticket is Blocked second_opinion_unavailable (no gate call, no loop); independent tickets continue', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { second_provider: { codex: 'fail', claude: 'fail' } } }, { key: 'T2' }, { key: 'T3', deps: ['T1'] }], { routes: [CODEX_ROUTE, FABLE_ROUTE] });
  const J = await settleAll(dir);
  assert.equal(J.blocked.T1.code, 'second_opinion_unavailable');
  assert.deepEqual(J.blocked.T1.attempts.map((a) => [a.op_id, a.outcome]), [['rtest:T1:review.second:rx-1', 'failed'], ['rtest:T1:review.second-2:rx-1', 'failed']]);
  assert.equal(secondLegs(dir).length, 2, 'one attempt per route');
  assert.equal(count(dir, (e) => e.kind === 'gate review' && e.ticket === 'T1'), 0);
  assert.ok(J.ship_ready.T2, 'the independent ticket continued');
  assert.equal(count(dir, (e) => e.ticket === 'T3'), 0, 'only the dependent holds');
  const n = effects(dir).length;
  await ticks(dir, 3);
  assert.equal(effects(dir).length, n, 'no loop: nothing more is attempted');
});

test('second opinion provenance: a launched model that differs from the requested route is refused (never a pass, never a fallback)', { skip: SKIP }, async (t) => {
  // (a) the carrier adapter built another model than the approved route names
  const dir = world(t, [{ key: 'T1', phase: 'review_owed' }, { key: 'T2' }], { routes: [CODEX_ROUTE, FABLE_ROUTE] });
  const drift = { prepareAgent: (cfg) => { const p = prepareAgentTask(cfg); return cfg.provider === 'codex' && cfg.workdir.endsWith('/T1') ? { ...p, model: 'codex-other', args: [...p.args.slice(0, -2), 'codex-other', '-'] } : p; } };
  const J = await settleAll(dir, drift);
  assert.equal(J.blocked.T1.code, 'second_opinion_provenance_mismatch', JSON.stringify(J.blocked.T1));
  assert.equal(secondLegs(dir).length, 0, 'nothing was launched on the drifted route');
  assert.equal(J.ops['rtest:T1:review.second-2:rx-1'], undefined, 'a mismatch is a refusal, not a reason to try the next route');
  assert.equal(count(dir, (e) => e.kind === 'gate review' && e.ticket === 'T1'), 0);
  assert.ok(J.ship_ready.T2);
  // (b) the provider reports it served another model than the one requested
  const dir2 = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { report_model: { second: 'claude-other-model' } } }], { routes: [FABLE_ROUTE] });
  const J2 = await settleAll(dir2);
  assert.equal(J2.blocked.T1.code, 'second_opinion_provenance_mismatch', JSON.stringify(J2.blocked.T1));
  assert.match(J2.blocked.T1.reason, /claude-other-model/);
  assert.equal(count(dir2, (e) => e.kind === 'gate review'), 0);
  // the reported model matching the request passes
  const dir3 = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { report_model: { second: 'claude-fable-x' } } }], { routes: [FABLE_ROUTE] });
  assert.ok((await settleAll(dir3)).ship_ready.T1);
});

test('wave validation: an unknown provider, a missing second_opinion route or a budget above the policy is refused before any effect', { skip: SKIP }, async (t) => {
  const cases = [
    [[{ role: 'second_opinion', provider: 'nosuch', model: 'm' }], 'review_route_provider_unknown'],
    [[{ role: 'second_opinion', provider: 'gemini', model: 'm' }], 'review_route_provider_unknown'], // a carrier provider without a verified adapter
    [[{ role: 'primary', provider: 'claude', model: 'm' }], 'second_opinion_route_missing'],
    [null, 'second_opinion_route_missing'],
    [[{ ...CODEX_ROUTE, budget_ms: SUP.SECOND_OPINION_BUDGET_MS + 1 }], 'second_opinion_budget_invalid'],
  ];
  for (const [routes, code] of cases) {
    const dir = world(t, [{ key: 'T1' }], { routes });
    const r = await tick(opts(dir), worldDeps(dir));
    assert.equal(r.code, 2, JSON.stringify(routes));
    assert.equal(r.out.code, code, JSON.stringify(r.out));
    assert.equal(effects(dir).length, 0);
  }
  // other roles are optional and ignored (no effect on routing)
  const dir = world(t, [{ key: 'T1', phase: 'review_owed' }], { routes: [{ role: 'primary', provider: 'codex', model: 'x' }, CODEX_ROUTE] });
  assert.ok((await settleAll(dir)).ship_ready.T1);
});

test('a changed route list after approval is a plan change (wave_plan_changed), by the digest and by the persisted binding', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1' }], { routes: [CODEX_ROUTE] });
  assert.equal((await tick(opts(dir), worldDeps(dir))).code, 0);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, review_routes: [CODEX_ROUTE, FABLE_ROUTE] }));
  const r = await tick(opts(dir), worldDeps(dir));
  assert.equal(r.code, 2);
  assert.equal(r.out.code, 'wave_plan_changed');
  // the same digest with another route list (the binding is persisted with the wave): refused too
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  const D = worldDeps(dir).verifyWave().digest;
  const r2 = await tick(opts(dir), worldDeps(dir, { readManifest: () => ({ ok: true, manifest: { ...m, review_routes: [FABLE_ROUTE] }, digest: D, problems: [] }) }));
  assert.equal(r2.out.code, 'wave_plan_changed');
  assert.deepEqual(routesOf(dir), [CODEX_ROUTE]);
});

test('the unreleased legacy same-provider route is gone: no reference to it anywhere in the skill', () => {
  const needles = ['review' + '_second', 'secondOpinion' + 'Route', 'second_opinion_route' + '_unresolved'];
  const root = join(HERE, '..');
  const hits = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.(mjs|cjs|js|md|json)$/.test(e.name)) { const s = readFileSync(f, 'utf8'); for (const n of needles) if (s.includes(n)) hits.push(`${f}: ${n}`); }
  } };
  walk(root);
  assert.deepEqual(hits, []);
  assert.ok(readFileSync(join(HERE, 'supervisor.mjs'), 'utf8').includes('reviewRoutesOf'), 'the walk saw the supervisor source');
});

test('second-opinion budget: the sweep kills a hung Codex leg at the 10-minute bound, then exactly one fallback attempt runs', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'review_owed', behaviour: { second_provider: { codex: 'hang' } } }], { routes: [CODEX_ROUTE, FABLE_ROUTE] });
  await tick(opts(dir), worldDeps(dir));
  const codex = journal(dir).ops['rtest:T1:review.second:rx-1'];
  await waitFor(() => secondLegs(dir).length === 1, 'codex leg started');
  const within = await sweep(opts(dir), worldDeps(dir));
  assert.equal(within.out.ops[codex.op_id], 'within_bound');
  setClock(dir, 1000000000 + (SUP.SECOND_OPINION_BUDGET_MS + 1) * 1e6);
  const s = await sweep(opts(dir), worldDeps(dir));
  assert.equal(s.out.ops[codex.op_id], 'killed');
  assert.notEqual(s.out.ops['rtest:T1:review.primary:rx-1'], 'killed', 'the primary leg keeps its own bound');
  const J = await settleAll(dir);
  assert.ok(['timed_out', 'failed', 'lost'].includes(J.ops[codex.op_id].result.outcome), JSON.stringify(J.ops[codex.op_id].result));
  assert.deepEqual(secondLegs(dir).map((e) => e.provider), ['codex', 'claude']);
  assert.equal(J.ops['rtest:T1:review:rx-1'].same_provider, true);
  assert.ok(J.ship_ready.T1);
});

// ------------------------------------------------------------------------------------------------- PR-5b: classifier follow-ups (S7a/PR-2)

test('a launch that never started (fork failure, throwing admission seam) is nothing_ran: retried, never a final no_progress', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1' }, { key: 'T2' }]);
  const base = worldDeps(dir);
  let forks = 0, seams = 0;
  const over = {
    startLauncher: (o) => (o.files.outFile.includes('T1__drive') && forks++ === 0 ? { pid: undefined, on() {}, stdin: null } : realStartLauncher(o)),
    admitted: (argv) => { if (argv.includes('T2') && argv.includes('drive') && seams++ === 0) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }); return base.admitted(argv); },
  };
  const J = await settleAll(dir, over);
  assert.equal(J.ops['rtest:T1:drive:s1'].result.outcome, 'nothing_ran');
  assert.equal(J.ops['rtest:T1:drive:s1'].result.cause, 'spawn_failed');
  assert.equal(J.ops['rtest:T2:drive:s1'].result.outcome, 'nothing_ran');
  assert.equal(J.ops['rtest:T2:drive:s1'].result.cause, 'EAGAIN');
  assert.ok(J.ship_ready.T1 && J.ship_ready.T2, JSON.stringify(J.blocked));
});

test('an engine gate refusal that writes no engine event (worktree_mismatch, no_state, binding drift) is nothing_ran: retried, then Blocked naming the cause', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'ship_owed', behaviour: { 'gate ship-ready': 'refuse_noevent' } }, { key: 'T2' }]);
  const J = await settleAll(dir);
  const gates = Object.values(J.ops).filter((o) => o.ticket === 'T1' && o.op === 'gate.ship-ready');
  assert.ok(gates.every((o) => o.result.outcome === 'nothing_ran' && o.result.cause === 'worktree_mismatch'), JSON.stringify(gates.map((o) => o.result)));
  assert.equal(J.blocked.T1.code, 'retries_exhausted', 'never a permanent no_progress park');
  assert.match(J.blocked.T1.reason, /worktree_mismatch/);
  assert.ok(J.ship_ready.T2);
});

test('tick and sweep start at decorrelated offsets (jitter), so their lock collisions do not repeat in lockstep', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', phase: 'owner_stop' }]);
  const waits = { tick: [], sweep: [] };
  for (const job of ['tick', 'sweep']) for (const rnd of [0, 0.999]) {
    const r = await SUP.main([job, '--wave', join(dir, 'manifest.json'), '--state-dir', join(dir, 'journal')], { ...worldDeps(dir), random: () => rnd, sleep: async (ms) => { waits[job].push(ms); } });
    assert.equal(r.code, 0);
  }
  const { tick: T, sweep: W } = SUP.START_JITTER_MS;
  assert.deepEqual(waits.tick.map((x) => x >= T.base && x < T.base + T.spread), [true, true]);
  assert.deepEqual(waits.sweep.map((x) => x >= W.base && x < W.base + W.spread), [true, true]);
  assert.notEqual(waits.tick[0], waits.tick[1], 'the offset is random, not fixed');
  assert.ok(T.base + T.spread <= W.base && W.base + W.spread <= SUP.INTERVALS.sweep * 1000, 'the sweep starts between ticks, never at a tick start');
});

test('a sweep kill of an admitted engine command stops it THROUGH the real host-admit (signals forwarded to its group)', { skip: SKIP, timeout: 200000 }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'hang' } }]);
  const store = join(dir, 'host-store');
  const viaHostAdmit = { admitted: (argv) => ({ file: process.execPath, args: [SUP.HOST_ADMIT, 'run', '--class', 'light', '--', process.execPath, join(dir, 'fake-engine.cjs'), ...argv.slice(1)], shell: false }),
    env: { ...worldDeps(dir).env, AI_SKILLS_HOST_RESOURCES_DIR: store } };
  await tick(opts(dir), worldDeps(dir, viaHostAdmit));
  await waitFor(() => count(dir, (e) => e.kind === 'drive') === 1, 'the engine command started under host-admit');
  const enginePid = effects(dir).find((e) => e.kind === 'drive').pid;
  const op = Object.values(journal(dir).ops).find((o) => o.op === 'drive');
  assert.notEqual(enginePid, op.pid, 'the engine command is not the launcher the journal knows');
  setClock(dir, 1000000000 + (SUP.DRIVE_BOUND_MS + 1) * 1e6);
  const s = await sweep(opts(dir), worldDeps(dir, viaHostAdmit));
  assert.equal(s.out.ops[op.op_id], 'killed');
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  await waitFor(() => gone(enginePid), 'the engine command host-admit started is gone', { ms: 15000 });
});
