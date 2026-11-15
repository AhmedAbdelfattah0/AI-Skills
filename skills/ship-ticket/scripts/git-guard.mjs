#!/usr/bin/env node
/**
 * Opt-in, per-repository pre-push guard for ship-ticket (P0 slice E1). Node built-ins only.
 *
 * `install --repo <dir> [--pattern <regex>]` writes a pre-push hook into THAT repository's hooks
 * directory (`git rev-parse --git-path hooks`: .git/hooks, or the repository's own core.hooksPath).
 * It never touches global or system configuration and refuses a core.hooksPath that comes from
 * outside the repository's local config (a shared hooks directory). An existing pre-push hook is
 * moved to `pre-push.ship-ticket-backup`, still runs first on every push, and is restored by
 * `uninstall`. In a linked worktree the hooks directory is the repository's common one, so the guard
 * covers every work tree of the repository; each push is judged against its own work tree's engine state. The pattern (default TICKET_PATTERN) is stored in the repository's LOCAL config key
 * `shipTicket.guardPattern`; the ticket key is its first capture group, else the whole match.
 *
 * On push, for every ref whose remote or local branch matches the pattern, the hook runs
 * `authorize publish` for that ticket's engine run in this work tree (engine-enroll.mjs) and requires the
 * pushed sha to be the authorized HEAD. No engine state, an unreadable one, a deny, or any
 * error blocks the push (fail closed). Other branches, tags and branch deletions pass untouched.
 *
 * This is a GUARDRAIL, not a boundary. Bypasses, recorded as expected by git-guard.test.mjs:
 * `git push --no-verify`, `git -c core.hooksPath=/dev/null push`, the GIT_CONFIG_COUNT/KEY/VALUE
 * environment override of core.hooksPath, unsetting a repository core.hooksPath the hook was
 * installed into, editing or deleting the hook, and pushing with any tool that is not git (gh api,
 * a second clone). A push wrapped in a script, `sh -c`/`bash -c` or node execSync still runs the
 * hook and is blocked.
 *
 * CLI: git-guard.mjs install|uninstall|status --repo <dir> [--pattern <regex>]
 *      git-guard.mjs check --repo <dir> [--remote <name>]   (the hook; reads git's pre-push stdin)
 * Exit: 0 ok/allowed, 1 blocked or refused, 2 usage error.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './harness.mjs';

export const TICKET_PATTERN = '^[A-Za-z][A-Za-z0-9]*-[0-9]+';
export const MARKER = '# ship-ticket git-guard v1 (managed by git-guard.mjs; remove with git-guard.mjs uninstall)';
export const BACKUP = 'pre-push.ship-ticket-backup';
const CONFIG_KEY = 'shipTicket.guardPattern';
const SELF = fileURLToPath(import.meta.url);
const ZERO = /^0+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const git = (repo, args, env = process.env) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env, timeout: 30000 });
const out = (r) => (r.status === 0 ? r.stdout.trim() : null);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const inside = (p, root) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** The repository's hooks directory, refusing a core.hooksPath from a non-local config (shared). */
export function hooksDir(repo, env = process.env) {
  const top = out(git(repo, ['rev-parse', '--show-toplevel'], env));
  if (!top) throw Object.assign(new Error(`${repo} is not a git work tree`), { code: 'not_a_repo' });
  const origin = out(git(repo, ['config', '--show-origin', '--show-scope', '--get', 'core.hooksPath'], env));
  if (origin && !origin.startsWith('local\t') && !origin.startsWith('worktree\t'))
    throw Object.assign(new Error(`core.hooksPath comes from ${origin.split('\t').slice(0, 2).join(' ')}: a shared hooks directory; git-guard installs per repository only`), { code: 'hooks_path_shared' });
  const dir = resolve(top, out(git(repo, ['rev-parse', '--git-path', 'hooks'], env)) ?? '.git/hooks');
  const common = resolve(top, out(git(repo, ['rev-parse', '--git-common-dir'], env)) ?? '.git');
  if (!inside(dir, top) && !inside(dir, common)) throw Object.assign(new Error(`hooks directory ${dir} is outside the repository`), { code: 'hooks_path_shared' });
  return { top, dir, hook: join(dir, 'pre-push'), backup: join(dir, BACKUP) };
}

const ours = (file) => existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);

/** The hook script: run a backed-up hook first with the same stdin, then the guard check. */
export function hookScript(nodePath = process.execPath, guard = SELF) {
  return `#!/bin/sh
${MARKER}
input=$(cat)
dir=$(dirname "$0")
if [ -x "$dir/${BACKUP}" ]; then
  printf '%s\\n' "$input" | "$dir/${BACKUP}" "$@" || exit $?
fi
printf '%s\\n' "$input" | ${shq(nodePath)} ${shq(guard)} check --repo "$(pwd)" --remote "$1"
`;
}

export function install(repo, { pattern, env } = {}) {
  if (pattern !== undefined) { try { new RegExp(pattern); } catch { throw Object.assign(new Error(`--pattern is not a valid regex: ${pattern}`), { code: 'bad_pattern' }); } }
  const h = hooksDir(repo, env);
  mkdirSync(h.dir, { recursive: true });
  let backedUp = false;
  if (existsSync(h.hook) && !ours(h.hook)) {
    if (existsSync(h.backup)) throw Object.assign(new Error(`${h.backup} already exists; resolve it by hand`), { code: 'backup_exists' });
    renameSync(h.hook, h.backup);
    backedUp = true;
  }
  writeFileSync(h.hook, hookScript());
  chmodSync(h.hook, 0o755);
  if (pattern !== undefined && git(repo, ['config', '--local', CONFIG_KEY, pattern], env).status !== 0)
    throw Object.assign(new Error(`could not set ${CONFIG_KEY}`), { code: 'config_failed' });
  return { installed: true, hook: h.hook, backed_up: backedUp, pattern: pattern ?? guardPattern(repo, env) };
}

