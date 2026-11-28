/**
 * S3 (P4) A2: the TAP parser, version 2 (config.succession runs only; gate.mjs PARSER_VERSIONS).
 *
 * Fixtures (fixtures/tap-v2/) are REAL `node --test --test-reporter=tap` output captured on node 22.23.1 with the absolute
 * spec path rewritten to /repo/spec. They are a RECONSTRUCTION of the SCRUM-348 shape, not the original 348 bytes (those
 * live in the product repository, which this step may not read): assert-diff-elision.tap is a deepStrictEqual failure whose
 * `error: |-` scalar carries node's "... Skipped lines" elision as a 4-space `    ...` line BEFORE `code: 'ERR_ASSERTION'`,
 * exactly the line R1 row 8 isolated at 348's attempt line 258. hook-failed.tap is a suite whose asserting `before` hook failed.
 *
 * The enumerated contract: version 2 newly ACCEPTS only a not-ok result whose YAML block holds a deeper-indented `...` line
 * (inside a block scalar) before its assertion keys; it newly REFUSES a hookFailed result (setup, never assertion) and a block
 * with no exact-pad terminator. Runtime, load, skip and missing results stay refused. Version 1 is the frozen parser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from './gate.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/tap-v2/${name}`, import.meta.url), 'utf8');
const ELISION = fixture('assert-diff-elision.tap');
const HOOK = fixture('hook-failed.tap');
const parse = (text, parser) => G.parseRunnerOutput('tap', text, parser === undefined ? undefined : { parser });
const kinds = (text, parser) => parse(text, parser).results.map((r) => [r.name, r.status, r.failure_kind]);
const SPEC = { file: 'spec/a.test.mjs', name: 'API-06 deep' };

function fakeDeps(stdout) {
  let n = 0;
  return { platform: 'linux', newAttemptId: () => `att-${++n}`, commit: () => {}, digestFile: (p) => `sha256:${p}`, isGroupAlive: () => false,
    spawnRunner: () => { let release; const r = new Promise((x) => { release = x; });
      return { pid: 4101, pgid: 4100, release: () => release(), done: r.then(() => ({ exitCode: 1, stdout, stderr: '', timedOut: false, quiescent: true })) }; } };
}
const red = (stdout, parser, specs = [SPEC]) => G.gateRed({ state: { nodes: { n: { deps: [] } }, events: [] }, node: 'n', command: { cmd: 'node', args: ['--test'] },
  format: 'tap', specs, baselineCandidate: 'sha256:c', timeoutMs: 120000, ...(parser !== undefined ? { parser } : {}) }, fakeDeps(stdout));

test('A2 the 348-shape bytes: frozen parser (v1) reads runtime and RED refuses; v2 reads assertion and RED is accepted', async () => {
  assert.ok(/^ {4}\.\.\.$/m.test(ELISION), 'the fixture holds a 4-space ... inside the error scalar');
  assert.ok(ELISION.indexOf('\n    ...\n') < ELISION.indexOf("code: 'ERR_ASSERTION'"), 'the elision line comes before the assertion keys');
  assert.deepEqual(kinds(ELISION), [['API-06 deep', 'fail', 'runtime']], 'v1 (default) is the frozen parser');
  assert.deepEqual(kinds(ELISION, 1), [['API-06 deep', 'fail', 'runtime']]);
  assert.deepEqual(kinds(ELISION, 2), [['API-06 deep', 'fail', 'assertion']]);
  const v1 = await red(ELISION);
  assert.equal(v1.code, 'non_assertion_failure', 'frozen: the real assertion failure is refused');
  const v2 = await red(ELISION, 2);
  assert.equal(v2.code, 'red_accepted', JSON.stringify(v2.reasons));
});

test('D-RED an asserting before hook is a setup failure under v2 (never RED credit); v1 read it as assertion', async () => {
  assert.deepEqual(kinds(HOOK, 1), [['suite > spec in hooked suite', 'fail', 'runtime'], ['suite', 'fail', 'assertion']]);
  assert.deepEqual(kinds(HOOK, 2), [['suite > spec in hooked suite', 'fail', 'runtime'], ['suite', 'fail', 'setup']]);
  const suite = { file: 'spec/b.test.mjs', name: 'suite' };
  assert.equal((await red(HOOK, 1, [suite])).code, 'red_accepted', 'frozen: a failed setup hook earned RED credit');
  assert.equal((await red(HOOK, 2, [suite])).code, 'non_assertion_failure');
  assert.equal((await red(HOOK, 2, [{ file: 'spec/b.test.mjs', name: 'suite > spec in hooked suite' }])).code, 'non_assertion_failure');
});

/** One not-ok top-level result whose YAML block carries `inner` lines between `error: |-` and its assertion keys. */
const block = (inner, { terminator = '  ...', name = 'T' } = {}) => ['TAP version 13', `# Subtest: ${name}`, `not ok 1 - ${name}`, '  ---',
  "  location: '/repo/spec/a.test.mjs:1:1'", "  failureType: 'testCodeFailure'", '  error: |-', ...inner,
  "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", ...(terminator === null ? [] : [terminator]), '1..1', ''].join('\n');

