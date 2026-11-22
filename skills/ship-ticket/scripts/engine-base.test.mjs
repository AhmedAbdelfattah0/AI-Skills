/**
 * S-12 (ASTF-6): the ported base check (engine-base.mjs, from a890b0d) and the remote helpers (remote-identity.mjs), on temp
 * git repos with a bare file:// origin. No engine run: the engine wiring is run-engine-base.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBase, authGit, BASE_CODES } from './engine-base.mjs';
import { remoteIdentity, resolveBaseRef, repositoryOf, sameRepository } from './remote-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** repo (branch main, one commit) + bare origin + a pusher clone. */
function repos(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-base-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const repo = join(root, 'repo'), origin = join(root, 'origin.git'), up = join(root, 'up');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'branch', '-M', 'main');
  git(root, 'clone', '-q', '--bare', repo, origin);
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'fetch', '-q', 'origin');
  git(root, 'clone', '-q', '--branch', 'main', origin, up);
  let n = 0;
  const push = () => { writeFileSync(join(up, `u${++n}.txt`), String(n)); git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', `u${n}`); git(up, 'push', '-q', 'origin', 'HEAD:main'); return git(up, 'rev-parse', 'HEAD'); };
  return { root, repo, origin, up, push, g: (...a) => git(repo, ...a) };
}

