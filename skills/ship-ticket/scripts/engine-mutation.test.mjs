/**
 * AIS-HARNESS-3 Wave 3.5: mutation check of the Wave 3.5 harness. Each mutant is a copy of this
 * scripts directory in a temp dir with ONE engine guard patched out (an exact string replacement
 * that must match exactly once; the repo is never edited). The new property harness
 * (engine-explore.test.mjs: bounded exploration plus the directed gap-A and property rows) must
 * FAIL against every mutant (one ceiling mutant is marked equivalent with its reasoning and reported,
 * not asserted), and must PASS against the unpatched copy (the control), or the result
 * would say nothing.
 *
 * Slow (one harness run per mutant), so it runs only with ENGINE_MUTATION=1: the POSIX
 * engine-properties CI job sets it. ENGINE_MUTATION_BUDGET sets the exploration budget per ceiling
 * inside each run (default 50, the exploration's own default, so the control also asserts its coverage signals).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX } from './engine-test-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP = !POSIX ? 'POSIX process groups (known limit D4)'
  : process.env.ENGINE_MUTATION !== '1' ? 'slow: runs in the engine-properties CI job (ENGINE_MUTATION=1)' : false;
const BUDGET = process.env.ENGINE_MUTATION_BUDGET ?? '50';
const CONCURRENCY = 4;

/** One guard each: the property it protects, the file, and the exact text replaced. */
export const MUTANTS = [
  { name: 'freshness: unit evidence never goes stale', property: 'P5', file: 'engine-units.mjs',
    from: 'function causeOf(S, ev, now, depsVerified) {\n', to: 'function causeOf(S, ev, now, depsVerified) {\n  return null;\n' },
  { name: 'quiescence: retire() records an attempt without proving its group gone', property: 'P4', file: 'engine-quiesce.mjs',
    from: 'const quiet = unreleased ? false : await quiesce(a.pgid, isAlive);', to: 'const quiet = false;' },
  { name: 'retry authorization: an untrusted (dispatched) RETRY authorizes a review', property: 'P2', file: 'engine-authority.mjs',
    from: "return { retry: trustedEvents(S, 'RETRY').find(match) ?? null,", to: "return { retry: [...trustedEvents(S, 'RETRY'), ...untrustedEvents(S, 'RETRY')].find(match) ?? null," },
  { name: 'retry authorization: mark failed->pending ignores the one-retry cap', property: 'P9', file: 'run-engine.mjs',
    from: 'if ((n.retries ?? 0) >= MAX_RETRIES) throw coded', to: 'if (false) throw coded' },
  { name: 'ceiling: a unit re-check never hits parent_ceiling', property: 'P8', file: 'engine-units.mjs',
    from: 'if (!held && used + heldOf(S) >= limit) {', to: 'if (false) {' },
  // Expected to survive (an equivalent mutant in every reachable state, by reading): spendCeiling's own
  // room check is defence in depth. Its callers check first: a re-review spends only when affordReview,
  // a repair only when opensNow (room after the re-review >= 3), and a confirmation is reachable only
  // while its cycle is open, which keeps its held confirmation slot (then `held` skips the check).
  { name: 'ceiling: a unit review cycle spends without room', property: 'P8', file: 'engine-units.mjs',
    from: 'if (!held && used + heldOf(S) + reserve > limit) return false;', to: '',
    equivalent: 'callers pre-check the room (affordReview, opensNow) and a reachable confirmation always holds its slot' },
  { name: 'ceiling: a unit FAIL opens its repair whatever the room', property: 'P8', file: 'engine-unit-review.mjs',
    from: 'const opensNow = opens && affordReview && room - reCost >= REPAIR_RESERVE;', to: 'const opensNow = opens;' },
];

/** Copy the scripts dir, apply `mutant` (null: the control), run the property harness; resolve its exit code and failing test names. */
async function runHarness(t, mutant) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-mutant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'scripts');
  cpSync(HERE, dir, { recursive: true });
  if (mutant) {
    const file = join(dir, mutant.file), text = readFileSync(file, 'utf8');
    assert.equal(text.split(mutant.from).length, 2, `mutant "${mutant.name}": its target text occurs exactly once in ${mutant.file}`);
    writeFileSync(file, text.replace(mutant.from, mutant.to));
  }
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, ['--test', 'engine-explore.test.mjs'], { cwd: dir, env: { ...env, ENGINE_EXPLORE_BUDGET: BUDGET }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise(r => child.on('close', r));
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1]);
  const violations = [...new Set([...out.matchAll(/\b(P\d+) [a-zA-Z-]+(?:@[^:]*)?: /g)].map(m => m[1]))];
  return { code, failed, violations, tail: out.slice(-1500) };
}

test('mutation: the property harness passes on the unpatched copy and fails on every guard mutant', { skip: SKIP, timeout: 30 * 60 * 1000 }, async (t) => {
  const jobs = [null, ...MUTANTS];
  const results = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    results.push(...await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (m) => ({ m, ...await runHarness(t, m) }))));
  }
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control (unpatched copy) passes, or the mutation results mean nothing:\n${control.tail}`);
  for (const r of mutants) {
    t.diagnostic(JSON.stringify({ mutant: r.m.name, guards: r.m.property, caught: r.code !== 0, ...(r.m.equivalent ? { equivalent: r.m.equivalent } : {}), properties_violated: r.violations,
      failing_tests: r.failed.filter(f => !/^ceiling \d/.test(f)) }));
  }
  const survivors = mutants.filter(r => r.code === 0 && !r.m.equivalent).map(r => r.m.name);
  assert.deepEqual(survivors, [], 'every mutant not argued equivalent is caught by the harness');
  assert.ok(mutants.filter(r => !r.m.equivalent).length >= 6, 'the freshness, quiescence, retry-authorization and ceiling guards are all mutated');
});
