/**
 * AIS-HARNESS-3 Wave 3.5: small seeded CLI layer over the real engine (engine-test-fixture.mjs),
 * checked by the independent oracle (engine-oracle.test-helper.mjs) after every command. Threat
 * model: accidental or buggy workers only. POSIX only; CI runs it in its own job with
 * `--test-concurrency=1`.
 *
 * Each seed generates a world (3-5 nodes, random dependencies, unit membership, declared reads of
 * inputs and of upstream outputs, unit reviews on or off, a ceiling 0-5) and a command stream chosen
 * from the enabled actions with weights biased toward reachable repair states (unit FAIL, repair
 * drive, confirmation, final review, ship), plus input edits and worker failures.
 *
 *   ENGINE_SEEDED_SEEDS     comma list or range (default 1,2,3,4), e.g. "1-200" for a nightly run
 *   ENGINE_SEEDED_COMMANDS  commands per seed (default 25: about 100 commands per PR run)
 *
 * A violation fails with the seed, the world and the command trace (reduced by dropping commands
 * that are not needed to reproduce it); re-run it with ENGINE_SEEDED_SEEDS=<seed>. A green run
 * means no violation in the printed number of commands and distinct states, nothing more.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POSIX } from './engine-test-fixture.mjs';
import { Driver } from './engine-explore.test-helper.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown (known limit D4)';
const J = JSON.stringify;

function seeds() {
  const spec = process.env.ENGINE_SEEDED_SEEDS ?? '1,2,3,4';
  return spec.split(',').flatMap(p => { const [a, b] = p.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; });
}
const COMMANDS = Number(process.env.ENGINE_SEEDED_COMMANDS ?? 25);
const CONCURRENCY = 4;

/** mulberry32: a small deterministic PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Whether contracting each unit to one vertex leaves the dependency graph acyclic (the engine refuses unit cycles). */
function unitAcyclic(nodes) {
  const v = (n) => (n.unit ? `u:${n.unit}` : `n:${n.id}`);
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const edges = {};
  for (const n of nodes) for (const d of n.deps) if (v(byId[d]) !== v(n)) (edges[v(byId[d])] ??= new Set()).add(v(n));
  const state = {};
  const visit = (x) => { if (state[x] === 1) return false; if (state[x] === 2) return true; state[x] = 1; for (const y of edges[x] ?? []) if (!visit(y)) return false; state[x] = 2; return true; };
  return nodes.every(n => visit(v(n)));
}

/** A random but valid world for `seed` (a draw whose units would form a cycle is discarded and redrawn). */
export function world(seed) {
  const r = prng(seed);
  for (;;) { const w = draw(r); if (unitAcyclic(w.nodes)) return w; }
}

function draw(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const n = 3 + Math.floor(r() * 3);
  const nodes = [], inputs = {}, behaviour = {};
  for (let i = 0; i < n; i++) {
    // Once a u2 node exists no later node joins u1, so u1 never depends on u2 (units may not form a cycle).
    const id = `n${i}`, unit = pick(nodes.some(x => x.unit === 'u2') ? ['u2', undefined] : ['u1', 'u2', undefined]);
    const deps = nodes.filter(() => r() < 0.4).map(x => x.id);
    const reads = [...deps.filter(() => r() < 0.6).map(d => `src/${d}.txt`)];
    if (!deps.length || r() < 0.4) { const p = `docs/in-${id}.txt`; reads.push(p); inputs[p] = `input ${id} v1`; }
    nodes.push({ id, deps, reads, writes: [`src/${id}.txt`], ...(unit ? { unit, checks: ['ok'] } : {}) });
    behaviour[id] = { write: { [`src/${id}.txt`]: `${id} v1` } };
  }
  if (!nodes.some(x => x.unit)) Object.assign(nodes[0], { unit: 'u1', checks: ['ok'] });
  const acceptanceIds = [];
  for (const u of [...new Set(nodes.map(x => x.unit).filter(Boolean))]) { acceptanceIds.push(`AC-${u}`); nodes.find(x => x.unit === u).acceptance = [`AC-${u}`]; }
  const config = { unitReview: r() < 0.75, unitRecheckCeiling: Math.floor(r() * 6) };
  return { nodes, inputs, behaviour, acceptanceIds, config, rand: r };
}

