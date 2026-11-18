// Regression tests for the shared mutation harness (lib/mutation.test-helper.mjs) itself, on a synthetic tree whose test file
// sits in a NESTED directory and imports modules from other subdirectories plus a *.test-helper.mjs.
// Defect pinned (PR #89, Windows + Node 18 only): fs.cpSync there hands the filter toNamespacedPath() spellings (`\\?\D:\...`),
// the filter compared them with join(root, testRel), the test file was silently dropped, and EVERY mutant came back 'invalid'
// with no reason. The `cp` seam replays that spelling on every OS, so these tests are red on the old harness everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { classify, copyMutantTree, runMutant } from './mutation.test-helper.mjs';

const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const TEST_REL = join('lib', 'deep', 't.test.mjs');
const MOD = "export const add = (a, b) => a + b;\n";
const FILES = {
  [join('measure', 'nested', 'm.mjs')]: MOD,
  [join('lib', 'h.test-helper.mjs')]: "export const two = 2;\n",
  [join('data', 'x.json')]: '{"v":3}\n',
  [TEST_REL]: [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { add } from '../../measure/nested/m.mjs';",
    "import { two } from '../h.test-helper.mjs';",
    "test('adds', () => { assert.equal(add(1, two), 3); });",
    "test('reads data', () => { assert.equal(JSON.parse(readFileSync(new URL('../../data/x.json', import.meta.url), 'utf8')).v, 3); });",
    '',
  ].join('\n'),
  // Another test file: never copied (it would fail if it were run, and it is never the one under run).
  [join('lib', 'other.test.mjs')]: "import { test } from 'node:test';\ntest('never runs', () => { throw new Error('other test copied'); });\n",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mh-root-'));
  for (const [rel, src] of Object.entries(FILES)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), src); }
  return root;
}
const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))])).sort();
/** cpSync exactly as Node 18 drives it on Windows: the filter sees a `\\?\`-prefixed spelling of every path. */
const namespacedCp = (src, dest, opts) => cpSync(src, dest, { ...opts, filter: (s, d) => opts.filter(`\\\\?\\${s}`, d) });

test('harness copy: a nested test file, its cross-directory imports, helpers and data are copied; no other *.test.mjs is', () => {
  const root = fixture();
  for (const cp of [cpSync, namespacedCp]) {
    const dir = copyMutantTree(root, TEST_REL, {}, { cp });
    try {
      assert.deepEqual(walk(dir), Object.keys(FILES).filter((f) => f !== join('lib', 'other.test.mjs')).sort(), cp.name);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  rmSync(root, { recursive: true, force: true });
});

test('harness verdicts do not depend on the absolute-path spelling cp hands the filter (Windows Node 18 regression)', () => {
  const root = fixture();
  try {
    for (const cp of [cpSync, namespacedCp]) {
      const intact = classify(runMutant({ root, testRel: TEST_REL, env: ENV, cp }));
      assert.equal(intact.verdict, 'survived', `${cp.name}: ${JSON.stringify(intact)}`);
      const mutant = classify(runMutant({ root, testRel: TEST_REL, env: ENV, cp, overrides: { [join('measure', 'nested', 'm.mjs')]: MOD.replace('a + b', 'a - b') } }));
      assert.equal(mutant.verdict, 'killed', `${cp.name}: ${JSON.stringify(mutant)}`);
      assert.deepEqual(mutant.failing, ['adds']);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('harness fails closed: a test file that is not in the tree throws (never a silent INVALID verdict)', () => {
  const root = fixture();
  try {
    assert.throws(() => runMutant({ root, testRel: join('lib', 'deep', 'missing.test.mjs'), env: ENV }), (e) => e.code === 'ENOENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an INVALID verdict carries the child\'s real failure reason and exit status', () => {
  const root = fixture();
  try {
    const broken = classify(runMutant({ root, testRel: TEST_REL, env: ENV, overrides: { [join('measure', 'nested', 'm.mjs')]: `${MOD}export const = ;\n` } }));
    assert.equal(broken.verdict, 'invalid');
    assert.match(broken.why, /^non-assertion failure \(exit [1-9]\d*\): /);
    assert.match(broken.why, /SyntaxError/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const crashed = classify({ status: null, signal: 'SIGKILL', stdout: '', stderr: 'out of memory\n' });
  assert.equal(crashed.verdict, 'invalid');
  assert.equal(crashed.why, 'SIGKILL: out of memory');
});
