/**
 * Shared test fixture for the run engine (run-engine.test.mjs, run-engine-repair.test.mjs).
 * Not a test file: it builds a temp git repo with an approved plan, a bound DAG, prompts and a
 * fake `claude` CLI on PATH, and helpers that drive the REAL engine CLI (`node run-engine.mjs`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSpec } from './provider-env.mjs';

export const POSIX = process.platform !== 'win32';
export const BEGIN = '<!-- RUN-STATE:BEGIN -->';
export const END = '<!-- RUN-STATE:END -->';
export const CLAUDE_OUT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK',
  usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } });

/** Digest in the skill's canonical `sha256:<hex>` form (the form real START events use). */
export const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
export const narrativeDigest = (text) => sha(text.slice(0, text.indexOf(BEGIN) + BEGIN.length) + text.slice(text.indexOf(END)));
export const delay = (ms) => new Promise(r => setTimeout(r, ms));
export const codes = (s) => (s?.judgments ?? []).map(j => j.code);

export function gitPath(repo, rel) {
  const r = spawnSync('git', ['rev-parse', '--git-path', rel], { cwd: repo, encoding: 'utf8' });
  return resolve(repo, r.stdout.trim());
}

/**
 * Fake provider CLI: `claude auth status` reports a subscription login; otherwise it reads
 * NODE=<id> from the prompt, logs the run and applies behaviour.json[<id>]:
 *   write {path: text}, remove [path] (deletes them first), appendRunState (inserts a NOTE inside RUN-STATE), appendEvent {event}
 *   (inserts that event inside RUN-STATE), appendRaw <text> (inserts those exact bytes), appendLate {event} (the same, just before the worker
 *   finishes, e.g. after waitFor), editPlan (edits the
 *   narrative), breakGit (makes `git status` fail), sleeper <pidfile> (leaves a background
 *   child in the process group), holdStdout <pidfile> (the same, holding the provider's stdout open),
 *   killGroup, exit <code>, hang, delayMs <ms> (finishes normally after that long: a slow worker),
 *   startDelayMs <ms> (blocks that long before doing anything, writes and appends included: a slow start), waitFor <file>.
 */
export const FAKE_CLI = (root) => `import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.argv.slice(2).includes('auth')) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
const ROOT = ${JSON.stringify(root)};
const prompt = readFileSync(0, 'utf8');
const node = /NODE=(\\S+)/.exec(prompt)?.[1] ?? 'unknown';
appendFileSync(join(ROOT, 'runs.log'), node + '\\n');
let b = {};
try { b = JSON.parse(readFileSync(join(ROOT, 'behaviour.json'), 'utf8'))[node] ?? {}; } catch {}
if (b.startDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, b.startDelayMs);
for (const p of b.remove ?? []) rmSync(p, { recursive: true, force: true });
for (const [p, c] of Object.entries(b.write ?? {})) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
const PLAN = '.specs/plans/T-1.md';
if (b.appendRunState) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', '{"event":"NOTE","note":"worker"}\\n${END}'));
if (b.appendEvent) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', JSON.stringify(b.appendEvent) + '\\n${END}'));
if (b.appendRaw) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', () => b.appendRaw + '${END}'));
if (b.editPlan) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('Approved narrative.', 'Forged narrative.'));
if (b.breakGit) { rmSync('.git/index', { force: true }); mkdirSync('.git/index'); }
if (b.sleeper) {
  const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(b.sleeper, String(s.pid)); s.unref();
}
if (b.holdStdout) {
  const h = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
  writeFileSync(b.holdStdout, String(h.pid)); h.unref();
}
function finish() {
  if (b.appendLate) writeFileSync(PLAN, readFileSync(PLAN, 'utf8').replace('${END}', JSON.stringify(b.appendLate) + '\\n${END}'));
  if (b.killGroup) process.kill(0, 'SIGKILL');
  if (b.exit) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'provider error' })); process.exit(b.exit); }
  process.stdout.write(b.apiMs === undefined ? ${JSON.stringify(CLAUDE_OUT)} : JSON.stringify({ ...JSON.parse(${JSON.stringify(CLAUDE_OUT)}), duration_api_ms: b.apiMs, num_turns: 3 }));
}
if (b.hang) setInterval(() => {}, 1000);
else if (b.delayMs) setTimeout(finish, b.delayMs);
else if (b.waitFor) { const t = setInterval(() => { if (existsSync(b.waitFor)) { clearInterval(t); finish(); } }, 50); }
else finish();
`;

