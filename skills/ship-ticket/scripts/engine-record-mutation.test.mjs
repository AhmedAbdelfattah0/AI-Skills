/**
 * AIS-BENCH-1 Wave 3a W3-record: every recording guard has a named mutant (mechanism copied from
 * engine-security-mutation.test.mjs). Each mutant is a copy of the repository layout the engine needs
 * (skills/ship-ticket/scripts and skills/vapt) in a temp dir with ONE guard patched by an exact string
 * replacement that must match exactly once (the repo is never edited). For mutant M with tag [R#], the
 * tests tagged [R#] in run-engine-record.test.mjs and gate.test.mjs must FAIL with a failing test
 * carrying that tag; the unpatched copy (the control) must PASS every tagged test, or the result would
 * say nothing. Several mutants share a tag (one tag per concern of the plan, §4).
 *
 * Runs with ENGINE_MUTATION=1 (the engine-properties CI job) or ENGINE_RECORD_MUTATION=1.
 * A kill needs the expected failure signature: a test carrying the tag fails as a test-code failure
 * (failureType 'testCodeFailure') whose error is not a timeout, a cancellation, a signal or a resource
 * error, nor an `INFRA:` error (run-engine-record.test.mjs: a CLI that ended without an exit status,
 * killed or timed out, throws it before any status assertion). A run that fails only with such errors is INCONCLUSIVE (a harness or load failure), never a
 * kill, and fails this test separately. The engine suites give false failures under load, so
 * CONCURRENCY is kept low and each kill is reported with its first error line.
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
  : process.env.ENGINE_MUTATION !== '1' && process.env.ENGINE_RECORD_MUTATION !== '1'
    ? 'slow: runs with ENGINE_MUTATION=1 (engine-properties CI job) or ENGINE_RECORD_MUTATION=1' : false;
const TESTS = ['run-engine-record.test.mjs', 'gate.test.mjs'];
const CONCURRENCY = 3;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** One guard each: its id, its tag, the file, and the exact text replaced. */
export const RECORD_MUTANTS = [
  // ---- review records (builder A: A1-A3)
  { id: 'R1a', tag: 'R1', name: 'switch: auditOn is always true', file: 'engine-dag.mjs',
    from: 'export const auditOn = (S) => S?.config?.auditRecord === true;', to: 'export const auditOn = (S) => true;' },
  { id: 'R1b', tag: 'R1', name: 'original record: the verdict spread is unconditional', file: 'gate.mjs',
    from: '...(policy.recordVerdicts === true ? { primary_outcome: p.outcome,', to: '...(true ? { primary_outcome: p.outcome,' },
  { id: 'R1d', tag: 'R1', name: 'digests: the digest algorithm input changes consistently (every placeholder still matches)', file: 'engine-dag.mjs',
    from: "export const sha = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');", to: "export const sha = (data) => 'sha256:' + createHash('sha256').update(data).update('v2').digest('hex');" },
  { id: 'R1e', tag: 'R1', name: 'telemetry-failure records gain a key with the switch on', file: 'run-engine.mjs',
    from: "S.telemetry_degraded.push({ sink, event_id: ev.event_id, error: e.code ?? e.message, at: new Date().toISOString() });",
    to: "S.telemetry_degraded.push({ sink, event_id: ev.event_id, error: e.code ?? e.message, at: new Date().toISOString(), ...(auditOn(S) ? { audit: true } : {}) });" },
  { id: 'R1c', tag: 'R1', name: 'DAG: a non-boolean config.auditRecord is accepted', file: 'engine-dag.mjs',
    from: "  if (c.auditRecord !== undefined && typeof c.auditRecord !== 'boolean') bad('config.auditRecord must be a boolean');\n", to: '' },
  { id: 'R2a', tag: 'R2', name: 'reconciliation.summary is not bounded', file: 'gate.mjs',
    from: "(typeof v === 'string' ? v.slice(0, SUMMARY_MAX) : null)", to: "(typeof v === 'string' ? v : null)" },
  { id: 'R2b', tag: 'R2', name: 'final review gate drops the recording policy', file: 'engine-gates.mjs',
    from: 'const recording = auditOn(S) ? { recordVerdicts: true } : {};', to: 'const recording = {};' },
  { id: 'R2c', tag: 'R2', name: 'unit review gate drops recordVerdicts', file: 'engine-unit-review.mjs',
    from: '  if (auditOn(S)) policy.recordVerdicts = true;', to: '' },
  { id: 'R3a', tag: 'R3', name: 'confirmation: primary_outcome is the reconciled outcome', file: 'gate.mjs',
    from: 'if (recording.recordVerdicts === true) record.primary_outcome = p.outcome;', to: 'if (recording.recordVerdicts === true) record.primary_outcome = record.outcome;' },
  { id: 'R3b', tag: 'R3', name: 'confirmation: gateReview does not forward the recording policy to confirm()', file: 'gate.mjs',
    from: ", { recordVerdicts: policy.recordVerdicts === true });", to: ', {});' },
  { id: 'R3c', tag: 'R3', name: 'confirmation: the final review gate drops the recording policy beside the confirmation policy', file: 'engine-gates.mjs',
    from: 'confirmationPolicy(S, input.review_execution), ...recording }', to: 'confirmationPolicy(S, input.review_execution) }' },
  { id: 'R6a', tag: 'R6', name: 'a primary PASS with findings to fix is accepted', file: 'gate.mjs',
    from: "if (p.outcome === 'PASS' && (failed.length || overflow || fixes.length)) {", to: "if (p.outcome === 'PASS' && (failed.length || overflow)) {" },
  // ---- GATE lines and timestamps (builder B: A4-A5)
  { id: 'R4a', tag: 'R4', name: 'GATE line: reasons are not recorded', file: 'run-engine.mjs',
    from: '  if (reasons.length) out.reasons = reasons;\n', to: '' },
  { id: 'R4b', tag: 'R4', name: 'GATE line: the unit is not recorded', file: 'run-engine.mjs',
    from: "  if (kind === 'unit-review' && boundedText(input.unit)) out.unit = input.unit;\n", to: '' },
  { id: 'R4c', tag: 'R4', name: 'GATE line: reasons are not capped (count or length)', file: 'run-engine.mjs',
    from: '.slice(0, AUDIT_REASONS_MAX).map(cutText);', to: ';' },
  { id: 'R4d', tag: 'R4', name: 'GATE line: oversize identifiers and outcomes are kept', file: 'run-engine.mjs',
    from: "const boundedText = (v) => typeof v === 'string' && v.length <= AUDIT_TEXT_MAX;", to: "const boundedText = (v) => typeof v === 'string';" },
  { id: 'R4e', tag: 'R4', name: 'GATE line: the audit fields are added with the switch off', file: 'run-engine.mjs',
    from: 'const audit = auditOn(S) ? () => gateAuditFields(ctx.gate, input, v) : () => ({});', to: 'const audit = () => gateAuditFields(ctx.gate, input, v);' },
  { id: 'R4f', tag: 'R4', name: 'timestamps: live attempts are stamped', file: 'run-engine.mjs',
    from: '!LIVE.includes(a.status) && a.quiesced === true && a.ended_at === undefined', to: 'a.ended_at === undefined' },
  { id: 'R4g', tag: 'R4', name: 'timestamps: terminal attempts get no ended_at', file: 'run-engine.mjs',
    from: ') a.ended_at = keep(memo.end, a.attempt_id);', to: ') void 0;' },
  { id: 'R5a', tag: 'R5', name: 'timestamps: an event loaded with its stamp is restamped by the next command', file: 'run-engine.mjs',
    from: "if (e && typeof e === 'object' && e.at === undefined) e.at =", to: "if (e && typeof e === 'object') e.at =" },
  { id: 'R5b', tag: 'R5', name: 'timestamps: the per-command memo is ignored (gateRed\'s snapshots restamp)', file: 'run-engine.mjs',
    from: 'const keep = (m, k) => { if (!m.has(k)) m.set(k, at); return m.get(k); };', to: 'const keep = () => at;' },
  { id: 'R5c', tag: 'R5', name: 'timestamps: commit() stamps with the switch off', file: 'run-engine.mjs',
    from: '      if (auditOn(E.S)) stampAudit(E.S, auditNow(ctx), E.stamps);', to: '      stampAudit(E.S, auditNow(ctx), E.stamps);' },
  { id: 'R5d', tag: 'R5', name: 'ctx.now is not a context key (mark, clear-unit, rebind and archive refuse it)', file: 'run-engine.mjs',
    from: "'catalogFile', 'now']);", to: "'catalogFile']);" },
  { id: 'R5e', tag: 'R5', name: 'timestamps: the test clock is ignored (always the wall clock)', file: 'run-engine.mjs',
    from: '  if (ctx.now === undefined) return new Date().toISOString();', to: '  return new Date().toISOString();' },
  // ---- no authority moves (readers adopting the audit fields)
  { id: 'R7a', tag: 'R7', name: 'carrier: REPAIR authorized from primary_outcome', file: 'carrier.mjs',
    from: "&& e.outcome === 'FAIL' && Array.isArray(e.write_set) && e.write_set.length > 0);", to: "&& (e.primary_outcome ?? e.outcome) === 'FAIL' && Array.isArray(e.write_set) && e.write_set.length > 0);" },
  { id: 'R7b', tag: 'R7', name: 'engine repair dispatch authorized from primary_outcome', file: 'engine-attempts.mjs',
    from: '.find(e => e.review_execution === rx && e.outcome === \'FAIL\'', to: '.find(e => e.review_execution === rx && (e.primary_outcome ?? e.outcome) === \'FAIL\'' },
  { id: 'R7c', tag: 'R7', name: 'ship-ready accepts on primary_outcome', file: 'gate.mjs',
    from: "&& last.outcome === 'PASS';", to: "&& (last.primary_outcome ?? last.outcome) === 'PASS';" },
  { id: 'R7d', tag: 'R7', name: 'unit reviewStates pass on primary_outcome', file: 'engine-unit-review.mjs',
    from: "if (last.outcome === 'PASS') { out[u] =", to: "if ((last.primary_outcome ?? last.outcome) === 'PASS') { out[u] =" },
  // ---- untrusted text never reaches RUN-STATE
  { id: 'R8b', tag: 'R8', name: 'switch-on GATE rows are written with raw U+0085/U+2028/U+2029 (splitLines breaks them)', file: 'run-engine.mjs',
    from: "auditOn(E.S) && ev.event === 'GATE' ? eventLine : undefined", to: 'undefined' },
  { id: 'R8a', tag: 'R8', name: 'GATE lines (with their untrusted text) are delivered to RUN-STATE', file: 'run-engine.mjs',
    from: "if (ev.event !== 'GATE') try { io.appendRunStateOnce(E.P.plan, ev); }", to: 'try { io.appendRunStateOnce(E.P.plan, ev); }' },
];

