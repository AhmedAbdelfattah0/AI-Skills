/**
 * S-14a (ASTF-8): every next_action guard has a named mutant, on the ONE shared harness (lib/mutation.test-helper.mjs: CRLF-safe
 * anchors, a kill only when every failure is an assertion). Each mutant copies skills/ with ONE exact-once replacement and runs
 * only the tests of its target file tagged with its own tag; the unpatched copy (the control) must pass every tagged test of
 * both files first. N1 (delete any rule) is the in-test rule-omission harness of engine-next.test.mjs, which derives every pinned
 * scenario with each rule omitted. Runs with ENGINE_MUTATION=1 or ENGINE_NEXT_MUTATION=1 (engine-properties CI job).
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
const PURE = 'ship-ticket/scripts/engine-next.test.mjs', CLI = 'ship-ticket/scripts/run-engine-next.test.mjs';
const SKIP = !POSIX ? 'POSIX process groups (known limit D4)'
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_NEXT_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_NEXT_MUTATION=1' : false;
const TIMEOUT_MS = 10 * 60 * 1000;
const NEXT = 'ship-ticket/scripts/engine-next.mjs';

/** One guard each: its tag, the test file that must kill it, the file (relative to skills/) and the exact text replaced. */
export const NEXT_MUTANTS = [
  { tag: 'N2', test: PURE, name: 'turn_end: a human-owned BLOCKED continues', file: NEXT,
    from: "if (disposition === 'NEEDS_APPROVAL' || (disposition === 'BLOCKED' && owner === 'human')) return 'WAIT_FOR_USER';", to: "if (disposition === 'NEEDS_APPROVAL') return 'WAIT_FOR_USER';" },
  { tag: 'N3', test: PURE, name: 'a human-owned (SECURITY / UNKNOWN) code is handed to the orchestrator', file: NEXT,
    from: '  return human();\n}', to: "  return { ...base, disposition: 'BLOCKED', action };\n}" },
  { tag: 'N4', test: PURE, name: 'an unlisted code defaults to ENGINE_FAILURE (a fallback is offered)', file: NEXT,
    from: "return CLASS_OF.get(code) ?? ['UNKNOWN_FAILURE'];", to: "return CLASS_OF.get(code) ?? ['ENGINE_FAILURE', 'install'];" },
  { tag: 'N5', test: PURE, name: 'every failure class offers a fallback (SECURITY and APPROVAL included)', file: NEXT,
    from: 'const fallback = r.fallback_offered ? ', to: 'const fallback = r.failure_class ? ' },
  { tag: 'N6', test: PURE, name: 'liveness: alive without start-time equality', file: NEXT,
    from: "return now.startTime === recordedStart ? { state: 'alive', reason: 'start_time_equal' } : { state: 'dead', reason: 'pid_reused' };", to: "return { state: 'alive', reason: 'start_time_equal' };" },
  { tag: 'N7', test: CLI, name: 'unconsumed results ignore the review chain (a consumed result stays owed)', file: NEXT,
    from: String.raw`d.marker_exists && !recorded.has(` + '`${d.review_execution}\\u0000${ROLE_KIND[d.role]}`' + ')', to: 'd.marker_exists && true' },
  { tag: 'N8', test: CLI, name: 'ready_work includes a node with a LIVE attempt', file: 'ship-ticket/scripts/engine-attempts.mjs',
    from: "['pending', 'stale'].includes(n.state) && !running.has(n.id)", to: "['pending', 'stale', 'running'].includes(n.state) && !running.has(n.id)" },
  { tag: 'N9', test: PURE, name: 'an unloadable state continues instead of FAILED', file: NEXT,
    from: "return shape(null, { disposition: 'FAILED', code,", to: "return shape(null, { disposition: 'READY', code," },
  { tag: 'N10', test: PURE, name: 'PUBLISH .. POST_MERGE owned by the orchestrator', file: NEXT,
    from: "`${stage.toLowerCase()}_owner_owned`, 'owner_publish',", to: "`${stage.toLowerCase()}_owner_owned`, 'resolve'," },
  { tag: 'N11', test: CLI, name: 'status records and commits state', file: 'ship-ticket/scripts/run-engine.mjs',
    from: '    const g = await N.gather(C, ext);\n', to: "    const g = await N.gather(C, ext); note(E.S, 'NEXT_DERIVED', {}); await E.commit();\n" },
];

const tagged = (tag) => ['--test-name-pattern', `\\[${tag}\\]`];
/** The child must report TAP on its own stdout: a NODE_TEST_CONTEXT inherited from this runner sends it to our channel instead (a vacuous pass). */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const taggedCount = (file, tag) => [...readFileSync(join(SKILLS, file), 'utf8').matchAll(/^test\('([^']*)'/gm)]
  .filter(([, n]) => (tag ? n.includes(`[${tag}]`) : /\[N\d+\]/.test(n))).length;
const tapCount = (r, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);

test('S-14a mutation: the tagged next_action tests pass on the unpatched copy and each guard mutant is killed by its own tag', { skip: SKIP, timeout: 40 * 60 * 1000 }, async (t) => {
  for (const file of [PURE, CLI]) {
    const raw = await runMutantAsync({ root: SKILLS, testRel: file, env: CHILD_ENV, args: ['--test-name-pattern', '\\[N\\d+\\]'], timeout: TIMEOUT_MS });
    assert.equal(classify(raw).verdict, 'survived', `${file}: the control passes every tagged test: ${JSON.stringify(classify(raw))}`);
    assert.ok(taggedCount(file, null) > 0 && tapCount(raw, 'pass') >= taggedCount(file, null) && tapCount(raw, 'fail') === 0,
      `${file}: the control RAN every tagged test (pass ${tapCount(raw, 'pass')} of ${taggedCount(file, null)})`);
  }
  const rows = [];
  for (const m of NEXT_MUTANTS) { // one at a time: the engine suites give false failures under load
    const src = loadMutationSource(join(SKILLS, m.file));
    assert.equal(src.split(m.from).length, 2, `${m.tag}: its anchor occurs exactly once in ${m.file}`);
    const out = await runMutantAsync({ root: SKILLS, testRel: m.test, env: CHILD_ENV, overrides: { [m.file]: src.replace(m.from, m.to) }, args: tagged(m.tag), timeout: TIMEOUT_MS });
    const r = classify(out), ran = tapCount(out, 'pass') + tapCount(out, 'fail');
    rows.push({ tag: m.tag, name: m.name, verdict: r.verdict, own_tag_failed: r.failing.some(f => f.includes(`[${m.tag}]`)), ran, tagged: taggedCount(m.test, m.tag),
      failing: r.failing, ...(r.why ? { why: r.why } : {}) });
    t.diagnostic(JSON.stringify(rows.at(-1)));
  }
  assert.deepEqual(rows.filter(r => !(r.verdict === 'killed' && r.own_tag_failed && r.tagged > 0 && r.ran >= r.tagged)).map(r => `${r.tag} ${r.verdict} ran ${r.ran}/${r.tagged}`), [],
    'every mutant ran its tagged tests and is killed by a test carrying its tag');
});
