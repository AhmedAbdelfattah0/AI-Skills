/**
 * P0 slice E2-min: stage dispositions and the one next_action (engine-next.mjs), consumed by a fake
 * orchestrator that ONLY calls `run-engine.mjs next` and performs the returned action. Deterministic: a fake
 * provider (engine-test-fixture.mjs), fake reviewers that write relay result files in the background, a fake
 * `gh` and a local bare remote; no model call. The derivation table is pinned on synthetic facts, and every
 * rule is load-bearing: omitting any one changes a pinned derivation (the mutation test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, primaryReview, secondOpinion, runStateEvents } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';
import { derive, RULES, STAGES, STOP, ACTIONS, DISPOSITIONS, LOOSE_JUDGMENT_RULE, LOCK_HELD_RULE } from './engine-next.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const RUN_LOG = fileURLToPath(new URL('./run-log.mjs', import.meta.url));
const CRASH_DRIVER = fileURLToPath(new URL('./engine-crash-driver.test-helper.mjs', import.meta.url));
const J = JSON.stringify;

// ------------------------------------------------------------------ synthetic derivations

const OK = { ok: true, code: 'admitted', reasons: [] };
const baseS = (over = {}) => ({ run_id: 'run-1', ticket: 'T-1', nodes: { a: { state: 'done' } }, review_chain: [], repairs: [], attempts: [],
  judgments: [], authority: { trusted: [], untrusted: [] }, ...over });
const baseF = (over = {}) => ({ now: 10000, lock: 'mine', unbound: [], blockers: [], attempts: [], redPending: [], work: false, unitReviewsPending: [],
  admission: { build: OK, review: OK, ship: OK }, candidate: { id: 'C1' }, tree: { dirty: false, paths: [] }, head: 'H1', dispatches: [],
  lastGate: {}, confirmationPolicy: null, ...over });
const att = (over = {}) => ({ attempt_id: 'att-1', kind: 'node', node: 'a', status: 'launched', provider: 'claude', model: 'sonnet',
  started_at: '2026-11-15T00:00:00.000Z', envelope_file: '/x/att-1.envelope.json', envelope: false, deadline: 'd', deadline_ms: 20000, pgid: 42, ...over });
const disp = (role, over = {}) => ({ role, event_id: `e-${role}`, review_execution: 'review-1', candidate_id: 'C1', started_at: 't', ended: false,
  ended_ms: null, marker: `/m/${role}.json`, marker_exists: false, deadline: 'd', deadline_ms: 20000, ...over });
const PASS_O = { review_execution: 'review-1', kind: 'original', outcome: 'PASS', candidate_id: 'C1' };
const FAIL_O = { review_execution: 'review-1', kind: 'original', outcome: 'FAIL', candidate_id: 'C0', fix_findings: ['F1'] };
const REPAIR_REC = { review_execution: 'review-1', kind: 'repair', old_candidate: 'C0', new_candidate: 'C1', write_set: ['src/a.txt'] };
const repair = (state) => ({ id: 'repair-review-1', kind: 'review', review_execution: 'review-1', state, writes: ['src/a.txt'] });
const CONF = (outcome) => ({ review_execution: 'review-1', kind: 'confirmation', outcome, candidate_id: 'C1' });
const repairing = (state, over = {}) => baseS({ review_chain: [FAIL_O], repairs: [repair(state)], ...over });
const confirming = (over = {}) => baseS({ review_chain: [FAIL_O, REPAIR_REC], repairs: [repair('done')], ...over });
const shipping = (over = {}) => baseS({ review_chain: [PASS_O], ...over });
const shipped = { ship_ready: { candidate_id: 'C1' }, local_proof: { candidate_id: 'C1', commands: [{ cmd: 'node', result: 'pass' }] } };
const PUBLISHED = shipping({ ...shipped, published: [{ head: 'H1' }] });
const ciDeny = (code) => ({ allow: false, code, reasons: ['r'] });
const ciEv = (state, code, over = {}) => ({ state, code, reasons: ['r'], timing: null, ...over });
const RETRY = J({ event: 'RETRY', run_id: 'run-1', review_execution: 'review-2', predecessor: 'review-1', authorized_by: 'owner' });

/** [name, S, facts, expected next_action { stage, disposition, reason, action }] — together they exercise every rule. */
const SCENARIOS = [
  ['binding drifted', baseS(), baseF({ unbound: [{ code: 'approval_mismatch', reason: 'r' }] }), ['APPROVAL', 'NEEDS_APPROVAL', 'approval_mismatch', 'reapprove']],
  ['malformed RUN-STATE', baseS(), baseF({ unbound: [{ code: 'run_state_malformed', reason: 'r' }] }), ['APPROVAL', 'BLOCKED', 'run_state_malformed', 'resolve']],
  ['un-enrolled', baseS(), baseF({ admission: { build: { ok: false, code: 'not_enrolled', reasons: [] } } }), ['ENROLL', 'BLOCKED', 'not_enrolled', 'enroll']],
  ['build context missing', baseS(), baseF({ admission: { build: { ok: false, code: 'context_missing', reasons: [] }, review: OK, ship: OK } }), ['ENROLL', 'READY', 'context_missing', 'context']],
  ['skill drifted', baseS(), baseF({ admission: { build: { ok: false, code: 'skill_drift', reasons: [] } } }), ['ENROLL', 'NEEDS_APPROVAL', 'skill_drift', 'new_run']],
  ['drive running elsewhere', baseS(), baseF({ lock: 'held', attempts: [att()] }), ['BUILD', 'RUNNING', 'engine_running', 'wait']],
  ['worker finished, not recorded', baseS(), baseF({ lock: 'free', attempts: [att({ envelope: true })] }), ['BUILD', 'READY', 'attempt_uncollected', 'resume']],
  ['worker overdue', baseS(), baseF({ now: 30000, attempts: [att()] }), ['BUILD', 'BLOCKED', 'attempt_overdue', 'recover_attempt']],
  ['worker in flight', baseS(), baseF({ attempts: [att()] }), ['BUILD', 'WAITING', 'attempt_in_flight', 'wait']],
  ['node judgment', baseS(), baseF({ blockers: [{ code: 'ownership_violation', node: 'a', reason: 'r' }] }), ['BUILD', 'BLOCKED', 'ownership_violation', 'resolve']],
  ['RED owed', baseS(), baseF({ redPending: ['a'] }), ['BUILD', 'READY', 'red_pending', 'gate_red']],
  ['unit review owed', baseS(), baseF({ unitReviewsPending: ['u1'] }), ['BUILD', 'READY', 'unit_review_owed', 'unit_review']],
  ['nodes pending', baseS({ nodes: { a: { state: 'pending' } } }), baseF({ work: true }), ['BUILD', 'READY', 'build_pending', 'drive']],
  ['loose judgment stops a READY', baseS({ nodes: { a: { state: 'pending' } } }), baseF({ work: true, blockers: [{ code: 'budget_stop', reason: 'r' }] }), ['BUILD', 'NEEDS_APPROVAL', 'budget_stop', 'resolve']],
  ['another command holds the lock', baseS({ nodes: { a: { state: 'pending' } } }), baseF({ work: true, lock: 'held' }), ['BUILD', 'RUNNING', 'engine_running', 'wait']],
  ['node in an underived state', baseS({ nodes: { a: { state: 'running' } } }), baseF(), ['BUILD', 'BLOCKED', 'underived', 'resolve']],
  ['review owed', baseS(), baseF(), ['REVIEW', 'READY', 'review_owed', 'dispatch_review']],
  ['review context missing', baseS(), baseF({ admission: { build: OK, review: { ok: false, code: 'context_missing', reasons: [] }, ship: OK } }), ['REVIEW', 'READY', 'context_missing', 'context']],
  ['candidate unavailable', baseS(), baseF({ candidate: { id: null, reason: 'git failed' } }), ['REVIEW', 'BLOCKED', 'candidate_unavailable', 'resolve']],
  ['second opinion owed', baseS(), baseF({ dispatches: [disp('primary')] }), ['REVIEW', 'READY', 'review_owed', 'dispatch_review']],
  ['review result on disk, no notification', baseS(), baseF({ dispatches: [disp('primary', { marker_exists: true }), disp('second_opinion')] }), ['REVIEW', 'READY', 'result_uncollected', 'collect_review']],
  ['review overdue', baseS(), baseF({ now: 30000, dispatches: [disp('primary'), disp('second_opinion')] }), ['REVIEW', 'BLOCKED', 'review_overdue', 'recover_review']],
  ['reviewers in flight', baseS(), baseF({ dispatches: [disp('primary'), disp('second_opinion')] }), ['REVIEW', 'WAITING', 'review_in_flight', 'wait']],
  ['results collected', baseS(), baseF({ dispatches: [disp('primary', { ended: true, ended_ms: 100 }), disp('second_opinion', { ended: true, ended_ms: 100 })] }), ['REVIEW', 'READY', 'results_collected', 'gate_review']],
  ['gate review refused after collection', baseS(), baseF({ dispatches: [disp('primary', { ended: true, ended_ms: 100 }), disp('second_opinion', { ended: true, ended_ms: 100 })],
    lastGate: { review: { ok: false, code: 'incomplete_contract', candidate_id: 'C1', at_ms: 200 } } }), ['REVIEW', 'BLOCKED', 'incomplete_contract', 'gate_review']],
  ['a dispatch of another candidate is ignored', baseS(), baseF({ dispatches: [disp('primary', { candidate_id: 'C0', marker_exists: true })] }), ['REVIEW', 'READY', 'review_owed', 'dispatch_review']],
  ['terminal FAIL needs an owner RETRY', baseS({ review_chain: [{ ...FAIL_O, overflow: true }] }), baseF(), ['REVIEW', 'NEEDS_APPROVAL', 'review_terminal', 'owner_retry']],
  ['a trusted RETRY makes the new review owed', baseS({ review_chain: [{ ...FAIL_O, overflow: true }], authority: { trusted: [RETRY], untrusted: [] } }), baseF(), ['REVIEW', 'READY', 'review_owed', 'dispatch_review']],
  ['repair owed', repairing('pending'), baseF(), ['REPAIR', 'READY', 'repair_owed', 'drive']],
  ['repair failed', repairing('failed'), baseF(), ['REPAIR', 'NEEDS_APPROVAL', 'repair_failed', 'owner_retry']],
  ['repair judgment', repairing('running'), baseF({ blockers: [{ code: 'repair_outside_findings', node: 'repair-review-1', reason: 'r' }] }), ['REPAIR', 'BLOCKED', 'repair_outside_findings', 'resolve']],
  ['repair running elsewhere', repairing('running'), baseF({ lock: 'held', attempts: [att({ kind: 'repair', node: 'repair-review-1' })] }), ['REPAIR', 'RUNNING', 'engine_running', 'wait']],
  ['repair finished, not recorded', repairing('running'), baseF({ attempts: [att({ kind: 'repair', node: 'repair-review-1', envelope: true })] }), ['REPAIR', 'READY', 'attempt_uncollected', 'resume']],
  ['repair overdue', repairing('running'), baseF({ now: 30000, attempts: [att({ kind: 'repair', node: 'repair-review-1' })] }), ['REPAIR', 'BLOCKED', 'attempt_overdue', 'recover_attempt']],
  ['repair in flight', repairing('running'), baseF({ attempts: [att({ kind: 'repair', node: 'repair-review-1' })] }), ['REPAIR', 'WAITING', 'attempt_in_flight', 'wait']],
  ['repair superseded without a recorded review', repairing('cancelled'), baseF(), ['SHIP_READY', 'BLOCKED', 'review_not_accepted', 'resolve']],
  ['confirmation owed', confirming(), baseF(), ['CONFIRMATION', 'READY', 'confirmation_owed', 'dispatch_review']],
  ['confirmation owes the second opinion (risky repair)', confirming(), baseF({ confirmationPolicy: 'required', dispatches: [disp('confirmation')] }), ['CONFIRMATION', 'READY', 'confirmation_owed', 'dispatch_review']],
  ['confirmation context missing', confirming(), baseF({ admission: { build: OK, review: { ok: false, code: 'context_stale', reasons: [] }, ship: OK } }), ['CONFIRMATION', 'READY', 'context_stale', 'context']],
  ['drift after the repair', confirming(), baseF({ candidate: { id: 'C9' } }), ['CONFIRMATION', 'BLOCKED', 'post_freeze_drift', 'resolve']],
  ['confirmation result on disk', confirming(), baseF({ dispatches: [disp('confirmation', { marker_exists: true })] }), ['CONFIRMATION', 'READY', 'result_uncollected', 'collect_review']],
  ['confirmation overdue', confirming(), baseF({ now: 30000, dispatches: [disp('confirmation')] }), ['CONFIRMATION', 'BLOCKED', 'review_overdue', 'recover_review']],
  ['confirmation in flight', confirming(), baseF({ dispatches: [disp('confirmation')] }), ['CONFIRMATION', 'WAITING', 'review_in_flight', 'wait']],
  ['confirmation collected', confirming(), baseF({ dispatches: [disp('confirmation', { ended: true, ended_ms: 100 })] }), ['CONFIRMATION', 'READY', 'results_collected', 'gate_review']],
  ['confirmation gate refused', confirming(), baseF({ dispatches: [disp('confirmation', { ended: true, ended_ms: 100 })], lastGate: { review: { ok: false, code: 'stale_candidate', candidate_id: 'C1', at_ms: 300 } } }),
    ['CONFIRMATION', 'BLOCKED', 'stale_candidate', 'gate_review']],
  ['confirmation FAILED', confirming({ review_chain: [FAIL_O, REPAIR_REC, CONF('FAIL')] }), baseF(), ['CONFIRMATION', 'FAILED', 'confirmation_failed', 'none']],
  ['confirmed, ship-ready owed', confirming({ review_chain: [FAIL_O, REPAIR_REC, CONF('PASS')] }), baseF(), ['SHIP_READY', 'READY', 'ship_ready_owed', 'gate_ship_ready']],
  ['ship-ready owed', shipping(), baseF(), ['SHIP_READY', 'READY', 'ship_ready_owed', 'gate_ship_ready']],
  ['E3 stale review: only an owner RETRY continues', shipping(shipped), baseF({ freshness: { fresh: false, code: 'review_stale', reasons: ['r'] } }), ['REVIEW', 'NEEDS_APPROVAL', 'review_stale', 'owner_retry']],
  ['E3 freshness not computable', shipping(shipped), baseF({ freshness: { fresh: false, code: 'candidate_unavailable', reasons: ['r'] } }), ['REVIEW', 'BLOCKED', 'candidate_unavailable', 'resolve']],
  ['E3 stale review with a trusted RETRY: the new review is owed', shipping({ ...shipped, authority: { trusted: [RETRY], untrusted: [] } }),
    baseF({ freshness: { fresh: false, code: 'review_stale', reasons: ['r'] } }), ['REVIEW', 'READY', 'review_owed', 'dispatch_review']],
  ['E3 stale confirmation (base moved)', confirming({ review_chain: [FAIL_O, REPAIR_REC, CONF('PASS')] }), baseF({ freshness: { fresh: false, code: 'review_base_moved', reasons: ['r'] } }),
    ['CONFIRMATION', 'NEEDS_APPROVAL', 'review_base_moved', 'owner_retry']],
  ['E3 fresh review ships', shipping(shipped), baseF({ freshness: { fresh: true, code: 'review_fresh', reasons: [] }, publishAuth: { allow: true } }), ['PUBLISH', 'READY', 'publish_owed', 'publish']],
  ['ship context missing', shipping(), baseF({ admission: { build: OK, review: OK, ship: { ok: false, code: 'context_missing', reasons: [] } } }), ['SHIP_READY', 'READY', 'context_missing', 'context']],
  ['ship-ready refused', shipping(), baseF({ lastGate: { review: { ok: true, at_ms: 100 }, 'ship-ready': { ok: false, code: 'missing_risk_evidence', candidate_id: 'C1', at_ms: 200 } } }),
    ['SHIP_READY', 'BLOCKED', 'missing_risk_evidence', 'gate_ship_ready']],
  ['proof runner running elsewhere', shipping(), baseF({ lock: 'held', attempts: [att({ kind: 'proof', node: 'ok' })] }), ['SHIP_READY', 'RUNNING', 'engine_running', 'wait']],
  ['proof runner left by a crashed gate', shipping(), baseF({ lock: 'free', attempts: [att({ kind: 'proof', node: 'ok', status: 'intent' })] }), ['SHIP_READY', 'READY', 'attempt_uncollected', 'resume']],
  ['proof runner overdue', shipping(), baseF({ now: 30000, attempts: [att({ kind: 'proof', node: 'ok', status: 'running' })] }), ['SHIP_READY', 'BLOCKED', 'attempt_overdue', 'recover_attempt']],
  ['proof runner in flight', shipping(), baseF({ attempts: [att({ kind: 'proof', node: 'ok', status: 'running' })] }), ['SHIP_READY', 'WAITING', 'attempt_in_flight', 'wait']],
  ['commit owed', shipping(shipped), baseF({ tree: { dirty: true, paths: ['src/a.txt'] } }), ['PUBLISH', 'READY', 'commit_owed', 'commit']],
  ['publish owed', shipping(shipped), baseF({ publishAuth: { allow: true, binding: {} } }), ['PUBLISH', 'READY', 'publish_owed', 'publish']],
  ['publish denied', shipping(shipped), baseF({ publishAuth: { allow: false, code: 'branch_mismatch', reasons: [] } }), ['PUBLISH', 'BLOCKED', 'branch_mismatch', 'resolve']],
  ['publish started, nothing recorded', shipping({ ...shipped, publish_intent: { head: 'H1' } }), baseF({ publishAuth: { allow: true } }), ['PUBLISH', 'BLOCKED', 'publish_unfinished', 'publish']],
  ['published, CI evidence owed', PUBLISHED, baseF({ completeAuth: ciDeny('ci_evidence_missing') }), ['CI', 'READY', 'ci_owed', 'collect_ci']],
  ['CI checks running: collect again', PUBLISHED, baseF({ completeAuth: ciDeny('ci_pending'), ci: ciEv('PENDING', 'ci_pending') }), ['CI', 'WAITING', 'ci_pending', 'collect_ci']],
  ['CI provider failed (never zero checks)', PUBLISHED, baseF({ completeAuth: ciDeny('ci_provider_unavailable'), ci: ciEv('UNAVAILABLE', 'ci_provider_unavailable') }),
    ['CI', 'BLOCKED', 'ci_provider_unavailable', 'collect_ci']],
  ['CI red on the published head', PUBLISHED, baseF({ completeAuth: ciDeny('ci_failed'), ci: ciEv('FAIL', 'ci_failed') }), ['CI', 'FAILED', 'ci_failed', 'none']],
  ['no check run after the window', PUBLISHED, baseF({ completeAuth: ciDeny('ci_no_checks'), ci: ciEv('NO_CHECKS', 'ci_no_checks', { diagnostic: { pr: null } }) }),
    ['CI', 'BLOCKED', 'ci_no_checks', 'resolve']],
  ['the PR head moved past the published head', PUBLISHED, baseF({ completeAuth: ciDeny('ci_head_moved'), ci: ciEv('STALE', 'ci_head_moved') }), ['CI', 'BLOCKED', 'ci_head_moved', 'resolve']],
  ['recorded PASS that authorize complete refuses', PUBLISHED, baseF({ completeAuth: ciDeny('ci_evidence_inconsistent'), ci: ciEv('PASS', 'ci_passed') }),
    ['CI', 'BLOCKED', 'ci_evidence_inconsistent', 'resolve']],
  ['complete: authorize complete allows', PUBLISHED, baseF({ completeAuth: { allow: true }, ci: ciEv('PASS', 'ci_passed') }), [null, 'COMPLETED', 'completed', 'none']],
];

