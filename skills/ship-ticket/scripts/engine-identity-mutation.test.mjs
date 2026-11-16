/**
 * R0-S round 5 (item 4): every mandatory stage's release verifier, and each round-5 fix, has a named mutant. Each mutant is a copy of the
 * layout the engine needs (skills/ship-ticket and skills/vapt) in a temp dir with ONE exact string replacement that must match exactly once
 * (the repository is never edited). For mutant M the tests tagged [M] in run-engine-r0s5.test.mjs must FAIL with a failing test carrying
 * that tag, and the unpatched copy (the control) must PASS every tagged test, or the result would say nothing.
 *   V-*   the stage's verifyReleaseBinding is OMITTED: it returns ok with the recorded identity and base (a plausible shape: the caller runs on
 *         and the tagged test fails on its expected refusal code, never on a TypeError)
 *   H2    the base of record resolved from the LOCAL refs/remotes/<r>/HEAD symref instead of ls-remote --symref
 *   I1    remote URLs read as the last configured value (pre-round-5); I2 the brief rendered by the repository's own `git diff`;
 *   I2b   the inventory not bound to the frozen candidate; I2e / I2h diff.ignoreSubmodules honoured by candidate-id / the history check;
 *   I3    filter=latest;
 *   I3b   supersession across workflow runs.
 * Runs with ENGINE_MUTATION=1 (the engine-properties CI job) or ENGINE_IDENTITY_MUTATION=1. POSIX only (the tagged tests are).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX } from './engine-test-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAPT = join(HERE, '..', '..', 'vapt');
const SKIP = !POSIX ? 'POSIX process groups (known limit D4)'
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_IDENTITY_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_IDENTITY_MUTATION=1' : false;
const TESTS = ['run-engine-r0s5.test.mjs'];
const CONCURRENCY = 3;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const ENTRY = "  if (!S?.enrollment) return no('identity_unbound', 'the run is not enrolled: no release identity is recorded');\n";
/** The stage's verifier omitted: ok with the identity and base the run recorded (review: the receipts' freeze), nothing checked. */
const omitted = (stage) => ENTRY + `  if (stage === '${stage}') { const r = stage === 'review' ? (a.recorded ?? (S.review_dispatches ?? []).findLast(d => d.base)?.base ?? null)`
  + ` : stage === 'ship-ready' ? S.freeze?.base ?? null : S.ship_ready?.base ?? null; return { ok: true, identity: S.enrollment.identity ?? null, base: r ? { ...r, remote_head: r.sha } : null }; }\n`;

export const IDENTITY_MUTANTS = [
  ...['review', 'ship-ready', 'publish', 'ci', 'complete'].map(stage => ({ tag: `V-${stage}`, name: `${stage}: the release verifier is omitted`, file: 'engine-identity.mjs', from: ENTRY, to: omitted(stage) })),
  { tag: 'H2', name: 'the base of record read from the local refs/remotes/<r>/HEAD symref', file: 'engine-identity.mjs',
    from: "  const r = authGit(repoRoot, ['ls-remote', '--symref', remote, 'HEAD']);",
    to: "  const r = (() => { const x = authGit(repoRoot, ['symbolic-ref', `refs/remotes/${remote}/HEAD`]); return x.status === 0 ? { ...x, stdout: `ref: ${x.stdout.trim().replace(`refs/remotes/${remote}/`, 'refs/heads/')}\\tHEAD\\n` } : x; })();" },
  { tag: 'I1', name: 'remote URLs read as the last configured value', file: 'engine-identity.mjs',
    from: "  return { ok: true, values: r.stdout.split('\\n').map(s => s.trim()).filter(Boolean) };",
    to: "  return { ok: true, values: r.stdout.split('\\n').map(s => s.trim()).filter(Boolean).slice(-1) };" },
  { tag: 'I2', name: 'the brief rendered by the repository\'s own git diff (attributes, drivers and filters apply), unverified', file: 'engine-review-dispatch.mjs',
    from: "      const hunks = oldT === newT ? '' : renderHunks(tmp, env, oldT, newT);\n      if (applyHunks(oldT, hunks) !== newT) throw unverified(`the rendered diff of ${p} does not reproduce its bytes`);",
    to: "      const rr = spawnSync('git', ['diff', '--no-color', mergeBase, '--', p], { cwd: repoRoot, encoding: 'utf8' }); const at = rr.stdout.search(/^@@ /m); const hunks = at < 0 ? '' : rr.stdout.slice(at).replace(/\\n$/, '');" },
  { tag: 'I2b', name: 'the brief inventory is not bound to the frozen candidate', file: 'engine-review-dispatch.mjs',
    from: '  if (recomputed !== candidate) throw unverified(', to: '  if (false) throw unverified(' },
  { tag: 'I2e', name: 'candidate-id honours diff.ignoreSubmodules', file: 'candidate-id.mjs',
    from: "'--ignore-submodules=none', mergeBase", to: 'mergeBase' },
  { tag: 'I2h', name: 'the publish history listing honours diff.ignoreSubmodules', file: 'engine-enroll.mjs',
    from: "'--ignore-submodules=none', '-z', range]", to: "'-z', range]" },
  { tag: 'I3', name: 'check runs read with filter=latest', file: 'engine-ci.mjs',
    from: "'-f', 'filter=all', '--paginate'", to: "'-f', 'filter=latest', '--paginate'" },
  { tag: 'I3b', name: 'a higher attempt of ANOTHER workflow run supersedes', file: 'engine-ci.mjs',
    from: "  for (const c of checks) if (annotated(c)) { const k = JSON.stringify([c.app ?? null, c.name, String(c.workflow_run)]);",
    to: "  for (const c of checks) if (annotated(c)) { const k = JSON.stringify([c.app ?? null, c.name]);" },
];

