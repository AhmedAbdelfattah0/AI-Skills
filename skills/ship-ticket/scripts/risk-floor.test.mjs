// Tests for risk-floor.mjs (S-10 / ASTF-11). Assertions are on codes and shapes, not message text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RF from './risk-floor.mjs';

const SCRIPT = fileURLToPath(new URL('./risk-floor.mjs', import.meta.url));
// A SCRUM-202-shaped plan: a read-only display ticket that shows per-tenant prices (the plan v1 said "security-sensitive: no").
const SCRUM202 = 'Reports page: display each tenant\'s price list and subscription totals. Read-only, no writes.';

test('AC1: a SCRUM-202-shaped ticket is floored to ELEVATED with a debate, even when claimed STANDARD', () => {
  const r = RF.check({ ticketText: SCRUM202, claimed: 'STANDARD' });
  assert.equal(r.floor, 'ELEVATED');
  assert.equal(r.final, 'ELEVATED');
  assert.equal(r.debate.required, true);
  assert.ok(r.classes.includes('money') && r.classes.includes('tenancy'));
});

test('AC2: a typo-only ticket is not floored', () => {
  const r = RF.check({ ticketText: 'Fix typo in README: "teh" -> "the"; author name capitalisation', paths: ['README.md', 'docs/intro.md'], claimed: 'STANDARD' });
  assert.equal(r.floor, 'STANDARD');
  assert.equal(r.final, 'STANDARD');
  assert.equal(r.debate.required, false);
});

test('AC3: the floor can only raise: applyFloor never returns less than the claim or the floor', () => {
  const hi = RF.riskFloor({ ticketText: 'change billing' }), lo = RF.riskFloor({ ticketText: 'fix typo' });
  for (const c of ['STANDARD', 'ELEVATED', undefined, 'LOW', null, 42, '__proto__']) {
    assert.equal(RF.applyFloor(c, hi), 'ELEVATED');
    assert.equal(RF.applyFloor(c, lo), c === 'ELEVATED' ? 'ELEVATED' : 'STANDARD');
  }
});

test('AC4: the result is recorded (record_line names floor, classes, claim, final, input digest)', () => {
  const r = RF.check({ ticketText: SCRUM202, claimed: 'STANDARD' });
  assert.match(r.record_line, /^risk-floor: floor=ELEVATED; classes=[a-z,-]+; claimed=STANDARD; final=ELEVATED; input sha256:[0-9a-f]{64}$/);
  assert.ok(r.reasons.length > 0 && r.reasons.every((x) => x.class && x.source));
});

test('AC5: every keyword class floors on its own (ticket text and path)', () => {
  for (const [cls, words] of Object.entries(RF.CLASSES)) {
    for (const w of words) {
      assert.ok(RF.riskFloor({ ticketText: `touch ${w} handling` }).classes.includes(cls), `${cls}:${w} text`);
      assert.ok(RF.riskFloor({ paths: [`src/${w.replace(/ /g, '-')}/x.ts`] }).classes.includes(cls), `${cls}:${w} path`);
    }
  }
});

test('negative: a keyword in a comment-only change still floors (over-classify is allowed)', () => {
  const r = RF.check({ ticketText: 'Comment-only change: reword the comment above the payment retry', claimed: 'STANDARD' });
  assert.equal(r.final, 'ELEVATED');
});

test('adversarial: case, whitespace, unicode, separators, camelCase, path separators', () => {
  const hit = (o) => assert.equal(RF.riskFloor(o).floor, 'ELEVATED', JSON.stringify(o));
  hit({ ticketText: 'BILLING' });
  hit({ ticketText: 'multi \t\ntenant' });
  hit({ ticketText: 'Ｐａｙｍｅｎｔ' });          // fullwidth "Payment"
  hit({ ticketText: 'pay​ment' === 'x' ? '' : 'pri​cing' });         // zero-width inside the word
  hit({ ticketText: 'row-level_security' });
  hit({ ticketText: 'updateTenantId helper' });
  hit({ paths: ['src\\billing\\invoice.ts'] });
  hit({ paths: ['src/Auth/login.service.ts'] });
  hit({ paths: ['db/migrations/001_init.sql'] });
});

test('adversarial: keywords inside other words do not match (author, taxonomy, discharge)', () => {
  assert.equal(RF.riskFloor({ ticketText: 'author taxonomy discharge authority', paths: ['src/authors/list.ts'] }).floor, 'STANDARD');
});

test('fail closed: empty and oversized input floor to ELEVATED, very long benign text is handled', () => {
  assert.deepEqual(RF.riskFloor({ ticketText: '   ' }).classes, ['no-input']);
  assert.equal(RF.riskFloor({}).floor, 'ELEVATED');
  assert.deepEqual(RF.riskFloor({ ticketText: 'a'.repeat(RF.MAX_INPUT + 1) }).classes, ['input-too-large']);
  const t = Date.now();
  assert.equal(RF.riskFloor({ ticketText: 'word '.repeat(300_000) }).floor, 'STANDARD');
  assert.ok(Date.now() - t < 3000);
});

test('CLI: exit 2 and final ELEVATED when the claim is below the floor; exit 0 when it already meets it', () => {
  const run = (args, input) => spawnSync(process.execPath, [SCRIPT, 'check', ...args], { input, encoding: 'utf8' });
  const low = run(['--ticket', '-', '--claimed', 'STANDARD'], SCRUM202);
  assert.equal(low.status, 2);
  assert.equal(JSON.parse(low.stdout).final, 'ELEVATED');
  assert.equal(run(['--ticket', '-', '--claimed', 'ELEVATED'], SCRUM202).status, 0);
  assert.equal(run(['--ticket', '-', '--claimed', 'STANDARD'], 'fix typo in readme').status, 0);
  assert.equal(run(['--ticket', '-', '--paths', '["src/pricing/x.ts"]', '--claimed', 'STANDARD'], 'x').status, 2);
  assert.equal(run(['--ticket', '-'], SCRUM202).status, 2); // no claim at all is below the floor
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
});
