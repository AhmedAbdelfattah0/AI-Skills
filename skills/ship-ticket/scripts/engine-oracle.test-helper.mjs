/**
 * Independent test oracle for the run engine's 12-property contract
 * (.specs/reviews/AIS-HARNESS-3/PROPERTIES.md). Not a test file.
 *
 * Independence rule: every verdict here is derived from observable facts only: files on disk (its
 * own sha256 of their bytes), raw `state.json` fields, the RUN-STATE text, `runs.log`, the exit code
 * and stdout of the command, `git rev-parse`, and process-group liveness. It never imports or calls
 * an engine decision function (unitStates, reviewStates, ceiling, units, closure, ...): the unit
 * structure is re-derived here from the DAG the test wrote, from the documented contract.
 *
 * Usage: `const o = new Oracle(fx, nodes, config)` right after `init`; around every command
 * `const pre = o.facts(); const res = await cli(...); const v = await o.check(action, res, pre)`.
 * `v` lists violations [{ property, detail }]. `o.mem` is plain data (structuredClone it with a
 * snapshot of the fixture root to explore branches). Owner RUN-STATE lines go through
 * `o.ownerAppend(event)` so authority provenance (P2) can be judged.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));
const BEGIN = '<!-- RUN-STATE:BEGIN -->';
const END = '<!-- RUN-STATE:END -->';
/** Attempt statuses during which dispatched code may still run (the documented live set). */
const LIVE = ['intent', 'launched', 'running', 'unknown'];
/** Coded refusals a CLI command may print as `run-engine: <code>: ...` with exit 1 (P11). */
const EXIT1_REFUSALS = ['mark_refused', 'retry_cap', 'unit_clear_refused', 'unit_clear_unauthorized', 'approval_mismatch', 'dag_mismatch',
  'run_mismatch', 'run_state_malformed', 'lock_held', 'lock_foreign_host', 'lock_malformed'];
const AUTHORITY = ['START', 'DAG_BOUND', 'RETRY', 'UNIT_CLEAR'];
const hex = (b) => createHash('sha256').update(b).digest('hex');
const J = JSON.stringify;

/** Run the real engine CLI asynchronously (so several fixtures can explore at once). */
export function cliAsync(fx, cmd, flags = {}, { timeout = 60000 } = {}) {
  const args = [ENGINE_CLI, ...cmd.split(' '), '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1',
    ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: fx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      let out = null;
      try { out = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ status: timedOut ? null : status, out, stdout, stderr, timedOut });
    });
  });
}

