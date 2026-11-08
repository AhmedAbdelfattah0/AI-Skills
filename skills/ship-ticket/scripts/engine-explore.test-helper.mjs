/**
 * World driver for the Wave 3.5 harness (engine-explore.test.mjs, engine-seeded.test.mjs,
 * engine-mutation.test.mjs). Not a test file. A `Driver` owns one fixture (the real CLI on a temp
 * git repo with the fake provider), the independent Oracle, and a small alphabet of commands and
 * owner actions; every applied action is checked by the oracle. `snapshot()`/`restore()` copy the
 * whole fixture root (same path, so the absolute paths in engine state stay valid) plus the
 * driver and oracle memory, which is what bounded exploration branches on.
 */
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, passReview, failReview, confirmReview, primaryReview } from './engine-test-fixture.mjs';
import { Oracle, cliAsync } from './engine-oracle.test-helper.mjs';

const J = JSON.stringify;
export const PASS_CMD = { cmd: process.execPath, args: ['-e', ''] };
const LIVE = ['intent', 'launched', 'running', 'unknown'];

/**
 * The exploration world: two units and one unit-less integration node spanning both.
 * uA = node a (reads docs/in.txt, writes src/a.txt), uB = node b (reads docs/in-b.txt, writes
 * src/b.txt), i depends on a and b and reads both outputs. `mode` sets i's fake worker:
 * pass | fail (writes, then exits 1: a real failure, no infra retry) | infra (exits 1 without
 * writing: the automatic infra retry spends its retry) | sleeper (passes, leaving a background child).
 */
export function twoUnitWorld(mode = 'pass') {
  const nodes = [
    { id: 'a', unit: 'uA', reads: ['docs/in.txt'], writes: ['src/a.txt'], checks: ['ok'], acceptance: ['AC1'] },
    { id: 'b', unit: 'uB', reads: ['docs/in-b.txt'], writes: ['src/b.txt'], checks: ['ok'], acceptance: ['AC2'] },
    { id: 'i', deps: ['a', 'b'], reads: ['src/a.txt', 'src/b.txt'], writes: ['src/i.txt'] },
  ];
  const i = { pass: { write: { 'src/i.txt': 'i1' } }, fail: { write: { 'src/i.txt': 'i-broken' }, exit: 1 }, infra: { exit: 1 },
    sleeper: { write: { 'src/i.txt': 'i1' }, sleeper: '@SLEEPER@' } }[mode];
  return { nodes, inputs: { 'docs/in.txt': 'input v1', 'docs/in-b.txt': 'input b v1' }, acceptanceIds: ['AC1', 'AC2'],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } }, i }, sleeperNode: mode === 'sleeper' ? 'i' : null };
}

