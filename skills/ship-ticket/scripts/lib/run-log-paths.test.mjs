// S5 (F05): run logs live in ONE place per repository (git-common-dir), are read from it or from the old per-worktree
// path, and no event is split or lost across linked worktrees. Safe on windows-latest: paths are compared through
// realpathSync.native, git identities are passed per command, and nothing here needs a POSIX shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn as spawnAsync } from 'node:child_process';
import { commonLogDir, legacyLogDirs, ownLogDir } from './run-log-paths.mjs';

const RUN_LOG = fileURLToPath(new URL('../run-log.mjs', import.meta.url));
const real = (p) => realpathSync.native(p);
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A main checkout with one commit and a linked worktree `wt2` next to it. */
function worktrees(t) {
  const base = real(mkdtempSync(join(tmpdir(), 's5-wt-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'main'), wt2 = join(base, 'wt2');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  mkdirSync(join(main, 'sub'));
  git(main, 'worktree', 'add', '-q', wt2);
  mkdirSync(join(wt2, 'deep', 'er'), { recursive: true });
  const common = join(main, '.git', 'ai-skills', 'ship-ticket');
  const wt2Legacy = join(main, '.git', 'worktrees', 'wt2', 'ai-skills', 'ship-ticket');
  const cli = (repo, ...args) => spawnSync(process.execPath, [RUN_LOG, ...args, '--repo', repo], { encoding: 'utf8' });
  return { base, main, wt2, common, wt2Legacy, cli };
}
const iv = (cmd, eventId, extra = []) => [cmd, '--ticket', 'T1', '--run-id', 'run-1', '--kind', 'phase', '--name', `P${eventId}`, '--event-id', eventId, ...extra];
const legacyRow = (event, eventId, ts, extra = {}) => ({ schema: 'ship-ticket-run-log-v1', ticket: 'T1', run_id: 'run-1', event, event_id: eventId,
  kind: 'phase', name: `P${eventId}`, timestamp: ts, metrics: {}, ...(event === 'end' ? { duration_ms: 0, outcome: 'pass' } : {}), ...extra });
const seed = (dir, rows) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'T1.jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join('')); };
const summary = (fx, repo) => { const r = fx.cli(repo, 'summary', '--ticket', 'T1'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const intervals = (s) => s.runs.flatMap((r) => r.intervals.map((i) => i.event_id)).sort();

test('commonLogDir is the absolute shared dir from the main checkout, a linked worktree and their subdirectories', (t) => {
  const fx = worktrees(t);
  for (const repo of [fx.main, join(fx.main, 'sub'), fx.wt2, join(fx.wt2, 'deep', 'er')]) {
    const dir = commonLogDir(repo);
    assert.ok(/^([A-Za-z]:[\\/]|\/)/.test(dir), `absolute: ${dir}`);
    mkdirSync(dir, { recursive: true });
    assert.equal(real(dir), real(fx.common), repo);
  }
  mkdirSync(fx.wt2Legacy, { recursive: true });
  assert.equal(real(ownLogDir(join(fx.wt2, 'deep', 'er'))), real(fx.wt2Legacy), 'own per-worktree path, resolved from a subdirectory');
  assert.equal(real(ownLogDir(join(fx.main, 'sub'))), real(fx.common), 'the main checkout: own path IS the common dir');
});

test('legacyLogDirs: the own legacy dir only, never a sibling; null in the main checkout', (t) => {
  const fx = worktrees(t);
  mkdirSync(fx.common, { recursive: true });
  mkdirSync(fx.wt2Legacy, { recursive: true });
  assert.equal(legacyLogDirs(fx.main).own, null, 'main checkout: the pre-S5 log IS the shared log');
  assert.equal(real(legacyLogDirs(fx.wt2).own), real(fx.wt2Legacy));
  assert.equal(Object.hasOwn(legacyLogDirs(fx.main), 'siblings'), false, 'no sibling enumeration exists');
});

test('AC1: two worktrees write ONE common file; summary from either (and from a subdirectory) shows every event', (t) => {
  const fx = worktrees(t);
  let r = fx.cli(fx.main, ...iv('start', 'a'));
  assert.equal(r.status, 0, r.stderr);
  r = fx.cli(fx.wt2, ...iv('end', 'a', ['--outcome', 'pass']));
  assert.equal(r.status, 0, `end from wt2 of a start made in the main checkout: ${r.stderr}`);
  r = fx.cli(join(fx.wt2, 'deep', 'er'), ...iv('start', 'b'));
  assert.equal(r.status, 0, r.stderr);
  r = fx.cli(join(fx.main, 'sub'), ...iv('end', 'b'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(fx.common, 'T1.jsonl')), 'one file under <common>/ai-skills/ship-ticket');
  assert.equal(existsSync(join(fx.wt2Legacy, 'T1.jsonl')), false, 'nothing under .git/worktrees/wt2/...');
  assert.equal(existsSync(join(fx.main, 'sub', '..', '..', '.git')), false, 'a subdirectory --repo never resolves outside the repository');
  assert.equal(readFileSync(join(fx.common, 'T1.jsonl'), 'utf8').trim().split('\n').length, 4);
  for (const repo of [fx.main, fx.wt2, join(fx.wt2, 'deep', 'er')]) {
    const s = summary(fx, repo);
    assert.deepEqual(intervals(s), ['a', 'b'], repo);
    assert.deepEqual(s.integrity_warnings, []);
  }
});

test('S5 repair 2 (1) reserved ticket names are refused case-insensitively (pure rule)', async () => {
  const { isReservedTicket } = await import('./run-log-paths.mjs');
  assert.equal(typeof isReservedTicket, 'function');
  for (const n of ['T.engine', 'T.ENGINE', 'T.review-auth', 'T.REVIEW-AUTH', 'T.Review-Auth', 'review-auth', 'REVIEW-AUTH', 'excluded', 'EXCLUDED']) assert.equal(isReservedTicket(n), true, n);
  for (const n of ['T', 'T-1', 'review', 'engine', 'auth.T', 'T.review']) assert.equal(isReservedTicket(n), false, n);
});


// ======================================================================= S5 cutover (Variant C, review repair 5)
// The shared log is the ONLY runtime telemetry source. A linked worktree's pre-S5 log is a read-only archive: normal
// commands never read it, except `legacy_present` (own worktree, lstat + a bounded read) and the carrier (unchanged).
const EVAL = fileURLToPath(new URL('../eval.mjs', import.meta.url));
const SRC = fileURLToPath(new URL('../ship-ready-check.mjs', import.meta.url));
function three(t) {
  const fx = worktrees(t);
  git(fx.main, 'worktree', 'add', '-q', join(fx.base, 'wt3'));
  fx.wt3 = join(fx.base, 'wt3');
  fx.wt3Legacy = join(fx.main, '.git', 'worktrees', 'wt3', 'ai-skills', 'ship-ticket');
  return fx;
}
const legacyOf = (fx, rows = [legacyRow('start', 'old', '2026-01-01T00:00:00.000Z'), legacyRow('end', 'old', '2026-01-01T00:00:01.000Z')]) => {
  seed(fx.wt2Legacy, rows);
  if (fx.wt3Legacy) seed(fx.wt3Legacy, rows.map((r) => ({ ...r, event_id: `${r.event_id}3`, name: `P${r.event_id}3` })));
};
const evalOf = (repo) => { const r = spawnSync(process.execPath, [EVAL, 'report', '--repo', repo, '--ticket', 'T1'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const integrityOf = async (repo) => (await import('../run-log.mjs')).integritySummary(repo, 'T1');

test('cutover AC10/AC9-C: legacy rows never reach any figure; summary, eval and integrity are identical from main, wt2 and wt3', async (t) => {
  const fx = three(t);
  legacyOf(fx);
  assert.equal(fx.cli(fx.main, ...iv('start', 'a')).status, 0);
  assert.equal(fx.cli(fx.wt3, ...iv('end', 'a')).status, 0);
  const seen = [];
  for (const repo of [fx.main, fx.wt2, fx.wt3]) {
    const s = summary(fx, repo);
    const e = evalOf(repo);
    const i = await integrityOf(repo);
    assert.deepEqual(intervals(s), ['a'], `legacy rows are not merged (${repo})`);
    seen.push(JSON.stringify({ iv: intervals(s), w: s.integrity_warnings, ev: e.runs.map((r) => r.wall_ms_by_phase && Object.keys(r.wall_ms_by_phase)), i: [i.events, i.runs, i.warnings] }));
  }
  assert.equal(new Set(seen).size, 1, seen.join('\n'));
});

test('cutover legacy_present: own worktree only; regular file required (dir, symlink, fifo => unavailable); 1 MiB bound', (t) => {
  const fx = three(t);
  const lp = (repo) => { const { path, ...rest } = JSON.parse(fx.cli(repo, 'summary', '--ticket', 'T1').stdout).legacy_present ?? { files: 0 }; void path; return rest; };
  assert.deepEqual(lp(fx.main), { files: 0 }, 'the main checkout never has a legacy log');
  assert.deepEqual(lp(fx.wt2), { files: 0 });
  seed(fx.wt3Legacy, [legacyRow('start', 'x', '2026-01-01T00:00:00.000Z')]);
  assert.deepEqual(lp(fx.wt2), { files: 0 }, "a sibling's legacy log is never seen");
  assert.deepEqual(lp(fx.wt3), { files: 1, lines: 1 });
  writeFileSync(join(fx.wt3Legacy, 'T1.jsonl'), 'x\n'.repeat(700000)); // 1.4 MB
  assert.deepEqual(lp(fx.wt3), { files: 1, lines: 524288, truncated: true }, 'only the first MiB is read');
  rmSync(join(fx.wt3Legacy, 'T1.jsonl'));
  for (const [kind, make] of [['directory', (p) => mkdirSync(p)], ['symlink', (p) => symlinkSync(join(fx.wt3Legacy, 'elsewhere'), p)],
    ['fifo', (p) => spawnSync('mkfifo', [p])]]) {
    if (process.platform === 'win32' && kind !== 'directory') continue;
    const p = join(fx.wt3Legacy, 'T1.jsonl');
    make(p);
    if (!existsSync(p) && kind !== 'symlink') continue;
    const got = lp(fx.wt3);
    assert.deepEqual([got.files, got.lines, got.errno], [1, 'unavailable', 'not_regular'], kind);
    rmSync(p, { recursive: true, force: true });
  }
});

test('cutover AC2-C: an end whose start is not in the shared log is refused with the legacy text in a worktree with a legacy log, zero rows', (t) => {
  const fx = three(t);
  legacyOf(fx, [legacyRow('start', 'old', '2026-01-01T00:00:00.000Z')]);
  const before = existsSync(join(fx.common, 'T1.jsonl')) ? readFileSync(join(fx.common, 'T1.jsonl')) : null;
  const r = fx.cli(fx.wt2, ...iv('end', 'old'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no start in the shared log; this worktree has a pre-S5 log .* cannot be ended by this version: close it with the build that started it, or record that it was abandoned with "run-log\.mjs abandon/);
  assert.equal(existsSync(join(fx.common, 'T1.jsonl')) ? readFileSync(join(fx.common, 'T1.jsonl')) : null, before, 'zero rows');
  const plain = fx.cli(fx.main, ...iv('end', 'old'));
  assert.match(plain.stderr, /event old has no start in run run-1/, 'no legacy log in the main checkout: the normal text');
  assert.doesNotMatch(plain.stderr, /pre-S5/);
});

test('cutover abandon: only with own legacy_present > 0; idempotent; NEVER counted as complete by summary, eval or the integrity line', async (t) => {
  const fx = three(t);
  assert.match(fx.cli(fx.main, 'abandon', '--ticket', 'T1', '--run-id', 'run-1').stderr, /no pre-S5 log/, 'refused without a legacy log');
  legacyOf(fx, [legacyRow('start', 'old', '2026-01-01T00:00:00.000Z')]);
  // an S5 continuation of the same run in wt2, including a workflow interval that ends "fail" (a COMPLETE one refuses abandon)
  for (const a of [['start', '--ticket', 'T1', '--run-id', 'run-1', '--kind', 'workflow', '--name', 'ship_ticket', '--event-id', 'wf'],
    ['end', '--ticket', 'T1', '--run-id', 'run-1', '--kind', 'workflow', '--name', 'ship_ticket', '--event-id', 'wf', '--outcome', 'fail']]) assert.equal(fx.cli(fx.wt2, ...a).status, 0);
  const a1 = fx.cli(fx.wt2, 'abandon', '--ticket', 'T1', '--run-id', 'run-1', '--reason', 'old_build_unavailable');
  assert.equal(a1.status, 0, a1.stderr);
  const a2 = fx.cli(fx.wt2, 'abandon', '--ticket', 'T1', '--run-id', 'run-1', '--reason', 'superseded');
  assert.equal(a2.status, 0);
  assert.deepEqual(JSON.parse(a2.stdout), JSON.parse(a1.stdout), 'idempotent: a second abandon (another reason) returns the first record');
  assert.equal(JSON.parse(a2.stdout).metrics.reason, 'old_build_unavailable');
  const rows = readFileSync(join(fx.common, 'T1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.name === 'legacy_abandoned');
  assert.equal(rows.length, 2, 'one start/end pair');
  assert.ok(rows.every((r) => r.kind === 'activity' && /^legacy-abandoned\.[0-9a-f]{12}$/.test(r.event_id)), 'a NON-workflow reserved activity');
  for (const repo of [fx.main, fx.wt2, fx.wt3]) {
    const s = summary(fx, repo);
    assert.equal(s.runs[0].outcome, 'abandoned', `summary from ${repo}`);
    assert.equal(s.runs[0].recorded_outcome, 'fail', 'the recorded workflow outcome is kept, not rewritten');
    assert.equal(s.aggregate.completed_runs, 0, 'never counted complete');
    assert.equal(s.aggregate.abandoned_runs, 1);
    const e = evalOf(repo);
    assert.equal(e.runs[0].outcome, 'abandoned', `eval from ${repo}`);
    assert.notEqual(e.runs[0].accepted, true);
    const i = await integrityOf(repo);
    assert.equal(i.abandoned_runs, 1);
  }
  const plan = join(fx.base, 'plan.md'), log = join(fx.base, 'engine.log');
  writeFileSync(plan, '# P\n\n<!-- RUN-STATE:BEGIN -->\n<!-- RUN-STATE:END -->\n');
  writeFileSync(log, '');
  const line = spawnSync(process.execPath, [SRC, 'check', '--run-state', plan, '--engine-log', log, '--repo', fx.main, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.match(line.stdout, /run-log integrity: .* abandoned=1/);
});

test('cutover: every writer in a worktree with a legacy log marks its rows legacy_worktree=true; readers label such runs partial_legacy=possible', (t) => {
  const fx = three(t);
  legacyOf(fx);
  assert.equal(fx.cli(fx.wt2, ...iv('start', 'w')).status, 0);
  assert.equal(fx.cli(fx.main, ...iv('start', 'm')).status, 0);
  const rows = readFileSync(join(fx.common, 'T1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find((r) => r.event_id === 'w').metrics.legacy_worktree, true);
  assert.equal(Object.hasOwn(rows.find((r) => r.event_id === 'm').metrics, 'legacy_worktree'), false, 'the main checkout has no legacy log');
  const s = summary(fx, fx.main);
  assert.equal(s.runs[0].partial_legacy, 'possible');
  assert.equal(evalOf(fx.wt3).runs[0].partial_legacy, 'possible');
});

test('cutover: run-log.mjs legacy prints the archive of the named worktree read-only, never merged into a figure', (t) => {
  const fx = three(t);
  legacyOf(fx);
  const before = readFileSync(join(fx.wt2Legacy, 'T1.jsonl'));
  const r = fx.cli(fx.wt2, 'legacy', '--ticket', 'T1');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.scope, 'legacy-archive');
  assert.deepEqual(out.tickets[0].rows.map((x) => x.event_id), ['old', 'old']);
  assert.equal(out.tickets[0].summary.runs[0].intervals.length, 1);
  assert.deepEqual(readFileSync(join(fx.wt2Legacy, 'T1.jsonl')), before, 'read-only');
  assert.deepEqual(JSON.parse(fx.cli(fx.main, 'legacy', '--ticket', 'T1').stdout).tickets, [], 'main: no archive');
  assert.deepEqual(summary(fx, fx.wt2).runs, [], 'never merged');
});

// fs spy: a preloaded module records every path a child process touches through node:fs.
const SPY = `data:text/javascript,${encodeURIComponent(`import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const out = process.env.FS_SPY; const write = fs.appendFileSync.bind(fs); const seen = [];
for (const n of ['openSync','readFileSync','statSync','lstatSync','readdirSync','accessSync','existsSync','writeFileSync','appendFileSync','mkdirSync','opendirSync']) {
  const o = fs[n]; fs[n] = function (p, ...a) { if (typeof p === 'string') seen.push(n + ' ' + p); return o.call(this, p, ...a); }; }
syncBuiltinESMExports(); process.on('exit', () => write(out, seen.join('\\n') + '\\n'));`)}`;
test('cutover AC9-C (fs spy): no normal command opens a sibling legacy path; the own legacy log only via lstat + bounded open (legacy_present)', (t) => {
  const fx = three(t);
  legacyOf(fx);
  const spy = join(fx.base, 'spy.log');
  const run = (repo, script, ...args) => spawnSync(process.execPath, ['--import', SPY, script, ...args], { encoding: 'utf8', env: { ...process.env, FS_SPY: spy } });
  const ops = [iv('start', 'q'), iv('end', 'q'), ['event', '--ticket', 'T1', '--run-id', 'run-1', '--name', 'host_sleep', '--event-id', 's', '--metric', 'label=measured'],
    ['summary', '--ticket', 'T1'], ['summary', '--all'], ['check', '--ticket', 'T1'], ['quarantine', '--ticket', 'T1']];
  for (const [name, repo] of [['main', fx.main], ['wt2', fx.wt2], ['wt3', fx.wt3]]) {
    writeFileSync(spy, '');
    for (const op of ops) {
      const r = run(repo, RUN_LOG, ...op.map((a) => (a === 'q' || a === 's' ? `${a}${name}` : a)), '--repo', repo);
      assert.equal(r.status, 0, `${name} ${op[0]}: the spied command must succeed: ${r.stderr}`);
    }
    const ev = run(repo, EVAL, 'report', '--repo', repo, '--ticket', 'T1');
    assert.equal(ev.status, 0, ev.stderr);
    const trace = readFileSync(spy, 'utf8');
    assert.ok(trace.split('\n').filter(Boolean).length > 20, `${name}: the spy recorded the commands' fs calls`);
    assert.match(trace, new RegExp(`(openSync|readFileSync) .*${join('ai-skills', 'ship-ticket', 'T1.jsonl').replaceAll('/', '\\/')}`), `${name}: the shared log was read`);
    if (name !== 'main') assert.match(trace, new RegExp(`lstatSync .*${join('.git', 'worktrees', name, 'ai-skills', 'ship-ticket', 'T1.jsonl').replaceAll('/', '\\/')}`), `${name}: legacy_present lstat seen`);
    const touched = trace.split('\n').filter((l) => l.includes(`${join('.git', 'worktrees')}`));
    for (const line of touched) {
      const [op, path] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
      assert.ok(path.includes(join('.git', 'worktrees', name)), `${name} touched a sibling path: ${line}`);
      if (path.endsWith(join('ai-skills', 'ship-ticket', 'T1.jsonl'))) assert.ok(['lstatSync', 'openSync'].includes(op), `${name}: the own legacy log only via lstat/open (bounded read): ${line}`);
    }
  }
});

test('cutover: an unreadable (chmod 000) sibling legacy log or directory changes nothing for main and wt2', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'root or win32' }, (t) => {
  const fx = three(t);
  legacyOf(fx);
  const outcome = () => [fx.main, fx.wt2].map((repo, i) => [fx.cli(repo, ...iv('start', `o${i}${Math.random().toString(36).slice(2, 6)}`)).status,
    JSON.stringify(summary(fx, repo).aggregate), fx.cli(repo, 'check', '--ticket', 'T1').status]).map((x) => [x[0], x[2]]);
  const base = outcome();
  chmodSync(join(fx.wt3Legacy, 'T1.jsonl'), 0o000);
  chmodSync(fx.wt3Legacy, 0o000);
  t.after(() => { try { chmodSync(fx.wt3Legacy, 0o700); chmodSync(join(fx.wt3Legacy, 'T1.jsonl'), 0o600); } catch { /* gone */ } });
  assert.deepEqual(outcome(), base);
  chmodSync(fx.wt3Legacy, 0o700);
});

// ======================================================================= review repair 6
test('repair 6 (1) abandon needs run R IN the own archive and refuses a run that completed in the shared log', (t) => {
  const fx = three(t);
  seed(fx.wt3Legacy, [{ ...legacyRow('start', 'o', '2026-01-01T00:00:00.000Z'), run_id: 'other' }]);
  for (const [cmd, outcome] of [['start'], ['end', 'complete']]) {
    assert.equal(fx.cli(fx.main, cmd, '--ticket', 'T1', '--run-id', 'live', '--kind', 'workflow', '--name', 'ship_ticket', '--event-id', 'wf', ...(outcome ? ['--outcome', outcome] : [])).status, 0);
  }
  for (const [cmd, outcome] of [['start'], ['end', 'fail']]) {
    assert.equal(fx.cli(fx.main, cmd, '--ticket', 'T1', '--run-id', 'A', '--kind', 'workflow', '--name', 'ship_ticket', '--event-id', 'wf', ...(outcome ? ['--outcome', outcome] : [])).status, 0);
  }
  const before = readFileSync(join(fx.common, 'T1.jsonl'));
  const notMine = fx.cli(fx.wt3, 'abandon', '--ticket', 'T1', '--run-id', 'live');
  assert.equal(notMine.status, 1);
  assert.match(notMine.stderr, /does not occur in this worktree's pre-S5 log/);
  assert.equal(fx.cli(fx.wt3, 'abandon', '--ticket', 'T1', '--run-id', 'A').status, 1, "A's failed run cannot be relabelled from an unrelated archive");
  assert.deepEqual(readFileSync(join(fx.common, 'T1.jsonl')), before, 'nothing written');
  // even with the run in the own archive, a run that COMPLETED in the shared log is never abandoned
  seed(fx.wt2Legacy, [{ ...legacyRow('start', 'p', '2026-01-01T00:00:00.000Z'), run_id: 'live' }]);
  const done = fx.cli(fx.wt2, 'abandon', '--ticket', 'T1', '--run-id', 'live');
  assert.equal(done.status, 1);
  assert.match(done.stderr, /completed in the shared log/);
  // a directory named T1.jsonl never authorises abandon
  rmSync(join(fx.wt3Legacy, 'T1.jsonl'));
  mkdirSync(join(fx.wt3Legacy, 'T1.jsonl'));
  assert.match(fx.cli(fx.wt3, 'abandon', '--ticket', 'T1', '--run-id', 'other').stderr, /not_regular|no pre-S5 log|not a regular/);
  assert.deepEqual(readFileSync(join(fx.common, 'T1.jsonl')), before);
  const s = summary(fx, fx.main);
  assert.deepEqual(s.runs.map((r) => [r.run_id, r.outcome]).sort(), [['A', 'fail'], ['live', 'complete']]);
});

test('repair 6 (3) no reader falls back to the per-worktree log when the shared directory cannot be resolved (fault-injected git)', { skip: process.platform === 'win32' && 'POSIX shim' }, (t) => {
  const fx = three(t);
  seed(fx.wt2Legacy, [legacyRow('start', 'old', '2026-01-01T00:00:00.000Z'), legacyRow('end', 'old', '2026-01-01T00:00:01.000Z')]);
  const shim = join(fx.base, 'shim');
  mkdirSync(shim);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--git-common-dir" ] && { echo "fatal: injected" >&2; exit 128; }; done\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shim, 'git'), 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
  const ev = spawnSync(process.execPath, [EVAL, 'report', '--repo', fx.wt2, '--ticket', 'T1'], { encoding: 'utf8', env });
  assert.equal(ev.status, 0, ev.stderr);
  const out = JSON.parse(ev.stdout);
  assert.deepEqual(out.runs, [], 'no legacy row becomes a figure');
  assert.ok((out.degraded ?? []).some((d) => d.code === 'shared_log_unavailable'), JSON.stringify(out.degraded));
  for (const args of [['summary', '--ticket', 'T1'], ['check', '--ticket', 'T1']]) {
    const r = spawnSync(process.execPath, [RUN_LOG, ...args, '--repo', fx.wt2], { encoding: 'utf8', env });
    assert.equal(r.status, 1, `${args[0]} refuses instead of reading the archive: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /"old"/);
  }
  const integ = spawnSync(process.execPath, ['--input-type=module', '-e', `import { integritySummary } from ${JSON.stringify(new URL('../run-log.mjs', import.meta.url).href)}; process.stdout.write(JSON.stringify(integritySummary(${JSON.stringify(fx.wt2)}, 'T1')));`], { encoding: 'utf8', env });
  assert.ok(JSON.parse(integ.stdout).unavailable, integ.stdout);
});

test('repair 6 (4) an unreadable archive directory is reported unavailable (with errno), never an empty listing', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'root or win32' }, (t) => {
  const fx = three(t);
  seed(fx.wt2Legacy, [legacyRow('start', 'old', '2026-01-01T00:00:00.000Z')]);
  chmodSync(fx.wt2Legacy, 0o000);
  t.after(() => { try { chmodSync(fx.wt2Legacy, 0o700); } catch { /* gone */ } });
  const all = JSON.parse(fx.cli(fx.wt2, 'summary', '--all').stdout);
  const one = JSON.parse(fx.cli(fx.wt2, 'summary', '--ticket', 'T1').stdout);
  const audit = JSON.parse(fx.cli(fx.wt2, 'legacy').stdout);
  chmodSync(fx.wt2Legacy, 0o700);
  assert.deepEqual([all.legacy_present?.lines, all.legacy_present?.errno], ['unavailable', 'EACCES'], JSON.stringify(all.legacy_present));
  assert.deepEqual([one.legacy_present?.lines, one.legacy_present?.errno], ['unavailable', 'EACCES']);
  assert.deepEqual([audit.status, audit.errno], ['unavailable', 'EACCES'], JSON.stringify(audit));
});

test('repair 6 (5) the legacy audit uses the safe read: no symlink follow, no FIFO block, a bounded size reported as truncated', { skip: process.platform === 'win32' && 'POSIX file types' }, (t) => {
  const fx = three(t);
  const p = join(fx.wt2Legacy, 'T1.jsonl');
  mkdirSync(fx.wt2Legacy, { recursive: true });
  writeFileSync(join(fx.base, 'target.jsonl'), JSON.stringify(legacyRow('start', 'x', '2026-01-01T00:00:00.000Z')) + '\n');
  symlinkSync(join(fx.base, 'target.jsonl'), p);
  const sym = JSON.parse(fx.cli(fx.wt2, 'legacy', '--ticket', 'T1').stdout).tickets[0];
  assert.deepEqual([sym.status, sym.errno, sym.rows], ['unavailable', 'not_regular', undefined], 'a symlink is never followed');
  rmSync(p);
  spawnSync('mkfifo', [p]);
  const fifo = spawnSync(process.execPath, [RUN_LOG, 'legacy', '--ticket', 'T1', '--repo', fx.wt2], { encoding: 'utf8', timeout: 10000 });
  assert.equal(fifo.error, undefined, 'never blocks on a FIFO');
  assert.equal(JSON.parse(fifo.stdout).tickets[0].errno, 'not_regular');
  rmSync(p);
  writeFileSync(p, Buffer.alloc(65 * 1024 * 1024, 0x61)); // one 65 MiB line: over the limit, and the printed output stays small
  const big = JSON.parse(fx.cli(fx.wt2, 'legacy', '--ticket', 'T1').stdout).tickets[0];
  assert.equal(big.truncated, true, 'over the limit: reported, not silently read');
  assert.equal(big.bytes_read, 64 * 1024 * 1024);
});

test('repair 6 (6) AC15 also binds event and close: a legacy-abandoned event id is refused in any case', (t) => {
  const fx = three(t);
  for (const id of ['legacy-abandoned.0123456789ab', 'LEGACY-ABANDONED.0123456789AB', 'Legacy-Abandoned']) {
    const r = fx.cli(fx.main, 'event', '--ticket', 'T1', '--run-id', 'run-1', '--name', 'host_sleep', '--event-id', id, '--metric', 'label=measured');
    assert.equal(r.status, 1, id);
    assert.match(r.stderr, /reserved/);
  }
  assert.equal(existsSync(join(fx.common, 'T1.jsonl')), false);
});

// ======================================================================= review repair 7
const spawnRunLog = (repo, ...args) => new Promise((done) => {
  const child = spawnAsync(process.execPath, [RUN_LOG, ...args, '--repo', repo]);
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => done({ status, out, err }));
});
const sharedStart = (fx, repo, run, outcome) => {
  for (const [cmd, o] of [['start'], ['end', outcome]]) {
    if (cmd === 'end' && !outcome) break;
    assert.equal(fx.cli(repo, cmd, '--ticket', 'T1', '--run-id', run, '--kind', 'workflow', '--name', 'ship_ticket', '--event-id', 'wf', ...(o ? ['--outcome', o] : [])).status, 0);
  }
};
test('repair 7 (3)(4)(6) abandon needs a VALID legacy START row of exactly run R for this ticket', (t) => {
  const fx = three(t);
  sharedStart(fx, fx.main, 'live');
  const before = () => readFileSync(join(fx.common, 'T1.jsonl'));
  const b = before();
  const tryWith = (lines) => { seed(fx.wt3Legacy, []); writeFileSync(join(fx.wt3Legacy, 'T1.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); return fx.cli(fx.wt3, 'abandon', '--ticket', 'T1', '--run-id', 'live'); };
  const start = { ...legacyRow('start', 'p', '2026-01-01T00:00:00.000Z'), run_id: 'live' };
  for (const [why, lines] of [
    ['a bare run_id object', [{ run_id: 'live' }]],
    ['a T2 row misplaced in T1', [{ ...start, ticket: 'T2' }]],
    ['an end row only', [{ ...legacyRow('end', 'p', '2026-01-01T00:00:01.000Z'), run_id: 'live' }]],
    ['another schema', [{ ...start, schema: 'other-v9' }]],
    ['run id only in a metric', [{ ...start, run_id: 'x', metrics: { run_id: 'live', note: 'live' } }]],
    ['a longer id sharing the substring', [{ ...start, run_id: 'live2' }]],
    ['a shorter id', [{ ...start, run_id: 'liv' }]],
  ]) {
    const r = tryWith(lines);
    assert.equal(r.status, 1, `${why}: refused`);
    assert.deepEqual(before(), b, `${why}: nothing written`);
  }
  const spaced = tryWith(['{ "schema" : "ship-ticket-run-log-v1", "ticket": "T1", "run_id" :"live", "event": "start", "event_id": "p", "kind": "phase", "name": "Pp", "timestamp": "2026-01-01T00:00:00.000Z", "metrics": {} }']);
  assert.equal(spaced.status, 0, `a valid start whose JSON spacing defeats a substring prefilter is found: ${spaced.stderr}`);
});

test('repair 7 (2) a completion committed while abandon waits for the lock refuses the abandon (checked inside the lock)', async (t) => {
  const fx = three(t);
  sharedStart(fx, fx.main, 'live');
  seed(fx.wt3Legacy, [{ ...legacyRow('start', 'p', '2026-01-01T00:00:00.000Z'), run_id: 'live' }]);
  const log = join(fx.common, 'T1.jsonl');
  writeFileSync(`${log}.lock`, JSON.stringify({ pid: process.pid, process_start_time: null, host: (await import('node:os')).hostname(), run_id: 'x', nonce: 'held' }));
  t.after(() => rmSync(`${log}.lock`, { force: true }));
  const waiting = spawnRunLog(fx.wt3, 'abandon', '--ticket', 'T1', '--run-id', 'live');
  await new Promise((r) => setTimeout(r, 800)); // abandon passed its pre-lock checks and waits for the lock
  const startRow = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find((r) => r.run_id === 'live' && r.event === 'start');
  // the completion is stamped BEFORE abandon's own stamp (Codex's interleaving: the timestamp guard alone would accept it)
  const at = new Date(Date.parse(startRow.timestamp) + 1).toISOString();
  writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ ...startRow, event: 'end', timestamp: at, duration_ms: Date.parse(at) - Date.parse(startRow.timestamp), outcome: 'complete' }) + '\n');
  rmSync(`${log}.lock`, { force: true });
  const r = await waiting;
  assert.equal(r.status, 1, r.out);
  assert.match(r.err, /completed in the shared log/);
  assert.equal(readFileSync(log, 'utf8').includes('legacy_abandoned'), false, 'nothing written');
  assert.equal(summary(fx, fx.main).runs[0].outcome, 'complete');
});

test('repair 7 (5) an inaccessible shared directory is unavailable with errno in every reader, never an empty result', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'root or win32' }, async (t) => {
  const fx = three(t);
  sharedStart(fx, fx.main, 'live', 'complete');
  chmodSync(fx.common, 0o000);
  t.after(() => { try { chmodSync(fx.common, 0o700); } catch { /* gone */ } });
  const one = fx.cli(fx.main, 'summary', '--ticket', 'T1');
  const all = fx.cli(fx.main, 'summary', '--all');
  const ev = spawnSync(process.execPath, [EVAL, 'report', '--repo', fx.main, '--ticket', 'T1'], { encoding: 'utf8' });
  const evAll = spawnSync(process.execPath, [EVAL, 'report', '--repo', fx.main, '--all'], { encoding: 'utf8' });
  const { integritySummary } = await import('../run-log.mjs');
  const integ = integritySummary(fx.main, 'T1');
  const { lostSignal } = await import('../eval.mjs');
  const lost = lostSignal(fx.common, 'T1');
  chmodSync(fx.common, 0o700);
  for (const [what, r] of [['summary --ticket', one], ['summary --all', all]]) {
    assert.equal(r.status, 1, `${what}: ${r.stdout}`);
    assert.match(r.stderr, /EACCES/);
  }
  for (const [what, r] of [['eval --ticket', ev], ['eval --all', evAll]]) {
    const out = JSON.parse(r.stdout);
    assert.ok((out.degraded ?? []).some((d) => d.code === 'shared_log_unavailable' && d.errno === 'EACCES'), `${what}: ${JSON.stringify(out.degraded)}`);
    assert.deepEqual(out.runs, []);
  }
  assert.match(integ.unavailable ?? '', /EACCES/);
  assert.equal(lost.log_unreadable, 'EACCES');
});

test('repair 8 (2) eval: an unreadable shared T1.jsonl (mode 000) is degraded shared_log_unavailable, never a crash', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'root or win32' }, (t) => {
  const fx = three(t);
  sharedStart(fx, fx.main, 'live', 'complete');
  const log = join(fx.common, 'T1.jsonl');
  chmodSync(log, 0o000);
  t.after(() => { try { chmodSync(log, 0o600); } catch { /* gone */ } });
  for (const sel of [['--ticket', 'T1'], ['--all']]) {
    const r = spawnSync(process.execPath, [EVAL, 'report', '--repo', fx.main, ...sel], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${sel}: ${r.stderr.slice(0, 200)}`);
    const out = JSON.parse(r.stdout);
    assert.ok((out.degraded ?? []).some((d) => d.code === 'shared_log_unavailable' && d.errno === 'EACCES'), JSON.stringify(out.degraded));
    assert.deepEqual(out.runs, []);
  }
});

test('repair 8 (2b) eval: an inaccessible shared log with readable engine state yields no synthetic run, only the degradation', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'root or win32' }, (t) => {
  const fx = three(t);
  sharedStart(fx, fx.main, 'live', 'complete');
  mkdirSync(fx.wt2Legacy, { recursive: true });
  writeFileSync(join(fx.wt2Legacy, 'T1.state.json'), JSON.stringify({ run_id: 'run-9' }));
  for (const mode of ['dir', 'file']) {
    const target = mode === 'dir' ? fx.common : join(fx.common, 'T1.jsonl');
    chmodSync(target, 0o000);
    let r;
    try { r = spawnSync(process.execPath, [EVAL, 'report', '--repo', fx.wt2, '--ticket', 'T1'], { encoding: 'utf8' }); } finally { chmodSync(target, mode === 'dir' ? 0o700 : 0o600); }
    assert.equal(r.status, 0, `${mode}: ${r.stderr.slice(0, 200)}`);
    const out = JSON.parse(r.stdout);
    assert.ok((out.degraded ?? []).some((d) => d.code === 'shared_log_unavailable'), `${mode}: ${JSON.stringify(out.degraded)}`);
    assert.deepEqual(out.runs, [], `${mode}: no empty synthetic run from the engine state`);
  }
});
