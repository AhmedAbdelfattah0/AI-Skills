import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runStateAppendOnly, workerRunStateAppend, AUTHORITY_EVENTS, prepareDispatch, dispatch, childEnv, verifySubscription, verifyApproval, spawnSpec,
  ownershipViolations, orchestratorPathsChanged, verifyReviewExecution, BILLING_ENV } from './carrier.mjs';
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

test('REPAIR is an explicit writer phase: needs reviewExecution, recorded as REPAIR, REVIEW still refused', (t) => {
  const fx = fixture(t);
  assert.throws(() => prepareDispatch(config(fx, { phase: 'REPAIR' })), /reviewExecution/);
  const c = prepareDispatch(config(fx, { phase: 'REPAIR', reviewExecution: 'review-1' }));
  assert.equal(c.phase, 'REPAIR');
  assert.equal(c.model_tier, 'inherit');
  assert.equal(prepareDispatch(config(fx, { phase: 'REPAIR', reviewExecution: 'review-1', risk: ['concurrency'], modelMap: { strong: 'opus' } })).model_tier, 'strong');
  assert.throws(() => prepareDispatch(config(fx, { phase: 'REVIEW', reviewExecution: 'review-1' })), /cannot be dispatched/);
});

test('REPAIR redSpecs require non-empty RED evidence before dispatch', (t) => {
  const fx = fixture(t);
  const base = { phase: 'REPAIR', reviewExecution: 'review-1', redSpecs: ['src/a.spec.ts'] };
  assert.throws(() => prepareDispatch(config(fx, base)), /redEvidence/);
  assert.throws(() => prepareDispatch(config(fx, { ...base, redEvidence: join(fx.root, 'missing.txt') })), /redEvidence/);
  writeFileSync(join(fx.root, 'empty.txt'), '');
  assert.throws(() => prepareDispatch(config(fx, { ...base, redEvidence: join(fx.root, 'empty.txt') })), /redEvidence/);
  writeFileSync(join(fx.root, 'red.txt'), 'FAIL a.spec.ts');
  assert.equal(prepareDispatch(config(fx, { ...base, redEvidence: join(fx.root, 'red.txt') })).phase, 'REPAIR');
  assert.equal(prepareDispatch(config(fx, { phase: 'REPAIR', reviewExecution: 'review-1', redSpecs: [] })).phase, 'REPAIR');
  assert.throws(() => prepareDispatch(config(fx, { ...base, redSpecs: ['../x'], redEvidence: join(fx.root, 'red.txt') })), /repository-relative/);
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

test('only the ticket own plan file is an orchestrator path; other plan-root changes are violations', () => {
  const before = new Map();
  const after = new Map([['.specs/plans/T-1.md', '1'], ['.spec/x.md', '2'], ['src/a.ts', '3'], ['package.json', '4']]);
  assert.deepEqual(ownershipViolations(before, after, ['src'], [], 'T-1'), ['.spec/x.md', 'package.json']);
  assert.deepEqual(orchestratorPathsChanged(before, after, 'T-1'), ['.specs/plans/T-1.md']);
  assert.deepEqual(orchestratorPathsChanged(null, after, 'T-1'), []);
  // Another ticket's plan, or no ticket at all, is never exempt.
  assert.deepEqual(ownershipViolations(before, new Map([['.specs/plans/T-2.md', '1']]), ['src'], [], 'T-1'), ['.specs/plans/T-2.md']);
  assert.deepEqual(ownershipViolations(before, new Map([['.specs/plans/T-1.md', '1']]), ['src'], []), ['.specs/plans/T-1.md']);
});

test('plan-file comparison is case-insensitive and returns the original path values', () => {
  const before = new Map();
  const after = new Map([['.SPECS/Plans/t-1.MD', '1'], ['.Spec/x.md', '2']]);
  assert.deepEqual(orchestratorPathsChanged(before, after, 'T-1'), ['.SPECS/Plans/t-1.MD']);
  assert.deepEqual(ownershipViolations(before, after, ['src'], [], 'T-1'), ['.Spec/x.md']);
});

test('REPAIR reviewExecution must have a REVIEW phase start in the same run log', (t) => {
  const fx = fixture(t);
  spawnSync('git', ['init', '-q'], { cwd: fx.repo });
  const approval = { ticket: 'T-1', run_id: 'run-1' };
  assert.throws(() => verifyReviewExecution(fx.repo, approval, 'review-1'), /no REVIEW phase start/);
  const dir = join(fx.repo, '.git', 'ai-skills', 'ship-ticket');
  mkdirSync(dir, { recursive: true });
  const row = (o) => JSON.stringify({ schema: 'ship-ticket-run-log-v1', ticket: 'T-1', run_id: 'run-1', event: 'start', event_id: 'e', kind: 'phase',
    name: 'REVIEW', timestamp: '2026-11-04T00:00:00Z', metrics: { review_execution: 'review-1' }, ...o }) + '\n';
  writeFileSync(join(dir, 'T-1.jsonl'), row({ run_id: 'run-2' }) + row({ name: 'BUILD' }) + row({ kind: 'activity' }) + row({ event: 'end' }) + row({ metrics: { review_execution: 'review-9' } }));
  assert.throws(() => verifyReviewExecution(fx.repo, approval, 'review-1'), /no REVIEW phase start/);
  writeFileSync(join(dir, 'T-1.jsonl'), row({}));
  verifyReviewExecution(fx.repo, approval, 'review-1');
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

test('integration: RUN-STATE edit during a REPAIR run is reported, not a violation', async (t) => {
  const fx = fixture(t);
  const env = fakeCli(t, fx, `import { readFileSync, writeFileSync } from 'node:fs';
process.stdin.resume(); process.stdin.on('end', () => { const p = '.specs/plans/T-1.md'; writeFileSync(p, readFileSync(p, 'utf8').replace('<!-- RUN-STATE:END -->', '{"event":"NOTE"}\\n<!-- RUN-STATE:END -->')); process.stdout.write(${JSON.stringify(CLAUDE_OUT)}); });
`);
  const logDir = join(fx.repo, '.git', 'ai-skills', 'ship-ticket');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'T-1.jsonl'), JSON.stringify({ schema: 'ship-ticket-run-log-v1', ticket: 'T-1', run_id: 'run-1', event: 'start',
    event_id: 'e1', kind: 'phase', name: 'REVIEW', timestamp: '2026-11-04T00:00:00Z', metrics: { review_execution: 'review-1' } }) + '\n');
  const result = await dispatch(config(fx, { phase: 'REPAIR', reviewExecution: 'review-1', usageLog: join(fx.root, 'u.jsonl') }),
    { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(result.phase, 'REPAIR');
  assert.equal(result.ownership_check, 'clean');
  assert.deepEqual(result.writes_outside_ownership, []);
  assert.deepEqual(result.orchestrator_paths_changed, ['.specs/plans/T-1.md']);
  assert.equal(result.succeeded, true);
  assert.equal(JSON.parse(readFileSync(join(fx.root, 'u.jsonl'), 'utf8')).phase, 'REPAIR');
});

test('integration: editing another plan file during a worker run is a violation', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.repo, '.specs', 'other.md'), 'x');
  const env = fakeCli(t, fx, `import { appendFileSync } from 'node:fs';
process.stdin.resume(); process.stdin.on('end', () => { appendFileSync('.specs/other.md', 'note'); process.stdout.write(${JSON.stringify(CLAUDE_OUT)}); });
`);
  const result = await dispatch(config(fx), { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(result.ownership_check, 'violated');
  assert.deepEqual(result.writes_outside_ownership, ['.specs/other.md']);
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
  // 5 s, not 1.5 s: under a loaded full-suite run the fake CLI can need over 1.5 s to start and write its pid file.
  const result = await dispatch(config(fx, { timeoutMs: 5000 }), { env, verifySubscription: () => true, handleSignals: false });
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

test('runStateAppendOnly accepts only insertions inside the RUN-STATE block', () => {
  const base = '# Plan\n\nscope\n<!-- RUN-STATE:BEGIN -->\n{"event":"START"}\n<!-- RUN-STATE:END -->\n';
  const appended = base.replace('<!-- RUN-STATE:END -->', '{"event":"NOTE"}\n<!-- RUN-STATE:END -->');
  assert.equal(runStateAppendOnly(base, appended), true);
  assert.equal(runStateAppendOnly(base, base), true, 'unchanged is fine');
  assert.equal(runStateAppendOnly(base, appended.replace('scope', 'widened scope')), false, 'edit outside the block');
  assert.equal(runStateAppendOnly(base, base.replace('{"event":"START"}', '{"event":"START","digest":"x"}')), false, 'rewrite of an existing event');
  assert.equal(runStateAppendOnly(base, base + 'tail'), false, 'text after END');
  assert.equal(runStateAppendOnly(base, base.replace('<!-- RUN-STATE:END -->', '<!-- RUN-STATE:END -->\n<!-- RUN-STATE:BEGIN -->\n<!-- RUN-STATE:END -->')), false, 'second block');
  assert.equal(runStateAppendOnly(base, null), false, 'deleted');
  assert.equal(runStateAppendOnly(null, base), false, 'created');
  assert.equal(runStateAppendOnly('# no block\n', '# no block\nmore'), false, 'no markers');
});

test('workerRunStateAppend: an append-only change is exempt only when it inserts no START, DAG_BOUND, RETRY or UNIT_CLEAR', () => {
  const base = '# Plan\n<!-- RUN-STATE:BEGIN -->\n{"event":"START"}\n<!-- RUN-STATE:END -->\n';
  const add = (line) => base.replace('<!-- RUN-STATE:END -->', line + '\n<!-- RUN-STATE:END -->');
  assert.equal(workerRunStateAppend(base, add('{"event":"NOTE"}')), true);
  assert.deepEqual(AUTHORITY_EVENTS, ['START', 'DAG_BOUND', 'RETRY', 'UNIT_CLEAR']);
  for (const ev of AUTHORITY_EVENTS) assert.equal(workerRunStateAppend(base, add(`{"event":"NOTE"}\n  {"event":"${ev}"}`)), false, ev);
  assert.equal(workerRunStateAppend(base, add('{"event":"NOTE"}').replace('# Plan', '# Plan!')), false, 'still append-only first');
});

for (const [name, script] of [
  ['edits the approved plan outside RUN-STATE', `const p = '.specs/plans/T-1.md'; writeFileSync(p, readFileSync(p, 'utf8').replace('# Plan', '# Plan (worker edit)'));`],
  ['deletes the plan file', `rmSync('.specs/plans/T-1.md');`],
  ...['START', 'DAG_BOUND', 'RETRY', 'UNIT_CLEAR'].map(ev => [`appends a ${ev} authority event inside RUN-STATE`,
    `const p = '.specs/plans/T-1.md'; writeFileSync(p, readFileSync(p, 'utf8').replace('<!-- RUN-STATE:END -->', '{"event":"${ev}","run_id":"run-1","authorized_by":"owner"}\\n<!-- RUN-STATE:END -->'));`]),
]) {
  test('integration: a worker that ' + name + ' is an ownership violation', async (t) => {
    const fx = fixture(t);
    const env = fakeCli(t, fx, `import { readFileSync, writeFileSync, rmSync } from 'node:fs';
process.stdin.resume(); process.stdin.on('end', () => { ${script} process.stdout.write(${JSON.stringify(CLAUDE_OUT)}); });
`);
    const result = await dispatch(config(fx), { env, verifySubscription: () => true, handleSignals: false });
    assert.equal(result.ownership_check, 'violated');
    assert.deepEqual(result.writes_outside_ownership, ['.specs/plans/T-1.md']);
    assert.deepEqual(result.orchestrator_paths_changed, []);
    assert.equal(result.succeeded, false);
  });
}

// ---- P0-3 (RED): changed_paths, structured report, onSpawn/attempt_id, usage role. ----
//
// New carrier API contract (implemented by the `carrier` builder; these tests define it):
// - dispatch result gains `changed_paths`: sorted array of repo-relative paths whose git-dirty
//   fingerprint changed during the run (net change vs the pre-run snapshot, like ownershipViolations)
//   EXCLUDING paths under ownership.othersOwned. Writes outside ownership are still listed.
//   Pre-existing unchanged dirt is not listed. `null` when git state is unavailable.
// - The worker's final message may end with a fenced block ```ship-ticket-report {json} ``` holding
//   {tests:[{cmd,result:'pass'|'fail'}], red_seen:[string], blockers:[string], needs_outside_ownership:[string]}.
//   The carrier parses + validates it. The message file (resultFile) then has `report: <object>`
//   and the result has `report_status: 'structured'`. Invalid JSON, wrong shape, or a missing block =>
//   message file `report: "unstructured"` + `report_failure: <non-empty string>` (message text kept in
//   `final_message`), result `report_status: 'unstructured'`, and the dispatch is NOT failed because of it
//   (`succeeded` unaffected).
// - config.attemptId (optional, SAFE id) else generated. Result, message file and usage-log event all
//   carry `attempt_id`. Usage event also carries `source:'carrier'`, `source_execution_id: attempt_id`.
// - deps.onSpawn({attempt_id, pid, pgid}) is called (and awaited if it returns a promise) AFTER the child is
//   spawned but BEFORE the prompt is released on its stdin. pgid === pid on POSIX (detached group leader),
//   null on win32.
// - config.role: 'builder'|'repair'|'evidence' (optional; default builder for BUILD, repair for REPAIR).
//   Anything else throws /role/ from prepareDispatch. The usage-log event carries `role`; result carries `role`.

const REPORT = { tests: [{ cmd: 'node --test a.test.mjs', result: 'pass' }], red_seen: ['a spec'], blockers: [], needs_outside_ownership: [] };
const claudeOut = (text) => JSON.stringify({ ...JSON.parse(CLAUDE_OUT), result: text });
const stdinThen = (fx, body, out = CLAUDE_OUT) => `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
process.stdin.resume(); process.stdin.on('end', () => { ${body}
process.stdout.write(${JSON.stringify(out)}); });
`;

test('RED carrier: dispatch exposes changed_paths excluding concurrent siblings, including outside writes', async (t) => {
  const fx = fixture(t);
  mkdirSync(join(fx.repo, 'api'), { recursive: true });
  writeFileSync(join(fx.repo, 'README.md'), 'pre-existing');
  const env = fakeCli(t, fx, stdinThen(fx, `writeFileSync('src/a.txt','1'); writeFileSync('api/sibling.txt','2'); writeFileSync('package.json','{}');`));
  const result = await dispatch(config(fx, { ownership: { writes: ['src'], othersOwned: ['api'] } }),
    { env, verifySubscription: () => true, handleSignals: false });
  assert.deepEqual(result.changed_paths, ['package.json', 'src/a.txt']);
  assert.deepEqual(result.writes_outside_ownership, ['package.json'], 'existing ownership semantics unchanged');
});

test('RED carrier: a valid ship-ticket-report block is validated into the message file', async (t) => {
  const fx = fixture(t);
  const text = 'Done.\n\n```ship-ticket-report\n' + JSON.stringify(REPORT) + '\n```\n';
  const env = fakeCli(t, fx, stdinThen(fx, '', claudeOut(text)));
  const result = await dispatch(config(fx, { resultFile: join(fx.root, 'm.json') }), { env, verifySubscription: () => true, handleSignals: false });
  const msg = JSON.parse(readFileSync(join(fx.root, 'm.json'), 'utf8'));
  assert.deepEqual(msg.report, REPORT);
  assert.equal(result.report_status, 'structured');
  assert.equal(result.succeeded, true);
});

test('RED carrier: invalid JSON, wrong shape or a missing block is unstructured, recorded, never fatal', async (t) => {
  const cases = {
    badjson: 'Done.\n```ship-ticket-report\n{not json\n```\n',
    badshape: 'Done.\n```ship-ticket-report\n' + JSON.stringify({ tests: 'nope', red_seen: [], blockers: [], needs_outside_ownership: [] }) + '\n```\n',
    missing: 'Done, no report at all.',
  };
  for (const [name, text] of Object.entries(cases)) {
    const fx = fixture(t);
    const env = fakeCli(t, fx, stdinThen(fx, '', claudeOut(text)));
    const result = await dispatch(config(fx, { resultFile: join(fx.root, 'm.json') }), { env, verifySubscription: () => true, handleSignals: false });
    const msg = JSON.parse(readFileSync(join(fx.root, 'm.json'), 'utf8'));
    assert.equal(msg.report, 'unstructured', name);
    assert.equal(typeof msg.report_failure, 'string', name);
    assert.ok(msg.report_failure.length > 0, name);
    assert.equal(msg.final_message, text, name + ': free text kept');
    assert.equal(result.report_status, 'unstructured', name);
    assert.equal(result.succeeded, true, name + ': not fatal');
  }
});

test('RED carrier: onSpawn gets {attempt_id,pid,pgid} before the prompt is released; attempt_id is on result, message and usage event', async (t) => {
  const fx = fixture(t);
  const marker = join(fx.root, 'child-read-stdin.txt');
  const env = fakeCli(t, fx, stdinThen(fx, `writeFileSync(${JSON.stringify(marker)}, String(Date.now()));`));
  let seen = null, hookDone = 0, markerExistedAtHook = null, alive = null;
  const onSpawn = async (info) => {
    seen = info;
    markerExistedAtHook = existsSync(marker);
    try { process.kill(info.pid, 0); alive = true; } catch { alive = false; }
    await new Promise(r => setTimeout(r, 300));
    hookDone = Date.now();
  };
  const result = await dispatch(config(fx, { attemptId: 'att-1', resultFile: join(fx.root, 'm.json'), usageLog: join(fx.root, 'u.jsonl') }),
    { env, verifySubscription: () => true, handleSignals: false, onSpawn });
  assert.ok(seen, 'onSpawn called');
  assert.equal(seen.attempt_id, 'att-1');
  assert.ok(Number.isInteger(seen.pid) && seen.pid > 0);
  if (process.platform !== 'win32') assert.equal(seen.pgid, seen.pid); else assert.equal(seen.pgid, null);
  assert.equal(alive, true, 'child alive when hook runs');
  assert.equal(markerExistedAtHook, false, 'child had not yet received the prompt');
  assert.ok(Number(readFileSync(marker, 'utf8')) >= hookDone, 'prompt released only after the awaited hook finished');
  assert.equal(result.attempt_id, 'att-1');
  assert.equal(JSON.parse(readFileSync(join(fx.root, 'm.json'), 'utf8')).attempt_id, 'att-1');
  const ev = JSON.parse(readFileSync(join(fx.root, 'u.jsonl'), 'utf8').trim());
  assert.equal(ev.attempt_id, 'att-1');
  assert.equal(ev.source, 'carrier');
  assert.equal(ev.source_execution_id, 'att-1');
});

test('RED carrier: attempt_id is generated when not configured', async (t) => {
  const fx = fixture(t);
  const env = fakeCli(t, fx, stdinThen(fx, ''));
  const result = await dispatch(config(fx), { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(typeof result.attempt_id, 'string');
  assert.match(result.attempt_id,/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
});

test('RED carrier: usage events carry role from config; invalid role is refused', async (t) => {
  const fx = fixture(t);
  assert.throws(() => prepareDispatch(config(fx, { role: 'orchestrator' })), /role/);
  assert.throws(() => prepareDispatch(config(fx, { role: 'root' })), /role/);
  const env = fakeCli(t, fx, stdinThen(fx, ''));
  for (const role of ['builder', 'repair', 'evidence']) {
    const log = join(fx.root, role + '.jsonl');
    const result = await dispatch(config(fx, { role, usageLog: log }), { env, verifySubscription: () => true, handleSignals: false });
    assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).role, role);
    assert.equal(result.role, role);
  }
  const def = join(fx.root, 'def.jsonl');
  await dispatch(config(fx, { usageLog: def }), { env, verifySubscription: () => true, handleSignals: false });
  assert.equal(JSON.parse(readFileSync(def, 'utf8').trim()).role, 'builder', 'BUILD defaults to builder');
});
