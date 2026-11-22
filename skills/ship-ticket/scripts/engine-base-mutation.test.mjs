/**
 * S-12 (ASTF-6): every pinned-base guard has a named mutant, on the ONE shared harness (lib/mutation.test-helper.mjs: CRLF-safe
 * anchors, a kill only when every failure is an assertion). Each mutant copies skills/ (the engine needs skills/vapt for the
 * catalog) with ONE exact-once replacement and runs only the run-engine-base.test.mjs tests tagged with its own tag; the
 * unpatched copy (the control) must pass every tagged test, or the verdicts would say nothing.
 *
 * Not engine-mutation.test.mjs MUTANTS: that suite runs the property harness (engine-explore.test.mjs) and counts a kill only as
 * an oracle verdict on a property P#, which no base guard has. Runs with ENGINE_MUTATION=1 or ENGINE_BASE_MUTATION=1.
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
const TEST = 'ship-ticket/scripts/run-engine-base.test.mjs';
const SKIP = !POSIX ? 'POSIX process groups (known limit D4)'
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_BASE_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_BASE_MUTATION=1' : false;
const TIMEOUT_MS = 10 * 60 * 1000;

/** One guard each: its tag, the file (relative to skills/), and the exact text replaced. */
export const BASE_MUTANTS = [
  { tag: 'B1', name: 'accessor: baseRef falls back to config.base (the pin is never read)', file: 'ship-ticket/scripts/engine-dag.mjs',
    from: "export const baseRef = (S) => S?.base?.merge_base ?? S?.config?.base ?? 'HEAD';", to: "export const baseRef = (S) => S?.config?.base ?? 'HEAD';" },
  { tag: 'B2', name: 'reassess: the local base branch comparison is dropped (AC1 silent)', file: 'ship-ticket/scripts/engine-gates.mjs',
    from: 'if (local !== undefined && local !== B.merge_base) return moved(local,', to: 'if (false) return moved(local,' },
  { tag: 'B3', name: 'remoteIdentity: several fetch URLs are accepted (the first is taken)', file: 'ship-ticket/scripts/remote-identity.mjs',
    from: "  if (urls.values.length > 1) return no('remote_ambiguous',", to: "  if (false) return no('remote_ambiguous'," },
  { tag: 'B4', name: 'reassess: a base refusal is ignored (offline or a moved base passes)', file: 'ship-ticket/scripts/engine-gates.mjs',
    from: '  if (baseNo) return baseNo;\n', to: '' },
  { tag: 'B5', name: 'load: a partial pin (flag, S.base, config.pinnedBase disagree) is resumed', file: 'ship-ticket/scripts/run-engine.mjs',
    from: '      if (new Set([E.policy.semantics.pinnedBase === true, E.S.base !== undefined, pinnedBaseOn(E.S)]).size !== 1)\n', to: '      if (false)\n' },
];

const tagged = (tag) => ['--test-name-pattern', `\\[${tag}\\]`];
/** The child must report TAP on its own stdout: a NODE_TEST_CONTEXT inherited from this runner sends it to our channel instead (a vacuous pass). */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
/** How many tests of the target file carry `tag` (all tags when null): the count a run must prove it executed. */
const TEST_SRC = readFileSync(join(SKILLS, TEST), 'utf8');
const taggedCount = (tag) => [...TEST_SRC.matchAll(/^test\('([^']*)'/gm)].filter(([, n]) => (tag ? n.includes(`[${tag}]`) : /\[B\d\]/.test(n))).length;
const tapCount = (r, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);

test('S-12 mutation: the tagged base tests pass on the unpatched copy and each guard mutant is killed by its own tag', { skip: SKIP, timeout: 40 * 60 * 1000 }, async (t) => {
  const raw = await runMutantAsync({ root: SKILLS, testRel: TEST, env: CHILD_ENV, args: ['--test-name-pattern', '\\[B\\d\\]'], timeout: TIMEOUT_MS });
  const control = classify(raw);
  assert.equal(control.verdict, 'survived', `the control passes every tagged test: ${JSON.stringify(control)}`);
  assert.ok(taggedCount(null) >= 5, 'the target file has tagged tests');
  assert.ok(tapCount(raw, 'pass') >= taggedCount(null) && tapCount(raw, 'fail') === 0, `the control RAN every tagged test (pass ${tapCount(raw, 'pass')} of ${taggedCount(null)}, fail ${tapCount(raw, 'fail')})`);
  const rows = [];
  for (const m of BASE_MUTANTS) { // one at a time: the engine suites give false failures under load
    const src = loadMutationSource(join(SKILLS, m.file));
    assert.equal(src.split(m.from).length, 2, `${m.tag}: its anchor occurs exactly once in ${m.file}`);
    const out = await runMutantAsync({ root: SKILLS, testRel: TEST, env: CHILD_ENV, overrides: { [m.file]: src.replace(m.from, m.to) }, args: tagged(m.tag), timeout: TIMEOUT_MS });
    const r = classify(out), ran = tapCount(out, 'pass') + tapCount(out, 'fail');
    const own = r.failing.some(f => f.includes(`[${m.tag}]`));
    rows.push({ tag: m.tag, name: m.name, verdict: r.verdict, own_tag_failed: own, ran, tagged: taggedCount(m.tag), failing: r.failing, ...(r.why ? { why: r.why } : {}) });
    t.diagnostic(JSON.stringify(rows.at(-1)));
  }
  assert.deepEqual(rows.filter(r => !(r.verdict === 'killed' && r.own_tag_failed && r.tagged > 0 && r.ran >= r.tagged)).map(r => `${r.tag} ${r.verdict} ran ${r.ran}/${r.tagged}`), [],
    'every mutant ran its tagged tests and is killed by a test carrying its tag');
});