/** Copy the layout, apply `mutant` (null: the control), run the tagged tests -> { code, timedOut, failed, ran, tail }. */
async function runMutant(t, mutant, pattern) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-id-mutant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'skills', 'ship-ticket', 'scripts');
  mkdirSync(dir, { recursive: true });
  cpSync(HERE, dir, { recursive: true });
  cpSync(join(HERE, '..', 'references'), join(dir, '..', 'references'), { recursive: true });
  cpSync(join(HERE, '..', 'SKILL.md'), join(dir, '..', 'SKILL.md'));
  cpSync(VAPT, join(root, 'skills', 'vapt'), { recursive: true });
  if (mutant) {
    const file = join(dir, mutant.file), text = readFileSync(file, 'utf8');
    assert.equal(text.split(mutant.from).length, 2, `mutant ${mutant.tag}: its target text occurs exactly once in ${mutant.file}`);
    writeFileSync(file, text.replace(mutant.from, mutant.to));
  }
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, ['--test', `--test-name-pattern=${pattern}`, ...TESTS], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
  const code = await new Promise(r => child.on('close', r));
  clearTimeout(timer);
  return { code, timedOut, failed: [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1]), ran: Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? 0), out, tail: out.slice(-1500) };
}

const esc = (tag) => tag.replace(/[-]/g, '\\-');

test('round-5 mutation: the tagged tests pass on the unpatched copy and each mutant (an omitted stage verifier, or a reverted round-5 fix) fails a test carrying its tag', { skip: SKIP, timeout: 40 * 60 * 1000 }, async (t) => {
  const tags = [...new Set(IDENTITY_MUTANTS.map(m => m.tag))];
  const src = TESTS.map(f => readFileSync(join(HERE, f), 'utf8')).join('\n');
  for (const tag of tags) assert.ok(src.includes(`[${tag}]`), `a test is tagged [${tag}]`);
  const all = `\\[(${tags.map(esc).join('|')})\\]`;
  const jobs = [null, ...IDENTITY_MUTANTS];
  const results = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY)
    results.push(...await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (m) => ({ m, ...await runMutant(t, m, m ? `\\[${esc(m.tag)}\\]` : all) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test:\n${control.tail}`);
  assert.ok(control.ran >= tags.length, `the control ran the tagged tests (${control.ran})`);
  const caught = (r) => !r.timedOut && r.code !== 0 && r.failed.some(f => f.includes(`[${r.m.tag}]`));
  for (const r of mutants) t.diagnostic(JSON.stringify({ mutant: r.m.tag, name: r.m.name, caught: caught(r), exit: r.code, failing: r.failed }));
  const crashed = mutants.filter(r => /TypeError|Cannot read properties/.test(r.out)).map(r => r.m.tag);
  assert.deepEqual(crashed, [], 'a mutant is caught by a refusal-code assertion, never by a crash');
  const survivors = mutants.filter(r => !caught(r)).map(r => `${r.m.tag} ${r.m.name} (exit ${r.code}, failing ${r.failed.join(' | ') || 'none'})`);
  assert.deepEqual(survivors, [], 'every mutant is caught by a test tagged with it');
});