const brief = (d) => [d.next_action.stage, d.next_action.disposition, d.next_action.reason, d.next_action.action];

test('derive: every scenario yields its pinned next_action; one disposition per stage; later stages are prerequisite_open', () => {
  for (const [name, S, f, want] of SCENARIOS) {
    const d = derive(S, f);
    assert.deepEqual(brief(d), want, name);
    assert.deepEqual(Object.keys(d.stages), [...STAGES], name);
    for (const s of Object.values(d.stages)) assert.ok(DISPOSITIONS.includes(s.disposition), `${name}: ${s.disposition}`);
    assert.ok(Object.hasOwn(ACTIONS, d.next_action.action), `${name}: ${d.next_action.action} is in the closed vocabulary`);
    assert.equal(d.next_action.owner, d.stages[d.next_action.stage]?.owner ?? 'orchestrator', name);
    const at = STAGES.indexOf(d.next_action.stage);
    if (at >= 0) for (const st of STAGES.slice(at + 1)) assert.equal(d.stages[st].code, 'prerequisite_open', `${name}: ${st}`);
  }
});

test('mutation: deleting any derivation rule changes a pinned derivation (every rule is load-bearing)', () => {
  const ids = [...RULES.map(r => r.id), LOOSE_JUDGMENT_RULE, LOCK_HELD_RULE];
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  const survivors = ids.filter(id => SCENARIOS.every(([, S, f]) => J(derive(S, f, { omit: [id] })) === J(derive(S, f))));
  assert.deepEqual(survivors, [], 'rules no scenario depends on');
});

