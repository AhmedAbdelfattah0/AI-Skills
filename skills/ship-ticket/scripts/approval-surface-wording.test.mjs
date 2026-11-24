// Change A (2026-11-24): plan approval is interface-neutral. Pins: the qualified-surface rule is present in the three
// docs and the printed constants, and the terminal-only wording is gone from the whole skill tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as S from './check-pr-scope.mjs';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(SKILL, p), 'utf8');
const flat = (p) => read(p).replace(/\s+/g, ' ');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p]; });
const REPO = join(SKILL, '..', '..');
// needles built by concatenation so this file never matches itself
const OLD = [['trusted', ' terminal'], ['trusted', '-terminal'], ['terminal', ' only'], ['terminal', '-only'], ['terminal', ' approval policy']].map((a) => a.join(''));

test('the old terminal-only approval phrases appear nowhere in the skill tree or AGENTS.md', () => {
  const files = [...walk(SKILL), join(REPO, 'AGENTS.md')].filter((p) => /\.(md|mjs|json|yml|yaml|txt)$/.test(p) && !p.endsWith('approval-surface-wording.test.mjs'));
  assert.ok(files.length > 30);
  for (const f of files) {
    const t = readFileSync(f, 'utf8').replace(/\s+/g, ' ').toLowerCase();
    for (const n of OLD) assert.ok(!t.includes(n), `${f} still says "${n}"`);
  }
});

test('the printed constants state the qualified-surface rule and name exactly the three surfaces', () => {
  for (const c of [S.APPROVAL_CAVEAT, S.NOT_VERIFIED_REPORT]) assert.match(c, /qualified approval surface/);
  assert.equal(S.APPROVAL_CAVEAT, 'Byte verification only: this does not prove what the owner saw and does not authorize execution. Native ExitPlanMode approval remains mandatory, and it is valid only when given on a qualified approval surface: one that shows the complete, untruncated plan and does not let raw HTML hide or run content (Claude Code terminal, Claude Desktop, Plannotator\'s Approve action). Browser, GitHub and editor previews are never valid approval surfaces.');
  assert.equal(S.NOT_VERIFIED_REPORT, 'scope approval NOT verified: the approval was not a native ExitPlanMode approval on a qualified approval surface; do not build');
});

const RULE = 'Scope approval is valid only from a native ExitPlanMode approval given on a qualified approval surface: a surface that shows the complete, untruncated plan and does not let raw HTML or Markdown extensions hide or run content.';
test('plan.md, review.md and ship.md carry the qualified-surface rule, the report and the never-approval list', () => {
  const plan = flat('references/plan.md'), review = flat('references/review.md'), ship = flat('references/ship.md');
  assert.ok(plan.includes(RULE));
  assert.ok(plan.includes('Qualified surfaces: the Claude Code terminal, Claude Desktop, and Plannotator\'s Approve action'));
  assert.ok(plan.includes('Plannotator is a view and approve layer over the same native ExitPlanMode result: its Deny returns feedback and a revised plan needs a fresh approval.'));
  assert.ok(plan.includes('Merely viewing or rendering a plan is never approval'));
  assert.ok(plan.includes('chat text and AskUserQuestion are never approval'));
  assert.ok(plan.includes('Editing the plan after START voids it through the START digest binding (`approval_mismatch`).'));
  for (const [n, t] of [['review', review], ['ship', ship]]) {
    assert.ok(t.includes('qualified approval surface'), n);
    assert.ok(t.includes('native ExitPlanMode approval'), n);
  }
  for (const [n, t] of [['plan', plan], ['review', review], ['ship', ship]]) assert.ok(t.includes(S.NOT_VERIFIED_REPORT), `${n} carries the fail-closed report`);
});

test('the approved plan text itself carries the scope-contract block and the debate-dispositions line', () => {
  const plan = flat('references/plan.md'), skill = flat('SKILL.md');
  assert.ok(plan.includes('The bytes the owner approves are the plan text: the `scope-contract` block and the `debate-dispositions-v1:` line must be in the plan itself, not only in chat, so a surface that shows only the plan shows them.'));
  assert.ok(plan.includes('The four-backtick quote in the ExitPlanMode text is the input `--verify-quote` byte-compares with the plan block (a FAIL blocks SHIP); what the owner approves is the plan text.'));
  assert.ok(skill.includes('The `debate-dispositions-v1:` line must also be in the plan text itself, so a surface that shows only the plan shows it.'));
});

test('approval_surface is documented as optional, recorded only, never evidence, with its exact values and compatibility rule', () => {
  const plan = flat('references/plan.md');
  assert.ok(plan.includes('`approval_surface` (OPTIONAL audit field, one of `terminal`, `desktop`, `plannotator`: where the owner gave the decision); it is recorded only and is never evidence of approval. Absent is always accepted;'));
  assert.ok(plan.includes('Known accepted residual: an agent-written START, an auto-approving hook, or a local request to an approval UI endpoint'));
  assert.ok(flat('references/ship.md').includes('OPTIONAL audit field') && flat('SKILL.md').includes('is an OPTIONAL audit field'));
});
