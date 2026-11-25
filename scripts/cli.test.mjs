// Tests for scripts/cli.mjs: install, update, the validator and the install targets.
// Run with: node --test scripts/cli.test.mjs   (needs Node >= 22. No dependencies.)
//
// ISOLATION (non-negotiable). The CLI writes to the home directory, runs
// `git pull` in its own checkout and can register a scheduled job, so no test may
// run the real script against the real machine. Every test therefore builds its
// own world under a fresh temp root:
//   <root>/lib/scripts/   COPIES of cli.mjs and autoupdate.mjs (the CLI under test)
//   <root>/lib/skills/    a fixture skill library
//   <root>/home           the only home directory the child process can see
// The copy's REPO_ROOT is <root>/lib, which is not a git clone, so `update` never
// pulls. The child env points HOME, USERPROFILE, XDG_*, LOCALAPPDATA and APPDATA
// inside the root, pins GIT_CEILING_DIRECTORIES to it and drops NODE_TEST_CONTEXT
// (otherwise the child would run as a nested test). Inherited variables are removed
// case-insensitively first: Windows names are case-insensitive, so a stray
// `LocalAppData` would otherwise sit beside ours with an unspecified winner. `autoupdate --install` and
// `--remove` are never called. The root is removed after every test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MANIFEST = '.ai-skills-manifest.json';

// ---- fixture builder ---------------------------------------------------------

const VOCABULARY = [
  'OUTCOME_VOCABULARY',
  'PASS the check held',
  'FAIL the check did not hold',
  'NOT_TRIGGERED the check never fired',
  'NOT_APPLICABLE the check does not apply',
  'DEGRADED the check ran with a stated limit',
];

function skillMd(name, bodyLines = [], { description = `The ${name} fixture.` } = {}) {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', ...bodyLines, ''].join('\n');
}

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function lineOf(text, needle) {
  return text.split('\n').findIndex((l) => l.includes(needle)) + 1;
}

