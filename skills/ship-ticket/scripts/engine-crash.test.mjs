/**
 * AIS-HARNESS-3 Wave 3.5: crash recovery (property P10, .specs/reviews/AIS-HARNESS-3/PROPERTIES.md).
 * Threat model: accidental or buggy workers only.
 *
 * 1. Deterministic exceptions: the unit-repair drive (repair dispatch, post-repair re-check,
 *    binding) and the unit-review FAIL gate are run in-process with a `boundary` hook (the
 *    engine's existing persistence and launch boundaries; none is added) that throws at hit k, for
 *    every k of the uncrashed reference run. The pipes of the launchers it spawned are then closed,
 *    as a process exit would close them. Recovery is what an orchestrator does: `resume`, re-issue
 *    the interrupted command, continue. The oracle checks every step; the final accounting and
 *    authorization must equal the reference, or end in a disclosed known limit (D5, D6).
 * 2. Real SIGKILL (4 cases) at acknowledged barriers: engine-crash-driver.test-helper.mjs kills
 *    its own process at a named boundary and leaves a marker file; worker ordering uses file
 *    handshakes (waitFor), never sleeps.
 * A thrown hook is not SIGKILL, and neither shows power-loss durability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, waitUntil } from './engine-test-fixture.mjs';
import { Driver, twoUnitWorld } from './engine-explore.test-helper.mjs';
import { drive, gate } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown (known limit D4)';
const CRASH_DRIVER = fileURLToPath(new URL('./engine-crash-driver.test-helper.mjs', import.meta.url));
const LANES = 3;
const J = JSON.stringify;
const LIVE = ['intent', 'launched', 'running', 'unknown'];
const shown = (vs) => vs.slice(0, 5).map(v => `${v.property} ${v.detail}\n    trace: ${v.trace.join(' > ')}`).join('\n');

/** Final accounting and authorization, path- and id-free. */
function summary(d) {
  const S = d.raw(), st = d.lastStatus, runs = d.oracle.facts().runs;
  return {
    used: S.unit_ceiling?.used ?? 0, held: (S.unit_ceiling?.holds ?? []).map(h => `${h.unit}:${h.slots.join('+')}`),
    chains: Object.fromEntries(Object.entries(S.unit_reviews).map(([u, R]) => [u, R.chain.map(r => `${r.kind}:${r.outcome ?? ''}`
      + (r.kind === 'repair' ? (r.new_candidate ? ':bound' : r.unbound ? ':unbound' : ':open') : ''))])),
    reviews: Object.fromEntries(Object.entries(st.units).map(([u, p]) => [u, `${p.state}/${p.review.state}${p.review.awaiting ? `/${p.review.awaiting}` : ''}`])),
    repairs: S.repairs.map(r => r.state), nodes: Object.fromEntries(Object.entries(S.nodes).map(([id, n]) => [id, n.state])),
    runs, judgments: st.judgments.map(j => j.code).sort(),
  };
}

/** Wait until no attempt on disk has a live process group (a released worker an exception or kill left running). */
async function groupsGone(d) {
  const gone = () => (d.raw()?.attempts ?? []).filter(a => LIVE.includes(a.status) && a.pgid).every(a => { try { process.kill(-a.pgid, 0); return false; } catch { return true; } });
  assert.ok(await waitUntil(gone, 20000), 'every process group left by the crash ended');
}

/** A boundary hook that records every hit, and throws at hit `at` (1-based) when given. */
function hook(hits, at = 0) {
  return { boundary: async (name, info) => { hits.push(name + (info?.unit ? `:${info.unit}` : '')); if (hits.length === at) throw new Error(`crash at ${hits.length} ${name}`); } };
}

