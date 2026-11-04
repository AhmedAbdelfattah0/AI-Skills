#!/usr/bin/env node
/**
 * Guarded writer carrier for BUILD/PROVE/SHIP nodes. PLAN and REVIEW are refused.
 *
 * Provider adapters use only flags verified against the installed CLIs
 * (Claude Code 2.1.318, Codex CLI 0.166.0, 2026-11-04):
 *   claude -p --output-format json --no-session-persistence --permission-mode <m> [--model <id>]
 *   codex exec --json --ephemeral -s <sandbox> [-m <id>] -        (prompt on stdin)
 * Gemini and Antigravity were not installed to verify; they run only from an
 * explicit trusted executable + argument template, with no model injection and
 * no usage parsing.
 *
 * Safety defaults: subscription billing (provider API-key variables are removed
 * from the child and the CLI's own auth status must prove a subscription login);
 * the approved plan's RUN-STATE START event must match the supplied digest and
 * run ID; prompts travel on stdin, never argv; raw model output is never printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { routeModel, isEntrypoint } from './harness.mjs';
import { extractUsage, COUNTERS } from './usage.mjs';

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const VERIFIED = new Set(['claude', 'codex']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/;
const SAFE_ARG = /^[A-Za-z0-9_.,:=@%+\/\[\]-]{1,256}$/;
const DIGEST = /^[A-Za-z0-9:_-]{8,160}$/;
const CLAUDE_MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'manual']); // never bypassPermissions or plan
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write']); // never danger-full-access
const MAX_CAPTURE = 32 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

/** Environment variables that route a provider CLI to metered API billing. */
export const BILLING_ENV = Object.freeze({
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
});

function fail(message) { throw new Error(message); }

function repoRelative(paths, label) {
  if (!Array.isArray(paths)) fail(label + ' must be an array');
  return paths.map(p => {
    if (typeof p !== 'string' || !p || isAbsolute(p) || p.includes('\\')
      || p.split('/').some(s => s === '..' || s === '.' || !s)) fail(label + ' paths must be repository-relative and normalized');
    return p;
  });
}

function outside(dir, file) {
  const rel = relative(dir, file);
  return rel === '' ? false : rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel);
}

/** Output files may live outside the workdir, or inside its Git metadata; never in candidate paths. */
function safeOutputPath(path, workdir, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(label + ' must be an absolute path');
  const abs = resolve(path);
  if (!outside(workdir, abs) && !relative(workdir, abs).split(sep).includes('.git'))
    fail(label + ' must be outside the worktree or under its .git metadata');
  return abs;
}

/**
 * Approval evidence: the plan artifact's RUN-STATE block must hold a START
 * event for this run with the same approved-plan digest. The harness reads the
 * artifact PLAN produced; it never writes it.
 */
export function verifyApproval(repoRoot, approval) {
  if (!approval || typeof approval !== 'object') fail('approval evidence required');
  const { ticket, runId, approvedPlanDigest } = approval;
  if (!SAFE_ID.test(ticket ?? '') || !SAFE_ID.test(runId ?? '') || !DIGEST.test(approvedPlanDigest ?? ''))
    fail('approval needs safe ticket, runId and approvedPlanDigest');
  const candidates = ['.specs', '.spec'].map(root => join(repoRoot, root, 'plans', ticket + '.md'));
  const planPath = candidates.find(p => existsSync(p));
  if (!planPath) fail('approved plan artifact not found for ticket ' + ticket);
  const text = readFileSync(planPath, 'utf8');
  const begin = text.lastIndexOf('<!-- RUN-STATE:BEGIN -->');
  const end = text.lastIndexOf('<!-- RUN-STATE:END -->');
  if (begin < 0 || end < begin) fail('plan artifact has no RUN-STATE block');
  const start = text.slice(begin, end).split(/\r?\n/).filter(l => l.trim().startsWith('{')).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).find(e => e?.event === 'START' && e.run_id === runId);
  if (!start) fail('no START event for run ' + runId + '; approval is not executable');
  if (start.approved_plan_digest !== approvedPlanDigest) fail('approved-plan digest mismatch');
  return { ticket, run_id: runId, approved_plan_digest: approvedPlanDigest };
}