// A throwaway world. `skills` maps a skill name to its SKILL.md body lines.
function world(t, skills = { alpha: ['Alpha body.'] }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ais-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The CLI copies ephemeral sources by default and treats them differently; a
  // temp path must not look like an npm cache or the tests would test another mode.
  assert.doesNotMatch(root.replace(/\\/g, '/'), /\/_npx\/|\/node_modules\/|\/\.npm\//);

  const lib = join(root, 'lib');
  const home = join(root, 'home');
  mkdirSync(join(lib, 'scripts'), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const f of ['cli.mjs', 'autoupdate.mjs']) cpSync(join(SCRIPTS, f), join(lib, 'scripts', f));
  const w = Object.assign({ root, lib, home, cli: join(lib, 'scripts', 'cli.mjs'), skillsDir: join(lib, 'skills') }, worldMethods);
  for (const [name, body] of Object.entries(skills)) w.writeSkill(name, body);
  return w;
}

// The inherited environment minus NODE_TEST_CONTEXT and every name we override
// (compared case-insensitively), plus the overrides.
function childEnv(overrides) {
  const drop = new Set(['node_test_context', ...Object.keys(overrides).map((k) => k.toLowerCase())]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop.has(k.toLowerCase())) env[k] = v;
  return Object.assign(env, overrides);
}

const worldMethods = {
  writeSkill(name, body = [], extra = {}) {
    put(join(this.skillsDir, name, 'SKILL.md'), skillMd(name, body));
    for (const [rel, text] of Object.entries(extra)) put(join(this.skillsDir, name, rel), text);
  },
  file(...parts) { return join(this.skillsDir, ...parts); },
  claudeDir(...parts) { return join(this.home, '.claude', 'skills', ...parts); },
  run(args, extraEnv = {}) {
    const env = childEnv({
      ...extraEnv,
      HOME: this.home,
      USERPROFILE: this.home,
      XDG_STATE_HOME: join(this.root, 'state'),
      XDG_CONFIG_HOME: join(this.root, 'config'),
      LOCALAPPDATA: join(this.root, 'localappdata'),
      APPDATA: join(this.root, 'appdata'),
      GIT_CEILING_DIRECTORIES: this.root,
    });
    const r = spawnSync(process.execPath, [this.cli, ...args], { cwd: this.root, env, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
  },
  // Every update goes through here so a run that could pull is caught, not trusted.
  update(args = []) {
    const r = this.run(['update', ...args]);
    assert.match(r.out, /is not a git clone/, `update must run against a non-clone library:\n${r.out}`);
    return r;
  },
  validate() { return this.run(['validate']); },
};

// A library the validator accepts: one skill owning the outcome vocabulary.
function validWorld(t, extraSkills = {}) {
  return world(t, { alpha: ['Alpha body.', '', ...VOCABULARY], ...extraSkills });
}

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
const read = (file) => readFileSync(file, 'utf8');

// ---- install -----------------------------------------------------------------

test('link install makes a link that resolves to the source skill', (t) => {
  const w = world(t);
  const r = w.run(['install', '--link', 'alpha']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /linked\s+alpha/);
  assert.ok(lstatSync(w.claudeDir('alpha')).isSymbolicLink(), 'destination is a link (a junction on Windows)');
  assert.equal(realpathSync(w.claudeDir('alpha')), realpathSync(w.file('alpha')));
});

test('copy install writes a real directory and records its hash and mode', (t) => {
  const w = world(t);
  w.writeSkill('alpha', ['Alpha body.'], { 'references/extra.md': 'Extra.\n' });
  const r = w.run(['install', '--copy', 'alpha']);
  assert.equal(r.status, 0, r.out);
  const dest = w.claudeDir('alpha');
  assert.ok(!lstatSync(dest).isSymbolicLink());
  assert.ok(lstatSync(dest).isDirectory());
  assert.equal(read(join(dest, 'SKILL.md')), read(w.file('alpha', 'SKILL.md')));
  assert.equal(read(join(dest, 'references', 'extra.md')), 'Extra.\n');
  const manifest = readManifest(w.claudeDir());
  assert.equal(manifest.skills.alpha.mode, 'copy');
  assert.match(manifest.skills.alpha.hash, /^[0-9a-f]{64}$/);
});

// ---- install never destroys what it does not own -------------------------------
// An existing entry is replaced only when it is ours: a link to this library's own skill, or a copy
// this library recorded and nobody edited since (the ownership test `update` already applies).
// Anything else is left byte-identical, named, and the run ends non-zero; --replace-foreign moves it
// to a backup under the state directory first and never deletes it.

const twoSkills = (t) => world(t, { alpha: ['Alpha body.'], beta: ['Beta body.'] });
const unixOnly = { skip: process.platform === 'win32' && 'a Unix-only path (bash installer, POSIX links and modes)' };
function linkDir(t, target, path) {
  mkdirSync(dirname(path), { recursive: true });
  try { symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch { t.skip('symlinks not permitted here'); return false; }
}
const leftAlone = (name, why) => new RegExp(`! ${name} {2}${why}, left alone; resolve this collision or re-run with --replace-foreign`);

test('install leaves a real directory of the same name byte-identical and exits 1', (t) => {
  const w = twoSkills(t);
  put(w.claudeDir('beta', 'SKILL.md'), 'my own beta\n');
  put(w.claudeDir('beta', 'notes', 'unique.txt'), 'only copy of this\n');
  const r = w.run(['install', '--link']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, leftAlone('beta', 'present but not installed by us'));
  assert.ok(r.out.includes(`${w.claudeDir('beta')} is untouched`), r.out);
  assert.ok(!lstatSync(w.claudeDir('beta')).isSymbolicLink());
  assert.equal(read(w.claudeDir('beta', 'SKILL.md')), 'my own beta\n');
  assert.equal(read(w.claudeDir('beta', 'notes', 'unique.txt')), 'only copy of this\n');
  assert.equal(realpathSync(w.claudeDir('alpha')), realpathSync(w.file('alpha')), 'the other skills still install');
  assert.match(r.out, /installed 1\/2 skill.*1 left alone/);
  assert.equal(readManifest(w.claudeDir()).skills.beta, undefined, 'a skipped skill is not recorded');
});

for (const [label, target] of [
  ['an arbitrary directory', (w) => join(w.root, 'elsewhere', 'beta')],
  ["another library's clone", (w) => join(w.root, 'other-library', 'skills', 'beta')],
]) {
  test(`install leaves a foreign link into ${label} alone`, (t) => {
    const w = twoSkills(t);
    const dest = target(w);
    put(join(dest, 'SKILL.md'), 'another collection\n');
    if (!linkDir(t, dest, w.claudeDir('beta'))) return;
    const r = w.run(['install', '--link']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, leftAlone('beta', 'a symlink that is not ours'));
    assert.equal(realpathSync(w.claudeDir('beta')), realpathSync(dest));
    assert.equal(read(join(dest, 'SKILL.md')), 'another collection\n');
  });
}

test('install leaves a dangling foreign link alone', (t) => {
  const w = twoSkills(t);
  const gone = join(w.root, 'gone', 'beta');
  put(join(gone, 'SKILL.md'), 'x\n');
  if (!linkDir(t, gone, w.claudeDir('beta'))) return;
  rmSync(join(w.root, 'gone'), { recursive: true, force: true });
  const r = w.run(['install', '--link']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, leftAlone('beta', 'a symlink that is not ours'));
  assert.ok(lstatSync(w.claudeDir('beta')).isSymbolicLink(), 'the dangling link is still there');
  assert.ok(!existsSync(w.claudeDir('beta')), 'and still dangles');
});

test('install leaves a copy edited after install alone', (t) => {
  const w = twoSkills(t);
  assert.equal(w.run(['install', '--copy']).status, 0);
  writeFileSync(w.claudeDir('beta', 'SKILL.md'), 'my own edit\n');
  const r = w.run(['install', '--copy']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, leftAlone('beta', 'edited after install'));
  assert.equal(read(w.claudeDir('beta', 'SKILL.md')), 'my own edit\n');
});

test('install replaces its own link and its own untouched copy as before', (t) => {
  const w = twoSkills(t);
  assert.equal(w.run(['install', '--link']).status, 0);
  const again = w.run(['install', '--link']);
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.out, /left alone/);
  const toCopy = w.run(['install', '--copy']);
  assert.equal(toCopy.status, 0, toCopy.out);
  assert.ok(!lstatSync(w.claudeDir('beta')).isSymbolicLink(), 'our link became our copy');
  w.writeSkill('beta', ['Beta body, revised.']);
  const refreshed = w.run(['install', '--copy']);
  assert.equal(refreshed.status, 0, refreshed.out);
  assert.match(read(w.claudeDir('beta', 'SKILL.md')), /Beta body, revised\./);
});

const movedTo = (name, out) => {
  const m = out.match(new RegExp(`${name} {2}moved to (.+)$`, 'm'));
  assert.ok(m, `the backup path is printed:\n${out}`);
  return m[1].trim();
};

test('install --replace-foreign moves the entry to a backup under the state dir, then installs', (t) => {
  const w = twoSkills(t);
  put(w.claudeDir('beta', 'SKILL.md'), 'my own beta\n');
  put(w.claudeDir('beta', 'notes', 'unique.txt'), 'only copy of this\n');
  const r = w.run(['install', '--link', '--replace-foreign']);
  assert.equal(r.status, 0, r.out);
  const backup = movedTo('beta', r.out);
  assert.ok(backup.startsWith(join(w.root, 'state', 'ai-skills')), `backup lives under the state dir: ${backup}`);
  assert.ok(existsSync(join(backup, 'notes', 'unique.txt')), `the backup holds the moved entry: ${backup}`);
  assert.equal(read(join(backup, 'SKILL.md')), 'my own beta\n');
  assert.equal(read(join(backup, 'notes', 'unique.txt')), 'only copy of this\n');
  assert.equal(realpathSync(w.claudeDir('beta')), realpathSync(w.file('beta')));
});

// A backup that has to cross filesystems: a preload makes every rename into the backup area fail
// with EXDEV, so backUpForeign takes its copy-then-remove path.
function crossDevice(w) {
  const preload = join(w.root, 'exdev.mjs');
  put(preload, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const rename = fs.renameSync;',
    `const mark = ${JSON.stringify(join(w.root, 'exdev-thrown'))};`,
    "fs.renameSync = (a, b) => { if (/[\\\\/]replaced[\\\\/]/.test(String(b))) { fs.appendFileSync(mark, String(a) + '\\n'); const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; } return rename(a, b); };",
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
}

test('install --replace-foreign across filesystems keeps a dangling link a link and a nested link a link', unixOnly, (t) => {
  const w = world(t, { alpha: ['Alpha body.'], beta: ['Beta body.'] });
  linkDir(t, join(w.root, 'gone', 'alpha'), w.claudeDir('alpha'));
  put(w.claudeDir('beta', 'notes', 'unique.txt'), 'only copy of this\n');
  symlinkSync('notes/unique.txt', w.claudeDir('beta', 'inner-link'));
  const r = w.run(['install', '--link', '--replace-foreign'], crossDevice(w));
  assert.equal(r.status, 0, r.out);
  assert.equal(read(join(w.root, 'exdev-thrown')).trim().split('\n').length, 2, 'both moves took the cross-device path');
  const alphaBackup = movedTo('alpha', r.out);
  assert.ok(lstatSync(alphaBackup).isSymbolicLink(), 'the dangling link was backed up as a link');
  assert.equal(readlinkSync(alphaBackup), join(w.root, 'gone', 'alpha'));
  const betaBackup = movedTo('beta', r.out);
  assert.ok(existsSync(join(betaBackup, 'notes', 'unique.txt')), `the backup holds the moved entry: ${betaBackup}`);
  assert.equal(read(join(betaBackup, 'notes', 'unique.txt')), 'only copy of this\n');
  assert.equal(readlinkSync(join(betaBackup, 'inner-link')), 'notes/unique.txt', 'a nested link is kept verbatim');
  assert.equal(realpathSync(w.claudeDir('beta')), realpathSync(w.file('beta')));
  assert.equal(realpathSync(w.claudeDir('alpha')), realpathSync(w.file('alpha')));
});

test('a backup that fails leaves the original untouched, installs the rest, records them and exits 1', unixOnly, (t) => {
  if (process.getuid?.() === 0) { t.skip('root reads unreadable files'); return; }
  const w = world(t, { alpha: ['Alpha body.'], beta: ['Beta body.'] });
  put(w.claudeDir('beta', 'SKILL.md'), 'my own beta\n');
  put(w.claudeDir('beta', 'secret.txt'), 'unreadable\n');
  chmodSync(w.claudeDir('beta', 'secret.txt'), 0o000);
  t.after(() => { try { chmodSync(w.claudeDir('beta', 'secret.txt'), 0o644); } catch { /* gone */ } });
  const r = w.run(['install', '--link', '--replace-foreign'], crossDevice(w));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /! beta {2}present but not installed by us, left alone: could not copy it to a backup .*the original is untouched/);
  assert.doesNotMatch(r.out, /\n\s+at /, 'no raw stack trace');
  assert.equal(read(w.claudeDir('beta', 'SKILL.md')), 'my own beta\n');
  chmodSync(w.claudeDir('beta', 'secret.txt'), 0o644);
  assert.equal(read(w.claudeDir('beta', 'secret.txt')), 'unreadable\n');
  assert.equal(realpathSync(w.claudeDir('alpha')), realpathSync(w.file('alpha')));
  const m = readManifest(w.claudeDir());
  assert.ok(m.skills.alpha, 'what was applied is recorded');
  assert.equal(m.skills.beta, undefined);
});

test('update still leaves a foreign link alone', (t) => {
  const w = twoSkills(t);
  assert.equal(w.run(['install', '--link', 'alpha']).status, 0);
  const dest = join(w.root, 'other-library', 'skills', 'beta');
  put(join(dest, 'SKILL.md'), 'another collection\n');
  if (!linkDir(t, dest, w.claudeDir('beta'))) return;
  const r = w.update(['beta']);
  assert.match(r.out, /beta {2}symlink to .* — not ours, left alone/);
  assert.equal(realpathSync(w.claudeDir('beta')), realpathSync(dest));
});

// scripts/install.sh applies the same rule: it replaces only its own link into this clone. Link mode
// only for exit codes: on the previous script a --copy run already exited 1 from its last line.
function bashInstall(w, args) {
  cpSync(join(SCRIPTS, 'install.sh'), join(w.lib, 'scripts', 'install.sh'));
  const env = childEnv({ HOME: w.home, XDG_STATE_HOME: join(w.root, 'state') });
  const r = spawnSync('bash', [join(w.lib, 'scripts', 'install.sh'), ...args], { cwd: w.root, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('scripts/install.sh leaves a real directory and foreign links alone, and exits 1', unixOnly, (t) => {
  const w = world(t, { alpha: ['Alpha body.'], beta: ['Beta body.'], gamma: ['Gamma body.'], delta: ['Delta body.'] });
  put(w.claudeDir('beta', 'notes', 'unique.txt'), 'only copy of this\n');
  const dest = join(w.root, 'other-library', 'skills', 'gamma');
  put(join(dest, 'SKILL.md'), 'another collection\n');
  linkDir(t, dest, w.claudeDir('gamma'));
  linkDir(t, join(w.root, 'gone', 'delta'), w.claudeDir('delta'));
  const r = bashInstall(w, ['--link']);
  assert.equal(r.status, 1, r.out);
  for (const n of ['beta', 'gamma', 'delta']) assert.match(r.out, new RegExp(`! ${n} {2}not this clone's link, left alone`));
  assert.equal(read(w.claudeDir('beta', 'notes', 'unique.txt')), 'only copy of this\n');
  assert.equal(realpathSync(w.claudeDir('gamma')), realpathSync(dest));
  assert.ok(lstatSync(w.claudeDir('delta')).isSymbolicLink() && !existsSync(w.claudeDir('delta')), 'the dangling link is kept');
  assert.equal(realpathSync(w.claudeDir('alpha')), realpathSync(w.file('alpha')));
  const again = bashInstall(w, ['--link', 'alpha']);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /linked {2}alpha/);
  assert.equal(realpathSync(w.claudeDir('alpha')), realpathSync(w.file('alpha')), 'its own link is replaced');
});

test('scripts/install.sh --replace-foreign backs the entry up, then installs', unixOnly, (t) => {
  const w = twoSkills(t);
  put(w.claudeDir('beta', 'notes', 'unique.txt'), 'only copy of this\n');
  const r = bashInstall(w, ['--link', '--replace-foreign']);
  assert.equal(r.status, 0, r.out);
  const backup = movedTo('beta', r.out);
  assert.ok(backup.startsWith(join(w.root, 'state', 'ai-skills', 'replaced')), backup);
  assert.ok(existsSync(join(backup, 'notes', 'unique.txt')), `the backup holds the moved entry: ${backup}`);
  assert.equal(read(join(backup, 'notes', 'unique.txt')), 'only copy of this\n');
  assert.equal(realpathSync(w.claudeDir('beta')), realpathSync(w.file('beta')));
});

// ---- update ------------------------------------------------------------------

test('update refreshes an unchanged copy without any flag', (t) => {
  const w = world(t);
  w.run(['install', '--copy', 'alpha']);
  const before = readManifest(w.claudeDir()).skills.alpha.hash;
  w.writeSkill('alpha', ['Alpha body, revised.']);
  const r = w.update();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /alpha {2}updated/);
  assert.match(read(w.claudeDir('alpha', 'SKILL.md')), /Alpha body, revised\./);
  assert.notEqual(readManifest(w.claudeDir()).skills.alpha.hash, before);
});

test('update leaves an edited copy alone and --force overwrites it', (t) => {
  const w = world(t);
  w.run(['install', '--copy', 'alpha']);
  const installed = w.claudeDir('alpha', 'SKILL.md');
  writeFileSync(installed, 'my own edit\n');
  w.writeSkill('alpha', ['Alpha body, revised.']);

  const left = w.update();
  assert.match(left.out, /alpha {2}edited after install — left alone/);
  assert.equal(read(installed), 'my own edit\n');

  const forced = w.update(['--force']);
  assert.match(forced.out, /alpha {2}updated \(over your edits\)/);
  assert.match(read(installed), /Alpha body, revised\./);
});

test('update leaves an unrecorded same-name directory alone and --adopt takes it over', (t) => {
  const w = world(t);
  put(w.claudeDir('alpha', 'SKILL.md'), 'somebody else owns this\n');

  const left = w.update();
  assert.match(left.out, /alpha {2}present but not installed by us — left alone/);
  assert.equal(read(w.claudeDir('alpha', 'SKILL.md')), 'somebody else owns this\n');
  assert.ok(!existsSync(join(w.claudeDir(), MANIFEST)), 'nothing was recorded');

  const adopted = w.update(['--adopt']);
  assert.match(adopted.out, /alpha {2}updated \(adopted\)/);
  assert.equal(read(w.claudeDir('alpha', 'SKILL.md')), read(w.file('alpha', 'SKILL.md')));
  assert.equal(readManifest(w.claudeDir()).skills.alpha.mode, 'copy');
});

// ---- retired aliases: install and update bring the successor (O-6, one release) --

const aliasWorld = (t) => world(t, {
  alpha: ['Alpha body.'],
  'angular-code-quality': ['Deprecated alias. Holds no rules.'],
  'backend-code-quality': ['Deprecated alias. Holds no rules.'],
  'code-quality': ['The rules.'],
});
const SUCCESSOR_ADDED = /\+ code-quality {2}\(successor of angular-code-quality — installed\)/;
const COLLISION = /code-quality {2}needed by the angular-code-quality alias, which holds no rules — resolve this collision/;
const installCollision = (alias, why) => new RegExp(`! code-quality {2}needed by the ${alias} alias, which holds no rules — ${why}, left alone`);

// An install made before the successor existed: the alias alone, recorded.
function aliasOnlyInstall(w, mode, alias = 'angular-code-quality') {
  assert.equal(w.run(['install', mode, alias]).status, 0);
  rmSync(w.claudeDir('code-quality'), { recursive: true, force: true });
  const manifestPath = join(w.claudeDir(), MANIFEST);
  const m = readManifest(w.claudeDir());
  delete m.skills['code-quality'];
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  assert.ok(!existsSync(w.claudeDir('code-quality')));
}

for (const [mode, alias] of [['--link', 'angular-code-quality'], ['--copy', 'angular-code-quality'],
  ['--link', 'backend-code-quality'], ['--copy', 'backend-code-quality']]) {
  test(`a selective ${mode} install of ${alias} also installs code-quality, with no update`, (t) => {
    const w = aliasWorld(t);
    const r = w.run(['install', mode, alias]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`code-quality {2}→ claude {2}\\(successor of ${alias}\\)`));
    assert.match(r.out, /installed 2\/2 skill/);
    const dst = w.claudeDir('code-quality');
    assert.equal(lstatSync(dst).isSymbolicLink(), mode === '--link');
    assert.equal(read(join(dst, 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
    assert.equal(readManifest(w.claudeDir()).skills['code-quality'].mode, mode.slice(2));
    assert.ok(!existsSync(w.claudeDir('alpha')), 'nothing else was installed');
  });
}

test('installing both aliases installs code-quality once', (t) => {
  const w = aliasWorld(t);
  const r = w.run(['install', '--copy', 'angular-code-quality', 'backend-code-quality']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /installed 3\/3 skill/);
  assert.equal(r.out.match(/successor of/g).length, 1);
});

test('install leaves a foreign successor directory alone and reports the collision', (t) => {
  const w = aliasWorld(t);
  put(w.claudeDir('code-quality', 'SKILL.md'), 'somebody else owns this\n');
  const r = w.run(['install', '--copy', 'backend-code-quality']);
  assert.match(r.out, installCollision('backend-code-quality', 'present but not installed by us'));
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'somebody else owns this\n');
  assert.equal(readManifest(w.claudeDir()).skills['code-quality'], undefined);
});

test('install leaves an edited successor alone and reports the collision', (t) => {
  const w = aliasWorld(t);
  w.run(['install', '--copy', 'angular-code-quality']);
  writeFileSync(w.claudeDir('code-quality', 'SKILL.md'), 'my own edit\n');
  const r = w.run(['install', '--copy', 'angular-code-quality']);
  assert.match(r.out, installCollision('angular-code-quality', 'edited after install'));
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'my own edit\n');
});

test('install leaves a successor symlink that is not ours alone', (t) => {
  const w = aliasWorld(t);
  const elsewhere = join(w.root, 'elsewhere-cq');
  put(join(elsewhere, 'SKILL.md'), 'another collection\n');
  mkdirSync(w.claudeDir(), { recursive: true });
  try { symlinkSync(elsewhere, w.claudeDir('code-quality'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('symlinks not permitted here'); return; }
  const r = w.run(['install', '--copy', 'angular-code-quality']);
  assert.match(r.out, installCollision('angular-code-quality', 'a symlink that is not ours'));
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'another collection\n');
});

// The same protection holds when code-quality is named or part of a bare install.
const namedCollision = (why) => new RegExp(`! code-quality {2}${why}, left alone; resolve this collision or re-run with --force`);

function foreignLink(t, w) {
  const elsewhere = join(w.root, 'elsewhere-cq');
  put(join(elsewhere, 'SKILL.md'), 'another collection\n');
  mkdirSync(w.claudeDir(), { recursive: true });
  try { symlinkSync(elsewhere, w.claudeDir('code-quality'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('symlinks not permitted here'); return false; }
  return true;
}

for (const mode of ['--copy', '--link']) {
  test(`a bare ${mode} install leaves an edited code-quality alone and installs the rest`, (t) => {
    const w = aliasWorld(t);
    w.run(['install', '--copy', 'code-quality']);
    writeFileSync(w.claudeDir('code-quality', 'SKILL.md'), 'my own edit\n');
    const r = w.run(['install', mode]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, namedCollision('edited after install'));
    assert.match(r.out, /installed 3\/4 skill.*1 left alone/);
    assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'my own edit\n');
    assert.ok(existsSync(w.claudeDir('alpha', 'SKILL.md')));
  });

  test(`a bare ${mode} install leaves a foreign code-quality symlink alone`, (t) => {
    const w = aliasWorld(t);
    if (!foreignLink(t, w)) return;
    const r = w.run(['install', mode]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, namedCollision('a symlink that is not ours'));
    assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'another collection\n');
  });

  test(`a repeated ${mode} install of an alias is idempotent`, (t) => {
    const w = aliasWorld(t);
    assert.equal(w.run(['install', mode, 'angular-code-quality']).status, 0);
    w.writeSkill('code-quality', ['The rules, revised.']);
    const r = w.run(['install', mode, 'angular-code-quality']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /left alone/);
    assert.match(read(w.claudeDir('code-quality', 'SKILL.md')), /The rules, revised\./, 'an untouched managed successor is refreshed');
  });
}

test('a bare install leaves a code-quality directory it never installed alone', (t) => {
  const w = aliasWorld(t);
  put(w.claudeDir('code-quality', 'SKILL.md'), 'somebody else owns this\n');
  const r = w.run(['install', '--copy']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, namedCollision('present but not installed by us'));
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'somebody else owns this\n');
});

test('naming the alias and code-quality keeps an edited code-quality; --force replaces it', (t) => {
  const w = aliasWorld(t);
  w.run(['install', '--copy', 'angular-code-quality']);
  writeFileSync(w.claudeDir('code-quality', 'SKILL.md'), 'my own edit\n');
  const r = w.run(['install', '--copy', 'angular-code-quality', 'code-quality']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, namedCollision('edited after install'));
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'my own edit\n');
  const forced = w.run(['install', '--copy', '--force', 'angular-code-quality', 'code-quality']);
  assert.equal(forced.status, 0, forced.out);
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
});

test('install --replace-foreign backs up a foreign code-quality an alias needs, then installs it', (t) => {
  const w = aliasWorld(t);
  put(w.claudeDir('code-quality', 'SKILL.md'), 'somebody else owns this\n');
  const r = w.run(['install', '--copy', '--replace-foreign', 'angular-code-quality']);
  assert.equal(r.status, 0, r.out);
  const backup = movedTo('code-quality', r.out);
  assert.ok(existsSync(join(backup, 'SKILL.md')), `the backup holds the moved entry: ${backup}`);
  assert.equal(read(join(backup, 'SKILL.md')), 'somebody else owns this\n');
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
  assert.ok(readManifest(w.claudeDir()).skills['code-quality'].hash, 'the installed successor is recorded');
});

// --force replaces the successor, but never without a backup of what was there.
for (const extra of [[], ['--replace-foreign']]) {
  test(`install ${['--force', ...extra].join(' ')} backs up a foreign code-quality before replacing it`, (t) => {
    const w = aliasWorld(t);
    put(w.claudeDir('code-quality', 'SKILL.md'), 'somebody else owns this\n');
    put(w.claudeDir('code-quality', 'notes', 'unique.txt'), 'only copy of this\n');
    const r = w.run(['install', '--copy', '--force', ...extra, 'code-quality']);
    assert.equal(r.status, 0, r.out);
    const backup = movedTo('code-quality', r.out);
    assert.ok(existsSync(join(backup, 'notes', 'unique.txt')), `the backup holds the moved entry: ${backup}`);
    assert.equal(read(join(backup, 'SKILL.md')), 'somebody else owns this\n');
    assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
  });
}

test('install --copy --force over an edited code-quality keeps the edit in a backup', (t) => {
  const w = aliasWorld(t);
  assert.equal(w.run(['install', '--copy', 'code-quality']).status, 0);
  writeFileSync(w.claudeDir('code-quality', 'SKILL.md'), 'my own edit\n');
  const r = w.run(['install', '--copy', '--force', 'code-quality']);
  assert.equal(r.status, 0, r.out);
  const backup = movedTo('code-quality', r.out);
  assert.ok(existsSync(join(backup, 'SKILL.md')), `the backup holds the moved entry: ${backup}`);
  assert.equal(read(join(backup, 'SKILL.md')), 'my own edit\n');
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
});

test('install --force does not replace a non-successor entry that is not ours', (t) => {
  const w = twoSkills(t);
  put(w.claudeDir('beta', 'SKILL.md'), 'my own beta\n');
  const r = w.run(['install', '--link', '--force']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, leftAlone('beta', 'present but not installed by us'));
  assert.equal(read(w.claudeDir('beta', 'SKILL.md')), 'my own beta\n');
});

// The legacy bash installer writes no manifest, so update cannot repair an
// alias-only install made with it: it refuses the alias names instead.
for (const alias of ['angular-code-quality', 'backend-code-quality']) {
  test(`scripts/install.sh refuses the rule-less alias ${alias}`, (t) => {
    if (process.platform === 'win32') { t.skip('bash installer is not run on Windows'); return; }
    const w = aliasWorld(t);
    cpSync(join(SCRIPTS, 'install.sh'), join(w.lib, 'scripts', 'install.sh'));
    const sh = (args) => spawnSync('bash', [join(w.lib, 'scripts', 'install.sh'), ...args],
      { cwd: w.root, env: childEnv({ HOME: w.home }), encoding: 'utf8' });
    for (const mode of ['--copy', '--link']) {
      const r = sh([mode, alias]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`${alias} is a deprecated alias with no rules: install code-quality instead`));
      assert.ok(!existsSync(w.claudeDir(alias)), 'the alias was not installed');
    }
    // Positive control in link mode (a --copy run exited 1 on its last line before the collision rule).
    const ok = sh(['--link', 'code-quality']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
  });
}

test('update installs the successor of an older alias-only link install', (t) => {
  const w = aliasWorld(t);
  aliasOnlyInstall(w, '--link');
  const r = w.update();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, SUCCESSOR_ADDED);
  assert.ok(lstatSync(w.claudeDir('code-quality')).isSymbolicLink(), 'linked like the alias');
  assert.equal(realpathSync(w.claudeDir('code-quality')), realpathSync(w.file('code-quality')));
  assert.ok(!existsSync(w.claudeDir('alpha')), 'nothing else was adopted');
});

test('update installs the successor of an older alias-only copy install', (t) => {
  const w = aliasWorld(t);
  aliasOnlyInstall(w, '--copy');
  const r = w.update();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, SUCCESSOR_ADDED);
  assert.ok(!lstatSync(w.claudeDir('code-quality')).isSymbolicLink());
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), read(w.file('code-quality', 'SKILL.md')));
  assert.ok(readManifest(w.claudeDir()).skills['code-quality'].hash, 'the successor copy is recorded');
});

