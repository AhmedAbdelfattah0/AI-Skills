import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, relative } from 'node:path';
import { buildNodes } from './engine-bench.mjs';
import { runScenarios, peakConcurrency } from './engine-bench-scenarios.mjs';
import { loadRecord, referenceBytes, sections } from './load-record.mjs';

const BENCH = fileURLToPath(new URL('./engine-bench.mjs', import.meta.url));

test('buildNodes makes two dependency waves and one join', () => {
  assert.deepEqual(buildNodes(6).map(x => x.deps.length), [0, 0, 0, 3, 3, 2]);
  assert.deepEqual(buildNodes(3).map(x => x.deps), [[], ['n1'], ['n2']]);
});

// Windows: no node reaches done (known quiescence limit N7, references/execution-harness.md), so
// there is no completion to measure; the run is skipped there rather than asserted differently.
const N7_SKIP = process.platform === 'win32' ? 'known Windows quiescence limit N7: bench nodes never reach done on Windows' : false;

test('the bench CLI runs both modes to completion and reports numeric counts', { skip: N7_SKIP }, () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./engine-bench.mjs', import.meta.url)), '--nodes', '3', '--json'],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  for (const mode of ['manual', 'engine']) {
    assert.equal(out[mode].nodes_completed, 3, mode);
    for (const k of ['orchestrator_commands', 'bytes_read', 'wall_ms']) assert.equal(typeof out[mode][k], 'number', `${mode}.${k}`);
  }
});

// ------------------------------------------------------------------ ten scenarios (engine-bench-scenarios.mjs)

const METRICS = ['orchestrator_commands', 'bytes_read', 'reference_bytes', 'wall_ms', 'nodes_completed', 'judgments', 'owner_interventions', 'proof_runs', 'retries'];
const scenario = async (id) => (await runScenarios(id, { buildNodes }))[0];
/** The result is complete and ok; every metric is a number. wall_ms is never asserted beyond its type. */
function assertResult(r, id) {
  assert.equal(r.id, id);
  assert.equal(r.ok, true, JSON.stringify(r.shows, null, 1));
  assert.equal(r.limits, 'fake provider: mechanism and orchestration overhead only');
  for (const k of METRICS) assert.equal(typeof r.metrics[k], 'number', `${id}.${k}`);
}

