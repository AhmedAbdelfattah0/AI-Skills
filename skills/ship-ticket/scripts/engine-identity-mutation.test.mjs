/**
 * S-28a (ASTF-5): every repository-identity guard has a named mutant, on the ONE shared harness (lib/mutation.test-helper.mjs:
 * CRLF-safe anchors, a kill only when every failure is an assertion). Each mutant copies skills/ with its exact-once
 * replacements (one or more files) and runs only the run-engine-identity.test.mjs tests tagged with its own tag; the unpatched
 * copy (the control) must pass every tagged test, or the verdicts would say nothing.
 *
 * P's identity-mutation suite (a890b0d engine-identity-mutation.test.mjs) is rewritten here, not ported: most of its mutants patch
 * S-15/S-28b modules. P's I1 (several URLs) is S-12's B3 (engine-base-mutation.test.mjs), still killed there. Runs with
 * ENGINE_MUTATION=1 or ENGINE_IDENTITY_MUTATION=1.
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
const TEST = 'ship-ticket/scripts/run-engine-identity.test.mjs';
const SKIP = !POSIX ? 'POSIX process groups (known limit D4)'
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_IDENTITY_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_IDENTITY_MUTATION=1' : false;
const TIMEOUT_MS = 10 * 60 * 1000;

const ID = 'ship-ticket/scripts/engine-identity.mjs', GATES = 'ship-ticket/scripts/engine-gates.mjs', ENGINE = 'ship-ticket/scripts/run-engine.mjs';
const STAGE = '  return underHardenedGit(() => identityRefusal(E, stage) ?? frozenBase(E, stage, RECORDED[stage](E.S)));';
const skipAt = (s) => `  return underHardenedGit(() => (stage === '${s}' ? null : identityRefusal(E, stage)) ?? frozenBase(E, stage, RECORDED[stage](E.S)));`;

/** One guard each: its tag and its exact-once edits ({ file relative to skills/, from, to }). */
export const IDENTITY_MUTANTS = [
  { tag: 'I1', name: 'reassess: the identity comparison is omitted (a re-pointed origin reassesses)',
    edits: [{ file: GATES, from: "  const idNo = identityRefusal(E, 'reassess');", to: '  const idNo = null;' }] },
  { tag: 'I2', name: 'review original: the identity comparison is omitted (V-review)', edits: [{ file: ID, from: STAGE, to: skipAt('review') }] },
  { tag: 'I3', name: 'review confirmation: the identity comparison is omitted', edits: [{ file: ID, from: STAGE, to: skipAt('confirmation') }] },
  { tag: 'I4', name: 'ship-ready: the identity comparison is omitted (V-ship-ready)', edits: [{ file: ID, from: STAGE, to: skipAt('ship-ready') }] },
  { tag: 'I5', name: 'review original: the freeze base is not recorded', edits: [{ file: GATES, from: '...(idAt ? { base: idAt.base } : {})', to: '' }] },
  { tag: 'I6', name: 'repair re-freeze drops the base, and load accepts a freeze without one',
    edits: [{ file: 'ship-ticket/scripts/engine-attempts.mjs', from: ', ...(S.freeze?.base ? { base: S.freeze.base } : {}) };', to: ' };' },
      { file: ID, from: "  const frozen = S.freeze === null || (exact(S.freeze, 'base,candidate,seq') && wellFormedFreezeBase(S.freeze.base, S.base));", to: '  const frozen = true;' }] },
  { tag: 'I7', name: 'ship-ready verifies against the pin, not the freeze base (a rewind below the freeze passes)',
    edits: [{ file: ID, from: '  const v = verifyFrozenBase(E, recorded);', to: "  const v = verifyFrozenBase(E, stage === 'ship-ready' ? E.S.base : recorded);" }] },
  { tag: 'I8', name: 'init: a null identity (no GitHub origin) is accepted',
    edits: [{ file: ENGINE, from: '    if (pin && repoIdentityOn(dag) && pin.base.identity === null)\n', to: '    if (false)\n' }] },
  { tag: 'I9', name: 'load: the identity invariant is removed',
    edits: [{ file: ENGINE, from: '      if (repoIdentity !== repoIdentityOn(E.S) || (repoIdentity && !identityStateHolds(E.S)))\n', to: '      if (false)\n' }] },
  { tag: 'I10', name: 'load: any freeze or SHIP_READY base is well-formed', edits: [{ file: ID, from: 'export function wellFormedFreezeBase(B, pin) {\n', to: 'export function wellFormedFreezeBase(B, pin) {\n  return true;\n' }] },
  // H2: the default branch is read from the LOCAL refs/remotes/origin/HEAD symref, formatted as ls-remote --symref prints it
  { tag: 'I11', name: 'init (HEAD mode): resolveBaseRef reads the local origin/HEAD symref', edits: [{ file: 'ship-ticket/scripts/remote-identity.mjs',
    from: "  const r = authGit(repoRoot, ['ls-remote', '--symref', '--', remote, 'HEAD']);",
    to: "  const l = authGit(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']); const r = { ...l, stdout: `ref: ${l.stdout.trim().replace('refs/remotes/origin/', 'refs/heads/')}\\tHEAD\\n` };" }] },
];

