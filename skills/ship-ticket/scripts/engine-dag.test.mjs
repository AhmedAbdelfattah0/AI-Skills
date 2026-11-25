/**
 * STAB-410 F-9: dagReadWriteConflicts(nodes), the pure plan-time check that refuses a DAG where a node reads a path a
 * TRANSITIVE dependent writes (the dependent's write would make the finished reader stale: drift() re-runs it before the
 * freeze, or raises post_freeze_drift after). Overlap is equality or a whole-segment prefix either way, case-folded like the
 * harness collision rule; a glob counts by its literal prefix (the whole segments before the first glob character), so an
 * unanchored glob overlaps everything (fail closed). It is called ONLY from run-engine preflight (dag_read_write_dependency),
 * never from validateEngineDag or init (run-engine.test.mjs and security-obligations.test.mjs pin that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dagReadWriteConflicts } from './engine-dag.mjs';

const N = (id, o = {}) => ({ id, deps: [], reads: [], writes: [], ...o });
const pairs = (nodes) => dagReadWriteConflicts(nodes).map((c) => `${c.reader}<-${c.writer}:${c.read}|${c.write}`);

test('TICKET-C shape: `tests` reads the file its dependent `fix` writes: one conflict naming the pair and both paths', () => {
  const nodes = [N('tests', { reads: ['apps/store/src/cart.ts'], writes: ['apps/store/src/cart.spec.ts'] }), N('fix', { deps: ['tests'], writes: ['apps/store/src/cart.ts'] })];
  assert.deepEqual(dagReadWriteConflicts(nodes), [{ reader: 'tests', writer: 'fix', read: 'apps/store/src/cart.ts', write: 'apps/store/src/cart.ts' }]);
});

test('transitive dependents count; independent nodes, predecessors and the node itself do not', () => {
  assert.deepEqual(pairs([N('a', { reads: ['x.ts'] }), N('b', { deps: ['a'] }), N('c', { deps: ['b'], writes: ['x.ts'] })]), ['a<-c:x.ts|x.ts'], 'through b');
  assert.deepEqual(pairs([N('a', { reads: ['x.ts'] }), N('b', { writes: ['x.ts'] })]), [], 'independent: no dependency, no conflict');
  assert.deepEqual(pairs([N('a', { writes: ['x.ts'] }), N('b', { deps: ['a'], reads: ['x.ts'] })]), [], 'read after write by a predecessor');
  assert.deepEqual(pairs([N('a', { reads: ['x.ts'], writes: ['x.ts'] })]), [], 'a node reading its own write');
  assert.deepEqual(pairs([N('a', { reads: ['x.ts'] }), N('b', { deps: ['a'], writes: ['y.ts'] }), N('c', { deps: ['a', 'b'], writes: ['x.ts'] })]), ['a<-c:x.ts|x.ts'], 'diamond: reported once');
});

test('directory prefixes overlap by whole segments in both directions, case-folded; a string prefix is not a segment prefix', () => {
  const one = (read, write) => pairs([N('a', { reads: [read] }), N('b', { deps: ['a'], writes: [write] })]).length;
  assert.equal(one('src', 'src/a.ts'), 1, 'reads a directory a dependent writes into');
  assert.equal(one('src/a.ts', 'src'), 1, 'a dependent owns the directory holding the read');
  assert.equal(one('src/a.ts', 'src/a.ts'), 1);
  assert.equal(one('Src/A.ts', 'src/a.ts'), 1, 'case-folded (case-insensitive file systems)');
  assert.equal(one('src/a', 'src/ab.ts'), 0, 'src/a is not a segment prefix of src/ab.ts');
  assert.equal(one('src/ab.ts', 'src/a'), 0);
  assert.equal(one('lib/x.ts', 'src/x.ts'), 0);
});

test('a glob counts by its literal prefix (whole segments before the first glob character); an unanchored glob overlaps everything', () => {
  const one = (read, write) => pairs([N('a', { reads: [read] }), N('b', { deps: ['a'], writes: [write] })]).length;
  assert.equal(one('src/**/*.ts', 'src/x/y.ts'), 1);
  assert.equal(one('src/*.ts', 'lib/x.ts'), 0, 'a different literal prefix');
  assert.equal(one('src/fo*.ts', 'src/bar.ts'), 1, 'the prefix is cut at the whole segment (src), fail closed');
  assert.equal(one('src/a?.ts', 'src/zz.ts'), 1);
  assert.equal(one('src/[ab].ts', 'src/c.ts'), 1);
  assert.equal(one('src/{a,b}.ts', 'src/c.ts'), 1);
  assert.equal(one('*.ts', 'docs/readme.md'), 1, 'no literal prefix: overlaps everything');
  assert.equal(one('**', 'x'), 1);
  assert.equal(one('docs/readme.md', '*.ts'), 1, 'an unanchored glob on the WRITE side overlaps everything too');
  assert.equal(one('x', '**'), 1);
  assert.equal(one('app/[id]/page.tsx', 'app/other.ts'), 1, 'documented over-refusal: a literal bracket segment reads as a glob (prefix app), fail closed');
  assert.equal(one('src/gen/a.ts', 'src/gen/*'), 1, 'a glob on the write side too');
  assert.equal(one('lib/a.ts', 'src/gen/*'), 0);
});

test('every conflicting pair is reported, in node order, with no duplicates', () => {
  const nodes = [N('a', { reads: ['p/1', 'p/2'] }), N('b', { reads: ['q'] }), N('c', { deps: ['a', 'b'], writes: ['p', 'q/r'] })];
  assert.deepEqual(pairs(nodes), ['a<-c:p/1|p', 'a<-c:p/2|p', 'b<-c:q|q/r']);
  assert.deepEqual(pairs([N('a'), N('b', { deps: ['a'] })]), [], 'absent reads and writes');
});
