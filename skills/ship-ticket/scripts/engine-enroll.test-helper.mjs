/**
 * Shared fixture for run-engine-enroll.test.mjs and git-guard.test.mjs (not a test file). Builds on
 * engine-test-fixture.mjs: a temp repo with an approved plan, a fake `claude` and a fake `gh` on
 * PATH, a ticket branch `T-1-work`, and a local bare remote `origin`. The DAG is the standard fixture
 * DAG (config.base HEAD) unless `base` names a branch. Git runs with an isolated global config.
 * `admit` (default true) is the fixture's: a successful `init` is followed by enroll + contexts.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, passReview } from './engine-test-fixture.mjs';
import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';

export const SKILL = fileURLToPath(new URL('..', import.meta.url));

/**
 * Fake `gh` (never the real one): records its argv as JSON lines in <root>/gh.log. `pr create` prints a PR URL.
 * The CI calls `run-engine.mjs ci` makes are served from <root>/gh-ci.json (`fx.scriptCi`): `checkRuns` is a
 * sequence of steps, one per call (the last repeats): { runs: [...], total?: n } or { fail: 'stderr text' }; a
 * run's head_sha '$SHA' is the requested commit. `pr` is the `gh pr view` JSON ('$HEAD' is the work tree's HEAD)
 * or { fail }, `runs` the `gh run list` JSON. Any other call, or a CI call with no script, exits 1.
 */
const FAKE_GH_JS = (root) => `const fs = require('fs'), { execFileSync } = require('child_process');
const root = ${JSON.stringify(root)}, argv = process.argv.slice(2);
fs.appendFileSync(root + '/gh.log', JSON.stringify(argv) + '\\n');
const die = (m) => { process.stderr.write('fake gh: ' + m + '\\n'); process.exit(1); };
if (argv[0] === 'pr' && argv[1] === 'create') { console.log('https://example.invalid/pr/1'); process.exit(0); }
let script = null;
try { script = JSON.parse(fs.readFileSync(root + '/gh-ci.json', 'utf8')); } catch { die('unscripted call ' + argv.join(' ')); }
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (argv[0] === 'api' && /\\/check-runs$/.test(argv[3] ?? '')) {
  const sha = /commits\\/([0-9a-f]+)\\//.exec(argv[3])[1];
  const steps = script.checkRuns ?? die('no checkRuns script');
  const n = Number((() => { try { return fs.readFileSync(root + '/gh-ci.count', 'utf8'); } catch { return '0'; } })());
  fs.writeFileSync(root + '/gh-ci.count', String(n + 1));
  const step = steps[Math.min(n, steps.length - 1)];
  if (step.fail) die(step.fail);
  const runs = step.runs.map(r => ({ ...r, head_sha: r.head_sha === '$SHA' ? sha : r.head_sha }));
  console.log(JSON.stringify({ total_count: step.total ?? runs.length }));
  for (const r of runs) console.log(JSON.stringify(r));
} else if (argv[0] === 'pr' && argv[1] === 'view') {
  if (!script.pr || script.pr.fail) die(script.pr?.fail ?? 'no pr script');
  console.log(JSON.stringify({ ...script.pr, headRefOid: script.pr.headRefOid === '$HEAD' ? head() : script.pr.headRefOid }));
} else if (argv[0] === 'run' && argv[1] === 'list') {
  console.log(JSON.stringify(script.runs ?? []));
} else die('unscripted call ' + argv.join(' '));
`;

