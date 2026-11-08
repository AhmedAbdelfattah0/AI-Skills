/**
 * Provider child environment and spawn specs for carrier.mjs and the run engine: the billing
 * variables stripped under subscription billing, the subscription login probe, and Windows
 * .cmd/.bat shim resolution. Moved out of carrier.mjs unchanged (re-exported there). Node built-ins only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ARG = /^[A-Za-z0-9_.,:=@%+\/\[\]-]{1,256}$/;
function fail(message) { throw new Error(message); }

/** Environment variables that route a provider CLI to metered API billing. */
export const BILLING_ENV = Object.freeze({
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
});

/** Child environment: provider billing variables removed (case-insensitively) unless API billing is authorized. */
export function childEnv(provider, billing, base = process.env) {
  const env = { ...base };
  if (billing !== 'subscription') return env;
  const deny = new Set(BILLING_ENV[provider].map(k => k.toUpperCase()));
  for (const key of Object.keys(env)) if (deny.has(key.toUpperCase())) delete env[key];
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
      return s.loggedIn === true && s.authMethod === 'claude.ai' && s.apiProvider === 'firstParty';
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
  const get = (name) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];
  const exts = (get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (get('PATH') ?? '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (exists(candidate)) return candidate;
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
