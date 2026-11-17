// S-02a0a tests: node --test skills/ship-ticket/scripts/lib/git-capability.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CAPABILITIES, GIT_FLOOR, PARTIAL_CLONE_FLOOR, assertGitCapable, atLeast, parseGitVersion, probeGit, resolveGitBinary,
} from './git-capability.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== 'win32';
const code = (c) => (e) => { assert.equal(e.code, c); assert.equal(e.message, c); return true; };
function tmp(t) {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-cap-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function fakeGit(dir, body) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'git');
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}
const info = (v, pre = false) => ({ version: v, prerelease: pre });

// ------------------------------------------------------------------ version parsing (AC2)

test('suffixed versions parse to the leading X.Y.Z with the pre-release flag', () => {
  const cases = [
    ['git version 2.39.5 (Apple Git-154)\n', [2, 39, 5], false],
    ['git version 2.45.0.windows.1\n', [2, 45, 0], false],
    ['git version 2.45.0.windows.1\r\n', [2, 45, 0], false],
    ['git version 2.46.0.rc1.windows.1\n', [2, 46, 0], true],
    ['git version 2.45.0.rc0\n', [2, 45, 0], true],
    ['git version 2.45.0-rc0\n', [2, 45, 0], true],
    ['git version 2.55.0\n', [2, 55, 0], false],
    ['git version 10.0.0', [10, 0, 0], false],
  ];
  for (const [out, version, prerelease] of cases) {
    const p = parseGitVersion(Buffer.from(out, 'latin1'));
    assert.deepEqual([p.version, p.prerelease], [version, prerelease], out);
    assert.equal(p.raw, out.trimEnd());
  }
});

test('malformed version output is refused with a code-only message', () => {
  const bad = [
    '', 'git version\n', 'git version 2.45\n', 'git version 2.45.GIT\n', 'Git version 2.45.0\n',
    'xgit version 2.45.0\n', 'git version 2.45.0\ngit version 9.9.9\n', 'git version 2.45.0 (Apple Git-154\n',
    'git version 2.45.0\0\n', 'git version 999999.0.0\n', 'git version 2.45.0 ' + 'x'.repeat(300),
  ].map((s) => Buffer.from(s, 'latin1'));
  bad.push(Buffer.from([...Buffer.from('git version 2.45.0 (caf'), 0xc3, 0xa9, 0x29, 0x0a]));
  bad.push(Buffer.from([...Buffer.from('git version 2.45.0 (x'), 0xff, 0x29]));
  for (const b of bad) assert.throws(() => parseGitVersion(b), code('git_version_unparseable'), JSON.stringify(b.toString('latin1')));
});

// ------------------------------------------------------------------ floors (AC1)

test('the general floor is 2.32.0 and a pre-release of the floor is below it', () => {
  assert.deepEqual(GIT_FLOOR, [2, 32, 0]);
  assert.throws(() => assertGitCapable(info([2, 31, 9])), code('git_version_below_floor'));
  assert.throws(() => assertGitCapable(info([1, 99, 99])), code('git_version_below_floor'));
  assert.throws(() => assertGitCapable(info([2, 32, 0], true)), code('git_version_below_floor'));
  for (const v of [[2, 32, 0], [2, 32, 1], [2, 100, 0], [3, 0, 0]]) assert.equal(assertGitCapable(info(v)).version, v);
  assert.equal(assertGitCapable(parseGitVersion('git version 2.39.5 (Apple Git-154)\n')).version[1], 39);
});

test('partial clones need 2.45.0; below it they are refused, above it lazy fetch is flagged off', () => {
  assert.deepEqual(PARTIAL_CLONE_FLOOR, [2, 45, 0]);
  const pc = { partialClone: true };
  assert.throws(() => assertGitCapable(info([2, 44, 9]), pc), code('partial_clone_unsupported'));
  assert.throws(() => assertGitCapable(parseGitVersion('git version 2.45.0-rc0'), pc), code('partial_clone_unsupported'));
  assert.throws(() => assertGitCapable(parseGitVersion('git version 2.39.5 (Apple Git-154)'), pc), code('partial_clone_unsupported'));
  assert.ok(assertGitCapable(parseGitVersion('git version 2.45.0.windows.1'), pc));
  assert.ok(assertGitCapable(info([2, 44, 9])), 'no partial clone: only the general floor applies');
  assert.equal(atLeast(info([2, 45, 0]), PARTIAL_CLONE_FLOOR), true);
  assert.equal(atLeast(info([2, 44, 99]), PARTIAL_CLONE_FLOOR), false);
});

