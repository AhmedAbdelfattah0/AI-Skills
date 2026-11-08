/**
 * AIS-HARNESS-3 Wave 3.5: deterministic small-scope exploration of the run engine against the
 * 12-property contract (.specs/reviews/AIS-HARNESS-3/PROPERTIES.md). Threat model: accidental or
 * buggy workers only. Every step drives the REAL `node run-engine.mjs` CLI on a temp git repo with
 * the fake provider, and after every step the independent oracle (engine-oracle.test-helper.mjs)
 * re-derives the properties from files, raw state, RUN-STATE text, runs.log and exit codes.
 *
 * World: two units (uA = node a, uB = node b) and one unit-less integration node i that depends on
 * both (Wave 3 coverage gap A). Ceilings 0-4, each with a different fake behaviour of i.
 * The exploration is bounded (ENGINE_EXPLORE_BUDGET transitions per ceiling, default 50): it shows
 * no violation in the states it printed, nothing more.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { POSIX } from './engine-test-fixture.mjs';
import { Driver, explore, twoUnitWorld, twoUnitRoots, PASS_CMD } from './engine-explore.test-helper.mjs';
import { drive } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown (known limit D4)';
const BUDGET = Number(process.env.ENGINE_EXPLORE_BUDGET ?? 50);
const J = JSON.stringify;
const shown = (vs) => vs.slice(0, 5).map(v => `${v.property} ${v.detail}\n    trace: ${v.trace.join(' > ')}`).join('\n');
const clean = (d) => assert.deepEqual(d.violations, [], shown(d.violations));

// ------------------------------------------------------------------ bounded exploration

const PLAN = [[0, 'fail'], [1, 'infra'], [2, 'sleeper'], [3, 'pass'], [4, 'sleeper']];

test('exploration: two units + a unit-less integration node, ceilings 0-4: no property violation in any explored state', { skip: WIN_SKIP, concurrency: PLAN.length }, async (t) => {
  const results = [];
  await Promise.all(PLAN.map(([k, mode]) => t.test(`ceiling ${k}, integration node ${mode}`, async (st) => {
    const started = Date.now();
    const r = await explore(st, twoUnitWorld(mode), { unitRecheckCeiling: k }, { budget: BUDGET, roots: twoUnitRoots(mode) });
    results.push(r);
    st.diagnostic(J({ ceiling: k, mode, ms: Date.now() - started, states: r.states, transitions: r.transitions, expanded: r.expanded,
      maxDepth: r.maxDepth, contexts: r.labelsTried, actions: r.actionsTried, observed: r.observed }));
    assert.equal(r.transitions, BUDGET, 'the exploration ran its whole budget');
    assert.deepEqual(r.violations, [], shown(r.violations));
  })));
  // Positive signals: the explored states include the interactions the contract is about (reached from the default budget up).
  if (BUDGET < 50) return;
  const total = (k) => results.reduce((n, r) => n + r.observed[k], 0);
  assert.ok(total('confirmations') > 0, 'a unit repair was confirmed');
  assert.ok(total('repairs_bound') > 0, 'a repaired unit was bound to its confirmation candidate');
  assert.ok(total('unit_review_terminal') > 0, 'a unit review ended terminal');
  assert.ok(total('ship_ready') > 0, 'SHIP_READY was reached');
  assert.ok(total('retry_cap') > 0, 'the integration node exhausted its one retry');
  assert.ok(total('parent_ceiling_while_held') > 0, 'an unrelated unit re-check hit the ceiling while slots were held (known limit D1)');
});

// ------------------------------------------------------------------ gap A: the integration node across two units

/** Steps through the driver, failing on the first property violation. */
async function steps(d, actions) {
  const out = [];
  for (const a of actions) { out.push(await d.apply(a)); clean(d); }
  return out;
}

