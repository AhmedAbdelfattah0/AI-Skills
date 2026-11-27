/**
 * W-1 wave model (PLAN-WAVE-FR4-approval-package A2/A4/A6 + addenda 2026-11-23d/e): manifest validator, binding, per-ticket state,
 * the generic readiness/admission core (WA-13/14/15/17), the read-only CLI, and mutants killed by exact-outcome assertions.
 * Every scenario below is an `(m) => void` over the module under test, so the SAME assertions run against the real module and
 * against each source mutant (a mutant must die with an AssertionError, never with a load error or any other throw).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as real from './wave.mjs';
import { planDigest } from './brief.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'wave.mjs');
const B = '<!-- RUN-STATE:BEGIN -->', E = '<!-- RUN-STATE:END -->';

// ---- fixtures ----------------------------------------------------------------------------------------------------------
const tk = (key, over = {}) => ({ key, plan: `.specs/plans/${key}.md`, run_id: `run-${key}`, worktree: `/work/${key}`, branch: `feat/${key}`, deps: [], dep_mode: 'ship_ready', resources: [], ...over });
const manifest = (tickets = [tk('T1'), tk('T2'), tk('T3', { deps: ['T1'] })], over = {}) => ({ schema: 'ship-ticket-wave-v1', wave_id: 'W-A', endpoint: 'SHIP_READY', heavy_slots: 1, tickets, ...over });
const codesOf = (m, mod = real) => mod.validateManifest(m).problems.map((p) => p.code);
const plan = (narrative, events = []) => `${narrative}${[B, ...events.map((e) => JSON.stringify(e)), E, ''].join('\n')}`;
const planFor = (t, line, over = {}) => {
  const narrative = `# ${t.key}\n\nDo it.\n${line === null ? '' : line + '\n'}\n`;
  const start = { run_id: t.run_id, event: 'START', approved_plan_digest: planDigest(plan(narrative)), approved_at: '2026-11-01T10:00:00Z', approved_by: 'Ahmed', ...over };
  return plan(narrative, [start]);
};
const node = (id, over = {}) => ({ id, deps: [], state: 'pending', owner_required: false, class: 'heavy', priority: 0, owns: [], ...over });
const states = (m, nodes) => Object.fromEntries(Object.entries(m.evaluateReadiness(nodes).decisions).map(([k, v]) => [k, v.state]));

// ---- scenarios (shared by the real module and every mutant) ---------------------------------------------------------------
const S = {
  manifest_valid_and_digest_stable(m) {
    const text = JSON.stringify(manifest(), null, 2) + '\n';
    const p = m.parseManifest(text);
    assert.equal(p.ok, true);
    assert.deepEqual(p.problems, []);
    assert.match(p.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(m.manifestDigest(text), p.digest);
    assert.notEqual(m.manifestDigest(text + ' '), p.digest);
    assert.equal(m.parseManifest(text.replace(/\n/g, '\r\n')).problems[0].code, 'wave_manifest_crlf');
    assert.equal(m.parseManifest('{nope').problems[0].code, 'wave_manifest_unreadable');
  },
  dag_cycle_refused(m) {
    assert.deepEqual(codesOf(manifest([tk('T1', { deps: ['T3'] }), tk('T2'), tk('T3', { deps: ['T1'] })]), m), ['wave_cycle']);
    assert.deepEqual(codesOf(manifest([tk('T1', { deps: ['T1'] })]), m), ['wave_cycle']);
    assert.deepEqual(codesOf(manifest([tk('A', { deps: ['C'] }), tk('B', { deps: ['A'] }), tk('C', { deps: ['B'] })]), m), ['wave_cycle']);
    assert.deepEqual(codesOf(manifest([tk('T1'), tk('T2', { deps: ['T1'] }), tk('T3', { deps: ['T1', 'T2'] })]), m), []);
  },
  dep_outside_wave_and_duplicates(m) {
    assert.deepEqual(codesOf(manifest([tk('T1', { deps: ['T9'] })]), m), ['wave_dep_unknown']);
    assert.deepEqual(codesOf(manifest([tk('T1'), tk('T1', { worktree: '/work/x', branch: 'feat/x' })]), m), ['wave_ticket_duplicate']);
    assert.deepEqual(codesOf(manifest([tk('T1'), tk('T2', { deps: ['T1', 'T1'] })]), m), ['wave_dep_duplicate']);
  },
  shared_branch_or_worktree_is_a_stack(m) {
    assert.deepEqual(codesOf(manifest([tk('T1'), tk('T2', { branch: 'feat/T1' })]), m), ['wave_stack_unsupported']);
    assert.deepEqual(codesOf(manifest([tk('T1'), tk('T2', { worktree: '/work/T1' })]), m), ['wave_stack_unsupported']);
  },
  release_mode_enum(m) {
    assert.deepEqual(codesOf(manifest(undefined, {}), m), []);
    assert.deepEqual(codesOf(manifest(undefined, { release_mode: 'manual' }), m), []);
    for (const bad of ['automated', 'auto_merge', 'create_pr', 'deploy', '', 'Manual']) assert.deepEqual(codesOf(manifest(undefined, { release_mode: bad }), m), ['release_mode_unsupported'], bad);
    assert.deepEqual(codesOf(manifest(undefined, { release_mode: 5 }), m), ['wave_schema_invalid']);
    assert.deepEqual(codesOf(manifest(undefined, { release_mode: null }), m), ['wave_schema_invalid']);
  },
  unsafe_paths_and_closed_schema(m) {
    const bad = (over, code = 'wave_path_unsafe') => assert.deepEqual(codesOf(manifest([tk('T1', over)]), m), [code], JSON.stringify(over));
    for (const plan of ['../x.md', '/etc/x.md', '.specs/../x.md', '.specs\\x.md', 'a\0.md', '.specs/plans/x.txt', '-x.md', 'a//b.md', '']) bad({ plan });
    for (const worktree of ['work/T1', '/work/../etc', '/work/T1/', '/work//T1', '/work/./T1', 'a\0']) bad({ worktree });
    for (const worktree of ['C:\\work\\..\\x', 'C:\\work\\T1\\', 'C:work', '\\\\srv\\x', 'C:\\work\\.\\T1']) bad({ worktree });
    // Windows-style roots are valid on every OS (no path.normalize: it would rewrite '/' on win32)
    assert.deepEqual(codesOf(manifest([tk('T1', { worktree: 'C:\\work\\T1' }), tk('T2', { worktree: 'D:/work/T2' })]), m), []);
    for (const owns of [['../x'], ['/abs'], ['a/../b'], ['-x']]) bad({ owns });
    for (const branch of ['--upload-pack=x', 'a..b', 'a b', 'x.lock', '/x', 'a//b']) bad({ branch }, 'wave_branch_invalid');
    bad({ resources: ['db'] }, 'wave_resource_invalid');
    bad({ resources: ['evil:x'] }, 'wave_resource_invalid');
    assert.deepEqual(codesOf(manifest([tk('T1', { resources: ['db:main', 'port:3000'], owns: ['src/a.mjs'] })]), m), []);
    assert.deepEqual(codesOf({ ...manifest(), extra: 1 }, m), ['wave_schema_invalid']);
    assert.deepEqual(codesOf(manifest([{ ...tk('T1'), surprise: true }]), m), ['wave_schema_invalid']);
    assert.deepEqual(codesOf(manifest(undefined, { heavy_slots: 3 }), m), ['wave_heavy_slots_invalid']);
    assert.deepEqual(codesOf(manifest(undefined, { heavy_slots: 0 }), m), ['wave_schema_invalid']);
    assert.deepEqual(codesOf(manifest([tk('T1', { priority: -1 })]), m), ['wave_schema_invalid']);
    assert.deepEqual(codesOf(manifest(undefined, { endpoint: 'MERGED' }), m), ['wave_schema_invalid']);
  },
  binding_digest_mismatch_after_ticket_added(m) {
    const m3 = manifest(), d3 = m.manifestDigest(JSON.stringify(m3, null, 2) + '\n');
    const plans = Object.fromEntries(m3.tickets.map((t) => [t.key, planFor(t, `wave: W-A ${d3}`)]));
    const ok = m.checkBinding(m3, d3, plans);
    assert.equal(ok.ok, true);
    assert.equal(ok.code, null);
    // add a ticket: the digest changes, so EVERY existing plan stops matching and nothing is approved
    const m4 = manifest([...m3.tickets, tk('T4')]), d4 = m.manifestDigest(JSON.stringify(m4, null, 2) + '\n');
    assert.notEqual(d4, d3);
    const after = m.checkBinding(m4, d4, { ...plans, T4: planFor(tk('T4'), `wave: W-A ${d4}`) });
    assert.equal(after.ok, false);
    assert.equal(after.code, 'wave_unapproved');
    assert.deepEqual(Object.fromEntries(Object.entries(after.tickets).map(([k, v]) => [k, v.reason])), { T1: 'wave_digest_mismatch', T2: 'wave_digest_mismatch', T3: 'wave_digest_mismatch', T4: null });
    // remove a ticket: same
    const m2 = manifest(m3.tickets.slice(0, 2)), d2 = m.manifestDigest(JSON.stringify(m2, null, 2) + '\n');
    assert.deepEqual(Object.values(m.checkBinding(m2, d2, plans).tickets).map((v) => v.reason), ['wave_digest_mismatch', 'wave_digest_mismatch']);
  },
  binding_line_rules(m) {
    const m3 = manifest(), d = m.manifestDigest(JSON.stringify(m3, null, 2) + '\n'), t = m3.tickets[0];
    const reason = (text) => m.checkPlanBinding(text, { waveId: 'W-A', digest: d, runId: t.run_id }).reason;
    assert.equal(reason(planFor(t, `wave: W-A ${d}`)), null);
    assert.equal(reason(planFor(t, null)), 'wave_line_missing');
    assert.equal(reason(planFor(t, `wave: W-A ${d}\nwave: W-A ${d}`)), 'wave_line_duplicate');
    assert.equal(reason(planFor(t, `wave: W-B ${d}`)), 'wave_id_mismatch');
    assert.equal(reason(planFor(t, `wave: W-A sha256:${'0'.repeat(64)}`)), 'wave_digest_mismatch');
    assert.equal(reason(planFor(t, 'wave: W-A sha256:abc')), 'wave_line_malformed');
    // a line only inside the RUN-STATE block is not narrative: it binds nothing
    const hidden = plan(`# T1\n\n`, [{ note: `wave: W-A ${d}` }]).replace(E, `wave: W-A ${d}\n${E}`);
    assert.equal(reason(hidden), 'wave_line_missing');
    // a plan edited after START: the existing approval digest no longer matches
    const edited = planFor(t, `wave: W-A ${d}`).replace('Do it.', 'Do something else.');
    assert.match(reason(edited), /^start_check_failed:.*start_digest_stale/);
    assert.match(reason(planFor(t, `wave: W-A ${d}`, { approved_plan_digest: undefined })), /^start_check_failed:/);
    assert.equal(reason(`no run state at all\nwave: W-A ${d}\n`), 'plan_invalid');
  },
  unlisted_plan_claiming_the_wave_is_refused(m) {
    const m3 = manifest(), d = m.manifestDigest(JSON.stringify(m3, null, 2) + '\n');
    const plans = Object.fromEntries(m3.tickets.map((t) => [t.key, planFor(t, `wave: W-A ${d}`)]));
    const rogue = planFor(tk('T9'), `wave: W-A ${d}`), other = planFor(tk('T8'), 'no wave here');
    const r = m.checkBinding(m3, d, plans, { unlisted: { '/p/T9.md': rogue, '/p/T8.md': other } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'wave_unapproved');
    assert.deepEqual(r.unlisted, ['/p/T9.md']);
    assert.equal(m.checkBinding(m3, d, { ...plans, T2: null }).tickets.T2.reason, 'plan_unreadable');
  },
  ticket_state_from_status(m) {
    const st = (over = {}) => ({ schema: 'ship-ticket-engine-status-v1', ticket: 'T1', run_id: 'r1', nodes: { a: { state: 'pending' } }, repairs: [], judgments: [], authority_untrusted: [], ...over });
    const d = (o) => m.deriveTicketState({ runId: 'r1', ...o });
    assert.deepEqual(d({ statusError: 'no_state' }), { state: 'pending', reason: 'not_started' });
    assert.deepEqual(d({ statusError: 'no_state', workspace: ['worktree_dirty'] }), { state: 'corrupt', reason: 'worktree_dirty' });
    assert.deepEqual(d({ statusError: 'engine_status_failed' }), { state: 'corrupt', reason: 'status_engine_status_failed' });
    assert.deepEqual(d({ status: null }), { state: 'corrupt', reason: 'status_unreadable' });
    assert.deepEqual(d({ status: st({ schema: 'x' }) }), { state: 'corrupt', reason: 'status_schema_unknown' });
    assert.deepEqual(d({ status: st({ run_id: 'other' }) }), { state: 'corrupt', reason: 'status_run_id_mismatch' });
    assert.deepEqual(d({ status: st({ judgments: 'x' }) }), { state: 'corrupt', reason: 'status_shape_invalid' });
    assert.deepEqual(d({ status: st({ judgments: [{ code: 'node_failed' }] }) }), { state: 'failed', reason: 'node_failed' });
    assert.deepEqual(d({ status: st({ judgments: [{ code: 'repair_failed' }, { code: 'x' }] }) }), { state: 'failed', reason: 'repair_failed' });
    assert.deepEqual(d({ status: st({ judgments: [{ code: 'retry_unauthorized' }] }) }), { state: 'waiting_owner', reason: 'retry_unauthorized' });
    assert.deepEqual(d({ status: st({ authority_untrusted: [{}] }) }), { state: 'waiting_owner', reason: 'authority_untrusted' });
    assert.deepEqual(d({ status: st({ next_action: { owner: 'human', code: 'approve' } }) }), { state: 'waiting_owner', reason: 'approve' });
    assert.deepEqual(d({ status: st(), shipReady: 'verified' }), { state: 'ship_ready', reason: 'ship_ready' });
    assert.deepEqual(d({ status: st(), shipReady: 'unverified' }), { state: 'corrupt', reason: 'ship_ready_unverified' });
    assert.deepEqual(d({ status: st({ judgments: [{ code: 'drift' }] }), shipReady: 'verified' }), { state: 'waiting_owner', reason: 'drift' });
    assert.deepEqual(d({ status: st({ nodes: { a: { state: 'running' } } }) }), { state: 'running', reason: 'work_live' });
    assert.deepEqual(d({ status: st({ repairs: [{ id: 'r', state: 'running' }] }) }), { state: 'running', reason: 'work_live' });
    assert.deepEqual(d({ status: st() }), { state: 'pending', reason: 'resumable' });
  },
  // WA-13: blocked parent -> independent ticket ready, dependant blocked
  work_conserving_three_ticket_dag(m) {
    const dag = (a) => [node('A', { state: a }), node('B'), node('C', { deps: ['A'] })];
    assert.deepEqual(states(m, dag('waiting_owner')), { A: 'waiting_owner', B: 'ready', C: 'blocked_dep' });
    assert.deepEqual(m.evaluateReadiness(dag('waiting_owner')).ready, ['B']);
    assert.deepEqual(states(m, dag('failed')), { A: 'failed', B: 'ready', C: 'blocked_dep' });
    assert.deepEqual(states(m, dag('corrupt')), { A: 'corrupt', B: 'ready', C: 'blocked_dep' });
    assert.deepEqual(states(m, dag('running')), { A: 'running', B: 'ready', C: 'blocked_dep' });
    assert.deepEqual(states(m, dag('pending')), { A: 'ready', B: 'ready', C: 'blocked_dep' });
    assert.deepEqual(m.evaluateReadiness(dag('pending')).decisions.C.blockers, [{ id: 'A', state: 'pending' }]);
    assert.deepEqual(states(m, dag('ship_ready')), { A: 'ship_ready', B: 'ready', C: 'ready' });
  },
  // WA-14: nothing cached across calls
  readiness_recomputed_on_every_call(m) {
    const before = [node('A'), node('C', { deps: ['A'] })];
    assert.deepEqual(m.evaluateReadiness(before).ready, ['A']);
    const after = [node('A', { state: 'ship_ready' }), node('C', { deps: ['A'] })];
    assert.deepEqual(m.evaluateReadiness(after).ready, ['C']);
    assert.deepEqual(m.evaluateReadiness(before).ready, ['A']);
    assert.deepEqual(before[0].state, 'pending', 'the input is never mutated');
  },
  // WA-17: truthful readiness
  ready_only_when_every_dep_is_ship_ready(m) {
    for (const s of ['prepared', 'pending', 'running', 'failed', 'waiting_owner', 'corrupt']) assert.equal(states(m, [node('A', { state: s }), node('C', { deps: ['A'] })]).C, 'blocked_dep', s);
    assert.equal(states(m, [node('A', { state: 'prepared' })]).A, 'prepared', 'prepared is a distinct state');
    assert.deepEqual(m.evaluateReadiness([node('A', { state: 'prepared' })]).ready, []);
    assert.equal(states(m, [node('A', { state: 'ship_ready' }), node('B', { state: 'prepared' }), node('C', { deps: ['A', 'B'] })]).C, 'blocked_dep');
    // dep_mode merged: ship_ready is not enough
    assert.equal(states(m, [node('A', { state: 'ship_ready' }), node('C', { deps: ['A'], dep_mode: 'merged' })]).C, 'blocked_dep');
    assert.equal(states(m, [node('A', { state: 'merged' }), node('C', { deps: ['A'], dep_mode: 'merged' })]).C, 'ready');
    assert.equal(states(m, [node('A', { state: 'merged' }), node('C', { deps: ['A'] })]).C, 'ready');
    assert.equal(m.evaluateReadiness([node('C', { deps: ['ghost'] })]).decisions.C.reason, 'dep_unknown');
    assert.equal(m.evaluateReadiness([node('C', { deps: ['ghost'] })]).decisions.C.state, 'blocked_dep');
  },
  owner_required_never_auto_ready(m) {
    const gated = [node('A', { owner_required: true }), node('B')];
    assert.deepEqual(states(m, gated), { A: 'waiting_owner', B: 'ready' });
    assert.equal(m.evaluateReadiness(gated).decisions.A.reason, 'owner_required');
    assert.deepEqual(m.evaluateReadiness(gated).ready, ['B']);
    assert.equal(states(m, [node('A', { owner_required: true, owner_approved: true })]).A, 'ready');
    assert.deepEqual(m.planAdmissions(gated, { capacity: { heavy: 2 } }).admit, ['B']);
  },
  cycle_in_the_pure_core_never_becomes_ready(m) {
    assert.deepEqual(states(m, [node('A', { deps: ['B'] }), node('B', { deps: ['A'] }), node('C')]), { A: 'blocked_dep', B: 'blocked_dep', C: 'ready' });
    assert.deepEqual(m.findCycle([{ id: 'A', deps: ['B'] }, { id: 'B', deps: ['A'] }]), ['A', 'B', 'A']);
    assert.equal(m.findCycle([{ id: 'A', deps: ['B'] }, { id: 'B', deps: [] }]), null);
  },
  readiness_input_is_checked(m) {
    for (const bad of [[node('A'), node('A')], [node('A', { state: 'weird' })], [node('A', { deps: 'B' })], [{ deps: [], state: 'pending' }], [node('A', { priority: 1.5 })], 'x']) {
      assert.throws(() => m.evaluateReadiness(bad), (e) => e.code === 'readiness_input_invalid');
    }
  },
  // WA-15 priority
  priority_orders_admission(m) {
    const nodes = [node('lo', { priority: 1 }), node('hi', { priority: 9 }), node('mid', { priority: 5 }), node('mid2', { priority: 5 })];
    assert.deepEqual(m.planAdmissions(nodes, { capacity: { heavy: 9 } }).admit, ['hi', 'mid', 'mid2', 'lo']);
    const one = m.planAdmissions(nodes, { capacity: { heavy: 1 } });
    assert.deepEqual(one.admit, ['hi']);
    assert.deepEqual(one.held.map((h) => [h.id, h.reason]), [['mid', 'held_heavy'], ['mid2', 'held_heavy'], ['lo', 'held_heavy']]);
  },
  // WA-15 bounded starvation (STARVATION_BOUND rounds, then the passed-over node goes first)
  starvation_is_bounded(m) {
    assert.equal(m.STARVATION_BOUND, 4, 'the bound is a pinned constant');
    let skips = {}, admittedAt = -1;
    for (let round = 0; round < 12 && admittedAt < 0; round++) {
      const nodes = [node('low', { priority: 0 }), node(`hi${round}`, { priority: 10 })];
      const r = m.planAdmissions(nodes, { capacity: { heavy: 1 }, skips });
      skips = r.skips;
      if (r.admit.includes('low')) { admittedAt = round; assert.deepEqual(r.admit, ['low']); }
      else assert.deepEqual(r.admit, [`hi${round}`]);
    }
    assert.equal(admittedAt, m.STARVATION_BOUND, 'low waits exactly STARVATION_BOUND rounds, then runs first');
    assert.equal(skips.low, undefined, 'an admitted node carries no skips');
  },
  admission_holds_and_resumes(m) {
    const nodes = [node('A'), node('B', { priority: 3 })];
    const held = m.planAdmissions(nodes, { capacity: { heavy: 2, hold: 'pressure' }, skips: { A: 2 } });
    assert.deepEqual(held.admit, []);
    assert.deepEqual(held.held.map((h) => [h.id, h.reason]), [['B', 'held_pressure'], ['A', 'held_pressure']]);
    assert.deepEqual(held.skips, { A: 2 }, 'a pressure hold does not age a node');
    assert.deepEqual(m.planAdmissions(nodes, { capacity: { heavy: 2 }, skips: held.skips }).admit, ['B', 'A']);
  },
  heavy_slots_and_reservations(m) {
    const running = node('R', { state: 'running', owns: ['src/a'] });
    assert.deepEqual(m.planAdmissions([running, node('A')], { capacity: { heavy: 1 } }).held, [{ id: 'A', reason: 'held_heavy' }]);
    assert.deepEqual(m.planAdmissions([running, node('A')], { capacity: { heavy: 2 } }).admit, ['A']);
    assert.deepEqual(m.planAdmissions([running, node('L', { class: 'light' })], { capacity: { heavy: 1 } }).admit, ['L'], 'a light node needs no heavy slot');
    const clash = m.planAdmissions([running, node('A', { owns: ['src/a'] })], { capacity: { heavy: 2 } });
    assert.deepEqual(clash.held, [{ id: 'A', reason: 'held_reservation' }]);
    const pair = m.planAdmissions([node('A', { owns: ['x'], priority: 2 }), node('B', { owns: ['x'] })], { capacity: { heavy: 2 } });
    assert.deepEqual([pair.admit, pair.held], [['A'], [{ id: 'B', reason: 'held_reservation' }]]);
  },
  verdict_is_truthful(m) {
    const d = (...s) => Object.fromEntries(s.map((x, i) => [`T${i}`, { state: x }]));
    assert.equal(m.waveVerdict(d('ship_ready', 'merged')), 'COMPLETE');
    assert.equal(m.waveVerdict(d('ship_ready', 'failed')), 'INCOMPLETE');
    assert.equal(m.waveVerdict(d('ship_ready', 'prepared')), 'INCOMPLETE');
    assert.equal(m.waveVerdict(d('ship_ready', 'blocked_dep')), 'INCOMPLETE');
    assert.equal(m.waveVerdict({}), 'INCOMPLETE');
  },
};

for (const [name, fn] of Object.entries(S)) test(`wave: ${name}`, () => fn(real));

// ---- CLI and read-only guarantees (real git worktrees) -----------------------------------------------------------------
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout; };
function waveRepo(specs) { // specs: [{key, deps?}] -> { root, manifestPath, tickets, digest }
  const root = mkdtempSync(join(tmpdir(), 'wave-w1-'));
  const tickets = specs.map((s) => tk(s.key, { worktree: join(root, s.key), deps: s.deps ?? [] }));
  const m = manifest(tickets);
  const text = JSON.stringify(m, null, 2) + '\n';
  const digest = real.manifestDigest(text);
  mkdirSync(join(root, 'plans'), { recursive: true });
  const manifestPath = join(root, 'plans', 'W-A.wave.json');
  writeFileSync(manifestPath, text);
  for (const t of tickets) {
    mkdirSync(join(t.worktree, '.specs/plans'), { recursive: true });
    git(t.worktree, 'init', '-q', '-b', t.branch);
    writeFileSync(join(t.worktree, t.plan), planFor(t, `wave: W-A ${digest}`));
    git(t.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(t.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  }
  return { root, manifestPath, tickets, digest, text };
}
const cli = (...args) => { const r = spawnSync(process.execPath, [SRC, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null }; };
const snapshot = (root) => { const out = {}; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = readFileSync(p, 'utf8'); } }; walk(root); return out; };

test('wave CLI: verify and status on a 3-ticket wave, then tamper (cli, read-only)', () => {
  const w = waveRepo([{ key: 'T1' }, { key: 'T2' }, { key: 'T3', deps: ['T1'] }]);
  try {
    const before = snapshot(w.root);
    const v = cli('verify', '--wave', w.manifestPath);
    assert.equal(v.code, 0, v.err);
    assert.equal(v.json.ok, true);
    assert.equal(v.json.digest, w.digest);
    assert.equal(v.json.release_mode, 'manual');
    const s = cli('status', '--wave', w.manifestPath);
    assert.equal(s.code, 0, s.err);
    assert.deepEqual(Object.fromEntries(Object.entries(s.json.decisions).map(([k, x]) => [k, x.state])), { T1: 'ready', T2: 'ready', T3: 'blocked_dep' });
    assert.deepEqual(s.json.ready, ['T1', 'T2']);
    assert.equal(s.json.verdict, 'INCOMPLETE');
    assert.equal(s.json.release, 'manual, pending owner');
    assert.deepEqual(snapshot(w.root), before, 'state, plans and the manifest are byte-identical after verify and status');
    // tamper the manifest: add a ticket -> every plan mismatches, status launches/derives nothing
    const m4 = JSON.parse(w.text); m4.tickets.push(tk('T4', { worktree: join(w.root, 'T4') }));
    writeFileSync(w.manifestPath, JSON.stringify(m4, null, 2) + '\n');
    const bad = cli('verify', '--wave', w.manifestPath);
    assert.equal(bad.code, 2);
    assert.equal(bad.json.code, 'wave_unapproved');
    assert.deepEqual(Object.values(bad.json.tickets).map((x) => x.reason).slice(0, 3), ['wave_digest_mismatch', 'wave_digest_mismatch', 'wave_digest_mismatch']);
    const st = cli('status', '--wave', w.manifestPath);
    assert.equal(st.code, 2);
    assert.deepEqual(st.json.ready, []);
    assert.deepEqual(st.json.states, {});
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('wave CLI: worktree precondition (wrong branch / dirty), unlisted claiming plan, bad manifests (cli)', () => {
  const w = waveRepo([{ key: 'T1' }, { key: 'T2' }]);
  try {
    git(w.tickets[0].worktree, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(w.tickets[1].worktree, 'stray.txt'), 'x');
    const s = cli('status', '--wave', w.manifestPath);
    assert.deepEqual(s.json.states, { T1: { state: 'corrupt', reason: 'worktree_wrong_branch' }, T2: { state: 'corrupt', reason: 'worktree_dirty' } });
    assert.deepEqual(s.json.ready, []);
    rmSync(join(w.tickets[1].worktree, 'stray.txt'));
    git(w.tickets[0].worktree, 'checkout', '-q', w.tickets[0].branch);
    rmSync(w.tickets[0].worktree, { recursive: true });
    const gone = cli('status', '--wave', w.manifestPath);
    assert.equal(gone.code, 2);
    assert.equal(gone.json.tickets.T1.reason, 'plan_unreadable');
    // an unlisted plan next to the manifest claiming the wave
    writeFileSync(join(w.root, 'plans', 'ROGUE.md'), `# rogue\nwave: W-A ${w.digest}\n`);
    const v = cli('verify', '--wave', w.manifestPath);
    assert.equal(v.json.code, 'wave_unapproved');
    assert.deepEqual(v.json.unlisted, [join(w.root, 'plans', 'ROGUE.md')]);
    // manifests refused with exact codes
    const bad = (m, name = 'W-A.wave.json') => { const p = join(w.root, 'plans', name); writeFileSync(p, typeof m === 'string' ? m : JSON.stringify(m, null, 2) + '\n'); return cli('verify', '--wave', p); };
    assert.equal(bad(manifest(undefined, { release_mode: 'automated' })).json.code, 'release_mode_unsupported');
    assert.equal(bad('{"a":1}\r\n').json.code, 'wave_manifest_crlf');
    assert.equal(bad(manifest(undefined, { wave_id: 'W-B' })).json.code, 'wave_id_invalid');
    assert.equal(cli('verify', '--wave', join(w.root, 'nope.wave.json')).json.code, 'wave_manifest_unreadable');
    assert.equal(cli('verify').code, 1);
    assert.equal(cli('launch', '--wave', w.manifestPath).code, 1);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('wave: read-only vocabulary and import graph (B11)', () => {
  const src = readFileSync(SRC, 'utf8');
  const specs = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((x) => x[1]);
  // S1: lib/run-placement.mjs is the read-only placement resolver of engine state (a leaf: node built-ins only, no writes)
  assert.deepEqual(specs.sort(), ['./brief.mjs', './harness.mjs', './lib/run-placement.mjs', './lib/shape.mjs', './run-state.mjs', './ship-ready-check.mjs', 'node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:url'].sort());
  assert.ok(!specs.some((s) => /gate|carrier|engine-|run-engine|durable-io/.test(s)), 'no gate/carrier/engine internals are imported');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  for (const word of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'unlinkSync', 'acquireLock', "'commit'", "'push'", "'add'", "'checkout'", 'worktree add', "'pr'", 'detached']) assert.ok(!code.includes(word), `read-only: ${word} must not appear`);
  assert.deepEqual([...code.matchAll(/spawnSync\(([^)]*)/g)].map((x) => x[1].split(',')[0].trim()), ["'git'", 'process.execPath']);
  assert.ok(/'--no-optional-locks'/.test(code), 'git is read without taking the index lock');
});

// ---- mutants: each source mutation must die by an AssertionError on a named scenario ---------------------------------------
const MUTANTS = [
  ['launch-ignoring-deps', "const ok = dep && (n.dep_mode === 'merged' ? dep.state === 'merged' : dep.state === 'ship_ready' || dep.state === 'merged');", 'const ok = true;', ['work_conserving_three_ticket_dag', 'ready_only_when_every_dep_is_ship_ready']],
  ['prepared-counts-as-ship-ready', "dep.state === 'ship_ready' || dep.state === 'merged');", "dep.state === 'ship_ready' || dep.state === 'merged' || dep.state === 'prepared');", ['ready_only_when_every_dep_is_ship_ready']],
  ['merged-mode-accepts-ship-ready', "n.dep_mode === 'merged' ? dep.state === 'merged' :", "n.dep_mode === 'merged' ? dep.state === 'ship_ready' :", ['ready_only_when_every_dep_is_ship_ready']],
  ['stale-ready-set', 'const nodes = normaliseNodes(rawNodes), by = new Map(nodes.map((n) => [n.id, n]));\n  const decisions = {}, ready = [];', 'const nodes = (globalThis.__w1 ??= normaliseNodes(rawNodes)), by = new Map(nodes.map((n) => [n.id, n]));\n  const decisions = {}, ready = [];', ['readiness_recomputed_on_every_call']],
  ['priority-ignored', 'return nb.priority - na.priority || na.order - nb.order;', 'return na.order - nb.order;', ['priority_orders_admission', 'admission_holds_and_resumes']],
  ['unbounded-starvation', 'export const STARVATION_BOUND = 4;', 'export const STARVATION_BOUND = 1e9;', ['starvation_is_bounded']],
  ['owner-gate-ignored', 'else if (n.owner_required && !n.owner_approved)', 'else if (false)', ['owner_required_never_auto_ready']],
  ['release-mode-automated-accepted', "export const RELEASE_MODES = Object.freeze(['manual']);", "export const RELEASE_MODES = Object.freeze(['manual', 'automated']);", ['release_mode_enum']],
  ['release-mode-never-checked', 'if (m.release_mode !== undefined && !RELEASE_MODES.includes(m.release_mode))', 'if (false)', ['release_mode_enum']],
  ['dag-cycle-unchecked', 'if (cycle) add(', 'if (false) add(', ['dag_cycle_refused']],
  ['dep-subset-unchecked', "else if (!keys.has(d)) add('wave_dep_unknown'", "else if (false) add('wave_dep_unknown'", ['dep_outside_wave_and_duplicates']],
  ['stack-unchecked', "if (prior !== undefined) add('wave_stack_unsupported'", "if (false) add('wave_stack_unsupported'", ['shared_branch_or_worktree_is_a_stack']],
  ['unsafe-paths-accepted', "const hasDots = (p) => p.split('/').some((s) => s === '' || s === '.' || s === '..');", 'const hasDots = () => false;', ['unsafe_paths_and_closed_schema']],
  ['binding-digest-unchecked', "if (lines[0].digest !== digest) return { ok: false, reason: 'wave_digest_mismatch' };", '', ['binding_digest_mismatch_after_ticket_added', 'binding_line_rules']],
  ['start-not-verified', "if (!sc.ok) return { ok: false, reason: 'start_check_failed:' + sc.errors.map((x) => x.code).join(',') };", '', ['binding_line_rules']],
  ['unlisted-plan-ignored', 'const ok = Object.values(tickets).every((x) => x.ok) && claimed.length === 0;', 'const ok = Object.values(tickets).every((x) => x.ok);', ['unlisted_plan_claiming_the_wave_is_refused']],
  ['complete-with-failed-ticket', "states.every((s) => s === 'ship_ready' || s === 'merged')", "states.some((s) => s === 'ship_ready' || s === 'merged')", ['verdict_is_truthful']],
  ['unverified-ship-ready-trusted', "if (shipReady === 'unverified') return { state: 'corrupt', reason: 'ship_ready_unverified' };", '', ['ticket_state_from_status']],
  ['failure-hidden', 'if (failed) return { state: \'failed\', reason: failed };', '', ['ticket_state_from_status']],
  ['heavy-slots-ignored', "if (n.class === 'heavy' && heavyBusy >= slots)", 'if (false)', ['heavy_slots_and_reservations', 'priority_orders_admission']],
  ['reservation-ignored', 'if (n.owns.some((o) => owned.has(o)))', 'if (false)', ['heavy_slots_and_reservations']],
  ['pressure-hold-ignored', 'if (capacity?.hold) return', 'if (false) return', ['admission_holds_and_resumes']],
];

for (const [name, from, to, killers] of MUTANTS) {
  test(`wave mutant ${name} is killed by an assertion`, async () => {
    const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n'); // Windows checkouts are CRLF; the mutation sites are LF
    assert.equal(src.split(from).length - 1, 1, `mutation site for ${name} must match exactly once`);
    const file = join(HERE, `wave.mutant-${name}.${process.pid}.mjs`);
    writeFileSync(file, src.replace(from, to));
    try {
      const mod = await import(pathToFileURL(file).href);
      const killed = [];
      for (const k of killers) {
        delete globalThis.__w1;
        try { S[k](mod); } catch (e) { assert.equal(e?.name, 'AssertionError', `${name}: ${k} died by a non-assertion ${e?.stack ?? e}`); killed.push(k); }
      }
      delete globalThis.__w1;
      assert.ok(killed.length > 0, `mutant ${name} survived: no scenario of ${killers.join(', ')} failed`);
    } finally { rmSync(file, { force: true }); }
  });
}

test('wave: readTicket reads the engine status through the CLI only (fake engine; ship-ready needs the engine GATE line)', () => {
  const w = waveRepo([{ key: 'T1' }]);
  try {
    const t = w.tickets[0];
    const dir = join(t.worktree, '.git', 'ai-skills', 'ship-ticket');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'T1.state.json'), '{}');
    const status = { schema: 'ship-ticket-engine-status-v1', ticket: 'T1', run_id: t.run_id, nodes: { a: { state: 'done' } }, repairs: [], judgments: [], authority_untrusted: [] };
    const fake = join(w.root, 'fake-engine.mjs');
    writeFileSync(fake, `process.stdout.write(${JSON.stringify(JSON.stringify(status))}); // argv: ${'$'}{process.argv.slice(2).join(' ')}\n`);
    const planPath = join(t.worktree, t.plan);
    const cand = 'cand-1';
    writeFileSync(planPath, readFileSync(planPath, 'utf8').replace(E, `${JSON.stringify({ event: 'SHIP_READY', run_id: t.run_id, candidate_id: cand })}\n${E}`));
    assert.deepEqual(pick(real.readTicket(t, { engineCli: fake })), { state: 'corrupt', reason: 'ship_ready_unverified' }, 'a RUN-STATE SHIP_READY without an engine GATE line is never trusted');
    writeFileSync(join(dir, 'T1.engine.jsonl'), JSON.stringify({ event: 'GATE', gate: 'ship-ready', ok: true, run_id: t.run_id, candidate_id: cand }) + '\n');
    assert.deepEqual(pick(real.readTicket(t, { engineCli: fake })), { state: 'ship_ready', reason: 'ship_ready' });
    writeFileSync(join(w.root, 'bad.mjs'), 'process.exit(3)');
    assert.deepEqual(pick(real.readTicket(t, { engineCli: join(w.root, 'bad.mjs') })), { state: 'corrupt', reason: 'status_engine_status_failed' });
    writeFileSync(join(w.root, 'junk.mjs'), 'process.stdout.write("not json")');
    assert.deepEqual(pick(real.readTicket(t, { engineCli: join(w.root, 'junk.mjs') })), { state: 'corrupt', reason: 'status_unreadable' });
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
const pick = ({ state, reason }) => ({ state, reason });
