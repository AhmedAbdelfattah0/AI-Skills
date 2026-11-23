import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateReview } from './gate.mjs';

// Windows runners check markdown out as CRLF; the multi-line assertions below match LF text.
const load = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const ref = (name) => load(fileURLToPath(new URL(`../references/${name}`, import.meta.url)));

const FINDING = { id: 'F1', severity: 'major', path: 'src/a.mjs', evidence: '"x"', consequence: 'c', fix: 'f' };
const primary = (over = {}) => ({
  reviewer_identity: 'claude-opus:review-1', candidate_id: 'sha256:c1', reviewed_paths: ['src/a.mjs'], reasoned_exclusions: [],
  coverage_partitions: [{ identity: 'claude-opus:review-1', owned: ['src/'], outcome: 'PASS' }],
  acceptance_criteria: [{ criterion: '1', outcome: 'PASS', evidence: 'a.test.mjs' }],
  rule_rows: [{ subject_id: 'BE-SEC-1', outcome: 'PASS', evidence: 'a.mjs:1' }],
  parity_outcome: 'NOT_TRIGGERED', attack_review_outcome: 'NOT_TRIGGERED', security_outcome: 'PASS',
  findings: [], overflow: false, outcome: 'PASS', ...over,
});
const second = (over = {}) => ({ route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: 'sha256:c1', findings: [], overflow: false, outcome: 'PASS', ...over });
const input = (over = {}) => ({
  state: { frozen_candidate: 'sha256:c1', builders: [{ node: 'n', identity: 'claude-sonnet:n' }], review_chain: [] },
  review_execution: 'rx-1', kind: 'original', primary: primary(), second_opinion: second(),
  reconciliation: { dispositions: [] }, graded_artifacts: {}, repair_ownership: [], ...over,
});

