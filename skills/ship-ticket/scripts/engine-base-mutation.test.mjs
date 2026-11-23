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
    from: "export const baseRef = (S) => (pinnedBaseOn(S) ? pinnedMergeBase(S) : S?.config?.base ?? 'HEAD');", to: "export const baseRef = (S) => (S?.config?.base ?? 'HEAD');" },
  { tag: 'B2', name: 'reassess: the local base branch comparison is dropped (AC1 silent)', file: 'ship-ticket/scripts/engine-base-read.mjs',
    from: 'if (local !== undefined && local !== B.merge_base) return moved(local,', to: 'if (false) return moved(local,' },
  // Both multi-URL guards at once (remoteIdentity, and remoteUrl since Round 1): either alone is an equivalent mutant.
  { tag: 'B3', name: 'several fetch URLs are accepted (the first is taken)', file: 'ship-ticket/scripts/remote-identity.mjs',
    from: "  if (urls.values.length > 1) return no('remote_ambiguous', `remote ${given} has", to: "  if (false) return no('remote_ambiguous', `remote ${given} has",
    also: [{ from: "  if (urls.values.length > 1) return no('remote_ambiguous', `remote ${name} has", to: "  if (false) return no('remote_ambiguous', `remote ${name} has" }] },
  { tag: 'B4', name: 'reassess: a base refusal is ignored (offline or a moved base passes)', file: 'ship-ticket/scripts/engine-gates.mjs',
    from: '  if (baseNo) return baseNo;\n', to: '' },
  { tag: 'B5', name: 'load: a partial pin (flag, S.base, config.pinnedBase disagree) is resumed', file: 'ship-ticket/scripts/run-engine.mjs',
    from: "      if (new Set([E.policy.semantics.pinnedBase === true, Object.hasOwn(E.S, 'base'), pinnedBaseOn(E.S)]).size !== 1)\n", to: '      if (false)\n' },
  { tag: 'B6', name: 'hardened reads: replace refs are honored (the pinned commit can be replaced)', file: 'ship-ticket/scripts/engine-base-read.mjs',
    from: "  return { ...clean, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };", to: '  return { ...clean, GIT_GRAFT_FILE: devNull };' },
  { tag: 'B7', name: 'hardened reads: grafts are honored (ancestry can be rewritten)', file: 'ship-ticket/scripts/engine-base-read.mjs',
    from: "  return { ...clean, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };", to: "  return { ...clean, GIT_NO_REPLACE_OBJECTS: '1' };" },
  { tag: 'B8', name: 'hardened reads: inherited GIT_* variables are kept (GIT_DIR redirects the pin)', file: 'ship-ticket/scripts/engine-base-read.mjs',
    from: '  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k)));', to: '  const clean = { ...env };' },
  { tag: 'B9', name: 'remoteUrl: a remote with no URL is accepted (its name is read as a path)', file: 'ship-ticket/scripts/remote-identity.mjs',
    from: "  if (urls.values.length === 0) return no('base_unverified',", to: "  if (false) return no('base_unverified'," },
  { tag: 'B10', name: 'load and reassess: a malformed S.base counts as a pin', file: 'ship-ticket/scripts/engine-base-read.mjs',
    from: 'export function wellFormedBase(B) {\n', to: 'export function wellFormedBase(B) {\n  return true;\n' },
  { tag: 'B11', name: 'remoteIdentity: a foreign push URL is skipped when the fetch URL names no GitHub repository', file: 'ship-ticket/scripts/remote-identity.mjs',
    from: 'if (push !== null && push !== url && !(id && sameRepository(repositoryOf(push), id)))', to: 'if (push !== null && push !== url && id && !sameRepository(repositoryOf(push), id))' },
  { tag: 'B12', name: 'init: a branch with no upstream is pinned', file: 'ship-ticket/scripts/engine-base-read.mjs',
    from: "    if (authGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).status !== 0)\n", to: '    if (false)\n' },
];

const tagged = (tag) => ['--test-name-pattern', `\\[${tag}\\]`];
/** The child must report TAP on its own stdout: a NODE_TEST_CONTEXT inherited from this runner sends it to our channel instead (a vacuous pass). */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
/** How many tests of the target file carry `tag` (all tags when null): the count a run must prove it executed. */
const TEST_SRC = readFileSync(join(SKILLS, TEST), 'utf8');
const taggedCount = (tag) => [...TEST_SRC.matchAll(/^test\('([^']*)'/gm)].filter(([, n]) => (tag ? n.includes(`[${tag}]`) : /\[B\d+\]/.test(n))).length;
const tapCount = (r, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);

test('S-12 mutation: the tagged base tests pass on the unpatched copy and each guard mutant is killed by its own tag', { skip: SKIP, timeout: 40 * 60 * 1000 }, async (t) => {
  const raw = await runMutantAsync({ root: SKILLS, testRel: TEST, env: CHILD_ENV, args: ['--test-name-pattern', '\\[B\\d+\\]'], timeout: TIMEOUT_MS });
  const control = classify(raw);
  assert.equal(control.verdict, 'survived', `the control passes every tagged test: ${JSON.stringify(control)}`);
  assert.ok(taggedCount(null) >= BASE_MUTANTS.length, 'the target file has tagged tests');
  assert.ok(tapCount(raw, 'pass') >= taggedCount(null) && tapCount(raw, 'fail') === 0, `the control RAN every tagged test (pass ${tapCount(raw, 'pass')} of ${taggedCount(null)}, fail ${tapCount(raw, 'fail')})`);
  const rows = [];
  for (const m of BASE_MUTANTS) { // one at a time: the engine suites give false failures under load
    let src = loadMutationSource(join(SKILLS, m.file));
    for (const x of [{ from: m.from, to: m.to }, ...(m.also ?? [])]) {
      assert.equal(src.split(x.from).length, 2, `${m.tag}: its anchor occurs exactly once in ${m.file}`);
      src = src.replace(x.from, x.to);
    }
    const out = await runMutantAsync({ root: SKILLS, testRel: TEST, env: CHILD_ENV, overrides: { [m.file]: src }, args: tagged(m.tag), timeout: TIMEOUT_MS });
    const r = classify(out), ran = tapCount(out, 'pass') + tapCount(out, 'fail');
    const own = r.failing.some(f => f.includes(`[${m.tag}]`));
    rows.push({ tag: m.tag, name: m.name, verdict: r.verdict, own_tag_failed: own, ran, tagged: taggedCount(m.tag), failing: r.failing, ...(r.why ? { why: r.why } : {}) });
    t.diagnostic(JSON.stringify(rows.at(-1)));
  }
  assert.deepEqual(rows.filter(r => !(r.verdict === 'killed' && r.own_tag_failed && r.tagged > 0 && r.ran >= r.tagged)).map(r => `${r.tag} ${r.verdict} ran ${r.ran}/${r.tagged}`), [],
    'every mutant ran its tagged tests and is killed by a test carrying its tag');
});