/** Weights biasing the stream toward reachable repair states. */
const WEIGHTS = { ufail: 4, uconf: 5, uconfFail: 1, drive: 4, upass: 2, final: 2, finalFail: 1, fconf: 4, ship: 3, mark: 3, clear: 3,
  edit: 1, revert: 1, resume: 1, setFail: 0.5, setPass: 1 };

function choose(r, actions) {
  const total = actions.reduce((t, a) => t + (WEIGHTS[a.kind] ?? 1), 0);
  let x = r() * total;
  for (const a of actions) { x -= WEIGHTS[a.kind] ?? 1; if (x <= 0) return a; }
  return actions.at(-1);
}

/** Run `seed`'s stream (or a given `trace` of actions): the trace, violations and distinct states. */
async function play(t, seed, { trace = null, commands = COMMANDS } = {}) {
  const w = world(seed);
  const d = await Driver.create(t, w, w.config);
  const actions = [], states = new Set();
  const failing = new Set();
  for (let i = 0; i < (trace ? trace.length : commands); i++) {
    let a = trace?.[i];
    if (!a) {
      const enabled = d.enabled();
      for (const n of w.nodes) if (w.rand() < 0.05) enabled.push(failing.has(n.id) ? { kind: 'setPass', node: n.id } : { kind: 'setFail', node: n.id });
      a = choose(w.rand, enabled);
      const { ctx: _c, ...plain } = a;
      a = plain;
    }
    if (a.kind === 'setFail') failing.add(a.node); else if (a.kind === 'setPass') failing.delete(a.node);
    actions.push(a);
    try { await d.apply(a); } catch (e) {
      if (!trace) throw e; // a generated action is always applicable; a replayed one may not be after a removal
      continue;
    }
    states.add(d.key());
    if (d.violations.length) break;
  }
  return { actions, violations: d.violations, states: states.size, world: w };
}

/** Drop commands not needed to reproduce the first violation's property (bounded number of replays). */
async function reduce(t, seed, actions, property) {
  let cur = actions;
  for (let i = cur.length - 2, replays = 0; i >= 0 && replays < 30; i--, replays++) {
    const cand = [...cur.slice(0, i), ...cur.slice(i + 1)];
    const r = await play(t, seed, { trace: cand });
    if (r.violations.some(v => v.property === property)) cur = r.actions;
  }
  return cur;
}

test(`seeded: ${seeds().length} seed(s) x ${COMMANDS} commands of random worlds through the real CLI, oracle-checked after every command`, { skip: WIN_SKIP, timeout: 30 * 60 * 1000 }, async (t) => {
  const list = seeds(), results = [];
  const started = Date.now();
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    results.push(...await Promise.all(list.slice(i, i + CONCURRENCY).map(async (seed) => ({ seed, ...await play(t, seed) }))));
  }
  const commands = results.reduce((n, r) => n + r.actions.length, 0);
  const kinds = {};
  for (const r of results) for (const a of r.actions) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  t.diagnostic(J({ seeds: list.length, commands, distinct_states: results.reduce((n, r) => n + r.states, 0), ms: Date.now() - started, kinds }));
  const bad = results.filter(x => x.violations.length);
  for (const r of bad) t.diagnostic(`seed ${r.seed} after ${r.actions.length} commands: ${r.violations[0].property} ${r.violations[0].detail}`);
  for (const r of bad) {
    const first = r.violations[0];
    const reduced = await reduce(t, r.seed, r.actions, first.property);
    assert.fail(`seed ${r.seed}: ${first.property} ${first.detail}\nworld: ${J({ nodes: r.world.nodes, config: r.world.config })}\n`
      + `reduced trace (${reduced.length} of ${r.actions.length}): ${reduced.map(a => J(a)).join(' > ')}\nreproduce: ENGINE_SEEDED_SEEDS=${r.seed} ENGINE_SEEDED_COMMANDS=${COMMANDS} node --test skills/ship-ticket/scripts/engine-seeded.test.mjs`);
  }
  assert.equal(commands, list.length * COMMANDS, 'every seed ran its whole stream');
});