test('A2 differential corpus: the only verdict v2 changes toward acceptance is a deeper-indented ... inside the block', () => {
  const changed = [];
  for (let indent = 0; indent <= 8; indent++) {
    for (const where of ['scalar', 'alone']) {
      const line = ' '.repeat(indent) + '...';
      const text = where === 'scalar' ? block(['    message', line, '    more']) : block([line]);
      const a = kinds(text, 1)[0]?.[2] ?? null, b = kinds(text, 2)[0]?.[2] ?? null;
      if (a !== b) changed.push({ indent, where, v1: a, v2: b });
    }
  }
  // indent 2 is the pad: the block's own terminator in both versions (no difference). Deeper: v1 cut the block early.
  assert.deepEqual(changed.filter((c) => c.v2 === 'assertion').map((c) => c.indent).sort(), [3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
  for (const c of changed) assert.ok(c.v2 === 'assertion' ? c.v1 === 'runtime' : c.v2 === 'runtime', JSON.stringify(c));
  // indent 0/1 dedents below the pad: v2 discards the malformed block (runtime, refused), never assertion
  for (const c of changed.filter((x) => x.indent < 2)) assert.equal(c.v2, 'runtime', JSON.stringify(c));
});

test('A2 a block with no exact-pad terminator fails closed and never absorbs a later result', () => {
  const unterminated = ['TAP version 13', '# Subtest: first', 'not ok 1 - first', '  ---', "  failureType: 'testCodeFailure'", '  error: |-', '    boom',
    '# Subtest: second', 'not ok 2 - second', '  ---', "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", '  ...', '1..2', ''].join('\n');
  assert.deepEqual(kinds(unterminated, 2), [['first', 'fail', 'runtime'], ['second', 'fail', 'assertion']], 'first is malformed, second is read on its own');
  const eof = block(['    boom'], { terminator: null });
  assert.deepEqual(kinds(eof, 2), [['T', 'fail', 'runtime']], 'a block cut at the end of the text keeps none of its keys');
});

test('A2 runtime, load, skip and missing stay refused under v2', async () => {
  const runtime = block(['    TypeError: x is not a function']).replace("  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n", "  code: 'ERR_TEST_FAILURE'\n");
  assert.equal((await red(runtime, 2, [{ file: 'spec/a.test.mjs', name: 'T' }])).code, 'non_assertion_failure');
  const load = ['TAP version 13', '# Subtest: /repo/spec/a.test.mjs', 'not ok 1 - /repo/spec/a.test.mjs', '  ---', "  location: '/repo/spec/a.test.mjs:1:1'",
    '  exitCode: 1', "  failureType: 'testCodeFailure'", '  ...', '# Error [ERR_MODULE_NOT_FOUND]: Cannot find module', '1..1', ''].join('\n');
  assert.equal((await red(load, 2, [{ file: 'spec/a.test.mjs', name: 'T' }])).code, 'non_assertion_failure');
  const skip = ['TAP version 13', '# Subtest: T', 'ok 1 - T # SKIP', '  ---', "  location: '/repo/spec/a.test.mjs:1:1'", '  ...', '1..1', ''].join('\n');
  assert.equal((await red(skip, 2, [{ file: 'spec/a.test.mjs', name: 'T' }])).code, 'spec_not_failing');
  assert.equal((await red(ELISION, 2, [{ file: 'spec/a.test.mjs', name: 'absent' }])).code, 'spec_missing');
  assert.equal(parse(ELISION, 3).supported, false, 'an unknown parser version is unsupported, never the default');
});

test('review R1: v2 refuses a truncated run; a repeated key makes the block malformed; explicit null options do not throw', async () => {
  const trunc = (stdout, parser) => G.gateRed({ state: { nodes: { n: { deps: [] } }, events: [] }, node: 'n', command: { cmd: 'node', args: ['--test'] },
    format: 'tap', specs: [SPEC], baselineCandidate: 'sha256:c', timeoutMs: 120000, parser }, (() => { const d = fakeDeps(stdout); const sp = d.spawnRunner;
      d.spawnRunner = (...a) => { const r = sp(...a); return { ...r, done: r.done.then((x) => ({ ...x, truncated: true, stdout_bytes: 1 })) }; }; return d; })());
  assert.equal((await trunc(ELISION, 2)).code, 'output_truncated');
  assert.equal((await trunc(ELISION, 1)).code, 'non_assertion_failure', 'v1 behaviour unchanged');
  const dup = ['TAP version 13', '# Subtest: suite', 'not ok 1 - suite', '  ---', "  failureType: 'hookFailed'", "  failureType: 'testCodeFailure'",
    "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", '  ...', '1..1', ''].join('\n');
  assert.deepEqual(kinds(dup, 2), [['suite', 'fail', 'runtime']]);
  assert.equal(G.parseRunnerOutput('tap', ELISION, null).supported, true);
  assert.equal(G.specResults([SPEC], [{ format: 'tap', stdout: ELISION }], null)[0].status, 'fail');
});
