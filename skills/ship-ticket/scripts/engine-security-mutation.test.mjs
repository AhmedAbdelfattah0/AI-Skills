/**
 * AIS-HARNESS-4 Wave B (class rule C2): every security guard has a named mutant. Each mutant is a copy
 * of the repository layout the engine needs (skills/ship-ticket/scripts and skills/vapt, for the
 * catalog and its evaluator) in a temp dir with ONE guard patched out by an exact string replacement
 * that must match exactly once (the repo is never edited). For mutant S#, the tests tagged [S#] in
 * gate-security.test.mjs and run-engine-security.test.mjs must FAIL with a failing test carrying that
 * tag; the unpatched copy (the control) must PASS every tagged test, or the result would say nothing.
 *
 * Runs with ENGINE_MUTATION=1 (the engine-properties CI job) or ENGINE_SECURITY_MUTATION=1.
 * It does not import engine-mutation.test.mjs (that would register its 30-minute run here too).
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
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_SECURITY_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_SECURITY_MUTATION=1' : false;
const TESTS = ['gate-security.test.mjs', 'run-engine-security.test.mjs'];
const CONCURRENCY = 4;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** One guard each: its tag, the file, and the exact text replaced. */
export const SECURITY_MUTANTS = [
  { tag: 'S1', name: 'DAG: policy-2 keys are never validated', file: 'engine-dag.mjs',
    from: '  validateSecurity(nodes, c, bad);\n', to: '' },
  { tag: 'S2', name: 'grandfathering: every START is legacy', file: 'engine-dag.mjs',
    from: 'return Number.isFinite(t) && t < Date.parse(SECURITY_POLICY_CUTOFF);', to: 'return true;' },
  { tag: 'S3', name: 'C4: reassess classifications are not shape-checked', file: 'engine-dag.mjs',
    from: "if (kind === 'reassess' && doc.classifications !== undefined &&", to: 'if (false &&' },
  { tag: 'S4', name: 'C7: a pass anywhere outranks a skip or fail', file: 'gate.mjs',
    from: "const SPEC_RANK = ['fail', 'skip', 'unparsed', 'pass', 'missing'];", to: "const SPEC_RANK = ['pass', 'fail', 'skip', 'unparsed', 'missing'];" },
  { tag: 'S5', name: 'addendum RED: dispatched_before_red also binds the addendum slot', file: 'gate.mjs',
    from: "const early = slot.map === 'red' && state.events.find(", to: 'const early = state.events.find(' },
  { tag: 'S6', name: 'ship-ready: control pairs are never judged', file: 'gate.mjs',
    from: 'if (proofOk && current.control_pairs !== undefined) {', to: 'if (false) {' },
  { tag: 'S7', name: 'C8: control pairs judged before the proof runs (the first call loops)', file: 'gate.mjs',
    from: 'if (proofOk && current.control_pairs !== undefined) {', to: 'if (current.control_pairs !== undefined) {' },
  { tag: 'S8', name: 'addenda: a trusted addendum adds no pair', file: 'engine-authority.mjs',
    from: 'for (const p of added) { pairs.push(p);', to: 'for (const p of added) {' },
  { tag: 'S9', name: 'addenda: a spec outside its node\'s writes is accepted', file: 'engine-authority.mjs',
    from: '      if (why.contract) { problem = { outside: why.contract }; break; }\n', to: '' },
  { tag: 'S10', name: 'waivers: an untrusted waiver waives', file: 'engine-authority.mjs',
    from: 'const waived = [...new Set(sec.waivers.filter(match)', to: 'const waived = [...new Set([...sec.waivers, ...sec.forged.waivers].filter(match)' },
  { tag: 'S11', name: 'C11: a pair RED whose spec changed since still proves', file: 'engine-gates.mjs',
    from: ' && !redChanges(E, ev);', to: ';' },
  { tag: 'S12', name: 'C3: every run is treated as policy 2', file: 'engine-dag.mjs',
    from: 'export const securityOn = (S) => S?.config?.securityPolicy === 2;', to: 'export const securityOn = (S) => true;' },
  { tag: 'S13', name: 'C9: init never binds the narrative to the DAG pairs', file: 'run-engine.mjs',
    from: '    await bindSecurity(ctx, dag.config, start, text, narrative);\n', to: '' },
  { tag: 'S14', name: 'review: pair rows, NOT_APPLICABLE and NOT_TRIGGERED are not checked', file: 'engine-gates.mjs',
    from: "?? (input.kind === 'original' ? securityRowsRefusal(input.primary, sec) : null);", to: ';' },
  { tag: 'S15', name: 'freshness: a stale reassessment is accepted', file: 'engine-gates.mjs',
    from: 'function reassessRefusal(S, sec) {\n', to: 'function reassessRefusal(S, sec) {\n  return null;\n' },
  { tag: 'S16', name: 'REAPPROVAL does not stop the binding', file: 'run-engine.mjs',
    from: 'if (securityOn(S) && S.security?.reapproval) out.push(', to: 'if (false) out.push(' },
  { tag: 'S17', name: 'ship-ready: a review that covered another addendum set authorizes ship', file: 'engine-gates.mjs',
    from: ' ?? coverageRefusal(S, sec);', to: ';' },
  { tag: 'S18', name: 'confirmation: a repair touching a pair spec needs no second opinion', file: 'engine-gates.mjs',
    from: "return risky || pairSpec ? 'required' : 'optional';", to: "return risky ? 'required' : 'optional';" },
  { tag: 'S19', name: 'C7: an unlocated pass of another file proves the spec (no attribution)', file: 'gate.mjs',
    from: "  if (unattributed) return 'missing';\n", to: '' },
  { tag: 'S20', name: 'reassess: ADD_CONTROLS is recorded as a fresh reassessment (no addendum_required)', file: 'engine-gates.mjs',
    from: "if (res.outcome === 'ADD_CONTROLS')", to: 'if (false)' },
  { tag: 'S21', name: 'proof: a truncated or timed-out formatted output is parsed as if whole', file: 'engine-gates.mjs',
    from: 'truncated: result.truncated === true || result.timedOut === true', to: 'truncated: false' },
  { tag: 'S22', name: 'C4: reassess surfaces are not shape-checked', file: 'engine-dag.mjs',
    from: "if (kind === 'reassess' && doc.surfaces !== undefined &&", to: 'if (false &&' },
  { tag: 'S23', name: "reassess diff: a '+++ ' line inside a hunk is taken for a file header", file: 'engine-gates.mjs',
    from: "if (armed && l.startsWith('+++ ')) {", to: "if (l.startsWith('+++ ')) {" },
  { tag: 'S24', name: 'addenda: an addendum without a reason is honoured', file: 'engine-authority.mjs',
    from: '|| !nonEmpty(e.reason) ', to: '' },
  { tag: 'S25', name: 'reassess: any classification dismisses a surface-introducing signal off every approved surface (no SURFACE_SIGNALS guard)', file: 'security-plan.mjs',
    from: 'const dismissed = (s) => byId.has(s.id) && !(SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));',
    to: 'const dismissed = (s) => byId.has(s.id);' },
  { tag: 'S26', name: 'reassess: an inventory surface at a signal\'s path never closes it (a new boundary cannot be added)', file: 'security-plan.mjs',
    from: ": carries(at(inventorySurfaces), selectedHere, cls) ? 'inventory-surface' : null;", to: ': null;' },
  { tag: 'S27', name: 'reassess: only an empty-facts classification is held back, so a cited no-op fact dismisses a surface-introducing signal off every approved surface', file: 'security-plan.mjs',
    from: 'const dismissed = (s) => byId.has(s.id) && !(SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));',
    to: 'const dismissed = (s) => byId.has(s.id) && !(Object.keys(byId.get(s.id).facts).length === 0 && SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));' },
];