export function uninstall(repo, { env } = {}) {
  const h = hooksDir(repo, env);
  if (existsSync(h.hook) && !ours(h.hook)) throw Object.assign(new Error(`${h.hook} is not a git-guard hook; left untouched`), { code: 'not_ours' });
  const removed = existsSync(h.hook);
  if (removed) unlinkSync(h.hook);
  const restored = existsSync(h.backup);
  if (restored) renameSync(h.backup, h.hook);
  git(repo, ['config', '--local', '--unset', CONFIG_KEY], env);
  return { installed: false, removed, restored };
}

export const guardPattern = (repo, env) => out(git(repo, ['config', '--local', '--get', CONFIG_KEY], env)) || TICKET_PATTERN;

export function status(repo, { env } = {}) {
  const h = hooksDir(repo, env);
  return { installed: ours(h.hook), foreign_hook: existsSync(h.hook) && !ours(h.hook), backup: existsSync(h.backup), hooks_dir: h.dir, pattern: guardPattern(repo, env) };
}

/** Ticket key a branch name guards (first capture group, else the whole match), or null. */
export function ticketOf(branch, pattern) {
  const m = new RegExp(pattern).exec(branch ?? '');
  const key = m ? (m[1] ?? m[0]) : null;
  return key && SAFE_ID.test(key) ? key : null;
}

/** The run id of `ticket`'s engine state in this work tree (null when none or unreadable): authorize then judges it. */
function latestRun(repo, ticket) {
  const file = resolve(repo, out(git(repo, ['rev-parse', '--git-path', `ai-skills/ship-ticket/${ticket}.state.json`])) ?? '');
  try { const id = JSON.parse(readFileSync(file, 'utf8')).run_id; return typeof id === 'string' && SAFE_ID.test(id) ? id : null; } catch { return null; }
}

/**
 * The hook: decide every pushed ref from git's stdin lines `<local ref> <local sha> <remote ref> <remote sha>`.
 * -> { ok, decisions: [{ ref, guarded, ticket?, allow, code, reason }] }
 */
export async function check(repo, stdin, { authorizeFn } = {}) {
  const authorize = authorizeFn ?? (async (ctx) => {
    const [{ authorize: a }, { readEngine }] = await Promise.all([import('./engine-enroll.mjs'), import('./run-engine.mjs')]);
    return a(ctx, readEngine);
  });
  const pattern = guardPattern(repo);
  const decisions = [];
  for (const line of stdin.split('\n').map(l => l.trim()).filter(Boolean)) {
    const [localRef, localSha, remoteRef] = line.split(/\s+/);
    const branchOf = (r) => (r?.startsWith('refs/heads/') ? r.slice('refs/heads/'.length) : null);
    const ticket = ticketOf(branchOf(remoteRef), pattern) ?? ticketOf(branchOf(localRef), pattern);
    if (!ticket) { decisions.push({ ref: remoteRef, guarded: false, allow: true, code: 'not_a_ticket_branch' }); continue; }
    if (ZERO.test(localSha ?? '')) { decisions.push({ ref: remoteRef, guarded: true, ticket, allow: true, code: 'branch_delete' }); continue; }
    const deny = (code, reason) => decisions.push({ ref: remoteRef, guarded: true, ticket, allow: false, code, reason });
    const runId = latestRun(repo, ticket);
    if (!runId) { deny('not_enrolled', `no readable engine run for ${ticket} in this work tree; ship through run-engine.mjs publish`); continue; }
    let a;
    try { a = await authorize({ repoRoot: repo, ticket, runId, stage: 'publish' }); } catch (e) { deny('authorize_error', e.message); continue; }
    if (!a.allow) { deny(a.code, a.reasons?.[0] ?? ''); continue; }
    if (a.binding?.head !== localSha) { deny('push_not_head', `pushing ${localSha}, but ${a.binding?.head} (HEAD) is what was authorized`); continue; }
    decisions.push({ ref: remoteRef, guarded: true, ticket, allow: true, code: a.code });
  }
  return { ok: decisions.every(d => d.allow), decisions };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) return usage();
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  const allowed = { install: ['repo', 'pattern'], uninstall: ['repo'], status: ['repo'], check: ['repo', 'remote'] }[cmd];
  if (!allowed || !flags.repo || Object.keys(flags).some(k => !allowed.includes(k))) return usage();
  const repo = resolve(flags.repo);
  try {
    if (cmd === 'check') {
      const r = await check(repo, readFileSync(0, 'utf8'));
      for (const d of r.decisions.filter(x => !x.allow)) process.stderr.write(`git-guard: push of ${d.ref} blocked (${d.ticket}): ${d.code}: ${d.reason}\n`);
      return r.ok ? 0 : 1;
    }
    const r = cmd === 'install' ? install(repo, { pattern: flags.pattern }) : cmd === 'uninstall' ? uninstall(repo) : status(repo);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`git-guard: ${e.code ? e.code + ': ' : ''}${e.message}\n`);
    return 1;
  }
}

function usage() {
  process.stderr.write('Usage: git-guard.mjs install|uninstall|status --repo <dir> [--pattern <regex>]\n       git-guard.mjs check --repo <dir> [--remote <name>]\n');
  return 2;
}

if (isEntrypoint(import.meta.url)) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`git-guard: ${e.message}\n`); process.exitCode = 1; });
