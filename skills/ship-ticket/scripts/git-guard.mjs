#!/usr/bin/env node
/**
 * Opt-in, per-repository pre-push guard for ship-ticket (P0 slice E1). Node built-ins only.
 *
 * `install --repo <dir> [--pattern <regex>]` writes a pre-push hook into THAT repository's hooks
 * directory (`git rev-parse --git-path hooks`: .git/hooks, or the repository's own core.hooksPath).
 * It never touches global or system configuration and refuses a core.hooksPath that comes from
 * outside the repository's local config (a shared hooks directory), and a hooks directory inside the
 * work tree unless git ignores it (a tracked hook would dirty the reviewed candidate: `.githooks`,
 * `.husky`; husky's own `.husky/_` is ignored). An existing pre-push hook is moved to
 * `pre-push.ship-ticket-backup`, still runs first on every push (a sh/bash hook is sourced with $0 =
 * the hooks/pre-push path, so hooks that derive paths from $0, like husky's, behave as before), and is
 * restored by `uninstall`. In a linked worktree the hooks directory is the repository's common one,
 * so the guard covers every work tree; each push is judged by its own work tree's engine state.
 *
 * A pushed branch is guarded when it names, as a whole token, a ticket that has engine state in this
 * work tree, or when it matches the pattern (default TICKET_PATTERN, unanchored: `T-1-x`,
 * `feat/SCRUM-140-x`, `feature/AB-1`, `AIS-BENCH-1-x`; LOCAL config key `shipTicket.guardPattern`;
 * the ticket is its first capture group, else the whole match). For a guarded branch the hook runs
 * `authorize publish` for that ticket's run (engine-enroll.mjs) and requires the pushed sha to be the
 * authorized HEAD and the DESTINATION ref to be exactly `refs/heads/<the authorized branch>`. The ticket
 * is taken from the destination first, then from the source: the local branch, or, for `HEAD` or a sha,
 * the checked-out branch when its commit is the one pushed (any source, a copy branch too, whose commit is the checked-out
 * HEAD of a ticket branch with engine state here). So `T-1-work:refs/heads/T-2-work` is
 * `cross_ticket_push` (or T-2's own refusal), and T-1's commit to the default branch or to a name with
 * no ticket (`HEAD:refs/heads/x`) is `push_to_default_branch` / `push_destination_mismatch`. No engine
 * state, an unreadable one, a deny, or any error blocks the push (fail closed). Other branches, tags and
 * branch deletions pass. If node or this script has moved, the hook blocks only branches matching the
 * default pattern and says how to reinstall.
 *
 * The PR base the hook's authorize judges is the bound one (config.base, else the remote default branch:
 * engine-enroll.mjs authorize, R0-S batch 2), the same one `publish` used; a stacked PR binds its parent as
 * config.base. A push to a URL (`git push <url>`, where git passes the URL as $1) is judged as the configured
 * remote with that url or pushurl; a URL no remote has is `remote_unconfigured` unless config.base binds the base.
 *
 * Pattern limits, pinned by git-guard.test.mjs. False positives (fail closed, never a bypass): the
 * default pattern also reads `fix/issue-42` as ticket `issue-42` and `release-2026-11` as
 * `release-2026`, so pushing those branches is refused (`not_enrolled`) until the repository narrows
 * the pattern (`install --pattern '^(?:feat|fix)/([A-Z][A-Z0-9]*-[0-9]+)'`). One ticket per branch: a
 * branch naming two tickets (`feat/T-1-T-2`) is judged only by the first ticket that has engine state
 * here, else the first the pattern finds; the other ticket's run is never consulted.
 *
 * This is a GUARDRAIL, not a boundary. Bypasses, recorded as expected by git-guard.test.mjs:
 * `git push --no-verify`, `git -c core.hooksPath=/dev/null push`, the GIT_CONFIG_COUNT/KEY/VALUE
 * environment override of core.hooksPath, unsetting a repository core.hooksPath the hook was
 * installed into, editing or deleting the hook, a source the guard cannot tie to a ticket pushed to a
 * branch that names none (a commit that is not the checked-out HEAD of a ticket branch with engine state:
 * an older commit, another work tree's, a detached HEAD, any commit before `init`), and pushing with any
 * tool that is not git (gh api, a second clone). A push wrapped in a script, `sh -c`/`bash -c` or node execSync still runs the
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
import { readdirSync } from 'node:fs';
import { isEntrypoint } from './harness.mjs';
import { branchNames } from './engine-enroll.mjs';

export const TICKET_PATTERN = '(?:^|/)([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*?-[0-9]+)';
/** The POSIX ERE the hook falls back to when node or this script is missing (same shape, presence only). */
const FALLBACK_ERE = '(^|/)[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*-[0-9]+';
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
  if (inside(dir, top) && !inside(dir, common) && git(repo, ['check-ignore', '-q', relative(top, join(dir, 'pre-push'))], env).status !== 0)
    throw Object.assign(new Error(`hooks directory ${relative(top, dir)} is inside the work tree and not ignored: the hook would dirty the reviewed candidate; ignore it or use .git/hooks`), { code: 'hooks_dir_in_worktree' });
  return { top, dir, hook: join(dir, 'pre-push'), backup: join(dir, BACKUP) };
}