test('never invents approval: no derivation hands a human-owned stop to the orchestrator as READY', () => {
  for (const [name, S, f] of SCENARIOS) {
    const d = derive(S, f);
    if (d.next_action.owner === 'human') assert.ok(STOP.includes(d.next_action.disposition), name);
    if (d.next_action.disposition === 'NEEDS_APPROVAL') assert.equal(d.next_action.owner, 'human', name);
  }
});

// ------------------------------------------------------------------ the fake orchestrator (supported path)

const ROLE_ACTIVITY = { primary: 'primary_review', second_opinion: 'optional_review', confirmation: 'review_confirmation' };

/**
 * A fake orchestrator that ONLY calls `next` and performs the returned action. It keeps no memory between
 * steps: every name it needs (event ids, marker paths) is derived from the action itself, so a fresh instance
 * after a kill continues the same run. `script.review(kind, role, candidate)` is what the fake reviewer returns.
 */
function orchestrator(fx, script) {
  const markers = join(fx.root, 'markers');
  mkdirSync(markers, { recursive: true });
  const runLog = (args) => {
    const r = spawnSync(process.execPath, [RUN_LOG, ...args, '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1'], { encoding: 'utf8', env: fx.env });
    assert.equal(r.status, 0, `run-log ${args.join(' ')}: ${r.stderr}`);
  };
  const id = (rx, kind, role) => `${rx}-${kind}-${role}`;
  const markerOf = (rx, kind, role) => join(markers, `${id(rx, kind, role)}.json`);
  const log = [];
  const act = {
    drive: () => fx.cli('drive'),
    resume: () => fx.cli('resume'),
    context: (a) => fx.cli('context', { phase: a.phase }),
    wait: async () => { await new Promise(r => setTimeout(r, 100)); },
    /** Record the dispatch (the marker next reads), then launch a background reviewer and do NOT wait for it. */
    dispatch_review: (a) => {
      const rx = a.review_execution ?? 'review-1';
      for (const role of a.roles) {
        const marker = markerOf(rx, a.kind, role);
        runLog(['start', '--kind', 'activity', '--name', ROLE_ACTIVITY[role], '--event-id', id(rx, a.kind, role),
          '--metric', `candidate_id=${a.candidate_id}`, '--metric', `review_execution=${rx}`, '--carrier-result', marker]);
        const result = { schema: 'delegate-relay.result.v1', tool: 'claude', readOnly: true, status: 'completed', workdir: fx.repo,
          review: script.review(a.kind, role, a.candidate_id) };
        const writer = `const fs=require('fs');setTimeout(()=>{const r=JSON.parse(process.argv[2]);r.startedAt=r.finishedAt=new Date().toISOString();`
          + `fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify(r));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);},150);`;
        spawn(process.execPath, ['-e', writer, marker, J(result)], { detached: true, stdio: 'ignore' }).unref();
      }
    },
    collect_review: (a) => runLog(['end', '--kind', 'activity', '--name', ROLE_ACTIVITY[a.item.role], '--event-id', a.item.event_id,
      '--outcome', 'complete', '--carrier-result', a.item.marker]),
    gate_review: (a) => {
      const rx = a.review_execution, read = (role) => JSON.parse(readFileSync(markerOf(rx, a.kind, role), 'utf8')).review;
      if (a.kind === 'confirmation') return fx.gate('review', { review_execution: rx, kind: 'confirmation', primary: read('confirmation') });
      const primary = read('primary');
      const fix = primary.findings.map(f => ({ finding_id: f.id, source: 'primary', disposition: 'fix' }));
      return fx.gate('review', { review_execution: rx, kind: 'original', primary, second_opinion: read('second_opinion'),
        reconciliation: { dispositions: fix }, ...(fix.length ? { repair_prompt_file: fx.prompt('fix') } : {}) });
    },
    gate_ship_ready: () => fx.gate('ship-ready', {}),
    commit: (a) => { fx.okGit(['add', '--', ...a.paths]); fx.okGit(['commit', '-q', '-m', 'T-1: ship']); },
    publish: () => fx.cli('publish'),
    collect_ci: () => fx.cli('ci'),
  };
  return {
    log,
    /** Run until a STOP disposition; returns the last `next` output. */
    async run({ max = 150, onStep } = {}) {
      for (let i = 0; i < max; i++) {
        const n = fx.cli('next');
        assert.ok(n.out?.next_action, `next printed no next_action: ${n.stdout}${n.stderr}`);
        const a = n.out.next_action;
        if (log.at(-1)?.action !== a.action || a.action !== 'wait') log.push({ stage: a.stage, action: a.action, reason: a.reason, disposition: a.disposition });
        if (STOP.includes(a.disposition)) return n.out;
        assert.ok(Object.hasOwn(act, a.action), `unknown or human-owned action ${a.action} (${a.reason}) at ${a.stage}`);
        await act[a.action](a);
        await onStep?.(n.out);
      }
      throw new Error(`no STOP after ${max} steps: ${J(log.slice(-6))}`);
    },
  };
}