test('the scenario CLI prints one result per scenario and exits 0 when it is ok', { skip: N7_SKIP }, () => {
  const r = spawnSync(process.execPath, [BENCH, '--scenario', 'S1', '--json'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.map(x => x.id), ['S1']);
  const bad = spawnSync(process.execPath, [BENCH, '--scenario', 'S11'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown scenario S11/);
});

test('S1 one node completes with the smallest command count', { skip: N7_SKIP }, async () => {
  const r = await scenario('S1');
  assertResult(r, 'S1');
  assert.deepEqual([r.shows.outcome, r.shows.nodes, r.shows.writer_runs], ['done', { a: 'done' }, 1]);
  assert.equal(r.metrics.orchestrator_commands, 2);
  assert.equal(r.metrics.nodes_completed, 1);
});

test('S2 frontend and backend are dispatched in the same wave, between the contract and the join', { skip: N7_SKIP }, async () => {
  const r = await scenario('S2');
  assertResult(r, 'S2');
  assert.equal(r.shows.outcome, 'done', 'each worker waits for the other to start, so only a concurrent dispatch can finish');
  assert.equal(r.shows.frontend_and_backend_in_one_wave, true);
  assert.ok(r.shows.peak_concurrency >= 2);
  assert.equal(r.shows.waves_in_order, true);
  assert.deepEqual(r.shows.start_waves, [['contract'], ['backend', 'frontend'], ['join']]);
  assert.equal(r.metrics.nodes_completed, 4);
});

test('S3 an auth-sensitive change: ship-ready needs accepted RED and the risk evidence, and each is shown to matter', { skip: N7_SKIP }, async () => {
  const r = await scenario('S3');
  assertResult(r, 'S3');
  const both = ['authorization-spec', 'negative-spec'];
  const { drive_before_red: before, ship_ready_before_red_with_evidence: early, ship_ready_after_red_with_evidence: late, ship_ready_after_red_no_evidence: bare } = r.shows;
  assert.deepEqual(before.red_pending, ['spec']);
  assert.equal(before.impl_runs, 0, 'production work waits for accepted RED');
  assert.equal(early.exit, 2);
  assert.ok(early.reasons.includes('missing_risk_evidence'), 'evidence for an unaccepted RED does not count');
  assert.deepEqual(early.missing, both);
  assert.equal(r.shows.red_gate, 'red_accepted');
  assert.equal(r.shows.drive_after_red.outcome, 'done');
  assert.ok(!late.reasons.includes('missing_risk_evidence'), 'accepted RED plus the evidence clears the reason: ' + late.reasons.join());
  assert.deepEqual(late.missing, []);
  assert.ok(late.reasons.includes('review_not_accepted') && late.reasons.includes('missing_local_proof'), 'what still blocks is the absent review and proof');
  assert.ok(bare.reasons.includes('missing_risk_evidence'), 'accepted RED without evidence is not enough');
  assert.deepEqual(bare.missing, both);
  assert.equal(r.shows.executions.red_spec, 1);
  assert.equal(r.metrics.proof_runs, 1, 'the RED spec ran once; the refused ship-ready ran no proof command');
  assert.ok(r.metrics.reference_bytes > referenceBytes({}), 'a security shape loads security-risk.md as well');
  assert.equal(r.metrics.reference_bytes, referenceBytes({ security: true }));
});

test('S4 six nodes in two waves and a join all complete within the configured width', { skip: N7_SKIP }, async () => {
  const r = await scenario('S4');
  assertResult(r, 'S4');
  assert.equal(r.metrics.nodes_completed, 6);
  assert.equal(r.shows.width, 2);
  assert.ok(r.shows.peak_concurrency >= 2 && r.shows.peak_concurrency <= r.shows.width, `peak ${r.shows.peak_concurrency}`);
  assert.equal(r.shows.waves_in_order, true, 'every first-wave node starts before any second-wave node, and the join after both');
  assert.deepEqual(r.shows.start_waves, [['n1', 'n2', 'n3'], ['n4', 'n5'], ['n6']]);
});

test('S5 failure and recovery: one retry on a provider error, none on a timeout, no second writer after a crash, a judgment for a crash with writes', { skip: N7_SKIP }, async () => {
  const r = await scenario('S5');
  assertResult(r, 'S5');
  const s = r.shows;
  assert.deepEqual([s.provider_error.node.state, s.provider_error.node.retries, s.provider_error.node.attempts, s.provider_error.writer_runs], ['failed', 1, 2, 2]);
  assert.deepEqual([s.timeout.node.state, s.timeout.node.retries, s.timeout.node_attempts_recorded], ['failed', 0, 1]);
  assert.match(s.timeout.reason, /timeout/, 'the failure is the timeout, not something incidental');
  assert.match(s.provider_error.reason, /provider error/);
  assert.equal(s.engine_crash.killed_by, 'SIGKILL');
  assert.equal(s.engine_crash.state_after_resume_while_live, 'running');
  assert.deepEqual([s.engine_crash.state_after_worker_ended, s.engine_crash.final_outcome, s.engine_crash.writer_runs], ['done', 'done', 1]);
  assert.equal(s.worker_crash_with_writes.outcome, 'judgment');
  assert.ok(s.worker_crash_with_writes.judgments.includes('crash_with_writes'));
  assert.equal(s.worker_crash_with_writes.writer_runs_after_second_drive, 1, 'never retried automatically');
  assert.equal(r.metrics.retries, 1, 'only the provider error was retried');
  assert.equal(r.metrics.owner_interventions, 4, 'the two failed nodes and the crash with writes (two judgments) wait for the owner');
});

test('S6 one undeclared file is an ownership violation and the whole run stops, dependents and independents alike', { skip: N7_SKIP }, async () => {
  const r = await scenario('S6');
  assertResult(r, 'S6');
  assert.equal(r.shows.outcome, 'judgment');
  assert.equal(r.shows.violation_node, 'a');
  assert.match(r.shows.violation_reason, /src\/extra\.txt/);
  assert.equal(r.shows.dependent_runs, 0);
  assert.equal(r.shows.writer_runs_after_second_drive, 1);
  assert.deepEqual(r.shows.nodes, { a: 'failed', b: 'pending', c: 'pending' });
  assert.deepEqual(r.shows.control_without_the_extra_file, { outcome: 'done', judgments: [], nodes: { a: 'done', b: 'done', c: 'done' } },
    'without the undeclared file the same DAG completes, so the stop is caused by that write');
  assert.equal(r.shows.independent_runs, 0, 'a ready node that does not depend on the violator is not dispatched either');
  assert.equal(r.shows.nodes_after_second_drive.c, 'pending');
  assert.equal(r.metrics.nodes_completed, 3, 'only the control run completes nodes');
});

test('S7 a ui ticket label makes ship-ready refuse without parity evidence', { skip: N7_SKIP }, async () => {
  const r = await scenario('S7');
  assertResult(r, 'S7');
  assert.equal(r.shows.drive_outcome, 'done', 'the build itself is not blocked');
  assert.equal(r.shows.ship_ready.exit, 2);
  assert.ok(r.shows.ship_ready.reasons.includes('missing_risk_evidence'));
  assert.deepEqual(r.shows.ship_ready.missing, ['parity-measurements']);
  const cleared = r.shows.ship_ready_with_parity_evidence;
  assert.ok(!cleared.reasons.includes('missing_risk_evidence'), 'supplying the parity evidence clears the reason: ' + cleared.reasons.join());
  assert.deepEqual(cleared.missing, []);
  assert.ok(cleared.reasons.includes('review_not_accepted'), 'the absent review still blocks');
  assert.ok(r.metrics.reference_bytes > referenceBytes({}), 'a ui shape loads design-parity.md as well');
  assert.equal(r.metrics.reference_bytes, referenceBytes({ ui: true }));
});

test('S8 baseline: what the review gate records and refuses for evidence-integrity cases today', { skip: N7_SKIP }, async () => {
  const r = await scenario('S8');
  assertResult(r, 'S8');
  const s = r.shows;
  // (1) a second-opinion minor finding disposed `fix` under a primary PASS is refused and nothing is recorded.
  assert.equal(s.primary_pass_with_second_opinion_fix.refusal.code, 'outcome_inconsistent');
  assert.deepEqual(s.primary_pass_with_second_opinion_fix.refusal.reasons, ['PASS with findings to fix']);
  assert.deepEqual(s.primary_pass_with_second_opinion_fix.chain_after, []);
  // (2) a second-opinion FAIL with every finding `not applicable` is accepted as PASS; the record keeps the route and the findings, not the verdict.
  const so = s.primary_pass_with_second_opinion_fail_not_applicable;
  assert.equal(so.result.code, 'review_accepted');
  assert.equal(so.recorded_outcome, 'PASS');
  assert.equal(so.recorded_second_opinion_route, 'codex');
  assert.equal(so.recorded_has_second_opinion_outcome, false, 'the second-opinion verdict is not in the original record');
  assert.deepEqual(so.chain_after[0].findings, [{ id: 'S1', source: 'codex', severity: 'major', disposition: 'not applicable' }]);
  // (3) a second original review needs an owner RETRY; behind one, the same finding id is recorded again and nothing links the two.
  const ids = s.finding_ids_reused_across_executions;
  assert.deepEqual([ids.first.code, ids.second_without_retry.code, ids.second_with_owner_retry.code], ['review_accepted', 'retry_unauthorized', 'review_accepted']);
  assert.deepEqual(ids.finding_ids_in_chain, ['rx-1:F1', 'rx-2:F1']);
  // (4) a confirmation is refused while the tree differs from the frozen candidate, whichever candidate it names, and accepted once the tree is restored.
  const moving = s.candidate_moves_before_confirmation;
  assert.equal(moving.tree_moved_after_repair, true);
  assert.deepEqual([moving.confirm_on_pre_repair_candidate.code, moving.confirm_on_moved_tree.code], ['stale_candidate', 'stale_candidate']);
  assert.equal(moving.confirm_on_repaired_candidate_after_restoring_the_tree.code, 'review_accepted');
  assert.deepEqual(moving.chain_after.map(x => x.kind), ['original', 'repair', 'confirmation']);
  // (5) with config.auditRecord the same input leaves the verdicts, the reconciliation and the GATE fields in the persisted state.
  const audit = s.audit_record_enabled;
  assert.equal(audit.config_audit_record, true, 'the persisted config carries the switch');
  assert.equal(audit.refusal.code, 'outcome_inconsistent', 'the refusal is unchanged');
  assert.equal(audit.accepted.code, 'review_accepted');
  assert.equal(audit.recorded_outcome, 'PASS');
  assert.equal(audit.recorded_primary_outcome, 'PASS');
  assert.equal(audit.recorded_second_opinion_outcome, 'FAIL');
  assert.equal(audit.recorded_second_opinion_identity_present, true);
  assert.equal(typeof audit.recorded_reconciliation, 'string');
  assert.equal(audit.refused_gate_event.review_execution, 'rx-0');
  assert.deepEqual(audit.refused_gate_event.reasons, ['PASS with findings to fix']);
  assert.deepEqual(audit.accepted_gate_event, { review_execution: 'rx-1', primary_outcome: 'PASS', second_opinion_outcome: 'FAIL' });
  assert.ok(audit.events_total > 0 && audit.events_with_at === audit.events_total, 'every event is stamped');
  assert.equal(audit.reader_can_reconstruct, true);
  assert.equal(r.metrics.reference_bytes, referenceBytes({}));
});

test('S9 baseline: a moved base is not detected by the engine in this world (single RED node, no dependent, so no RED check ran), and the archive does not carry the RED attempt output', { skip: N7_SKIP }, async () => {
  const r = await scenario('S9');
  assertResult(r, 'S9');
  const base = r.shows.base_moves_mid_run;
  assert.equal(base.drive_before_move.nodes.b, 'pending');
  assert.equal(base.base_drift_report.exit, 1);
  assert.deepEqual(base.base_drift_report.stdout, ['base-drift: OVERLAP', '  src/b.txt (declared src/b.txt, node b writes)']);
  assert.equal(base.drive_after_move.outcome, 'done', 'today the engine finishes the run over a moved base and raises no judgment');
  assert.deepEqual(base.drive_after_move.judgments, []);
  const red = r.shows.red_provenance_in_a_later_run;
  assert.equal(red.after_base_move.red_invalidated, false);
  assert.equal(red.after_base_move.red_still_accepted, true);
  assert.equal(red.red_attempt_output_live, true);
  assert.equal(red.archive_contains_attempts, false);
  assert.deepEqual(red.archived_files, ['engine.jsonl', 'manifest.json', 'state.json']);
  assert.equal(red.second_run_init.refused, 'state_exists', 'a second run cannot start from the live state; it would have to rely on the archive');
});

test('S10 baseline: with config.base unset (HEAD) a branch-tip move over a node-owned file does not end the run, change the candidate id or raise a judgment', { skip: N7_SKIP }, async () => {
  const r = await scenario('S10');
  assertResult(r, 'S10');
  const s = r.shows;
  assert.equal(s.config_base_in_state, false);
  assert.equal(s.head_moved, true);
  assert.equal(s.drive_before_move.outcome, 'waiting');
  assert.equal(s.candidate_id_changed, false, 'the commit is absorbed into the base: the candidate id (changed-path content against HEAD) is unchanged right after the move');
  assert.equal(s.evidence.final_candidate_differs_from_pre_move, true);
  assert.equal(s.drive_after_move.outcome, 'done', 'the archived stop (a run ended by a base move) is NOT reproduced: the run finishes');
  assert.deepEqual(s.drive_after_move.judgments, []);
  assert.deepEqual(s.drive_after_move.writer_runs, { a: 1, b: 1 }, 'no node is re-run');
  assert.equal(s.evidence.node_a_state_after, 'done', 'node a evidence is kept');
  assert.equal(s.evidence.red_invalid_recorded, false);
  assert.equal(s.evidence.upstream_bytes_overwritten_by_node_b, true, 'node b overwrote the upstream change; nothing flagged it');
  assert.equal(s.ship_ready.code, 'review_not_accepted', 'ship-ready is refused only for the absent review and proof, not for the base move');
  assert.equal(r.metrics.reference_bytes, referenceBytes({}));
});

test('peakConcurrency counts overlapping node attempts and nothing else', () => {
  const at = (s, e, kind = 'node') => ({ kind, started_at: new Date(s).toISOString(), envelope: { ended_at: new Date(e).toISOString() } });
  assert.equal(peakConcurrency([at(0, 10), at(5, 15), at(12, 20)]), 2);
  assert.equal(peakConcurrency([at(0, 10), at(10, 20)]), 1, 'back to back is not concurrent');
  assert.equal(peakConcurrency([at(0, 10), at(1, 9, 'gate-red')]), 1, 'only node attempts count');
  assert.equal(peakConcurrency([]), 0);
});

// ------------------------------------------------------------------ load record (load-record.mjs)

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url));