export const STAGED = [
  { id: 'a', reads: ['docs/in.txt'], writes: ['src/a.txt'] },
  { id: 'b', deps: ['a'], reads: ['src/a.txt'], writes: ['src/b.txt'] },
  { id: 'c', writes: ['src/c.txt'] },
];
export const STAGED_BEHAVIOUR = { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } }, c: { write: { 'src/c.txt': 'c1' } } };

const ENGINE_CLI = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));

/**
 * Warm-up: the first exec of a freshly created executable can stall up to ~13 s under load on macOS
 * (likely a Gatekeeper/AMFI scan of the new file; the stall was measured, the cause was not). Pay that
 * here, once, synchronously and with no timeout, so the engine's 15 s subscription check does not.
 * The production budget is intentionally unchanged. The fake's `auth` path exits 0 at once and writes
 * no runs.log line or state, so behaviour is unaffected. Call it again after any rebuild of the file.
 * Windows: the .cmd is spawned the way production does (spawnSpec, which adds a shell for .cmd/.bat).
 * Returns true only when the warm-up really ran and exited 0.
 */
export function warmFakeClaude(bin, env) {
  const spec = spawnSpec(join(bin, POSIX ? 'claude' : 'claude.cmd'), ['auth', 'status', '--json'], process.platform, env);
  const warm = spawnSync(spec.file, spec.args, { env, stdio: 'ignore', shell: spec.shell });
  return !warm.error && warm.status === 0;
}

/**
 * Temp git repo with an approved plan, a DAG file, prompts and a fake `claude` on PATH.
 * bind: 'plan' lists the DAG digest in the narrative; 'dag_bound' records one DAG_BOUND event;
 * 'none' binds nothing. extraEvents(dagDigest) appends further RUN-STATE events.
 * digestForm: 'colon' (canonical) or 'dash' (legacy spelling the engine normalizes).
 * commit: make an initial commit so candidate ids (base HEAD) are computable.
 * startAt: the START timestamp (default 2026-11-05, before the security policy cutoff).
 * narrativeExtra: text appended to the approved narrative (e.g. a plan §3a security block).
 */