test('the capability table pins every mechanism within its enforced floor and never claims 2.44', () => {
  assert.ok(Object.isFrozen(CAPABILITIES) && CAPABILITIES.every(Object.isFrozen));
  const floorOf = { floor: GIT_FLOOR, 'partial-clone-floor': PARTIAL_CLONE_FLOOR };
  for (const c of CAPABILITIES) {
    assert.match(c.evidence, /\.adoc/, c.id);
    assert.ok(!String(c.since).startsWith('2.44'), c.id);
    if (/^not-relied-on/.test(c.enforcement)) continue; // documented, never assumed at a floor
    assert.ok(atLeast(info(floorOf[c.enforcement]), c.since.split('.').map(Number)), `${c.id} ${c.since} above its floor`);
  }
  const since = Object.fromEntries(CAPABILITIES.map((c) => [c.id, [c.since, c.enforcement.split(' ')[0]]]));
  assert.deepEqual(since['--no-lazy-fetch'], ['2.45.0', 'partial-clone-floor']);
  assert.deepEqual(since['--end-of-options (parse-options commands)'], ['2.24.0', 'floor']);
  assert.deepEqual(since['rev-parse --end-of-options'], ['2.30.0', 'floor']);
  assert.deepEqual(since['--end-of-options <rev> -- <path>'], ['2.43.1', 'not-relied-on'], 'combined form is above the 2.32 floor');
  assert.deepEqual(since.GIT_GRAFT_FILE, [null, 'not-relied-on:']);
});

// ------------------------------------------------------------------ binary resolution (AC3)

test('POSIX: empty, relative, cwd and candidate-tree PATH entries never resolve', { skip: !posix && 'POSIX resolver' }, (t) => {
  const root = tmp(t);
  const good = fakeGit(join(root, 'good'), 'echo "git version 2.55.0"');
  const gd = dirname(good);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const plant = join(root, 'plant');
  fakeGit(plant, 'echo planted');
  fakeGit(join(plant, 'sub'), 'echo planted');
  const cand = join(root, 'cand');
  fakeGit(join(cand, 'node_modules', '.bin'), 'echo planted');
  mkdirSync(join(root, 'link'));
  symlinkSync(join(cand, 'node_modules', '.bin', 'git'), join(root, 'link', 'git'));
  const r = (PATH, cwd = plant, exclude = [cand]) => resolveGitBinary({ env: { PATH }, cwd, exclude });

  // Control: an absolute plant dir outside cwd and exclusions is chosen, so the refusals below are real.
  assert.equal(r(`${plant}:${gd}`, elsewhere, []), join(plant, 'git'));
  assert.equal(r(`:${gd}`), good);
  assert.equal(r(`.:${gd}`), good);
  assert.equal(r(`sub:${gd}`), good);
  assert.equal(r(`${plant}:${gd}`), good);
  assert.equal(r(`${join(plant, 'sub')}:${gd}`), good);
  assert.equal(r(`${join(cand, 'node_modules', '.bin')}:${gd}`, elsewhere), good);
  assert.equal(r(`${join(root, 'link')}:${gd}`, elsewhere), good, 'symlink into the candidate tree');
  assert.equal(r(`${join(root, 'link')}:${gd}`, elsewhere, []), join(cand, 'node_modules', '.bin', 'git'), 'symlink control');
  assert.throws(() => r(`:.:${plant}`), code('git_unavailable'));
  assert.throws(() => resolveGitBinary({ env: {}, cwd: root }), code('git_unavailable'));
});