const ours = (file) => existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);

/** The hook script: run a backed-up hook first with the same stdin, then the guard check. */
export function hookScript(nodePath = process.execPath, guard = SELF) {
  return `#!/bin/sh
${MARKER}
input=$(cat)
dir=$(dirname "$0")
backup="$dir/${BACKUP}"
if [ -x "$backup" ]; then
  case "$(head -n 1 "$backup")" in
    '#!/bin/sh'*|'#!/usr/bin/env sh'*) printf '%s\\n' "$input" | sh -c 'b=$1; shift; . "$b"' "$0" "$backup" "$@" || exit $? ;;
    '#!/bin/bash'*|'#!/usr/bin/env bash'*) printf '%s\\n' "$input" | bash -c 'b=$1; shift; . "$b"' "$0" "$backup" "$@" || exit $? ;;
    *) printf '%s\\n' "$input" | "$backup" "$@" || exit $? ;;
  esac
fi
node=${shq(nodePath)}
guard=${shq(guard)}
if [ ! -x "$node" ] || [ ! -f "$guard" ]; then
  echo "git-guard: $guard or $node is missing; run git-guard.mjs install again (or uninstall). Ticket-like branches are blocked meanwhile." >&2
  printf '%s\\n' "$input" | while read -r lref lsha rref rsha; do
    for r in "$lref" "$rref"; do
      case "$r" in refs/heads/*) if printf '%s\\n' "\${r#refs/heads/}" | grep -Eq '${FALLBACK_ERE}'; then echo "git-guard: push of $rref blocked (fail closed)" >&2; exit 1; fi ;; esac
    done
  done || exit 1
  exit 0
fi
printf '%s\\n' "$input" | "$node" "$guard" check --repo "$(pwd)" --remote "$1"
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
 * The configured remote a pre-push `$1` names: a remote name as is, a URL (`git push <url>`) mapped to the
 * remote whose url or pushurl it is, else the URL itself (authorize then refuses `remote_unconfigured`
 * when it would need that remote's HEAD as the PR base, instead of reading refs/remotes/<url>/HEAD).
 */
export function remoteName(repo, given) {
  if (!given) return given;
  const list = out(git(repo, ['config', '--local', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'])) ?? '';
  const names = new Map();
  for (const line of list.split('\n').filter(Boolean)) {
    const sp = line.indexOf(' '), key = line.slice(0, sp), value = line.slice(sp + 1);
    const name = key.replace(/^remote\./, '').replace(/\.(url|pushurl)$/, '');
    if (!names.has(value)) names.set(value, name);
    if (name === given) return given;
    // The URL git pushes to after url.<base>.insteadOf / pushInsteadOf rewriting (what git passes the hook as $1 for a URL push).
    for (const args of [['remote', 'get-url', '--all', name], ['remote', 'get-url', '--push', '--all', name]])
      for (const u of (out(git(repo, args)) ?? '').split('\n').filter(Boolean)) if (!names.has(u)) names.set(u, name);
  }
  return names.get(given) ?? given;
}

/** Tickets with engine state in this work tree. */
function stateTickets(repo) {
  const dir = resolve(repo, out(git(repo, ['rev-parse', '--git-path', 'ai-skills/ship-ticket'])) ?? '');
  try { return readdirSync(dir).filter(f => f.endsWith('.state.json')).map(f => f.slice(0, -'.state.json'.length)).filter(t => SAFE_ID.test(t)); } catch { return []; }
}

/**
 * The hook: decide every pushed ref from git's stdin lines `<local ref> <local sha> <remote ref> <remote sha>`.
 * -> { ok, decisions: [{ ref, guarded, ticket?, allow, code, reason }] }
 */
export async function check(repo, stdin, { authorizeFn, remote } = {}) {
  const authorize = authorizeFn ?? (async (ctx) => {
    const [{ authorize: a }, { readEngine }] = await Promise.all([import('./engine-enroll.mjs'), import('./run-engine.mjs')]);
    return a(ctx, readEngine);
  });
  const pattern = guardPattern(repo), withState = stateTickets(repo);
  remote = remoteName(repo, remote);
  const decisions = [];
  const ticketIn = (b) => (b ? withState.find(t => branchNames(b, t)) ?? ticketOf(b, pattern) : null);
  const head = out(git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  const current = out(git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']));
  const defaultRef = remote ? out(git(repo, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])) : null;
  const defaultBranch = defaultRef?.startsWith(`refs/remotes/${remote}/`) ? defaultRef.slice(`refs/remotes/${remote}/`.length) : null;
  for (const line of stdin.split('\n').map(l => l.trim()).filter(Boolean)) {
    const [localRef, localSha, remoteRef] = line.split(/\s+/);
    const branchOf = (r) => (r?.startsWith('refs/heads/') ? r.slice('refs/heads/'.length) : null);
    // The destination decides first; the source is the local branch, or (HEAD, a sha) the checked-out branch whose commit is pushed.
    const destTicket = ticketIn(branchOf(remoteRef));
    const srcBranch = branchOf(localRef) ?? (!localRef?.startsWith('refs/') && current && localSha === head ? current : null);
    // Any source (a copy branch too) whose commit is the checked-out HEAD of a ticket branch with engine state is that ticket's.
    const atHead = current && localSha === head ? withState.find(t => branchNames(current, t)) ?? null : null;
    const srcTicket = ticketIn(srcBranch) ?? atHead;
    const ticket = destTicket ?? srcTicket;
    if (!ticket) { decisions.push({ ref: remoteRef, guarded: false, allow: true, code: 'not_a_ticket_branch' }); continue; }
    if (ZERO.test(localSha ?? '')) { decisions.push({ ref: remoteRef, guarded: true, ticket, allow: true, code: 'branch_delete' }); continue; }
    const deny = (code, reason) => decisions.push({ ref: remoteRef, guarded: true, ticket, allow: false, code, reason });
    if (destTicket && srcTicket && destTicket.toUpperCase() !== srcTicket.toUpperCase()) { deny('cross_ticket_push', `pushing ${srcBranch} (${srcTicket}) to ${remoteRef} (${destTicket}): one ticket's authorization never covers another's branch`); continue; }
    const runId = latestRun(repo, ticket);
    if (!runId) { deny('not_enrolled', `no readable engine run for ${ticket} in this work tree; ship through run-engine.mjs publish`); continue; }
    let a;
    try { a = await authorize({ repoRoot: repo, ticket, runId, stage: 'publish', ...(remote ? { remote } : {}) }); } catch (e) { deny('authorize_error', e.message); continue; }
    if (!a.allow) { deny(a.code, a.reasons?.[0] ?? ''); continue; }
    if (a.binding?.head !== localSha) { deny('push_not_head', `pushing ${localSha}, but ${a.binding?.head} (HEAD) is what was authorized`); continue; }
    // The authorization names one branch: the destination must be exactly it (never the default branch, never another name).
    const want = `refs/heads/${a.binding?.branch}`;
    if (remoteRef !== want) {
      const toDefault = branchOf(remoteRef) && (branchOf(remoteRef) === defaultBranch || branchOf(remoteRef) === a.binding?.base);
      deny(toDefault ? 'push_to_default_branch' : 'push_destination_mismatch', `${ticket} is authorized to push ${want} only, not ${remoteRef}`);
      continue;
    }
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
      const r = await check(repo, readFileSync(0, 'utf8'), { remote: flags.remote });
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