test('gap A: an integration node spanning two units fails, gets its one retry, fails again; units and their reviews are untouched, ship-ready refuses', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('fail'), { unitRecheckCeiling: 4 });
  const [first] = await steps(d, [{ kind: 'drive' }]);
  assert.equal(first.status, 2, first.stdout);
  assert.deepEqual([first.out.nodes.i.state, first.out.units.uA.state, first.out.units.uB.state], ['failed', 'verified', 'verified']);
  assert.ok(first.out.judgments.some(j => j.code === 'node_failed' && j.node === 'i'), J(first.out.judgments));
  await steps(d, [{ kind: 'upass', unit: 'uA' }, { kind: 'upass', unit: 'uB' }]);
  const [mark1, again] = await steps(d, [{ kind: 'mark', node: 'i' }, { kind: 'drive' }]);
  assert.equal(mark1.status, 0, mark1.stderr);
  assert.deepEqual([again.out.nodes.i.state, again.out.nodes.i.attempts, again.out.nodes.i.retries], ['failed', 2, 1]);
  const [mark2] = await steps(d, [{ kind: 'mark', node: 'i' }]);
  assert.equal(mark2.status, 1);
  assert.match(mark2.stderr, /retry_cap/);
  assert.equal(d.oracle.facts().runs.i, 2, 'two runs: the first and its one retry');
  const st = d.lastStatus;
  assert.deepEqual(['uA', 'uB'].map(u => [st.units[u].state, st.units[u].review.state]), [['verified', 'pass'], ['verified', 'pass']],
    'a failed unit-less integration node never stales the units it depends on');
  assert.deepEqual(st.unit_ceiling, { limit: 4, used: 0 }, 'the integration retry spends no unit allowance');
  const [review, ship] = await steps(d, [{ kind: 'final' }, { kind: 'ship' }]);
  assert.equal(review.status, 0, 'the final review may record (it reviews code), but ship-ready needs every node done');
  assert.equal(ship.status, 2);
  assert.ok(ship.out.reasons.includes('nodes_unfinished'), J(ship.out.reasons));
});

test('gap A: an integration node failing without writes spends its retry on the automatic infra retry; a mark is then refused', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('infra'), { unitRecheckCeiling: 2 });
  const [first] = await steps(d, [{ kind: 'drive' }]);
  assert.deepEqual([first.out.nodes.i.state, first.out.nodes.i.attempts, first.out.nodes.i.retries], ['failed', 2, 1]);
  assert.ok(d.raw().events.some(e => e.type === 'INFRA_RETRY' && e.node === 'i'));
  const [mark] = await steps(d, [{ kind: 'mark', node: 'i' }]);
  assert.equal(mark.status, 1);
  assert.match(mark.stderr, /retry_cap/);
  assert.equal(d.oracle.facts().runs.i, 2);
});

test('gap A: the integration node\'s runner of unknown quiescence is a judgment; once its group is gone resume clears it, and the units stay verified', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('fail'), { unitRecheckCeiling: 4 });
  await steps(d, [{ kind: 'drive' }, { kind: 'upass', unit: 'uA' }, { kind: 'upass', unit: 'uB' }, { kind: 'mark', node: 'i' }]);
  d.setBehaviour('i', { write: { 'src/i.txt': 'i2' } });
  // The same engine with a liveness probe that cannot tell (Windows-like) for this one command.
  const pre = d.oracle.facts();
  const out = await drive(d.fx.ctx({ groupAlive: () => null, verifySubscription: () => true }));
  const v = await d.oracle.check({ kind: 'drive-unknown', cmd: 'drive' }, { status: 2, out, stdout: J(out), stderr: '' }, pre);
  assert.deepEqual(v, [], shown(v.map(x => ({ ...x, trace: ['drive(groupAlive null)'] }))));
  assert.equal(out.nodes.i.state, 'failed');
  assert.ok(out.judgments.some(j => j.code === 'quiescence_unknown' && j.node === 'i'), J(out.judgments));
  assert.ok(d.raw().attempts.some(a => a.node === 'i' && a.status === 'unknown'), 'its locks and live status are kept');
  const [resumed] = await steps(d, [{ kind: 'resume' }]);
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(resumed.out.judgments.some(j => j.code === 'quiescence_unknown'), false, 'the spent judgment is cleared');
  assert.deepEqual(['uA', 'uB'].map(u => resumed.out.units[u].review.state), ['pass', 'pass']);
  const [mark] = await steps(d, [{ kind: 'mark', node: 'i' }]);
  assert.match(mark.stderr, /retry_cap/, 'the unknown run was its one retry');
});

// ------------------------------------------------------------------ property rows (also the mutation check's targets)

