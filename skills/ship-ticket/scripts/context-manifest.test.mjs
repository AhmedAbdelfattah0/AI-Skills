/**
 * context-manifest.mjs (P0 slice E4). The first test is the CI gate: the committed
 * references/context-manifest.json must describe the references exactly as committed, so editing a
 * reference without `node skills/ship-ticket/scripts/context-manifest.mjs build` fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_DIR, MANIFEST_REL, PHASE_REFS, buildManifest, manifestText, verifySkill, deliverPhase, sha256, gitReader } from './context-manifest.mjs';

const CLI = fileURLToPath(new URL('./context-manifest.mjs', import.meta.url));

test('CI gate: the committed manifest verifies and is byte-identical to a rebuild', () => {
  const v = verifySkill();
  assert.equal(v.ok, true, `${v.code}: ${v.reasons?.join('; ')} (run: node skills/ship-ticket/scripts/context-manifest.mjs build)`);
  assert.equal(readFileSync(join(SKILL_DIR, MANIFEST_REL), 'utf8'), manifestText(buildManifest()), 'manifest is not the output of build');
  const r = spawnSync(process.execPath, [CLI, 'verify'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^context-manifest: ok sha256:[0-9a-f]{64}$/m);
});

test('every phase lists only existing references, and each phase delivers exactly those bytes', () => {
  for (const [phase, list] of Object.entries(PHASE_REFS)) {
    const d = deliverPhase(phase);
    assert.equal(d.ok, true, phase);
    assert.deepEqual(d.inventory.map(i => i.path), list);
    for (const p of list) {
      const bytes = readFileSync(join(SKILL_DIR, p));
      assert.ok(d.text.includes(`===== BEGIN ${p} ${sha256(bytes)} =====\n${bytes.toString('utf8')}`), p);
    }
  }
  assert.equal(deliverPhase('prove-everything').code, 'phase_unknown');
});

// The R0-S C3 test (every lifecycle phase named in SKILL.md has a delivery) is deferred to S-28b b1, which reads references/execution-harness.md (R8).

function copy(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'context-manifest-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(SKILL_DIR, 'references'), join(dir, 'references'), { recursive: true });
  return dir;
}

test('verify fails on a changed, missing or extra reference, a hand-edited manifest and changed phases', (t) => {
  const dir = copy(t);
  const code = () => verifySkill(dir).code;
  const cli = () => spawnSync(process.execPath, [CLI, 'verify', '--skill', dir], { encoding: 'utf8' });
  assert.equal(code(), 'verified');
  const units = join(dir, 'references', 'units.md'); // not mandatory for any phase, still covered
  const before = readFileSync(units);
  writeFileSync(units, Buffer.concat([before, Buffer.from(' ')]));
  assert.equal(code(), 'reference_changed');
  const r = cli();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /reference_changed: references\/units\.md/);
  assert.equal(deliverPhase('build', dir).code, 'reference_changed', 'any drift blocks every phase delivery');
  writeFileSync(units, before);
  writeFileSync(join(dir, 'references', 'new.md'), 'x');
  assert.equal(code(), 'reference_extra');
  unlinkSync(join(dir, 'references', 'new.md'));
  unlinkSync(join(dir, 'references', 'ship.md'));
  assert.equal(code(), 'reference_missing');
  writeFileSync(join(dir, 'references', 'ship.md'), 'replacement');
  const m = JSON.parse(readFileSync(join(dir, MANIFEST_REL), 'utf8'));
  m.files['references/ship.md'] = sha256(Buffer.from('replacement'));
  m.phases.ship = [];
  writeFileSync(join(dir, MANIFEST_REL), JSON.stringify(m));
  assert.equal(code(), 'manifest_phases_changed');
  writeFileSync(join(dir, MANIFEST_REL), 'not json');
  assert.equal(code(), 'manifest_invalid');
  assert.equal(spawnSync(process.execPath, [CLI, 'build', '--skill', dir]).status, 0);
  assert.equal(code(), 'verified', 'build repairs it');
  assert.equal(spawnSync(process.execPath, [CLI, 'nonsense']).status, 2);
});

// ---- the git reader reads the PINNED COMMIT, under a hardened environment (S-28b b0) ----

const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A git repository holding a committed copy of the skill (references/ with a rebuilt manifest) under skills/ship-ticket. */
function skillRepo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-manifest-git-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = join(root, 'skills', 'ship-ticket');
  mkdirSync(skill, { recursive: true });
  cpSync(join(SKILL_DIR, 'references'), join(skill, 'references'), { recursive: true });
  assert.equal(spawnSync(process.execPath, [CLI, 'build', '--skill', skill]).status, 0);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false'); // the scratch repo keeps the bytes it is given, whatever the machine's git config
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'pin');
  return { root, skill, head: git(root, 'rev-parse', 'HEAD') };
}