test('POSIX rules (injected fs): relative entries never resolve, whatever the process cwd holds', () => {
  const files = new Set(['git', 'sub/git', '/good/git', '/plant/git']);
  const fs = { realpath: (p) => (files.has(p) ? p : null), isExecutableFile: (p) => files.has(p) };
  const r = (PATH) => resolveGitBinary({ env: { PATH }, cwd: '/work', exclude: [], platform: 'linux', fs });
  assert.equal(r('.:sub::/good'), '/good/git');
  assert.equal(r('/plant:/good'), '/plant/git', 'control: an absolute dir resolves');
});

test('a relative cwd or exclude is refused, not resolved against the process cwd', () => {
  const fs = { realpath: () => null, isExecutableFile: () => false };
  const bad = [
    { cwd: 'work', platform: 'linux' }, { cwd: '/work', exclude: ['cand'], platform: 'linux' }, { cwd: '', platform: 'linux' },
    { cwd: 'D:\\a\\repo', exclude: ['cand'], platform: 'win32' }, { cwd: 'D:repo', platform: 'win32' }, { cwd: '\\repo', platform: 'win32' },
  ];
  for (const o of bad) assert.throws(() => resolveGitBinary({ env: { PATH: '/g' }, fs, ...o }), code('git_resolver_bad_arg'), JSON.stringify(o));
  assert.throws(() => resolveGitBinary({ env: { PATH: '/g' }, cwd: '/work', exclude: ['/cand'], platform: 'linux', fs }), code('git_unavailable'), 'control');
});

// Probe the real temp volume, not the OS name: macOS volumes may be case-sensitive.
const caseInsensitiveTmp = (() => {
  const d = mkdtempSync(join(tmpdir(), 'git-cap-case-'));
  try { writeFileSync(join(d, 'probe'), ''); return existsSync(join(d, 'PROBE')); } finally { rmSync(d, { recursive: true, force: true }); }
})();

test('case-insensitive volume: a case-variant PATH spelling of the cwd is still refused', {
  skip: (process.platform === 'win32' && 'Windows spellings are covered by the injected-fs test')
    || (!caseInsensitiveTmp && 'the temp volume is case-sensitive, so a case-variant spelling names a different dir'),
}, (t) => {
  const root = tmp(t);
  const plant = join(root, 'plant');
  fakeGit(plant, 'echo planted');
  const good = fakeGit(join(root, 'good'), 'echo "git version 2.55.0"');
  const upper = plant.toUpperCase();
  assert.ok(existsSync(join(upper, 'git')), 'the volume is case-insensitive, so the plant is reachable');
  assert.equal(resolveGitBinary({ env: { PATH: `${upper}:${dirname(good)}` }, cwd: plant }), good);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  assert.equal(resolveGitBinary({ env: { PATH: `${upper}:${dirname(good)}` }, cwd: elsewhere }), join(plant, 'git'), 'control');
});

test('POSIX: a non-executable file or a directory named git is skipped', { skip: !posix && 'POSIX modes' }, (t) => {
  const root = tmp(t);
  const good = fakeGit(join(root, 'good'), 'echo "git version 2.55.0"');
  mkdirSync(join(root, 'noexec'));
  writeFileSync(join(root, 'noexec', 'git'), '#!/bin/sh\n');
  mkdirSync(join(root, 'isdir', 'git'), { recursive: true });
  const env = { PATH: `${join(root, 'noexec')}:${join(root, 'isdir')}:${dirname(good)}` };
  mkdirSync(join(root, 'cwd'));
  assert.equal(resolveGitBinary({ env, cwd: join(root, 'cwd') }), good);
});