const tagged = (tag) => ['--test-name-pattern', `\\[${tag}\\]`];
/** The child must report TAP on its own stdout: a NODE_TEST_CONTEXT inherited from this runner sends it to our channel instead (a vacuous pass). */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const TEST_SRC = readFileSync(join(SKILLS, TEST), 'utf8');
/** How many tests of the target file carry `tag` (every [I#] when null): the count a run must prove it executed. */
const taggedCount = (tag) => [...TEST_SRC.matchAll(/^test\('([^']*)'/gm)].filter(([, n]) => (tag ? n.includes(`[${tag}]`) : /\[I\d+\]/.test(n))).length;
const tapCount = (r, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);

/** The sources each mutant runs with: every edit's anchor must occur exactly once in the file it patches. */
export function mutantSources(m, load = (f) => loadMutationSource(join(SKILLS, f))) {
  const out = {};
  for (const e of m.edits) {
    const src = out[e.file] ?? load(e.file);
    assert.equal(src.split(e.from).length, 2, `${m.tag}: its anchor occurs exactly once in ${e.file}: ${e.from}`);
    out[e.file] = src.replace(e.from, () => e.to);
  }
  return out;
}

test('S-28a mutation anchors: every edit of every identity mutant occurs exactly once (cheap, always runs)', () => {
  for (const m of IDENTITY_MUTANTS) mutantSources(m);
  assert.equal(new Set(IDENTITY_MUTANTS.map(m => m.tag)).size, IDENTITY_MUTANTS.length);
  for (const m of IDENTITY_MUTANTS) assert.ok(taggedCount(m.tag) > 0, `${m.tag} has a tagged test`);
});

test('S-28a mutation: the tagged identity tests pass on the unpatched copy and each guard mutant is killed by its own tag', { skip: SKIP, timeout: 60 * 60 * 1000 }, async (t) => {
  const raw = await runMutantAsync({ root: SKILLS, testRel: TEST, env: CHILD_ENV, args: ['--test-name-pattern', '\\[I\\d+\\]'], timeout: TIMEOUT_MS });
  const control = classify(raw);
  assert.equal(control.verdict, 'survived', `the control passes every tagged test: ${JSON.stringify(control)}`);
  assert.ok(tapCount(raw, 'pass') >= taggedCount(null) && tapCount(raw, 'fail') === 0, `the control RAN every tagged test (pass ${tapCount(raw, 'pass')} of ${taggedCount(null)}, fail ${tapCount(raw, 'fail')})`);
  const rows = [];
  for (const m of IDENTITY_MUTANTS) { // one at a time: the engine suites give false failures under load
    const out = await runMutantAsync({ root: SKILLS, testRel: TEST, env: CHILD_ENV, overrides: mutantSources(m), args: tagged(m.tag), timeout: TIMEOUT_MS });
    const r = classify(out), ran = tapCount(out, 'pass') + tapCount(out, 'fail');
    const own = r.failing.some(f => f.includes(`[${m.tag}]`));
    rows.push({ tag: m.tag, name: m.name, verdict: r.verdict, own_tag_failed: own, ran, tagged: taggedCount(m.tag), failing: r.failing, ...(r.why ? { why: r.why } : {}) });
    t.diagnostic(JSON.stringify(rows.at(-1)));
  }
  assert.deepEqual(rows.filter(r => !(r.verdict === 'killed' && r.own_tag_failed && r.tagged > 0 && r.ran >= r.tagged)).map(r => `${r.tag} ${r.verdict} ran ${r.ran}/${r.tagged}`), [],
    'every mutant ran its tagged tests and is killed by a test carrying its tag');
});
