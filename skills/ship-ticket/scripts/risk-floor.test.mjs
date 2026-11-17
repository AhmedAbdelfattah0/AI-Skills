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
  hit({ ticketText: 'pri\u200Bcing' });         // zero-width inside the word
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
  assert.deepEqual(RF.riskFloor({ ticketText: '   ' }).classes, ['malformed_input']);
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

test('docs: no file still limits the plan debate to money/auth tickets; honesty wording present; no verify mention', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const files = ['SKILL.md', ...readdirSync(new URL('references/', root)).map((f) => `references/${f}`)];
  for (const f of files) {
    const t = readFileSync(new URL(f, root), 'utf8');
    assert.doesNotMatch(t, /debate runs only for money or auth|cross-model plan debate\s+only for money or auth|Skip it, and record the skip, for UI/i, f);
    assert.doesNotMatch(t, /risk-floor\.mjs verify/, f);
  }
  const ref = (f) => readFileSync(new URL(f, root), 'utf8');
  assert.match(ref('references/cross-model.md'), /risk floor/i);
  assert.match(ref('SKILL.md'), /risk floor is ELEVATED/i);
  for (const f of ['SKILL.md', 'references/plan.md']) assert.match(ref(f), /best-effort lexical floor/i);
  assert.match(ref('SKILL.md'), /advisory, not enforced/i);
  assert.doesNotMatch(ref('SKILL.md') + ref('scripts/risk-floor.mjs'), /never under-classify|is final: it forces/);
});

test('CLI parsing is strict and fails closed (exit 1, final ELEVATED): missing values, unknown/duplicate flags, positionals', () => {
  assert.equal(run(['check', '--ticket', '-', '--claimed=ELEVATED'], 'fix typo').status, 0);
  assert.equal(run(['check', '--ticket=-', '--claimed=standard'], 'fix typo').status, 0);
  const bads = [['--ticket', '-', '--paths'], ['--ticket', '-', '--claimed'], ['--ticket'], ['--ticket', '-', '--claimd', 'ELEVATED'],
    ['--ticket', '-', '--claimed', 'ELEVATED', '--claimed', 'STANDARD'], ['--ticket', '-', '--ticket', '-'], ['--ticket', '-', 'extra'],
    ['--ticket', '-', '--paths', '--claimed', 'STANDARD'], ['--ticket', '-', '--claimed=']];
  for (const a of bads) { const r = run(['check', ...a], 'fix typo'); assert.equal(r.status, 1, a.join(' ')); assert.equal(out(r).final, 'ELEVATED', a.join(' ')); }
  for (const a of [['--ticket', '-', '--claimed', '--paths=[]'], ['--ticket', '-', '--paths', '--claimed=ELEVATED']]) assert.equal(out(run(['check', ...a], 'fix typo')).error, 'bad_input', a.join(' ')); // a flag is never a value
  assert.equal(run(['verify', '--plan', 'x']).status, 1); // verify is not part of this slice
});

test('meaningful content after normalisation: empty-normalising input is malformed, exit 1 even when claimed ELEVATED', () => {
  for (const t of ['​', '---', '   ', '...!!!', '​​']) {
    const r = run(['check', '--ticket', '-', '--claimed', 'ELEVATED'], t);
    assert.equal(r.status, 1, JSON.stringify(t)); assert.equal(out(r).final, 'ELEVATED'); assert.ok(out(r).classes.includes('malformed_input'));
  }
  assert.equal(run(['check', '--ticket', '-', '--paths', '["---"]', '--claimed', 'ELEVATED'], '').status, 1);
  assert.equal(run(['check', '--ticket', '-', '--paths', '["src/pricing/x.ts"]', '--claimed', 'ELEVATED'], '').status, 0); // paths alone are evaluated
  assert.equal(run(['check', '--ticket', '-', '--paths', 'null', '--claimed', 'ELEVATED'], 'x').status, 1);
  const big = run(['check', '--ticket', '-', '--claimed', 'ELEVATED'], 'a '.repeat(1_100_000));
  assert.equal(big.status, 1); assert.ok(out(big).classes.includes('input-too-large'));
});

test('normalisation holes: digit+acronym and acronym+short word stay matchable', () => {
  for (const t of ['2FA', 'JWTId', 'RBACId', 'SSOId', 'RLSId', 'OIDCClient', 'enable 2FA for staff']) assert.equal(RF.riskFloor({ ticketText: t }).floor, 'ELEVATED', t);
  for (const p of ['src/2FA.ts', 'src/JWTId.ts', 'src/RBACId.ts']) assert.equal(RF.riskFloor({ paths: [p] }).floor, 'ELEVATED', p);
});

