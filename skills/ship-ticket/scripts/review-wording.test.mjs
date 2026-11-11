import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
  assert.match(t, /Not applicable after degradation: record `harness degraded` and get explicit user approval\s+\(`WAIT_FOR_USER`\) before the commit/);
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
