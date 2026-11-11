#!/usr/bin/env node
/**
 * Fixture benchmark for the durable run engine (AIS-HARNESS-2). Measured, no estimates.
 * Builds a temp git repo with an approved plan, a DAG (two dependency waves + one join) and a
 * fake provider CLI, then executes it twice: `manual` (the documented hand-run loop) and `engine`.
 *
 * CLI: engine-bench.mjs [--nodes 6] [--json]     exit 0 only when every node of both modes completed
 *      engine-bench.mjs --scenario <S1..S7|all> [--json]     one result per scenario (engine-bench-scenarios.mjs);
 *                                                             exit 0 only when every scenario is ok; on Windows every
 *                                                             scenario is skipped (limit N7) with ok false, so it exits 1
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planNarrativeDigest } from './run-engine.mjs';
import { isEntrypoint } from './harness.mjs';
import { runScenarios } from './engine-bench-scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = (name) => join(HERE, name);
const POSIX = process.platform !== 'win32';
const BEGIN = '<!-- RUN-STATE:BEGIN -->', END = '<!-- RUN-STATE:END -->';
const TICKET = 'BENCH-1', RUN = 'run-bench';
const OUT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK',
  usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } });

// Fake provider CLI: answers `auth status`, otherwise reads NODE=<id> from stdin and writes src/<id>.txt.
const FAKE_CLI = `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
if (process.argv[2] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0); }
const node = /NODE=(\\S+)/.exec(readFileSync(0, 'utf8'))?.[1] ?? 'unknown';
mkdirSync('src', { recursive: true }); writeFileSync('src/' + node + '.txt', node + '\\n');
process.stdout.write(${JSON.stringify(OUT)});
`;

/** Two dependency waves plus one join: w1 (no deps) -> w2 (dep on all of w1) -> join (dep on all of w2). */
export function buildNodes(n) {
  const ids = Array.from({ length: n }, (_, i) => 'n' + (i + 1));
  const w1 = ids.slice(0, Math.max(1, Math.ceil((n - 1) / 2)));
  const w2 = ids.slice(w1.length, n - 1);
  const join = ids.at(-1);
  return ids.map(id => ({ id, deps: w1.includes(id) || (n === 1) ? [] : id === join ? (w2.length ? w2 : w1) : w1 }));
}

