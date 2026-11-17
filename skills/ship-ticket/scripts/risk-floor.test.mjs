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
    assert.equal(RF.applyFloor(c, lo), c === 'STANDARD' || c === undefined ? 'STANDARD' : 'ELEVATED'); // unknown claims never lower
  }
});

test('AC4: the result is recorded (record_line names floor, classes, claim, final, input digest)', () => {
  const r = RF.check({ ticketText: SCRUM202, claimed: 'STANDARD' });
  assert.match(r.record_line, /^risk-floor: floor=ELEVATED; classes=[a-z,-]+; claimed=STANDARD; final=ELEVATED; input sha256:[0-9a-f]{64}$/);
  assert.ok(r.reasons.length > 0 && r.reasons.every((x) => x.class && x.source));
});

test('AC5: each class floors on a text sample and a path sample', () => {
  const samples = { money: 'pricing', tenancy: 'tenant', auth: 'password', 'public-contract': 'webhook', 'data-shape': 'migration', shared: 'shared component' };
  for (const [cls, w] of Object.entries(samples)) {
    assert.ok(RF.riskFloor({ ticketText: `touch ${w} handling` }).classes.includes(cls), `${cls} text`);
    assert.ok(RF.riskFloor({ paths: [`src/${w.replace(/ /g, '-')}/x.ts`] }).classes.includes(cls), `${cls} path`);
  }
  assert.deepEqual(Object.keys(RF.CLASSES).sort(), Object.keys(samples).sort()); // a new class needs a sample here
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

// ---- repair batch ----
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
const out = (r) => JSON.parse(r.stdout);

test('M1: claim spellings are normalised; unknown claims never lower and exit non-zero', () => {
  for (const c of ['ELEVATED', 'elevated', 'Elevated', ' ELEVATED ']) {
    const r = RF.check({ ticketText: 'fix typo', claimed: c });
    assert.equal(r.final, 'ELEVATED', c); assert.equal(r.claimed, 'ELEVATED');
  }
  for (const c of ['STANDARD', 'standard']) assert.equal(RF.check({ ticketText: 'fix typo', claimed: c }).final, 'STANDARD');
  for (const c of ['garbage', '', 'LOW', null, 42]) {
    const r = RF.check({ ticketText: 'fix typo', claimed: c });
    assert.equal(r.final, 'ELEVATED', String(c)); assert.equal(r.error, 'bad_claim');
  }
  for (const c of ['elevated', 'Elevated']) assert.equal(run(['check', '--ticket', '-', '--claimed', c], 'fix typo').status, 0);
  for (const c of ['garbage', '']) { const r = run(['check', '--ticket', '-', '--claimed', c], 'fix typo'); assert.equal(r.status, 1); assert.equal(out(r).final, 'ELEVATED'); }
  // sibling: final is never below the claim or the floor for any claim/ticket pair
  for (const c of ['STANDARD', 'ELEVATED', 'x', undefined]) for (const t of ['typo', 'billing']) {
    const r = RF.check({ ticketText: t, claimed: c });
    assert.ok(r.final === 'ELEVATED' || (r.floor === 'STANDARD' && !r.error));
  }
});

test('M3: malformed input fails closed with malformed_input (library and CLI siblings)', () => {
  const bad = [{ paths: { a: 1 } }, { paths: 'src/billing' }, { paths: 5 }, { paths: null, ticketText: 7 }, { ticketText: 'typo', paths: [5] },
    { ticketText: 'typo', paths: [null] }, { ticketText: 'typo', paths: [''] }, { ticketText: '', paths: [''] }, { ticketText: ' ', paths: ['  '] }, { ticketText: {}, paths: [] }];
  for (const b of bad) { const r = RF.check({ claimed: 'STANDARD', ...b }); assert.equal(r.final, 'ELEVATED', JSON.stringify(b)); assert.ok(r.classes.includes('malformed_input'), JSON.stringify(b)); }
  for (const p of ['{"paths":["src/billing/x.ts"]}', '"x"', 'null', '[1]', '[""]', '[bad']) {
    const r = run(['check', '--ticket', '-', '--paths', p.startsWith('[') ? p : p, '--claimed', 'STANDARD'], 'typo fix');
    assert.notEqual(r.status, 0, p); assert.equal(out(r).final, 'ELEVATED', p);
  }
  assert.notEqual(run(['check', '--ticket', '/nonexistent/x', '--claimed', 'STANDARD']).status, 0);
  assert.equal(out(run(['check', '--ticket', '/nonexistent/x'])).final, 'ELEVATED');
});

test('M2: stems, inflections, acronym camelCase, digits, concatenations, path surfaces floor ELEVATED', () => {
  const texts = ['Only authorized users', 'authorised', 'authorisation', 'unauthorized', 'authenticated', 'Rotate API keys', 'public APIs', 'taxes', 'VAT totals',
    'organisation id', 'Migrate OAuth2 client', 'auth0', 'JWTService', 'RLSPolicies', 'storeId', 'store_id', 'tenantId', 'fees', 'discounts', 'coupons',
    'refunded', 'payouts', 'invoicing', 'checkout', 'cart total', 'webhooks', 'access tokens', 'credentials', 'passwords', 'row level security', 'CORS', 'CSRF', 'shared contracts',
    'mfa', 'roles', 'admin', 'sign in', 'logged in', 'event schemas', 'design systems'];
  for (const t of texts) assert.equal(RF.riskFloor({ ticketText: t }).floor, 'ELEVATED', t);
  const paths = ['src/shared/ui/Button.tsx', 'alembic/versions/3f2a_add_column.py', 'drizzle/0001_x.sql', 'prisma/schema.prisma', 'src/paymentservice.ts', 'src/authmiddleware.ts',
    'db/changelog.xml', '.env', 'apps/api/src/services/cart-validation.service.ts', 'src/páyment.ts'];
  for (const p of paths) assert.equal(RF.riskFloor({ paths: [p] }).floor, 'ELEVATED', p);
  assert.equal(RF.riskFloor({ ticketText: 'p‮ayment' }).floor, 'ELEVATED'); // bidi control inside a word
});

const CORPUS_RISKY = [
  ['Cart price reconciliation — flag lines whose price changed since add-to-cart', ['apps/api/src/services/cart-validation.service.ts', 'apps/storefront/src/app/features/cart/cart.component.ts']],
  ['Security F23: Cart recovery emails put the recovery token on an unverified custom domain', ['apps/api/src/emails/cart-recovery.ts']],
  ['Subscription renewal fails to retry after a declined card', ['apps/api/src/billing/renewal.job.ts']],
  ['Staff permissions: managers can edit roles of other staff', ['apps/api/src/staff/staff.controller.ts']],
  ['Store suspension should block storefront traffic for the store', ['apps/api/src/stores/suspend.ts']],
  ['Accounts: add login rate limit', ['apps/api/src/accounts/login.ts']],
  ['Apply coupon codes at checkout', ['apps/storefront/src/app/checkout/coupon.ts']],
  ['Add column to orders table', ['db/migrations/20260101_add_col.sql']],
  ['Export customers CSV for a store', ['apps/api/src/export.ts']],
  ['Refactor Button component used across the app', ['libs/shared/ui/button.tsx']],
  ['Expose GET /v2/products to partners', ['apps/api/openapi.yaml']],
  ['Rotate the signing secret for outbound webhooks', ['apps/api/src/webhooks/sign.ts']],
  ['Show VAT breakdown in the order summary', ['apps/storefront/src/order-summary.ts']],
  ['Fix IDOR on order lookup', ['apps/api/src/orders/get.ts']]];
const CORPUS_BENIGN = ['Fix typo in README', 'Comment-only wording cleanup in the helper', 'Change button color token to blue-500', 'Bump prettier config line width',
  'Rename internal variable for clarity', 'Update changelog heading', 'Add unit test for date formatter', 'Fix alignment of footer links'];

test('corpus: realistic risky tickets all floor ELEVATED; benign ones may stay STANDARD', () => {
  for (const [t, p] of CORPUS_RISKY) assert.equal(RF.riskFloor({ ticketText: t, paths: p }).floor, 'ELEVATED', t);
  for (const t of CORPUS_BENIGN) assert.equal(RF.riskFloor({ ticketText: t, paths: ['README.md'] }).floor, 'STANDARD', t);
});

const PLAN = (o = {}) => `---\nrun_id: x\nplan_debate: {max_calls: 3, total_timeout: 20m, status: ${o.status ?? 'CONVERGED'}}\nreview_profile: ${o.profile ?? 'ELEVATED'}\nrisk_floor: ${o.rec ?? 'risk-floor: floor=ELEVATED; classes=money; claimed=STANDARD; final=ELEVATED; input sha256:' + 'a'.repeat(64)}\n---\nbody\n`;
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const verify = (text) => { const f = join(mkdtempSync(join(tmpdir(), 'rf-')), 'plan.md'); writeFileSync(f, text); return run(['verify', '--plan', f]); };

test('M4: verify fails on missing/inconsistent record, skipped debate, low profile; passes a consistent plan', () => {
  assert.equal(verify(PLAN()).status, 0);
  const code = (t) => { const r = verify(t); assert.equal(r.status, 1); return out(r).errors; };
  assert.ok(code(PLAN({ rec: '<the record>' })).includes('no_record'));
  assert.ok(code(PLAN({ rec: 'risk-floor: floor=ELEVATED; classes=money; claimed=STANDARD; final=STANDARD; input sha256:' + 'a'.repeat(64) })).includes('final_below_floor'));
  assert.ok(code(PLAN({ status: 'SKIPPED' })).includes('debate_skipped'));
  assert.ok(code(PLAN({ profile: 'STANDARD' })).includes('profile_below_floor'));
  assert.ok(code(PLAN().replace(/plan_debate:.*\n/, '')).includes('debate_missing'));
  assert.ok(code(PLAN().replace(/review_profile:.*\n/, '')).includes('profile_below_floor'));
  assert.ok(code('no header at all').includes('no_record'));
  assert.equal(verify(PLAN({ status: 'SKIPPED', profile: 'STANDARD', rec: 'risk-floor: floor=STANDARD; classes=none; claimed=STANDARD; final=STANDARD; input sha256:' + 'b'.repeat(64) })).status, 0);
  assert.equal(run(['verify', '--plan', '/nonexistent']).status, 1);
});

test('docs: no reference still limits the plan debate to money/auth tickets; honesty wording present', async () => {
  const { readFileSync } = await import('node:fs');
  const ref = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(ref('references/cross-model.md'), /debate runs only for money or auth/);
  assert.match(ref('references/cross-model.md'), /risk floor/i);
  for (const f of ['SKILL.md', 'references/plan.md']) assert.match(ref(f), /best-effort lexical floor/i);
  assert.match(ref('SKILL.md'), /advisory, not enforced/i);
  assert.doesNotMatch(ref('SKILL.md') + ref('scripts/risk-floor.mjs'), /never under-classify|is final: it forces/);
});
