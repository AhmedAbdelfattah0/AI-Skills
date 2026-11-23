// The shipped SKILL.md and plan.md template must never read as a test-kinds declaration: a plan that copies their
// text would otherwise be opted in (and refused) by the test-kinds detector. Positive signals: optIn false, status not_declared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as TK from './test-kinds.mjs';

const doc = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

for (const rel of ['SKILL.md', 'references/plan.md']) {
  test(`${rel} carries no test-kinds declaration`, () => {
    const planText = doc(rel);
    const opted = TK.MARKERS.filter((m) => m.opt_in).flatMap((m) => planText.split(/\r?\n/).filter((l) => TK.carriers(l, m).length).map((l) => `${m.id}: ${l}`));
    assert.deepEqual(opted, [], 'no line may carry an opt-in marker token');
    assert.equal(TK.optIn({ planText, declaration: null }), false);
    assert.equal(TK.requiredFor({ planText }).status, 'not_declared');
  });
}