/** Errors that say nothing about the mutant: timeouts, cancellations, signals, resource exhaustion. */
export const INFRA = /INFRA:|failureType: '(?!testCodeFailure')|test timed out|timed ?out after|ETIMEDOUT|EAGAIN|EMFILE|ENFILE|ENOSPC|ENOMEM|SIGKILL|SIGTERM|cancelledByParent|\bkilled\b/i;

/** Each failing test of a TAP stream: its name, its YAML block, whether it is an infra failure, and its first error line. */
export function failuresOf(out) {
  return [...out.matchAll(/^( *)not ok \d+ - (.+)\n([\s\S]*?)^\1  \.\.\.$/gm)].map(([, , name, block]) => ({
    name, infra: INFRA.test(block), error: (/error: (?:\|-?\n\s*)?(.+)/.exec(block)?.[1] ?? '').trim().slice(0, 160) }));
}

/** Copy the layout, apply `mutant` (null: the control), run the tagged tests; resolve exit code, failing test names and first messages. */
async function runMutant(t, mutant) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-rec-mutant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'skills', 'ship-ticket', 'scripts');
  mkdirSync(dir, { recursive: true });
  cpSync(HERE, dir, { recursive: true });
  cpSync(VAPT, join(root, 'skills', 'vapt'), { recursive: true });
  if (mutant) {
    const file = join(dir, mutant.file), text = readFileSync(file, 'utf8');
    assert.equal(text.split(mutant.from).length, 2, `mutant ${mutant.id} "${mutant.name}": its target text occurs exactly once in ${mutant.file}`);
    writeFileSync(file, text.replace(mutant.from, () => mutant.to));
  }
  const pattern = mutant ? `\\[${mutant.tag}\\]` : '\\[R\\d+\\]';
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, ['--test', `--test-name-pattern=${pattern}`, ...TESTS], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
  const code = await new Promise(r => child.on('close', r));
  clearTimeout(timer);
  const failures = failuresOf(out);
  const ran = [...out.matchAll(/^# pass (\d+)$/gm)].map(m => Number(m[1]))[0] ?? 0;
  return { code, timedOut, failures, failed: failures.map(f => f.name), ran, tail: out.slice(-1500) };
}

test('W3-record mutation: the tagged record tests pass on the unpatched copy and each recording mutant fails a test carrying its tag', { skip: SKIP, timeout: 90 * 60 * 1000 }, async (t) => {
  const tags = [...new Set(RECORD_MUTANTS.map(m => m.tag))];
  assert.equal(new Set(RECORD_MUTANTS.map(m => m.id)).size, RECORD_MUTANTS.length, 'mutant ids are distinct');
  assert.equal(new Set(RECORD_MUTANTS.map(m => `${m.file}\u0000${m.from}\u0000${m.to}`)).size, RECORD_MUTANTS.length, 'mutants are distinct');
  const src = TESTS.map(f => readFileSync(join(HERE, f), 'utf8')).join('\n');
  for (const tag of tags) assert.ok(src.includes(`[${tag}]`), `a test is tagged [${tag}]`);
  const only = process.env.ENGINE_RECORD_MUTANTS ? new Set(process.env.ENGINE_RECORD_MUTANTS.split(',')) : null;
  const jobs = [null, ...RECORD_MUTANTS.filter(m => !only || only.has(m.id))];
  const results = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) results.push(...await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test, or the mutation results mean nothing:\n${control.tail}`);
  assert.ok(control.ran >= tags.length, `the control ran the tagged tests (${control.ran} passed for ${tags.length} tags)`);
  const tagged = (r) => r.failures.filter(f => f.name.includes(`[${r.m.tag}]`));
  const caught = (r) => !r.timedOut && r.code !== 0 && tagged(r).some(f => !f.infra);
  const inconclusive = (r) => !caught(r) && (r.timedOut || tagged(r).some(f => f.infra));
  for (const r of mutants) {
    t.diagnostic(JSON.stringify({ mutant: r.m.id, name: r.m.name, caught: caught(r), inconclusive: inconclusive(r), exit: r.code,
      failing: tagged(r).map(f => ({ name: f.name, infra: f.infra, error: f.error })) }));
  }
  const odd = mutants.filter(inconclusive).map(r => `${r.m.id} ${r.m.name} (exit ${r.code}${r.timedOut ? ', run timed out' : ''}): ${tagged(r).map(f => f.error).join(' | ')}`);
  assert.deepEqual(odd, [], 'INCONCLUSIVE (harness or load failure, not a kill): rerun on a quiet machine');
  const survivors = mutants.filter(r => !caught(r) && !inconclusive(r)).map(r => `${r.m.id} ${r.m.name} (exit ${r.code}, failing ${r.failed.join(' | ') || 'none'})`);
  assert.deepEqual(survivors, [], 'every recording mutant is caught by a test tagged with its guard');
});

test('W3-record mutation: the kill signature rejects timeouts, cancellations and signals', () => {
  const tap = (fields) => `not ok 1 - [R4] x\n  ---\n${fields}\n  ...\n`;
  const assertion = tap("  failureType: 'testCodeFailure'\n  error: 'expected 1'\n  code: 'ERR_ASSERTION'");
  assert.deepEqual(failuresOf(assertion).map(f => [f.name, f.infra, f.error]), [['[R4] x', false, "'expected 1'"]]);
  assert.equal(failuresOf(tap("  failureType: 'testCodeFailure'\n  error: |-\n    mark_refused: no\n  code: 'mark_refused'"))[0].infra, false, 'a thrown engine error is a kill');
  for (const f of ["  failureType: 'testTimeoutFailure'\n  error: 'test timed out after 120000ms'", "  failureType: 'cancelledByParent'\n  error: 'test did not finish'",
    "  failureType: 'testCodeFailure'\n  error: 'spawnSync git ETIMEDOUT'", "  failureType: 'testCodeFailure'\n  error: 'child killed by SIGKILL'"]) {
    assert.equal(failuresOf(tap(f))[0].infra, true, f);
  }
  // A signalled or timed-out CLI: the record tests' helper throws INFRA: before any `null !== 0` status assertion.
  assert.equal(failuresOf(tap("  failureType: 'testCodeFailure'\n  error: |-\n    INFRA: engine CLI 'drive' ended without an exit status (signal, spawn timeout or spawn error): \n  code: 'ERR_TEST_FAILURE'"))[0].infra, true);
  const nested = `# Subtest: [R4] a\n    not ok 1 - inner\n      ---\n      failureType: 'testCodeFailure'\n      ...\n    1..1\nnot ok 1 - [R4] a\n  ---\n  failureType: 'subtestsFailed'\n  ...\n`;
  assert.deepEqual(failuresOf(nested).map(f => f.name), ['inner', '[R4] a']);
});

test('W3-record mutation: a run whose tagged CLI is killed is INCONCLUSIVE, not a kill (planted: spawn timeout 1 ms)', { skip: POSIX ? false : 'POSIX' }, async () => {
  const PLANT = `import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from ${JSON.stringify(join(HERE, 'engine-test-fixture.mjs'))};
test('[R4] planted: the CLI is killed', (t) => {
  const fx = fixture(t, {});
  const r = fx.cli('status', {}, { timeout: 1 });
  if (r.status === null) throw new Error("INFRA: engine CLI 'status' ended without an exit status (signal, spawn timeout or spawn error)");
  assert.equal(r.status, 0);
});
`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-rec-plant-')));
  try {
    writeFileSync(join(root, 'plant.test.mjs'), PLANT);
    const { NODE_TEST_CONTEXT: _n, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', 'plant.test.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise(r => child.on('close', r));
    const [f] = failuresOf(out);
    assert.notEqual(code, 0);
    assert.equal(f?.name, '[R4] planted: the CLI is killed', out.slice(-800));
    assert.equal(f.infra, true, 'classified as infrastructure: the harness reports INCONCLUSIVE, never a kill');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
