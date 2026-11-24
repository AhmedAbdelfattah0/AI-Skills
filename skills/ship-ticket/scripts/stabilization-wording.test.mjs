import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// STAB-410 PR-1 wording pins (F-1, F-2/F-13, F-3, F-4, F-10, F-11, F-14 and the admission anti-loop sentence).
// One pin per decision; each pinned sentence is exact (whitespace-flattened), so a reword fails here.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');
const doc = (name) => flat(read(`../references/${name}`));
const skill = flat(read('../SKILL.md'));
const RED_RULE = 'On an engine run the RED record is the `gate red` evidence and no hand-written RUN-STATE RED line is required; on the manual flow the orchestrator appends the RED line. Unsupported runner output (a refused `gate red`) falls back to the manual event, marked degraded.';

test('F-1: direct Vitest applies only with a vitest config; the Angular unit-test builder gets an sh -c wrapper recipe', () => {
  const t = doc('execution-harness.md');
  assert.ok(t.includes('"Direct Vitest" applies only when a vitest config exists for the project.'));
  assert.ok(t.includes('`@angular/build:unit-test`'));
  assert.ok(t.includes('its RED runner is an `sh -c` wrapper with `format: vitest-json`'));
  assert.ok(t.includes('--skip-nx-cache --include=<workspace-relative spec> --reporters=json --outputFile="$f"'));
  assert.ok(t.includes('cat "$f"; rm -f "$f"; exit $rc'));
});

test('F-2/F-13 positive: the Fable PLAN route is claude_relay and native_session is unsupported for PLAN', () => {
  const t = doc('cross-model.md');
  assert.ok(t.includes('through the same relay with `--model`, kind `claude_relay`)'));
  assert.ok(t.includes('(through the same read-only relay, kind `claude_relay`)'));
  assert.ok(t.includes('The `native_session` carrier kind is unsupported for PLAN'));
});

test('F-2/F-13: one supported PLAN debate route (the read-only relay); native_session is unsupported for PLAN', () => {
  const t = doc('cross-model.md');
  assert.ok(t.includes('The one supported PLAN debate route is the read-only relay (`codex_relay` on a Claude host, `claude_relay` on a Codex host;'));
  assert.ok(t.includes("The relay's own out-dir under the host session scratchpad is the single write besides the plan file, and the orchestrator writes nothing else (no host-side scratch file)."));
  assert.ok(t.includes("a permission prompt is the owner's approval, a refusal is reported with its class and the degradation policy below applies, and the relay's out-dir writes are disclosed next to the approval request."));
  assert.ok(t.includes('The `native_session` carrier kind is unsupported for PLAN on a host without a defined evidence writer (the verifier code stays; nothing is deleted).'));
  assert.ok(!t.includes('(a subagent runs inside Plan Mode)'), 'the Fable substitute no longer runs as a Plan Mode subagent');
  assert.ok(doc('plan.md').includes("The PLAN debate runs only through the read-only relay ([cross-model.md](cross-model.md)); the relay's own out-dir under the host session scratchpad is the one write besides the plan file."));
});

test('F-3: the plan template states a Recording paths line outside the contract block', () => {
  const t = doc('plan.md');
  assert.ok(t.includes('**Recording paths:** `.specs/plans/<TICKET>.md` (this plan) and the predeclared ticket-keyed `session-log.md` entry.'));
  assert.ok(t.includes('they are not contract paths and are never added to the block above. State this line next to the scope when presenting it to the owner.'));
  const raw = read('../references/plan.md');
  const open = raw.indexOf('```scope-contract\n{"v":1,"mode":"<engine|manual>"');
  const close = raw.indexOf('```', open + 10);
  assert.ok(open > 0 && close > open);
  assert.ok(!raw.slice(open, close).includes('session-log.md'), 'session-log.md is not inside the scope-contract template block');
});

test('F-4: the template header value is fixed and no instruction flips it', () => {
  const raw = read('../references/plan.md');
  assert.ok(raw.includes('approval_status: recorded in START'));
  assert.ok(flat(raw).includes('the START event is the approval record; never edit this header after approval'));
  assert.ok(!/flips/.test(raw), 'plan.md has no "flips" instruction');
  assert.ok(!raw.includes('approval_status: pending|approved'));
});

