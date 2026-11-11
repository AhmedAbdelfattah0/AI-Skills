/**
 * Seven fixture scenarios for the run engine (AIS-BENCH-1 Wave 1), driven through the REAL engine
 * and gate CLIs against a fake provider. They measure mechanism and orchestration overhead, never
 * model quality or real tokens. Everything lives in temp directories that are removed afterwards.
 *
 * Reuse: engine-test-fixture.mjs (repo, plan, DAG, fake `claude`) and
 * engine-crash-driver.test-helper.mjs (a child that SIGKILLs itself at a named boundary).
 * Ordering between workers is enforced by causal file handshakes (`waitFor`), never by sleeps. The only waits
 * outside the engine are polls of a file or a process group for a condition (never a fixed delay), and the
 * wall-clock times the engine records are read only to measure overlap, never to order anything.
 *
 * Metric definitions (per scenario, summed over its sub-runs):
 *   orchestrator_commands  engine and gate CLI invocations the orchestrator makes (the crash child counts as one;
 *                          waiting for a worker to end polls a file and a process group, which is not a command, so the
 *                          count is the same on every run)
 *   bytes_read             bytes of those commands' stdout
 *   reference_bytes        referenceBytes(flags) of load-record.mjs for the scenario's shape
 *   judgments              distinct judgments (code, node) raised in any status the orchestrator read
 *   owner_interventions    judgments still standing in the last status of each sub-run: the run cannot continue
 *                          without an owner decision (a refusal the orchestrator can answer with more work is not one)
 *   proof_runs             executions of config.testCommands entries, counted by their own side effect: proof-command
 *                          executions and RED spec executions both count
 *   retries                automatic retries the engine made (nodes[*].retries in the last status; nothing here marks a retry)
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, POSIX, codes, waitUntil } from './engine-test-fixture.mjs';
import { loadRecord, referenceBytes } from './load-record.mjs';

export const LIMITS = 'fake provider: mechanism and orchestration overhead only';
export const WINDOWS_SKIP = 'known Windows quiescence limit N7: bench nodes never reach done on Windows';
const CRASH_DRIVER = fileURLToPath(new URL('./engine-crash-driver.test-helper.mjs', import.meta.url));
const SPEC_NAME = 'fails on assertion';
const SHORT_TIMEOUT_MS = 2000; // above the carrier's 1000 ms floor, short enough for the hang case
const ROOM_MS = 30000;          // a worker that waits on a handshake must outlive a slow machine

const sum = (xs) => xs.reduce((n, x) => n + x, 0);
const states = (status) => Object.fromEntries(Object.entries(status?.nodes ?? {}).map(([id, n]) => [id, n.state]));
const doneCount = (status) => Object.values(status?.nodes ?? {}).filter(n => n.state === 'done').length;
const reasonOf = (status, code) => (status?.judgments ?? []).find(j => j.code === code)?.reason ?? null;
const overlap = (a, b) => Date.parse(a.started_at) <= Date.parse(b.envelope.ended_at) && Date.parse(b.started_at) <= Date.parse(a.envelope.ended_at);

/** Which of `waves` each started node belongs to: `in_order` when every node of a wave started before any of the next; `groups` sorted within a wave. */
function waveOrder(order, waves) {
  const index = (id) => waves.findIndex(w => w.includes(id));
  return { in_order: order.length === waves.flat().length && order.every((id, i) => i === 0 || index(order[i - 1]) <= index(id)),
    groups: waves.map(w => order.filter(id => w.includes(id)).sort()) };
}

/** Peak number of node attempts alive at once, from the started/ended times the engine recorded. */
export function peakConcurrency(attempts) {
  const edges = attempts.filter(a => a.kind === 'node' && a.started_at && a.envelope?.ended_at)
    .flatMap(a => [[Date.parse(a.started_at), 1], [Date.parse(a.envelope.ended_at), -1]])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]); // an end sorts before a start at the same instant
  let live = 0, peak = 0;
  for (const [, d] of edges) peak = Math.max(peak, live += d);
  return peak;
}

/** Counts what one scenario costs the orchestrator, across all the sub-run worlds it builds. */
function newMeter() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engine-bench-scn-')));
  const cleanups = [() => rmSync(dir, { recursive: true, force: true })];
  return { commands: 0, bytes: 0, seen: new Map(), worlds: [], dir,
    t: { after: (f) => cleanups.push(f) }, // the only thing the fixture needs from a test context
    cleanup() { for (const f of cleanups.reverse()) { try { f(); } catch { /* best effort */ } } } };
}

