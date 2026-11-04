#!/usr/bin/env node
/**
 * Provider-neutral, opt-in carrier launcher for BUILD/PROVE/SHIP only.
 * Explicit executable and argument arrays supplied by trusted orchestrator;
 * never auto-authenticates or infers a subscription billing route.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { routeModel, PHASES } from './harness.mjs';
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const EXECUTABLES = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
const TIERS = new Set(['economy', 'balanced', 'strong', 'inherit']);
export function prepareDispatch(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid dispatch config');
  if (!['BUILD', 'PROVE', 'SHIP'].includes(config.phase)) throw new Error('PLAN and REVIEW cannot be dispatched through this adapter');
  if (!PROVIDERS.has(config.provider)) throw new Error('unsupported provider');
  if (!config.approved || !config.approvedPlanId || typeof config.approvedPlanId !== 'string')
    throw new Error('approved plan ID required');
  if (typeof config.workdir !== 'string' || !config.workdir.startsWith('/')) throw new Error('absolute workdir required');
  if (!config.ownership || !Array.isArray(config.ownership.writes)) throw new Error('explicit ownership required');
  if (!Array.isArray(config.args) || !config.args.every(x => typeof x === 'string' && !x.includes('\0')))
    throw new Error('args must be an array of strings');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 3600000)
    throw new Error('timeoutMs must be 1000..3600000');
  const tier = routeModel(config.phase, { risk: config.risk ?? [], complexity: config.complexity ?? 'medium', model: config.modelTier });
  if (!TIERS.has(tier)) throw new Error('invalid model tier');
  // Antigravity has no universal executable interface; require an explicit
  // trusted carrier executable, never invent one.
  const executable = EXECUTABLES[config.provider] ?? config.executable;
  if (typeof executable !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(executable)) throw new Error('invalid carrier executable');
  const mapped = config.modelMap?.[config.provider]?.[tier];
  // No invented CLI flags: the trusted orchestrator supplies carrier-version-
  // specific args and is responsible for mapping model tiers to actual IDs.
  return { provider: config.provider, phase: config.phase, executable,
    args: config.args, workdir: resolve(config.workdir), timeoutMs: config.timeoutMs,
    modelTier: tier, mappedModel: typeof mapped === 'string' ? mapped : null,
    advisory: true };
}
export function dispatch(config, spawn = spawnSync) {
  const plan = prepareDispatch(config);
  const env = { ...process.env };
  // Prevent accidental Claude API-key billing when subscription is intended.
  if (plan.provider === 'claude' && config.subscriptionOnly === true) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  const result = spawn(plan.executable, plan.args, {
    cwd: plan.workdir, env, encoding: 'utf8', timeout: plan.timeoutMs,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Do not expose raw output, which can contain secrets.
  return { schema: 'ship-ticket-harness-dispatch-v1', provider: plan.provider,
    model_tier: plan.modelTier, exit_code: result.status, timed_out: result.error?.code === 'ETIMEDOUT',
    succeeded: !result.error && result.status === 0, stdout_bytes: Buffer.byteLength(result.stdout ?? ''),
    stderr_bytes: Buffer.byteLength(result.stderr ?? '') };
}
function main(argv) {
  if (argv.length !== 2 || !['inspect', 'run'].includes(argv[0])) throw new Error('Usage: carrier.mjs inspect|run <config.json>');
  const config = JSON.parse(readFileSync(argv[1], 'utf8'));
  return argv[0] === 'inspect' ? prepareDispatch(config) : dispatch(config);
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (e) { process.stderr.write('carrier: ' + e.message + '\n'); process.exitCode = 1; }
}
