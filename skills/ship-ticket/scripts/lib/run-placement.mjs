/**
 * Where one ticket's engine files live (S1, P1 durable substrate). The ONE placement resolver: run-engine.mjs and every
 * reader of engine state (carrier.mjs, the PR scope check, engine-accepted.mjs, eval.mjs, wave.mjs) go through it.
 * Node built-ins only, no local imports.
 *
 * Two placements:
 * - `legacy` (every run before S1, and every run whose DAG does not set config.durableRun): `git rev-parse --git-path
 *   ai-skills/ship-ticket/<ticket>.{state.json,engine.jsonl,usage.jsonl,attempts,lock}`. In a linked worktree that is the
 *   worktree's private gitdir, which `git worktree remove` deletes (RC9). Unchanged, byte for byte.
 * - `durable` (a run whose DAG sets config.durableRun { version: 1 }, chosen at init): one run directory in the git COMMON
 *   dir, `<git-common-dir>/ai-skills/ship-ticket/runs/<ticket>/{state.json,engine.jsonl,usage.jsonl,attempts/,lock}`,
 *   shared by every worktree of the repository, so removing a worktree loses no engine state.
 *
 * Placement cannot be read from the state (the lock is taken first), so it is read from the filesystem: the state file
 * that exists decides. Both existing for one ticket is refused (`state_placement_ambiguous`, fail closed); neither means no
 * run yet, and only `init` (which knows the DAG) chooses. In the main checkout both live under `.git`, at different names.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The durable-run subdirectory of `<git-common-dir>/ai-skills/ship-ticket`. */
export const RUNS_SUBDIR = 'runs';

function rev(repoRoot, args) {
  const r = spawnSync('git', ['rev-parse', ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw coded('not_a_repo', `${repoRoot} is not a git work tree`);
  const out = r.stdout.trim();
  return isAbsolute(out) ? out : resolve(repoRoot, out);
}

/** The legacy (per-worktree, `--git-path`) files of `ticket`. */
export function legacyPaths(repoRoot, ticket) {
  const dir = rev(repoRoot, ['--git-path', 'ai-skills/ship-ticket']);
  const base = join(dir, ticket);
  return { placement: 'legacy', dir, state: base + '.state.json', log: base + '.engine.jsonl', usage: base + '.usage.jsonl',
    attempts: base + '.attempts', lock: base + '.lock' };
}

/** The durable (common-dir run directory) files of `ticket`. */
export function durablePaths(repoRoot, ticket) {
  const dir = join(rev(repoRoot, ['--git-common-dir']), 'ai-skills', 'ship-ticket', RUNS_SUBDIR, ticket);
  return { placement: 'durable', dir, state: join(dir, 'state.json'), log: join(dir, 'engine.jsonl'), usage: join(dir, 'usage.jsonl'),
    attempts: join(dir, 'attempts'), lock: join(dir, 'lock') };
}

/**
 * The placement of `ticket`'s existing run: its paths, or `null` when no state exists in either placement. `prefer`
 * ('legacy' | 'durable') is what init chose and is returned when no state exists yet. Throws `state_placement_ambiguous`
 * when both state files exist, `bad_context` for an unsafe ticket id.
 */
export function enginePaths(repoRoot, ticket, { prefer = null } = {}) {
  if (!SAFE_ID.test(ticket ?? '')) throw coded('bad_context', 'a safe ticket id is required');
  const L = legacyPaths(repoRoot, ticket), D = durablePaths(repoRoot, ticket);
  const l = existsSync(L.state), d = existsSync(D.state);
  if (l && d) throw coded('state_placement_ambiguous', `engine state of ${ticket} exists both at ${L.state} and at ${D.state}; archive one of them by hand`);
  if (l) return L;
  if (d) return D;
  return prefer === 'durable' ? D : prefer === 'legacy' ? L : null;
}
