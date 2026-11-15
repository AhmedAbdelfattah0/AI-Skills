/**
 * Test helper (not a test file): engine-dispatched reviews for the shared fixtures, so the regression suites run the
 * STRICT (default) review policy end to end: review-dispatch -> a FAKE relay -> review-collect -> gate review.
 *
 * The fake relays are installed by name under the fixture's relay home (<root>/relay-home/.agents/skills/<skill>/scripts/
 * relay.mjs). The engine resolves relays from the account's home directory (os.userInfo, never $HOME); the in-process
 * seam `ctx.relayHome` points it at the fixture's, which is why every dispatch here runs IN PROCESS (a CLI
 * review-dispatch from a test would resolve the real home and could launch a real reviewer). No real claude or codex runs.
 *
 * Each fake relay reads the engine's brief on stdin, logs one line per launch to <root>/relay.log (whether the receipt
 * was already durable, whether the brief is the one the receipt hashed) and writes a relay result.json whose final
 * message is <root>/relay-behaviour.json[<skill>].final (a ```json fenced review), or a failure it is told to simulate.
 *
 * `strictReview` turns a hand-written gate review input into the collected engine output with the same CONTENT: it
 * dispatches each slot's role (the relay emits that slot's content without the engine fields), collects, and returns the
 * input with each dispatched slot replaced by its parsed result file (identities from the receipts). A dispatch the
 * engine refuses (not owed, wrong candidate, ...) leaves that slot hand-written, so the gate decides as it would.
 * CLI: node engine-review.test-helper.mjs <args.json>   ({ repoRoot, ticket, runId, relayHome, root, input }) -> stdout JSON
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEW_CLI = fileURLToPath(import.meta.url);
const J = JSON.stringify;

/** The fake relay: one file serves both skills (its skill is its install directory's name). */
export const FAKE_RELAY = (root) => `import { readFileSync, writeFileSync, appendFileSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const skill = basename(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const outDir = val('--out-dir'), cd = val('--cd');
const brief = readFileSync(0, 'utf8');
const ticket = /^Ticket (\\S+), run /m.exec(brief)?.[1] ?? 'T-1';
const rel = spawnSync('git', ['rev-parse', '--git-path', 'ai-skills/ship-ticket/' + ticket + '.state.json'], { cwd: cd, encoding: 'utf8' }).stdout.trim();
let receipt = null;
try { receipt = (JSON.parse(readFileSync(resolve(cd, rel), 'utf8')).review_dispatches ?? []).find(d => d.out_dir === outDir) ?? null; } catch {}
const briefSha = 'sha256:' + createHash('sha256').update(brief).digest('hex');
// Like the real relays: resolve the provider CLI by NAME through this process's PATH, and run it (claude 'auth status', which the fake
// answers without logging a run): cli_path is the file the relay would launch, so a test can prove which one ran.
const provider = skill === 'codex-delegate' ? 'codex' : 'claude';
let cliPath = null;
for (const d of (process.env.PATH ?? '').split(':').filter(Boolean)) { try { const p = join(d, provider); if (statSync(p).isFile()) { cliPath = realpathSync(p); break; } } catch {} }
const cliRun = cliPath ? spawnSync(cliPath, provider === 'claude' ? ['auth', 'status', '--json'] : ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) : null;
appendFileSync(${J(join(root, 'relay.log'))}, JSON.stringify({ skill, args, receipt_seen: Boolean(receipt), brief_matches: receipt?.prompt_sha256 === briefSha,
  brief_has_candidate: Boolean(receipt && brief.includes(receipt.candidate_id)), cli_path: cliPath, cli_status: cliRun?.status ?? null,
  path_head: (process.env.PATH ?? '').split(':')[0], node_options: process.env.NODE_OPTIONS ?? null }) + '\\n');
let all = {};
try { all = JSON.parse(readFileSync(${J(join(root, 'relay-behaviour.json'))}, 'utf8')); } catch {}
const b = all[skill] ?? {};
if (b.sleep_ms) await new Promise(r => setTimeout(r, b.sleep_ms));
const exitCode = b.exit ?? 0;
writeFileSync(join(outDir, 'result.json'), JSON.stringify({ schema: 'delegate-relay.result.v1', status: b.status ?? 'completed', exitCode,
  finalMessage: b.final ?? '' }));
process.exit(exitCode);
`;

export const RELAY_SKILLS = Object.freeze(['claude-delegate', 'codex-delegate']);

