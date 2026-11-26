import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// FR-4a wording pins for the two-cycle review limit in references/review.md.
// Kept apart from review-wording.test.mjs, which another unit owns.
const text = readFileSync(fileURLToPath(new URL('../references/review.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');
const start = text.indexOf('\n## Two-cycle limit');
const next = start < 0 ? -1 : text.indexOf('\n## ', start + 1);
const section = flat(start < 0 ? '' : text.slice(start, next < 0 ? undefined : next));

test('the two-cycle limit section exists and replaces the tripwire heading', () => {
  assert.ok(start >= 0, 'review.md has a "## Two-cycle limit" section');
  assert.ok(!text.includes('## Tripwire: same defect class twice'));
});

test('a cycle is counted per implementation revision, not per reviewer', () => {
  assert.ok(section.includes('per implementation revision (head), not per reviewer'));
  assert.ok(section.includes('Opus and Codex on the same head are one cycle'));
});

test('cycle 1 yields ONE consolidated repair plan; cycle 2 is an independent review of the repair', () => {
  assert.ok(section.includes('one consolidated repair plan'));
  assert.ok(section.includes('independent review of the consolidated repair'));
});

test('a qualifying Major or Blocker after cycle 2 stops automatic repair and opens a Root-Cause / Architecture Assessment', () => {
  assert.ok(section.includes('qualifying Major or Blocker'));
  assert.ok(section.includes('STOP automatic repair'));
  assert.ok(section.includes('Root-Cause / Architecture Assessment'));
});

test('no third repair cycle in one review execution; the Factory resumes on progress and the owner decides when none is made', () => {
  assert.ok(section.includes('There is no third repair cycle inside one review execution'));
  assert.ok(section.includes('the Factory resumes on its own'));
  assert.ok(section.includes('Owner approval is required when two consecutive rounds show no progress'));
  assert.ok(section.includes('a revised plan returns to the owner'));
});

test('the limit never waives a gate, downgrades a severity or approves shipping', () => {
  assert.ok(section.includes('Never waive a failing mandatory gate'));
  assert.ok(section.includes('never downgrade a severity to meet the limit'));
  assert.ok(section.includes('never treat the escalation as approval to ship'));
});

test('a provider refusal is recorded as provider_refused and the brief is never reworded', () => {
  assert.ok(section.includes('`provider_refused`'));
  assert.ok(section.includes('Never reword, split or re-scope a brief to pass a provider safeguard'));
});

test('at most two cycles per implementation attempt, in force from 2026-11-23', () => {
  assert.ok(section.includes('at most two cycles per implementation attempt'));
  assert.ok(section.includes('In force from 2026-11-23'));
});

test('cycle 2 is the targeted confirmation, not a new full review or any number of repair batches', () => {
  assert.ok(section.includes('the targeted confirmation above, the independent review of the consolidated repair'));
  assert.ok(section.includes('It is not a new full review, and it does not allow any number of repair batches'));
});

test('an implementation attempt is never reset by a commit or new head', () => {
  assert.ok(section.includes('An implementation attempt is never reset by a commit or a new head'));
  assert.ok(section.includes('A new attempt starts through a RUN-STATE `RETRY` for ticket runs'));
  assert.ok(section.includes('RUN-STATE `RETRY`'));
});

test('a same-class failed confirmation, even a Minor or a failed check, still requires re-assessment', () => {
  assert.ok(section.includes('fails on the same defect class as a primary finding, whatever its severity (including a Minor) and including a failed check'));
  assert.ok(section.includes('requires re-assessment, never another patch'));
});

test('manual versus engine enforcement is stated and no non-existent check is promised', () => {
  assert.ok(section.includes('**Manual versus engine today.**'));
  for (const c of ['`round_limit`', '`confirmation_spent`', '`retry_unauthorized`']) assert.ok(section.includes(c), c);
  assert.ok(section.includes('Until FR-4c, writing the assessment'));
  assert.ok(section.includes('nothing checks that the assessment file exists'));
  assert.ok(!section.includes('The engine checks that the assessment exists'));
});

test('provider_refused is recorded manually until a field exists', () => {
  assert.ok(section.includes('it is recorded manually (ledger or PR note) until one does'));
});

test('the assessment template names the five classes and the smallest defensible corrective approach', () => {
  for (const c of ['architecture defect', 'implementation defect', 'unclear acceptance contract', 'trust-boundary failure', 'incomplete test strategy']) {
    assert.ok(section.includes(c), `class: ${c}`);
  }
  assert.ok(section.includes('smallest defensible corrective approach'));
  for (const a of ['revise the approved plan', 'simplify the architecture', 'replace the implementation mechanism']) {
    assert.ok(section.includes(a), `approach: ${a}`);
  }
  assert.ok(section.includes('.specs/reviews/<KEY>/assessment-<review_execution>.md'));
});

