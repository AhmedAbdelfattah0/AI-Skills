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
import { fixture, primaryReview, secondOpinion, withOrigin, passReview } from './engine-test-fixture.mjs';
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
  // the default second-opinion route is the approved modelMap's `review_second` tier key; unresolved -> a clear refusal
  const dir3 = world(t, [{ key: 'T1', phase: 'review_owed' }]);
  const J3 = await settleAll(dir3, { secondOpinionRoute: undefined });
  assert.equal(J3.blocked.T1.code, 'second_opinion_route_unresolved');
  assert.match(J3.blocked.T1.reason, /modelMap\.review_second/);
  const dir4 = world(t, [{ key: 'T1', phase: 'review_owed' }]);
  const S4 = readState(dir4, 'T1'); S4.config.modelMap.review_second = 'claude-second-x'; writeState(dir4, 'T1', S4);
  assert.ok((await settleAll(dir4, { secondOpinionRoute: undefined })).ship_ready.T1);
  const second = effects(dir4).find((e) => e.kind === 'agent' && e.leg === 'second');
  assert.deepEqual(second.args.slice(-2), ['--model', 'claude-second-x'], 'second opinion = modelMap.review_second');
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
  assert.equal(B.blocked.T1.code, 'not_a_repo', 'PR-4b: the real succeed adapter runs the engine; this fake world has no engine run, so the engine refuses');
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
        const same = key === 'T2' ? Boolean(J.ship_ready.T2) : J.blocked.T1?.code === 'not_a_repo';
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

test('two failed rounds -> RCA -> a different evidence-backed path (succession; an engine refusal -> Blocked); no third review (§14.4 #9)', { skip: SKIP }, async (t) => {
  const different = { hypothesis: 'the fixture seeds stale data', evidence: ['log line 12'], differs: 'reseed the fixture instead of patching the parser', path: 'succession' };
  const dir = world(t, [{ key: 'T1', behaviour: { outcomes: { original: 'FAIL', confirmation: 'FAIL' }, rca: different } }, { key: 'T2' }]);
  const J = await settleAll(dir);
  assert.equal(failedRounds(readState(dir, 'T1')), 2);
  assert.equal(count(dir, (e) => e.ticket === 'T1' && e.kind === 'agent' && e.leg === 'primary'), 2, 'original + confirmation: no third review');
  assert.equal(count(dir, (e) => e.ticket === 'T1' && e.kind === 'agent' && e.leg === 'rca'), 1, 'one RCA');
  assert.equal(J.blocked.T1.code, 'not_a_repo', 'the default adapter ran run-engine succeed, which refused (no engine run in this world)');
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

test('PR-4b seam smoke (fake providers): after two failed rounds the RCA path calls the REAL run-engine succeed; the engine records one generation carrying the RCA', { skip: SKIP }, async (t) => {
  // a real succession run: reviewed, then an in-scope correction in the work tree (what the RCA's different path changed)
  const fx = fixture(t, { config: { width: 1, base: 'main', pinnedBase: { remote: 'origin' }, succession: { version: 1 }, redEnvironment: { setup: [] },
    testCommands: { unit: { cmd: process.execPath, args: ['-e', ''] } } }, nodes: [{ id: 'a', writes: ['src/a.txt'] }], behaviour: { a: { write: { 'src/a.txt': 'a1' } } } });
  withOrigin(fx).feature();
  for (const [cmd, flags] of [['init', { dag: fx.dagFile }], ['drive', {}]]) { const r = fx.cli(cmd, flags); assert.equal(r.status, 0, r.stdout + r.stderr); }
  const rv = fx.gate('review', passReview('rx1', fx.candidate()));
  assert.equal(rv.status, 0, rv.stdout + rv.stderr);
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'a2: the different path');
  // the supervisor's world: the same ticket key and run id, its worktree the real engine repository
  const rca = { hypothesis: 'the fixture seeds stale data', evidence: ['log line 12'], differs: 'reseed the fixture instead of patching the parser', path: 'succession' };
  const fail = (kind) => ({ review_execution: 'rx1', kind, outcome: 'FAIL', fix_findings: ['f1'] });
  const dir = world(t, [{ key: 'T-1', phase: 'terminal', chain: [fail('original'), { review_execution: 'rx1', kind: 'repair' }, fail('confirmation')], behaviour: { rca } }]);
  const M = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  Object.assign(M.tickets[0], { worktree: fx.repo, run_id: 'run-1' });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(M));
  const J = await settleAll(dir);
  assert.equal(J.blocked['T-1'], undefined, JSON.stringify(J.blocked));
  const op = Object.values(J.ops).find((o) => o.op === 'succeed');
  assert.deepEqual([op.state, op.result.outcome, op.result.detail], ['recorded', 'succeeded', { generation: 1, kind: 'correction' }]);
  const S = JSON.parse(readFileSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'state.json'), 'utf8'));
  assert.equal(S.succession.g, 1);
  const gen = S.succession.generations[0];
  assert.deepEqual([gen.kind, gen.review_required, gen.rca], ['correction', true, { differs: rca.differs, evidence: rca.evidence }]);
  assert.deepEqual(gen.delta.candidate.map((d) => [d.path, d.change]), [['src/a.txt', 'content']]);
  assert.equal(count(dir, (e) => e.leg === 'rca'), 1, 'one RCA');
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