/** Install the fake relay for `skills` under `home` (the fixture's relay home). */
export function installRelays(root, home, skills = RELAY_SKILLS) {
  for (const skill of skills) {
    const d = join(home, '.agents', 'skills', skill, 'scripts');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'relay.mjs'), FAKE_RELAY(root));
  }
}

/** A review object as the reviewer writes it: without the fields the engine records from its receipt. */
export const reviewBody = (o) => { const { reviewer_identity: _i, candidate_id: _c, route: _r, ...rest } = o ?? {}; return rest; };
/** The relay final message carrying `obj` as the reviewer's JSON. */
export const finalMessage = (obj) => 'Review done.\n```json\n' + J(obj, null, 2) + '\n```\n';

const SLOTS = (kind) => (kind === 'confirmation' ? [['primary', 'confirmation'], ['second_opinion', 'second']] : [['primary', 'primary'], ['second_opinion', 'second']]);

/** Wait (bounded) until every live review attempt of the run wrote its envelope. */
async function envelopes(stateFile, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    let S = null;
    try { S = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* mid-write */ }
    const live = (S?.attempts ?? []).filter(a => a.kind === 'review' && ['intent', 'launched', 'running'].includes(a.status));
    if (S && live.every(a => existsSync(a.envelope_file))) return;
    if (Date.now() > end) throw new Error(`reviewer envelopes did not appear: ${live.map(a => a.attempt_id).join(', ')}`);
    await new Promise(r => setTimeout(r, 40));
  }
}

/** See the header. -> { input, dispatched: [{ slot, role, code }] } */
export async function strictReview({ repoRoot, ticket, runId, relayHome, root, input, env }) {
  const { reviewDispatch, reviewCollect } = await import('./run-engine.mjs');
  const io = await import('./engine-io.mjs');
  if (!input || typeof input !== 'object' || !['original', 'confirmation'].includes(input.kind)) return { input, dispatched: [] };
  const ctx = { repoRoot, ticket, runId, relayHome, handleSignals: false, ...(env ? { env } : {}) };
  const stateFile = io.gitPath(repoRoot, `ai-skills/ship-ticket/${ticket}.state.json`);
  const S = JSON.parse(readFileSync(stateFile, 'utf8'));
  const candidate = io.candidateId(repoRoot, io.candidateBase(S), S.pinned_exclusions ?? []).candidate_id;
  const slots = SLOTS(input.kind).filter(([slot]) => input[slot] && typeof input[slot] === 'object' && !Array.isArray(input[slot]));
  const behaviour = {};
  for (const [slot, role] of slots) behaviour[role === 'second' ? 'codex-delegate' : 'claude-delegate'] = { final: finalMessage(reviewBody(input[slot])) };
  writeFileSync(join(root, 'relay-behaviour.json'), J(behaviour));
  const dispatched = [];
  for (const [slot, role] of slots) {
    const r = await reviewDispatch({ ...ctx, role, candidate });
    dispatched.push({ slot, role, code: r.code, attempt_id: r.receipt?.attempt_id ?? null });
  }
  if (!dispatched.some(d => d.attempt_id)) return { input, dispatched };
  await envelopes(stateFile);
  await reviewCollect(ctx);
  const after = JSON.parse(readFileSync(stateFile, 'utf8'));
  const out = { ...input };
  for (const d of dispatched.filter(x => x.attempt_id)) {
    const rec = (after.review_dispatches ?? []).find(x => x.attempt_id === d.attempt_id);
    if (rec?.status === 'collected') out[d.slot] = JSON.parse(readFileSync(rec.collected.parsed_file, 'utf8'));
  }
  return { input: out, dispatched };
}

/** One in-process review-dispatch with the fixture's relay home (args.mode 'dispatch'): the CLI's output and exit code. */
async function dispatchOnce({ repoRoot, ticket, runId, relayHome, role, candidate, env }) {
  const { reviewDispatch } = await import('./run-engine.mjs');
  const r = await reviewDispatch({ repoRoot, ticket, runId, relayHome, role, candidate, handleSignals: false, ...(env ? { env } : {}) });
  return { out: r, status: r.dispatched === false ? 2 : 0 };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(REVIEW_CLI)) {
  const args = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const run = args.mode === 'dispatch' ? dispatchOnce(args).then(r => { process.stdout.write(J(r.out, null, 2) + '\n'); process.exitCode = r.status; })
    : strictReview(args).then(r => { process.stdout.write(J(r)); });
  run.catch((e) => { process.stderr.write(`review helper: ${e.stack ?? e.message}\n`); process.exitCode = 1; });
}
