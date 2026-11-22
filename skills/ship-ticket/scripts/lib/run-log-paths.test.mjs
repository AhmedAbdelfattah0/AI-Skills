// S5 (F05): run logs live in ONE place per repository (git-common-dir), are read from it or from the old per-worktree
// path, and no event is split or lost across linked worktrees. Safe on windows-latest: paths are compared through
// realpathSync.native, git identities are passed per command, and nothing here needs a POSIX shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn as spawnAsync } from 'node:child_process';
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
  assert.deepEqual(common.map((row) => row.event), ['start', 'end'], 'S5 repair: the legacy start is migrated with its end');
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

// ---- S5 repair (2): legacy interval migration, so removing a worktree never leaves an orphan end in the shared log.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** origin/main's run-log.mjs (the pre-S5 writer) extracted to a temp tree; null when origin/main or tar is unavailable. */
function preS5Writer(t) {
  if (process.platform === 'win32') return null;
  const tar = spawnSync('git', ['-C', REPO_ROOT, 'archive', 'origin/main', 'skills/ship-ticket/scripts'], { maxBuffer: 256 * 1024 * 1024 });
  if (tar.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), 's5-old-writer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout }).status !== 0) return null;
  const script = join(dir, 'skills', 'ship-ticket', 'scripts', 'run-log.mjs');
  return existsSync(script) ? script : null;
}
function seedLegacyStart(t, fx, repo, legacyDir, id, ts) {
  const old = preS5Writer(t);
  if (old) {
    const r = spawnSync(process.execPath, [old, ...iv('start', id), '--repo', repo], { encoding: 'utf8' });
    assert.equal(r.status, 0, `pre-S5 writer: ${r.stderr}`);
    assert.ok(existsSync(join(legacyDir, 'T1.jsonl')), 'the pre-S5 writer wrote the per-worktree log');
    return 'origin/main writer';
  }
  seed(legacyDir, [legacyRow('start', id, ts)]);
  return 'hand-seeded';
}