test('admission held: nothing ran, re-tried under a derived generation (not a duplicate effect, not no-progress)', { skip: SKIP }, async (t) => {
  const dir = world(t, [{ key: 'T1', behaviour: { drive: 'held' } }]);
  await settleAll(dir, {}, 4).catch(() => {});
  const ops = Object.values(journal(dir).ops).filter((o) => o.op === 'drive');
  assert.ok(ops.length >= 2 && ops.every((o) => o.result?.outcome === 'held' || o.state !== 'recorded'), JSON.stringify(ops.map((o) => [o.gen, o.result])));
  assert.deepEqual(ops.map((o) => o.gen).slice(0, 2), ['s1', 's1.r1']);
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
  const manifest = { schema: 'ship-ticket-wave-v1', wave_id: 'W-R', endpoint: 'SHIP_READY', heavy_slots: 1,
    tickets: [{ key: 'T-1', plan: '.specs/plans/T-1.md', run_id: 'run-1', worktree: fx.repo, branch: 'main', deps: [], dep_mode: 'ship_ready', resources: [] }] };
  const D = 'sha256:' + '1'.repeat(64);
  const deps = { verifyWave: () => ({ ok: true, digest: D }), readManifest: () => ({ ok: true, manifest, digest: D, problems: [] }),
    admitted: (argv) => ({ file: argv[0], args: argv.slice(1), shell: false }), // PR-2 seam re-pointed: the engine itself, no host-admit
    env: fx.env, verifySubscription: () => true, secondOpinionRoute: () => ({ provider: 'codex', modelMap: { strong: 'codex-strong-x' } }),
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
  assert.equal(J().blocked['T-1'].code, 'review_leg_unreadable', 'the stand-in reviewers wrote nothing: Blocked, never a gate call');
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
  const fx = fixture(t, { commit: true, config: { modelMap: { strong: 'claude-strong-x', review_second: 'claude-second-x' }, testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } }, ...config },
    ...(behaviour ? { behaviour } : {}) });
  const init = fx.cli('init', { dag: fx.dagFile });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const manifest = { schema: 'ship-ticket-wave-v1', wave_id: 'W-R', endpoint: 'SHIP_READY', heavy_slots: 1,
    tickets: [{ key: 'T-1', plan: '.specs/plans/T-1.md', run_id: 'run-1', worktree: fx.repo, branch: 'main', deps: [], dep_mode: 'ship_ready', resources: [] }] };
  const D = 'sha256:' + '1'.repeat(64);
  const arts = join(fx.root, 'arts');
  spawnSync('mkdir', ['-p', arts]);
  const agent = join(fx.root, 'agent.cjs');
  writeFileSync(agent, `const fs = require('node:fs'); let p = ''; process.stdin.on('data', (c) => { p += c; }); process.stdin.on('end', () => {
    const leg = /leg (\\w+)/.exec(p)?.[1] || 'rca', kind = /# ship-ticket (\\w+) review/.exec(p)?.[1] || 'rca';
    const f = ${JSON.stringify(arts)} + '/' + leg + '-' + kind + '.json';
    const out = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : JSON.stringify({ hypothesis: 'h', evidence: [], differs: '', path: 'blocked' });
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: out })); });`);
  const deps = { verifyWave: () => ({ ok: true, digest: D }), readManifest: () => ({ ok: true, manifest, digest: D, problems: [] }),
    admitted: (argv) => ({ file: argv[0], args: argv.slice(1), shell: false }), env: fx.env, verifySubscription: () => true,
    agentSpec: () => ({ file: process.execPath, args: [agent], shell: false }) };
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
  w.art('reconcile-original', { kind: 'original', review_execution: 'rx-1', primary: p1, second_opinion: s1, reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] } });
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