test('load record: each file bytes equal its size on disk and the total is their sum', () => {
  const rec = loadRecord({ skillDir: SKILL_DIR });
  const onDisk = (rel) => readFileSync(join(SKILL_DIR, rel)).length;
  assert.equal(rec.spine.bytes, onDisk('SKILL.md'));
  assert.deepEqual(rec.references.map(r => r.file), readdirSync(join(SKILL_DIR, 'references')).sort().map(f => `references/${f}`));
  for (const ref of rec.references) assert.equal(ref.bytes, onDisk(ref.file), ref.file);
  assert.equal(rec.total_bytes, rec.spine.bytes + rec.references.reduce((n, r) => n + r.bytes, 0));
  assert.equal(rec.file_count, rec.references.length + 1);
  for (const phase of rec.phases) for (const load of phase.loads) assert.equal(load.bytes, onDisk(load.file), `${phase.phase} ${load.file}`);
});

test('load record: phases follow the SKILL.md table, with conditions as flags', () => {
  const rec = loadRecord({ skillDir: SKILL_DIR });
  const loads = (phase) => rec.phases.find(p => p.phase === phase).loads.map(l => l.file.replace('references/', ''));
  assert.deepEqual(loads('START'), ['observability.md']);
  assert.deepEqual(loads('UNDERSTAND'), ['understand.md', 'cross-model.md']);
  assert.ok(loads('BUILD').includes('execution-harness.md'), 'the spine says to read it before BUILD');
  assert.ok(loads('PROVE').includes('design-parity.md') && loads('PROVE').includes('security-risk.md'));
  assert.deepEqual(rec.phases.find(p => p.phase === 'PROVE').loads.filter(l => l.condition).map(l => [l.file, l.condition]).sort(),
    [['references/design-parity.md', 'PROVE with UI'], ['references/security-risk.md', 'PLAN, PROVE or REVIEW of security-relevant work'],
      ['references/units.md', 'BUILD, PROVE or REVIEW when any DAG node has `unit`']]);
  const base = referenceBytes({}, rec);
  assert.equal(referenceBytes({ ui: true }, rec) - base, rec.references.find(r => r.file === 'references/design-parity.md').bytes);
  assert.equal(referenceBytes({ security: true }, rec) - base, rec.references.find(r => r.file === 'references/security-risk.md').bytes);
  assert.equal(referenceBytes({ codex: true }, rec) - base, rec.references.find(r => r.file === 'references/codex-cli.md').bytes);
});

