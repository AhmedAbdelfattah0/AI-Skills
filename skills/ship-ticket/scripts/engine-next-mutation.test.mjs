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
const PURE = 'ship-ticket/scripts/engine-next.test.mjs', CLI = 'ship-ticket/scripts/run-engine-next.test.mjs', PROP = 'ship-ticket/scripts/engine-next-property.test.mjs';
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
    from: 'd.marker_exists && !consumedBy(S.review_chain ?? [], d, dispatchKind(S, d))', to: 'd.marker_exists && true' },
  { tag: 'N8', test: CLI, name: 'ready_work includes a node with a LIVE attempt', file: 'ship-ticket/scripts/engine-attempts.mjs',
    from: "['pending', 'stale'].includes(n.state) && !running.has(n.id)", to: "['pending', 'stale', 'running'].includes(n.state) && !running.has(n.id)" },
  { tag: 'N9', test: PURE, name: 'an unloadable state continues instead of FAILED', file: NEXT,
    from: "return shape(null, { disposition: 'FAILED', code,", to: "return shape(null, { disposition: 'READY', code," },
  { tag: 'N10', test: PURE, name: 'PUBLISH .. POST_MERGE owned by the orchestrator', file: NEXT,
    from: "`${stage.toLowerCase()}_owner_owned`, 'owner_publish',", to: "`${stage.toLowerCase()}_owner_owned`, 'resolve'," },
  { tag: 'N11', test: CLI, name: 'status records and commits state', file: 'ship-ticket/scripts/run-engine.mjs',
    from: '    const g = await N.gather(C, ext);\n', to: "    const g = await N.gather(C, ext); note(E.S, 'NEXT_DERIVED', {}); await E.commit();\n" },
  // Round 1 repair (PR #125)
  { tag: 'N12', test: PURE, name: 'only the first judgment is classified (a later human stop is hidden)', file: NEXT,
    from: '  return fold(list.map(j => judgmentSignal(S, j, reasons, detail)));', to: '  return judgmentSignal(S, list[0], reasons, detail);' },
  { tag: 'N13', test: PURE, name: 'a cached SHIP_READY completes for a moved or unknown candidate', file: NEXT,
    from: "else if (x.authorizing && !x.retry && cur !== x.authorizing.candidate_id)", to: 'else if (false)' },
  { tag: 'N14', test: PURE, name: 'a review is ready while a dispatched lane (partition) is still pending', file: NEXT,
    from: '&& list.length > 0 && list.every(ready);', to: '&& list.length > 0;' },
  { tag: 'N15', test: PURE, name: 'a confirmation second opinion is filed under the original review', file: NEXT,
    from: "return d.candidate_id === rec.new_candidate ? 'confirmation' : 'original';", to: "return 'original';" },
  { tag: 'N16', test: PURE, name: 'a repeated ENGINE verification refusal stays with the orchestrator', file: NEXT,
    from: "if (cls[0] === 'ENGINE_FAILURE' && cls[1] === 'verification') return repeat > 1 ?", to: "if (cls[0] === 'ENGINE_FAILURE' && cls[1] === 'verification') return false ?" },
  { tag: 'N17', test: PURE, name: 'a lock holder of unknown liveness is reported free', file: NEXT,
    from: "state: v.state === 'dead' ? 'free' : 'held'", to: "state: v.state === 'alive' ? 'held' : 'free'" },
  { tag: 'N18', test: PURE, name: 'a ship-ready refusal of another candidate blocks the current one', file: NEXT,
    from: "export const latestRow = (gates, gate, c) => (gates ?? []).filter(g => g.gate === gate && (g.candidate_id == null || g.candidate_id === c)).at(-1) ?? null;", to: 'export const latestRow = (gates, gate, c) => (gates ?? []).filter(g => g.gate === gate).at(-1) ?? null;' },
  { tag: 'N19', test: PURE, name: 'with no execution chosen, another candidate\'s incomplete execution is reused', file: NEXT,
    from: 'mine.filter(sameCand).map(d => d.review_execution)', to: 'mine.map(d => d.review_execution)' },
  { tag: 'N20', test: PURE, name: 'liveness ignores the process group (a gone leader reads dead while members run)', file: NEXT,
    from: "return g === true ? { state: 'unknown', reason: 'leader_gone_group_alive' } :", to: 'return g === true ? v :' },
  { tag: 'N21', test: PURE, name: 'a result is timed by its interval close, not its file', file: NEXT,
    from: '(d.marker_exists && Number.isFinite(d.mtime) ? d.mtime : d.ended ? d.ended_ms : null)', to: '(d.ended ? d.ended_ms : d.marker_exists ? d.mtime : null)' },
  // Attempt 2 (PR #125 round 2): the fold order, the null-candidate rule and the history retention die by the invariant property test
  { tag: 'N22', test: PROP, name: 'fold order: a human-owned signal ranks like an orchestrator BLOCKED', file: NEXT,
    from: "if (ACTIONS[r.action] === 'human') return", to: 'if (false) return' },
  { tag: 'N23', test: PROP, name: 'a candidate-less (legacy) lane is dropped instead of applying to the current candidate', file: NEXT,
    from: 'const sameCand = (d) => d.candidate_id == null || d.candidate_id === w.candidate;', to: 'const sameCand = (d) => d.candidate_id === w.candidate;' },
  { tag: 'N24', test: PROP, name: 'gate history keeps one row per gate (the last), not every row per candidate', file: NEXT,
    from: "export const latestRow = (gates, gate, c) => (gates ?? []).filter(g => g.gate === gate && (g.candidate_id == null || g.candidate_id === c)).at(-1) ?? null;",
    to: 'export const latestRow = (gates, gate, c) => { const l = (gates ?? []).filter(g => g.gate === gate).at(-1); return l && (l.candidate_id == null || l.candidate_id === c) ? l : null; };' },
  { tag: 'N25', test: PURE, name: 'consumption ignores the candidate', file: NEXT,
    from: '&& (r.candidate_id === undefined || d.candidate_id === null || r.candidate_id === d.candidate_id));', to: ');' },
  { tag: 'N26', test: PURE, name: 'an unavailable candidate never escalates (repeat fixed at 1)', file: NEXT,
    from: '{ repeat: unavailableRepeat(f.gates) }', to: '{ repeat: 1 }' },
  { tag: 'N27', test: PURE, name: 'a spent quiescence_unknown stays a human stop', file: NEXT,
    from: "const spentQuiescence = (S, j) => j.code === 'quiescence_unknown'", to: "const spentQuiescence = (S, j) => false && j.code === 'quiescence_unknown'" },
  // Attempt 2 round 1 repair (PR #125 @ 77da744): N28-N31 die by the property tests (independent oracle), N32 by its pin
  { tag: 'N28', test: PROP, name: 'a trusted RETRY never supersedes the retried execution\'s review refusals (deadlock)', file: NEXT,
    from: '  if (x.retry) {\n    const rx = x.retry.review_execution;', to: '  if (false) {\n    const rx = x.retry.review_execution;' },
  { tag: 'N29', test: PROP, name: 'a human-class review refusal clears like an input refusal (a later result clears it)', file: NEXT,
    from: "  if (ACTIONS[refusal(r.code, []).action] === 'human') return true;\n", to: '' },
  { tag: 'N30', test: PROP, name: 'a candidate-less second opinion during the confirmation is filed under the original', file: NEXT,
    from: "if (d.candidate_id == null) return chain.some(r => r.kind === 'confirmation' && r.review_execution === d.review_execution) ? 'original' : 'confirmation';",
    to: "if (d.candidate_id == null) return 'original';" },
  { tag: 'N31', test: PROP, name: 'an input refusal binds over a pending or missing lane', file: NEXT,
    from: '  return complete(bucket.roles, bucket.mine) && !bucket.mine.some(', to: '  return !bucket.mine.some(' },
  { tag: 'N32', test: PURE, name: 'an input refusal never clears (a corrected result is ignored)', file: NEXT,
    from: '&& !bucket.mine.some(d => (d.result_ms ?? -Infinity) > r.at_ms);', to: ';' },
];

const tagged = (tag) => ['--test-name-pattern', `\\[${tag}\\]`];
/** The child must report TAP on its own stdout: a NODE_TEST_CONTEXT inherited from this runner sends it to our channel instead (a vacuous pass). */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const taggedCount = (file, tag) => [...readFileSync(join(SKILLS, file), 'utf8').matchAll(/^test\('([^']*)'/gm)]
  .filter(([, n]) => (tag ? n.includes(`[${tag}]`) : /\[N\d+\]/.test(n))).length;
const tapCount = (r, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);

test('S-14a mutation: the tagged next_action tests pass on the unpatched copy and each guard mutant is killed by its own tag', { skip: SKIP, timeout: 40 * 60 * 1000 }, async (t) => {
  for (const file of [PURE, CLI, PROP]) {
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