test('provenance: every line after the 5-line header is the a890b0d blob 2ea46c7, byte for byte', () => {
  const body = readFileSync(join(HERE, 'engine-base.mjs'), 'utf8').replace(/\r\n/g, '\n').split('\n').slice(5).join('\n');
  const r = spawnSync('git', ['hash-object', '--stdin'], { input: body, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '2ea46c719fa62ce350784a8e91185e79e5195857');
  assert.deepEqual([...BASE_CODES], ['base_unverified', 'base_remote_unavailable', 'base_moved_local', 'base_moved_remote']);
});

test('verifyBase: the remote head, its merge base with HEAD, the recorded sha kept', (t) => {
  const r = repos(t);
  const head = r.g('rev-parse', 'HEAD');
  const v = verifyBase(r.repo, { ref: 'main', remote: 'origin' });
  assert.deepEqual(v, { ok: true, base: { ref: 'main', remote: 'origin', identity: null, sha: head, remote_head: head, merge_base: head } });
  const tip = r.push(); r.g('fetch', '-q', 'origin');
  const w = verifyBase(r.repo, { ref: 'main', remote: 'origin', recorded: v.base });
  assert.equal(w.ok, true);
  assert.deepEqual([w.base.sha, w.base.remote_head, w.base.merge_base], [head, tip, head], 'advanced: accepted, the merge base is unchanged');
});

test('verifyBase refusals: offline, no such branch, not fetched, rewound, no shared history, local merge base', (t) => {
  const r = repos(t);
  const pinned = verifyBase(r.repo, { ref: 'main', remote: 'origin' }).base;
  assert.equal(verifyBase(r.repo, { ref: 'trunk', remote: 'origin' }).code, 'base_remote_unavailable');
  r.push();
  const unfetched = verifyBase(r.repo, { ref: 'main', remote: 'origin' });
  assert.equal(unfetched.code, 'base_remote_unavailable');
  assert.match(unfetched.reasons[0], /fetch it/);
  r.g('fetch', '-q', 'origin');
  const advanced = verifyBase(r.repo, { ref: 'main', remote: 'origin', recorded: pinned });
  assert.equal(advanced.ok, true);
  // rewind origin below a recorded head
  const recorded = { ...pinned, sha: advanced.base.remote_head };
  spawnSync('git', ['push', '-q', '--force', 'origin', `${pinned.sha}:refs/heads/main`], { cwd: r.up });
  assert.equal(verifyBase(r.repo, { ref: 'main', remote: 'origin', recorded }).code, 'base_moved_remote');
  assert.equal(verifyBase(r.repo, { ref: 'main', remote: 'origin', localMergeBase: 'f'.repeat(40) }).code, 'base_moved_local');
  // no shared history: an orphan HEAD
  r.g('checkout', '-q', '--orphan', 'lonely'); r.g('commit', '-q', '--allow-empty', '-m', 'orphan');
  assert.equal(verifyBase(r.repo, { ref: 'main', remote: 'origin' }).code, 'base_unverified');
  renameSync(r.origin, r.origin + '.away');
  assert.equal(verifyBase(r.repo, { ref: 'main', remote: 'origin' }).code, 'base_remote_unavailable');
});

test('authGit turns replacement objects off: a `git replace` never changes what it reads', (t) => {
  const r = repos(t);
  const x = r.g('rev-parse', 'HEAD');
  writeFileSync(join(r.repo, 'b.txt'), 'b'); r.g('add', '-A'); r.g('commit', '-q', '-m', 'y');
  const y = r.g('rev-parse', 'HEAD');
  r.g('replace', x, y);
  assert.equal(r.g('rev-parse', `${x}^{tree}`), r.g('rev-parse', `${y}^{tree}`), 'plain git follows the replacement');
  const a = authGit(r.repo, ['rev-parse', `${x}^{tree}`]);
  assert.equal(a.status, 0, a.stderr);
  assert.notEqual(a.stdout.trim(), r.g('rev-parse', `${y}^{tree}`), 'authGit reads the original object');
});

test('remoteIdentity: one URL ok (a local path names no repository); several fetch or push URLs, or a foreign push URL, are remote_ambiguous', (t) => {
  const r = repos(t);
  assert.deepEqual(remoteIdentity(r.repo, 'origin'), { ok: true, identity: null });
  r.g('config', 'remote.origin.url', 'git@github.com:Acme/App.git');
  assert.deepEqual(remoteIdentity(r.repo, 'origin').identity, { remote_name: 'origin', url: 'git@github.com:Acme/App.git', host: 'github.com', owner: 'Acme', repo: 'App', slug: 'github.com/Acme/App' });
  r.g('config', 'remote.origin.pushurl', 'https://github.com/acme/app.git');
  assert.equal(remoteIdentity(r.repo, 'origin').ok, true, 'a push URL of the same repository (case-insensitive) is fine');
  r.g('config', 'remote.origin.pushurl', 'https://github.com/evil/app.git');
  assert.equal(remoteIdentity(r.repo, 'origin').code, 'remote_ambiguous');
  r.g('config', '--unset-all', 'remote.origin.pushurl');
  r.g('config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/app.git');
  r.g('config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/app2.git');
  assert.match(remoteIdentity(r.repo, 'origin').reasons[0], /2 push URLs/);
  r.g('config', '--unset-all', 'remote.origin.pushurl');
  r.g('config', '--add', 'remote.origin.url', r.origin);
  const two = remoteIdentity(r.repo, 'origin');
  assert.equal(two.code, 'remote_ambiguous');
  assert.match(two.reasons[0], /2 fetch URLs/);
  assert.deepEqual(remoteIdentity(r.repo, 'nosuch'), { ok: true, identity: null }, 'an unconfigured remote has no identity (ls-remote then refuses)');
});

test('repositoryOf and sameRepository: GitHub URL forms; paths and malformed URLs name none', () => {
  for (const u of ['https://github.com/o/r.git', 'https://github.com/o/r', 'ssh://git@github.com:22/o/r.git', 'git@github.com:o/r.git', 'github.com:o/r'])
    assert.equal(repositoryOf(u)?.slug, 'github.com/o/r', u);
  for (const u of ['/tmp/origin.git', 'C:\\repo\\x', 'file:///tmp/x.git', 'https://github.com/o', '', null, 'https://github.com/o/r b']) assert.equal(repositoryOf(u), null, String(u));
  assert.equal(sameRepository(repositoryOf('https://github.com/O/R'), repositoryOf('git@github.com:o/r.git')), true);
  assert.equal(sameRepository(null, repositoryOf('git@github.com:o/r.git')), false);
});

test('resolveBaseRef: config.base when it names a branch, else the remote default branch; refuses when unreachable or no default', (t) => {
  const r = repos(t);
  assert.deepEqual(resolveBaseRef({ config: { base: 'release' } }, r.repo, 'origin'), { ok: true, ref: 'release' });
  assert.deepEqual(resolveBaseRef({ config: { base: 'HEAD' } }, r.repo, 'origin'), { ok: true, ref: 'main' });
  assert.deepEqual(resolveBaseRef({ config: {} }, r.repo, 'origin'), { ok: true, ref: 'main' });
  spawnSync('git', ['--git-dir', r.origin, 'symbolic-ref', 'HEAD', 'refs/heads/nowhere']);
  assert.equal(resolveBaseRef({ config: {} }, r.repo, 'origin').code, 'base_remote_unavailable');
  renameSync(r.origin, r.origin + '.away');
  assert.equal(resolveBaseRef({ config: {} }, r.repo, 'origin').code, 'base_remote_unavailable');
});
