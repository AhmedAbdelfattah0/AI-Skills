import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareDispatch, dispatch, childEnv, verifySubscription, verifyApproval, spawnSpec,
  ownershipViolations, BILLING_ENV } from './carrier.mjs';
import { extractUsage, summarizeUsage } from './usage.mjs';

// Real output shapes captured from Claude Code 2.1.318 and Codex CLI 0.166.0 (content trimmed).
const CLAUDE_OUT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK',
  total_cost_usd: 0.00536751, usage: { input_tokens: 2, cache_creation_input_tokens: 26257,
    cache_read_input_tokens: 11391, output_tokens: 4, output_tokens_details: { thinking_tokens: 0 } },
  modelUsage: { 'claude-haiku-5-5': { costUSD: 0.00536751, costBasis: 'list' } } });
const CODEX_OUT = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":28116,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

const DIGEST = 'sha256-abcdef0123456789';

function fixture(t, { start = true, digest = DIGEST } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'carrier-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.specs', 'plans'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  const events = start ? JSON.stringify({ run_id: 'run-1', event: 'START', timestamp: '2026-11-04T00:00:00Z',
    approved_plan_digest: digest }) + '\n' : '';
  writeFileSync(join(repo, '.specs', 'plans', 'T-1.md'), `# Plan\n\n<!-- RUN-STATE:BEGIN -->\n${events}<!-- RUN-STATE:END -->\n`);
  writeFileSync(join(root, 'prompt.txt'), 'Implement the node.');
  return { root, repo };
}

const config = (fx, extra = {}) => ({ phase: 'BUILD', provider: 'claude', nodeId: 'frontend', workdir: fx.repo,
  ownership: { writes: ['src'] }, timeoutMs: 10000, promptFile: join(fx.root, 'prompt.txt'),
  approval: { ticket: 'T-1', runId: 'run-1', approvedPlanDigest: DIGEST }, ...extra });

test('carrier refuses PLAN and REVIEW', (t) => {
  const fx = fixture(t);
  assert.throws(() => prepareDispatch(config(fx, { phase: 'PLAN' })), /cannot be dispatched/);
  assert.throws(() => prepareDispatch(config(fx, { phase: 'REVIEW' })), /cannot be dispatched/);
});