/** Recovery as an orchestrator does it, then the rest of the unit cycle; returns how the run ended. */
async function recoverAndFinish(d, reissue) {
  await d.apply({ kind: 'resume' });
  if (reissue) {
    const r = await d.gate(reissue.action, reissue.kind, reissue.input);
    assert.ok(r.status === 0 || ['unit_review_open'].includes(r.out?.code), `the re-issued gate is accepted or refused as already recorded: ${r.stdout}`);
  }
  await d.apply({ kind: 'drive' });
  if (d.lastStatus.units.uA.review.awaiting === 'confirmation') await d.apply({ kind: 'uconf', unit: 'uA' });
  return summary(d);
}

/**
 * Compare a recovered run with the reference: equal, or a disclosed limit with its exact
 * signature. D6: a re-check whose result a crash lost was spent, so its re-run spends once more
 * (used +1, one unit-check attempt abandoned), everything else equal.
 */
function classify(d, got, ref) {
  if (J(got) === J(ref)) return 'equivalent';
  const abandoned = d.raw().attempts.filter(a => a.kind === 'unit-check' && a.status === 'abandoned').length;
  if (J({ ...got, used: got.used - 1 }) === J(ref) && abandoned === 1) return 'D6';
  return `DIFFERENT ${J(got)} vs reference ${J(ref)}`;
}

/** One lane: its own fixture, prefix snapshot and reference; then its share of the crash points. */
async function lane(t, lanes, index, family) {
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 4 }, { strictRuns: false });
  await d.apply({ kind: 'drive' });
  if (family === 'drive') await d.apply({ kind: 'ufail', unit: 'uA' });
  const prefix = d.snapshot();
  const hits = [];
  const g = family === 'gate' ? await d.prepare({ kind: 'ufail', unit: 'uA' }) : null;
  const run = (h, spawned) => (family === 'drive' ? drive(d.fx.ctx({ hooks: h, spawn: (...a) => { const c = spawn(...a); spawned.push(c); return c; } }))
    : gate(d.fx.ctx({ gate: g.kind, input: g.input, hooks: h })));
  const r0 = await d.inProcess({ kind: `${family}-reference`, cmd: family === 'drive' ? 'drive' : 'gate unit-review', unit: 'uA', rx: g?.action.rx }, () => run(hook(hits), []));
  assert.equal(r0.error, null);
  if (family === 'gate') await d.apply({ kind: 'drive' });
  if (d.lastStatus.units.uA.review.awaiting === 'confirmation') await d.apply({ kind: 'uconf', unit: 'uA' });
  const ref = summary(d);
  assert.equal(ref.reviews.uA, 'verified/pass', `the reference completes the cycle: ${J(ref)}`);
  assert.deepEqual(d.violations, [], shown(d.violations));
  const out = [];
  for (let k = 1 + index; k <= hits.length; k += lanes) {
    d.restore(prefix);
    if (g) await d.prepare({ kind: 'ufail', unit: 'uA' }); // the same input (same rx), as before the crash
    const spawned = [], seen = [];
    const r = await d.inProcess({ kind: `${family}-crash@${k}:${hits[k - 1]}`, cmd: family === 'drive' ? 'drive' : 'gate unit-review', crashed: true, unit: 'uA', rx: g?.action.rx },
      () => run(hook(seen, k), spawned));
    // An exception inside unit-check runCheck's launch try block (its 'running' commit, the
    // unit-check-running hook) is absorbed as a runner start failure: the unreleased runner is
    // killed and the check retried once (UNIT_CHECK_RETRY, no recheck spent). Not a crash.
    const absorbed = !r.error;
    if (absorbed) assert.ok(d.raw().events.some(e => e.type === 'UNIT_CHECK_RETRY'), `hit ${k} (${hits[k - 1]}) neither crashed nor was absorbed: ${seen.join(' ')}`);
    else assert.match(r.error.message, /crash at/);
    for (const c of spawned) c.stdin?.destroy(); // a process exit closes the launchers' release pipes
    await groupsGone(d);
    const got = await recoverAndFinish(d, g);
    out.push({ k, at: hits[k - 1], outcome: classify(d, got, ref), absorbed });
  }
  return { hits, out, violations: d.violations };
}