test('update gives the successor the alias install mode, not the directory default', (t) => {
  const w = aliasWorld(t);
  aliasOnlyInstall(w, '--link');
  w.run(['install', '--copy', 'alpha']);               // the directory default is now copy
  assert.equal(readManifest(w.claudeDir()).mode, 'copy');
  const r = w.update();
  assert.match(r.out, SUCCESSOR_ADDED);
  assert.ok(lstatSync(w.claudeDir('code-quality')).isSymbolicLink(), 'linked like the alias');
});

test('a selective install with no alias does not gain the successor', (t) => {
  const w = aliasWorld(t);
  w.run(['install', '--copy', 'alpha']);
  const r = w.update();
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /code-quality/);
  assert.ok(!existsSync(w.claudeDir('code-quality')));
});

test('update treats a foreign successor directory as a collision and leaves it alone', (t) => {
  const w = aliasWorld(t);
  aliasOnlyInstall(w, '--copy');
  put(w.claudeDir('code-quality', 'SKILL.md'), 'somebody else owns this\n');
  const r = w.update();
  assert.match(r.out, /code-quality {2}present but not installed by us — left alone/);
  assert.match(r.out, COLLISION);
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'somebody else owns this\n');
  assert.equal(readManifest(w.claudeDir()).skills['code-quality'], undefined);
});

