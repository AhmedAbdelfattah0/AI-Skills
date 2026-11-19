/**
 * AIS-HARNESS-4 Wave B (class rule C2): every security guard has a named mutant. Each mutant is a copy
 * of the repository layout the engine needs (skills/ship-ticket/scripts and skills/vapt, for the
 * catalog and its evaluator) in a temp dir with ONE guard patched out by an exact string replacement
 * that must match exactly once (the repo is never edited). For mutant S#, the tests tagged [S#] in
 * gate-security.test.mjs, run-engine-security.test.mjs, security-plan.test.mjs and security-obligations.test.mjs must FAIL with a failing test carrying that
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
const TESTS = ['gate-security.test.mjs', 'run-engine-security.test.mjs', 'security-plan.test.mjs', 'security-obligations.test.mjs'];
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
    from: '    await bindSecurity(ctx, dag.config, dag.nodes, start, text, narrative);\n', to: '' },
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
  { tag: 'S28', name: 'ship-ready: the post-proof control pairs reuse the pre-proof base, so a proof that moves config.base still proves a pair', file: 'engine-gates.mjs',
    from: '    E.baseCommit = undefined;\n', to: '' },
  { tag: 'S29', name: "reassess: the inventory surfaces are taken as given (no union with the approved surfaces, no redefinition refusal)", file: 'security-plan.mjs',
    from: "    const surfaces = withApprovedSurfaces(block.surfaces, validateSurfaces(inv.surfaces, vocab));\n", to: "    const surfaces = validateSurfaces(inv.surfaces, vocab);\n" },
  { tag: 'S30', name: "reassess: an approved surface whose path is a prefix of the signal path counts as an approved path", file: 'security-plan.mjs',
    from: "const dismissed = (s) => byId.has(s.id) && !(SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));", to: "const dismissed = (s) => byId.has(s.id) && !(SURFACE_SIGNALS.includes(s.kind) && ![...approvedPaths].some((p) => s.path.startsWith(p)));" },
  { tag: 'S31', name: "reassess: one classification dismisses every open signal", file: 'security-plan.mjs',
    from: "const dismissed = (s) => byId.has(s.id) && !(SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));", to: "const dismissed = (s) => byId.size > 0 && !(SURFACE_SIGNALS.includes(s.kind) && !approvedPaths.has(s.path));" },
  { tag: 'S32', name: "C7 attribution: any option (--import=, --require=, a reporter path) still lets a command count as running only the spec file", file: 'gate.mjs',
    from: "  if (!args.every((a) => typeof a !== 'string' || !a.startsWith('-') || soleOption(a))) return null;\n", to: "" },
  { tag: 'S33', name: "C7 path matching: a backslash in any result path is taken for a separator (POSIX aliasing)", file: 'gate.mjs',
    from: "const r = WIN_PATH.test(String(resultFile)) ? norm(resultFile) : String(resultFile);", to: "const r = norm(resultFile);" },
  { tag: 'S34', name: "DAG: a pair spec file with a backslash, '.', '..' or empty segment is accepted", file: 'engine-dag.mjs',
    from: "const odd = p.specs.find(s => !normalRel(s.file));", to: "const odd = undefined;" },
  { tag: 'S35', name: "TAP adapter: a '# Subtest:' name is not unescaped (a nested spec under a name with '#' or '\\' is never found)", file: 'gate.mjs',
    from: "stack[level] = sub[1].replace(/\\\\([#\\\\])/g, '$1');", to: "stack[level] = sub[1];" },
  { tag: 'S36', name: "select/reassess: a backslash in a surface or changed path is accepted (no refusal)", file: 'security-plan.mjs',
    from: "  if (String(p).includes('\\\\')) refuse('bad_input', `${what} ${JSON.stringify(p)} contains a backslash; use forward slashes`);\n", to: "" },
  { tag: 'S37', name: "C7 attribution: a file argument with a backslash still counts as the slash spec file (POSIX aliasing)", file: 'gate.mjs',
    from: "  if (pos[0].includes('\\\\')) return null;\n", to: "" },
  { tag: 'S38', name: "ship-ready: the security context is not re-derived after the proof, so a proof that rewrites the catalog ships on the stale reassessment", file: 'engine-gates.mjs',
    from: "    if (sec) {\n      sec = await securityContext(E, candidate); // post-proof security context\n", to: "    if (false) {\n      sec = await securityContext(E, candidate); // post-proof security context\n" },
  { tag: 'S39', name: "init: an approved §3a surface outside every node's writes binds", file: 'run-engine.mjs',
    from: "  if (outside.length) throw coded('security_pairs_mismatch',", to: "  if (false) throw coded('security_pairs_mismatch'," },
  { tag: 'S40', name: 'init: a reassess refusal of the approved block is taken for "no surface outside the contract"', file: 'run-engine.mjs',
    from: "  if (!res.ok) throw coded('security_pairs_mismatch',", to: "  if (false) throw coded('security_pairs_mismatch'," },
  // ---- F12a (block format 3: surface-level facts, dropped pairs, accountability, C5) ----
  { tag: 'S41', name: 'matrix: a dropped (not applicable) pair is counted as proven', file: 'security-plan.mjs',
    from: '    const effective = new Set([...block.pairs, ...addenda]);\n', to: '    const effective = new Set([...block.pairs, ...addenda, ...(block.na_pairs ?? []).map((n) => n.pair_id)]);\n' },
  { tag: 'S42', name: 'block format 3: the selection digest does not cover the surfaces (facts, citations, path, principals)', file: 'security-plan.mjs',
    from: 'surfaces: v3.surfaces, ', to: '' },
  { tag: 'S43', name: 'select: an unknown (or false) change fact is lowered by a surface', file: 'security-plan.mjs',
    from: "      if (facts[f] !== true) refuse('surface_fact_not_lowerable',", to: "      if (false) refuse('surface_fact_not_lowerable'," },
  { tag: 'S44', name: 'reassess: a signal at an approved surface path never reopens a dropped pair', file: 'security-plan.mjs',
    from: 'for (const c of SIGNAL_CLASS[s.kind] ?? []) keep.add(', to: 'for (const c of []) keep.add(' },
  { tag: 'S45', name: 'reassess: a classification that raises a lowered fact never reopens its dropped pairs', file: 'security-plan.mjs',
    from: '.filter(([f]) => facts[f] === true && !raised.has(f))', to: '.filter(([f]) => facts[f] === true)' },
  { tag: 'S46', name: 'review: repair + confirmation (and ship-ready) clear a disputed dropped pair', file: 'engine-gates.mjs',
    from: 'export function disputedRefusal(S, sec) {\n', to: 'export function disputedRefusal(S, sec) {\n  return null;\n' },
  { tag: 'S47', name: 'C5 too wide: a test/ or fixtures/ directory is taken for a test file (real routes there stop firing)', file: 'security-plan.mjs',
    from: '(__tests__|__mocks__|__fixtures__)\\/|', to: '(__tests__|__mocks__|__fixtures__|tests?|fixtures?)\\/|' },
  { tag: 'S48', name: 'C5 too wide: every <dir>/api/ is taken for a workspace project folder (pages/api, src/api stop firing)', file: 'security-plan.mjs',
    from: 'const WORKSPACE_API = /(^|\\/)(apps|packages|services|libs|modules|projects)\\/api\\//g;', to: 'const WORKSPACE_API = /(^|\\/)([^/]+)\\/api\\//g;' },
  { tag: 'S49', name: 'C5: a signalling non-test path with no surface is left to classification (no inventory refusal)', file: 'security-plan.mjs',
    from: "      if (gaps.length) refuse('surface_inventory_incomplete',", to: "      if (false) refuse('surface_inventory_incomplete'," },
  { tag: 'S50', name: 'review: dropped pairs need no row (and PASS / uncited NOT_APPLICABLE / NOT_TRIGGERED with a dispute pass)', file: 'engine-gates.mjs',
    from: '  return naRowsRefusal(p, sec);\n', to: '  return null;\n' },
  { tag: 'S51', name: 'select: a fact lowered on every surface is accepted (derived-OR re-inflation)', file: 'security-plan.mjs',
    from: '    if (surfaces.every((s) => lower.get(s.boundary_id)?.has(f))) refuse(', to: '    if (false) refuse(' },
  { tag: 'S52', name: 'reassess/matrix: a hand-edited format-3 block is not replayed under the catalog', file: 'security-plan.mjs',
    from: 'function replayFormat3(r, block) {\n', to: 'function replayFormat3(r, block) {\n  return;\n' },
  { tag: 'S53', name: 'init: a format-3 run records the legacy policy version (an engine without F12a would resume it)', file: 'run-engine.mjs',
    from: '  const version = obligations ? recordedVersion({ testKinds: active, obligations }) : active ? TEST_KINDS_POLICY_VERSION : engine.current;',
    to: '  const version = active ? TEST_KINDS_POLICY_VERSION : engine.current;' },
  // ---- F12a repair R1 (review of 5dbeffd) ----
  { tag: "S54", name: "gates: a block format that disagrees with the run policy version is not refused (formatMismatch)", file: "engine-gates.mjs",
    from: "  if (sec.formatMismatch) return gateNo(", to: "  if (false) return gateNo(" },
  { tag: "S55", name: "ship-ready: an obligation matrix that does not verify is not refused", file: "engine-gates.mjs",
    from: "  return { obligations, refusal: obligations && !obligations.ok ? gateNo(", to: "  return { obligations, refusal: false ? gateNo(" },
  { tag: "S56", name: "review: a later review replaces the dispute list (a RETRY launders a dispute)", file: "engine-gates.mjs",
    from: "  S.security.disputed_na = [...new Set([...(S.security.disputed_na ?? []), ...disputes])].sort();", to: "  S.security.disputed_na = [...disputes].sort();" },
  { tag: "S57", name: "review: a dropped pair an addendum made effective is still treated as dropped", file: "engine-gates.mjs",
    from: "  return block.na_pairs.filter(n => !effective.has(n.pair_id));", to: "  return block.na_pairs;" },
  { tag: "S58", name: "matrix: a block selected against another catalog is accepted", file: "security-plan.mjs",
    from: "    if (block.catalog_digest !== digest) refuse('catalog_invalid',", to: "    if (false) refuse('catalog_invalid'," },
  { tag: "S59", name: "C5 applies to format-2 (legacy) runs too", file: "security-plan.mjs",
    from: "    const c5 = block.policy === 3, c5_exempted = [];", to: "    const c5 = true, c5_exempted = [];" },
  { tag: "S60", name: "C5 exempts test-named migration files", file: "security-plan.mjs",
    from: "      const rule = kind === 'auth-or-middleware-change' && test ? 'test-file'", to: "      const rule = (kind === 'auth-or-middleware-change' || kind === 'migration-or-rls-change') && test ? 'test-file'" },
  { tag: "S61", name: "C5 exempts test-named files under a router root", file: "security-plan.mjs",
    from: "        : kind === 'new-route' && test && !ROUTER_ROOT.test(p) ? 'test-file'", to: "        : kind === 'new-route' && test ? 'test-file'" },
  { tag: "S62", name: "select: a selected control may end with zero effective pairs (a keeper that cannot pair it)", file: "security-plan.mjs",
    from: "    if (emptied.length) refuse('surface_fact_reinflates',", to: "    if (false) refuse('surface_fact_reinflates'," },
  { tag: "S63", name: "citations: a missing cited file or symbol is accepted", file: "security-plan.mjs",
    from: "    if (bad.length) refuse('citation_missing', ...bad);", to: "    if (false) refuse('citation_missing', ...bad);" },
  { tag: "S64", name: "review: a second-opinion finding against a drop records no dispute", file: "engine-gates.mjs",
    from: "  const second = (Array.isArray(input.second_opinion?.findings) ? input.second_opinion.findings : []).filter(f => ids.has(f?.subject_id)).map(f => f.subject_id);", to: "  const second = [];" },
  { tag: "S65", name: "C5: an exemption that applies leaves no record", file: "security-plan.mjs",
    from: "      if (rule) { exempted?.push({ path: f.path, kind, rule }); continue; }", to: "      if (rule) continue;" },
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
