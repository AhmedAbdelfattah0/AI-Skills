/**
 * R0-S round 6: reviewed content == committed content == published content. The reviewer and the candidate id cover the RAW work-tree
 * bytes; `git add` stores what the repository's conversions make of them (a clean filter, core.autocrlf / eol, LFS). Before round 6 a
 * clean filter shipped other bytes than the reviewed ones with publish allowed. Now authorize publish (publish(), the pre-push hook,
 * `next`) and, cumulatively, authorize complete compare the committed HEAD with the reviewed-content manifest bound at SHIP_READY
 * (engine-enroll.mjs committedContent: plumbing only): committed_content_mismatch on any difference.
 * The first test is the round-5 report's reproduction (pre-fix outcome in its title). STRICT review policy; the REAL engine CLI on temp
 * repos with fakes only; every PR and CI answer is SIMULATED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, passReview } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';
import { committedContent } from './engine-enroll.mjs';
import { worktreeManifest } from './engine-review-dispatch.mjs';
import { candidateId } from './engine-io.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const GREEN = { checkRuns: [{ runs: [{ id: 1, name: 'test', head_sha: '$SHA', status: 'completed', conclusion: 'success', started_at: '2026-11-15T00:00:01.000Z', completed_at: '2026-11-15T00:00:09.000Z' }] }] };
const code = (r) => r.out?.code;
const body = (fx) => { const f = join(fx.root, 'pr-body.md'); writeFileSync(f, 'body'); return f; };
const publishPr = (fx) => fx.cli('publish', { 'pr-title': 'T-1: ship', 'pr-body-file': body(fx) });
const authorize = (fx, stage) => fx.cli('authorize', { stage });
const remoteBlob = (fx, path) => { const r = spawnSync('git', ['--git-dir', fx.remote, 'show', `refs/heads/T-1-work:${path}`], { encoding: 'utf8', env: fx.env }); return r.status === 0 ? r.stdout : null; };
const attributes = (fx, text) => { mkdirSync(join(fx.repo, '.git', 'info'), { recursive: true }); writeFileSync(join(fx.repo, '.git', 'info', 'attributes'), text); };

test('R6-1 [C1] (pre-fix: published EVIL while the reviewer and the candidate saw a1): a clean filter that rewrites src/a.txt at commit is committed_content_mismatch at authorize publish, publish and the pre-push hook; nothing reaches the remote', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  attributes(h, 'src/a.txt filter=swap\n');
  h.okGit(['config', '--local', 'filter.swap.clean', 'printf EVIL']);
  await h.toShipReady();
  h.commitAll();
  const a = authorize(h, 'publish');
  assert.equal(code(a), 'committed_content_mismatch', a.stdout);
  assert.match(a.out.reasons.join(' '), /src\/a\.txt/);
  const n = h.cli('next').out.next_action;
  assert.deepEqual([n.disposition, n.reason, n.owner], ['BLOCKED', 'committed_content_mismatch', 'human'], JSON.stringify(n));
  assert.match(n.reasons.join(' '), /re-freeze/);
  const p = publishPr(h);
  assert.equal(code(p), 'committed_content_mismatch', p.stdout);
  assert.equal(h.remoteHead(), null, 'nothing pushed');
  assert.equal(spawnSync(process.execPath, [GUARD, 'install', '--repo', h.repo], { encoding: 'utf8', env: h.env }).status, 0);
  const push = spawnSync('git', ['push', 'origin', 'T-1-work'], { cwd: h.repo, encoding: 'utf8', env: h.env });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /committed_content_mismatch/);
  assert.equal(remoteBlob(h, 'src/a.txt'), null);
});

test('R6-2 [C1] core.autocrlf=true turning a reviewed CRLF file into LF at commit is committed_content_mismatch (fail closed: a repository relying on eol conversion is refused)', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  writeFileSync(join(h.repo, 'src', 'crlf.txt'), 'one\r\ntwo\r\n');
  h.okGit(['config', '--local', 'core.autocrlf', 'true']);
  await h.toShipReady();
  h.commitAll();
  const a = authorize(h, 'publish');
  assert.equal(code(a), 'committed_content_mismatch', a.stdout);
  assert.match(a.out.reasons.join(' '), /src\/crlf\.txt/);
});

test('R6-3 legitimate: a smudge-only filter (no clean side), a symlink, a mode-only change, a deletion, an untracked file added, and a new submodule all publish, pass CI and complete (no false block)', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  // a base commit A carrying docs/gone.txt and docs/mode.txt, pushed as the remote default branch (the merge base)
  writeFileSync(join(h.repo, 'docs', 'gone.txt'), 'to be deleted\n');
  writeFileSync(join(h.repo, 'docs', 'mode.txt'), 'mode only\n');
  h.okGit(['add', 'docs']); h.okGit(['commit', '-q', '-m', 'A']);
  h.okGit(['push', '-q', 'origin', `HEAD:refs/heads/${h.defaultBranch}`]);
  assert.equal(h.cli('init', { dag: h.dagFile }).status, 0);
  assert.equal(h.cli('drive').status, 0);
  // after the build (outside node writes, before the review): the candidate the reviewers see
  attributes(h, 'src/sm.txt filter=sm\n');
  h.okGit(['config', '--local', 'filter.sm.smudge', 'cat']);
  writeFileSync(join(h.repo, 'src', 'sm.txt'), 'smudged side only\n');
  symlinkSync('a.txt', join(h.repo, 'src', 'link'));
  chmodSync(join(h.repo, 'docs', 'mode.txt'), 0o755);
  rmSync(join(h.repo, 'docs', 'gone.txt'));
  writeFileSync(join(h.repo, 'src', 'new.txt'), 'untracked, then added\n');
  const inner = join(h.root, 'inner');
  mkdirSync(inner);
  h.okGit(['init', '-q'], { cwd: inner });
  writeFileSync(join(inner, 'f'), '1');
  h.okGit(['add', 'f'], { cwd: inner }); h.okGit(['commit', '-q', '-m', 'i1'], { cwd: inner });
  h.okGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub']);
  h.scriptCi(GREEN);
  assert.equal(h.gate('review', passReview('rx-1', h.candidate())).out.code, 'review_accepted');
  assert.equal(h.gate('ship-ready', {}).out.ok, true);
  h.commitAll();
  const p = publishPr(h);
  assert.equal(code(p), 'published', p.stdout);
  assert.equal(h.cli('ci').out.state, 'PASS');
  const c = authorize(h, 'complete');
  assert.equal(c.out.allow, true, c.stdout);
  const m = h.readState().ship_ready.manifest;
  assert.equal(m.source, 'review_receipt', 'the manifest bound at SHIP_READY is the accepted review\'s');
  const kinds = Object.fromEntries(m.entries.map(e => [e.path, `${e.kind} ${e.mode}`]));
  assert.deepEqual([kinds['src/link'], kinds['docs/mode.txt'], kinds['docs/gone.txt'], kinds.sub], ['symlink 120000', 'file 100755', 'deleted 0', 'submodule 160000']);
});

test('R6-4 [C1] complete is cumulative: a published head whose bound manifest no longer matches the committed bytes is committed_content_mismatch at authorize complete', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  h.scriptCi(GREEN);
  await h.toShipReady();
  h.commitAll();
  assert.equal(code(publishPr(h)), 'published');
  assert.equal(h.cli('ci').out.state, 'PASS');
  assert.equal(authorize(h, 'complete').out.allow, true);
  h.editState(S => { const e = S.ship_ready.manifest.entries.find(x => x.path === 'src/a.txt'); h.saved = e.oid; e.oid = '0'.repeat(40); });
  assert.equal(code(authorize(h, 'complete')), 'committed_content_mismatch');
  h.editState(S => { S.ship_ready.manifest.entries.find(x => x.path === 'src/a.txt').oid = h.saved; });
  assert.equal(authorize(h, 'complete').out.allow, true);
});

test('R6-5 an extra committed file outside the reviewed manifest never publishes (history_outside_candidate here; committedContent lists it as extra: unit test below)', { skip: WIN_SKIP }, async (t) => {
  const h = enrollFixture(t);
  await h.toShipReady();
  writeFileSync(join(h.repo, 'docs', 'extra.txt'), 'never reviewed');
  h.commitAll();
  const a = authorize(h, 'publish');
  assert.equal(a.out.allow, false, a.stdout);
  assert.ok(['history_outside_candidate', 'candidate_stale', 'committed_content_mismatch'].includes(code(a)), a.stdout);
  assert.equal(h.remoteHead(), null);
});

// ------------------------------------------------------------------ committedContent, directly (plumbing; both checks)

function unitRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r0s6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.none'), '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, '.none'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q');
  writeFileSync(join(dir, '.gitignore'), '.none\n');
  writeFileSync(join(dir, 'a.txt'), 'old\n');
  g('add', '.'); g('commit', '-q', '-m', 'c0'); g('branch', 'trunk');
  /** The reviewed manifest of the work tree now (as SHIP_READY binds it). */
  const manifest = () => { const c = candidateId(dir, 'trunk', []); return { merge_base: c.merge_base, entries: worktreeManifest(dir, c.paths, c.candidate_id) }; };
  return { dir, g, manifest };
}