test('Windows rules (injected fs): Path key, quotes, drive-relative entries, shims and cwd are refused', () => {
  const files = new Set([
    'C:\\Plant\\git.cmd', 'C:\\Plant\\git.bat', 'C:\\Plant\\git.com', 'D:\\a\\repo\\git.exe', 'D:\\a\\repo\\bin\\git.exe',
    'C:\\tools\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'tools\\git.exe', 'C:tools\\git.exe', '\\tools\\git.exe',
  ]);
  // Case-insensitive like NTFS: a lookup returns the canonical spelling.
  const canon = (p) => [...files, 'D:\\a\\repo'].find((f) => f.toLowerCase() === p.toLowerCase()) ?? null;
  const fs = { realpath: canon, isExecutableFile: (p) => files.has(p) };
  const r = (Path) => resolveGitBinary({ env: { Path }, cwd: 'D:\\a\\repo', exclude: [], platform: 'win32', fs });
  const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
  assert.equal(r('C:\\Plant;"C:\\Program Files\\Git\\cmd"'), gitExe, '.cmd/.bat/.com shims never resolve');
  assert.equal(r('d:\\A\\REPO;D:\\a\\repo\\bin;"C:\\Program Files\\Git\\cmd"'), gitExe, 'cwd and below, any case');
  assert.equal(r('tools;C:tools;\\tools;;"C:\\Program Files\\Git\\cmd"'), gitExe, 'relative, drive-relative, rooted, empty');
  assert.equal(r('C:\\tools;C:\\Program Files\\Git\\cmd'), 'C:\\tools\\git.exe', 'control: an absolute dir resolves');
  assert.throws(() => r('C:\\Plant'), code('git_unavailable'));
});

test('Windows: a planted git.exe and git.cmd in the cwd lose to the real git', { skip: posix && 'Windows only' }, (t) => {
  const real = resolveGitBinary({ cwd: tmpdir() });
  const plant = tmp(t);
  writeFileSync(join(plant, 'git.exe'), 'MZ planted');
  writeFileSync(join(plant, 'git.cmd'), '@echo planted');
  const Path = `${plant};.;${dirname(real)}`;
  const elsewhere = tmp(t);
  assert.equal(resolveGitBinary({ env: { Path }, cwd: plant }), real);
  assert.equal(resolveGitBinary({ env: { Path }, cwd: elsewhere }), join(plant, 'git.exe'), 'control');
});

// ------------------------------------------------------------------ probe

test('probeGit runs the resolved binary with every GIT_* removed, never a cwd plant', { skip: !posix && 'POSIX fake git' }, (t) => {
  const root = tmp(t);
  const envOut = join(root, 'env.txt');
  const good = fakeGit(join(root, 'good'), `/usr/bin/env > '${envOut}'\necho "git version 2.45.1.windows.2"`);
  const marker = join(root, 'planted-ran');
  const plant = join(root, 'plant');
  fakeGit(plant, `/usr/bin/touch '${marker}'\necho "git version 9.9.9"`);
  const env = { PATH: `:${plant}:${dirname(good)}`, GIT_DIR: '/x', Git_Exec_Path: '/x', git_config_count: '1', KEEP: 'k' };
  const got = probeGit({ env, cwd: plant });
  assert.deepEqual([got.path, got.version, got.noLazyFetch, existsSync(marker)], [good, [2, 45, 1], true, false]);
  const seen = readFileSync(envOut, 'utf8').split('\n');
  assert.deepEqual(seen.filter((l) => /^git_/i.test(l)), []);
  assert.ok(seen.includes('LC_ALL=C') && seen.includes('KEEP=k'));
  assert.ok(Object.isFrozen(got));
});

test('probeGit refuses a failing, old or malformed git', { skip: !posix && 'POSIX fake git' }, (t) => {
  const root = tmp(t);
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const probe = (body) => {
    const d = mkdtempSync(join(root, 'g-'));
    fakeGit(d, body);
    return () => probeGit({ env: { PATH: d }, cwd: cwd });
  };
  assert.throws(probe('exit 3'), code('git_failed'));
  assert.throws(probe('echo "git version 2.31.0"'), code('git_version_below_floor'));
  assert.throws(probe('printf "git version 2.45.0 \\377\\n"'), code('git_version_unparseable'));
  assert.equal(probe('echo "git version 2.44.0"')().noLazyFetch, false);
});