/** Pure validation and argument construction. No process is started. */
export function prepareDispatch(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid dispatch config');
  if (!['BUILD', 'PROVE', 'SHIP'].includes(config.phase)) fail('PLAN and REVIEW cannot be dispatched through this adapter');
  if (!PROVIDERS.has(config.provider)) fail('unsupported provider');
  if (typeof config.nodeId !== 'string' || !SAFE_ID.test(config.nodeId)) fail('safe nodeId required');
  if (typeof config.workdir !== 'string' || !isAbsolute(config.workdir)) fail('absolute workdir required');
  const workdir = resolve(config.workdir);
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) fail('workdir does not exist');
  const repoRoot = config.repoRoot === undefined ? workdir : resolve(config.repoRoot);
  if (!isAbsolute(repoRoot)) fail('repoRoot must be absolute');
  if (!config.ownership || typeof config.ownership !== 'object') fail('explicit ownership required');
  const writes = repoRelative(config.ownership.writes, 'ownership.writes');
  if (!writes.length) fail('ownership.writes must name at least one path');
  const othersOwned = repoRelative(config.ownership.othersOwned ?? [], 'ownership.othersOwned');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 3600000)
    fail('timeoutMs must be 1000..3600000');
  const billing = config.billing ?? 'subscription';
  if (!['subscription', 'api'].includes(billing)) fail('billing must be subscription or api');
  if (billing === 'api' && config.allowApiBilling !== true) fail('api billing requires allowApiBilling: true');
  if (typeof config.promptFile !== 'string' || !isAbsolute(config.promptFile) || !existsSync(config.promptFile))
    fail('absolute promptFile required; prompts are sent on stdin, never argv');

  const tier = routeModel(config.phase, { risk: config.risk ?? [], complexity: config.complexity ?? 'medium', model: config.modelTier });
  const mapped = config.modelMap?.[tier];
  if (mapped !== undefined && (typeof mapped !== 'string' || !MODEL_ID.test(mapped))) fail('invalid model ID in modelMap');
  // Escalated tiers never fall back to a cheaper mapping: unmapped means provider default.
  const model = tier === 'inherit' ? null : mapped ?? null;

  let executable, args;
  if (config.provider === 'claude') {
    if (config.args !== undefined || config.executable !== undefined) fail('claude adapter builds its own verified arguments');
    const mode = config.permissionMode ?? 'acceptEdits';
    if (!CLAUDE_MODES.has(mode)) fail('unsupported claude permissionMode');
    executable = 'claude';
    args = ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-mode', mode,
      ...(model ? ['--model', model] : [])];
  } else if (config.provider === 'codex') {
    if (config.args !== undefined || config.executable !== undefined) fail('codex adapter builds its own verified arguments');
    const sandbox = config.sandbox ?? 'workspace-write';
    if (!CODEX_SANDBOXES.has(sandbox)) fail('unsupported codex sandbox');
    executable = 'codex';
    args = ['exec', '--json', '--ephemeral', '-s', sandbox, ...(model ? ['-m', model] : []), '-'];
  } else {
    // Unverified providers: trusted template only, never model injection.
    if (typeof config.executable !== 'string' || !/^[A-Za-z0-9_.\/:\\ -]{1,512}$/.test(config.executable))
      fail(config.provider + ' requires an explicit trusted executable');
    if (!Array.isArray(config.args) || !config.args.every(a => typeof a === 'string' && SAFE_ARG.test(a)))
      fail('args must be safe tokens; send prompts on stdin');
    executable = config.executable;
    args = config.args;
  }
  return {
    provider: config.provider, phase: config.phase, node_id: config.nodeId, executable, args, workdir, repoRoot,
    timeoutMs: config.timeoutMs, billing, model_tier: tier, model: model ?? 'provider-default',
    model_applied: VERIFIED.has(config.provider) ? model !== null : false, adapter: VERIFIED.has(config.provider) ? 'verified' : 'trusted-template',
    ownership: { writes, othersOwned }, promptFile: resolve(config.promptFile),
    resultFile: config.resultFile === undefined ? null : safeOutputPath(config.resultFile, workdir, 'resultFile'),
    usageLog: config.usageLog === undefined ? null : safeOutputPath(config.usageLog, workdir, 'usageLog'),
  };
}