/**
 * One fixture repo plus counted wrappers around the engine and gate CLIs. The config always carries a
 * `proof` test command whose side effect counts its own executions; `red` adds a `unit` RED runner and
 * a failing spec that counts its executions too.
 */
function world(meter, { nodes, config = {}, red = false }) {
  const proofLog = join(meter.dir, `proof-${meter.worlds.length}.log`);
  writeFileSync(proofLog, '');
  const testCommands = { proof: { cmd: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(proofLog)}, 'p')`] } };
  if (red) testCommands.unit = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };
  const fx = fixture(meter.t, { commit: true, nodes, behaviour: {}, config: { ...config, testCommands } });
  if (red) {
    mkdirSync(join(fx.repo, 'spec'), { recursive: true });
    writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`
      + `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(proofLog)}, 'r');\n`
      + `test('${SPEC_NAME}', () => { assert.equal(1, 2); });\n`);
  }
  const w = { fx, proofLog, last: null,
    count(r) {
      meter.commands++; meter.bytes += Buffer.byteLength(r.stdout ?? '');
      if (Array.isArray(r.out?.judgments)) { w.last = r.out; for (const j of r.out.judgments) meter.seen.set(`${meter.worlds.indexOf(w)}:${j.code}:${j.node ?? ''}`, j.code); }
      return r;
    },
    cli: (cmd, flags, o) => w.count(fx.cli(cmd, flags, o)),
    gate: (kind, input, o) => w.count(fx.gate(kind, input, o)),
    init: () => w.cli('init', { dag: fx.dagFile }),
    flag: (name) => join(fx.root, name),
    executions: () => { const s = readFileSync(proofLog, 'utf8'); return { proof: [...s].filter(c => c === 'p').length, red: [...s].filter(c => c === 'r').length }; },
  };
  meter.worlds.push(w);
  return w;
}

const node = (id, extra = {}) => ({ id, writes: [`src/${id}.txt`], ...extra });
const writeOf = (id) => ({ write: { [`src/${id}.txt`]: id } });
const plain = (...ids) => Object.fromEntries(ids.map(id => [id, writeOf(id)]));

/** Both nodes of a pair write their own start marker, then wait for the other's: neither can finish unless both run at once. */
function pair(w, a, b) {
  const started = (id) => w.flag(`${id}-started`);
  return Object.fromEntries([[a, b], [b, a]].map(([me, other]) => [me,
    { write: { [`src/${me}.txt`]: me, [started(me)]: '' }, waitFor: started(other) }]));
}

// ------------------------------------------------------------------ the scenarios

async function s1(meter) {
  const w = world(meter, { nodes: [node('a')] });
  w.fx.behave(plain('a'));
  w.init(); const d = w.cli('drive'); // the drive output is the status the orchestrator needs
  const shows = { outcome: d.out?.outcome ?? null, nodes: states(d.out), writer_runs: w.fx.runs('a').length, commands: ['init', 'drive'] };
  return { shows, ok: shows.outcome === 'done' && shows.nodes.a === 'done' && shows.writer_runs === 1 };
}

async function s2(meter) {
  const w = world(meter, { config: { timeoutMs: ROOM_MS },
    nodes: [node('contract'), node('frontend', { deps: ['contract'] }), node('backend', { deps: ['contract'] }), node('join', { deps: ['frontend', 'backend'] })] });
  w.fx.behave({ ...plain('contract', 'join'), ...pair(w, 'frontend', 'backend') });
  w.init(); const d = w.cli('drive');
  const attempts = w.fx.readState().attempts.filter(a => a.kind === 'node');
  const get = (id) => attempts.find(a => a.node === id);
  const order = w.fx.runs();
  const wave = waveOrder(order, [['contract'], ['frontend', 'backend'], ['join']]);
  const shows = { outcome: d.out?.outcome ?? null, nodes: states(d.out), start_waves: wave.groups, waves_in_order: wave.in_order,
    frontend_and_backend_in_one_wave: Boolean(get('frontend') && get('backend') && overlap(get('frontend'), get('backend'))),
    peak_concurrency: peakConcurrency(attempts) };
  // Each of the two workers waits for the other's start marker before it can finish, so a completed run proves one wave.
  return { shows, ok: shows.outcome === 'done' && shows.frontend_and_backend_in_one_wave && shows.peak_concurrency >= 2 && shows.waves_in_order };
}

