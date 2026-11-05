import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'candidate-id.mjs');

function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-id-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

const run = (dir, ...extra) => {
  const r = spawnSync(process.execPath, [script, '--repo', dir, '--base', 'HEAD', ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const names = (out) => out.paths.map((p) => p.path).sort();

test('--exclude <dir> excludes everything under the directory; exact files still work', (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, '.specs', 'plans'), { recursive: true });
  writeFileSync(join(dir, '.specs', 'plans', 'T-1.md'), 'plan');
  writeFileSync(join(dir, '.specs-other.txt'), 'sibling with a shared prefix');
  writeFileSync(join(dir, 'src.txt'), 'code');

  const all = run(dir);
  assert.deepEqual(names(all), ['.specs-other.txt', '.specs/plans/T-1.md', 'src.txt']);

  const dirExcluded = run(dir, '--exclude', '.specs');
  assert.deepEqual(names(dirExcluded), ['.specs-other.txt', 'src.txt']);
  assert.deepEqual(names(run(dir, '--exclude', '.specs/plans/')), ['.specs-other.txt', 'src.txt']);
  assert.deepEqual(names(run(dir, '--exclude', 'src.txt')), ['.specs-other.txt', '.specs/plans/T-1.md']);

  assert.notEqual(all.candidate_id, dirExcluded.candidate_id);
  writeFileSync(join(dir, '.specs', 'plans', 'T-1.md'), 'plan edited');
  assert.equal(run(dir, '--exclude', '.specs').candidate_id, dirExcluded.candidate_id, 'excluded edits do not change the id');
});

test('an exclude that normalizes to empty is rejected, not treated as exclude-everything', (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, 'src.txt'), 'code');
  for (const bad of ['', '.', './']) {
    const r = spawnSync(process.execPath, [script, '--repo', dir, '--base', 'HEAD', '--exclude', bad], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `exclude ${JSON.stringify(bad)} must fail`);
    assert.match(r.stderr, /exclude.*(empty|whole|everything)/i);
  }
});

test('tracked edits and deletions under an excluded dir are ignored with --exclude', (t) => {
  const dir = repo(t);
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, '.specs', 'plans'), { recursive: true });
  writeFileSync(join(dir, '.specs', 'plans', 'one.md'), 'one');
  writeFileSync(join(dir, '.specs', 'plans', 'two.md'), 'two');
  git('add', '-A');
  git('commit', '-q', '-m', 'specs');
  const clean = run(dir, '--exclude', '.specs');
  writeFileSync(join(dir, '.specs', 'plans', 'one.md'), 'one edited');
  rmSync(join(dir, '.specs', 'plans', 'two.md'));
  assert.deepEqual(names(run(dir)), ['.specs/plans/one.md', '.specs/plans/two.md']);
  const excluded = run(dir, '--exclude', '.specs');
  assert.deepEqual(names(excluded), []);
  assert.equal(excluded.candidate_id, clean.candidate_id);
});