test('a git that ignores SIGTERM cannot hold probeGit past its timeout (external watchdog)', { skip: !posix && 'POSIX signal traps; Windows has no SIGTERM to ignore' }, (t) => {
  const root = tmp(t);
  const pidFile = join(root, 'pid');
  const d = join(root, 'g');
  // Trap FIRST, then publish readiness (the PID file). probeGit owns the spawn, so the test cannot hold
  // the probe until the wrapper is ready; instead readiness is asserted below. A SIGTERM regression that
  // lands before the trap leaves no PID file and fails; one that lands after it hangs and the watchdog
  // fails it. Only a correct SIGKILL passes. A wrapper slower than timeoutMs fails red, never green.
  fakeGit(d, `trap '' TERM\necho $$ > '${pidFile}.tmp'\n/bin/mv '${pidFile}.tmp' '${pidFile}'\nwhile :; do :; done`);
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const pid = () => Number(readFileSync(pidFile, 'utf8'));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  t.after(() => { if (existsSync(pidFile) && alive(pid())) process.kill(pid(), 'SIGKILL'); });
  const mod = JSON.stringify(pathToFileURL(join(here, 'git-capability.mjs')).href);
  const opts = JSON.stringify({ env: { PATH: d }, cwd, timeoutMs: 5000 });
  const script = `import(${mod}).then((m) => { try { m.probeGit(${opts}); console.log('returned'); } catch (e) { console.log(e.code); } });`;
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  assert.equal(r.error, undefined, 'the external watchdog had to kill the probe: it hung');
  assert.equal(r.stdout.trim(), 'git_timeout', r.stderr);
  assert.ok(Date.now() - started < 20_000);
  assert.ok(existsSync(pidFile), 'readiness: the TERM trap was installed before the probe killed the wrapper');
  assert.equal(alive(pid()), false, 'and was killed');
});

// ------------------------------------------------------------------ static: no bare git
// A heuristic for lib/git-*.mjs only; the real ratchet is design T1/T3 (S-02a0e). Unsupported import
// forms are rejected outright rather than tracked: one static, named, unaliased child_process import.

const SPAWNERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];
function spawnViolations(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const v = [];
  const imports = [...code.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'node:child_process';$/gm)];
  if (imports.length > 1 || (code.match(/child_process/g) ?? []).length !== imports.length) v.push('child_process: only one static named import');
  if (/\b(?:require|createRequire)\s*\(|\bimport\s*\(|process\s*\.\s*(?:binding|dlopen)/.test(code)) v.push('require or dynamic import');
  if (/\bshell\s*:(?!\s*false\b)/.test(code)) v.push('shell option');
  const names = imports.flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));
  for (const n of names) if (!SPAWNERS.includes(n)) v.push(`import form: ${n}`);
  const body = code.replace(/^import\s*\{[^}]*\}\s*from\s*'node:child_process';$/gm, '');
  let sites = 0;
  for (const n of names.filter((x) => SPAWNERS.includes(x))) {
    for (const m of body.matchAll(new RegExp(`\\b${n}\\b(\\s*\\(\\s*([^,)]*))?`, 'g'))) {
      sites++;
      const arg = m[2] ?? '';
      if (!m[1]) { v.push(`${n} used without a call`); continue; }
      const via = /^([A-Za-z_$][\w$]*)$/.exec(arg) ? 'resolveGitBinary' : /^([A-Za-z_$][\w$]*)\.path$/.test(arg) ? 'probeGit' : null;
      const id = arg.split('.')[0];
      if (!via || !new RegExp(`\\b(?:const|let)\\s+${id.replace(/\$/g, '\\$')}\\s*=\\s*${via}\\(`).test(body)) v.push(`executable ${arg || '?'} not from the resolver`);
    }
  }
  return { v, sites };
}

test('no lib/git-*.mjs module spawns a literal executable, a shell, or bypasses the resolver', () => {
  const mods = readdirSync(here).filter((f) => /^git-.*\.mjs$/.test(f) && !f.endsWith('.test.mjs'));
  assert.ok(mods.includes('git-capability.mjs'));
  let sites = 0;
  for (const f of mods) {
    const r = spawnViolations(readFileSync(join(here, f), 'utf8'));
    assert.deepEqual(r.v, [], f);
    sites += r.sites;
  }
  assert.ok(sites > 0, 'the scan saw at least one spawn site');
});