test('update treats an edited successor as a collision and keeps its edits', (t) => {
  const w = aliasWorld(t);
  w.run(['install', '--copy', 'angular-code-quality']);
  writeFileSync(w.claudeDir('code-quality', 'SKILL.md'), 'my own edit\n');
  w.writeSkill('code-quality', ['The rules, revised.']);
  const r = w.update();
  assert.match(r.out, /code-quality {2}edited after install — left alone/);
  assert.match(r.out, COLLISION);
  assert.equal(read(w.claudeDir('code-quality', 'SKILL.md')), 'my own edit\n');
});

test('update does not trust the records of a manifest from another library', (t) => {
  const w = world(t);
  w.run(['install', '--copy', 'alpha']);
  const manifestPath = join(w.claudeDir(), MANIFEST);
  const foreign = { ...readManifest(w.claudeDir()), origin: 'https://example.com/other/library' };
  writeFileSync(manifestPath, JSON.stringify(foreign));
  // The installed copy is untouched, so a trusted record WOULD let this refresh.
  w.writeSkill('alpha', ['Alpha body, revised.']);
  const oldText = read(w.claudeDir('alpha', 'SKILL.md'));

  const r = w.update();
  assert.match(r.out, /installed by a different library \(https:\/\/example\.com\/other\/library\)/);
  assert.match(r.out, /alpha {2}present but not installed by us — left alone/);
  assert.equal(read(w.claudeDir('alpha', 'SKILL.md')), oldText);
  assert.equal(readManifest(w.claudeDir()).origin, 'https://example.com/other/library', 'foreign record not rewritten as ours');

  const forced = w.update(['--force']);
  assert.match(forced.out, /alpha {2}present but not installed by us — left alone/);
  assert.equal(read(w.claudeDir('alpha', 'SKILL.md')), oldText);
});

