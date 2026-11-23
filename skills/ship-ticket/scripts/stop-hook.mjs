#!/usr/bin/env node
/**
 * Stop hook SCRIPT for a Factory (ship-ticket engine) run. NOT installed by anything in this repository: wiring it
 * into a settings file is the owner's separate approval (D-9). See references/execution-harness.md.
 *
 * At the end of a turn Claude Code runs this with a JSON object on stdin ({ session_id, transcript_path, cwd,
 * stop_hook_active, ... }). It asks the engine one question, "is there an allowed next step?", by running the
 * read-only `engine-accepted.mjs next` for the single live run of this repository (argv array, no shell), and:
 *   - action run|dispatch  -> prints {"decision":"block","reason":...} naming the step: Claude continues the run;
 *   - stop acceptance_unknown with facts.settle_with -> block: "run <settle_with>, then come back" (not a real stop);
 *   - any other stop (gate_refused, no_progress, identity_unavailable, state_moved, owner-class codes,
 *     review_fail_no_repair, owner_publish, unknown ...) -> prints nothing: Claude may stop and report.
 * FAIL OPEN: any error, missing or malformed input or state, zero or several candidate runs, timeout (hard limit
 * HARD_LIMIT_MS) or unsupported condition ends in exit 0 with no output, which allows stopping.
 * Loop bound with NO new state: when stdin says stop_hook_active is true (this stop was already a forced
 * continuation) it allows stopping, so at most one forced continuation per turn.
 * It never runs the named command, takes no lock, and writes no file.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HARD_LIMIT_MS = 20000;
const MAX_STDIN = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), 'engine-accepted.mjs');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (s) => String(s).replace(/[^\x20-\x7e]/g, ' ').slice(0, 400);

/** The command as text: script, subcommand, ticket, run id, and the input object. Never the repo or any file path. */
function render(command, ticket, runId) {
  if (!isObj(command) || typeof command.script !== 'string' || typeof command.cmd !== 'string') return null;
  const input = command.input !== undefined ? ` --input <file holding ${clean(JSON.stringify(command.input))}>` : '';
  return clean(`node ${command.script} ${command.cmd} --repo <this repo> --ticket ${ticket} --run-id ${runId}${input}`);
}

/**
 * Pure decision: the `next` JSON of the engine -> { block: true, reason } or { block: false }.
 * Only run/dispatch and a settle-able acceptance_unknown continue; everything else, including anything unrecognised, stops.
 */
export function decide(next, ticket, runId) {
  try {
    if (!isObj(next) || !SAFE_ID.test(ticket ?? '') || !SAFE_ID.test(runId ?? '')) return { block: false };
    const phase = typeof next.phase === 'string' && /^[A-Z_]{1,32}$/.test(next.phase) ? next.phase : 'unknown';
    if (next.action === 'run' || next.action === 'dispatch') {
      const text = render(next.command, ticket, runId);
      if (!text) return { block: false };
      return { block: true, reason: `Factory run ${ticket}, phase ${phase}: the engine names an allowed next step. Continue the Factory run with exactly this step (${next.action}): ${text}` };
    }
    if (next.action === 'stop' && next.code === 'acceptance_unknown' && isObj(next.facts?.settle_with)) {
      const text = render(next.facts.settle_with, ticket, runId);
      if (!text) return { block: false };
      return { block: true, reason: `Factory run ${ticket}, phase ${phase}: acceptance is not yet readable from the run state, which is not a real stop. Run ${text} and then come back; pass its output to the engine next with --last.` };
    }
  } catch { /* fail open */ }
  return { block: false };
}

/** The single candidate { ticket, runId, repoRoot } or null (none, several, or anything unreadable). */
export function findRun(cwd) {
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const repoRoot = git('rev-parse', '--show-toplevel');
  const dir = resolve(repoRoot, git('rev-parse', '--git-path', 'ai-skills/ship-ticket'));
  if (!existsSync(dir)) return null;
  const found = [];
  for (const f of readdirSync(dir)) {
    const m = /^(.+)\.state\.json$/.exec(f);
    if (!m) continue;
    const S = JSON.parse(readFileSync(join(dir, f), 'utf8')); // unreadable or malformed throws: ambiguous, so stop is allowed
    if (!isObj(S) || S.ticket !== m[1] || !SAFE_ID.test(m[1]) || !SAFE_ID.test(S.run_id ?? '')) return null;
    found.push({ ticket: m[1], runId: S.run_id, repoRoot });
  }
  return found.length === 1 ? found[0] : null;
}

function readStdin() {
  return new Promise((res) => {
    let n = 0; const chunks = [];
    process.stdin.on('data', (c) => { n += c.length; if (n <= MAX_STDIN) chunks.push(c); });
    process.stdin.on('end', () => res(n <= MAX_STDIN ? Buffer.concat(chunks).toString('utf8') : null));
    process.stdin.on('error', () => res(null));
  });
}

function runNext(run, limitMs) {
  return new Promise((res) => {
    execFile(process.execPath, [ENGINE, 'next', '--repo', run.repoRoot, '--ticket', run.ticket, '--run-id', run.runId],
      { encoding: 'utf8', timeout: limitMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        // exit 0 = run/dispatch, 2 = stop (both carry the JSON); any other failure is not an answer
        if (err && err.code !== 2) return res(null);
        try { res(JSON.parse(stdout)); } catch { res(null); }
      });
  });
}

/** Whole hook: stdin text -> the stdout to print ('' allows stopping). Never throws. */
export async function hook(stdinText, { limitMs = HARD_LIMIT_MS } = {}) {
  try {
    const input = JSON.parse(stdinText ?? '');
    if (!isObj(input) || input.stop_hook_active === true) return '';
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const run = findRun(cwd);
    if (!run) return '';
    const next = await runNext(run, limitMs);
    const d = decide(next, run.ticket, run.runId);
    return d.block ? JSON.stringify({ decision: 'block', reason: d.reason }) + '\n' : '';
  } catch { return ''; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const limit = Number(process.env.STOP_HOOK_TIMEOUT_MS);
  const limitMs = Number.isFinite(limit) && limit > 0 && limit <= HARD_LIMIT_MS ? limit : HARD_LIMIT_MS;
  const timer = setTimeout(() => process.exit(0), limitMs + 1000); // hard stop: allow stopping
  readStdin().then((t) => hook(t, { limitMs })).then((out) => { process.stdout.write(out, () => process.exit(0)); })
    .catch(() => process.exit(0));
  void timer;
}