test('R6-6 [C1a] (a) the changed path set must equal the manifest: an extra committed path and a reviewed path left uncommitted are each listed', (t) => {
  const r = unitRepo(t);
  writeFileSync(join(r.dir, 'a.txt'), 'reviewed\n');
  writeFileSync(join(r.dir, 'b.txt'), 'reviewed too\n');
  const m = r.manifest();
  r.g('add', 'a.txt'); r.g('commit', '-q', '-m', 'only a');
  writeFileSync(join(r.dir, 'x.txt'), 'extra');
  r.g('add', 'x.txt'); r.g('commit', '-q', '-m', 'extra x');
  const v = committedContent(r.dir, r.g('rev-parse', 'HEAD'), m, [], { checks: ['paths'] });
  assert.equal(v?.code, 'committed_content_mismatch', JSON.stringify(v));
  assert.ok(v.reasons.some(x => x.startsWith('x.txt: committed')), JSON.stringify(v.reasons));
  assert.ok(v.reasons.some(x => x.startsWith('b.txt: reviewed but not changed')), JSON.stringify(v.reasons));
  // an excluded path (the plan, the session log) may be committed beside the reviewed content
  assert.equal(committedContent(r.dir, r.g('rev-parse', 'HEAD'), { ...m, entries: m.entries.filter(e => e.path !== 'b.txt') }, ['x.txt'], { checks: ['paths'] }), null);
});

