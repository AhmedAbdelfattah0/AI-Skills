import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkContinuity, loadHistory } from './check-continuity.mjs';

const script = fileURLToPath(new URL('./check-continuity.mjs', import.meta.url));
const finding = (id = 'PA-001', severity = 'High') => ({ id, severity, status: 'CONFIRMED' });
function manifest(run_id, day, items = [finding()]) {
  return { schema: 'project-audit/manifest@2', run_id, created_at: `2026-01-${day}T00:00:00Z`,
    status: 'COMPLETE_DEGRADED', system: { digest: run_id, repositories: [
      { identity: 'example.test/team/app', commit: 'a'.repeat(40) },
    ] }, findings: items, coverage: [], degradations: [],
    release_assessment: { category: 'BLOCKING_FINDINGS' } };
}
function entry(source = 'old/PA-001', disposition = 'RETAINED', current_ids = ['PA-001']) {
  return { source, disposition, current_ids, reason: 'Pinned handler still accepts the same unauthenticated input.',
    evidence: ['new/app:src/handler:12'], classification_changes: {} };
}
function fixture() {
  const old = manifest('old', '01');
  const current = manifest('new', '03');
  current.reconciliation = { prior_runs: ['old'], prior_findings: [entry()] };
  return { old, current };
}
function pendingFixture(disposition = 'NOT_RECHECKED') {
  const f = fixture();
  const e = entry('old/PA-001', disposition, disposition === 'PARTIAL' ? ['PA-001'] : []);
  e.residual = { description: 'The second callback path was not inspected.', rows: ['B02.STATIC'], degradations: ['DG-01'] };
  f.current.reconciliation.prior_findings = [e];
  f.current.coverage = [{ row_id: 'B02.STATIC', criticality: 'critical', outcome: 'DEGRADED', degradations: ['DG-01'] }];
  f.current.degradations = [{ id: 'DG-01', kind: 'coverage', critical: true, resolved: false,
    rows: ['B02.STATIC'], closing_action: 'Inspect the second callback at the current pin.' }];
  if (disposition === 'NOT_RECHECKED') { f.current.findings = []; e.evidence = []; }
  return f;
}
const codes = result => result.issues.map(i => i.code);
const check = f => checkContinuity(f.current, [f.old]);

test('same source pins with different digests are retained, not declared a regression', () => {
  const f = fixture();
  assert.notEqual(f.current.system.digest, f.old.system.digest);
  assert.equal(check(f).ok, true);
});

test('matching IDs alone cannot stand in for an exhaustive ledger', () => {
  const f = fixture();
  delete f.current.reconciliation;
  const result = check(f);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing_sources, ['old/PA-001']);
  assert.ok(codes(result).includes('MISSING_PRIOR_FINDING_LEDGER'));
});

test('every observation from every run is required, including repeated IDs', () => {
  const f = fixture();
  const older = manifest('older', '02', [finding(), finding('PA-002')]);
  f.current.reconciliation.prior_runs.push('older');
  const result = checkContinuity(f.current, [f.old, older]);
  assert.equal(result.prior_observations, 3);
  assert.deepEqual(result.missing_sources, ['older/PA-001', 'older/PA-002']);
});

test('an empty explicit ledger is valid only when there are no earlier findings', () => {
  const f = fixture();
  f.current.reconciliation = { prior_runs: [], prior_findings: [] };
  assert.equal(checkContinuity(f.current, []).ok, true);
  assert.equal(check(f).ok, false);
});

test('duplicate sources, unknown targets and unsupported dispositions fail', () => {
  const f = fixture();
  f.current.reconciliation.prior_findings.push(entry());
  f.current.reconciliation.prior_findings[0].current_ids = ['PA-999'];
  f.current.reconciliation.prior_findings[1].disposition = 'GONE';
  const actual = codes(check(f));
  for (const code of ['DUPLICATE_SOURCE', 'UNKNOWN_CURRENT_FINDING', 'INVALID_DISPOSITION']) {
    assert.ok(actual.includes(code));
  }
});

test('severity and confirmation changes each require an explicit evidence-backed reason', () => {
  for (const change of [{ severity: 'Medium' }, { status: 'SUSPECTED' }]) {
    const f = fixture();
    Object.assign(f.current.findings[0], change);
    assert.ok(codes(check(f)).includes('UNEXPLAINED_CLASSIFICATION_CHANGE'));
    f.current.reconciliation.prior_findings[0].classification_changes['PA-001'] = {
      reason: 'High/CONFIRMED changed: the pinned route now needs operator access; reachability is unverified.',
      evidence: ['new/app:src/auth:5'],
    };
    assert.equal(check(f).ok, true);
  }
});

test('a split must account for all target classifications', () => {
  const f = fixture();
  f.current.findings = [finding('PA-002'), finding('PA-003', 'Medium')];
  f.current.reconciliation.prior_findings = [entry('old/PA-001', 'MAPPED', ['PA-002', 'PA-003'])];
  assert.ok(codes(check(f)).includes('UNEXPLAINED_CLASSIFICATION_CHANGE'));
});

test('partial mapping keeps residual scope even when a mapped finding is confirmed', () => {
  const f = pendingFixture('PARTIAL');
  f.current.coverage[0].outcome = 'FAIL';
  assert.equal(check(f).ok, true);
  delete f.current.reconciliation.prior_findings[0].residual;
  assert.ok(codes(check(f)).includes('MISSING_RESIDUAL_SCOPE'));
});