export function enrollFixture(t, opts = {}) {
  const { base = 'HEAD', branch = 'T-1-work', config = {}, admit = true, nodes, behaviour } = opts;
  // modelMap: the builders are claude:sonnet, so the strict policy's engine reviewer (claude:opus) is never a builder.
  const fx = fixture(t, { commit: true, admit, ...(nodes ? { nodes } : {}), ...(behaviour ? { behaviour } : {}), ...(opts.approvePolicy === false ? { approvePolicy: false } : {}), ...(opts.bind ? { bind: opts.bind } : {}),
    config: { base, timeoutMs: WORKER_FAILURE_BOUND_MS, testCommands: { ok: { cmd: process.execPath, args: ['-e', ''] } }, modelMap: { inherit: 'sonnet' }, ...config } });
  const home = join(fx.root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '');
  writeFileSync(join(fx.root, 'fake-gh.cjs'), FAKE_GH_JS(fx.root));
  writeFileSync(join(fx.root, 'bin', 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fx.root, 'fake-gh.cjs'))} "$@"\n`);
  chmodSync(join(fx.root, 'bin', 'gh'), 0o755);
  Object.assign(fx.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
  const g = (args, opts = {}) => spawnSync('git', args, { cwd: opts.cwd ?? fx.repo, encoding: 'utf8', env: opts.env ?? fx.env });
  const ok = (r) => { assert.equal(r.status, 0, `${r.stdout}${r.stderr}`); return r; };
  if (base !== 'HEAD') ok(g(['branch', base]));
  const defaultBranch = ok(g(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  const remote = join(fx.root, 'remote.git');
  ok(spawnSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8', env: fx.env }));
  ok(g(['remote', 'add', 'origin', remote]));
  // The remote's default branch is the PR base authorize publish resolves when the DAG's base is HEAD.
  ok(g(['push', '-q', 'origin', defaultBranch]));
  ok(g(['remote', 'set-head', 'origin', defaultBranch]));
  ok(g(['checkout', '-q', '-b', branch]));
  Object.assign(fx, {
    remote, defaultBranch, git: g, okGit: (args, opts) => ok(g(args, opts)),
    head: () => ok(g(['rev-parse', 'HEAD'])).stdout.trim(),
    remoteHead: (b = branch) => { const r = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { encoding: 'utf8', env: fx.env }); return r.status === 0 ? r.stdout.trim() : null; },
    commitAll: (msg = 'ship') => { ok(g(['add', '-A'])); ok(g(['commit', '-q', '-m', msg])); },
    /** Script the fake gh's CI answers (see FAKE_GH_JS) and reset its check-runs step counter. */
    scriptCi: (script) => { writeFileSync(join(fx.root, 'gh-ci.json'), JSON.stringify(script)); writeFileSync(join(fx.root, 'gh-ci.count'), '0'); },
    ghLog: () => (existsSync(join(fx.root, 'gh.log')) ? readFileSync(join(fx.root, 'gh.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    /** init (the fixture admits it), drive, a PASS review (engine-dispatched under the strict default), ship-ready: the engine path up to SHIP. */
    toShipReady: () => {
      for (const [cmd, f] of [['init', { dag: fx.dagFile }], ['drive', {}]]) {
        const r = fx.cli(cmd, f);
        assert.equal(r.status, 0, `${cmd}: ${r.stdout.slice(0, 400)}${r.stderr}`);
      }
      const rv = fx.gate('review', passReview('rx-1', fx.candidate()));
      assert.equal(rv.status, 0, rv.stdout + rv.stderr);
      const sr = fx.gate('ship-ready', {});
      assert.equal(sr.status, 0, sr.stdout + sr.stderr);
    },
  });
  // The fixture's candidate helper uses base HEAD; a base branch shifts the merge base.
  fx.candidate = () => {
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'candidate-id.mjs'), '--repo', fx.repo, '--base', base,
      '--exclude', '.specs/plans/T-1.md', '--exclude', 'session-log.md'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).candidate_id;
  };
  return fx;
}

/**
 * A private copy of the whole skill whose files a test may edit, as a copy install (`git: false`) or
 * as a git install (`git: true`: its own repository with one commit). `cli` runs the copy's engine.
 */
export function skillCopy(fx, { git = false } = {}) {
  const dir = join(fx.root, git ? 'skill-git' : 'skill-copy');
  cpSync(SKILL, dir, { recursive: true, filter: (src) => !/[\\/]\.git$/.test(src) }); // a copy install never carries the source's git metadata
  if (git) for (const a of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'skill']]) assert.equal(spawnSync('git', a, { cwd: dir, env: fx.env }).status, 0);
  return { dir, cli: (cmd, flags = {}, runId = 'run-1') => {
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'run-engine.mjs'), ...cmd.split(' '), '--repo', fx.repo, '--ticket', 'T-1', '--run-id', runId,
      ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { encoding: 'utf8', env: fx.env, timeout: 60000 });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* text */ }
    return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
  } };
}