/** Child environment: provider billing variables removed unless API billing is explicitly authorized. */
export function childEnv(provider, billing, base = process.env) {
  const env = { ...base };
  if (billing === 'subscription') for (const key of BILLING_ENV[provider]) delete env[key];
  return env;
}

/**
 * Ask the provider CLI, in the stripped environment, how it is authenticated.
 * Returns true (subscription proven), false (refuse) or 'unverified'
 * (no verified status interface for this provider).
 */
export function verifySubscription(provider, env, run = spawnSync) {
  const opts = { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] };
  const exec = (cmd, args) => { const s = spawnSpec(cmd, args, process.platform, env); return run(s.file, s.args, { ...opts, shell: s.shell }); };
  if (provider === 'claude') {
    const r = exec('claude', ['auth', 'status', '--json']);
    try {
      const s = JSON.parse(r.stdout ?? '');
      return s.loggedIn === true && s.authMethod === 'claude.ai' && (s.apiProvider ?? 'firstParty') === 'firstParty';
    } catch { return false; }
  }
  if (provider === 'codex') {
    const r = exec('codex', ['login', 'status']);
    return r.status === 0 && /Logged in using ChatGPT/.test(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  }
  return 'unverified';
}

/** Resolve a bare command on Windows through PATH x PATHEXT so .cmd shims can be detected. */
export function resolveWindowsCommand(command, env = process.env, exists = existsSync) {
  if (/[\\/]/.test(command)) return command;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.Path ?? env.PATH ?? '').split(';').filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const candidate = join(dir, command + ext);
      if (ext && exists(candidate)) return candidate;
    }
  }
  return command;
}

/** Spawn spec that works for real executables and Windows .cmd/.bat shims without unsafe shell interpolation. */
export function spawnSpec(executable, args, platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== 'win32') return { file: executable, args, shell: false };
  const resolved = resolveWindowsCommand(executable, env, exists);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    if (!args.every(a => SAFE_ARG.test(a))) fail('unsafe argument for a Windows batch shim');
    return { file: `"${resolved}"`, args, shell: true };
  }
  return { file: resolved, args, shell: false };
}

function killTree(child, platform = process.platform) {
  if (!child.pid || child.exitCode !== null) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, KILL_GRACE_MS);
  timer.unref();
}

function gitDirty(root) {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const map = new Map();
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const path = e.slice(3);
    if (e[0] === 'R' || e[0] === 'C') i++; // rename source follows
    let sig = 'deleted';
    try { const s = statSync(join(root, path)); sig = `${s.size}:${s.mtimeMs}`; } catch { /* deleted */ }
    map.set(path, sig);
  }
  return map;
}

const under = (path, roots) => roots.some(r => path === r || path.startsWith(r + '/'));

/** Paths changed during the run that neither this worker nor a declared concurrent worker owns. */
export function ownershipViolations(before, after, writes, othersOwned) {
  if (!before || !after) return null;
  return [...after].filter(([p, sig]) => before.get(p) !== sig && !under(p, writes) && !under(p, othersOwned))
    .map(([p]) => p).sort();
}

function finalMessage(provider, stdout) {
  if (provider === 'claude') {
    try { const r = JSON.parse(stdout); return { text: typeof r.result === 'string' ? r.result : null, is_error: r.is_error === true }; }
    catch { return { text: null, is_error: true }; }
  }
  if (provider === 'codex') {
    let text = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      try { const e = JSON.parse(line); if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text; } catch { /* skip */ }
    }
    return { text, is_error: text === null };
  }
  return { text: null, is_error: false };
}

/**
 * Run one approved writer node. Resolves with metadata only; raw output is
 * never returned. `deps` exists for tests and hosts that must inject seams.
 */