// ---- install targets ---------------------------------------------------------

for (const [name, spec] of [
  ['install --target antigravity writes to the documented directory only', 'antigravity'],
  ['install --target all never writes to the legacy antigravity directory', 'all'],
]) {
  test(name, (t) => {
    const w = world(t);
    const r = w.run(['install', '--copy', '--target', spec, 'alpha']);
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(w.home, '.gemini', 'config', 'skills', 'alpha', 'SKILL.md')));
    assert.ok(!existsSync(join(w.home, '.gemini', 'antigravity')), 'the legacy directory was not created');
  });
}

test('the legacy antigravity directory is not an installable target', (t) => {
  const w = world(t);
  for (const key of ['antigravity-legacy', 'antigravity (legacy path)']) {
    const r = w.run(['install', '--copy', '--target', key, 'alpha']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /unknown target\(s\)/);
  }
  assert.ok(!existsSync(join(w.home, '.gemini', 'antigravity')));
});

test('a plain update still refreshes a copy installed in the legacy antigravity directory', (t) => {
  const w = world(t);
  const legacy = join(w.home, '.gemini', 'antigravity', 'skills');
  const installed = w.run(['install', '--copy', '--dest', legacy, 'alpha']);
  assert.equal(installed.status, 0, installed.out);
  w.writeSkill('alpha', ['Alpha body, revised.']);

  const r = w.update();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[antigravity \(legacy path\)\]/);
  assert.match(r.out, /alpha {2}updated/);
  assert.match(read(join(legacy, 'alpha', 'SKILL.md')), /Alpha body, revised\./);
  assert.ok(!existsSync(join(w.home, '.gemini', 'config')), 'the new directory was not created by update');
});

// ---- update inside the legacy antigravity directory ----------------------------

const legacyDir = (w) => join(w.home, '.gemini', 'antigravity', 'skills');

test('update leaves an unrecorded directory in the legacy directory alone and --adopt takes it over', (t) => {
  const w = world(t);
  put(join(legacyDir(w), 'alpha', 'SKILL.md'), 'somebody else owns this\n');

  const left = w.update();
  assert.match(left.out, /\[antigravity \(legacy path\)\]/);
  assert.match(left.out, /alpha {2}present but not installed by us — left alone/);
  assert.equal(read(join(legacyDir(w), 'alpha', 'SKILL.md')), 'somebody else owns this\n');

  const adopted = w.update(['--adopt']);
  assert.match(adopted.out, /alpha {2}updated \(adopted\)/);
  assert.equal(read(join(legacyDir(w), 'alpha', 'SKILL.md')), read(w.file('alpha', 'SKILL.md')));
});

test('update does not trust a manifest in the legacy directory that names another library', (t) => {
  const w = world(t);
  w.run(['install', '--copy', '--dest', legacyDir(w), 'alpha']);
  const manifestPath = join(legacyDir(w), MANIFEST);
  writeFileSync(manifestPath, JSON.stringify({ ...readManifest(legacyDir(w)), origin: 'https://example.com/other/library' }));
  w.writeSkill('alpha', ['Alpha body, revised.']);
  const oldText = read(join(legacyDir(w), 'alpha', 'SKILL.md'));

  const r = w.update();
  assert.match(r.out, /installed by a different library/);
  assert.equal(read(join(legacyDir(w), 'alpha', 'SKILL.md')), oldText);
});

test('update --prune in the legacy directory removes only what the manifest recorded', (t) => {
  const w = world(t, { alpha: ['Alpha body.'], beta: ['Beta body.'] });
  w.run(['install', '--copy', '--dest', legacyDir(w), 'alpha', 'beta']);
  put(join(legacyDir(w), 'gamma', 'SKILL.md'), 'not ours, not in the library\n');
  rmSync(w.file('beta'), { recursive: true, force: true });

  const r = w.update(['--prune']);
  assert.match(r.out, /beta {2}\(removed upstream — removed\)/);
  assert.ok(!existsSync(join(legacyDir(w), 'beta')), 'the recorded, removed skill is gone');
  assert.ok(existsSync(join(legacyDir(w), 'alpha', 'SKILL.md')));
  assert.equal(read(join(legacyDir(w), 'gamma', 'SKILL.md')), 'not ours, not in the library\n');
});

for (const [name, pick] of [
  ['--target', () => ['--target', 'claude']],
  ['--dest', (w) => ['--dest', join(w.home, 'elsewhere')]],
]) {
  test(`update ${name} does not touch the legacy directory`, (t) => {
    const w = world(t);
    w.run(['install', '--copy', 'alpha']);
    w.run(['install', '--copy', '--dest', join(w.home, 'elsewhere'), 'alpha']);
    w.run(['install', '--copy', '--dest', legacyDir(w), 'alpha']);
    const legacyBefore = read(join(legacyDir(w), 'alpha', 'SKILL.md'));
    w.writeSkill('alpha', ['Alpha body, revised.']);

    const r = w.update(pick(w));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /alpha {2}updated/);
    assert.doesNotMatch(r.out, /legacy/);
    assert.equal(read(join(legacyDir(w), 'alpha', 'SKILL.md')), legacyBefore);
  });
}

// ---- validator: baseline and planted violations -------------------------------

test('validate accepts a valid library', (t) => {
  const w = validWorld(t);
  const r = w.validate();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /✅ alpha/);
  assert.match(r.out, /✅ all skills valid/);
});

test('validate rejects a folder name that differs from the frontmatter name', (t) => {
  const w = validWorld(t);
  put(w.file('beta', 'SKILL.md'), skillMd('gamma'));
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ beta: folder name != frontmatter name \('gamma'\)/);
});

for (const [name, text, message] of [
  ['validate rejects a SKILL.md with no frontmatter', '# Beta\n\nNo frontmatter here.\n', /❌ beta: missing or empty frontmatter/],
  ['validate rejects frontmatter with no name', '---\ndescription: A skill.\n---\n\nBody.\n', /❌ beta: frontmatter has no 'name:'/],
  ['validate rejects frontmatter with no description', '---\nname: beta\n---\n\nBody.\n', /❌ beta: frontmatter has no 'description:'/],
]) {
  test(name, (t) => {
    const w = validWorld(t);
    put(w.file('beta', 'SKILL.md'), text);
    const r = w.validate();
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, message);
  });
}

test('validate rejects a skill directory with no SKILL.md', (t) => {
  const w = validWorld(t);
  put(w.file('beta', 'notes.txt'), 'no skill file here\n');
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ beta: no SKILL\.md/);
});

test('validate rejects a call to a shell script that is neither bundled nor generated', (t) => {
  const w = validWorld(t);
  w.writeSkill('beta', ['Run: bash missing-tool.sh first.']);
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ beta: calls 'missing-tool\.sh' but it is neither bundled nor created by the skill/);
});

test('validate rejects a dangling relative Markdown link', (t) => {
  const w = validWorld(t);
  w.writeSkill('beta', ['See [the guide](references/nope.md).']);
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ beta: .*SKILL\.md links to 'references\/nope\.md', which does not exist\./);
});

test('validate rejects a reference file that no link reaches', (t) => {
  const w = validWorld(t);
  w.writeSkill('beta', ['Body.'], { 'references/lonely.md': 'Nobody points here.\n' });
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ beta: references\/lonely\.md is not reachable by any link from SKILL\.md — orphaned\./);
});

