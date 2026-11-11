import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { overlaps, declaredPaths } from './base-drift.mjs';

const CLI = fileURLToPath(new URL('./base-drift.mjs', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const put = (repo, rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bdrift-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'lib/a.js', 'a1\n'); put(repo, 'docs/readme.txt', 'r1\n'); put(repo, 'cfg/contract.json', 'c1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const dag = { nodes: [{ id: 'n1', reads: ['lib/a.js'], writes: ['src/new'] }] };
  writeFileSync(join(dir, 'dag.json'), JSON.stringify(dag));
  return { dir, repo, base, dag: join(dir, 'dag.json') };
}
const run = (fx, extra = []) => spawnSync(process.execPath, [CLI, 'check', '--repo', fx.repo, '--base', fx.base, '--target', 'main', '--dag', fx.dag, ...extra], { encoding: 'utf8' });

test('planted failure: main touching a declared read is reported', () => {
  const fx = fixture();
  try {
    put(fx.repo, 'lib/a.js', 'a2\n'); git(fx.repo, 'commit', '-q', '-am', 'drift');
    const r = run(fx);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /lib\/a\.js/);
    assert.match(r.stdout, /node n1 reads/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('unrelated changes pass; a contract path catches an otherwise-unrelated change', () => {
  const fx = fixture();
  try {
    put(fx.repo, 'docs/readme.txt', 'r2\n'); put(fx.repo, 'cfg/contract.json', 'c2\n'); git(fx.repo, 'commit', '-q', '-am', 'other');
    const ok = run(fx);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    writeFileSync(join(fx.dir, 'contract.txt'), '# contract\ncfg\n');
    const bad = run(fx, ['--contract-paths', join(fx.dir, 'contract.txt')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /cfg\/contract\.json/);
    assert.doesNotMatch(bad.stdout, /readme/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a bad ref fails closed and usage error exits 2', () => {
  const fx = fixture();
  try {
    const r = spawnSync(process.execPath, [CLI, 'check', '--repo', fx.repo, '--base', 'nope', '--target', 'main', '--dag', fx.dag], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(spawnSync(process.execPath, [CLI, 'check'], { encoding: 'utf8' }).status, 2);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('path matching is directory-aware, not substring', () => {
  const declared = declaredPaths({ nodes: [{ id: 'x', reads: ['lib'], writes: [] }] });
  assert.equal(overlaps(['lib/a.js'], declared).length, 1);
  assert.equal(overlaps(['library/a.js'], declared).length, 0);
});

test('planted failure: renaming a declared read out of its directory is reported (both sides of the rename)', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.repo, 'moved'));
    git(fx.repo, 'mv', 'lib/a.js', 'moved/a.js'); // a pure rename: git would pair it and list only moved/a.js
    git(fx.repo, 'commit', '-q', '-m', 'move');
    const r = run(fx);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ {2}lib\/a\.js \(declared lib\/a\.js, node n1 reads\)$/m);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a ref starting with - is refused before git runs (no option injection)', () => {
  const fx = fixture();
  try {
    for (const which of ['--base', '--target']) {
      const planted = join(fx.dir, `planted-${which.slice(2)}.txt`);
      const args = { '--base': fx.base, '--target': 'main' };
      args[which] = `--output=${planted}`;
      const r = spawnSync(process.execPath, [CLI, 'check', '--repo', fx.repo, '--base', args['--base'], '--target', args['--target'], '--dag', fx.dag], { encoding: 'utf8' });
      assert.equal(r.status, 1, which);
      assert.match(r.stderr, /refused ref: --output=/, which);
      assert.equal(existsSync(planted), false, `${which}: git never wrote the planted file`);
    }
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