export function fixture(t, { nodes = [{ id: 'a', writes: ['src/a.txt'] }], config = {}, bind = 'plan', extraEvents = () => [],
  behaviour = { a: { write: { 'src/a.txt': 'a1' } } }, digestForm = 'colon', commit = false, startAt = '2026-11-05T00:00:00Z', narrativeExtra = '' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-engine-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  for (const d of ['src', 'docs', join('.specs', 'plans')]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'docs', 'in.txt'), 'input v1');
  spawnSync('git', ['init', '-q'], { cwd: repo });

  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'fake-claude.mjs'), FAKE_CLI(root));
  if (POSIX) { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${join(bin, 'fake-claude.mjs')}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  else writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs" %*\r\n`);
  const sep = POSIX ? ':' : ';';
  const { NODE_TEST_CONTEXT: _nested, ...base } = process.env; // a nested `node --test` must not report to this runner
  const env = { ...base, PATH: bin + sep + process.env.PATH, Path: bin + sep + (process.env.Path ?? process.env.PATH) };
  const warmedUp = warmFakeClaude(bin, env);

  const promptFor = (id) => { const p = join(root, `prompt-${id}.txt`); writeFileSync(p, `NODE=${id}\n`); return p; };
  const dag = {
    schema: 'ship-ticket-engine-dag-v1',
    config: { provider: 'claude', modelMap: {}, permissionMode: 'acceptEdits', billing: 'subscription', width: 2,
      memoryBudgetMb: 4096, timeoutMs: 10000, budget: null, candidateExclusions: ['.specs/plans/T-1.md', 'session-log.md'],
      testCommands: {}, base: commit ? 'HEAD' : 'main', ...config },
    nodes: nodes.map(n => ({ deps: [], reads: [], writes: [], othersOwned: [], resources: [], risk: [], complexity: 'low',
      modelTier: 'inherit', estimatedMemoryMb: 64, promptFile: promptFor(n.id), phase: 'BUILD', role: 'builder',
      evidence: [], redSpecs: [], ...n })),
  };
  const dagFile = join(root, 'dag.json');
  const dagText = JSON.stringify(dag, null, 2);
  writeFileSync(dagFile, dagText);
  const dagDigest = sha(dagText);
  const dash = (d) => (digestForm === 'dash' ? d.replace(/^sha256:/, 'sha256-') : d);

  const narrative = `# Plan T-1\n\nApproved narrative.\n\n${bind === 'plan' ? `Execution DAG digest: ${dash(dagDigest)}\n\n` : ''}${narrativeExtra}`;
  const skeleton = `${narrative}${BEGIN}\n${END}\n`;
  const events = [{ run_id: 'run-1', event: 'START', timestamp: startAt, approved_plan_digest: dash(narrativeDigest(skeleton)) }];
  if (bind === 'dag_bound') events.push({ run_id: 'run-1', event: 'DAG_BOUND', dag_digest: dash(dagDigest) });
  events.push(...extraEvents(dagDigest));
  const planFile = join(repo, '.specs', 'plans', 'T-1.md');
  writeFileSync(planFile, `${narrative}${BEGIN}\n${events.map(e => JSON.stringify(e)).join('\n')}\n${END}\n`);
  writeFileSync(join(root, 'behaviour.json'), JSON.stringify(behaviour));
  if (commit) {
    const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
  }

  let inputSeq = 0;
  const fx = {
    root, repo, dagFile, dagDigest, planFile, env, warmedUp,
    ctx: (extra = {}) => ({ repoRoot: repo, ticket: 'T-1', runId: 'run-1', dagFile, env, verifySubscription: () => true,
      handleSignals: false, ...extra }),
    stateFile: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.state.json'),
    lockFile: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.lock'),
    runLog: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.jsonl'),
    engineLog: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.engine.jsonl'),
    usageFile: () => gitPath(repo, 'ai-skills/ship-ticket/T-1.usage.jsonl'),
    runs: (id) => { try { return readFileSync(join(root, 'runs.log'), 'utf8').split('\n').filter(l => l && (!id || l === id)); } catch { return []; } },
    behave: (b) => writeFileSync(join(root, 'behaviour.json'), JSON.stringify(b)),
    prompt: promptFor,
    readState: () => JSON.parse(readFileSync(fx.stateFile(), 'utf8')),
    editState: (fn) => { const s = fx.readState(); fn(s); writeFileSync(fx.stateFile(), JSON.stringify(s)); },
    /**
     * Test injection of a per-step budget. The engine has one run-wide timeoutMs (workers AND proof/check
     * runners), bound at init. A test whose subject is a timeout sets it short only around the command
     * whose worker hangs (between commands) and restores the failure bound after, so nothing that should
     * finish by itself ever races a short timer (load-sensitive engine tests, PR #84).
     */
    setRunTimeout: (ms) => fx.editState((s) => { s.config.timeoutMs = ms; }),
    /** Run the real engine CLI: `node run-engine.mjs <cmd> --repo --ticket --run-id [--flag value...]`. */
    cli: (cmd, flags = {}, { runId = 'run-1', timeout = 60000 } = {}) => {
      const args = [ENGINE_CLI, ...cmd.split(' '), '--repo', repo, '--ticket', 'T-1', '--run-id', runId,
        ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout });
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { status: r.status, out, stderr: r.stderr, stdout: r.stdout };
    },
    /** `run-engine.mjs gate <kind> --input <file>` with `input` written to a temp file. */
    gate: (kind, input, opts) => {
      const file = join(root, `gate-input-${++inputSeq}.json`);
      writeFileSync(file, typeof input === 'string' ? input : JSON.stringify(input));
      return fx.cli(`gate ${kind}`, { input: file }, opts);
    },
    /** Spawn the engine CLI asynchronously (for crash tests); resolves nothing, returns the child. */
    spawnCli: (cmd, flags = {}) => spawn(process.execPath, [ENGINE_CLI, ...cmd.split(' '), '--repo', repo, '--ticket', 'T-1', '--run-id', 'run-1',
      ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { env, stdio: 'ignore' }),
    candidate: () => {
      const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', repo, '--base', 'HEAD', '--exclude', '.specs/plans/T-1.md', '--exclude', 'session-log.md'],
        { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).candidate_id;
    },
    appendRunState: (event) => {
      const text = readFileSync(planFile, 'utf8');
      writeFileSync(planFile, text.replace(END, JSON.stringify(event) + '\n' + END));
    },
  };
  return fx;
}