test('unrechecked history stays visible without importing a confirmed finding', () => {
  const f = pendingFixture();
  const snapshot = JSON.stringify(f);
  assert.equal(check(f).ok, true);
  assert.equal(f.current.findings.length, 0);
  assert.equal(JSON.stringify(f), snapshot);
});

test('residual rows and gaps must be unresolved and linked in both directions', () => {
  for (const mutate of [
    f => { f.current.coverage[0].outcome = 'PASS'; },
    f => { f.current.coverage[0].degradations = []; },
    f => { f.current.degradations[0].rows = ['B99.STATIC']; },
    f => { f.current.degradations[0].resolved = true; },
    f => { f.current.degradations[0].critical = false; },
    f => { f.current.degradations[0].closing_action = ''; },
  ]) {
    const f = pendingFixture();
    mutate(f);
    assert.equal(check(f).ok, false);
  }
});

test('unverified High history blocks a clear assessment even on a standard FAIL row', () => {
  const f = pendingFixture();
  f.current.coverage[0].criticality = 'standard';
  f.current.coverage[0].outcome = 'FAIL';
  f.current.release_assessment.category = 'NO_BLOCKERS_OBSERVED';
  assert.ok(codes(check(f)).includes('CRITICAL_RESIDUAL_FORBIDS_CLEAR_ASSESSMENT'));
  f.current.status = 'COMPLETE';
  assert.ok(codes(check(f)).includes('RESIDUAL_REQUIRES_DEGRADED_STATUS'));
});

test('a Low historical issue on a current critical row is also a critical gap', () => {
  const f = pendingFixture();
  f.old.findings[0].severity = 'Low';
  f.current.degradations[0].critical = false;
  assert.ok(codes(check(f)).includes('INVALID_RESIDUAL_DEGRADATION'));
});

test('resolution, rejection and scope exclusion need evidence, not just different pins', () => {
  for (const disposition of ['RESOLVED', 'REJECTED', 'OUT_OF_SCOPE']) {
    const f = fixture();
    f.current.system.repositories[0].commit = 'b'.repeat(40);
    f.current.reconciliation.prior_findings = [entry('old/PA-001', disposition, [])];
    assert.equal(check(f).ok, true);
    f.current.reconciliation.prior_findings[0].evidence = [];
    assert.ok(codes(check(f)).includes('MISSING_DECISION_EVIDENCE'));
  }
});

test('legacy keyed collections remain readable without rewriting old manifests', () => {
  const f = pendingFixture();
  f.old.findings = { 'PA-001': { severity: 'High', status: 'CONFIRMED' } };
  f.current.coverage = { 'B02.STATIC': f.current.coverage[0] };
  const { id, ...gap } = f.current.degradations[0];
  f.current.degradations = { [id]: gap };
  assert.equal(check(f).ok, true);
});

test('malformed collections, classifications and duplicate prior runs fail closed', () => {
  const f = fixture();
  assert.throws(() => checkContinuity(f.current, [f.old, f.old]), /duplicate prior/);
  f.old.findings[0].severity = 'Unknown';
  assert.throws(() => check(f), /classification/);
  f.old.findings = null;
  assert.throws(() => check(f), /collection/);
});

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-continuity-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); // Only this test-owned mkdtemp tree.
  async function put(m, parent = root) {
    const dir = path.join(parent, m.run_id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'manifest.json');
    await writeFile(file, JSON.stringify(m));
    return file;
  }
  return { root, put };
}

test('discovery includes all older overlapping terminal runs, not future, active or unrelated runs', async t => {
  const { put } = await sandbox(t);
  const f = fixture();
  const file = await put(f.current);
  await put(f.old);
  const earlier = manifest('partial', '02'); earlier.status = 'INCOMPLETE'; await put(earlier);
  const future = manifest('future', '04'); await put(future);
  const active = manifest('active', '02'); active.status = 'IN_PROGRESS'; await put(active);
  const other = manifest('other', '02'); other.system.repositories[0].identity = 'example.test/another'; await put(other);
  const { priors } = await loadHistory(file);
  assert.deepEqual(priors.map(m => m.run_id).sort(), ['old', 'partial']);
  assert.equal(checkContinuity(f.current, priors).ok, false);
});

test('explicit external prior runs are checked and duplicate paths are deduplicated', async t => {
  const { put } = await sandbox(t);
  const outside = await sandbox(t);
  const f = fixture();
  const file = await put(f.current);
  const prior = await outside.put(f.old);
  const { current, priors } = await loadHistory(file, [prior, prior]);
  assert.equal(priors.length, 1);
  assert.equal(checkContinuity(current, priors).ok, true);
  await assert.rejects(loadHistory(file, [file]), /not an earlier terminal run/);
});

test('CLI returns 0/1/2 for valid/omitted/unreadable history without changing inputs', async t => {
  const { put } = await sandbox(t);
  const f = fixture();
  const current = await put(f.current);
  const prior = await put(f.old);
  const before = await Promise.all([readFile(current, 'utf8'), readFile(prior, 'utf8')]);
  let run = spawnSync(process.execPath, [script, current], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).accounted_observations, 1);
  assert.deepEqual(await Promise.all([readFile(current, 'utf8'), readFile(prior, 'utf8')]), before);
  delete f.current.reconciliation;
  await put(f.current);
  run = spawnSync(process.execPath, [script, current], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout).missing_sources, ['old/PA-001']);
  await writeFile(prior, '{invalid json');
  run = spawnSync(process.execPath, [script, current], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unreadable manifest/);
});