test('S5 migration: a start in a worktree legacy log, ended by S5, survives `git worktree remove`: later writes, check and summary are healthy', (t) => {
  const fx = worktrees(t);
  git(fx.main, 'worktree', 'add', '-q', join(fx.base, 'wt3'));
  const wt3 = join(fx.base, 'wt3'), wt3Legacy = join(fx.main, '.git', 'worktrees', 'wt3', 'ai-skills', 'ship-ticket');
  seedLegacyStart(t, fx, wt3, wt3Legacy, 'a', new Date(Date.now() - 60000).toISOString());
  const legacyBytes = readFileSync(join(wt3Legacy, 'T1.jsonl'));
  const e = fx.cli(wt3, ...iv('end', 'a', ['--outcome', 'pass']));
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(readFileSync(join(wt3Legacy, 'T1.jsonl')), legacyBytes, 'the legacy log is never written');
  const shared = readFileSync(join(fx.common, 'T1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(shared.map((r) => `${r.event}:${r.event_id}`), ['start:a', 'end:a'], 'the start was copied verbatim before its end');
  assert.equal(JSON.stringify(shared[0]) + '\n', legacyBytes.toString('utf8'), 'verbatim copy of the legacy start');
  assert.deepEqual(summary(fx, wt3).integrity_warnings, [], 'the migrated copy is not a duplicate of itself');
  git(fx.main, 'worktree', 'remove', '--force', wt3);
  assert.equal(existsSync(wt3Legacy), false, 'the legacy log went with the worktree');
  for (const args of [iv('start', 'b'), iv('end', 'b'), ['event', '--ticket', 'T1', '--run-id', 'run-1', '--name', 'host_sleep', '--event-id', 'sl', '--metric', 'label=measured']]) {
    const r = fx.cli(fx.main, ...args);
    assert.equal(r.status, 0, `${args[0]} after the removal: ${r.stderr}`);
  }
  const c = fx.cli(fx.main, 'check', '--ticket', 'T1');
  assert.equal(c.status, 0, c.stdout);
  assert.deepEqual(intervals(summary(fx, fx.main)), ['a', 'b']);
});

test('S5 migrate: copies the own legacy log (open starts and closed pairs) verbatim, idempotently; writes nothing else', (t) => {
  const fx = worktrees(t);
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const [t3, t2, t1] = [ago(30), ago(20), ago(10)];
  seed(fx.wt2Legacy, [legacyRow('start', 'c', t3), legacyRow('end', 'c', t3), legacyRow('start', 'o', t2)]);
  const legacyBytes = readFileSync(join(fx.wt2Legacy, 'T1.jsonl'));
  const m = fx.cli(fx.wt2, 'migrate', '--ticket', 'T1');
  assert.equal(m.status, 0, m.stderr);
  assert.deepEqual(JSON.parse(m.stdout.trim()), { migrated: 3, skipped_events: 0 });
  assert.equal(readFileSync(join(fx.common, 'T1.jsonl'), 'utf8'), legacyBytes.toString('utf8'), 'verbatim, in file order');
  const again = fx.cli(fx.wt2, 'migrate', '--ticket', 'T1');
  assert.deepEqual(JSON.parse(again.stdout.trim()), { migrated: 0, skipped_events: 0 }, 'idempotent');
  assert.deepEqual(readFileSync(join(fx.wt2Legacy, 'T1.jsonl')), legacyBytes);
  assert.equal(fx.cli(fx.wt2, ...iv('end', 'o', ['--ended-at', t1])).status, 0, 'the migrated open start can be ended');
  git(fx.main, 'worktree', 'remove', '--force', fx.wt2);
  const s = summary(fx, fx.main);
  assert.deepEqual(intervals(s), ['c', 'o']);
  assert.deepEqual(s.integrity_warnings, []);
  const none = fx.cli(fx.main, 'migrate', '--ticket', 'T1');
  assert.deepEqual(JSON.parse(none.stdout.trim()), { migrated: 0, skipped_events: 0 }, 'the main checkout has no separate legacy log');
});

// ---- S5 review repair 2
test('S5 repair 2 (1) reserved ticket names are refused case-insensitively (pure rule)', async () => {
  const { isReservedTicket } = await import('./run-log-paths.mjs');
  assert.equal(typeof isReservedTicket, 'function');
  for (const n of ['T.engine', 'T.ENGINE', 'T.review-auth', 'T.REVIEW-AUTH', 'T.Review-Auth', 'review-auth', 'REVIEW-AUTH', 'excluded', 'EXCLUDED']) assert.equal(isReservedTicket(n), true, n);
  for (const n of ['T', 'T-1', 'review', 'engine', 'auth.T', 'T.review']) assert.equal(isReservedTicket(n), false, n);
});

const spawnRunLog = (repo, ...args) => new Promise((done) => {
  const child = spawnAsync(process.execPath, [RUN_LOG, ...args, '--repo', repo]);
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => done({ status, out, err }));
});
const sharedRows = (fx) => readFileSync(join(fx.common, 'T1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const copies = (rows, id, event = 'start') => rows.filter((r) => r.event_id === id && r.event === event).length;

test('S5 repair 2 (2) concurrent migrate/migrate and migrate/end-time migration leave exactly ONE verbatim copy', async (t) => {
  for (let round = 0; round < 4; round += 1) {
    const fx = worktrees(t);
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
    const [ta, tb] = [ago(30), ago(20)];
    seed(fx.wt2Legacy, [legacyRow('start', 'a', ta), legacyRow('start', 'b', tb)]);
    const results = await Promise.all(round % 2 === 0
      ? [spawnRunLog(fx.wt2, 'migrate', '--ticket', 'T1'), spawnRunLog(fx.wt2, 'migrate', '--ticket', 'T1')]
      : [spawnRunLog(fx.wt2, 'migrate', '--ticket', 'T1'), spawnRunLog(fx.wt2, ...iv('end', 'a'))]);
    for (const r of results) assert.equal(r.status, 0, r.err);
    const rows = sharedRows(fx);
    assert.equal(copies(rows, 'a'), 1, `round ${round}: one copy of start a`);
    assert.equal(copies(rows, 'b'), 1, `round ${round}: one copy of start b`);
    assert.deepEqual(summary(fx, fx.wt2).integrity_warnings, [], `round ${round}`);
  }
});

test('S5 repair 2 (2) a verbatim row written TWICE to the shared log is a duplicate, even when a legacy copy exists', (t) => {
  const fx = worktrees(t);
  const row = legacyRow('start', 'a', new Date(Date.now() - 1000).toISOString());
  seed(fx.wt2Legacy, [row]);
  seed(fx.common, [row, row]);
  const s = summary(fx, fx.wt2);
  assert.ok(s.integrity_warnings.some((w) => w.code === 'duplicate_start'), JSON.stringify(s.integrity_warnings));
  assert.match(fx.cli(fx.wt2, ...iv('start', 'z')).stderr, /duplicate_start/, 'writers refuse it too');
});

test("S5 repair 2 (5) N1: a legacy start colliding with another worktree's start of the same id is recoverable from the affected worktree, keeping all evidence", (t) => {
  const fx = worktrees(t);
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  seed(fx.wt2Legacy, [legacyRow('start', 'a', ago(60))]);
  const legacyBytes = readFileSync(join(fx.wt2Legacy, 'T1.jsonl'));
  assert.equal(fx.cli(fx.main, ...iv('start', 'a')).status, 0, 'the same run and event id started from the main checkout after the upgrade');
  const locked = fx.cli(fx.wt2, ...iv('start', 'z'));
  assert.equal(locked.status, 1, 'wt2 is locked out by duplicate_start');
  const plain = fx.cli(fx.wt2, 'migrate', '--ticket', 'T1');
  assert.equal(plain.status, 1, 'plain migrate refuses to copy a conflicting start');
  const r = fx.cli(fx.wt2, 'migrate', '--ticket', 'T1', '--resolve-duplicates');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).excluded, 1);
  assert.deepEqual(readFileSync(join(fx.wt2Legacy, 'T1.jsonl')), legacyBytes, 'the legacy log is never changed');
  const excluded = readFileSync(join(fx.wt2Legacy, 'excluded', 'T1.jsonl'), 'utf8');
  assert.equal(excluded, legacyBytes.toString('utf8'), 'the excluded row is recorded verbatim');
  assert.equal(fx.cli(fx.wt2, ...iv('start', 'z')).status, 0, 'wt2 can write again');
  assert.equal(fx.cli(fx.wt2, ...iv('end', 'a')).status, 0, 'and end the shared start a');
  assert.deepEqual(summary(fx, fx.main).integrity_warnings, []);
  const again = fx.cli(fx.wt2, 'migrate', '--ticket', 'T1', '--resolve-duplicates');
  assert.equal(JSON.parse(again.stdout.trim()).excluded, 0, 'idempotent');
});