test('F-10: a gate script that diffs merge-base...HEAD proves nothing before the commit (prove.md and ship.md)', () => {
  assert.ok(doc('prove.md').includes('A repository gate script that diffs `merge-base...HEAD` (for example a `local-gates.sh`) proves nothing before the one commit exists: run the underlying commands on the working tree instead. A rehearsal with `--allow-dirty` is never evidence.'));
  assert.ok(doc('ship.md').includes('(a gate script that diffs `merge-base...HEAD` checks nothing before the one commit)'));
});

test('F-11: the same RED rule appears in SKILL.md, review.md and ship.md', () => {
  assert.ok(skill.includes(RED_RULE), 'SKILL.md');
  assert.ok(doc('review.md').includes(RED_RULE), 'review.md');
  assert.ok(doc('ship.md').includes(RED_RULE), 'ship.md');
});

test('F-14: the turn may end while waiting on a host-tracked background command, as CONTINUE under that condition', () => {
  assert.ok(skill.includes('The turn may also end while waiting on a background command the host tracks and will resume on exit, provided the next action is recorded; that is the CONTINUE row under that condition, not a new state.'));
});

test('admission anti-loop: re-sample only while the reasons change; stop after 2 identical unsafe holds', () => {
  const t = doc('execution-harness.md');
  assert.ok(t.includes('Anti-loop rule: re-sample only while the set of hold reasons changes; after 2 identical unsafe holds in a row stop, report `host_hold_stable`, and either re-check at most once every 5 minutes or ask the owner.'));
});

test('STAB-410 F-8: debate cost and timing are not narrated in the digest-bound section 7', () => {
  const cm = doc('cross-model.md');
  assert.ok(!cm.includes('is shown in section 7 as information'), 'F-8: cost is not narrated in the digest-bound section 7');
  assert.ok(cm.includes('and timing are recorded only in the plan-resident attestation (`metrics`), outside the digest'));
});

test('STAB-410 F-8 (review round 1): the plan template keeps timing, cost and session ids out of the digest-bound narrative', () => {
  const p = doc('plan.md');
  assert.ok(!p.includes('**Timing and cost:**'), 'no section-7 timing and cost line');
  assert.ok(!p.includes('last version actually checked by counterpart'));
  assert.ok(!p.includes('carrier: {agent, kind, degraded}, rounds, calls, minutes}'), 'no counts in the plan_debate header');
  assert.ok(p.includes('live ONLY in the plan-resident attestation (`rounds`, `metrics`; RUN-STATE body, outside the digest)'));
  assert.ok(p.includes('live only in the plan-resident attestation `metrics` (RUN-STATE body, outside the digest)'));
  assert.ok(p.includes('Preflight also refuses `dag_read_write_dependency`'), 'F-9 refusal documented where preflight is described');
  assert.ok(p.includes('a literal bracket segment such as `app/[id]/page.tsx` reads as a glob'), 'the fail-closed over-refusal and its resolution');
  const sk = flat(read('../SKILL.md'));
  assert.ok(sk.includes('a non-conforming answer is recorded as a `rejected` round with its evidence kept'));
  assert.ok(sk.includes('(`dag_read_write_dependency`,'));
  assert.ok(!sk.includes('a non-conforming answer fails the round'));
});

test('F-4 resume: understand.md routes on the START event, not on the approval_status header', () => {
  const t = doc('understand.md');
  assert.ok(t.includes("read the START event in the plan's RUN-STATE (present and digest-valid = approved; absent = pending approval)"));
  assert.ok(!t.includes('`approval_status` literally'));
});

test('F-4 resume: a START with a digest mismatch routes to changed-plan re-approval via brief.mjs start-check', () => {
  assert.ok(doc('understand.md').includes('a START whose digest does not match the plan is a changed plan: route to the changed-plan re-approval bullet; the check is `brief.mjs start-check`'));
});