export async function dispatch(config, deps = {}) {
  const plan = prepareDispatch(config);
  const approval = (deps.verifyApproval ?? verifyApproval)(plan.repoRoot, config.approval);
  const env = childEnv(plan.provider, plan.billing, deps.env ?? process.env);
  const auth = plan.billing === 'subscription' ? (deps.verifySubscription ?? verifySubscription)(plan.provider, env) : 'api-authorized';
  if (auth === false) fail('subscription authentication not verified for ' + plan.provider + '; refusing to risk API billing');
  const before = gitDirty(plan.repoRoot);
  const spec = (deps.spawnSpec ?? spawnSpec)(plan.executable, plan.args, process.platform, env);
  const started = Date.now();
  const child = (deps.spawn ?? spawn)(spec.file, spec.args, {
    cwd: plan.workdir, env, shell: spec.shell, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stdoutBytes = 0, stderrBytes = 0, truncated = false, timedOut = false, cancelled = false;
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdout.length + chunk.length <= MAX_CAPTURE) stdout += chunk.toString('utf8');
    else truncated = true;
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.stdin.on('error', () => { /* child may exit before reading */ });
  child.stdin.end(readFileSync(plan.promptFile));

  const timer = setTimeout(() => { timedOut = true; killTree(child); }, plan.timeoutMs);
  const onCancel = () => { cancelled = true; killTree(child); };
  deps.signal?.addEventListener('abort', onCancel, { once: true });
  const signals = deps.handleSignals === false ? [] : ['SIGINT', 'SIGTERM'];
  for (const s of signals) process.on(s, onCancel);
  const [code, signal, spawnError] = await new Promise(done => {
    child.on('error', err => done([null, null, err]));
    child.on('close', (c, s) => done([c, s, null]));
  });
  clearTimeout(timer);
  for (const s of signals) process.off(s, onCancel);
  deps.signal?.removeEventListener('abort', onCancel);
  const ended = Date.now();

  const usage = truncated ? null : extractUsage(plan.provider, stdout);
  const message = finalMessage(plan.provider, truncated ? '' : stdout);
  let resultWritten = false;
  if (plan.resultFile && message.text !== null) {
    writeFileSync(plan.resultFile, JSON.stringify({ schema: 'ship-ticket-carrier-message-v1', provider: plan.provider,
      node_id: plan.node_id, final_message: message.text }) + '\n', { flag: 'wx', mode: 0o600 });
    resultWritten = true;
  }
  if (plan.usageLog) {
    appendFileSync(plan.usageLog, JSON.stringify({ provider: plan.provider, run_id: approval.run_id, node_id: plan.node_id,
      phase: plan.phase, model_tier: plan.model_tier, ...(usage ?? {}), timestamp: new Date(ended).toISOString() }) + '\n', { mode: 0o600 });
  }
  const violations = ownershipViolations(before, gitDirty(plan.repoRoot), plan.ownership.writes, plan.ownership.othersOwned);
  const succeeded = !spawnError && !timedOut && !cancelled && code === 0 && !message.is_error
    && (violations === null || violations.length === 0);
  return {
    schema: 'ship-ticket-harness-dispatch-v2', provider: plan.provider, phase: plan.phase, node_id: plan.node_id,
    adapter: plan.adapter, model_tier: plan.model_tier, model: plan.model, model_applied: plan.model_applied,
    billing: plan.billing, subscription_auth: auth, approval_verified: true, run_id: approval.run_id,
    started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString(), duration_ms: ended - started,
    exit_code: code, signal: signal ?? null, spawn_error: spawnError?.code ?? null, timed_out: timedOut, cancelled,
    succeeded, provider_reported_error: message.is_error,
    stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, output_truncated: truncated,
    usage, result_written: resultWritten,
    ownership_check: violations === null ? 'unavailable' : violations.length ? 'violated' : 'clean',
    writes_outside_ownership: violations ?? [],
    run_log_metrics: usage ? COUNTERS.filter(k => usage[k] !== null).map(k => `${k}=${usage[k]}`) : [],
  };
}

async function main(argv) {
  if (argv.length !== 2 || !['inspect', 'run'].includes(argv[0])) fail('Usage: carrier.mjs inspect|run <config.json>');
  const config = JSON.parse(readFileSync(argv[1], 'utf8'));
  if (argv[0] === 'inspect') {
    const plan = prepareDispatch(config);
    return { ...plan, approval: verifyApproval(plan.repoRoot, config.approval) };
  }
  return dispatch(config);
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.succeeded === false) process.exitCode = 2;
  }).catch(e => { process.stderr.write('carrier: ' + e.message + '\n'); process.exitCode = 1; });
}