test('validate rejects retired vocabulary in a skill', (t) => {
  const w = validWorld(t);
  w.writeSkill('beta', ['Pass the GATE 1 first.']);
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ beta: .*SKILL\.md:\d+ uses retired 'GATE 1' — there was never a GATE 1 or GATE 2/);
});

// code-quality owns the NG/BE rule rows, so the old row header is retired there too.
test('validate rejects the retired rule-row header in a code-quality stack reference', (t) => {
  const w = validWorld(t);
  w.writeSkill('code-quality', ['Angular: [stack](references/stack-angular.md).'],
    { 'references/stack-angular.md': 'Rows.\n\n| Rule | Status | Evidence |\n|---|---|---|\n' });
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ code-quality: code-quality[\\/]references[\\/]stack-angular\.md:3 uses retired '\| Rule \| Status \| Evidence \|' — routed rule rows use the canonical Subject ID \| Outcome \| Evidence shape/);
});

test('validate rejects retired vocabulary in a repo guidance file', (t) => {
  const w = validWorld(t);
  put(join(w.lib, 'AGENTS.md'), 'Pass the GATE 1 first.\n');
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ AGENTS\.md:1 uses retired 'GATE 1'/);
});

test('a guidance line that says the term is retired is not flagged, the same term elsewhere is', (t) => {
  const w = validWorld(t);
  put(join(w.lib, 'AGENTS.md'), 'GATE 1 was removed long ago.\nPass the GATE 1 first.\n');
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ AGENTS\.md:2 uses retired 'GATE 1'/);
  assert.doesNotMatch(r.out, /AGENTS\.md:1 /);
});

test('validate rejects an outcome vocabulary with two owners', (t) => {
  const w = validWorld(t);
  w.writeSkill('alpha', ['See [more](references/second.md).', '', ...VOCABULARY],
    { 'references/second.md': `${VOCABULARY.join('\n')}\n` });
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ alpha: the outcome vocabulary is defined in 2 files — it must have exactly one owner\./);
  assert.match(r.out, /❌ canonical outcome vocabulary has 2 owners — expected exactly one\./);
});

test('validate rejects a library where no file defines the outcome vocabulary', (t) => {
  const w = world(t);
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ canonical outcome vocabulary has 0 owners — expected exactly one\./);
});

test('validate rejects an outcome vocabulary that omits a token', (t) => {
  const w = world(t, { alpha: VOCABULARY.filter((l) => !l.startsWith('DEGRADED')) });
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /❌ alpha: the outcome vocabulary omits DEGRADED\./);
});

// ---- validator: cited rule IDs ------------------------------------------------

// Owners with the IDs they define. `alpha` cites; it also owns the vocabulary.
function citingWorld(t, citations, owners = {}) {
  const defaults = {
    'code-quality': ['Rules: BE-SEC-01, BE-SEC-02, BE-AUTH-01, BE-AUTH-02.'],
    'test-quality': ['Rules: TEST-01.'],
  };
  const w = validWorld(t, {});
  for (const [name, body] of Object.entries({ ...defaults, ...owners })) {
    if (!body) continue;
    // code-quality defines NG/BE only in its stack references.
    if (name === 'code-quality') writeStackBackend(w, body);
    else w.writeSkill(name, body);
  }
  w.writeSkill('alpha', [...citations, '', ...VOCABULARY]);
  return w;
}

function writeStackBackend(w, rules, entry = []) {
  w.writeSkill('code-quality', ['Backend: [stack](references/stack-backend.md).', ...entry],
    { 'references/stack-backend.md': `${rules.join('\n')}\n` });
}

// Only the stack references define NG/BE; a citation anywhere else in
// code-quality is checked against them, never defines itself.
test('an NG/BE ID cited outside the code-quality stack references must be defined in them', (t) => {
  const w = citingWorld(t, ['Intro.']);
  writeStackBackend(w, ['Rules: BE-SEC-01.'], ['', 'Cites BE-SEC-99 here.']);
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  const line = lineOf(read(w.file('code-quality', 'SKILL.md')), 'BE-SEC-99');
  assert.match(r.out, new RegExp(`❌ code-quality: code-quality/SKILL\\.md:${line} cites 'BE-SEC-99', which code-quality does not define\\.`));
});

function assertCited(w, id, needle = id) {
  const r = w.validate();
  const text = read(w.file('alpha', 'SKILL.md'));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`❌ alpha: alpha/SKILL\\.md:${lineOf(text, needle)} cites '${id}', which code-quality does not define\\.`));
  return r;
}

// The retired specialists are aliases now: a BE-* rule they still carried would
// not count, because only code-quality may define the NG/BE families.
test('a BE-* ID defined only in a retired specialist is still undefined', (t) => {
  const w = citingWorld(t, ['This follows BE-SEC-09.'], { 'backend-code-quality': ['Rules: BE-SEC-09.'] });
  assertCited(w, 'BE-SEC-09');
});

test('an undefined direct rule ID fails with its file and line', (t) => {
  const w = citingWorld(t, ['Intro.', 'This follows BE-SEC-09.']);
  assertCited(w, 'BE-SEC-09');
});

for (const sep of ['…', '..', '...', '–']) {
  test(`an undefined end of a range written with '${sep}' fails and names only that ID`, (t) => {
    const w = citingWorld(t, [`Read BE-AUTH-01${sep}03.`]);
    const r = assertCited(w, 'BE-AUTH-03', 'BE-AUTH-01');
    assert.doesNotMatch(r.out, /cites 'BE-AUTH-0[12]'/);
  });
}

test('an undefined member of a slash list fails', (t) => {
  const w = citingWorld(t, ['See BE-SEC-01/02/03.']);
  const r = assertCited(w, 'BE-SEC-03', 'BE-SEC-01');
  assert.doesNotMatch(r.out, /cites 'BE-SEC-0[12]'/);
});

test('an undefined member of a comma list fails', (t) => {
  const w = citingWorld(t, ['See BE-SEC-01, 02, 08.']);
  const r = assertCited(w, 'BE-SEC-08', 'BE-SEC-01');
  assert.doesNotMatch(r.out, /cites 'BE-SEC-0[12]'/);
});

test('an ID defined only inside a range in its owner is still undefined', (t) => {
  const w = citingWorld(t, ['See BE-AUTH-02.'], { 'code-quality': ['Rules: BE-AUTH-01…03.'] });
  assertCited(w, 'BE-AUTH-02');
});

// A range end that names another prefix or family is its own citation, not an end.
test('a range end with a different family is checked as its own citation', (t) => {
  const w = citingWorld(t, ['Read BE-SEC-01…BE-AUTH-09.']);
  const r = assertCited(w, 'BE-AUTH-09', 'BE-SEC-01');
  assert.doesNotMatch(r.out, /cites 'BE-SEC-0[2-9]'/, 'the head must not expand to the foreign end');
});

test('a range end with the same family as its head expands', (t) => {
  const w = citingWorld(t, ['Read BE-AUTH-01…BE-AUTH-03.'],
    { 'code-quality': ['Rules: BE-AUTH-01, BE-AUTH-03.'] });
  assertCited(w, 'BE-AUTH-02', 'BE-AUTH-01');
});

test('a reversed range checks every ID between its ends', (t) => {
  const w = citingWorld(t, ['Read BE-AUTH-03…01.'],
    { 'code-quality': ['Rules: BE-AUTH-01, BE-AUTH-03.'] });
  assertCited(w, 'BE-AUTH-02', 'BE-AUTH-03');
});

// A range end that repeats only the head's family is still a range.
for (const sep of ['…', '..']) {
  test(`a range end naming only the family, written with '${sep}', expands and names undefined members`, (t) => {
    const w = citingWorld(t, [`Read BE-AUTH-01${sep}AUTH-09 together.`]);
    const r = w.validate();
    const text = read(w.file('alpha', 'SKILL.md'));
    assert.equal(r.status, 1, r.out);
    for (const id of ['BE-AUTH-08', 'BE-AUTH-09']) {
      assert.match(r.out, new RegExp(`alpha/SKILL\\.md:${lineOf(text, 'BE-AUTH-01')} cites '${id}'`));
    }
    assert.doesNotMatch(r.out, /cites 'BE-AUTH-0[12]'/);
  });
}

test('a range end naming only the family passes when every member is defined', (t) => {
  const w = citingWorld(t, ['Read BE-AUTH-01…AUTH-03 together.'],
    { 'code-quality': ['Rules: BE-AUTH-01, BE-AUTH-02, BE-AUTH-03.'] });
  const r = w.validate();
  assert.equal(r.status, 0, r.out);
});

test('a range end with another family and no prefix is not guessed at', (t) => {
  const w = citingWorld(t, ['Read BE-AUTH-01…VAL-03 together.']);
  const r = w.validate();
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /cites/);
});