test('R6-7 [C1b] (b) mode and object id per path: other committed bytes, a lost executable bit, and a reviewed deletion still present are each listed; the exact commit is equal', (t) => {
  const r = unitRepo(t);
  writeFileSync(join(r.dir, 'a.txt'), 'reviewed\n');
  writeFileSync(join(r.dir, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(r.dir, 'run.sh'), 0o755);
  const m = r.manifest();
  r.g('add', '-A'); r.g('commit', '-q', '-m', 'exact');
  assert.equal(committedContent(r.dir, r.g('rev-parse', 'HEAD'), m), null, 'the reviewed bytes, committed: equal');
  writeFileSync(join(r.dir, 'a.txt'), 'other bytes\n');
  r.g('add', 'a.txt');
  r.g('update-index', '--chmod=-x', 'run.sh');
  r.g('commit', '-q', '-m', 'drift');
  const v = committedContent(r.dir, r.g('rev-parse', 'HEAD'), m, [], { checks: ['content'] });
  assert.equal(v?.code, 'committed_content_mismatch');
  assert.ok(v.reasons.some(x => x.startsWith('a.txt: committed 100644')), JSON.stringify(v.reasons));
  assert.ok(v.reasons.some(x => x.startsWith('run.sh: committed 100644') && x.includes('reviewed 100755')), JSON.stringify(v.reasons));
  const del = { ...m, entries: [{ path: 'a.txt', kind: 'deleted', mode: '0', oid: null }] };
  assert.match(committedContent(r.dir, r.g('rev-parse', 'HEAD'), del, [], { checks: ['content'] }).reasons[0], /reviewed as deleted/);
});
