/**
 * Shared test fixture for the run engine (run-engine.test.mjs, run-engine-repair.test.mjs).
 * Not a test file: it builds a temp git repo with an approved plan, a bound DAG, prompts and a
 * fake `claude` CLI on PATH, and helpers that drive the REAL engine CLI (`node run-engine.mjs`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const POSIX = process.platform !== 'win32';
export const BEGIN = '<!-- RUN-STATE:BEGIN -->';
export const END = '<!-- RUN-STATE:END -->';
export const CLAUDE_OUT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK',
  usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } });

/** Digest in the skill's canonical `sha256:<hex>` form (the form real START events use). */
export const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
export const narrativeDigest = (text) => sha(text.slice(0, text.indexOf(BEGIN) + BEGIN.length) + text.slice(text.indexOf(END)));
export const delay = (ms) => new Promise(r => setTimeout(r, ms));
export const codes = (s) => (s?.judgments ?? []).map(j => j.code);

export function gitPath(repo, rel) {
  const r = spawnSync('git', ['rev-parse', '--git-path', rel], { cwd: repo, encoding: 'utf8' });
  return resolve(repo, r.stdout.trim());
}

/**
 * Fake provider CLI: `claude auth status` reports a subscription login; otherwise it reads
 * NODE=<id> from the prompt, logs the run and applies behaviour.json[<id>]:
 *   write {path: text}, appendRunState (inserts a NOTE inside RUN-STATE), appendEvent {event}
 *   (inserts that event inside RUN-STATE), appendRaw <text> (inserts those exact bytes), appendLate {event} (the same, just before the worker
 *   finishes, e.g. after waitFor), editPlan (edits the
 *   narrative), breakGit (makes `git status` fail), sleeper <pidfile> (leaves a background
 *   child in the process group), killGroup, exit <code>, hang, waitFor <file>.
 */
export const FAKE_CLI = (root) => `import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.argv.slice(2).includes('auth')) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
const ROOT = ${JSON.stringify(root)};
const prompt = readFileSync(0, 'utf8');
const node = /NODE=(\\S+)/.exec(prompt)?.[1] ?? 'unknown';
appendFileSync(join(ROOT, 'runs.log'), node + '\\n');
let b = {};
try { b = JSON.parse(readFileSync(join(ROOT, 'behaviour.json'), 'utf8'))[node] ?? {}; } catch {}
for (const [p, c] of Object.entries(b.write ?? {})) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
const PLAN = '.specs/plans/T-1.md';
if (b.appendRunState) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', '{"event":"NOTE","note":"worker"}\\n${END}'));
if (b.appendEvent) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', JSON.stringify(b.appendEvent) + '\\n${END}'));
if (b.appendRaw) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', () => b.appendRaw + '${END}'));
if (b.editPlan) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('Approved narrative.', 'Forged narrative.'));
if (b.breakGit) { rmSync('.git/index', { force: true }); mkdirSync('.git/index'); }
if (b.sleeper) {
  const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(b.sleeper, String(s.pid)); s.unref();
}
function finish() {
  if (b.appendLate) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', JSON.stringify(b.appendLate) + '\\n${END}'));
  if (b.killGroup) process.kill(0, 'SIGKILL');
  if (b.exit) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'provider error' })); process.exit(b.exit); }
  process.stdout.write(${JSON.stringify(CLAUDE_OUT)});
}
if (b.hang) setInterval(() => {}, 1000);
else if (b.waitFor) { const t = setInterval(() => { if (existsSync(b.waitFor)) { clearInterval(t); finish(); } }, 50); }
else finish();
`;

export const STAGED = [
  { id: 'a', reads: ['docs/in.txt'], writes: ['src/a.txt'] },
  { id: 'b', deps: ['a'], reads: ['src/a.txt'], writes: ['src/b.txt'] },
  { id: 'c', writes: ['src/c.txt'] },
];
export const STAGED_BEHAVIOUR = { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } }, c: { write: { 'src/c.txt': 'c1' } } };

const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));