// A prose number after a comma is not part of the list.
test('a number after a comma that starts a phrase is not a citation', (t) => {
  const w = citingWorld(t, ['Here BE-SEC-01, 20 lines later.']);
  const r = w.validate();
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /cites/);
});

// A range or slash list is one whatever follows it.
for (const [name, line, id] of [
  ['a range followed by a word, as the tree writes it', 'walk BE-AUTH-01..03 from the backend skill', 'BE-AUTH-03'],
  ['a slash list followed by a word', 'A BE-SEC-01/20 ratio applies.', 'BE-SEC-20'],
]) {
  test(`${name} still fails on an undefined member`, (t) => {
    const w = citingWorld(t, [line]);
    assertCited(w, id, line);
  });
}

// The shapes the real tree uses, each with one undefined member.
for (const [name, line, id] of [
  ['a comma list at the end of a table cell', '| Must fix | BE-SEC-01, 02, 08 | Hide real bugs |', 'BE-SEC-08'],
  ['a comma list at the end of a line', 'Must fix: BE-SEC-01, 02, 08', 'BE-SEC-08'],
  ['a comma list before a dot separator', 'BE-SEC-01,08 · BE-AUTH-01', 'BE-SEC-08'],
  ['a slash list before a dot separator', 'BE-SEC-01/02/09 · BE-AUTH-01…02 ·', 'BE-SEC-09'],
  ['a range before a dot separator', 'BE-SEC-01/02 · BE-AUTH-01…03 · BE-SEC-01', 'BE-AUTH-03'],
  ['a range at the end of a line', 'walk BE-AUTH-01..03', 'BE-AUTH-03'],
]) {
  test(`${name} still fails on an undefined member`, (t) => {
    const w = citingWorld(t, [line]);
    const r = assertCited(w, id, line);
    assert.equal(r.out.match(/cites '/g).length, 1, `only the undefined member is named:\n${r.out}`);
  });
}

test('defined citations, wildcards, ticket keys and other prefixes do not fail', (t) => {
  const w = citingWorld(t, [
    'Defined: BE-SEC-01, BE-AUTH-01…02, TEST-01.',
    'A wildcard BE-SEC-* is not a citation.',
    'Ticket TICKET-E and CWE-22 and SHA-256 and KEY-123 and A11Y-01.',
  ]);
  const r = w.validate();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /✅ all skills valid/);
});

test('an undefined-looking ID in a test file or a JSON file is not a citation', (t) => {
  const w = citingWorld(t, ['Nothing cited here.']);
  put(w.file('alpha', 'check.test.mjs'), "assert.equal(id, 'BE-SEC-99');\n");
  put(w.file('alpha', 'data.json'), '{"rule": "BE-SEC-98"}\n');
  const r = w.validate();
  assert.equal(r.status, 0, r.out);
});

test('a citation whose owning skill is missing from the library fails', (t) => {
  const w = citingWorld(t, ['This follows TEST-01.'], { 'test-quality': null });
  const r = w.validate();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cites 'TEST-01', which test-quality does not define\. Its owner skill is missing from the library\./);
});

// ---- supported-runtime contract (OD-Q5: minimum Node.js is 22) -----------------
// package.json engines, the install.sh guard and the README must state one floor.

const REPO = join(SCRIPTS, '..');
const NODE_FLOOR = 22;

test('the supported Node floor is the same in package.json, install.sh and README', () => {
  const engines = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).engines.node;
  assert.equal(engines, `>=${NODE_FLOOR}`);

  const sh = readFileSync(join(REPO, 'install.sh'), 'utf8');
  const guard = sh.match(/"\$NODE_MAJOR" -lt (\d+)/);
  assert.ok(guard, 'install.sh has a NODE_MAJOR guard');
  assert.equal(Number(guard[1]), NODE_FLOOR);
  assert.match(sh, new RegExp(`Install Node\\.js ${NODE_FLOOR} or newer`));
  assert.match(sh, new RegExp(`this needs ${NODE_FLOOR} or newer`));

  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`Needs \`git\` and Node ${NODE_FLOOR}\\+`));
});

test('no support claim in README, AGENTS.md, install.sh or package.json names a Node below the floor', () => {
  // "Node 18", "Node.js](url) >= 18", "Node >= 18", "≥ 18": every number after such a lead must be the floor or more.
  const claim = /node(?:\.js)?(?:\]\([^)]*\))?["':\s]*(?:≥|>=)?\s*"?(\d{1,2})(?!\d)/gi;
  let seen = 0;
  for (const f of ['README.md', 'AGENTS.md', 'install.sh', 'package.json']) {
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const m of text.matchAll(claim)) {
      seen += 1;
      assert.ok(Number(m[1]) >= NODE_FLOOR, `${f} claims Node ${m[1]}: ${JSON.stringify(m[0])}`);
    }
  }
  assert.ok(seen >= 4, `the scan found the claims it is meant to police (${seen})`);
});

test('CI runs Node 22 only and every job in validate.yml has timeout-minutes', () => {
  for (const f of ['validate.yml']) {
    const yml = readFileSync(join(REPO, '.github', 'workflows', f), 'utf8');
    // Every node-version is the floor or a matrix reference; every matrix node list is the floor alone.
    const versions = [...yml.matchAll(/node-version:[ \t]*'?([^'\n]*?)'?[ \t]*$/gm)].map((m) => m[1]);
    assert.ok(versions.length >= 1, `${f} sets a node-version`);
    for (const v of versions) {
      assert.ok(v === '${{ matrix.node }}' || v === String(NODE_FLOOR), `${f} node-version ${v}`);
    }
    const lists = [...yml.matchAll(/^\s+node:\s*\[([^\]]*)\]/gm)].map((m) => m[1].replace(/['\s]/g, ''));
    for (const l of lists) assert.equal(l, String(NODE_FLOOR), `${f} matrix node list`);
    if (f === 'validate.yml') assert.equal(lists.length, 2, 'cli and harness matrices were found');
    // Every top-level job (two-space indent under jobs:) declares a timeout.
    const jobsText = yml.slice(yml.indexOf('\njobs:'));
    const blocks = jobsText.split(/^  (?=[A-Za-z][\w-]*:\s*$)/m).slice(1);
    assert.ok(blocks.length >= 1, `${f} has jobs`);
    for (const b of blocks) {
      const name = b.split(':')[0];
      assert.match(b, /^    timeout-minutes:\s*\d+\s*$/m, `${f} job ${name} has timeout-minutes`);
    }
    if (f === 'validate.yml') assert.equal(blocks.length, 4, 'validate, cli, harness, engine-properties');
  }
});

// Runs the real install.sh with a stand-in `node` and a `git` that records any call and fails. The
// clone target is an existing non-git directory, so a regressed guard is refused by install.sh itself.
function installWith(t, nodeMajorOutput) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ais-nodefloor-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const gitLog = join(root, 'git-called');
  put(join(bin, 'node'), `#!/bin/sh\ncase "$1" in -v) echo v0.0.0;; *) echo '${nodeMajorOutput}';; esac\n`);
  put(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${gitLog}'\nexit 1\n`);
  for (const b of ['node', 'git']) spawnSync('chmod', ['755', join(bin, b)]);
  const target = join(root, 'target');
  mkdirSync(target);
  const home = join(root, 'home');
  mkdirSync(home);
  const r = spawnSync('bash', [join(REPO, 'install.sh')], {
    encoding: 'utf8',
    timeout: 20000,
    env: childEnv({
      PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
      AI_SKILLS_HOME: target, AI_SKILLS_NO_AUTOUPDATE: '1',
    }),
  });
  return { r, gitCalled: existsSync(gitLog) };
}

test('install.sh refuses a Node below the floor and names the floor', (t) => {
  const { r, gitCalled } = installWith(t, String(NODE_FLOOR - 1));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`too old; this needs ${NODE_FLOOR} or newer`));
  assert.equal(gitCalled, false, 'the guard fires before any git call');
});

for (const [label, out] of [['empty', ''], ['non-numeric', 'abc'], ['partly numeric', '22x']]) {
  test(`install.sh refuses (fails closed) when the Node major is ${label}`, (t) => {
    const { r, gitCalled } = installWith(t, out);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /could not read the Node major version/);
    assert.equal(gitCalled, false, 'the guard fires before any git call');
  });
}