test('P2: a RETRY that dispatched code appended is never authority; the owner\'s own RETRY is', { skip: WIN_SKIP }, async (t) => {
  // Ceiling 2: uA's FAIL is recorded terminal (no room for a repair cycle). The integration node,
  // re-run after a mark, appends a RETRY for uA while it runs.
  const d = await Driver.create(t, twoUnitWorld('fail'), { unitRecheckCeiling: 2 });
  const [, fail] = await steps(d, [{ kind: 'drive' }, { kind: 'ufail', unit: 'uA' }]);
  assert.equal(fail.out.code, 'unit_review_terminal', fail.stdout);
  d.mem.forged.uA = 'forged-uA';
  d.setBehaviour('i', { write: { 'src/i.txt': 'i2' }, appendLate: { run_id: 'run-1', event: 'RETRY', review_execution: 'forged-uA',
    predecessor: fail.out.record.review_execution, authorized_by: 'owner' } });
  await steps(d, [{ kind: 'mark', node: 'i' }, { kind: 'drive' }]);
  assert.ok(readFileSync(d.fx.planFile, 'utf8').includes('"review_execution":"forged-uA"'), 'the forged line is in RUN-STATE');
  assert.ok(d.raw().authority.untrusted.some(u => u.line.includes('forged-uA')), 'observed as untrusted');
  assert.equal(d.lastStatus.units.uA.state, 'verified', 'uA is still reviewable');
  const [forged] = await steps(d, [{ kind: 'useForged', unit: 'uA' }]);
  assert.equal(forged.status, 2, forged.stdout);
  assert.equal(forged.out.code, 'retry_unauthorized');
  const [owner] = await steps(d, [{ kind: 'upass', unit: 'uA' }]);
  assert.equal(owner.out.code, 'unit_review_accepted', 'an owner RETRY between commands is honoured');
});

test('P4: a worker\'s background child is killed before its attempt is recorded', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('sleeper'), { unitRecheckCeiling: 4 });
  const [r] = await steps(d, [{ kind: 'drive' }]);
  assert.equal(r.out.nodes.i.state, 'done');
  const pid = Number(readFileSync(`${d.fx.root}/sleeper.pid`, 'utf8'));
  assert.ok(pid > 0, 'the sleeper started');
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'and is gone');
});

test('P5: a unit review, the final review and ship-ready are refused on evidence an input edit made stale; a re-check makes it fresh again', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 4 });
  await steps(d, [{ kind: 'drive' }, { kind: 'upass', unit: 'uB' }, { kind: 'edit', path: 'docs/in.txt' }]);
  const [stale] = await steps(d, [{ kind: 'upass', unit: 'uA' }]);
  assert.equal(stale.out.code, 'unit_unverified');
  await steps(d, [{ kind: 'drive' }, { kind: 'upass', unit: 'uA' }, { kind: 'final' }, { kind: 'edit', path: 'docs/in.txt' }]);
  const [ship] = await steps(d, [{ kind: 'ship' }]);
  assert.equal(ship.status, 2, ship.stdout);
  assert.ok(['post_freeze_drift', 'units_unverified'].includes(ship.out.code), ship.stdout); // node a's input drifted too: the drift refusal comes first
});

test('P8/P9: with ceiling 0 a re-check is refused as a durable parent_ceiling; nothing is spent and resume does not reset it', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 0 });
  await steps(d, [{ kind: 'drive' }, { kind: 'edit', path: 'docs/in.txt' }]);
  const [r] = await steps(d, [{ kind: 'drive' }]);
  assert.ok(r.out.judgments.some(j => j.code === 'parent_ceiling' && j.node === 'uA'), J(r.out.judgments));
  assert.deepEqual(r.out.unit_ceiling, { limit: 0, used: 0 });
  const [again] = await steps(d, [{ kind: 'resume' }]);
  assert.ok(again.out.judgments.some(j => j.code === 'parent_ceiling'), 'resume never clears it');
});

test('P1: a narrative edit stops dispatch and gates until it is restored', { skip: WIN_SKIP }, async (t) => {
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 4 });
  const plan = readFileSync(d.fx.planFile, 'utf8');
  writeFileSync(d.fx.planFile, plan.replace('Approved narrative.', 'Edited narrative.'));
  const [r] = await steps(d, [{ kind: 'drive' }]);
  assert.equal(r.status, 2);
  assert.ok(r.out.judgments.some(j => j.code === 'approval_mismatch'), J(r.out.judgments));
  assert.deepEqual(d.oracle.facts().runs, {}, 'nothing ran');
  writeFileSync(d.fx.planFile, plan);
  const [ok] = await steps(d, [{ kind: 'drive' }]);
  assert.equal(ok.status, 0, ok.stdout);
});