test('load record: a run without units loads no unit file, a run with units loads units.md, and no unit text is left in the other files', () => {
  const rec = loadRecord({ skillDir: SKILL_DIR });
  const without = rec.runs.without_units;
  assert.equal(without.flags.units, false);
  assert.equal(rec.runs.with_units.flags.units, true);
  assert.equal(rec.runs.with_units.flags.split, true);
  assert.equal(rec.runs.plan_chooses_split.flags.units, false);
  assert.equal(rec.runs.plan_chooses_split.flags.split, true);
  assert.ok(!without.files.includes('references/units.md'), 'the unit rules stay out of a run that never splits');
  assert.ok(rec.runs.with_units.files.includes('references/units.md'));
  assert.ok(rec.runs.plan_chooses_split.files.includes('references/units.md'));
  assert.ok(without.files.includes('references/brief.md'), 'brief.md loads at BUILD');
  assert.ok(!without.files.includes('references/harness-internals.md'), 'harness-internals.md is on demand: never in the default run');
  assert.equal(without.unit_text_bytes, 0, 'no opt-in unit section is left in a file a run without units loads');
  assert.deepEqual(rec.unit_text, []);
  assert.equal(rec.runs.with_units.unit_text_bytes, rec.references.find(r => r.file === 'references/units.md').bytes);
});