// The curl bootstrap passes --replace-foreign to the CLI only when AI_SKILLS_REPLACE_FOREIGN=1. A
// stand-in `git` "clones" an empty directory and a stand-in `node` records the CLI arguments.
for (const [value, expected] of [['1', true], [undefined, false], ['yes', false]]) {
  test(`install.sh passes --replace-foreign only for AI_SKILLS_REPLACE_FOREIGN=1 (${value ?? 'unset'})`, unixOnly, (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ais-replace-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    const argLog = join(root, 'node-args');
    put(join(bin, 'node'), `#!/bin/sh\ncase "$1" in -v) echo v${NODE_FLOOR}.0.0;; -p) echo ${NODE_FLOOR};; *) echo "$@" >> '${argLog}';; esac\n`);
    put(join(bin, 'git'), '#!/bin/sh\n[ "$1" = clone ] && for a; do last="$a"; done && mkdir -p "$last"\nexit 0\n');
    for (const b of ['node', 'git']) spawnSync('chmod', ['755', join(bin, b)]);
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, AI_SKILLS_HOME: join(root, 'clone'), AI_SKILLS_NO_AUTOUPDATE: '1' };
    if (value !== undefined) env.AI_SKILLS_REPLACE_FOREIGN = value;
    const drop = value === undefined ? { AI_SKILLS_REPLACE_FOREIGN: undefined } : {};
    const r = spawnSync('bash', [join(REPO, 'install.sh')], { encoding: 'utf8', timeout: 20000, env: Object.fromEntries(Object.entries(childEnv({ ...env, ...drop })).filter(([, v]) => v !== undefined)) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const install = read(argLog).split('\n').find((l) => / install --link --target claude/.test(l));
    assert.ok(install, `the CLI install call was made:\n${read(argLog)}`);
    assert.equal(install.includes('--replace-foreign'), expected, install);
  });
}

test('install.sh says automatic updates were not scheduled when the install stops, and names the env var', unixOnly, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ais-stop-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const argLog = join(root, 'node-args');
  put(join(bin, 'node'), `#!/bin/sh\ncase "$1" in -v) echo v${NODE_FLOOR}.0.0;; -p) echo ${NODE_FLOOR};; *) echo "$@" >> '${argLog}'; case "$*" in *' install '*) exit 1;; esac;; esac\n`);
  put(join(bin, 'git'), '#!/bin/sh\n[ "$1" = clone ] && for a; do last="$a"; done && mkdir -p "$last"\nexit 0\n');
  for (const b of ['node', 'git']) spawnSync('chmod', ['755', join(bin, b)]);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = Object.fromEntries(Object.entries(childEnv({
    PATH: `${bin}:${process.env.PATH}`, HOME: home, AI_SKILLS_HOME: join(root, 'clone'),
    AI_SKILLS_NO_AUTOUPDATE: undefined, AI_SKILLS_REPLACE_FOREIGN: undefined,
  })).filter(([, v]) => v !== undefined));
  const r = spawnSync('bash', [join(REPO, 'install.sh')], { encoding: 'utf8', timeout: 20000, env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /automatic updates were NOT scheduled/);
  assert.match(r.stderr, /AI_SKILLS_REPLACE_FOREIGN=1/);
  assert.ok(read(argLog).includes(' install --link'), 'the install ran');
  assert.ok(!read(argLog).includes('autoupdate'), 'nothing was scheduled');
});

// ---- the repository rename: one library under two names -----------------------------------------
// AI-Skills was renamed agentic-software-factory. Clones and manifests made before keep the old
// remote, so identity (never a recorded value) treats the two names as ONE library.

const OLD_HTTPS = 'https://github.com/AhmedAbdelfattah0/AI-Skills.git';
const OLD_SCP = 'git@github.com:AhmedAbdelfattah0/AI-Skills.git';
const NEW_HTTPS = 'https://github.com/AhmedAbdelfattah0/agentic-software-factory.git';
const NEW_SCP = 'git@github.com:AhmedAbdelfattah0/agentic-software-factory';

function gitIn(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: childEnv({ GIT_CEILING_DIRECTORIES: dirname(dir) }) });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

// Install under one origin, then look at the library from another. Returns what update says.
function updateAcross(t, installedAs, nowAt) {
  const w = world(t);
  gitIn(w.lib, ['init', '-q']);
  gitIn(w.lib, ['remote', 'add', 'origin', installedAs]);
  const i = w.run(['install', '--copy', 'alpha']);
  assert.equal(i.status, 0, i.out);
  gitIn(w.lib, ['remote', 'set-url', 'origin', nowAt]);
  const before = readFileSync(join(w.claudeDir(), MANIFEST), 'utf8');
  const r = w.run(['update', '--no-pull']);
  return { w, r, before };
}

for (const [label, was, now] of [
  ['old manifest, new clone', OLD_HTTPS, NEW_HTTPS],
  ['new manifest, old clone', NEW_HTTPS, OLD_SCP],
  ['old manifest, old clone (scp)', OLD_SCP, OLD_HTTPS],
  ['new manifest, new clone (scp)', NEW_SCP, NEW_HTTPS],
]) {
  test(`update treats the two repository names as one library (${label})`, (t) => {
    const { r, w } = updateAcross(t, was, now);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /installed by a different library/, r.out);
    // Positive signal: the record was trusted, so the unchanged copy is reported as current.
    assert.match(r.out, /1 already current/, r.out);
    assert.ok(readManifest(w.claudeDir()).skills.alpha, 'record kept');
  });
}

// A recorded origin is never rewritten by the alias: older code reads it back and must still agree.
for (const [label, origin, recorded] of [
  ['old-origin clone', OLD_HTTPS, 'https://github.com/ahmedabdelfattah0/ai-skills'],
  ['new-origin clone', NEW_HTTPS, 'https://github.com/ahmedabdelfattah0/agentic-software-factory'],
]) {
  test(`install and a changing update record the clone's own origin (${label})`, (t) => {
    const w = world(t);
    gitIn(w.lib, ['init', '-q']);
    gitIn(w.lib, ['remote', 'add', 'origin', origin]);
    const i = w.run(['install', '--copy', 'alpha']);
    assert.equal(i.status, 0, i.out);
    assert.equal(readManifest(w.claudeDir()).origin, recorded, 'recorded by install');
    const hashBefore = readManifest(w.claudeDir()).skills.alpha.hash;
    w.writeSkill('alpha', ['Alpha body, revised.']);
    const u = w.run(['update', '--no-pull']);
    assert.equal(u.status, 0, u.out);
    assert.notEqual(readManifest(w.claudeDir()).skills.alpha.hash, hashBefore, 'the update really changed the copy');
    assert.equal(readManifest(w.claudeDir()).origin, recorded, 'recorded by update');
  });
}

for (const other of ['https://github.com/AhmedAbdelfattah0/other-repo.git', 'https://github.com/someone-else/AI-Skills.git']) {
  test(`update keeps a different repository foreign (${other})`, (t) => {
    const { r, w, before } = updateAcross(t, NEW_HTTPS, other);
    assert.match(r.out, /installed by a different library/);
    assert.equal(readFileSync(join(w.claudeDir(), MANIFEST), 'utf8'), before, 'manifest untouched');
  });
}

// install.sh over an EXISTING clone: the identity check runs before any fetch. A git shim fails the
// fetch with a marker, so reaching the marker proves the check passed without touching the network.
function installShOver(t, origin) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ais-rename-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clone = join(root, 'clone');
  mkdirSync(clone);
  gitIn(clone, ['init', '-q', '-b', 'main']);
  if (origin) gitIn(clone, ['remote', 'add', 'origin', origin]);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(root, 'bin');
  put(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" fetch "*) echo FETCH-REACHED >&2; exit 1;; esac\nexec '${realGit}' "$@"\n`);
  spawnSync('chmod', ['755', join(bin, 'git')]);
  const home = join(root, 'home');
  mkdirSync(home);
  const r = spawnSync('bash', [join(REPO, 'install.sh')], {
    encoding: 'utf8', timeout: 20000,
    env: childEnv({ PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home, AI_SKILLS_HOME: clone, AI_SKILLS_NO_AUTOUPDATE: '1' }),
  });
  return `${r.stdout}${r.stderr}`;
}

for (const origin of [OLD_HTTPS, OLD_SCP, 'https://github.com/AhmedAbdelfattah0/AI-Skills', NEW_HTTPS, NEW_SCP]) {
  test(`install.sh accepts an existing clone whose origin is ${origin}`, unixOnly, (t) => {
    const out = installShOver(t, origin);
    assert.match(out, /FETCH-REACHED/, out);
    assert.doesNotMatch(out, /origin is not this project/);
  });
}

for (const origin of ['https://github.com/someone-else/AI-Skills.git', 'https://github.com/AhmedAbdelfattah0/other.git', null]) {
  test(`install.sh still refuses an existing clone whose origin is ${origin}`, unixOnly, (t) => {
    const out = installShOver(t, origin);
    assert.match(out, /origin is not this project/, out);
    assert.doesNotMatch(out, /FETCH-REACHED/);
  });
}