/** Copy the layout, apply `mutant` (null: the control), run the tagged tests; resolve exit code and failing test names. */
async function runMutant(t, mutant) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-sec-mutant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'skills', 'ship-ticket', 'scripts');
  mkdirSync(dir, { recursive: true });
  cpSync(HERE, dir, { recursive: true });
  cpSync(VAPT, join(root, 'skills', 'vapt'), { recursive: true });
  if (mutant) {
    const file = join(dir, mutant.file), text = readFileSync(file, 'utf8');
    assert.equal(text.split(mutant.from).length, 2, `mutant ${mutant.tag} "${mutant.name}": its target text occurs exactly once in ${mutant.file}`);
    writeFileSync(file, text.replace(mutant.from, mutant.to));
  }
  const pattern = mutant ? `\\[${mutant.tag}\\]` : '\\[S\\d+\\]';
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, ['--test', `--test-name-pattern=${pattern}`, ...TESTS], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
  const code = await new Promise(r => child.on('close', r));
  clearTimeout(timer);
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1]);
  const ran = [...out.matchAll(/^# pass (\d+)$/gm)].map(m => Number(m[1]))[0] ?? 0;
  return { code, timedOut, failed, ran, tail: out.slice(-1500) };
}

test('C2 mutation: the tagged security tests pass on the unpatched copy and each guard mutant fails a test carrying its tag', { skip: SKIP, timeout: 30 * 60 * 1000 }, async (t) => {
  const tags = SECURITY_MUTANTS.map(m => m.tag);
  assert.equal(new Set(SECURITY_MUTANTS.map(m => `${m.file}\u0000${m.from}\u0000${m.to}`)).size, SECURITY_MUTANTS.length, 'mutants are distinct');
  const src = TESTS.map(f => readFileSync(join(HERE, f), 'utf8')).join('\n');
  for (const tag of new Set(tags)) assert.ok(src.includes(`[${tag}]`), `a test is tagged [${tag}]`);
  const jobs = [null, ...SECURITY_MUTANTS];
  const results = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) results.push(...await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test, or the mutation results mean nothing:\n${control.tail}`);
  assert.ok(control.ran >= tags.length, 'the control ran the tagged tests');
  const caught = (r) => !r.timedOut && r.code !== 0 && r.failed.some(f => f.includes(`[${r.m.tag}]`));
  for (const r of mutants) t.diagnostic(JSON.stringify({ mutant: r.m.tag, name: r.m.name, caught: caught(r), exit: r.code, failing: r.failed }));
  const survivors = mutants.filter(r => !caught(r)).map(r => `${r.m.tag} ${r.m.name} (exit ${r.code}, failing ${r.failed.join(' | ') || 'none'})`);
  assert.deepEqual(survivors, [], 'every security mutant is caught by a test tagged with its guard');
});