export class Driver {
  /**
   * @param t node:test context (cleanup)
   * @param world { nodes, inputs, acceptanceIds, behaviour, sleeperNode? }
   * @param config extra DAG config (unitRecheckCeiling, unitReview...)
   */
  static async create(t, world, config = {}, oracleOpts = {}) {
    const unitReview = config.unitReview ?? true;
    const fx = fixture(t, { commit: true, nodes: world.nodes, behaviour: {},
      config: { ...(world.acceptanceIds ? { acceptanceIds: world.acceptanceIds } : {}), testCommands: { ok: PASS_CMD }, ...config, unitReview } });
    const d = new Driver(fx, world, config);
    t.after(() => {
      rmSync(d.snapDir, { recursive: true, force: true });
      // Child cleanup: kill every process group the last oracle check saw owned by a live attempt.
      for (const g of d.oracle?.livePgids ?? []) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
    });
    for (const [p, c] of Object.entries(world.inputs)) writeFileSync(join(fx.repo, p), c);
    const behaviour = structuredClone(world.behaviour);
    if (world.sleeperNode) behaviour[world.sleeperNode].sleeper = join(fx.root, 'sleeper.pid');
    writeFileSync(join(fx.root, 'behaviour.json'), J(behaviour));
    const init = await cliAsync(fx, 'init', { dag: fx.dagFile });
    if (init.status !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
    d.oracle = new Oracle(fx, world.nodes, { limit: config.unitRecheckCeiling ?? 4,
      sleepers: world.sleeperNode ? [{ file: join(fx.root, 'sleeper.pid'), node: world.sleeperNode }] : [], ...oracleOpts });
    return d;
  }

  constructor(fx, world, config) {
    this.fx = fx;
    this.world = world;
    this.config = config;
    this.snapDir = fx.root + '.snaps';
    this.mem = { trace: [], rx: 0, inputs: Object.fromEntries(Object.keys(world.inputs).map(p => [p, 0])), forged: {} };
    this.violations = [];
    this.lastStatus = null;
    this.snapSeq = 0;
  }

  units() { return Object.keys(this.oracle.model.units); }
  raw() { try { return JSON.parse(readFileSync(this.fx.stateFile(), 'utf8')); } catch { return null; } }
  behaviour() { return JSON.parse(readFileSync(join(this.fx.root, 'behaviour.json'), 'utf8')); }
  setBehaviour(id, b) { const all = this.behaviour(); all[id] = b; writeFileSync(join(this.fx.root, 'behaviour.json'), J(all)); }

  snapshot() {
    const id = `s${++this.snapSeq}`;
    mkdirSync(this.snapDir, { recursive: true });
    cpSync(this.fx.root, join(this.snapDir, id), { recursive: true });
    return { id, mem: structuredClone(this.mem), oracle: structuredClone(this.oracle.mem), status: this.lastStatus };
  }
  restore(s) {
    rmSync(this.fx.root, { recursive: true, force: true });
    cpSync(join(this.snapDir, s.id), this.fx.root, { recursive: true });
    this.mem = structuredClone(s.mem);
    this.oracle.mem = structuredClone(s.oracle);
    this.lastStatus = s.status;
  }
  drop(s) { rmSync(join(this.snapDir, s.id), { recursive: true, force: true }); }

  /** Run one engine command and check it. */
  async run(action, cmd, flags = {}) {
    const pre = this.oracle.facts();
    // An owner edit between commands runs no command: the oracle checks the engine's claims (status) after it.
    const res = cmd === null ? { status: 0, out: {}, stdout: '{}', stderr: '' } : await cliAsync(this.fx, cmd, flags);
    const v = await this.oracle.check({ ...action, cmd }, res, pre);
    this.lastStatus = this.oracle.lastStatus;
    for (const x of v) this.violations.push({ ...x, trace: [...this.mem.trace] });
    if (process.env.ENGINE_EXPLORE_DEBUG) process.stderr.write(`${this.mem.trace.join(' > ')}\n    -> ${res.status} ${res.out?.code ?? res.out?.outcome ?? res.stderr.trim().slice(0, 120)} ${v.length ? J(v) : ''}\n`);
    return res;
  }
  async gate(action, kind, input) {
    if (this.capture) { this.capture = false; return { prepared: { action, kind, input } }; }
    const file = join(this.fx.root, `in-${this.mem.trace.length}-${++this.mem.rx}.json`);
    writeFileSync(file, J(input));
    return this.run(action, `gate ${kind}`, { input: file });
  }

  /** Build (with its owner appends and behaviour) the gate input action `a` would submit, without submitting it. */
  async prepare(a) {
    this.capture = true;
    const r = await this.apply(a);
    if (!r?.prepared) throw new Error(`${J(a)} is not a gate action`);
    return r.prepared;
  }

  /**
   * Check a command run in-process by the caller (`fn` returns the command's result object, or
   * throws when a hook simulates a crash): exit status as the CLI would map it.
   */
  async inProcess(action, fn) {
    this.mem.trace.push(J(action));
    const pre = this.oracle.facts();
    let out = null, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    const status = error ? null : (out?.outcome === 'judgment' || (out?.gate && (!out.ok || out.judgment_point === true))) ? 2 : 0;
    const res = { status, out, stdout: J(out), stderr: error ? String(error.message) : '' };
    const v = await this.oracle.check({ ...action, crashed: Boolean(error) }, res, pre);
    this.lastStatus = this.oracle.lastStatus;
    for (const x of v) this.violations.push({ ...x, trace: [...this.mem.trace] });
    return { ...res, error };
  }

  /** The unit review binding the orchestrator would name (raw state digests, current evidence). */
  bound(u) {
    const S = this.raw(), ev = S.unit_checks[u].evidence;
    return { unit: u, approved_plan_digest: S.plan_digest, dag_digest: S.dag_digest, base_commit: ev?.binding.base_commit ?? 'none', id: ev?.id ?? 'none' };
  }
  firstWrite(u) { return this.oracle.model.units[u].writes[0]; }
  lastUnitRx(u) { return this.raw().unit_reviews[u].chain.findLast(r => r.kind === 'original')?.review_execution ?? null; }
  newRx(prefix) { this.mem.rx += 1; return `${prefix}-${this.mem.rx}`; }

  /** Owner RETRY when unit `u`'s last review is terminal (or `force`). Returns the rx to use. */
  retryIfTerminal(u, rx) {
    const r = this.lastStatus?.units?.[u]?.review;
    if (r?.terminal) this.oracle.ownerAppend({ run_id: 'run-1', event: 'RETRY', review_execution: rx, predecessor: r.review_execution, authorized_by: 'owner' });
  }

  /** Enabled actions of the current state (state-changing first). */
  enabled() {
    const S = this.raw(), st = this.lastStatus;
    if (!S || !st) return [{ kind: 'drive' }];
    const out = [];
    const rev = (u) => st.units?.[u]?.review ?? {};
    const reviewsOn = Boolean(S.unit_reviews);
    for (const u of this.units()) {
      const ev = S.unit_checks[u]?.evidence;
      const r = rev(u);
      const reviewable = ev?.state === 'verified' && r.state !== 'pass' && !(r.state === 'fail' && !r.terminal);
      // On stale evidence only the PASS probe (a refusal unless the freshness guard is broken).
      if (reviewsOn && reviewable) out.push(...(st.units[u].state === 'verified' ? [{ kind: 'ufail', unit: u }] : []), { kind: 'upass', unit: u });
      if (reviewsOn && r.awaiting === 'confirmation') out.push({ kind: 'uconf', unit: u }, { kind: 'uconfFail', unit: u });
      if (this.mem.forged[u] && r.terminal) out.push({ kind: 'useForged', unit: u });
      if ((st.judgments ?? []).some(j => j.code === 'unit_invalidation_storm' && j.node === u) || (S.freeze && ev?.state === 'failed')) out.push({ kind: 'clear', unit: u });
    }
    const prev = this.mem.trace.at(-1);
    if (prev !== J({ kind: 'drive' })) out.push({ kind: 'drive' }); // a second drive in a row changes nothing (dedup would drop it)
    const allPass = !reviewsOn || this.units().every(u => rev(u).state === 'pass');
    const originals = S.review_chain.filter(r => r.kind === 'original');
    const last = S.review_chain.at(-1);
    if (allPass && !originals.length && !S.freeze) out.push({ kind: 'finalFail' });
    if (allPass && (!originals.length || (reviewsOn && last?.outcome === 'PASS' && !this.consumedNow(last)))) out.push({ kind: 'final' });
    if (allPass && last?.kind === 'repair') out.push({ kind: 'fconf' });
    if (last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' && !S.ship_ready) out.push({ kind: 'ship' });
    for (const [id, n] of Object.entries(S.nodes)) if (n.state === 'failed') out.push({ kind: 'mark', node: id });
    for (const p of Object.keys(this.world.inputs)) {
      if (this.mem.inputs[p] === 0) out.push({ kind: 'edit', path: p });
      if (this.mem.inputs[p] > 0) out.push({ kind: 'revert', path: p });
    }
    if (prev !== J({ kind: 'resume' })) out.push({ kind: 'resume' });
    for (const a of out) a.ctx = this.context(a, S, st);
    return out;
  }

  /**
   * The interaction context of action `a` here (part of its coverage label): the review and
   * evidence state of the unit it touches, whether a repair cycle holds ceiling slots and for whom,
   * the spent ceiling, the node's retries, open judgments and the freeze. The explorer prefers
   * states offering actions in contexts not tried yet, which is how cross-unit interactions
   * (another unit's re-check while slots are held, a third invalidation, a second mark) get reached.
   */
  context(a, S, st) {
    const holds = (S.unit_ceiling?.holds ?? []).map(h => h.unit);
    const unitOf = a.unit ?? (a.path ? this.units().find(u => this.oracle.model.units[u].paths.includes(a.path)) : null);
    const r = unitOf ? st.units?.[unitOf]?.review ?? {} : null;
    const parts = [
      unitOf ? `${st.units?.[unitOf]?.state}/${r.state ?? '-'}${r.awaiting ? `/${r.awaiting}` : ''}${r.terminal ? '/T' : ''}/inv${S.unit_checks[unitOf].invalidations ?? 0}` : '',
      holds.length ? `held:${holds.map(h => (h === unitOf ? 'self' : 'other')).join('+')}` : '',
      `used${Math.min(S.unit_ceiling?.used ?? 0, this.oracle.limit)}of${this.oracle.limit}`,
      a.node ? `retries${S.nodes[a.node].retries}` : '',
      ['drive', 'resume', 'final', 'ship'].includes(a.kind) ? [...new Set((st.judgments ?? []).map(j => j.code))].sort().join('+') : '',
      ['drive', 'resume'].includes(a.kind) ? this.units().map(u => `${u}=${st.units?.[u]?.state}/${st.units?.[u]?.review?.state ?? '-'}`).join(',') : '',
      S.freeze ? 'frozen' : '',
    ];
    return parts.filter(Boolean).join('|');
  }

  consumedNow(record) {
    const S = this.raw();
    return this.units().every(u => (record.units_consumed ?? []).some(c => c.unit === u && c.evidence_id === S.unit_checks[u].evidence?.id));
  }

  /** Apply one action (an engine command, or an owner edit/append followed by its command). */
  async apply(a) {
    const { ctx: _ctx, ...plain } = a;
    a = plain;
    const fx = this.fx, label = J(a);
    this.mem.trace.push(label);
    const u = a.unit;
    switch (a.kind) {
      case 'drive': return this.run(a, 'drive');
      case 'resume': return this.run(a, 'resume');
      case 'edit': case 'revert': {
        this.mem.edits = (this.mem.edits ?? 0) + 1;
        this.mem.inputs[a.path] = a.kind === 'edit' ? this.mem.edits : 0;
        this.oracle.edit(a.path, a.kind === 'edit' ? `${this.world.inputs[a.path]} edit ${this.mem.edits}` : this.world.inputs[a.path]);
        return this.run(a, null);
      }
      case 'upass': case 'ufail': {
        const rx = this.newRx(`urx-${u}`);
        this.retryIfTerminal(u, rx);
        const { id, ...b } = this.bound(u);
        let input;
        if (a.kind === 'upass') { const { second_opinion: _s, ...r } = passReview(rx, id); input = { ...b, ...r }; }
        else {
          const key = `fix${u}`, n = this.mem.rx;
          const fix = { write: { [this.firstWrite(u)]: `fixed ${n}` } };
          if (a.forge) { fix.appendLate = { run_id: 'run-1', event: 'RETRY', review_execution: `forged-${u}`, predecessor: rx, authorized_by: 'owner' }; this.mem.forged[u] = `forged-${u}`; }
          this.setBehaviour(key, fix);
          const { second_opinion: _s, ...r } = failReview(rx, id, this.firstWrite(u), fx.prompt(key));
          input = { ...b, ...r };
        }
        return this.gate({ ...a, rx }, 'unit-review', input);
      }
      case 'useForged': {
        const rx = this.mem.forged[u];
        const { id, ...b } = this.bound(u);
        const { second_opinion: _s, ...r } = passReview(rx, id);
        return this.gate({ ...a, rx }, 'unit-review', { ...b, ...r });
      }
      case 'uconf': case 'uconfFail': {
        const rx = this.lastStatus.units[u].review.review_execution;
        const { id, ...b } = this.bound(u);
        const c = confirmReview(rx, id);
        c.primary.outcome = a.kind === 'uconf' ? 'PASS' : 'FAIL';
        return this.gate({ ...a, rx }, 'unit-review', { ...b, ...c });
      }
      case 'final': case 'finalFail': {
        const S = this.raw(), cand = this.oracle.candidate();
        const rx = this.newRx('rx');
        const prev = S.review_chain.filter(r => r.kind === 'original').at(-1);
        if (prev) this.oracle.ownerAppend({ run_id: 'run-1', event: 'RETRY', review_execution: rx, predecessor: prev.review_execution, authorized_by: 'owner' });
        const rows = (this.world.acceptanceIds ?? ['AC1']).map(id => ({ criterion: id, outcome: 'PASS', evidence: id }));
        const consumed = S.unit_reviews ? { units_consumed: this.units().map(x => ({ unit: x, evidence_id: S.unit_checks[x].evidence?.id })) } : {};
        let input;
        if (a.kind === 'final') input = passReview(rx, cand, { primary: primaryReview(cand, { acceptance_criteria: rows }), ...consumed });
        else {
          const path = this.firstWrite(this.units()[0]);
          this.setBehaviour('ffix', { write: { [path]: `final fix ${this.mem.rx}` } });
          input = { ...failReview(rx, cand, path, fx.prompt('ffix')), ...consumed };
          input.primary.acceptance_criteria = rows.map((r, i) => (i === 0 ? { ...r, outcome: 'FAIL' } : r));
        }
        return this.gate({ ...a, rx }, 'review', input);
      }
      case 'fconf': {
        const S = this.raw(), rx = S.review_chain.at(-1).review_execution;
        const consumed = S.unit_reviews ? { units_consumed: this.units().map(x => ({ unit: x, evidence_id: S.unit_checks[x].evidence?.id })) } : {};
        return this.gate({ ...a, rx }, 'review', { ...confirmReview(rx, this.oracle.candidate()), ...consumed });
      }
      case 'ship': return this.gate(a, 'ship-ready', {});
      case 'mark': return this.run({ ...a, transition: 'failed->pending' }, 'mark', { node: a.node, transition: 'failed->pending', reason: 'explore' });
      case 'clear': {
        const S = this.raw();
        this.oracle.ownerAppend({ run_id: 'run-1', event: 'UNIT_CLEAR', unit: u, predecessor: S.unit_checks[u].evidence.id, authorized_by: 'owner', reason: `explore ${this.mem.trace.length}` });
        return this.run(a, 'clear-unit', { unit: u });
      }
      case 'setFail': this.setBehaviour(a.node, { write: { [this.oracle.model.byId[a.node].writes[0]]: `broken ${this.mem.trace.length}` }, exit: 1 }); return this.run(a, null);
      case 'setPass': this.setBehaviour(a.node, { write: { [this.oracle.model.byId[a.node].writes[0]]: `ok ${this.mem.trace.length}` } }); return this.run(a, null);
      default: throw new Error(`unknown action ${label}`);
    }
  }

  /** Projected state for de-duplication (no ids, timestamps or seqs). */
  key() {
    const S = this.raw(), st = this.lastStatus;
    if (!S) return 'none';
    return J({
      nodes: Object.entries(S.nodes).map(([id, n]) => [id, n.state, n.attempts, n.retries]),
      units: this.units().map(u => [u, st?.units?.[u]?.state, st?.units?.[u]?.review?.state, st?.units?.[u]?.review?.awaiting ?? null, Boolean(st?.units?.[u]?.review?.terminal),
        (S.unit_reviews?.[u]?.chain ?? []).map(r => `${r.kind}:${r.outcome ?? ''}`).join(',')]),
      ceiling: [S.unit_ceiling?.used ?? 0, (S.unit_ceiling?.holds ?? []).map(h => `${h.unit}:${h.slots.join('+')}`)],
      judgments: (st?.judgments ?? []).map(j => `${j.code}:${j.node}`).sort(),
      repairs: S.repairs.map(r => `${r.id}:${r.state}`),
      final: S.review_chain.map(r => `${r.kind}:${r.outcome ?? ''}`), freeze: Boolean(S.freeze), ship: Boolean(S.ship_ready),
      inputs: Object.values(this.mem.inputs).map(Boolean), forged: Object.keys(this.mem.forged),
    });
  }

  /** How far into the workflow this state is (frontier tie-break: deeper review/repair/ship states first). */
  progress() {
    const S = this.raw();
    if (!S) return 0;
    const chains = Object.values(S.unit_reviews ?? {}).flatMap(R => R.chain);
    return chains.length + 3 * chains.filter(r => r.kind === 'confirmation' || r.kind === 'repair').length + 2 * (S.unit_ceiling?.holds ?? []).length
      + 2 * S.review_chain.length + (S.freeze ? 3 : 0) + (S.ship_ready ? 5 : 0) + (S.unit_ceiling?.used ?? 0)
      + Object.values(S.nodes).reduce((t, n) => t + (n.retries ?? 0), 0);
  }

  /** Coarse features used to keep the exploration frontier diverse. */
  features() {
    const S = this.raw(), st = this.lastStatus;
    const f = new Set();
    for (const u of this.units()) {
      const r = st?.units?.[u]?.review;
      f.add(`${u}:${st?.units?.[u]?.state}:${r?.state}:${r?.awaiting ?? ''}:${r?.terminal ? 'T' : ''}`);
    }
    for (const j of st?.judgments ?? []) f.add(`j:${j.code}`);
    if ((S?.unit_ceiling?.holds ?? []).length) f.add('held');
    f.add(`used:${S?.unit_ceiling?.used ?? 0}`);
    if (S?.freeze) f.add('freeze');
    if (S?.ship_ready) f.add('ship');
    for (const [id, n] of Object.entries(S?.nodes ?? {})) f.add(`${id}:${n.state}:${n.retries}`);
    return [...f];
  }
}

/** Label of an action for coverage bookkeeping (kind plus its target). */
export const label = (a) => [a.kind, a.unit ?? a.node ?? a.path ?? '', a.ctx ?? ''].join(':');

/**
 * Bounded deterministic exploration, coverage-guided best-first over projected states. From the
 * root (init + first drive) the explorer repeatedly picks the queued state with the most enabled
 * actions not yet tried anywhere (then the furthest workflow progress, then the shallowest, then
 * the earliest), and applies every enabled action of it once, each on a restored copy, checking the
 * oracle after each; the end states of the directed `roots` prefixes are expanded first. New
 * projected states are queued (at most `depth` actions deep). It stops after
 * `budget` transitions. Deterministic: no randomness, ties broken by discovery order. Returns counts
 * and violations.
 */
export async function explore(t, world, config, { depth = 10, budget = 60, roots = [] } = {}) {
  const d = await Driver.create(t, world, config);
  await d.apply({ kind: 'drive' });
  const seen = new Set([d.key()]), tried = new Set();
  const base = d.snapshot();
  const queue = [{ snap: base, enabled: d.enabled(), progress: d.progress(), depth: 0, order: 0 }];
  let transitions = 1, order = 0, maxDepth = 0, expanded = 0;
  // Directed prefixes into the interactions the contract is about (each step oracle-checked); their end states start queued.
  // The prefixes spend the same budget (PR #38 4507604538): a budget below their cost stops them, and a partly applied one is not queued.
  for (const prefix of roots) {
    if (transitions + prefix.length > budget) break;
    d.restore(base);
    for (const a of prefix) { await d.apply(a); transitions += 1; seen.add(d.key()); }
    queue.push({ snap: d.snapshot(), enabled: d.enabled(), progress: d.progress(), depth: prefix.length, order: ++order, pinned: true });
  }
  const actionsTried = {};
  const untried = (n) => n.enabled.filter(a => !tried.has(label(a))).length;
  while (queue.length && transitions < budget) {
    queue.sort((x, y) => (Number(Boolean(y.pinned)) - Number(Boolean(x.pinned))) || (x.pinned && y.pinned ? x.order - y.order : 0) || (untried(y) - untried(x)) || (y.progress - x.progress) || (x.depth - y.depth) || (x.order - y.order));
    const node = queue.shift();
    expanded += 1;
    for (const a of node.enabled) {
      if (transitions >= budget) break;
      d.restore(node.snap);
      await d.apply(a);
      transitions += 1;
      tried.add(label(a));
      actionsTried[a.kind] = (actionsTried[a.kind] ?? 0) + 1;
      const k = d.key();
      if (seen.has(k) || node.depth + 1 >= depth) continue;
      seen.add(k);
      maxDepth = Math.max(maxDepth, node.depth + 1);
      queue.push({ snap: d.snapshot(), enabled: d.enabled(), progress: d.progress(), depth: node.depth + 1, order: ++order });
    }
    d.drop(node.snap);
  }
  for (const node of queue) d.drop(node.snap);
  return { states: seen.size, transitions, expanded, maxDepth, actionsTried, labelsTried: tried.size, violations: d.violations, observed: d.oracle.observed };
}

/** Directed prefixes for the two-unit world (see explore `roots`). */
export function twoUnitRoots(mode) {
  const A = 'uA', B = 'uB';
  return [
    [{ kind: 'ufail', unit: A }, { kind: 'drive' }], // repaired, awaiting its confirmation (confirmation slot held)
    [{ kind: 'ufail', unit: A }, { kind: 'edit', path: 'docs/in-b.txt' }], // A holds slots; unrelated B is stale (its re-check is next)
    [{ kind: 'upass', unit: A }, { kind: 'upass', unit: B }], // both units reviewed: the final review is next
    [{ kind: 'edit', path: 'docs/in.txt' }, { kind: 'drive' }, { kind: 'revert', path: 'docs/in.txt' }, { kind: 'drive' }], // two invalidations of A
    ...(mode === 'fail' || mode === 'infra' ? [[{ kind: 'mark', node: 'i' }, { kind: 'drive' }]] : []), // the integration node's one retry
  ];
}