/** Own parse of the RUN-STATE block: the JSON lines between the first BEGIN and the last END. */
export function runStateLines(text) {
  const b = text.indexOf(BEGIN), e = text.lastIndexOf(END);
  if (b < 0 || e < b) return [];
  return text.slice(b + BEGIN.length, e).split('\n').filter(l => l.trim().startsWith('{')).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const narrative = (text) => text.slice(0, text.indexOf(BEGIN) + BEGIN.length) + text.slice(text.indexOf(END));

/** The unit structure of a DAG, re-derived from the documented contract (engine-units.mjs header), not imported. */
export function unitModel(nodes) {
  const byId = Object.fromEntries(nodes.map(n => [n.id, { deps: [], reads: [], writes: [], ...n }]));
  const U = {};
  for (const n of Object.values(byId)) if (n.unit !== undefined) {
    const u = (U[n.unit] ??= { members: [], paths: [], upstream: [], upstreamPaths: [], deps: [], writes: [] });
    u.members.push(n.id);
    for (const p of [...n.reads, ...n.writes]) if (!u.paths.includes(p)) u.paths.push(p);
    for (const p of n.writes) if (!u.writes.includes(p)) u.writes.push(p);
  }
  for (const [name, u] of Object.entries(U)) {
    const seen = new Set(), queue = u.members.flatMap(id => byId[id].deps);
    while (queue.length) {
      const d = byId[queue.shift()];
      if (seen.has(d.id) || d.unit === name) continue;
      seen.add(d.id);
      u.upstream.push(d.id);
      if (d.unit !== undefined) { if (!u.deps.includes(d.unit)) u.deps.push(d.unit); }
      else for (const p of [...d.reads, ...d.writes]) if (!u.upstreamPaths.includes(p)) u.upstreamPaths.push(p);
      queue.push(...d.deps);
    }
  }
  return { byId, units: U };
}

/** Every regular file under the work tree (minus .git and the plan dir) with its own sha256. */
function treeHashes(repo) {
  const out = {};
  const walk = (rel) => {
    for (const k of readdirSync(join(repo, rel || '.'))) {
      const r = rel ? `${rel}/${k}` : k;
      if (r === '.git' || r === '.specs') continue;
      const st = lstatSync(join(repo, r));
      if (st.isDirectory()) walk(r); else out[r] = hex(readFileSync(join(repo, r)));
    }
  };
  walk('');
  return out;
}

const ownHash = (repo, rel) => { try { return hex(readFileSync(join(repo, rel))); } catch { return 'missing'; } };
/** The content hash inside an engine fingerprint ('missing', 'f:<mode>:sha256:<hex>'); null for any other kind. */
const fpHash = (fp) => (fp === 'missing' ? 'missing' : /^f:[0-7]+:sha256:([0-9a-f]{64})$/.exec(fp ?? '')?.[1] ?? null);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export class Oracle {
  /**
   * @param fx engine-test-fixture fixture (after `init`)
   * @param nodes the node list given to the fixture (DAG facts)
   * @param opts { limit: config.unitRecheckCeiling (default 4), strictRuns: no crash expected, sleepers: [pidfile] }
   */
  constructor(fx, nodes, { limit = 4, strictRuns = true, sleepers = [] } = {}) {
    this.fx = fx;
    this.model = unitModel(nodes);
    this.limit = limit;
    this.strictRuns = strictRuns;
    this.sleepers = sleepers;
    const plan = readFileSync(fx.planFile, 'utf8');
    this.mem = {
      step: 0,
      narrative: hex(narrative(plan)),
      dag: hex(readFileSync(fx.dagFile)),
      owner: runStateLines(plan).filter(e => AUTHORITY.includes(e.event)).map(e => J(e)),
      edits: [], // { step, path }
      fails: {}, // unit review execution -> { step, unit, attempts }
      marks: {}, // node -> accepted failed->pending count
      used: 0,
      finalAccepted: null, // { step, files }
    };
    /** Disclosed limits and milestones reached, across all explored branches (never restored with `mem`). */
    this.observed = { parent_ceiling_while_held: 0, unit_review_terminal: 0, retry_cap: 0, ship_ready: 0, confirmations: 0, repairs_bound: 0 };
  }

  /** Owner RUN-STATE append between commands (recorded as owner authority, P2). */
  ownerAppend(event) {
    const text = readFileSync(this.fx.planFile, 'utf8');
    writeFileSync(this.fx.planFile, text.replace(END, J(event) + '\n' + END));
    this.mem.owner.push(J(event));
  }

  /** A test edit of a work-tree file between commands (P5/P6 bookkeeping). */
  edit(rel, content) {
    writeFileSync(join(this.fx.repo, rel), content);
    this.mem.edits.push({ step: this.mem.step, path: rel });
  }

  /** Observable facts at this instant. */
  facts() {
    const fx = this.fx;
    let raw = null, stateText = null;
    try { stateText = readFileSync(fx.stateFile(), 'utf8'); raw = JSON.parse(stateText); } catch { /* no state */ }
    const runs = {};
    try { for (const l of readFileSync(join(fx.root, 'runs.log'), 'utf8').split('\n')) if (l) runs[l] = (runs[l] ?? 0) + 1; } catch { /* none yet */ }
    const plan = readFileSync(fx.planFile, 'utf8');
    const head = spawnSync('git', ['rev-parse', 'HEAD^{commit}'], { cwd: fx.repo, encoding: 'utf8' }).stdout.trim();
    return { raw, stateText, runs, plan, files: treeHashes(fx.repo), head, dag: hex(readFileSync(fx.dagFile)) };
  }

  candidate() {
    const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', this.fx.repo, '--base', 'HEAD', '--exclude', '.specs/plans/T-1.md', '--exclude', 'session-log.md'], { encoding: 'utf8' });
    return r.status === 0 ? JSON.parse(r.stdout).candidate_id : null;
  }

  /** Prompt key (NODE=<key>) of a prompt file. */
  promptKey(file) { try { return /NODE=(\S+)/.exec(readFileSync(file, 'utf8'))?.[1] ?? null; } catch { return null; } }

  /**
   * Whether unit `u`'s current evidence is fresh by the oracle's own reading (P5), with the reason
   * when not. Unknowable path kinds (directories) answer null (never a violation).
   */
  fresh(F, u, seen = new Set()) {
    const S = F.raw, U = this.model.units[u], ev = S?.unit_checks?.[u]?.evidence;
    if (!ev) return { fresh: false, why: 'no evidence' };
    if (ev.state !== 'verified') return { fresh: false, why: `evidence ${ev.state}` };
    const b = ev.binding ?? {};
    for (const [p, list] of [...U.paths.map(p => [p, b.fps]), ...U.upstreamPaths.map(p => [p, b.upstream_fps])]) {
      if (!list || !(p in list)) return { fresh: false, why: `binding lacks ${p}`, unbound: true };
      const want = fpHash(list[p]);
      if (want === null) return { fresh: null, why: `${p} is not a file` };
      const now = F.files[p] ?? 'missing';
      if (now !== want) return { fresh: false, why: `${p} changed since the check` };
    }
    if (b.base_commit !== F.head) return { fresh: false, why: 'base moved' };
    const settled = (id, member) => ['done', 'cancelled'].includes(S.nodes[id].state) || (member && S.nodes[id].unit_check_failed);
    for (const m of U.members) {
      if ((S.nodes[m].attempts ?? 0) !== b.attempts?.[m]) return { fresh: false, why: `member ${m} re-ran` };
      if (!settled(m, true)) return { fresh: false, why: `member ${m} is ${S.nodes[m].state}` };
    }
    for (const n of U.upstream) {
      if ((S.nodes[n].attempts ?? 0) !== b.upstream?.[n]) return { fresh: false, why: `upstream ${n} re-ran` };
      if (!settled(n, false)) return { fresh: false, why: `upstream ${n} is ${S.nodes[n].state}` };
    }
    for (const d of U.deps) {
      if (seen.has(d)) continue;
      if (b.deps?.[d] !== S.unit_checks[d]?.evidence?.id) return { fresh: false, why: `dependency ${d} re-checked` };
      const df = this.fresh(F, d, new Set([...seen, u]));
      if (df.fresh === false) return { fresh: false, why: `dependency ${d}: ${df.why}` };
    }
    return { fresh: true };
  }

  /**
   * Check the oracle's share of the properties after one command (PROPERTIES.md, "Oracle check" column; not everything a property means). `action` = { kind, cmd, unit?, rx?, input?, crashed? };
   * `res` = cli result; `pre` = facts() before the command. Runs `status` itself (the engine's
   * claims) and checks it writes nothing. Returns violations.
   */
  async check(action, res, pre) {
    const v = [];
    const bad = (property, detail) => v.push({ property, detail: `${action.kind}: ${detail}` });
    const M = this.mem;
    M.step += 1;
    const post = this.facts();
    const S = post.raw, P = pre.raw;
    const st = await cliAsync(this.fx, 'status');
    const after = (() => { try { return readFileSync(this.fx.stateFile(), 'utf8'); } catch { return null; } })();
    if (after !== post.stateText) bad('P11', 'status changed the state file');
    this.lastStatus = st.out;
    // A state file that existed before the command and is gone or unparsable after it is lost progress (PR #38 4507604542).
    if (!S) { if (P) bad('P11', 'the state file existed before the command and is missing or unparsable after it'); return v; }
    this.livePgids = S.attempts.filter(a => LIVE.includes(a.status) && a.pgid).map(a => a.pgid); // for the caller's cleanup
    const status = st.out;
    this.lastStatus = status;
    const cmd = action.cmd === null ? 'none' : action.cmd ?? action.kind;
    const ok = res.status === 0;
    const gateKind = cmd.startsWith('gate ') ? cmd.slice(5) : null;
    const code = res.out?.code;

    // ---- P11 bounded progress -------------------------------------------------------------
    if (!action.crashed) {
      if (res.status === null) bad('P11', `command did not return (timeout)`);
      else if (res.status === 0 || res.status === 2) {
        if (!res.out) bad('P11', `exit ${res.status} without JSON: ${res.stdout.slice(0, 200)} ${res.stderr.slice(0, 200)}`);
        else if (res.status === 2) {
          const explained = (code && Array.isArray(res.out.reasons) && res.out.reasons.length) || (res.out.outcome === 'judgment' && res.out.judgments?.length);
          if (!explained) bad('P11', `exit 2 with no code/reasons or judgment: ${res.stdout.slice(0, 300)}`);
        }
        if (cmd === 'drive' && res.out?.outcome === 'waiting') {
          const liveNow = S.attempts.some(a => LIVE.includes(a.status));
          // A stale or pending unit is the next drive's check (Wave 2a minor: each unit is checked at most once per command).
          const unitsOpen = Object.values(res.out.units ?? {}).some(p => p.state !== 'verified');
          if (!liveNow && !(res.out.unit_reviews_pending?.length || res.out.red_pending?.length || unitsOpen)) bad('P11', `drive waiting on nothing: ${J({ nodes: res.out.nodes, units: Object.fromEntries(Object.entries(res.out.units ?? {}).map(([u, p]) => [u, p.state])) })}`);
        }
        // A failed final-review repair is terminal for its execution: `done` would be a false completion (PR #38 4505924571).
        if (cmd === 'drive' && res.out?.outcome === 'done' && S.repairs.some(r => r.state === 'failed' && r.kind !== 'unit-review')) {
          bad('P11', `drive reported done with a failed repair: ${J(S.repairs.filter(r => r.state === 'failed').map(r => r.id))}`);
        }
      } else if (res.status === 1) {
        const m = /^run-engine: ([a-z_]+): /.exec(res.stderr);
        if (!m || !EXIT1_REFUSALS.includes(m[1])) bad('P11', `exit 1 is not a coded refusal: ${res.stderr.slice(0, 300)}`);
        if (m?.[1] === 'retry_cap') this.observed.retry_cap += 1;
      } else bad('P11', `unexpected exit ${res.status}: ${res.stderr.slice(0, 300)}`);
    }
    if (st.status !== 0) bad('P11', `status failed: ${st.stderr.slice(0, 300)}`);

    // ---- P1 approval binding --------------------------------------------------------------
    const bound = hex(narrative(pre.plan)) === M.narrative && pre.dag === M.dag;
    const newAttempts = S.attempts.filter(a => !(P?.attempts ?? []).some(b => b.attempt_id === a.attempt_id));
    const recorded = gateKind && ok && ['review_accepted', 'unit_review_accepted', 'red_accepted', 'ship_ready'].includes(code);
    if (!bound && (recorded || newAttempts.some(a => a.pid))) bad('P1', `ran or recorded while the plan narrative or DAG differed from the binding`);
    // A unit check that drifted the binding mid-command: nothing dispatches after it in that command (PR #38 4507607938).
    const cmdEvents = (S.events ?? []).filter(e => e.seq > (P?.seq ?? 0)), drop = cmdEvents.find(e => e.type === 'UNIT_CHECK_DROPPED');
    if (drop && cmdEvents.some(e => e.type === 'DISPATCH' && e.seq > drop.seq)) bad('P1', `dispatched after unit ${drop.unit}'s checks drifted the binding`);

    // ---- P2 authority provenance ----------------------------------------------------------
    for (const line of S.authority?.trusted ?? []) if (!M.owner.includes(line)) bad('P2', `trusted authority line not appended by the owner: ${line}`);
    const owner = M.owner.map(l => JSON.parse(l));
    const chains = [['final', S.review_chain ?? []], ...Object.entries(S.unit_reviews ?? {}).map(([u, R]) => [u, R.chain])];
    for (const [who, chain] of chains) for (const r of chain) if (r.kind === 'retry'
      && !owner.some(e => e.event === 'RETRY' && e.review_execution === r.review_execution && e.predecessor === r.predecessor && e.run_id === 'run-1')) {
      bad('P2', `${who} chain retry ${r.review_execution} has no owner RETRY`);
    }
    for (const [u, rec] of Object.entries(S.unit_checks ?? {})) for (const c of rec.clears ?? []) {
      if (!owner.some(e => e.event === 'UNIT_CLEAR' && e.unit === u && e.predecessor === c.predecessor)) bad('P2', `unit ${u} cleared without an owner UNIT_CLEAR`);
    }

    // ---- P3 exclusive execution -----------------------------------------------------------
    const keyOf = (a) => this.promptKey(a.kind === 'repair' ? S.repairs.find(r => r.id === a.node)?.promptFile : S.nodes[a.node]?.promptFile);
    const dispatched = {};
    for (const a of S.attempts) if (['node', 'repair'].includes(a.kind) && a.pid) { const k = keyOf(a); dispatched[k] = (dispatched[k] ?? 0) + 1; }
    // Every key either side knows (PR #38 4507604550): under strictRuns a released dispatch that never ran is a violation too.
    for (const k of new Set([...Object.keys(post.runs), ...Object.keys(dispatched)])) {
      const n = post.runs[k] ?? 0;
      if (n > (dispatched[k] ?? 0)) bad('P3', `${k} ran ${n} times for ${dispatched[k] ?? 0} released dispatch(es)`);
      else if (this.strictRuns && !action.crashed && n !== (dispatched[k] ?? 0)) bad('P3', `${k} ran ${n} times for ${dispatched[k]} released dispatch(es)`);
    }
    const liveBy = {};
    for (const a of S.attempts) if (LIVE.includes(a.status)) { const k = `${a.kind}:${a.node}`; if (liveBy[k]) bad('P3', `two live attempts on ${k}`); liveBy[k] = true; }

    // ---- P4 quiescence ---------------------------------------------------------------------
    for (const a of S.attempts) if (!LIVE.includes(a.status) && a.quiesced !== true) bad('P4', `attempt ${a.attempt_id} ${a.status} without quiesced`);
    for (const [r, holder] of Object.entries(S.locks ?? {})) if (!S.attempts.some(a => a.attempt_id === holder && LIVE.includes(a.status))) bad('P4', `lock ${r} held by non-live ${holder}`);
    for (const a of S.attempts) {
      const was = P?.attempts?.find(b => b.attempt_id === a.attempt_id);
      if (LIVE.includes(a.status) || (was && !LIVE.includes(was.status)) || !a.pgid) continue;
      try { process.kill(-a.pgid, 0); bad('P4', `attempt ${a.attempt_id} (${a.kind} ${a.node}) is ${a.status} but its process group ${a.pgid} is alive`); } catch { /* gone */ }
    }
    for (const { file, node } of this.sleepers) {
      // Checked in the command that retired the sleeper's worker (an old pid file may name a reused pid later).
      const retired = S.attempts.some(a => a.kind === 'node' && a.node === node && !LIVE.includes(a.status)
        && LIVE.includes(P?.attempts?.find(b => b.attempt_id === a.attempt_id)?.status ?? 'intent'));
      if (!retired || !existsSync(file)) continue;
      const pid = Number(readFileSync(file, 'utf8'));
      if (alive(pid)) bad('P4', `worker ${node}'s background child ${pid} outlived its retired attempt`);
    }
    // A live attempt after a command that did not crash: its group really runs (a worker an earlier crash left), or a judgment says why not.
    if (!action.crashed) for (const a of S.attempts.filter(x => LIVE.includes(x.status))) {
      let running = false;
      try { if (a.pgid) { process.kill(-a.pgid, 0); running = true; } } catch { /* gone */ }
      if (!running && !S.judgments.some(j => j.code === 'quiescence_unknown')) bad('P4', `attempt ${a.attempt_id} left ${a.status} after ${cmd}: its group is gone and no quiescence_unknown says why`);
    }

    // ---- P8 ceiling conservation ------------------------------------------------------------
    const limit = S.config.unitRecheckCeiling ?? 4;
    if (limit !== this.limit) bad('P8', `limit ${limit}, configured ${this.limit}`);
    const used = S.unit_ceiling?.used ?? 0, holds = S.unit_ceiling?.holds ?? [];
    const held = holds.reduce((t, h) => t + h.slots.length, 0);
    if (S.unit_checks && used + held > limit) bad('P8', `used ${used} + held ${held} > limit ${limit}`);
    const ev = S.events ?? [];
    const spends = ev.filter(e => e.type === 'UNIT_RECHECK' || e.type === 'UNIT_REVIEW_CYCLE');
    if (spends.length !== used) bad('P8', `used ${used} but ${spends.length} spend event(s)`);
    for (const h of holds) if (holds.filter(x => x.unit === h.unit).length > 1) bad('P8', `unit ${h.unit} holds more than one cycle`);
    // Replay hold conversion: a repair cycle holds 2; each reserved spend or release consumes; what is left is held.
    const model = {};
    for (const e of ev) {
      if (e.type === 'UNIT_REVIEW_CYCLE' && e.kind === 'unit_repair') model[e.trigger.review_execution] = { unit: e.unit, slots: 2 };
      else if ((e.type === 'UNIT_RECHECK' || e.type === 'UNIT_REVIEW_CYCLE') && e.reserved) {
        const h = Object.entries(model).find(([, m]) => m.unit === e.unit && m.slots > 0);
        if (!h) bad('P8', `reserved spend (seq ${e.seq}) for ${e.unit} without a held slot`); else h[1].slots -= 1;
      } else if (e.type === 'UNIT_CEILING_RELEASED') {
        const m = model[e.review_execution];
        if (!m || m.slots < e.slots.length) bad('P8', `release of ${e.review_execution} beyond its holds (seq ${e.seq})`); else m.slots -= e.slots.length;
      }
    }
    for (const [rx, m] of Object.entries(model)) {
      const now = holds.find(h => h.review_execution === rx)?.slots.length ?? 0;
      if (now !== m.slots) bad('P8', `hold ${rx}: ${m.slots} slot(s) by replay, ${now} in state`);
    }
    for (const h of holds) if (!model[h.review_execution]) bad('P8', `hold ${h.review_execution} was never spent for`);
    // Every hold belongs to an open FAIL cycle (after commands that reconcile).
    if (['drive', 'resume'].includes(cmd) || gateKind) for (const h of holds) {
      const chain = S.unit_reviews?.[h.unit]?.chain ?? [];
      const i = chain.findIndex(r => r.kind === 'original' && r.review_execution === h.review_execution);
      const fail = chain[i];
      const repair = S.repairs.find(r => r.id === `repair-${h.review_execution}`);
      const ended = !fail || fail.outcome !== 'FAIL' || !fail.repair_opened || chain.some(r => r.kind === 'confirmation' && r.review_execution === h.review_execution)
        || chain.slice(i + 1).some(r => r.kind === 'original') || ['cancelled', 'failed'].includes(repair?.state)
        || chain.some(r => r.kind === 'repair' && r.review_execution === h.review_execution && r.unbound);
      if (ended) bad('P8', `hold ${h.review_execution} of ${h.unit} outlived its cycle`);
    }
    // Every new unit-check round after a unit's first spends exactly one recheck (no quiescence refusal or crash).
    const unknownCheck = S.attempts.some(a => a.kind === 'unit-check' && a.status !== 'exited');
    if (!unknownCheck && !action.crashed) for (const u of Object.keys(this.model.units)) {
      const checked = ev.filter(e => e.type === 'UNIT_CHECKED' && e.unit === u).length;
      const rechecks = ev.filter(e => e.type === 'UNIT_RECHECK' && e.unit === u).length;
      if (rechecks !== Math.max(0, checked - 1)) bad('P8', `unit ${u}: ${checked} check round(s), ${rechecks} recheck spend(s)`);
    }
    // Spends are attributable to this command.
    const newSpends = spends.filter(e => e.seq > (P?.seq ?? 0));
    for (const e of newSpends) {
      if (e.type === 'UNIT_RECHECK' && cmd !== 'drive') bad('P8', `recheck spent by ${cmd}`);
      if (e.type === 'UNIT_REVIEW_CYCLE' && gateKind !== 'unit-review') bad('P8', `review cycle spent by ${cmd}`);
      // A confirmation spends its cycle's held slot (Opus N3).
      if (e.type === 'UNIT_REVIEW_CYCLE' && e.kind === 'unit_confirmation' && e.reserved !== true) bad('P8', `unit_confirmation of ${e.unit} (seq ${e.seq}) spent without a held slot`);
    }
    if (gateKind === 'unit-review' && res.out?.record) {
      const kinds = newSpends.map(e => e.kind);
      const want = res.out.record.kind === 'confirmation' ? ['unit_confirmation'] : res.out.record.repair_opened ? ['unit_repair'] : [];
      for (const k of want) if (kinds.filter(x => x === k).length !== 1) bad('P8', `${res.out.record.kind} recorded with ${J(kinds)} spends`);
      if (kinds.filter(x => x === 'unit_rereview').length > 1) bad('P8', `two re-review spends in one gate`);
    }
    if (S.judgments.some(j => j.code === 'parent_ceiling') && holds.some(h => !S.judgments.some(j => j.code === 'parent_ceiling' && j.node === h.unit))) this.observed.parent_ceiling_while_held += 1;

    // ---- P9 bounded allowances ----------------------------------------------------------------
    if (used < M.used) bad('P9', `used fell from ${M.used} to ${used}`);
    M.used = used;
    for (const [id, n] of Object.entries(S.nodes)) if ((n.retries ?? 0) > 1) bad('P9', `node ${id} has ${n.retries} retries`);
    for (const [k, rounds] of Object.entries(S.rounds ?? {})) if (rounds && typeof rounds === 'object') for (const [rx, n] of Object.entries(rounds)) if (n > 1) bad('P9', `${k}[${rx}] = ${n}`);
    for (const [who, chain] of chains) {
      const conf = chain.filter(r => r.kind === 'confirmation').map(r => r.review_execution);
      if (new Set(conf).size !== conf.length) bad('P9', `${who}: two confirmations of one execution`);
    }
    if (cmd === 'mark' && ok && action.transition === 'failed->pending') {
      M.marks[action.node] = (M.marks[action.node] ?? 0) + 1;
      if (M.marks[action.node] > 1) bad('P9', `mark failed->pending of ${action.node} accepted ${M.marks[action.node]} times`);
    }

    // ---- P5 fresh evidence ------------------------------------------------------------------
    const fresh = {};
    for (const u of Object.keys(this.model.units)) fresh[u] = this.fresh(post, u);
    for (const [u, p] of Object.entries(status?.units ?? {})) {
      if (p.state === 'verified' && fresh[u].fresh === false) bad('P5', `status claims ${u} verified; oracle: ${fresh[u].why}`);
    }
    if (gateKind === 'unit-review' && ok) {
      const u = action.unit;
      if (fresh[u].fresh === false) bad('P5', `unit review of ${u} accepted on stale evidence: ${fresh[u].why}`);
      if (res.out.record?.evidence_id !== S.unit_checks[u].evidence?.id) bad('P5', `unit review record names ${res.out.record?.evidence_id}, current ${S.unit_checks[u].evidence?.id}`);
    }
    if ((gateKind === 'review' || gateKind === 'ship-ready') && ok && S.unit_checks) {
      for (const [u, f] of Object.entries(fresh)) if (f.fresh === false) bad('P5', `${gateKind} accepted with ${u} stale: ${f.why}`);
    }

    // ---- P6 review continuity --------------------------------------------------------------
    for (const [u, R] of Object.entries(S.unit_reviews ?? {})) {
      const last = R.chain.findLast(r => r.kind === 'original' || r.kind === 'confirmation');
      if (status?.units?.[u]?.review?.state === 'pass' && !(last?.outcome === 'PASS' && last.candidate_id === S.unit_checks[u].evidence?.id && fresh[u].fresh !== false)) {
        bad('P6', `status says ${u} pass, but its last review is ${last?.outcome} on ${last?.candidate_id} (evidence ${S.unit_checks[u].evidence?.id}, oracle ${fresh[u].why ?? 'fresh'})`);
      }
    }
    // FAILs that opened a repair, first seen in raw state (also when the gate that recorded one crashed before answering).
    for (const [u, R] of Object.entries(S.unit_reviews ?? {})) for (const r of R.chain) {
      if (r.kind === 'original' && r.outcome === 'FAIL' && r.repair_opened && !M.fails[r.review_execution]) {
        M.fails[r.review_execution] = { step: M.step, unit: u, attempts: Object.fromEntries(this.model.units[u].members.map(m => [m, S.nodes[m].attempts])) };
      }
    }
    if (gateKind === 'unit-review' && ok && res.out.record?.kind === 'confirmation') {
      this.observed.confirmations += 1;
      const u = action.unit, rx = action.rx, f = M.fails[rx];
      const chain = S.unit_reviews[u].chain;
      const rec = chain.find(r => r.kind === 'repair' && r.review_execution === rx);
      const ran = S.attempts.some(a => a.kind === 'repair' && a.node === `repair-${rx}` && a.status === 'exited');
      if (!f) bad('P6', `confirmation of ${rx} without an accepted FAIL that opened a repair`);
      else {
        const U = this.model.units[u];
        const touched = M.edits.filter(e => e.step >= f.step && [...U.paths, ...U.upstreamPaths].includes(e.path));
        if (touched.length) bad('P6', `confirmation of ${rx} accepted although the test edited ${touched.map(e => e.path)} since the FAIL`);
        for (const m of U.members) if (S.nodes[m].attempts !== f.attempts[m]) bad('P6', `confirmation of ${rx} accepted although member ${m} re-ran since the FAIL`);
      }
      if (!rec || rec.new_candidate !== S.unit_checks[u].evidence?.id) bad('P6', `confirmation of ${rx} on ${S.unit_checks[u].evidence?.id}, repaired ${rec?.new_candidate}`);
      if (!ran) bad('P6', `confirmation of ${rx} although its repair never ran`);
    }
    const boundNow = (X) => Object.values(X?.unit_reviews ?? {}).flatMap(R => R.chain.filter(r => r.kind === 'repair' && r.new_candidate)).length;
    this.observed.repairs_bound += Math.max(0, boundNow(S) - boundNow(P));
    if (gateKind === 'unit-review' && res.out?.code === 'unit_review_terminal') this.observed.unit_review_terminal += 1;

    // ---- P7 repair isolation -----------------------------------------------------------------
    const changed = Object.keys({ ...pre.files, ...post.files }).filter(p => pre.files[p] !== post.files[p]);
    const nodeWrites = newAttempts.filter(a => a.kind === 'node').flatMap(a => S.nodes[a.node].writes);
    for (const r of S.repairs) {
      const was = P?.repairs?.find(x => x.id === r.id);
      if (r.kind === 'unit-review') {
        const outside = r.writes.filter(w => !this.model.units[r.unit].writes.includes(w));
        if (outside.length) bad('P7', `unit repair ${r.id} write set leaves its unit: ${outside}`);
      }
      if (r.state !== 'done' || was?.state === 'done') continue;
      const stray = changed.filter(p => !r.writes.includes(p) && !nodeWrites.includes(p));
      if (stray.length) bad('P7', `repair ${r.id} recorded done but ${stray} changed outside its write set`);
    }

    // ---- P12 SHIP conjunction ----------------------------------------------------------------
    // Node-level freshness, implied by "done" (seeded seed 20): every done node's declared reads and
    // writes still hash (own sha256) to the fingerprints recorded when it became done. A path the
    // node's fps lack counts as drifted; a non-file fingerprint is unknowable (skipped).
    const drifted = Object.entries(S.nodes).filter(([, n]) => n.state === 'done' && n.fps).filter(([id, n]) => {
      const N = this.model.byId[id];
      return [...N.reads, ...N.writes].some(p => {
        if (!(p in n.fps)) return true;
        const want = fpHash(n.fps[p]);
        return want !== null && (post.files[p] ?? 'missing') !== want;
      });
    }).map(([id]) => id);
    if (gateKind === 'review' && ok && code === 'review_accepted') {
      // The review freezes the candidate: a done node drifted before it must surface as post_freeze_drift (it blocks ship).
      for (const id of drifted) if (!(status?.judgments ?? []).some(j => j.code === 'post_freeze_drift' && j.node === id)) {
        bad('P12', `final review accepted while done node ${id}'s declared paths drifted, and status reports no post_freeze_drift for it`);
      }
    }
    if (gateKind === 'review' && ok && code === 'review_accepted' && res.out.record?.outcome === 'PASS') M.finalAccepted = { step: M.step, files: post.files };
    // A local proof recorded by a ship-ready whose commands changed the tree proves no tree (PR #38 4505924540).
    if (gateKind === 'ship-ready' && S.local_proof && S.local_proof.seq !== P?.local_proof?.seq && S.local_proof.candidate_id !== null
      && Object.keys({ ...pre.files, ...post.files }).some(p => pre.files[p] !== post.files[p])) {
      bad('P12', `local proof bound to ${S.local_proof.candidate_id} although its commands changed the work tree`);
    }
    if (gateKind === 'ship-ready' && ok) {
      this.observed.ship_ready += 1;
      const why = [];
      if (Object.values(S.nodes).some(n => !['done', 'cancelled'].includes(n.state))) why.push('a node is unfinished');
      for (const id of drifted) why.push(`done node ${id}'s declared paths drifted since it was done`);
      if (S.attempts.some(a => LIVE.includes(a.status))) why.push('an attempt is live');
      if (S.repairs.some(r => ['pending', 'running'].includes(r.state))) why.push('a repair is open');
      if (S.judgments.length || status?.judgments?.length) why.push(`judgments ${J([...S.judgments, ...(status?.judgments ?? [])].map(j => j.code))}`);
      const candidate = this.candidate();
      const last = (S.review_chain ?? []).at(-1);
      if (!(last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' && last.candidate_id === candidate)) why.push('the last final review is not a PASS on the candidate');
      for (const u of Object.keys(this.model.units)) {
        if (fresh[u].fresh === false) why.push(`${u} stale (${fresh[u].why})`);
        if (S.unit_reviews) {
          const lr = S.unit_reviews[u].chain.findLast(r => r.kind === 'original' || r.kind === 'confirmation');
          if (!(lr?.outcome === 'PASS' && lr.candidate_id === S.unit_checks[u].evidence?.id)) why.push(`${u} has no current PASS unit review`);
          if (!(last?.units_consumed ?? []).some(c => c.unit === u && c.evidence_id === S.unit_checks[u].evidence?.id)) why.push(`final review did not consume ${u}'s current evidence`);
        }
      }
      if (!(S.local_proof?.candidate_id === candidate && S.local_proof.commands?.length && S.local_proof.commands.every(c => c.result === 'pass'))) why.push('no passing local proof on the candidate');
      if (M.finalAccepted) {
        const drift = Object.keys({ ...M.finalAccepted.files, ...post.files }).filter(p => M.finalAccepted.files[p] !== post.files[p]);
        if (drift.length) why.push(`files changed since the accepted final review: ${drift}`);
      }
      for (const w of why) bad('P12', `ship-ready accepted although ${w}`);
    }
    return v;
  }
}