test('verified adapters build exact verified flags and reject smuggled arguments', (t) => {
  const fx = fixture(t);
  const c = prepareDispatch(config(fx, { modelMap: { strong: 'opus' }, risk: ['auth'] }));
  assert.deepEqual(c.args, ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--model', 'opus']);
  const x = prepareDispatch(config(fx, { provider: 'codex', complexity: 'low', modelMap: { economy: 'gpt-mini' } }));
  assert.deepEqual(x.args, ['exec', '--json', '--ephemeral', '-s', 'workspace-write', '-m', 'gpt-mini', '-']);
  assert.throws(() => prepareDispatch(config(fx, { args: ['--model', 'haiku'] })), /builds its own/);
  assert.throws(() => prepareDispatch(config(fx, { permissionMode: 'bypassPermissions' })), /permissionMode/);
  assert.throws(() => prepareDispatch(config(fx, { provider: 'codex', sandbox: 'danger-full-access' })), /sandbox/);
});

test('strong routing is refused unless a strong model is mapped (CX-1)', (t) => {
  const fx = fixture(t);
  assert.throws(() => prepareDispatch(config(fx, { risk: ['auth'], modelTier: 'economy', modelMap: { economy: 'haiku' } })), /strong tier requires/);
  assert.throws(() => prepareDispatch(config(fx, { provider: 'gemini', executable: 'gemini', args: [], acknowledgeUnverifiedAuth: true,
    complexity: 'high', modelMap: { strong: 'x' } })), /verified adapter/);
});

test('inherit applies an explicit host-model mapping, else declares provider-default (CX-1)', (t) => {
  const fx = fixture(t);
  const mapped = prepareDispatch(config(fx, { modelMap: { inherit: 'claude-opus-5-5', economy: 'haiku' } }));
  assert.equal(mapped.model_tier, 'inherit');
  assert.deepEqual(mapped.args.slice(-2), ['--model', 'claude-opus-5-5']);
  assert.equal(mapped.model_resolution, 'mapped');
  const unmapped = prepareDispatch(config(fx, { modelMap: { economy: 'haiku' } }));
  assert.equal(unmapped.model_resolution, 'provider-default');
  assert.equal(unmapped.args.includes('--model'), false);
});

test('unverified providers need a trusted template and never receive a model flag', (t) => {
  const fx = fixture(t);
  assert.throws(() => prepareDispatch(config(fx, { provider: 'antigravity' })), /explicit trusted executable/);
  assert.throws(() => prepareDispatch(config(fx, { provider: 'gemini', executable: 'gemini', args: ['--yolo'] })), /acknowledgeUnverifiedAuth/);
  const g = prepareDispatch(config(fx, { provider: 'gemini', executable: 'gemini', args: ['--yolo'], modelMap: { inherit: 'x' },
    acknowledgeUnverifiedAuth: true }));
  assert.equal(g.adapter, 'trusted-template');
  assert.equal(g.model_applied, false);
  assert.throws(() => prepareDispatch(config(fx, { provider: 'gemini', executable: 'gemini', args: ['do it; rm -rf /'], acknowledgeUnverifiedAuth: true })), /safe tokens/);
});

test('workdir must be absolute for the host platform and output files stay out of the candidate', (t) => {
  const fx = fixture(t);
  assert.throws(() => prepareDispatch(config(fx, { workdir: 'relative/path' })), /absolute workdir/);
  assert.throws(() => prepareDispatch(config(fx, { resultFile: join(fx.repo, 'src', 'out.json') })), /outside the repository/);
  assert.throws(() => prepareDispatch(config(fx, { resultFile: join(fx.repo, '.git', 'r.json') })), /outside the repository/,
    'a ".git" path segment is not trusted when there is no real Git metadata');
  spawnSync('git', ['init', '-q'], { cwd: fx.repo });
  assert.ok(prepareDispatch(config(fx, { resultFile: join(fx.repo, '.git', 'r.json') })).resultFile);
  assert.ok(prepareDispatch(config(fx, { resultFile: join(fx.root, 'r.json') })).resultFile);
  mkdirSync(join(fx.repo, 'apps', 'web'), { recursive: true });
  assert.throws(() => prepareDispatch(config(fx, { workdir: join(fx.repo, 'apps', 'web'), resultFile: join(fx.repo, 'apps', 'api.json') })),
    /outside the repository/, 'checked against the repository, not just the workdir (CX-10)');
  if (process.platform !== 'win32') {
    symlinkSync(join(fx.repo, 'src'), join(fx.root, 'escape'));
    assert.throws(() => prepareDispatch(config(fx, { resultFile: join(fx.root, 'escape', 'x.json') })), /outside the repository/, 'symlink escape (CX-10)');
  }
  assert.throws(() => prepareDispatch(config(fx, { ownership: { writes: ['.specs'] } })), /plan artifact roots/, 'CL-4');
  assert.throws(() => prepareDispatch(config(fx, { ownership: { writes: ['.spec/plans'] } })), /plan artifact roots/, 'CL-4');
  assert.throws(() => prepareDispatch(config(fx, { ownership: { writes: ['src'], othersOwned: ['.specs'] } })), /plan artifact roots/, 'CL-4 via othersOwned');
  assert.throws(() => prepareDispatch(config(fx, { ownership: { writes: ['.SPECS'] } })), /plan artifact roots/, 'CL-4 case-insensitive');
  assert.throws(() => prepareDispatch(config(fx, { ownership: { writes: ['src'], othersOwned: ['.Spec/plans/T.md'] } })), /plan artifact roots/, 'CL-4 case-insensitive othersOwned');
  assert.throws(() => prepareDispatch(config(fx, { promptFile: fx.root })), /regular file/, 'CX-8');
  writeFileSync(join(fx.root, 'stale.json'), '{}');
  assert.throws(() => prepareDispatch(config(fx, { resultFile: join(fx.root, 'stale.json') })), /must not exist yet/);
});

test('subscription billing strips provider API credentials; API billing needs explicit authority', (t) => {
  const fx = fixture(t);
  const env = childEnv('claude', 'subscription', { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 'y', PATH: '/bin' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(childEnv('codex', 'subscription', { OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k' }).OPENAI_API_KEY, undefined);
  assert.equal(childEnv('claude', 'api', { ANTHROPIC_API_KEY: 'sk-x' }).ANTHROPIC_API_KEY, 'sk-x');
  const mixed = childEnv('codex', 'subscription', { openai_api_key: 'k', Codex_Api_Key: 'k', Path: 'x' });
  assert.deepEqual(Object.keys(mixed), ['Path'], 'case-insensitive stripping for Windows (CX-3)');
  for (const p of Object.keys(BILLING_ENV)) assert.ok(BILLING_ENV[p].length > 0);
  assert.throws(() => prepareDispatch(config(fx, { billing: 'api' })), /allowApiBilling/);
});

test('subscription preflight discriminates real auth status output', () => {
  const fake = (out) => () => ({ status: 0, stdout: out, stderr: '' });
  assert.equal(verifySubscription('claude', {}, fake('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}')), true);
  assert.equal(verifySubscription('claude', {}, fake('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}')), false);
  assert.equal(verifySubscription('claude', {}, fake('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}')), false);
  assert.equal(verifySubscription('claude', {}, fake('not json')), false);
  assert.equal(verifySubscription('claude', {}, fake('{"loggedIn":true,"authMethod":"claude.ai"}')), false, 'missing apiProvider fails closed');
  assert.equal(verifySubscription('codex', {}, fake('Logged in using ChatGPT')), true);
  assert.equal(verifySubscription('codex', {}, fake('Logged in using an API key')), false);
  assert.equal(verifySubscription('gemini', {}, fake('')), 'unverified');
});

test('an already-aborted signal never launches a worker (CX-7)', async (t) => {
  const fx = fixture(t);
  let spawned = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dispatch(config(fx), { signal: controller.signal, verifySubscription: () => true, spawn: () => { spawned = true; } }), /cancelled before start/);
  assert.equal(spawned, false);
});

test('dispatch refuses before spawning when subscription auth is not proven', async (t) => {
  const fx = fixture(t);
  let spawned = false;
  await assert.rejects(dispatch(config(fx), { verifySubscription: () => false, spawn: () => { spawned = true; } }), /subscription authentication/);
  assert.equal(spawned, false);
});

test('approval evidence must match the plan RUN-STATE START event', (t) => {
  const fx = fixture(t);
  assert.equal(verifyApproval(fx.repo, { ticket: 'T-1', runId: 'run-1', approvedPlanDigest: DIGEST }).run_id, 'run-1');
  assert.throws(() => verifyApproval(fx.repo, { ticket: 'T-1', runId: 'run-1', approvedPlanDigest: 'sha256-other000' }), /digest mismatch/);
  assert.throws(() => verifyApproval(fx.repo, { ticket: 'T-1', runId: 'run-2', approvedPlanDigest: DIGEST }), /no START event/);
  assert.throws(() => verifyApproval(fx.repo, { ticket: 'T-9', runId: 'run-1', approvedPlanDigest: DIGEST }), /not found/);
  const pending = fixture(t, { start: false });
  assert.throws(() => verifyApproval(pending.repo, { ticket: 'T-1', runId: 'run-1', approvedPlanDigest: DIGEST }), /no START event/);
});

test('Windows .cmd shims run through a quoted shell only with safe arguments', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };
  const exists = (p) => p === join('C:\\bin', 'codex.CMD');
  const spec = spawnSpec('codex', ['exec', '--json', '-'], 'win32', env, exists);
  assert.equal(spec.shell, true);
  assert.match(spec.file, /^".*codex\.CMD"$/);
  assert.throws(() => spawnSpec('codex', ['a&b'], 'win32', env, exists), /unsafe argument/);
  assert.deepEqual(spawnSpec('claude', ['-p'], 'linux'), { file: 'claude', args: ['-p'], shell: false });
});

test('usage extraction from real Claude and Codex output shapes', () => {
  const c = extractUsage('claude', CLAUDE_OUT);
  assert.deepEqual([c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens], [2, 4, 11391, 26257]);
  assert.equal(c.reported_cost_usd, 0.00536751);
  assert.equal(c.cost_basis, 'list');
  const x = extractUsage('codex', CODEX_OUT + '\n' + CODEX_OUT.split('\n')[3]);
  assert.equal(x.input_tokens, 56232, 'multiple turns are summed');
  assert.equal(x.reported_cost_usd, null, 'codex reports no cost; never estimated');
  assert.equal(extractUsage('claude', 'not json'), null);
  assert.equal(extractUsage('gemini', '{}'), null);
});

test('usage summary preserves unknowns, reports cache ratio and rejects bad counters', () => {
  const r = summarizeUsage([{ provider: 'claude', run_id: 'a', input_tokens: 10, cache_read_tokens: 30, cache_write_tokens: 0, cost_basis: 'list' },
    { provider: 'claude', run_id: 'a', output_tokens: 3 }, { provider: 'claude', run_id: 'a' }]);
  assert.equal(r.providers.claude.input_tokens, 10);
  assert.equal(r.providers.claude.reported_cost_usd, null);
  assert.equal(r.providers.claude.cache_hit_ratio, 0.75);
  assert.equal(r.providers.claude.events_without_usage, 1);
  assert.deepEqual(r.providers.claude.cost_bases, ['list']);
  assert.throws(() => summarizeUsage([{ provider: 'claude', run_id: 'a', input_tokens: -1 }]), /invalid usage/);
  assert.equal(r.providers.claude.counter_events.input_tokens, 1, 'coverage: 1 of 3 events reported input_tokens');
  assert.equal(r.providers.claude.counter_events.output_tokens, 1);
  const mixed = [{ provider: 'claude', run_id: 'a', output_tokens: 3 }, { provider: 'claude', run_id: 'b', output_tokens: 100 }];
  assert.equal(summarizeUsage(mixed, 'a').providers.claude.output_tokens, 3, 'run filter excludes other runs');
  assert.equal(summarizeUsage(mixed, 'a').run_id, 'a');
  assert.equal(summarizeUsage(mixed).providers.claude.output_tokens, 103);
  assert.throws(() => summarizeUsage(mixed, '../x'), /invalid run_id filter/);
});

test('ownership violations ignore owned, concurrently owned and pre-existing unchanged paths', () => {
  const before = new Map([['README.md', '1:1']]);
  const after = new Map([['README.md', '1:1'], ['src/a.ts', '2:2'], ['api/x.ts', '3:3'], ['package.json', '4:4']]);
  assert.deepEqual(ownershipViolations(before, after, ['src'], ['api']), ['package.json']);
  assert.equal(ownershipViolations(null, after, ['src'], []), null);
  assert.deepEqual(ownershipViolations(new Map([['user.txt', ' M:1']]), new Map(), ['src'], []), ['user.txt'],
    'reverting or deleting a pre-existing user change is a violation (CX-4)');
});

// ---- Integration: a real child process through the real spawn/kill/stdin path. ----

function fakeCli(t, fx, body) {
  const bin = join(fx.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(script, body);
  if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs" %*\r\n`);
  else { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${script}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  spawnSync('git', ['init', '-q'], { cwd: fx.repo });
  spawnSync('git', ['add', '-A'], { cwd: fx.repo });
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: bin + sep + process.env.PATH, Path: bin + sep + (process.env.Path ?? process.env.PATH),
    ANTHROPIC_API_KEY: 'sk-must-not-leak' };
}

test('integration: prompt on stdin, usage and message captured, key never reaches the child', async (t) => {
  const fx = fixture(t);
  const env = fakeCli(t, fx, `import { readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
writeFileSync('src/built.txt', 'ok');
writeFileSync(${JSON.stringify(join(fx.root, 'child-env.json'))}, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, argv: process.argv.slice(2), prompt }));
process.stdout.write(${JSON.stringify(CLAUDE_OUT)});
`);
  // A pre-existing world-readable log must be tightened before the append (mode applies only on creation).
  writeFileSync(join(fx.root, 'usage.jsonl'), '');
  chmodSync(join(fx.root, 'usage.jsonl'), 0o644);
  const result = await dispatch(config(fx, { resultFile: join(fx.root, 'message.json'), usageLog: join(fx.root, 'usage.jsonl'),
    modelMap: { strong: 'opus' }, complexity: 'high' }),
    { env, verifySubscription: () => true, handleSignals: false });
  const child = JSON.parse(readFileSync(join(fx.root, 'child-env.json'), 'utf8'));
  assert.equal(child.key, null, 'API key stripped under subscription billing');
  assert.equal(child.prompt, 'Implement the node.');
  assert.equal(child.argv.includes('Implement the node.'), false, 'prompt not on argv');
  assert.deepEqual(child.argv.slice(-2), ['--model', 'opus']);
  assert.equal(result.succeeded, true);
  assert.equal(result.usage.cache_read_tokens, 11391);
  assert.ok(result.run_log_metrics.includes('input_tokens=2'));
  assert.equal(result.ownership_check, 'clean');
  assert.equal(JSON.stringify(result).includes('OK"'), false, 'raw output is not in the result');
  assert.equal(JSON.parse(readFileSync(join(fx.root, 'message.json'), 'utf8')).final_message, 'OK');
  assert.equal(summarizeUsage(readFileSync(join(fx.root, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)).providers.claude.output_tokens, 4);
  if (process.platform !== 'win32') assert.equal(statSync(join(fx.root, 'usage.jsonl')).mode & 0o777, 0o600, 'existing usage log restricted to 0600');
});

test('integration: writes outside ownership fail the node', async (t) => {
  const fx = fixture(t);
  const env = fakeCli(t, fx, `import { writeFileSync } from 'node:fs';
process.stdin.resume(); process.stdin.on('end', () => { writeFileSync('package.json', '{}'); process.stdout.write(${JSON.stringify(CLAUDE_OUT)}); });
`);
  const result = await dispatch(config(fx), { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(result.ownership_check, 'violated');
  assert.deepEqual(result.writes_outside_ownership, ['package.json']);
  assert.equal(result.succeeded, false);
});

test('integration: timeout kills the child process tree', async (t) => {
  const fx = fixture(t);
  const pidFile = join(fx.root, 'grandchild.pid');
  const env = fakeCli(t, fx, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setTimeout(() => {}, 60000);
`);
  const started = Date.now();
  const result = await dispatch(config(fx, { timeoutMs: 1500 }), { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(result.timed_out, true);
  assert.equal(result.succeeded, false);
  assert.ok(Date.now() - started < 20000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise(r => setTimeout(r, 500));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'grandchild was killed with the tree');
});

test('integration: abort signal cancels a running node', async (t) => {
  const fx = fixture(t);
  const env = fakeCli(t, fx, `setTimeout(() => {}, 60000);\n`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const result = await dispatch(config(fx), { env, verifySubscription: () => true, handleSignals: false, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.succeeded, false);
  assert.equal(existsSync(join(fx.repo, 'src', 'built.txt')), false);
});

test('integration: telemetry failure never discards the execution outcome (CX-11)', async (t) => {
  const fx = fixture(t);
  const env = fakeCli(t, fx, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(CLAUDE_OUT)}));\n`);
  const result = await dispatch(config(fx, { usageLog: join(fx.root, 'missing-dir', 'usage.jsonl') }),
    { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(result.succeeded, true);
  assert.deepEqual(result.telemetry_degraded, ['usage_log:ENOENT']);
  assert.equal(result.usage.output_tokens, 4);
});

test('integration: a background descendant cannot hold dispatch open or outlive it (CX-5, CL-1)', { skip: process.platform === 'win32'
  ? 'Windows: no process group survives the leader; documented limitation' : false }, async (t) => {
  const fx = fixture(t);
  const pidFile = join(fx.root, 'bg.pid');
  const env = fakeCli(t, fx, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
process.stdout.write(${JSON.stringify(CLAUDE_OUT)});
process.exit(0);
`);
  const started = Date.now();
  const result = await dispatch(config(fx, { timeoutMs: 30000 }), { env, verifySubscription: () => true, handleSignals: false });
  assert.ok(Date.now() - started < 15000, 'did not wait for the inherited pipes or the timeout');
  assert.equal(result.exit_code, 0);
  assert.equal(result.process_tree_terminated, true, 'termination verified, not just signalled (CX-6)');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'SIGTERM-ignoring descendant was SIGKILLed before dispatch returned (CX-6)');
});
