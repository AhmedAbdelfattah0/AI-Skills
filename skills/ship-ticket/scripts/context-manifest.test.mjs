/**
 * context-manifest.mjs (P0 slice E4). The first test is the CI gate: the committed
 * references/context-manifest.json must describe the references exactly as committed, so editing a
 * reference without `node skills/ship-ticket/scripts/context-manifest.mjs build` fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_DIR, MANIFEST_REL, PHASE_REFS, buildManifest, manifestText, verifySkill, deliverPhase, sha256, gitReader, fsReader } from './context-manifest.mjs';

const CLI = fileURLToPath(new URL('./context-manifest.mjs', import.meta.url));

test('CI gate: the committed manifest verifies and is byte-identical to a rebuild', () => {
  const v = verifySkill();
  assert.equal(v.ok, true, `${v.code}: ${v.reasons?.join('; ')} (run: node skills/ship-ticket/scripts/context-manifest.mjs build)`);
  assert.equal(readFileSync(join(SKILL_DIR, MANIFEST_REL), 'utf8'), manifestText(buildManifest()), 'manifest is not the output of build');
  const r = spawnSync(process.execPath, [CLI, 'verify'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^context-manifest: ok sha256:[0-9a-f]{64}$/m);
  // the COMMITTED tree too (on a pull_request run, HEAD is the PR's merge ref): the blobs at HEAD verify against the manifest at HEAD
  const g = gitReader();
  assert.ok(g && !g.missing, 'the CI checkout is a git work tree');
  const h = verifySkill(SKILL_DIR, g);
  assert.equal(h.ok, true, `HEAD ${g.revision}: ${h.code}: ${h.reasons?.join('; ')} (commit the rebuilt manifest)`);
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
  assert.deepEqual(reader.inventory().files, buildManifestPaths(skill, reader));
  assert.equal(gitReader(join(tmpdir(), 'no-such-dir-context-manifest')), null, 'not inside a git work tree: null (a copy install)');
  assert.equal(verifySkill(skill, gitReader(skill, '0'.repeat(40))).code, 'skill_revision_unavailable');
  assert.ok(reader.inventory().files.includes('references/ship.md') && reader.inventory().files.length >= 12, 'the git reader lists the pinned references (skill below the repo root)');
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

// ---- Round 1 repair (PR #121): one inventory for both readers; anything in references/ that is not a top-level regular file is
// refused (MAJOR C); the manifest's file set must EQUAL the inventory; malformed or non-canonical manifests are refused, never thrown ----

const win = process.platform === 'win32';
const unsupported = (v) => { assert.equal(v.ok, false); assert.equal(v.code, 'reference_unsupported_entry', `${v.code}: ${v.reasons?.join('; ')}`); return v.reasons.join('; '); };

test('fs reader: a nested file, an empty directory or a symlink in references/ is refused by verify AND by build', (t) => {
  const dir = copy(t);
  const refs = join(dir, 'references');
  const build = () => spawnSync(process.execPath, [CLI, 'build', '--skill', dir], { encoding: 'utf8' });
  mkdirSync(join(refs, 'subdir')); writeFileSync(join(refs, 'subdir', 'untracked.md'), 'x');
  assert.match(unsupported(verifySkill(dir)), /references\/subdir \(directory\)/);
  const before = readFileSync(join(dir, MANIFEST_REL));
  let r = build();
  assert.equal(r.status, 1, 'build refuses instead of skipping the entry');
  assert.match(r.stderr, /reference_unsupported_entry: references\/subdir \(directory\)/);
  assert.deepEqual(readFileSync(join(dir, MANIFEST_REL)), before, 'a refused build writes nothing');
  assert.throws(() => buildManifest(dir), (e) => e.code === 'reference_unsupported_entry');
  rmSync(join(refs, 'subdir', 'untracked.md'));
  assert.match(unsupported(verifySkill(dir)), /references\/subdir \(directory\)/, 'an empty directory too');
  rmSync(join(refs, 'subdir'), { recursive: true });
  assert.equal(verifySkill(dir).ok, true);
  if (!win) {
    symlinkSync(join(refs, 'ship.md'), join(refs, 'alias.md'));
    assert.match(unsupported(verifySkill(dir)), /references\/alias\.md \(symbolic link\)/);
    r = build(); assert.equal(r.status, 1);
    rmSync(join(refs, 'alias.md'));
    // a LISTED reference replaced by a symlink to identical bytes is refused too (the digest alone would pass)
    const ship = readFileSync(join(refs, 'ship.md'));
    writeFileSync(join(dir, 'ship-copy.md'), ship); rmSync(join(refs, 'ship.md')); symlinkSync(join(dir, 'ship-copy.md'), join(refs, 'ship.md'));
    assert.match(unsupported(verifySkill(dir)), /references\/ship\.md \(symbolic link\)/);
    rmSync(join(refs, 'ship.md')); writeFileSync(join(refs, 'ship.md'), ship);
    // references/ itself a symlink
    const real = join(dir, 'real-refs');
    cpSync(refs, real, { recursive: true }); rmSync(refs, { recursive: true }); symlinkSync(real, refs);
    assert.match(unsupported(verifySkill(dir)), /references is not a directory \(symbolic link\)/);
  }
});

test('git reader: a committed symlink, a nested file and a submodule entry in references/ are refused; both readers agree on a clean tree', (t) => {
  const { root, skill, head } = skillRepo(t);
  const clean = gitReader(skill, head).inventory();
  assert.deepEqual(clean, fsReader(skill).inventory(), 'one inventory, whichever reader');
  assert.deepEqual(clean.unsupported, []);
  const commitWith = (mode, name) => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'references/ship.md', encoding: 'utf8' }).stdout.trim();
    git(root, 'update-index', '--add', '--cacheinfo', `${mode},${mode === '160000' ? head : blob},skills/ship-ticket/references/${name}`);
    git(root, 'commit', '-q', '-m', name);
    return git(root, 'rev-parse', 'HEAD');
  };
  assert.match(unsupported(verifySkill(skill, gitReader(skill, commitWith('120000', 'link.md')))), /references\/link\.md \(symbolic link\)/);
  git(root, 'rm', '-q', '--cached', 'skills/ship-ticket/references/link.md'); git(root, 'commit', '-q', '-m', 'rm link');
  assert.match(unsupported(verifySkill(skill, gitReader(skill, commitWith('160000', 'sm')))), /references\/sm \(submodule\)/);
  git(root, 'rm', '-q', '--cached', 'skills/ship-ticket/references/sm'); git(root, 'commit', '-q', '-m', 'rm sm');
  mkdirSync(join(skill, 'references', 'subdir')); writeFileSync(join(skill, 'references', 'subdir', 'nested.md'), 'x');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'nested');
  const nested = git(root, 'rev-parse', 'HEAD');
  const g = unsupported(verifySkill(skill, gitReader(skill, nested)));
  assert.match(g, /references\/subdir \(directory\)/);
  assert.equal(unsupported(verifySkill(skill)), g, 'the fs reader refuses the same entry with the same reason');
  assert.equal(verifySkill(skill, gitReader(skill, head)).ok, true, 'the pinned clean commit still verifies');
});

test('gitReader resolves the requested revision ONCE to a full commit sha; option-like or unresolvable input is refused', (t) => {
  const { root, skill, head } = skillRepo(t);
  const r = gitReader(skill, 'HEAD');
  assert.equal(r.revision, head, 'a ref is resolved to the commit sha and recorded');
  assert.match(r.revision, /^[0-9a-f]{40}$/);
  const before = r.read('references/ship.md');
  writeFileSync(join(skill, 'references', 'ship.md'), 'moved on'); git(root, 'commit', '-q', '-am', 'later');
  assert.deepEqual(r.read('references/ship.md'), before, 'a later commit does not move a reader created from a ref');
  assert.equal(gitReader(skill, head.slice(0, 12)).revision, head, 'an abbreviated sha resolves to the full sha');
  for (const bad of ['--output=/tmp/x', '-h', '', 'no-such-ref', `${head}:skills`, 'HEAD\nHEAD', 5, {}]) {
    const g = gitReader(skill, bad);
    assert.equal(g.missing, true, String(bad));
    assert.equal(g.revision, null, String(bad));
    const v = verifySkill(skill, g);
    assert.equal(v.code, 'skill_revision_unavailable', String(bad));
  }
});

test('malformed, aliased and non-canonical manifests are refused with a structured verdict, never a throw', (t) => {
  const dir = copy(t);
  const path = join(dir, MANIFEST_REL), good = readFileSync(path, 'utf8');
  const withM = (edit) => { const m = JSON.parse(good); edit(m); writeFileSync(path, manifestText(m)); return verifySkill(dir); };
  for (const [name, edit, code] of [
    ['phases.ship = 7', (m) => { m.phases.ship = 7; }, 'manifest_phases_changed'],
    ['phases an array', (m) => { m.phases = []; }, 'manifest_invalid'],
    ['a digest not a string', (m) => { m.files['references/ship.md'] = 7; }, 'manifest_invalid'],
    ['a digest malformed', (m) => { m.files['references/ship.md'] = 'sha256:XYZ'; }, 'manifest_invalid'],
    ['files an array', (m) => { m.files = []; }, 'manifest_invalid'],
    ['an escaping key', (m) => { m.files['references/../SKILL.md'] = m.files['references/ship.md']; }, 'manifest_invalid'],
    ['a nested key', (m) => { m.files['references/sub/x.md'] = m.files['references/ship.md']; }, 'manifest_invalid'],
    ['a case alias key', (m) => { m.files['references/Ship.md'] = m.files['references/ship.md']; }, 'reference_missing'],
    ['an extra top-level key', (m) => { m.extra = 1; }, 'manifest_invalid'],
  ]) {
    let v;
    assert.doesNotThrow(() => { v = withM(edit); }, name);
    assert.equal(v.ok, false, name);
    assert.equal(v.code, code, `${name}: ${v.reasons?.join('; ')}`);
  }
  assert.equal(deliverPhase('ship', dir).ok, false, 'no phase is delivered from a malformed manifest');
  // duplicate key: JSON.parse keeps the last one, so the bytes are not the canonical serialization of what was parsed
  const ship = JSON.parse(good).files['references/ship.md'];
  writeFileSync(path, good.replace(`"references/ship.md": "${ship}"`, `"references/ship.md": "${sha256(Buffer.from('other'))}",\n    "references/ship.md": "${ship}"`));
  let v = verifySkill(dir);
  assert.equal(v.code, 'manifest_noncanonical', `${v.code}: ${v.reasons?.join('; ')}`);
  writeFileSync(path, good.replace(/\n/g, '\r\n'));
  assert.equal(verifySkill(dir).code, 'manifest_noncanonical', 'CRLF manifest bytes');
  writeFileSync(path, good);
  assert.equal(verifySkill(dir).ok, true);
});