// A synthetic skill with known file sizes, so the flag arithmetic is exact and independent of the real text.
const SYNTH_ROWS = [
  ['Workflow start', 'observability'], ['UNDERSTAND', 'understand', 'cross-model'], ['PLAN', 'plan', 'cross-model'],
  ['PLAN when the plan chooses SPLIT', 'units'], ['BUILD', 'brief'], ['BUILD, PROVE or REVIEW when any DAG node has `unit`', 'units'],
  ['On demand, when the operator card names it', 'harness-internals'], ['PROVE', 'prove'], ['PROVE with UI', 'design-parity'], ['REVIEW', 'review'],
  ['PLAN, PROVE or REVIEW of security-relevant work', 'security-risk'], ['REVIEW with elevated counterpart', 'cross-model'], ['SHIP', 'ship'],
];
const SYNTH_SIZES = { observability: 100, understand: 200, 'cross-model': 300, plan: 400, brief: 50, units: 70, 'harness-internals': 30, prove: 500, 'design-parity': 5,
  review: 700, 'security-risk': 7, ship: 600, 'execution-harness': 1000, 'codex-cli': 11 };
function synthSkill(dir, { reviewExtra = '' } = {}) {
  const link = (n) => `[references/${n}.md](references/${n}.md)`;
  const rows = SYNTH_ROWS.map(([enter, ...names]) => `| ${enter} | ${names.map(link).join(' and ')} |`);
  const table = ['| Entering | Load |', '|---|---|', ...rows.map(r => (r.startsWith('| BUILD |') ? r.replace('| BUILD | ', '| BUILD | this spine and ') : r)), ''].join('\n');
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# Skill\n\n${table}\n`);
  for (const [name, size] of Object.entries(SYNTH_SIZES)) {
    const body = name === 'review' ? `${'r'.repeat(size - reviewExtra.length)}${reviewExtra}` : 'x'.repeat(size);
    writeFileSync(join(dir, 'references', `${name}.md`), body);
  }
}
const withSynth = (opts, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'load-record-test-'));
  try { synthSkill(dir, opts); fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('load record: the units flag adds units.md at BUILD, PROVE and REVIEW, the split flag adds it at PLAN, internals only when named', () => {
  withSynth({}, (dir) => {
    const rec = loadRecord({ skillDir: dir });
    const S = SYNTH_SIZES;
    // The default run: the card (execution-harness.md, from the prose load) plus brief.md at BUILD; no units.md, no internals.
    assert.deepEqual(rec.runs.without_units.phase_bytes, { START: S.observability, UNDERSTAND: S.understand + S['cross-model'], PLAN: S.plan + S['cross-model'],
      BUILD: S['execution-harness'] + S.brief, PROVE: S.prove, REVIEW: S.review, SHIP: S.ship });
    assert.ok(!rec.runs.without_units.files.includes('references/units.md'));
    assert.equal(rec.runs.without_units.unit_text_bytes, 0);
    // The plan chooses SPLIT: units.md at PLAN only, because no DAG exists yet and no node has a unit.
    assert.equal(rec.runs.plan_chooses_split.phase_bytes.PLAN, S.plan + S['cross-model'] + S.units);
    assert.equal(rec.runs.plan_chooses_split.phase_bytes.BUILD, S['execution-harness'] + S.brief);
    // A DAG with a unit node: units.md at BUILD, PROVE and REVIEW (and at PLAN, because it was chosen there).
    const w = rec.runs.with_units.phase_bytes;
    assert.deepEqual([w.PLAN, w.BUILD, w.PROVE, w.REVIEW, w.SHIP], [S.plan + S['cross-model'] + S.units, S['execution-harness'] + S.brief + S.units, S.prove + S.units, S.review + S.units, S.ship]);
    assert.equal(rec.runs.with_units.unit_text_bytes, S.units);
    assert.equal(referenceBytes({ units: true }, rec) - referenceBytes({}, rec), S.units, 'counted once, however many phases load it');
    // On demand: counted only when named.
    assert.equal(referenceBytes({ internals: true }, rec) - referenceBytes({}, rec), S['harness-internals']);
    assert.equal(referenceBytes({}, rec), referenceBytes({ internals: false }, rec));
    assert.ok(rec.runs.all_conditions.files.includes('references/harness-internals.md') && rec.runs.all_conditions.files.includes('references/units.md'));
  });
});

test('load record: a unit section left in a loaded file is counted as unit text, and units.md counts whole only when loaded', () => {
  const extra = '## Unit review (opt-in)\nleftover rules\n';
  withSynth({ reviewExtra: `\n${extra.trimEnd()}` }, (dir) => {
    const rec = loadRecord({ skillDir: dir });
    assert.deepEqual(rec.unit_text.map(u => [u.file, u.bytes]), [['references/review.md', Buffer.byteLength(extra)]]);
    assert.equal(rec.runs.without_units.unit_text_bytes, Buffer.byteLength(extra), 'review.md is loaded by every run');
    assert.equal(rec.runs.with_units.unit_text_bytes, Buffer.byteLength(extra) + SYNTH_SIZES.units);
  });
});

test('load record: unit text is counted by whole sections (heading level and bold lead rules)', () => {
  const doc = ['# Title', '', '## Keep', 'k', '', '## Units here', 'u1', '### Inner', 'u2', '', '## After', 'a', '',
    '**Other.** x', '', '**Units (opt-in).** b', '- item', '', 'still b', '', '**Next.** n', ''].join('\n');
  const found = sections(doc, [/^## Units here/, /^\*\*Units \(opt-in\)/]);
  assert.deepEqual(found.map(s => s.heading), ['## Units here', 'Units (opt-in).']);
  assert.equal(found[0].bytes, Buffer.byteLength(['## Units here', 'u1', '### Inner', 'u2', '', ''].join('\n')), 'a heading section includes its subsections');
  assert.equal(found[1].bytes, Buffer.byteLength(['**Units (opt-in).** b', '- item', '', 'still b', '', ''].join('\n')));
});

test('load record: a table row it does not recognise makes it fail, and the CLI names the row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-record-test-'));
  try {
    cpSync(SKILL_DIR, dir, { recursive: true, filter: (src) => !relative(SKILL_DIR, src).split(sep).includes('scripts') });
    const skill = join(dir, 'SKILL.md');
    const row = '| PROVE with a new thing | [references/prove.md](references/prove.md) |';
    writeFileSync(skill, readFileSync(skill, 'utf8').replace(/(\| SHIP \|[^\n]*\n)/, `$1${row}\n`));
    assert.throws(() => loadRecord({ skillDir: dir }), (e) => e.message.includes(row));
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./load-record.mjs', import.meta.url)), '--skill-dir', dir, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(row), r.stderr);
    assert.equal(r.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load record: a row pointing at a missing reference fails instead of being measured as zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-record-test-'));
  try {
    cpSync(SKILL_DIR, dir, { recursive: true, filter: (src) => !relative(SKILL_DIR, src).split(sep).includes('scripts') });
    rmSync(join(dir, 'references', 'ship.md'));
    assert.throws(() => loadRecord({ skillDir: dir }), /missing file references\/ship\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load record CLI prints one JSON object for the real skill and exits 0', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./load-record.mjs', import.meta.url)), '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.total_bytes, loadRecord({ skillDir: SKILL_DIR }).total_bytes);
});