/**
 * Temp git repo with an approved plan, a DAG file, prompts and a fake `claude` on PATH.
 * bind: 'plan' lists the DAG digest in the narrative; 'dag_bound' records one DAG_BOUND event;
 * 'none' binds nothing. extraEvents(dagDigest) appends further RUN-STATE events.
 * digestForm: 'colon' (canonical) or 'dash' (legacy spelling the engine normalizes).
 * commit: make an initial commit so candidate ids (base HEAD) are computable.
 */
export function fixture(t, { nodes = [{ id: 'a', writes: ['src/a.txt'] }], config = {}, bind = 'plan', extraEvents = () => [],
  behaviour = { a: { write: { 'src/a.txt': 'a1' } } }, digestForm = 'colon', commit = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-engine-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  for (const d of ['src', 'docs', join('.specs', 'plans')]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'docs', 'in.txt'), 'input v1');
  spawnSync('git', ['init', '-q'], { cwd: repo });

  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'fake-claude.mjs'), FAKE_CLI(root));
  if (POSIX) { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${join(bin, 'fake-claude.mjs')}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  else writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs" %*\r\n`);
  const sep = POSIX ? ':' : ';';
  const { NODE_TEST_CONTEXT: _nested, ...base } = process.env; // a nested `node --test` must not report to this runner
  const env = { ...base, PATH: bin + sep + process.env.PATH, Path: bin + sep + (process.env.Path ?? process.env.PATH) };

  const promptFor = (id) => { const p = join(root, `prompt-${id}.txt`); writeFileSync(p, `NODE=${id}\n`); return p; };
  const dag = {
    schema: 'ship-ticket-engine-dag-v1',
    config: { provider: 'claude', modelMap: {}, permissionMode: 'acceptEdits', billing: 'subscription', width: 2,
      memoryBudgetMb: 4096, timeoutMs: 10000, budget: null, candidateExclusions: ['.specs/plans/T-1.md', 'session-log.md'],
      testCommands: {}, base: commit ? 'HEAD' : 'main', ...config },
    nodes: nodes.map(n => ({ deps: [], reads: [], writes: [], othersOwned: [], resources: [], risk: [], complexity: 'low',
      modelTier: 'inherit', estimatedMemoryMb: 64, promptFile: promptFor(n.id), phase: 'BUILD', role: 'builder',
      evidence: [], redSpecs: [], ...n })),
  };
  const dagFile = join(root, 'dag.json');
  const dagText = JSON.stringify(dag, null, 2);
  writeFileSync(dagFile, dagText);
  const dagDigest = sha(dagText);
  const dash = (d) => (digestForm === 'dash' ? d.replace(/^sha256:/, 'sha256-') : d);

  const narrative = `# Plan T-1\n\nApproved narrative.\n\n${bind === 'plan' ? `Execution DAG digest: ${dash(dagDigest)}\n\n` : ''}`;
  const skeleton = `${narrative}${BEGIN}\n${END}\n`;
  const events = [{ run_id: 'run-1', event: 'START', timestamp: '2026-11-05T00:00:00Z', approved_plan_digest: dash(narrativeDigest(skeleton)) }];
  if (bind === 'dag_bound') events.push({ run_id: 'run-1', event: 'DAG_BOUND', dag_digest: dash(dagDigest) });
  events.push(...extraEvents(dagDigest));
  const planFile = join(repo, '.specs', 'plans', 'T-1.md');
  writeFileSync(planFile, `${narrative}${BEGIN}\n${events.map(e => JSON.stringify(e)).join('\n')}\n${END}\n`);
  writeFileSync(join(root, 'behaviour.json'), JSON.stringify(behaviour));
  if (commit) {
    const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
  }

  let inputSeq = 0;
  const fx = {
    root, repo, dagFile, dagDigest, planFile, env,
    ctx: (extra = {}) => ({ repoRoot: repo, ticket: 'T-1', runId: 'run-1', dagFile, env, verifySubscription: () => true,
      handleSignals: false, ...extra }),
    stateFile: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.state.json'),
    lockFile: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.lock'),
    runLog: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.jsonl'),
    engineLog: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.engine.jsonl'),
    usageFile: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.usage.jsonl'),
    runs: (id) => { try { return readFileSync(join(root, 'runs.log'), 'utf8').split('\n').filter(l => l && (!id || l === id)); } catch { return []; } },
    behave: (b) => writeFileSync(join(root, 'behaviour.json'), JSON.stringify(b)),
    prompt: promptFor,
    readState: () => JSON.parse(readFileSync(fx.stateFile(), 'utf8')),
    editState: (fn) => { const s = fx.readState(); fn(s); writeFileSync(fx.stateFile(), JSON.stringify(s)); },
    /** Run the real engine CLI: `node run-engine.mjs <cmd> --repo --ticket --run-id [--flag value...]`. */
    cli: (cmd, flags = {}, { runId = 'run-1', timeout = 60000 } = {}) => {
      const args = [ENGINE_CLI, ...cmd.split(' '), '--repo', repo, '--ticket', 'T-1', '--run-id', runId,
        ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout });
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { status: r.status, out, stderr: r.stderr, stdout: r.stdout };
    },
    /** `run-engine.mjs gate <kind> --input <file>` with `input` written to a temp file. */
    gate: (kind, input, opts) => {
      const file = join(root, `gate-input-${++inputSeq}.json`);
      writeFileSync(file, typeof input === 'string' ? input : JSON.stringify(input));
      return fx.cli(`gate ${kind}`, { input: file }, opts);
    },
    /** Spawn the engine CLI asynchronously (for crash tests); resolves nothing, returns the child. */
    spawnCli: (cmd, flags = {}) => spawn(process.execPath, [ENGINE_CLI, ...cmd.split(' '), '--repo', repo, '--ticket', 'T-1', '--run-id', 'run-1',
      ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { env, stdio: 'ignore' }),
    candidate: () => {
      const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', repo, '--base', 'HEAD', '--exclude', '.specs/plans/T-1.md', '--exclude', 'session-log.md'],
        { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).candidate_id;
    },
    appendRunState: (event) => {
      const text = readFileSync(planFile, 'utf8');
      writeFileSync(planFile, text.replace(END, JSON.stringify(event) + '\n' + END));
    },
  };
  return fx;
}