async function s3(meter) {
  const spec = 'spec/red.test.mjs';
  const w = world(meter, { red: true, config: { modelMap: { strong: 'claude-strong-test' } },
    nodes: [node('spec', { risk: ['auth'], redSpecs: [{ file: spec, name: SPEC_NAME }] }), node('impl', { deps: ['spec'], risk: ['auth'] })] });
  w.fx.behave(plain('spec', 'impl'));
  const evidence = ['authorization-spec', 'negative-spec'];
  // A spec-kind entry counts only when the RED gate accepted a RED run of the file it names (gate.mjs gateShipReady; engine-dag.mjs boundRiskEvidence derives red_accepted).
  const supplied = { risk_evidence: evidence.map(kind => ({ kind, path: spec })) };
  const refusal = (r) => ({ exit: r.status, code: r.out?.code ?? null, reasons: r.out?.reasons ?? [], missing: r.out?.missing ?? [] });
  w.init();
  const before = w.cli('drive');
  const implRunsBeforeRed = w.fx.runs('impl').length;
  const early = refusal(w.gate('ship-ready', supplied));
  const red = w.gate('red', { node: 'spec', command: 'unit' });
  const after = w.cli('drive');
  const late = refusal(w.gate('ship-ready', supplied));
  const bare = refusal(w.gate('ship-ready', { risk_evidence: [] })); // an explicit empty list replaces the stored evidence
  const shows = { drive_before_red: { outcome: before.out?.outcome ?? null, red_pending: before.out?.red_pending ?? [], impl_runs: implRunsBeforeRed },
    ship_ready_before_red_with_evidence: early, red_gate: red.out?.code ?? null,
    drive_after_red: { outcome: after.out?.outcome ?? null, nodes: states(after.out) },
    ship_ready_after_red_with_evidence: late, ship_ready_after_red_no_evidence: bare,
    executions: { red_spec: w.executions().red, proof_command: w.executions().proof } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return { shows, ok: shows.drive_before_red.red_pending.includes('spec') && implRunsBeforeRed === 0
    && early.exit === 2 && early.reasons.includes('missing_risk_evidence') && same(early.missing, evidence)
    && shows.red_gate === 'red_accepted' && shows.drive_after_red.outcome === 'done'
    && !late.reasons.includes('missing_risk_evidence') && late.missing.length === 0 && late.reasons.includes('review_not_accepted') && late.reasons.includes('missing_local_proof')
    && bare.reasons.includes('missing_risk_evidence') && same(bare.missing, evidence) };
}

async function s4(meter, { buildNodes }) {
  const dag = buildNodes(6);
  const width = 2;
  const w = world(meter, { config: { width, timeoutMs: ROOM_MS }, nodes: dag.map(n => node(n.id, { deps: n.deps })) });
  w.fx.behave({ ...plain('n3', 'n6'), ...pair(w, 'n1', 'n2'), ...pair(w, 'n4', 'n5') });
  w.init(); const d = w.cli('drive');
  const attempts = w.fx.readState().attempts.filter(a => a.kind === 'node');
  const wave = waveOrder(w.fx.runs(), [['n1', 'n2', 'n3'], ['n4', 'n5'], ['n6']]);
  const shows = { outcome: d.out?.outcome ?? null, width, nodes: states(d.out), peak_concurrency: peakConcurrency(attempts), ...{ start_waves: wave.groups, waves_in_order: wave.in_order } };
  return { shows, ok: shows.outcome === 'done' && doneCount(d.out) === 6 && shows.peak_concurrency >= 2 && shows.peak_concurrency <= width && shows.waves_in_order };
}

async function s5(meter) {
  const one = (config = {}) => world(meter, { nodes: [node('a')], config });

  const providerError = one(); providerError.fx.behave({ a: { exit: 1 } });
  providerError.init(); const pe = providerError.cli('drive');

  const timeout = one({ timeoutMs: SHORT_TIMEOUT_MS }); timeout.fx.behave({ a: { hang: true } });
  timeout.init(); const to = timeout.cli('drive');

  // Engine crash mid-drive: the drive process dies right after releasing the worker; the worker keeps running.
  const crash = one({ timeoutMs: ROOM_MS }); const finish = crash.flag('finish');
  crash.fx.behave({ a: { ...writeOf('a'), waitFor: finish } });
  crash.init();
  const marker = crash.flag('crashed-at');
  const job = { cmd: 'drive', ctx: { repoRoot: crash.fx.repo, ticket: 'T-1', runId: 'run-1', dagFile: crash.fx.dagFile }, at: { name: 'after-release', nth: 1 }, marker };
  const child = spawn(process.execPath, [CRASH_DRIVER, JSON.stringify(job)], { env: crash.fx.env, stdio: 'ignore' });
  const signal = await new Promise(r => child.on('exit', (_c, s) => r(s)));
  meter.commands++; // the crashed drive is one orchestrator command; its output is lost with the process
  await waitUntil(() => crash.fx.runs('a').length === 1);
  const live = crash.cli('resume');
  writeFileSync(finish, '');
  // Wait, without running a command, for the worker to end: its complete envelope is on disk and its process group is gone.
  const attempt = crash.fx.readState().attempts.find(a => a.node === 'a');
  const ended = () => {
    try { JSON.parse(readFileSync(attempt.envelope_file, 'utf8')); } catch { return false; }
    if (!attempt.pgid) return true;
    try { process.kill(-attempt.pgid, 0); return false; } catch { return true; }
  };
  await waitUntil(ended, 15000);
  const recovered = crash.cli('resume');
  const finished = crash.cli('drive');

  const workerCrash = one(); workerCrash.fx.behave({ a: { ...writeOf('a'), killGroup: true } });
  workerCrash.init(); const wc = workerCrash.cli('drive'); const wcAgain = workerCrash.cli('drive');

  const shows = {
    provider_error: { node: pe.out?.nodes?.a, writer_runs: providerError.fx.runs('a').length, judgments: codes(pe.out), reason: reasonOf(pe.out, 'node_failed') },
    // Facts come from the engine's own state, not from the provider's log: the provider may not have started before the timer fired.
    timeout: { node: to.out?.nodes?.a, node_attempts_recorded: timeout.fx.readState().attempts.filter(a => a.kind === 'node' && a.node === 'a').length,
      judgments: codes(to.out), reason: reasonOf(to.out, 'node_failed') },
    engine_crash: { killed_by: signal, state_after_resume_while_live: live.out?.nodes?.a?.state ?? null, state_after_worker_ended: recovered.out?.nodes?.a?.state ?? null,
      final_outcome: finished.out?.outcome ?? null, writer_runs: crash.fx.runs('a').length },
    worker_crash_with_writes: { outcome: wc.out?.outcome ?? null, judgments: codes(wc.out), writer_runs_after_second_drive: workerCrash.fx.runs('a').length,
      second_drive_judgments: codes(wcAgain.out) },
  };
  const ok = shows.provider_error.node?.state === 'failed' && shows.provider_error.node.retries === 1 && shows.provider_error.node.attempts === 2 && shows.provider_error.writer_runs === 2
    && shows.timeout.node?.state === 'failed' && shows.timeout.node.retries === 0 && shows.timeout.node_attempts_recorded === 1
    && signal === 'SIGKILL' && shows.engine_crash.state_after_resume_while_live === 'running' && shows.engine_crash.state_after_worker_ended === 'done'
    && shows.engine_crash.final_outcome === 'done' && shows.engine_crash.writer_runs === 1
    && shows.worker_crash_with_writes.outcome === 'judgment' && shows.worker_crash_with_writes.judgments.includes('crash_with_writes') && shows.worker_crash_with_writes.writer_runs_after_second_drive === 1;
  return { shows, ok };
}

async function s6(meter) {
  const dag = () => ({ config: { width: 1 }, nodes: [node('a'), node('b', { deps: ['a'] }), node('c')] });
  // width 1 makes the order causal: `a` (the violator) is dispatched first, `c` (independent, ready from the start) could only follow it.
  const w = world(meter, dag());
  w.fx.behave({ a: { write: { 'src/a.txt': 'a', 'src/extra.txt': 'not declared' } }, ...plain('b', 'c') });
  w.init(); const first = w.cli('drive'); const again = w.cli('drive');
  // Control: the same DAG with the extra file left out completes, so the stop above is caused by the undeclared write.
  const control = world(meter, dag());
  control.fx.behave(plain('a', 'b', 'c'));
  control.init(); const clean = control.cli('drive');
  const violation = (first.out?.judgments ?? []).find(j => j.code === 'ownership_violation');
  const shows = { outcome: first.out?.outcome ?? null, judgments: codes(first.out), violation_node: violation?.node ?? null, violation_reason: violation?.reason ?? null,
    nodes: states(first.out), nodes_after_second_drive: states(again.out), dependent_runs: w.fx.runs('b').length,
    independent_runs: w.fx.runs('c').length, writer_runs_after_second_drive: w.fx.runs('a').length, second_drive_judgments: codes(again.out),
    control_without_the_extra_file: { outcome: clean.out?.outcome ?? null, judgments: codes(clean.out), nodes: states(clean.out) } };
  return { shows, ok: shows.outcome === 'judgment' && shows.violation_node === 'a' && /src\/extra\.txt/.test(shows.violation_reason ?? '')
    && shows.dependent_runs === 0 && shows.independent_runs === 0 && shows.nodes.c === 'pending' && shows.nodes_after_second_drive.c === 'pending'
    && shows.writer_runs_after_second_drive === 1 && shows.second_drive_judgments.includes('ownership_violation')
    && shows.control_without_the_extra_file.outcome === 'done' && shows.control_without_the_extra_file.judgments.length === 0 };
}

async function s7(meter) {
  // `ui` is a ticket-level label: a node's own `risk` rejects it at init (dag_invalid), config.riskLabels carries it.
  const w = world(meter, { config: { riskLabels: ['ui'] }, nodes: [node('screen')] });
  w.fx.behave(plain('screen'));
  w.init(); const d = w.cli('drive');
  const refusal = (r) => ({ exit: r.status, code: r.out?.code ?? null, reasons: r.out?.reasons ?? [], missing: r.out?.missing ?? [] });
  const without = refusal(w.gate('ship-ready', {}));
  // Complement: a non-spec kind needs an existing artifact (gate.mjs gateShipReady; engine-io.mjs evidenceExists); supplying one clears the reason.
  const artifact = 'parity-measurements.json';
  writeFileSync(join(w.fx.repo, artifact), '{}');
  const withEvidence = refusal(w.gate('ship-ready', { risk_evidence: [{ kind: 'parity-measurements', path: artifact }] }));
  const shows = { drive_outcome: d.out?.outcome ?? null, ship_ready: without, ship_ready_with_parity_evidence: withEvidence };
  return { shows, ok: shows.drive_outcome === 'done' && without.exit === 2 && without.reasons.includes('missing_risk_evidence')
    && JSON.stringify(without.missing) === JSON.stringify(['parity-measurements'])
    && !withEvidence.reasons.includes('missing_risk_evidence') && withEvidence.missing.length === 0 };
}

export const SCENARIOS = [
  { id: 'S1', title: 'one node', run: s1, flags: {} },
  { id: 'S2', title: 'contract, frontend and backend in one wave, then a join', run: s2, flags: {} },
  { id: 'S3', title: 'auth-sensitive change: ship-ready needs accepted RED and the risk evidence', run: s3, flags: { security: true } },
  { id: 'S4', title: 'six nodes in two waves and a join', run: s4, flags: {} },
  { id: 'S5', title: 'failure and recovery: provider error, timeout, engine crash, worker crash', run: s5, flags: {} },
  { id: 'S6', title: 'scope expansion: one undeclared file is an ownership violation and the whole run stops', run: s6, flags: {} },
  { id: 'S7', title: 'UI change: ship-ready refuses without parity evidence', run: s7, flags: { ui: true } },
];

/** Run one scenario and return its result; `deps.buildNodes` is the bench's DAG shape builder. */
export async function runScenario(def, deps, record = loadRecord()) {
  const base = { id: def.id, title: def.title, limits: LIMITS };
  if (!POSIX) return { ...base, ok: false, skipped: WINDOWS_SKIP, shows: {}, metrics: null };
  const meter = newMeter();
  const t0 = Date.now();
  try {
    const { shows, ok } = await def.run(meter, deps);
    const last = meter.worlds.map(w => w.last);
    const executions = meter.worlds.map(w => w.executions());
    return { ...base, ok, shows, metrics: {
      orchestrator_commands: meter.commands, bytes_read: meter.bytes, reference_bytes: referenceBytes(def.flags, record), wall_ms: Date.now() - t0,
      nodes_completed: sum(last.map(doneCount)), judgments: meter.seen.size, owner_interventions: sum(last.map(s => s?.judgments?.length ?? 0)),
      proof_runs: sum(executions.map(e => e.proof + e.red)), retries: sum(last.map(s => sum(Object.values(s?.nodes ?? {}).map(n => n.retries ?? 0)))) } };
  } catch (e) {
    return { ...base, ok: false, shows: { error: String(e?.stack ?? e) }, metrics: null };
  } finally { meter.cleanup(); }
}

/** `which` is an id (S1..S7) or 'all'; returns the results in order. */
export async function runScenarios(which, deps) {
  const defs = which === 'all' ? SCENARIOS : SCENARIOS.filter(d => d.id === which);
  if (!defs.length) throw new Error(`unknown scenario ${which}: expected S1..S7 or all`);
  const record = loadRecord();
  const out = [];
  for (const def of defs) out.push(await runScenario(def, deps, record));
  return out;
}