test('the spawn guard rejects aliased, namespace, default, require and dynamic forms (negative fixtures)', () => {
  const imp = "import { spawnSync } from 'node:child_process';\n";
  const bad = {
    alias: "import { spawnSync as run } from 'node:child_process';\nconst bin = resolveGitBinary();\nrun('git', []);",
    namespace: "import * as cp from 'node:child_process';\nconst bin = resolveGitBinary();\ncp.spawnSync('git');",
    default: "import cp from 'node:child_process';\ncp.spawnSync('git');",
    require: "const cp = require('node:child_process');\ncp.spawnSync('git');",
    requireAlias: "const { spawnSync: run } = require('child_process');\nrun('git');",
    dynamic: "const { spawnSync: run } = await import('node:child_process');\nrun('git');",
    computedRequire: "const cp = require('node:child' + '_process');\ncp.spawnSync('git');",
    computedImport: "const cp = await import(['node:child', 'process'].join('_'));\ncp.spawnSync('git');",
    unprefixed: 'import { spawnSync } from "child_process";\nspawnSync(\'git\');',
    twoImports: imp + "import { spawn } from 'node:child_process';\nconst bin = resolveGitBinary();\nspawn(bin);",
    rebind: imp + "const run = spawnSync;\nrun('git');",
    literal: imp + "spawnSync('git', []);",
    template: imp + 'spawnSync(`git`, []);',
    notResolved: imp + "const bin = '/usr/bin/git';\nspawnSync(bin, []);",
    wrongSource: imp + 'const gi = resolveGitBinary();\nspawnSync(gi.path, []);',
    exec: "import { exec } from 'node:child_process';\nexec('git status');",
    shell: imp + "const bin = resolveGitBinary();\nspawnSync(bin, [], { shell: true });",
  };
  for (const [name, src] of Object.entries(bad)) assert.notDeepEqual(spawnViolations(src).v, [], name);
  const good = [
    imp + "const bin = resolveGitBinary();\nspawnSync(bin, ['--version'], { shell: false });",
    imp + "const gi = probeGit();\nspawnSync(gi.path, ['status']);",
  ];
  for (const src of good) assert.deepEqual(spawnViolations(src), { v: [], sites: 1 }, src);
});

// ------------------------------------------------------------------ T6 capability matrix on this runner's git (AC4)