test('gate refuses primary PASS with a second-opinion finding disposed fix', () => {
  const r = gateReview(input({
    second_opinion: second({ findings: [FINDING], outcome: 'FAIL' }),
    reconciliation: { dispositions: [{ finding_id: 'F1', source: 'codex', disposition: 'fix' }] },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'outcome_inconsistent');
  assert.ok(r.reasons.includes('PASS with findings to fix'));
});

test('the same finding with a primary FAIL is accepted and opens a repair', () => {
  const r = gateReview(input({
    primary: primary({ outcome: 'FAIL' }),
    second_opinion: second({ findings: [FINDING], outcome: 'FAIL' }),
    reconciliation: { dispositions: [{ finding_id: 'F1', source: 'codex', disposition: 'fix' }] },
  }));
  assert.equal(r.code, 'review_accepted');
  assert.deepEqual(r.record.fix_findings, ['F1']);
});

test('review.md states the finding id form, the fix refusal and the usage import', () => {
  const t = ref('review.md');
  assert.ok(t.includes('A disposition row carries `finding_id` and `source`'));
  assert.ok(t.includes('refusing a primary `PASS` with a finding\ndisposed `fix` (`outcome_inconsistent`)'));
  assert.ok(t.includes('Run `usage.mjs import-session` (and `import-codex`)'));
  assert.ok(!t.includes('usage.mjs import`'));
  assert.ok(t.includes('never edit it by hand'));
});

test('ship.md states the ship-ready check; brief.md holds the base-drift placement', () => {
  const t = ref('ship.md');
  assert.ok(!t.includes('Pin `config.base`'));
  assert.ok(t.includes('`ship-ready-check.mjs check\n--run-state <plan> --engine-log <log> --run-id <ID> --require-event`'));
  assert.ok(t.includes('nonzero stops (`WAIT_FOR_USER`)'));
  // Harness degradation: ELEVATED or security-sensitive runs still stop for explicit approval before the commit;
  // STANDARD runs record it with the manual confirmations in SHIP_READY and the PR body and proceed.
  const flat = t.replace(/\s+/g, ' ');
  assert.ok(flat.includes('A nonzero result is a gate failure, never relabelled as degradation.'));
  assert.ok(flat.includes('Not applicable after degradation: record `harness degraded` and the results of the read-only confirmations above in the SHIP_READY event and the PR body.'));
  assert.ok(flat.includes('On an ELEVATED or security-sensitive run this is an assurance exception: get explicit user approval (`WAIT_FOR_USER`) before the commit.'));
  assert.ok(flat.includes('A STANDARD run then commits without a second approval.'));
  assert.ok(!flat.includes('the one plan approval already covers it'));
  const hi = ref('harness-internals.md').replace(/\s+/g, ' ');
  assert.ok(hi.includes('On an ELEVATED or security-sensitive run, get explicit user approval (`WAIT_FOR_USER`) before the commit; a STANDARD run records it in the PR body and commits.'));
  const b = ref('brief.md');
  assert.ok(b.includes('leave `config.base` as is'));
  assert.ok(b.includes('base-drift.mjs check --repo <R> --base <SHA>'));
  assert.ok(!b.includes('or `rebind`'));
  assert.match(b, /Exit 1 \(overlap\): `WAIT_FOR_USER`; after the user accepts the move, re-record the base SHA/);
  assert.match(b, /Exit 3 \(git or input failure\): fix the input and rerun; not a user decision/);
});

test('harness-internals.md names the .attempts copy destination and has no narrative exception', () => {
  const t = ref('harness-internals.md');
  assert.ok(t.includes('<run-id>-<n>.attempts`, a sibling'));
  assert.ok(!t.includes('Owner exception'));
  assert.ok(t.includes('`harness degraded`'));
});

test('the multi-line assertions hold on a CRLF checkout of the same files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crlf-'));
  try {
    for (const name of ['review.md', 'ship.md']) {
      const copy = join(dir, name);
      writeFileSync(copy, ref(name).replace(/\n/g, '\r\n'));
      assert.ok(readFileSync(copy, 'utf8').includes('\r\n'));
      assert.equal(load(copy), ref(name));
    }
    assert.ok(load(join(dir, 'review.md')).includes('with a finding\ndisposed `fix`'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The code-quality specialists are retired aliases with no rules. ship-ticket must
// never route to one, nor make a proof or fallback depend on one being installed:
// a unified-only install would satisfy "no specialist installed" literally.
test('no ship-ticket instruction names or depends on a retired code-quality specialist', () => {
  const dir = fileURLToPath(new URL('../', import.meta.url));
  const files = ['SKILL.md', ...readdirSync(join(dir, 'references')).filter((f) => f.endsWith('.md')).map((f) => `references/${f}`)];
  assert.ok(files.length > 10, `read ${files.length} files`);
  const hits = [];
  for (const f of files) {
    load(join(dir, f)).split('\n').forEach((line, i) => {
      if (/\bspecialists?\b|angular-code-quality|backend-code-quality/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
  assert.ok(load(join(dir, 'references/prove.md')).includes('`code-quality`\nor the applicable stack reference not installed'));
});

// RC-1 reviewer policy: Codex, else a fresh Fable session; CodeRabbit is optional. The final gate only
// requires the two reviewers to differ by provider:model, so an Opus primary and a Fable second pass.
test('gate accepts a Fable second opinion beside the Opus primary and refuses the same model twice', () => {
  const opus = { reviewer_identity: 'claude:opus-5-5', coverage_partitions: [{ identity: 'claude:opus-5-5', owned: ['src/'], outcome: 'PASS' }] };
  const fable = input({ primary: primary(opus), second_opinion: second({ route: 'fable', reviewer_identity: 'claude:fable' }) });
  assert.equal(gateReview(fable).code, 'review_accepted');
  const twin = input({ primary: primary(opus), second_opinion: second({ route: 'fable', reviewer_identity: 'claude:opus-5-5' }) });
  assert.equal(gateReview(twin).code, 'reviewers_not_distinct');
});

test('the second-opinion policy names Codex then Fable and never requires CodeRabbit', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const x = flat(ref('cross-model.md'));
  assert.ok(x.includes('Record the model id the carrier reports (`claude:fable-<version>`), or `claude:fable` when it reports none.'));
  assert.ok(x.includes('if any builder ran on Fable, Fable cannot be the second opinion'));
  assert.ok(x.includes('**CodeRabbit is optional extra coverage**'));
  assert.ok(x.includes('start a new subagent with `model: fable`'), 'the Fable route has dispatch instructions');
  const skill = load(fileURLToPath(new URL('../SKILL.md', import.meta.url)));
  const texts = { 'SKILL.md': skill, ...Object.fromEntries(['review.md', 'cross-model.md', 'understand.md', 'codex-cli.md', 'plan.md', 'units.md'].map((n) => [n, ref(n)])) };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(flat(text), /CodeRabbit (fallback|on the same candidate;)|falls back to CodeRabbit|run the CodeRabbit fallback|CodeRabbit is still a required route/, name);
  }
  // Risky unit reviews need a cross-provider second opinion (engine-enforced), so unitReview stays off without Codex.
  assert.ok(flat(ref('units.md')).includes('leave `config.unitReview` off (it is opt-in, never defaulted) whenever Codex is unavailable at PLAN'));
  assert.ok(flat(skill).includes('`config.unitReview` stays off when Codex is unavailable'));
});

test('a targeted confirmation accepts a Fable second opinion on the repair beside the Opus primary', () => {
  const opus = 'claude:opus-5-5';
  const chain = [
    { review_execution: 'rx-1', kind: 'original', outcome: 'FAIL', candidate_id: 'sha256:c1', reviewer_identity: opus, second_opinion_route: 'codex', fix_findings: ['F1'] },
    { review_execution: 'rx-1', kind: 'repair', old_candidate: 'sha256:c1', new_candidate: 'sha256:c2', write_set: ['src/a.mjs'] },
  ];
  const confirmation = (soId) => ({
    state: { frozen_candidate: 'sha256:c2', builders: [{ node: 'n', identity: 'claude:sonnet-5-5' }], review_chain: chain },
    review_execution: 'rx-1', kind: 'confirmation',
    primary: { reviewer_identity: opus, candidate_id: 'sha256:c2', checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed at a.mjs:1' },
    second_opinion: { route: 'fable', reviewer_identity: soId, candidate_id: 'sha256:c2', checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed at a.mjs:1' },
  });
  const ok = gateReview(confirmation('claude:fable'), { confirmationSecondOpinion: 'required' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(gateReview(confirmation(opus), { confirmationSecondOpinion: 'required' }).code, 'reviewers_not_distinct');
});

test('RC-1 headline rules are pinned: native Plan Mode approval, section 3b, the stop-list owner', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const skill = flat(load(fileURLToPath(new URL('../SKILL.md', import.meta.url))));
  const plan = flat(ref('plan.md'));
  for (const [name, t] of [['SKILL.md', skill], ['plan.md', plan]]) {
    assert.ok(t.includes('ToolSearch query `select:EnterPlanMode,ExitPlanMode`'), name);
  }
  assert.ok(plan.includes('**Only `ExitPlanMode` approves.** Chat text, an `AskUserQuestion` answer and a typed "approve" are not plan approval'));
  assert.ok(skill.includes('A chat reply, an `AskUserQuestion` answer or the gap question\'s answer is never that approval.'));
  assert.ok(plan.includes('### 3b. Impact and check applicability'));
  assert.ok(plan.includes('| Component / flow / dependency touched | Risk (technical · security · business · data-integrity · regression) | Check that covers it (test type, security control id, review skill or gate) | Runs when | Re-runs when | Status |'));
  assert.ok(plan.includes('**Status vocabulary:** `verified`, `partially verified`, `unverified`, `failed` (it ran and did not pass), `not applicable`'));
  assert.ok(plan.includes('anything other than `verified` or `not applicable` (`planned`, `partially verified`, `unverified`, `failed`) is a security exception: it blocks SHIP'));
  assert.ok(flat(ref('ship.md')).includes('`SECURITY_WAIVER` event with `boundary: "plan-3b"`'));
  assert.ok(skill.includes('This list is the single owner of the stop points, by category'));
  assert.ok(skill.includes('Never force-push without explicit owner authority'));
  assert.ok(skill.includes('a nonzero `ship-ready-check` (a gate failure, never relabelled as harness degradation)'));
});

test('RC-1 release and stop rules are pinned where they are executed: ship.md block list, the spine stop list, Resume', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const skill = flat(load(fileURLToPath(new URL('../SKILL.md', import.meta.url))));
  const stops = skill.slice(skill.indexOf('## When execution may yield'), skill.indexOf('Use **FAIL** for:'));
  assert.ok(stops.length > 500, 'the stop list section was found');
  assert.ok(flat(ref('ship.md')).includes('Any other status (`planned`, `partially verified`, `unverified`, `failed`, or no status) needs the owner\'s explicit acceptance for this candidate, otherwise `WAIT_FOR_USER`.'));
  assert.ok(flat(ref('plan.md')).includes('`failed` (it ran and did not pass)'));
  assert.ok(stops.includes('an applicable security check in plan section 3b whose status is anything other than `verified` or `not applicable` at release'));
  assert.ok(stops.includes('a degraded harness at SHIP on an ELEVATED or security-sensitive run'));
  assert.ok(stops.includes('a REPAIR the ledger does not authorize'));
  assert.ok(!stops.includes('classification_missing'), 'the engine reports reassess_unclassified; classifying is routine');
  assert.ok(skill.includes('On Claude that means re-entering Plan Mode (`EnterPlanMode`), updating the plan file and presenting the revised plan with `ExitPlanMode`'));
  assert.ok(skill.includes('Chat text, an `AskUserQuestion` answer and a typed "approve" are not plan approval'));
});

test('S3c: manual-flow fallback stops at fallback time on ELEVATED runs, and an internal plan defect recovers inside Plan Mode', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const skill = flat(load(fileURLToPath(new URL('../SKILL.md', import.meta.url))));
  const stops = skill.slice(skill.indexOf('## When execution may yield'), skill.indexOf('Use **FAIL** for:'));
  const assurance = stops.slice(stops.indexOf('- **security or assurance exceptions:**'), stops.indexOf('- **engine and gate safety refusals:**'));
  const resume = skill.slice(skill.indexOf('## Resume'), skill.indexOf('## Scope boundary'));
  assert.ok(assurance.length > 300 && resume.length > 500, 'the stop category and Resume sections were found');
  const exh = flat(ref('execution-harness.md'));
  // Fallback-time stop, with the ELEVATED qualifier inside each pinned string.
  assert.ok(skill.includes('On an ELEVATED or security-sensitive run, falling back to the manual (engine-less) flow after plan approval is an assurance exception at fallback time: **WAIT_FOR_USER** for the owner\'s recorded approval (approve the manual flow, or restore the engine and resume on it); a STANDARD run records the degraded path with a warning and continues.'));
  assert.ok(assurance.includes('a fallback to the manual flow after plan approval on an ELEVATED or security-sensitive run'));
  assert.ok(exh.includes('On an ELEVATED or security-sensitive run, falling back to the manual flow after plan approval is **WAIT_FOR_USER** at fallback time (SKILL.md); a STANDARD run records `harness degraded` with a warning.'));
  assert.ok(exh.includes('on an ELEVATED or security-sensitive run that is **WAIT_FOR_USER** at fallback time, SKILL.md stop list'));
  assert.ok(flat(ref('review.md')).includes('on an ELEVATED or security-sensitive run that is **WAIT_FOR_USER** at fallback time, SKILL.md stop list'));
  // Internal Factory plan defect recovery, in Resume.
  assert.ok(resume.includes('Approved plan that fails the Factory\'s own prerequisites'));
  assert.ok(resume.includes('and `init` has not run: this bullet takes precedence over the one above.'));
  assert.ok(resume.includes('(native approval, never typed; accepting it records the new START, which the orchestrator then appends) and record the evidence in the plan\'s RUN-STATE.'));
  assert.ok(resume.includes('Renewed approval of the substance is needed only if the pairs, DAG, surfaces or review profile change; even a deterministic completion goes through `ExitPlanMode`, and derived sections are never auto-approved.'));
  assert.ok(resume.includes('After `init`, any narrative change needs a new approved START/run'));
});

test('P7m: test-kinds.md carries the verbatim L-ran claim, the declaration how-to and the limits, and no stale freeze-check claim', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const tk = flat(ref('test-kinds.md'));
  assert.ok(tk.includes('Test-kind evidence is **L-ran**: the engine itself ran the declared test command on the exact candidate and received, through a channel no test file can write after the run, the runner\'s report that a test carrying the marker in its own title executed and passed. It does not show the test would fail if the behaviour broke (mutation testing and independent review cover that). It does not yet cover Angular/nx tests, tests run in a `threads` pool, or tampering with installed dependencies.'));
  assert.ok(tk.includes('`config.testKinds: { "policy": 1 }`'));
  assert.ok(tk.includes('`config.securityPolicy: 2`'));
  for (const code of ['test_kinds_policy_required', 'plan_tags_missing', 'test_kinds_runner_missing', 'multi_entry_unsupported_v0', 'evidence_refreshed', 'evidence_unquiet', 'channel_unsupported']) assert.ok(tk.includes('`' + code + '`'), code);
  for (const limit of ['**R-L2:**', '**R-T2:**', '**R-TC:**', '**R-cov:**']) assert.ok(tk.includes(limit), limit);
  assert.ok(tk.includes('**T0 (`fast-checks.mjs`) is not engine-enforced yet**'));
  assert.ok(!tk.includes('No engine step runs `check` at freeze yet'), 'the stale claim is gone');
  assert.ok(flat(ref('prove.md')).includes('The engine-enforced evidence option and its limits are in the same file.'));
  assert.ok(flat(tk).includes('Once DAG validation has passed, a MISSING value on a current approval is refused as `security_policy_required`'));
  assert.ok(flat(tk).includes('is refused as `dag_invalid` (`scripts/engine-dag.mjs:150` and `:152`'));
  assert.ok(!tk.includes('refused first as `security_policy_required`'), 'the unqualified claim is gone');
  assert.ok(tk.includes('`test_kinds_needs_security_policy` (`scripts/run-engine.mjs:382`) applies only after those pass.'));
  assert.ok(tk.includes('the Linux vector is moot while the evidence channel is darwin-only'));
});