// One sample per keyword fragment: removing any keyword or stem turns this red (the fragment list must equal the sample list).
const SAMPLES = {
  money: { 'prices?': 'price', pricing: 'pricing', 'bill\\w*': 'billed', 'pay(?:ments?|outs?|ing|pal)?': 'pay', 'invoic\\w*': 'invoicing', 'refund\\w*': 'refunded', 'check ?out': 'checkout',
    stripe: 'stripe', 'currenc\\w*': 'currencies', 'subscri\\w*': 'subscription', 'discount\\w*': 'discounts', 'coupons?': 'coupon', 'tax(?:es)?': 'taxes', vat: 'VAT', 'fees?': 'fee',
    money: 'money', 'charg\\w*': 'charged', 'wallets?': 'wallet', 'ledgers?': 'ledger', 'transactions?': 'transaction', 'carts?': 'cart', 'cart totals?': 'cart total', 'orders?': 'order',
    'plans?': 'plan', 'renewals?': 'renewal' },
  tenancy: { 'tenan\\w*': 'tenancy', 'multi ?tenan\\w*': 'multitenant', rls: 'RLS', 'row level security': 'row level security',
    '(?:org|organi[sz]ation|workspace|store|shop|merchant|account|team) ids?': 'merchantId', idor: 'IDOR', ownership: 'ownership' },
  auth: { auth: 'auth', authn: 'authn', authz: 'authz', 'authenticat\\w*': 'authenticated', '(?:un)?authori[sz]\\w*': 'unauthorised', 'log ?(?:in|ins|out|ged)': 'logout', 'sign ?(?:in|up|ed)?': 'signup',
    'sessions?': 'session', 'jwts?': 'jwt', oauth: 'oauth', oidc: 'oidc', saml: 'saml', sso: 'sso', 'passwords?': 'password', 'permissions?': 'permission', 'roles?': 'role', rbac: 'rbac',
    'acls?': 'acl', 'admin\\w*': 'administrator', staff: 'staff', 'secrets?': 'secret', 'credentials?': 'credential', 'api ?keys?': 'API key',
    '(?:access|refresh|recovery|csrf|bearer|auth|api|session|reset|jwt|id|verification) tokens?': 'reset token', bearer: 'bearer', 'cookies?': 'cookie', mfa: 'mfa', '2fa': '2fa', otp: 'otp', cors: 'cors', csrf: 'csrf', 'suspen\\w*': 'suspended' },
  'public-contract': { 'public apis?': 'public API', 'apis?': 'api', openapi: 'openapi', swagger: 'swagger', 'webhooks?': 'webhook', graphql: 'graphql', grpc: 'grpc', 'routes?': 'route',
    'endpoints?': 'endpoint', 'breaking changes?': 'breaking change', 'event schemas?': 'event schema', 'events?': 'event', 'api contracts?': 'api contract' },
  'data-shape': { 'migrat\\w*': 'migration', 'schemas?': 'schema', alembic: 'alembic', drizzle: 'drizzle', prisma: 'prisma', flyway: 'flyway', liquibase: 'liquibase', sql: 'sql', 'changelog xml': 'changelog.xml', env: '.env' },
  shared: { shared: 'shared', 'shared (?:components?|contracts?|librar(?:y|ies)|modules?)': 'shared library', 'design systems?': 'design system' }
};
const STEM_SAMPLES = { payment: 'paymentservice', billing: 'billingjob', invoice: 'invoiceexport', checkout: 'checkoutflow', subscription: 'subscriptionrepo', stripe: 'stripeclient',
  tenant: 'tenantscope', password: 'passwordreset', credential: 'credentialstore', authoriz: 'authorizer', authentic: 'authenticator', oauth: 'oauthclient', apikey: 'apikeystore',
  authmiddleware: 'authmiddleware', nextauth: 'nextauth', webhook: 'webhookrelay', openapi: 'openapispec', migration: 'migrationrunner' };

test('every keyword fragment and stem has its own passing sample (removing any one turns this red)', () => {
  assert.deepEqual(Object.keys(RF.CLASSES).sort(), Object.keys(SAMPLES).sort());
  const stems = [];
  for (const [cls, { words, stems: st }] of Object.entries(RF.CLASSES)) {
    assert.deepEqual([...words].sort(), Object.keys(SAMPLES[cls]).sort(), `${cls} words`);
    for (const [frag, sample] of Object.entries(SAMPLES[cls])) {
      assert.ok(RF.riskFloor({ ticketText: `touch the ${sample} handling` }).classes.includes(cls), `${cls}:${frag}`);
      assert.ok(RF.riskFloor({ paths: [`src/${sample.replace(/ /g, '-')}/x.ts`] }).classes.includes(cls), `${cls}:${frag} path`);
    }
    stems.push(...st);
  }
  assert.deepEqual([...stems].sort(), Object.keys(STEM_SAMPLES).sort());
  for (const [stem, sample] of Object.entries(STEM_SAMPLES)) assert.equal(RF.riskFloor({ paths: [`src/${sample}.ts`] }).floor, 'ELEVATED', stem);
});