for (const family of ['drive', 'gate']) {
  test(`exceptions: a crash at every boundary of the unit ${family === 'drive' ? 'repair drive (repair, re-check, binding)' : 'review FAIL gate'} recovers to the reference accounting or a disclosed limit`, { skip: WIN_SKIP, concurrency: LANES }, async (t) => {
    const results = await Promise.all(Array.from({ length: LANES }, (_, i) => lane(t, LANES, i, family)));
    const cases = results.flatMap(r => r.out).sort((x, y) => x.k - y.k);
    t.diagnostic(J({ family, boundaries: results[0].hits.length, cases: cases.length,
      outcomes: cases.reduce((m, c) => ({ ...m, [c.outcome.startsWith('DIFF') ? 'different' : c.outcome]: (m[c.outcome.startsWith('DIFF') ? 'different' : c.outcome] ?? 0) + 1 }), {}),
      d6: cases.filter(c => c.outcome === 'D6').map(c => `${c.k}:${c.at}`), absorbed: cases.filter(c => c.absorbed).map(c => `${c.k}:${c.at}`) }));
    assert.equal(cases.length, results[0].hits.length, 'every boundary hit of the reference was crashed once');
    for (const r of results) assert.deepEqual(r.violations, [], shown(r.violations));
    const different = cases.filter(c => !['equivalent', 'D6'].includes(c.outcome));
    assert.deepEqual(different, []);
  });
}

// ------------------------------------------------------------------ real SIGKILL at acknowledged barriers

/** Run one command in a child that SIGKILLs itself at the `nth` hit of boundary `name`. */
async function killedAt(d, cmd, name, nth, extra = {}) {
  const marker = join(d.fx.root, `killed-${name}`);
  rmSync(marker, { force: true });
  const job = { cmd, ctx: { repoRoot: d.fx.repo, ticket: 'T-1', runId: 'run-1', dagFile: d.fx.dagFile }, at: { name, nth }, marker, ...extra };
  const pre = d.oracle.facts();
  const child = spawn(process.execPath, [CRASH_DRIVER, J(job)], { env: d.fx.env, stdio: 'ignore' });
  const signal = await new Promise(r => child.on('exit', (_c, s) => r(s)));
  assert.equal(signal, 'SIGKILL', 'the engine process died by SIGKILL');
  assert.ok(existsSync(marker), `it died at the ${name} barrier`);
  const v = await d.oracle.check({ kind: `kill@${name}`, cmd: cmd === 'drive' ? 'drive' : `gate ${extra.gate}`, crashed: true }, { status: null, out: null, stdout: '', stderr: '' }, pre);
  for (const x of v) d.violations.push({ ...x, trace: [`kill@${name}`] });
}

async function killBase(t, family) {
  const d = await Driver.create(t, twoUnitWorld('pass'), { unitRecheckCeiling: 4 }, { strictRuns: false });
  await d.apply({ kind: 'drive' });
  if (family === 'drive') await d.apply({ kind: 'ufail', unit: 'uA' });
  return d;
}