export function spawnSpy() {
  const calls = [];
  return { calls, fn: (...args) => { calls.push(args); return spawn(...args); } };
}

export function runStateEvents(planFile) {
  const text = readFileSync(planFile, 'utf8');
  return text.slice(text.indexOf(BEGIN), text.indexOf(END)).split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
}

export function runLogEvents(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export async function waitUntil(pred, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await delay(50); }
  return false;
}

/** A complete review.md primary artifact (non-empty coverage, criteria and rule rows). */
export const primaryReview = (candidate, over = {}) => ({ reviewer_identity: 'opus:review', candidate_id: candidate,
  reviewed_paths: ['src/a.txt'], reasoned_exclusions: [],
  coverage_partitions: [{ identity: 'opus:review', owned: ['src/'], outcome: 'PASS' }],
  acceptance_criteria: [{ criterion: 'AC1', outcome: 'PASS', evidence: 'run-engine.test.mjs' }],
  rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }],
  parity_outcome: 'NOT_TRIGGERED', attack_review_outcome: 'NOT_TRIGGERED', security_outcome: 'PASS',
  findings: [], overflow: false, outcome: 'PASS', ...over });

export const secondOpinion = (candidate, over = {}) => ({ route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: candidate,
  findings: [], overflow: false, outcome: 'PASS', ...over });

/** A complete original review input (PASS by default). */
export const passReview = (rx, candidate, over = {}) => ({ review_execution: rx, kind: 'original',
  primary: primaryReview(candidate), second_opinion: secondOpinion(candidate), reconciliation: { dispositions: [] }, ...over });

/** An original FAIL review whose one primary finding on `path` is to be fixed by the repair brief `promptFile`. */
export const failReview = (rx, candidate, path, promptFile) => ({ review_execution: rx, kind: 'original',
  primary: primaryReview(candidate, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path }],
    acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: path }] }),
  second_opinion: secondOpinion(candidate),
  reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] },
  repair_prompt_file: promptFile });

/** A targeted confirmation of `rx` on the repaired candidate. */
export const confirmReview = (rx, candidate) => ({ review_execution: rx, kind: 'confirmation',
  primary: { reviewer_identity: 'opus:review', candidate_id: candidate, checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed' } });