test('gitReader delivers the blobs of the pinned commit: a work-tree edit changes nothing (mutant C2 reads the work tree)', (t) => {
  const { skill, head } = skillRepo(t);
  const committed = readFileSync(join(skill, 'references', 'ship.md'));
  writeFileSync(join(skill, 'references', 'ship.md'), 'edited in the work tree after the pin');
  assert.equal(verifySkill(skill).code, 'reference_changed', 'the work-tree reader sees the edit');
  const reader = gitReader(skill, head);
  assert.equal(reader.mode, 'git');
  assert.equal(reader.revision, head);
  const v = verifySkill(skill, reader);
  assert.equal(v.ok, true, `${v.code}: ${v.reasons?.join('; ')}`);
  const d = deliverPhase('ship', skill, reader);
  assert.equal(d.ok, true);
  assert.ok(d.text.includes(committed.toString('utf8')), 'the committed bytes are delivered');
  assert.ok(!d.text.includes('edited in the work tree'), 'the work-tree edit is not');
  assert.match(d.text, new RegExp(`\\(skill commit ${head}\\)`));
  assert.deepEqual(reader.list(), buildManifestPaths(skill, reader));
  assert.equal(gitReader(join(tmpdir(), 'no-such-dir-context-manifest')), null, 'not inside a git work tree: null (a copy install)');
  assert.equal(verifySkill(skill, gitReader(skill, '0'.repeat(40))).code, 'skill_revision_unavailable');
  assert.ok(reader.list().includes('references/ship.md') && reader.list().length >= 12, 'the git reader lists the pinned references (skill below the repo root)');
  // an extra reference committed later is seen by a reader pinned to that commit, not by one pinned to the old commit
  writeFileSync(join(skill, 'references', 'ship.md'), committed);
  writeFileSync(join(skill, 'references', 'extra.md'), 'x');
  git(skill, 'add', '-A'); git(skill, 'commit', '-q', '-m', 'extra');
  const later = git(skill, 'rev-parse', 'HEAD');
  assert.equal(verifySkill(skill, gitReader(skill, later)).code, 'reference_extra');
  assert.equal(verifySkill(skill, gitReader(skill, head)).ok, true);
});
const buildManifestPaths = (skill, reader) => Object.keys(JSON.parse(reader.read(MANIFEST_REL).toString('utf8')).files).sort();

test('a planted GIT_DIR / GIT_OBJECT_DIRECTORY / replace ref does not redirect gitReader', (t) => {
  const { skill, head } = skillRepo(t);
  const decoy = skillRepo(t); // another repository whose references differ
  writeFileSync(join(decoy.skill, 'references', 'ship.md'), 'DECOY');
  git(decoy.root, 'commit', '-q', '-am', 'decoy');
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  process.env.GIT_DIR = join(decoy.root, '.git');
  process.env.GIT_WORK_TREE = decoy.root;
  process.env.GIT_OBJECT_DIRECTORY = join(decoy.root, '.git', 'objects');
  const reader = gitReader(skill);
  assert.equal(reader?.revision, head, 'HEAD of the skill repository, not of the planted GIT_DIR');
  const d = deliverPhase('ship', skill, reader);
  assert.equal(d.ok, true, `${d.code}: ${d.reasons?.join('; ')}`);
  assert.ok(!d.text.includes('DECOY'));
  assert.equal(process.env.GIT_DIR, join(decoy.root, '.git'), 'the caller environment is restored');
  // a GIT_DIR naming nothing must not turn the skill into "not a git work tree" either
  process.env.GIT_DIR = join(decoy.root, 'nowhere');
  assert.equal(gitReader(skill)?.revision, head);
  // a replace ref on the pinned commit's blob must not rewrite what is read
  delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE; delete process.env.GIT_OBJECT_DIRECTORY;
  const blob = git(skill, 'rev-parse', `${head}:skills/ship-ticket/references/ship.md`);
  const fake = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: skill, input: 'REPLACED', encoding: 'utf8' }).stdout.trim();
  git(skill, 'replace', blob, fake);
  const r2 = gitReader(skill, head);
  assert.notEqual(r2.read('references/ship.md')?.toString('utf8'), 'REPLACED', 'replace refs are off');
  assert.equal(verifySkill(skill, r2).ok, true);
});

// ---- CRLF work tree (Windows core.autocrlf), found by CI on PR #121 ----

test('CRLF work-tree bytes: the work-tree reader fails closed naming each file; the pinned-blob reader is unaffected', (t) => {
  const { skill, head } = skillRepo(t);
  const refs = join(skill, 'references');
  for (const f of ['ship.md', 'brief.md']) writeFileSync(join(refs, f), readFileSync(join(refs, f), 'utf8').replace(/\n/g, '\r\n'));
  const v = verifySkill(skill);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'reference_changed');
  assert.deepEqual(v.reasons.sort(), ['references/brief.md differs from its manifest digest', 'references/ship.md differs from its manifest digest']);
  const blob = verifySkill(skill, gitReader(skill, head));
  assert.equal(blob.ok, true, `${blob.code}: ${blob.reasons?.join('; ')}`);
  const d = deliverPhase('ship', skill, gitReader(skill, head));
  assert.equal(d.ok, true);
  assert.ok(!d.text.includes('\r\n'), 'the pinned LF bytes are delivered, not the CRLF work tree');
});

test('the repository pins LF for references/** so a Windows checkout matches the manifest digests', () => {
  const r = spawnSync('git', ['-C', SKILL_DIR, 'check-attr', 'text', 'eol', '--', 'references/ship.md', 'references/context-manifest.json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  for (const l of lines.filter(x => /: text:/.test(x))) assert.match(l, /: text: set$/);
  for (const l of lines.filter(x => /: eol:/.test(x))) assert.match(l, /: eol: lf$/);
});