test('SIGKILL at after-release of a unit repair, resume while the worker runs: never duplicated; the run ends in the disclosed safe refusal D5', { skip: WIN_SKIP }, async (t) => {
  const d = await killBase(t, 'drive');
  const go = join(d.fx.root, 'go-fix'), ready = join(d.fx.root, 'ready-fix');
  // The worker writes its fix and then this readiness marker (outside the repo) before it waits for
  // `go`: resume must not run before the worker's in-flight write exists (no timing dependence).
  const fix = d.behaviour().fixuA;
  d.setBehaviour('fixuA', { ...fix, write: { ...fix.write, [ready]: 'written' }, waitFor: go });
  await killedAt(d, 'drive', 'after-release', 1);
  assert.ok(await waitUntil(() => existsSync(ready), 20000), 'the released repair worker wrote its fix');
  const live = await d.apply({ kind: 'resume' });
  assert.equal(live.status, 0, live.stdout);
  assert.ok(d.raw().attempts.some(a => a.kind === 'repair' && LIVE.includes(a.status)), 'the repair worker is still live and owned');
  assert.equal(d.oracle.facts().runs.fixuA, 1);
  writeFileSync(go, '');
  await groupsGone(d);
  const got = await recoverAndFinish(d, null);
  assert.equal(got.runs.fixuA, 1, 'the repair ran exactly once');
  // D5: the resume ran while the repair worker was writing, so the drift check read its in-flight
  // write as drift of builder node a: a and its closure were re-run (overwriting the repair) and the
  // hold was released; the repair is recorded unbound and the review is stale. Safe: nothing binds,
  // a fresh unit review is due and the allowance stays conserved.
  const S = d.raw(), rec = S.unit_reviews.uA.chain.find(r => r.kind === 'repair');
  assert.deepEqual([got.reviews.uA, rec.unbound?.reason, got.runs.a, got.held], ['verified/stale', 'node re-run: a', 2, []], J(got));
  assert.ok(S.events.some(e => e.type === 'UNIT_CEILING_RELEASED' && e.why === 'stale'));
  const fresh = await d.apply({ kind: 'upass', unit: 'uA' });
  assert.equal(fresh.out.code, 'unit_review_accepted', 'the fresh original review the refusal asks for is accepted');
  assert.deepEqual(d.violations, [], shown(d.violations));
});

test('SIGKILL at unit-check-running: the unreleased runner never starts (its launcher exits on the closed pipe); the lost re-check is re-run (D6)', { skip: WIN_SKIP }, async (t) => {
  const d = await killBase(t, 'drive');
  await killedAt(d, 'drive', 'unit-check-running', 1);
  await groupsGone(d);
  const got = await recoverAndFinish(d, null);
  assert.equal(got.reviews.uA, 'verified/pass', J(got));
  assert.equal(d.raw().attempts.filter(a => a.kind === 'unit-check' && a.status === 'abandoned').length, 1);
  assert.equal(got.used, 4, 'D6: repair 1 + lost re-check 1 + its re-run 1 + confirmation 1');
  assert.deepEqual(d.violations, [], shown(d.violations));
});

test('SIGKILL at unit-checked (re-check evidence durable, binding not yet): resume binds it and the confirmation is accepted', { skip: WIN_SKIP }, async (t) => {
  const d = await killBase(t, 'drive');
  await killedAt(d, 'drive', 'unit-checked', 1);
  assert.equal(d.raw().unit_reviews.uA.chain.find(r => r.kind === 'repair').new_candidate, null, 'killed before the binding');
  const got = await recoverAndFinish(d, null);
  assert.deepEqual([got.reviews.uA, got.used, got.held, got.runs.fixuA], ['verified/pass', 3, [], 1], J(got));
  assert.deepEqual(d.violations, [], shown(d.violations));
});

test('SIGKILL at run-log-append of a unit FAIL gate (record durable, outbox pending): the re-issued gate is refused as already open; one repair runs', { skip: WIN_SKIP }, async (t) => {
  const d = await killBase(t, 'gate');
  const g = await d.prepare({ kind: 'ufail', unit: 'uA' });
  await killedAt(d, 'gate', 'run-log-append', 1, { gate: g.kind, input: g.input });
  assert.equal(d.raw().outbox.length > 0, true, 'the GATE event was not delivered');
  const got = await recoverAndFinish(d, g);
  assert.deepEqual([got.reviews.uA, got.used, got.held, got.runs.fixuA, got.chains.uA.length], ['verified/pass', 3, [], 1, 3], J(got));
  assert.deepEqual(d.violations, [], shown(d.violations));
});