test('T6: the runner git honours COUNT pairs, GIT_CONFIG_GLOBAL, --end-of-options, --path-format and lazy-fetch off', (t) => {
  const root = tmp(t);
  const gi = probeGit({ cwd: root });
  console.log(`git-capability: ${JSON.stringify({ path: gi.path, raw: gi.raw, noLazyFetch: gi.noLazyFetch, platform: process.platform })}`);
  const home = join(root, 'home');
  mkdirSync(home);
  const globalCfg = join(root, 'global.gitconfig');
  writeFileSync(globalCfg, '[t6]\n\tglobal = yes\n');
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  Object.assign(base, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalCfg, GIT_CEILING_DIRECTORIES: root, GIT_TERMINAL_PROMPT: '0',
  });
  const git = (args, { cwd = root, env = {} } = {}) => {
    const r = spawnSync(gi.path, args, { cwd, env: { ...base, ...env }, encoding: 'latin1', timeout: 60_000 });
    assert.equal(r.error, undefined);
    return { status: r.status, out: r.stdout.trim(), err: r.stderr };
  };
  const ok = (...a) => { const r = git(...a); assert.equal(r.status, 0, r.err); return r.out; };

  const pair = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 't6.count', GIT_CONFIG_VALUE_0: 'x=y' };
  assert.equal(ok(['config', '--get', 't6.count'], { env: pair }), 'x=y');
  assert.equal(git(['config', '--get', 't6.count']).status, 1, 'control: no pair, no value');
  assert.equal(ok(['config', '--get', 't6.global']), 'yes');
  writeFileSync(join(root, 'empty.gitconfig'), '');
  assert.equal(git(['config', '--get', 't6.global'], { env: { GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig') } }).status, 1, 'control');

  const src = join(root, 'src');
  ok(['init', '-q', src]);
  writeFileSync(join(src, 'f.txt'), 'lazy\n');
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  ok(['add', 'f.txt'], { cwd: src });
  ok([...id, 'commit', '-q', '-m', 'c'], { cwd: src });
  const gitDir = ok(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: src });
  assert.ok(isAbsolute(gitDir), gitDir);
  assert.equal(realpathSync.native(gitDir), realpathSync.native(join(src, '.git')));
  // rev-parse row (2.30.0) and parse-options row (2.24.0; cat-file is a parse-options command). The
  // combined `--end-of-options <rev> -- <path>` form is not relied on below 2.43.1, so it is not asserted.
  assert.match(ok(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], { cwd: src }), /^[0-9a-f]{40,64}$/);
  assert.equal(ok(['cat-file', '-t', '--end-of-options', 'HEAD'], { cwd: src }), 'commit');
  assert.notEqual(git(['cat-file', '-t', '--end-of-options', '--batch'], { cwd: src }).status, 0, 'an option after it is an object name');
  const opt = git(['rev-parse', '--verify', '--quiet', '--end-of-options', '--git-dir'], { cwd: src });
  assert.deepEqual([opt.status !== 0, opt.out], [true, ''], 'an option after --end-of-options is an operand');

  const flag = git(['--no-lazy-fetch', 'version']);
  if (!gi.noLazyFetch) { assert.notEqual(flag.status, 0, 'older git fails loudly on --no-lazy-fetch'); return; }
  assert.equal(flag.status, 0);
  const blob = ok(['rev-parse', 'HEAD:f.txt'], { cwd: src });
  ok(['config', 'uploadpack.allowFilter', 'true'], { cwd: src });
  const dst = join(root, 'dst');
  ok(['clone', '-q', '--no-checkout', '--filter=blob:none', pathToFileURL(src).href, dst]);
  assert.notEqual(git(['--no-lazy-fetch', 'cat-file', '-e', blob], { cwd: dst }).status, 0, 'flag: no lazy fetch');
  assert.notEqual(git(['--no-lazy-fetch', 'cat-file', '-e', blob], { cwd: dst }).status, 0, 'still missing after the flagged read');
  assert.equal(ok(['cat-file', '-p', blob], { cwd: dst }), 'lazy', 'control: without the flag the blob is fetched');
  assert.equal(git(['--no-lazy-fetch', 'cat-file', '-e', blob], { cwd: dst }).status, 0);
  // Grafts refusal (the fourth T6 row) needs a handle bootstrap: it lands with S-02a0c.
});

// ------------------------------------------------------------------ mutation evidence (AC5)
// Each mutant was applied to a scratch copy of git-capability.mjs; every one turned this file red.
// | Mutant                                   | Killed by                                              |
// |------------------------------------------|--------------------------------------------------------|
// | relative PATH entry allowed              | POSIX rules (injected fs); Windows rules               |
// | cwd not banned                           | POSIX plant; Windows rules; probeGit GIT_* scrub       |
// | realpath not checked (spelling only)     | POSIX plant (symlink); macOS case-variant              |
// | general floor 2.31                       | general floor; capability table; probeGit refuses      |
// | pre-release ignored                      | general floor; partial clones                          |
// | version regex unanchored (start / end)   | malformed version output (+ probeGit refuses)          |
// | partial-clone check dropped              | partial clones                                         |
// | bare 'git' spawn                         | no lib/git-*.mjs module spawns ...                     |
// | case-sensitive GIT_* scrub               | probeGit GIT_* scrub                                   |
// | Windows quotes not stripped              | Windows rules                                          |
// | drive-relative entry treated absolute    | Windows rules                                          |
// | executable check dropped                 | POSIX non-executable                                   |
// | noLazyFetch against the general floor    | probeGit refuses                                       |
// | floor not enforced in probeGit           | probeGit refuses                                       |
// | Windows binary name git.cmd              | Windows rules                                          |
// | killSignal SIGTERM (default)             | SIGTERM-ignoring git (external watchdog)               |
// | relative cwd/exclude accepted            | relative cwd or exclude is refused                     |
// | guard: aliased import accepted           | negative fixtures                                      |
// | guard: probeGit().path form rejected     | negative fixtures (good forms)                         |
// | guard: require/dynamic import accepted   | negative fixtures (computed require/import)            |
// | --end-of-options combined row as 'floor' | capability table                                       |