/**
 * S-12: give a fixture repo a real remote. Commits the work tree as the base, names its branch `branch`
 * (never init.defaultBranch), clones it bare to <root>/origin.git as remote `origin` and fetches it. `upstream(n, prefix)`
 * pushes `n` commits (one file each, `<prefix>/f<i>.txt`) to origin from a separate clone, as another developer would;
 * the fixture repo's own refs do not move until `fetch()`. `git(...args)` runs in the fixture repo.
 *
 * S-28a: `github: 'owner/repo'` makes origin GitHub-shaped: remote.origin.url is https://github.com/<owner/repo>.git and a
 * repo-local `url.<bare>.insteadOf` maps it to the local bare, so no network is reached (the technique of commit a890b0d
 * run-engine-r0s5.test.mjs lines 389-391). `repoint(slug, { reachable })` re-points origin at another GitHub URL, mapped to the
 * same bare (reachable, the default: the identity is the only difference) or to a path that does not exist.
 */
export function withOrigin(fx, { branch = 'main', github } = {}) {
  const run = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
  const must = (cwd, ...a) => { const r = run(cwd, ...a); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const origin = join(fx.root, 'origin.git'), up = join(fx.root, 'upstream');
  const ghUrl = (slug) => `https://github.com/${slug}.git`;
  must(fx.repo, 'add', '-A');
  must(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  must(fx.repo, 'branch', '-M', branch);
  must(fx.root, 'clone', '-q', '--bare', fx.repo, origin);
  must(fx.repo, 'remote', 'add', 'origin', origin);
  if (github) {
    must(fx.repo, 'config', '--add', `url.${origin}.insteadOf`, ghUrl(github));
    must(fx.repo, 'remote', 'set-url', 'origin', ghUrl(github));
  }
  must(fx.repo, 'fetch', '-q', 'origin');
  must(fx.repo, 'branch', '-q', `--set-upstream-to=origin/${branch}`, branch); // the base branch tracks origin, as a clone's does
  must(fx.root, 'clone', '-q', '--branch', branch, origin, up);
  let seq = 0;
  return { origin, branch, git: (...a) => must(fx.repo, ...a), gitRaw: (...a) => run(fx.repo, ...a), sha: (ref) => must(fx.repo, 'rev-parse', ref),
    fetch: () => must(fx.repo, 'fetch', '-q', 'origin'),
    gitDir: () => join(fx.repo, '.git'),
    /** Check out a new ticket branch (from `start`, default HEAD) that tracks origin/<branch>, as a pushed branch would. */
    feature: (start = 'HEAD', name = 'feature') => { must(fx.repo, 'checkout', '-q', '-b', name, start); must(fx.repo, 'branch', '-q', `--set-upstream-to=origin/${branch}`, name); },
    upstream(n, prefix = 'upstream') {
      mkdirSync(join(up, prefix), { recursive: true });
      for (let i = 0; i < n; i++) { const f = `${prefix}/f${++seq}.txt`; writeFileSync(join(up, f), `upstream ${seq}\n`); must(up, 'add', f); must(up, 'commit', '-q', '-m', `upstream ${seq}`); }
      must(up, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      return must(up, 'rev-parse', 'HEAD');
    },
    /** Rewind origin's branch to `sha` (a force-push below what was pinned). */
    rewind: (sha) => { must(up, 'push', '-q', '--force', 'origin', `${sha}:refs/heads/${branch}`); },
    /** S-28a: point remote.origin.url at https://github.com/<slug>.git, mapped to the bare (reachable) or to a missing path. */
    repoint: (slug, { reachable = true } = {}) => {
      must(fx.repo, 'config', '--add', `url.${reachable ? origin : join(fx.root, 'nowhere.git')}.insteadOf`, ghUrl(slug));
      must(fx.repo, 'remote', 'set-url', 'origin', ghUrl(slug));
    },
    /**
     * S-28a attempt 2: a SECOND bare repository at https://github.com/<slug>.git (insteadOf) that is origin PLUS `extra` commits
     * (shared ancestry), its tip fetched into the fixture repo (every object present), so a read mixing it with origin pins or
     * verifies its SHAs instead of failing. Does not change remote.origin.url. -> its tip.
     */
    evil(slug = 'evil/other', extra = 2) {
      const bare = join(fx.root, 'evil.git'), work = join(fx.root, 'evil-work');
      must(fx.root, 'clone', '-q', '--bare', origin, bare);
      must(fx.root, 'clone', '-q', '--branch', branch, bare, work);
      for (let i = 0; i < extra; i++) { writeFileSync(join(work, `evil${i}.txt`), `evil ${i}\n`); must(work, 'add', '-A'); must(work, 'commit', '-q', '-m', `evil ${i}`); }
      must(work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      must(fx.repo, 'config', '--add', `url.${bare}.insteadOf`, ghUrl(slug));
      must(fx.repo, 'fetch', '-q', bare, `+refs/heads/${branch}:refs/evil/${branch}`);
      return must(work, 'rev-parse', 'HEAD');
    },
    ghUrl };
}

/**
 * S-28a attempt 2: a deterministic counting `git` shim, first on fx.env.PATH (the engine CLI and every git it spawns use it; the
 * test's own git calls do not). Every path is written INTO the script (underHardenedGit strips GIT_* variables). It finds the
 * subcommand past --options and the -c/-C/--git-dir/--work-tree/--namespace operands, counts each `config` process that names
 * `remote.` (one line in log), and records each ls-remote's arguments. `flip(n, { key, to, restore })`: on the n-th counted
 * config process it sets `key` to `to` before running it, and (restore, the default) puts the old value back after it.
 * POSIX only (callers skip win32).
 */
export function withGitShim(fx) {
  const dir = join(fx.root, 'shim'), real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(real.startsWith('/'), `the real git is found by absolute path: ${real}`);
  mkdirSync(dir, { recursive: true });
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  writeFileSync(join(dir, 'git'), `#!/bin/sh
D=${q(dir)}; REAL=${q(real)}; REPO=${q(fx.repo)}
sub=''; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in -c|-C|--git-dir|--work-tree|--namespace) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac
done
if [ "$sub" = ls-remote ]; then printf '%s\\n' "$*" >> "$D/ls"; fi
if [ "$sub" = config ]; then
  case "$*" in *remote*)
    n=$(( $(cat "$D/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/count"; printf '%s %s\\n' "$n" "$*" >> "$D/log"
    if [ "$n" = "$(cat "$D/flip" 2>/dev/null)" ]; then
      key=$(cat "$D/key"); old=$("$REAL" -C "$REPO" config --get "$key")
      "$REAL" -C "$REPO" config "$key" "$(cat "$D/to")"
      "$REAL" "$@"; rc=$?
      if [ "$(cat "$D/restore")" = 1 ]; then if [ -n "$old" ]; then "$REAL" -C "$REPO" config "$key" "$old"; else "$REAL" -C "$REPO" config --unset "$key"; fi; fi
      exit $rc
    fi ;;
  esac
fi
exec "$REAL" "$@"
`);
  chmodSync(join(dir, 'git'), 0o755);
  const sep = POSIX ? ':' : ';';
  fx.env.PATH = dir + sep + fx.env.PATH;
  if (fx.env.Path !== undefined) fx.env.Path = dir + sep + fx.env.Path;
  const lines = (f) => { try { return readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const shim = {
    /** Clear the counters and logs, and any flip. */
    reset: () => { for (const f of ['count', 'log', 'ls', 'flip']) rmSync(join(dir, f), { force: true }); return shim; },
    flip: (n, { key = 'remote.origin.url', to, restore = true }) => {
      writeFileSync(join(dir, 'flip'), String(n)); writeFileSync(join(dir, 'key'), key); writeFileSync(join(dir, 'to'), to); writeFileSync(join(dir, 'restore'), restore ? '1' : '0');
      return shim;
    },
    /** The counted remote-config processes since the last reset (their argv). */
    reads: () => lines('log'),
    /** The ls-remote argv since the last reset. */
    lsRemotes: () => lines('ls'),
  };
  return shim.reset();
}

export function spawnSpy() {
  const calls = [];
  return { calls, fn: (...args) => { calls.push(args); return spawn(...args); } };
}

export function runStateEvents(planFile) {
  const text = readFileSync(planFile, 'utf8');
  return text.slice(text.indexOf(BEGIN), text.indexOf(END)).split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
}

export function runLogEvents(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export async function waitUntil(pred, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await delay(50); }
  return false;
}

/** A complete review.md primary artifact (non-empty coverage, criteria and rule rows). */
export const primaryReview = (candidate, over = {}) => ({ reviewer_identity: 'opus:review', candidate_id: candidate,
  reviewed_paths: ['src/a.txt'], reasoned_exclusions: [],
  coverage_partitions: [{ identity: 'opus:review', owned: ['src/'], outcome: 'PASS' }],
  acceptance_criteria: [{ criterion: 'AC1', outcome: 'PASS', evidence: 'run-engine.test.mjs' }],
  rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }],
  parity_outcome: 'NOT_TRIGGERED', attack_review_outcome: 'NOT_TRIGGERED', security_outcome: 'PASS',
  findings: [], overflow: false, outcome: 'PASS', ...over });

export const secondOpinion = (candidate, over = {}) => ({ route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: candidate,
  findings: [], overflow: false, outcome: 'PASS', ...over });

/** A complete original review input (PASS by default). */
export const passReview = (rx, candidate, over = {}) => ({ review_execution: rx, kind: 'original',
  primary: primaryReview(candidate), second_opinion: secondOpinion(candidate), reconciliation: { dispositions: [] }, ...over });

/** An original FAIL review whose one primary finding on `path` is to be fixed by the repair brief `promptFile`. */
export const failReview = (rx, candidate, path, promptFile) => ({ review_execution: rx, kind: 'original',
  primary: primaryReview(candidate, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path }],
    acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: path }] }),
  second_opinion: secondOpinion(candidate),
  reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] },
  repair_prompt_file: promptFile });

/** A targeted confirmation of `rx` on the repaired candidate. */
export const confirmReview = (rx, candidate) => ({ review_execution: rx, kind: 'confirmation',
  primary: { reviewer_identity: 'opus:review', candidate_id: candidate, checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed' } });
