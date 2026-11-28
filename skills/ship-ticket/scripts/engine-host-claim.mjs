/**
 * PR-2 (S2-min host admission, COMPLETION-PLAN-2026-11-28 row 4): host claims at the ENGINE-COMMAND process boundary.
 * The one place that knows both an engine command and the host claim store (host-claims.mjs). Two users, both at a CLI edge:
 *   - host-admit.mjs `run -- <engine command>` sizes and binds the claim (engineClaimSpec): class, weight and run binding
 *     are DERIVED from the command and the run's state, never supplied by the caller (the frozen `--running N` failure);
 *   - run-engine.mjs main() checks it (checkHostClaim) before a heavy command of a run whose policy requires a claim
 *     (config.hostClaimRequired, policy twin engine-policy.mjs HOST_CLAIM_OFFSET): a CHECK, never an await or a hold, so
 *     nothing of the failed in-engine design (RCA-S2-ROUND2/3: hold vs budget, barrier and judgment ordering) returns.
 * The engine library (drive(), gate(), dispatch, units, gates) never imports this module.
 *
 * Weights: drive = min(config.width, DAG nodes) (every node counts as heavy: main has no per-node class); gate red, gate
 * prove and gate ship-ready = 1 (one runner at a time); every other engine command is light (0): status, resume, review
 * gates, mark, archive, ... Reviews and other LLM-only operations are light.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { enginePaths } from './lib/run-placement.mjs';
import { driveWeight } from './engine-dag.mjs';
import { listClaims, storeDir, groupAlive, boundedOpId } from './host-claims.mjs';
import { groupIdentity, processInfo } from './engine-quiesce.mjs';

/** The environment variable through which `host-admit run` names its claim to the command it launches. */
export const CLAIM_OP_ENV = 'AI_SKILLS_HOST_CLAIM_OP';
const HEAVY_GATES = new Set(['red', 'prove', 'ship-ready']);
/** Whether engine command `cmd` (with `gateKind` for `gate`) launches heavy work: drive, gate red|prove|ship-ready. */
export const heavyCommand = (cmd, gateKind) => cmd === 'drive' || (cmd === 'gate' && HEAVY_GATES.has(gateKind));

/** The claim weight engine command `cmd` of run state `S` needs (0 = light). Width without config.width is the runtime default. */
export function requiredWeight(S, cmd, gateKind) {
  if (!heavyCommand(cmd, gateKind)) return 0;
  if (cmd !== 'drive') return 1;
  const width = Number.isInteger(S?.config?.width) ? S.config.width : Math.max(1, Math.min(3, cpus().length)); // harness.mjs schedule default
  return driveWeight({ width }, Object.keys(S?.nodes ?? {}).length || 1);
}

/**
 * The engine command in a command vector (`node .../run-engine.mjs <cmd> [gate kind] --flag value ...`), or null when it
 * is not one: { cmd, gateKind, repo, ticket, runId }.
 */
export function engineCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 3) return null;
  const nodeLike = argv[0] === process.execPath || /^node(\.exe)?$/i.test(basename(String(argv[0])));
  if (!nodeLike || basename(String(argv[1])) !== 'run-engine.mjs') return null;
  const cmd = argv[2], rest = argv.slice(cmd === 'gate' ? 4 : 3);
  const flags = {};
  for (let i = 0; i + 1 < rest.length; i += 2) if (String(rest[i]).startsWith('--')) flags[rest[i].slice(2)] ??= rest[i + 1];
  return { cmd, gateKind: cmd === 'gate' ? argv[3] : undefined, repo: flags.repo, ticket: flags.ticket, runId: flags['run-id'] };
}

/**
 * The claim an engine command needs, derived from the command and the run's existing state (read-only): { cls, weight,
 * runState, opId } or null when `argv` is not an engine command. runState is the realpath of the run's state file (null
 * before init); the op id is bounded (host-claims.mjs boundedOpId).
 */
export function engineClaimSpec(argv) {
  const e = engineCommand(argv);
  if (!e) return null;
  if (typeof e.repo !== 'string' || typeof e.ticket !== 'string') return { error: 'an engine command needs --repo and --ticket' };
  let P = null, S = null;
  try { P = enginePaths(resolve(e.repo), e.ticket); } catch (err) { return { error: err.message }; }
  if (P && existsSync(P.state)) { try { S = JSON.parse(readFileSync(P.state, 'utf8')); } catch { S = null; } }
  const weight = S ? requiredWeight(S, e.cmd, e.gateKind) : heavyCommand(e.cmd, e.gateKind) ? 1 : 0;
  return { cls: weight > 0 ? 'heavy' : 'light', weight, runState: P && existsSync(P.state) ? realpathSync(P.state) : null,
    opId: boundedOpId([e.ticket, e.runId ?? 'run', e.cmd, ...(e.gateKind ? [e.gateKind] : []), randomUUID().slice(0, 8)]) };
}

/** The process group of `pid` (`ps -o pgid=`), or null when unknowable: Node has no getpgid. */
export function ownProcessGroup(pid = process.pid) {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  const n = Number(r.stdout?.trim());
  return r.status === 0 && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The CLI-entry check (run-engine.mjs main): null when THIS process runs inside an active host claim that covers heavy
 * command `cmd` of the run whose state is `S` at `statePath`; otherwise { code: 'host_claim_required', reason }. Active =
 * the claim named by CLAIM_OP_ENV exists in the store, is heavy with weight >= the command's, is bound to this run's state
 * file, is bound to a process group whose identity is verified, and this process is a member of that group. Read-only.
 */
export function checkHostClaim({ S, statePath, cmd, gateKind, env = process.env, platform = process.platform, ownPgid = ownProcessGroup,
  info = processInfo, isAlive = groupAlive, host = hostname() }) {
  const need = requiredWeight(S, cmd, gateKind);
  const no = (why) => ({ code: 'host_claim_required', reason: `${cmd}${gateKind ? ' ' + gateKind : ''} of this run (config.hostClaimRequired) needs an active `
    + `host claim of weight >= ${need}: start it through host-admit.mjs run -- <engine command> (${why})` });
  if (platform === 'win32') return no('host claims need POSIX process groups');
  const op = env[CLAIM_OP_ENV];
  if (typeof op !== 'string' || !op) return no(`no ${CLAIM_OP_ENV} in the environment`);
  let c;
  try { c = listClaims(storeDir(env)).find(x => x.id === op)?.claim; } catch (e) { return no(`the claim store is unreadable: ${e.message}`); }
  if (!c) return no(`no readable claim ${op}`);
  if (c.claimer.host !== host) return no(`claim ${op} is from another host`);
  if (c.class !== 'heavy' || c.weight < need) return no(`claim ${op} is ${c.class} of weight ${c.weight}`);
  let real;
  try { real = realpathSync(statePath); } catch { return no('the run state is unreadable'); }
  if (c.run_state !== real) return no(`claim ${op} is bound to ${c.run_state ?? 'no run'}, not to this run (${real})`);
  if (c.pgid === null) return no(`claim ${op} is not bound to a process group`);
  const mine = ownPgid();
  if (mine !== c.pgid) return no(`this process (process group ${mine ?? 'unknown'}) is not in claim ${op}'s process group ${c.pgid}`);
  if (groupIdentity({ pgid: c.pgid, leader_start: c.leader_start }, isAlive, info) !== 'verified') return no(`claim ${op}'s process group identity is not verified`);
  return null;
}