const failThenPass = {
  review: (kind, role, candidate) => (kind === 'confirmation' ? { reviewer_identity: 'opus:review', candidate_id: candidate, checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed' }
    : role === 'primary' ? primaryReview(candidate, { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }],
      acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: 'src/a.txt' }] })
      : secondOpinion(candidate)),
};

/** A check run of the fake gh ('$SHA': the requested commit). */
const checkRun = (status, conclusion = null, over = {}) => ({ id: 1, name: 'test', head_sha: '$SHA', status, conclusion,
  started_at: '2026-11-15T00:00:01.000Z', completed_at: status === 'completed' ? '2026-11-15T00:00:09.000Z' : null, app: 'github-actions', url: 'https://example.invalid/run/1', ...over });
/** The fake gh's CI: the checks of the published head are running at the first collection and green at the next. */
const CI_RUNNING_THEN_GREEN = { checkRuns: [{ runs: [checkRun('in_progress')] }, { runs: [checkRun('completed', 'success')] }] };

function nextFixture(t, opts = {}) {
  const fx = enrollFixture(t, { behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } }, ...opts });
  fx.scriptCi(CI_RUNNING_THEN_GREEN);
  return fx;
}
const checkRunCalls = (fx) => fx.ghLog().filter(a => a[0] === 'api' && /\/check-runs$/.test(a[3] ?? '')).map(a => /commits\/([0-9a-f]+)\//.exec(a[3])[1]);

test('supported path: a fake orchestrator that only calls next ships FAIL -> repair -> confirmation -> publish -> CI and reaches COMPLETED, collecting review results with no notification', { skip: WIN_SKIP }, async (t) => {
  const fx = nextFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const o = orchestrator(fx, failThenPass);
  let collectedWithoutNotice = 0;
  const end = await o.run({ onStep: (out) => { if (out.next_action.action === 'collect_review') collectedWithoutNotice++; } });
  // P0 E6-min: COMPLETED through next only, once the engine recorded CI PASS for the published head.
  assert.deepEqual([end.next_action.stage, end.disposition, end.next_action.reason], [null, 'COMPLETED', 'completed']);
  for (const st of STAGES) assert.equal(end.stages[st].disposition, 'COMPLETED', `${st}: ${J(end.stages[st])}`);
  assert.equal(end.stages.CI.code, 'ci_passed');
  assert.equal(collectedWithoutNotice, 3, 'primary, second opinion and confirmation were each collected from the marker on disk');
  t.diagnostic(o.log.map(l => `${l.stage}:${l.action}:${l.reason}`).join(' > '));
  const actions = o.log.map(l => l.action);
  for (const a of ['drive', 'dispatch_review', 'collect_review', 'gate_review', 'gate_ship_ready', 'commit', 'publish', 'collect_ci']) assert.ok(actions.includes(a), `${a} in ${actions}`);
  assert.deepEqual(o.log.filter(l => l.stage === 'CI').map(l => [l.disposition, l.reason]), [['READY', 'ci_owed'], ['WAITING', 'ci_pending']],
    'CI: owed, then running (collect again)');
  const S = fx.readState();
  assert.deepEqual(S.review_chain.map(r => [r.kind, r.outcome ?? null]), [['original', 'FAIL'], ['repair', null], ['confirmation', 'PASS']]);
  assert.deepEqual([fx.runs('a').length, fx.runs('fix').length], [1, 1], 'nothing was dispatched twice');
  assert.equal(fx.remoteHead(), fx.head(), 'published through run-engine.mjs publish');
  assert.deepEqual(checkRunCalls(fx), [fx.head(), fx.head()], 'the fake gh was asked for the check runs of exactly the published head, twice');
  assert.deepEqual(S.ci_evidence.map(e => [e.head_sha, e.state]), [[fx.head(), 'PENDING'], [fx.head(), 'PASS']]);
  const st = fx.cli('status').out;
  assert.deepEqual([st.disposition, st.next_action.reason], ['COMPLETED', 'completed'], 'status derives the same next action');
  assert.equal(fx.cli('authorize', { stage: 'complete' }).out.allow, true);
});

test('killed mid-stage: a fresh orchestrator finds the in-flight worker WAITING (identity, start, marker), status offers resume, and the finished worker is collected once', { skip: WIN_SKIP }, async (t) => {
  const fx = nextFixture(t);
  const go = join(fx.root, 'go');
  fx.behave({ a: { write: { 'src/a.txt': 'a1' }, waitFor: go }, fix: { write: { 'src/a.txt': 'fixed' } } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  // The orchestrator's drive is SIGKILLed mid-stage, right after it released the worker (the lock stays behind).
  const killed = join(fx.root, 'killed');
  const job = { cmd: 'drive', ctx: { repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1', dagFile: fx.dagFile }, at: { name: 'after-release', nth: 1 }, marker: killed };
  const child = spawn(process.execPath, [CRASH_DRIVER, J(job)], { env: fx.env, stdio: 'ignore' });
  await new Promise(r => child.on('exit', r));
  assert.ok(existsSync(killed), 'the engine died at the after-release boundary');
  // A fresh orchestrator with no memory asks next: the dead engine's lock is recovered and the worker is WAITING.
  const w = fx.cli('next');
  assert.deepEqual([w.status, w.out.next_action.stage, w.out.disposition, w.out.next_action.reason], [0, 'BUILD', 'WAITING', 'attempt_in_flight'], w.stdout);
  const item = w.out.next_action.item;
  assert.match(item.attempt_id, /^att-/);
  assert.match(item.identity, /^claude:/);
  assert.ok(Number.isFinite(Date.parse(item.started_at)) && Number.isFinite(Date.parse(item.deadline)), J(item));
  assert.match(item.marker, /\.envelope\.json$/);
  assert.equal(existsSync(item.marker), false, 'no completion marker yet');
  writeFileSync(go, '');
  await waitFor(() => existsSync(item.marker), 'the worker envelope (its completion marker)');
  const st = fx.cli('status').out.next_action;
  assert.deepEqual([st.stage, st.action, st.reason], ['BUILD', 'resume', 'attempt_uncollected'], 'status offers resume for the finished, unrecorded worker');
  assert.equal(fx.cli('resume').status, 0);
  assert.equal(fx.readState().nodes.a.state, 'done', 'resume recorded the finished worker');
  const end = await orchestrator(fx, failThenPass).run();
  assert.deepEqual([end.next_action.stage, end.disposition], [null, 'COMPLETED']);
  assert.equal(fx.runs('a').length, 1, 'the killed stage was collected, never re-dispatched');
});

test('next collects a background worker itself: the envelope on disk is recorded under the lock, nothing dispatched again', { skip: WIN_SKIP }, async (t) => {
  const fx = nextFixture(t);
  const go = join(fx.root, 'go');
  fx.behave({ a: { write: { 'src/a.txt': 'a1' }, waitFor: go } });
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const killed = join(fx.root, 'killed');
  const child = spawn(process.execPath, [CRASH_DRIVER, J({ cmd: 'drive', ctx: { repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1', dagFile: fx.dagFile },
    at: { name: 'after-release', nth: 1 }, marker: killed })], { env: fx.env, stdio: 'ignore' });
  await new Promise(r => child.on('exit', r));
  const marker = fx.readState().attempts[0].envelope_file;
  writeFileSync(go, '');
  await waitFor(() => existsSync(marker), 'the worker envelope');
  const n = fx.cli('next').out;
  assert.deepEqual(n.collected.map(c => [c.node, c.status]), [['a', 'exited']]);
  assert.deepEqual([n.next_action.stage, n.next_action.action], ['REVIEW', 'dispatch_review']);
  assert.equal(fx.runs('a').length, 1);
});

test('NEEDS_APPROVAL stops the loop and never invents approval: a terminal review FAIL waits for an owner RETRY', { skip: WIN_SKIP }, async (t) => {
  const fx = nextFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const overflow = { review: (kind, role, c) => (role === 'primary' ? primaryReview(c, { outcome: 'FAIL', overflow: true, findings: [{ id: 'F1', severity: 'major', path: 'src/a.txt' }],
    acceptance_criteria: [{ criterion: 'AC1', outcome: 'FAIL', evidence: 'x' }] }) : secondOpinion(c)) };
  const before = runStateEvents(fx.planFile).length;
  const end = await orchestrator(fx, overflow).run();
  assert.deepEqual([end.next_action.stage, end.disposition, end.next_action.reason, end.next_action.action, end.next_action.owner],
    ['REVIEW', 'NEEDS_APPROVAL', 'review_terminal', 'owner_retry', 'human']);
  const chain = fx.readState().review_chain.length;
  const again = fx.cli('next');
  assert.equal(again.status, 2, 'next exits 2 on a stop');
  assert.equal(again.out.next_action.reason, 'review_terminal', 'asking again changes nothing');
  assert.equal(fx.readState().review_chain.length, chain);
  assert.equal(runStateEvents(fx.planFile).filter(e => e.event === 'RETRY').length, 0, 'no RETRY was appended');
  assert.ok(runStateEvents(fx.planFile).length >= before);
  // The owner's RETRY (appended while nothing runs) makes the new original review owed: approval came from the owner, not the loop.
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'review-2', predecessor: 'review-1', authorized_by: 'owner' });
  const owed = fx.cli('next').out.next_action;
  assert.deepEqual([owed.stage, owed.action, owed.review_execution], ['REVIEW', 'dispatch_review', 'review-2']);
});

test('un-enrolled: next returns the NEEDS_ENROLLMENT diagnostic (BLOCKED, enroll) and nothing advances', { skip: WIN_SKIP }, (t) => {
  const fx = nextFixture(t, { admit: false });
  const none = fx.cli('next');
  assert.deepEqual([none.status, none.out.next_action.action, none.out.next_action.reason], [2, 'init', 'no_state']);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  for (let i = 0; i < 2; i++) {
    const n = fx.cli('next');
    assert.equal(n.status, 2, n.stdout);
    assert.deepEqual([n.out.next_action.stage, n.out.disposition, n.out.next_action.action, n.out.next_action.diagnostic], ['ENROLL', 'BLOCKED', 'enroll', 'NEEDS_ENROLLMENT']);
  }
  assert.deepEqual([fx.readState().attempts.length, fx.runs().length], [0, 0], 'no worker ran');
  assert.equal(fx.cli('enroll').status, 0);
  assert.deepEqual([fx.cli('next').out.next_action.action, fx.cli('next').out.next_action.phase], ['context', 'build']);
});

test('the skill instructs next after every tool or agent return, stops only on the four STOP dispositions, and no longer ends a turn on "still running"', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
  const skill = read('SKILL.md'), card = read('references/execution-harness.md');
  assert.match(skill, /after every tool or agent return, and before any turn end, run `run-engine\.mjs next` and execute its `next_action`/);
  assert.match(skill, /Stop only when its disposition is `NEEDS_APPROVAL` \(\*\*WAIT_FOR_USER\*\*\), `BLOCKED` .* `FAILED` \(\*\*FAIL\*\*\) or `COMPLETED`/);
  assert.match(skill, /A `READY` stage is owed work, never a reason to end the turn/);
  assert.match(skill, /then follow `run-engine\.mjs next`/);
  assert.doesNotMatch(skill, /A reply of "still running" is valid/);
  assert.doesNotMatch(skill, /and read only `status`/);
  assert.match(card, /\*\*`next` is the supported path\*\*/);
  assert.doesNotMatch(card, /the only thing the orchestrator reads/);
  for (const d of STOP) assert.ok(card.includes(`\`${d}\``), d);
});
