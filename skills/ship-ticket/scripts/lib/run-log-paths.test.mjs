// S5 (F05): run logs live in ONE place per repository (git-common-dir), are read from it or from the old per-worktree
// path, and no event is split or lost across linked worktrees. Safe on windows-latest: paths are compared through
// realpathSync.native, git identities are passed per command, and nothing here needs a POSIX shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commonLogDir, legacyLogDirs, ownLogDir, readLogRows } from './run-log-paths.mjs';

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

test('legacyLogDirs: own legacy only when it differs from common; siblings only on request (reporting)', (t) => {
  const fx = worktrees(t);
  mkdirSync(fx.common, { recursive: true });
  mkdirSync(fx.wt2Legacy, { recursive: true });
  assert.deepEqual(legacyLogDirs(fx.main), { own: null, siblings: [] }, 'main checkout: no separate own legacy, siblings not enumerated');
  const all = legacyLogDirs(fx.main, { siblings: true });
  assert.equal(all.own, null);
  assert.deepEqual(all.siblings.map(real), [real(fx.wt2Legacy)]);
  const w = legacyLogDirs(fx.wt2, { siblings: true });
  assert.equal(real(w.own), real(fx.wt2Legacy));
  assert.deepEqual(w.siblings, [], 'a worktree is never its own sibling');
});

test('readLogRows reads common first, then own legacy, through the given parser', (t) => {
  const fx = worktrees(t);
  seed(fx.common, [legacyRow('start', 'a', '2026-01-01T00:00:00.000Z')]);
  seed(fx.wt2Legacy, [legacyRow('start', 'b', '2026-01-01T00:00:01.000Z')]);
  const seen = [];
  const out = readLogRows([commonLogDir(fx.wt2), legacyLogDirs(fx.wt2).own], 'T1', (buf, path) => { seen.push(real(path)); return buf.toString('utf8').trim().split('\n').map(JSON.parse); });
  assert.deepEqual(seen, [real(join(fx.common, 'T1.jsonl')), real(join(fx.wt2Legacy, 'T1.jsonl'))]);
  assert.deepEqual(out.map((s) => s.parsed[0].event_id), ['a', 'b']);
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

test('AC2: a start in the old per-worktree log is ended by the new version; the end lands in common; legacy bytes untouched', (t) => {
  const fx = worktrees(t);
  const startedAt = new Date(Date.now() - 60000).toISOString();
  seed(fx.wt2Legacy, [legacyRow('start', 'a', startedAt)]);
  const before = readFileSync(join(fx.wt2Legacy, 'T1.jsonl'));
  const r = fx.cli(fx.wt2, ...iv('end', 'a', ['--outcome', 'pass']));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).event, 'end');
  assert.deepEqual(readFileSync(join(fx.wt2Legacy, 'T1.jsonl')), before, 'legacy file byte-identical');
  const common = readFileSync(join(fx.common, 'T1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(common.map((row) => row.event), ['end']);
  const s = summary(fx, fx.wt2);
  assert.deepEqual(intervals(s), ['a']);
  assert.deepEqual(s.integrity_warnings, [], 'a pair split across the legacy and the common file is one valid interval');
  const again = fx.cli(fx.wt2, ...iv('start', 'c'));
  assert.equal(again.status, 0, `later writes are not refused by the split pair: ${again.stderr}`);
  assert.match(fx.cli(fx.wt2, ...iv('start', 'a')).stderr, /already exists/, 'a duplicate start is refused across files');
  // The split pair must not lock the OTHER worktrees out of the shared file: they judge pairing with every legacy log.
  const fromMain = fx.cli(fx.main, ...iv('start', 'm'));
  assert.equal(fromMain.status, 0, `the main checkout can still write: ${fromMain.stderr}`);
  const checkMain = fx.cli(fx.main, 'check', '--ticket', 'T1');
  assert.equal(checkMain.status, 0, checkMain.stdout);
  assert.deepEqual(summary(fx, fx.main).integrity_warnings, []);
});

test('event counts preserved: N legacy events over two worktrees, then M new writes: summary --all counts N, then N+M; legacy bytes identical', (t) => {
  const fx = worktrees(t);
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const [t50, t40, t30] = [ago(50), ago(40), ago(30)];
  seed(fx.common, [legacyRow('start', 'm1', t50), legacyRow('end', 'm1', t50)]); // the main checkout's old log IS common
  seed(fx.wt2Legacy, [legacyRow('start', 'w1', t40), legacyRow('end', 'w1', t40), legacyRow('start', 'w2', t30)]);
  const wtBytes = readFileSync(join(fx.wt2Legacy, 'T1.jsonl'));
  const count = (repo) => { const r = fx.cli(repo, 'summary', '--all'); assert.equal(r.status, 0, r.stderr); const s = JSON.parse(r.stdout);
    return s.runs.reduce((n, run) => n + run.intervals.length * 2 + run.open_intervals.length, 0); };
  assert.equal(count(fx.main), 5, 'summary --all from the main checkout reads the sibling legacy log for reporting');
  assert.equal(count(fx.wt2), 5);
  for (const id of ['n1', 'n2']) assert.equal(fx.cli(fx.wt2, ...iv('start', id)).status, 0);
  assert.equal(fx.cli(fx.main, ...iv('end', 'n1')).status, 0);
  assert.equal(count(fx.main), 8);
  assert.equal(count(fx.wt2), 8);
  assert.deepEqual(readFileSync(join(fx.wt2Legacy, 'T1.jsonl')), wtBytes);
});