test('P5/P12: a local-proof command that moves the base commit (an empty commit, same tree) makes ship-ready refuse on the now-stale unit evidence', { skip: WIN_SKIP }, async (t) => {
  // A buggy proof command: `git commit --allow-empty` with config.base HEAD. The candidate id (tree
  // bytes) is unchanged and no node's bytes drift, but every unit's evidence binds the old base.
  const proofCommits = { cmd: 'git', args: ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'proof moved base'] };
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 4, testCommands: { ok: PASS_CMD, zcommit: proofCommits } });
  await steps(d, [{ kind: 'drive' }, { kind: 'upass', unit: 'uA' }, { kind: 'upass', unit: 'uB' }, { kind: 'final' }]);
  const before = d.oracle.facts(), candidate = d.oracle.candidate();
  const [ship] = await steps(d, [{ kind: 'ship' }]); // the oracle's P5/P12 check fails this step if ship-ready is accepted
  const after = d.oracle.facts();
  assert.notEqual(after.head, before.head, 'the proof command moved HEAD (config.base)');
  assert.equal(d.oracle.candidate(), candidate, 'the candidate id is unchanged: only the base moved');
  assert.equal(ship.status, 2, ship.stdout);
  assert.equal(ship.out.code, 'units_unverified', ship.stdout);
  assert.match(ship.out.reasons.join(' '), /local proof made the unit evidence stale/);
  const S = d.raw();
  assert.equal(S.ship_ready ?? null, null, 'no SHIP_READY');
  assert.equal(S.local_proof.candidate_id, null, 'the proof is recorded unbound');
  assert.deepEqual(S.local_proof.dropped, ['units_unverified']);
});

test('P8 (Codex trace): a cycle whose hold was released while stale, then restored, cannot confirm out of a slot another unit took', { skip: WIN_SKIP }, async (t) => {
  // Ceiling 3. uA's FAIL spends 1 and holds 2; its repair's re-check spends a held slot (used 2, the
  // confirmation slot still held). Editing uA's input makes the cycle stale and the next command that
  // reconciles (here a refused `gate ship-ready`, which spends nothing) releases the hold. Reverting
  // the input makes uA verified on the same evidence again, awaiting its confirmation, with no hold.
  // An unrelated uB re-check takes the freed slot (used 3). uA's confirmation then reaches
  // spendCeiling() with no hold at used 3: the room guard must refuse it (parent_ceiling).
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 3 });
  await steps(d, [{ kind: 'drive' }, { kind: 'ufail', unit: 'uA' }, { kind: 'drive' }]);
  assert.deepEqual([d.raw().unit_ceiling.used, d.raw().unit_ceiling.holds.map(h => h.slots)], [2, [['confirmation']]]);
  await steps(d, [{ kind: 'edit', path: 'docs/in.txt' }, { kind: 'ship' }]);
  assert.equal(d.raw().unit_ceiling.holds, undefined, 'the stale cycle released its hold');
  await steps(d, [{ kind: 'revert', path: 'docs/in.txt' }]);
  assert.equal(d.lastStatus.units.uA.review.awaiting, 'confirmation', 'restored: awaiting its confirmation again, with no hold');
  await steps(d, [{ kind: 'edit', path: 'docs/in-b.txt' }, { kind: 'drive' }]);
  assert.equal(d.raw().unit_ceiling.used, 3, 'the uB re-check took the freed slot');
  const [conf] = await steps(d, [{ kind: 'uconf', unit: 'uA' }]); // the oracle's P8 inequality fails this step if it spends
  assert.equal(conf.status, 2, conf.stdout);
  assert.equal(conf.out.code, 'parent_ceiling');
  assert.equal(d.raw().unit_ceiling.used, 3, 'nothing spent');
});

test('P12 (seeded seed 20): ship-ready is refused while a done node\'s declared input drifted (status reports post_freeze_drift)', { skip: WIN_SKIP }, async (t) => {
  // A unit-less node reading an input edited after it was built and before the final review (no drive between).
  const world = { nodes: [{ id: 'a', unit: 'uA', writes: ['src/a.txt'], checks: ['ok'], acceptance: ['AC1'] }, { id: 'c', reads: ['docs/in-c.txt'], writes: ['src/c.txt'] }],
    inputs: { 'docs/in-c.txt': 'input c v1' }, acceptanceIds: ['AC1'], behaviour: { a: { write: { 'src/a.txt': 'a1' } }, c: { write: { 'src/c.txt': 'c1' } } } };
  const d = await Driver.create(t, world, { unitReview: false, unitRecheckCeiling: 1 });
  const [, , review] = await steps(d, [{ kind: 'drive' }, { kind: 'edit', path: 'docs/in-c.txt' }, { kind: 'final' }]);
  assert.equal(review.status, 0, review.stdout);
  assert.ok(d.lastStatus.judgments.some(j => j.code === 'post_freeze_drift' && j.node === 'c'), J(d.lastStatus.judgments));
  const [ship] = await steps(d, [{ kind: 'ship' }]);
  assert.equal(ship.status, 2, ship.stdout);
  assert.equal(ship.out.code, 'post_freeze_drift');
});