function sandbox(root, label, nodes) {
  const dir = join(root, label), repo = join(dir, 'repo'), bin = join(dir, 'bin');
  for (const d of [join(repo, '.specs', 'plans'), join(repo, 'src'), bin]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(bin, 'fake.mjs'), FAKE_CLI);
  if (POSIX) { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${join(bin, 'fake.mjs')}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  else writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  const sep = POSIX ? ':' : ';';
  const env = { ...process.env, PATH: bin + sep + process.env.PATH, Path: bin + sep + (process.env.Path ?? process.env.PATH) };
  const prompts = {};
  for (const n of nodes) { prompts[n.id] = join(dir, `prompt-${n.id}.txt`); writeFileSync(prompts[n.id], `NODE=${n.id}\n`); }
  const dag = { schema: 'ship-ticket-engine-dag-v1',
    config: { provider: 'claude', modelMap: {}, permissionMode: 'acceptEdits', billing: 'subscription', width: 2, memoryBudgetMb: 4096,
      timeoutMs: 30000, budget: null, candidateExclusions: [`.specs/plans/${TICKET}.md`, 'session-log.md'], testCommands: {}, base: 'main' },
    nodes: nodes.map(n => ({ id: n.id, deps: n.deps, reads: [], writes: [`src/${n.id}.txt`], othersOwned: [], resources: [], risk: [],
      complexity: 'low', modelTier: 'inherit', estimatedMemoryMb: 64, promptFile: prompts[n.id], phase: 'BUILD', role: 'builder',
      evidence: [], redSpecs: [] })) };
  const dagFile = join(dir, 'dag.json'), dagText = JSON.stringify(dag, null, 2);
  writeFileSync(dagFile, dagText);
  const dagDigest = 'sha256:' + sha256(dagText);
  const narrative = `# Plan ${TICKET}\n\nBench plan.\n\nExecution DAG digest: ${dagDigest}\n\n`;
  const approved = planNarrativeDigest(`${narrative}${BEGIN}\n${END}\n`);
  // A fixed approval time before SECURITY_POLICY_CUTOFF: the bench DAG is a legacy (policy-1) run; a clock-derived START would stop init after the cutoff.
  const start = { run_id: RUN, event: 'START', timestamp: '2026-11-05T00:00:00Z', approved_plan_digest: approved };
  writeFileSync(join(repo, '.specs', 'plans', `${TICKET}.md`), `${narrative}${BEGIN}\n${JSON.stringify(start)}\n${END}\n`);
  return { dir, repo, env, prompts, dagFile, approved };
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const run = (file, args, env, cwd) => spawnSync(process.execPath, [file, ...args], { env, cwd, encoding: 'utf8', timeout: 120000 });

function manual(sb, nodes) {
  const t0 = Date.now(); let commands = 0, bytes = 0, completed = 0;
  const logArgs = (verb, id, extra = []) => [SCRIPT('run-log.mjs'), verb, '--repo', sb.repo, '--ticket', TICKET, '--run-id', RUN,
    '--kind', 'phase', '--name', 'BUILD', '--event-id', `${id}-build`, ...extra];
  for (const n of nodes) {
    const resultFile = join(sb.dir, `${n.id}.message.json`), config = join(sb.dir, `${n.id}.dispatch.json`);
    writeFileSync(config, JSON.stringify({ phase: 'BUILD', provider: 'claude', nodeId: n.id, workdir: sb.repo, repoRoot: sb.repo,
      approval: { ticket: TICKET, runId: RUN, approvedPlanDigest: sb.approved }, ownership: { writes: [`src/${n.id}.txt`], othersOwned: [] },
      promptFile: sb.prompts[n.id], complexity: 'low', timeoutMs: 30000, resultFile }));
    const step = (args) => { commands++; return spawnSync(process.execPath, args, { env: sb.env, encoding: 'utf8', timeout: 120000 }); };
    const started = step(logArgs('start', n.id));
    const carrier = step([SCRIPT('carrier.mjs'), 'run', config]);
    const ended = step(logArgs('end', n.id, ['--outcome', carrier.status === 0 ? 'pass' : 'fail']));
    commands += 2; // the orchestrator reads the result JSON and the message file
    bytes += Buffer.byteLength(carrier.stdout ?? '') + (existsSync(resultFile) ? readFileSync(resultFile).length : 0);
    let ok = false;
    try { ok = started.status === 0 && ended.status === 0 && carrier.status === 0 && JSON.parse(carrier.stdout).succeeded === true; } catch { /* not JSON */ }
    if (ok) completed++;
  }
  return { orchestrator_commands: commands, bytes_read: bytes, wall_ms: Date.now() - t0, nodes_completed: completed };
}

function engine(sb, nodes) {
  const t0 = Date.now(); let commands = 0, bytes = 0, last = null;
  for (const verb of ['init', 'drive', 'status']) {
    commands++;
    const flags = ['--repo', sb.repo, '--ticket', TICKET, '--run-id', RUN, ...(verb === 'init' || verb === 'drive' ? ['--dag', sb.dagFile] : [])];
    const r = run(SCRIPT('run-engine.mjs'), [verb, ...flags], sb.env, sb.repo);
    if (verb === 'status') { bytes += Buffer.byteLength(r.stdout ?? ''); try { last = JSON.parse(r.stdout); } catch { /* reported below */ } }
    else if (r.status !== 0) process.stderr.write(`engine ${verb} exit ${r.status}: ${r.stderr}${r.stdout}\n`);
  }
  const completed = Object.values(last?.nodes ?? {}).filter(x => x.state === 'done').length;
  return { orchestrator_commands: commands, bytes_read: bytes, wall_ms: Date.now() - t0, nodes_completed: completed };
}

export function bench({ nodes: count = 6 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-bench-')));
  try {
    const nodes = buildNodes(count);
    const m = manual(sandbox(root, 'manual', nodes), nodes);
    const e = engine(sandbox(root, 'engine', nodes), nodes);
    return { nodes: count, manual: m, engine: e, ok: m.nodes_completed === count && e.nodes_completed === count };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2), at = argv.indexOf('--nodes'), scenarioAt = argv.indexOf('--scenario');
  if (scenarioAt >= 0) {
    const which = argv[scenarioAt + 1] ?? '';
    const results = await runScenarios(which, { buildNodes }).catch(e => { process.stderr.write(`engine-bench: ${e.message}\n`); return null; });
    if (!results) process.exit(1);
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    else for (const r of results) process.stdout.write(JSON.stringify(r) + '\n');
    process.exitCode = results.every(r => r.ok) ? 0 : 1;
  } else {
    const n = at >= 0 ? Number(argv[at + 1]) : 6;
    if (!Number.isInteger(n) || n < 1) { process.stderr.write('Usage: engine-bench.mjs [--nodes 6] [--json] | --scenario <S1..S7|all> [--json]\n'); process.exit(1); }
    const r = bench({ nodes: n });
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else for (const k of ['manual', 'engine']) process.stdout.write(`${k}: ${JSON.stringify(r[k])}\n`);
    process.exitCode = r.ok ? 0 : 1;
  }
}
