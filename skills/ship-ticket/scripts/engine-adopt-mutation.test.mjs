/**
 * S-13a (ASTF-7): every adoption guard has a named mutant (PLAN-S13 §5, D1-D12), on the ONE shared harness
 * (lib/mutation.test-helper.mjs: CRLF-safe anchors, a kill only when every failure is an assertion). Each mutant copies skills/
 * with ONE exact-once replacement and runs only the tests of its target file tagged with its own tag; the unpatched copy (the
 * control) must pass every tagged test of both files, or the verdicts would say nothing. Runs with ENGINE_MUTATION=1 or
 * ENGINE_ADOPT_MUTATION=1 (engine-properties CI job).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMutationSource, classify, runMutantAsync } from './lib/mutation.test-helper.mjs';
import { POSIX } from './engine-test-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const PURE = 'ship-ticket/scripts/engine-adopt.test.mjs', CLI = 'ship-ticket/scripts/run-engine-adopt.test.mjs';
const ADOPT = 'ship-ticket/scripts/engine-adopt.mjs', ENGINE = 'ship-ticket/scripts/run-engine.mjs';
const SKIP = !POSIX ? 'POSIX process groups (known limit D4)'
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_ADOPT_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_ADOPT_MUTATION=1' : false;
const TIMEOUT_MS = 10 * 60 * 1000;

/** One guard each: its tag, the test file that kills it, the file (relative to skills/) and the exact text replaced. */
export const ADOPT_MUTANTS = [
  { tag: 'D1', test: PURE, name: 'fingerprint comparison skipped (an edited file is adopted)', file: ADOPT,
    from: "    if (changed.length) { verdict[id] = { code: 'node_files_changed', changed }; continue; }", to: '' },
  { tag: 'D2', test: PURE, name: 'closure not applied (a dependent of a rejected node is adopted)', file: ADOPT,
    from: "  const out = closure(newS, Object.keys(verdict).filter(id => verdict[id]));", to: '  const out = Object.keys(verdict).filter(id => verdict[id]);' },
  { tag: 'D3', test: PURE, name: 'plan digest check removed (cross-plan adoption)', file: ADOPT,
    from: '  if (oldS.plan_digest !== newS.plan_digest) return', to: '  if (false) return' },
  { tag: 'D4', test: PURE, name: 'RED carried when a spec digest changed', file: ADOPT,
    from: '  if (what && (what.changed.length || what.moved))', to: '  if (what && (what.moved))' },
  { tag: 'D5', test: PURE, name: 'RED carried when the base moved', file: ADOPT,
    from: '  if (what && (what.changed.length || what.moved))', to: '  if (what && (what.changed.length))' },
  { tag: 'D6', test: PURE, name: 'manifest sha check skipped', file: ADOPT,
    from: '    if (sha(buf) !== m.files[name]) throw bad(', to: '    if (false) throw bad(' },
  { tag: 'D7', test: CLI, name: 'window check skipped (double adoption)', file: ENGINE,
    from: "    if (closed) throw coded('adoption_window_closed',", to: "    if (false) throw coded('adoption_window_closed'," },
  { tag: 'D8', test: PURE, name: 'node definition compare ignores deps and writes', file: ADOPT,
    from: "export const ADOPT_NODE_FIELDS = Object.freeze(['id', 'deps', 'reads', 'writes', ", to: "export const ADOPT_NODE_FIELDS = Object.freeze(['id', 'reads', " },
  { tag: 'D9', test: PURE, name: 'a non-done archived node adopted', file: ADOPT,
    from: "    if (o.state !== 'done') { verdict[id] = { code: 'node_not_done' }; continue; }", to: '' },
  { tag: 'D10', test: PURE, name: 'a LIVE source ignored', file: ADOPT,
    from: "  if (live.length) return { code: 'adopt_source_live',", to: "  if (false) return { code: 'adopt_source_live'," },
  { tag: 'D11', test: PURE, name: 'containment check skipped', file: ADOPT,
    from: "  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.includes(sep)) throw outside(", to: '  if (false) throw outside(' },
  { tag: 'D12', test: CLI, name: 'retire renames on a byte mismatch', file: ADOPT,
    from: "      throw coded('retire_mismatch',", to: "      void ('retire_mismatch'," },
];

const tagged = (tag) => ['--test-name-pattern', `\\[${tag}\\]`];
/** The child must report TAP on its own stdout: a NODE_TEST_CONTEXT inherited from this runner sends it to our channel instead (a vacuous pass). */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const SRC = { [PURE]: readFileSync(join(SKILLS, PURE), 'utf8'), [CLI]: readFileSync(join(SKILLS, CLI), 'utf8') };
/** How many tests of `file` carry `tag` (any D tag when null): the count a run must prove it executed. */
const taggedCount = (file, tag) => [...SRC[file].matchAll(/^test\('([^']*)'/gm)].filter(([, n]) => (tag ? n.includes(`[${tag}]`) : /\[D\d+\]/.test(n))).length;
const tapCount = (r, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);

test('S-13a mutation: the tagged adoption tests pass on the unpatched copy and each guard mutant is killed by its own tag', { skip: SKIP, timeout: 60 * 60 * 1000 }, async (t) => {
  for (const file of [PURE, CLI]) {
    const raw = await runMutantAsync({ root: SKILLS, testRel: file, env: CHILD_ENV, args: ['--test-name-pattern', '\\[D\\d+\\]'], timeout: TIMEOUT_MS });
    const control = classify(raw);
    assert.equal(control.verdict, 'survived', `${file}: the control passes every tagged test: ${JSON.stringify(control)}`);
    assert.ok(taggedCount(file, null) > 0 && tapCount(raw, 'pass') >= taggedCount(file, null) && tapCount(raw, 'fail') === 0,
      `${file}: the control RAN every tagged test (pass ${tapCount(raw, 'pass')} of ${taggedCount(file, null)}, fail ${tapCount(raw, 'fail')})`);
  }
  const rows = [];
  for (const m of ADOPT_MUTANTS) { // one at a time: the engine suites give false failures under load
    const src = loadMutationSource(join(SKILLS, m.file));
    assert.equal(src.split(m.from).length, 2, `${m.tag}: its anchor occurs exactly once in ${m.file}`);
    const out = await runMutantAsync({ root: SKILLS, testRel: m.test, env: CHILD_ENV, overrides: { [m.file]: src.replace(m.from, m.to) }, args: tagged(m.tag), timeout: TIMEOUT_MS });
    const r = classify(out), ran = tapCount(out, 'pass') + tapCount(out, 'fail');
    const own = r.failing.some(f => f.includes(`[${m.tag}]`));
    rows.push({ tag: m.tag, name: m.name, verdict: r.verdict, own_tag_failed: own, ran, tagged: taggedCount(m.test, m.tag), failing: r.failing, ...(r.why ? { why: r.why } : {}) });
    t.diagnostic(JSON.stringify(rows.at(-1)));
  }
  assert.deepEqual(rows.filter(r => !(r.verdict === 'killed' && r.own_tag_failed && r.tagged > 0 && r.ran >= r.tagged)).map(r => `${r.tag} ${r.verdict} ran ${r.ran}/${r.tagged}`), [],
    'every mutant ran its tagged tests and is killed by a test carrying its tag');
});
