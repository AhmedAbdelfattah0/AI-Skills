// Tests for risk-floor.mjs (S-10 / ASTF-11). Assertions are on codes and shapes, not message text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RF from './risk-floor.mjs';

const SCRIPT = fileURLToPath(new URL('./risk-floor.mjs', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
const out = (r) => JSON.parse(r.stdout);
const T = 'update the thing'; // a meaningful, risk-free ticket body for tests that only vary paths
const floorOf = (o) => RF.riskFloor({ ticketText: T, ...o }).floor;
const SCRUM202 = 'Reports page: display each tenant\'s price list and subscription totals. Read-only, no writes.';
const tmpFile = (bytes) => { const f = join(mkdtempSync(join(tmpdir(), 'rf-')), 't.txt'); writeFileSync(f, bytes); return f; };

test('AC1: a SCRUM-202-shaped ticket is floored to ELEVATED with a debate, even when claimed STANDARD', () => {
  const r = RF.check({ ticketText: SCRUM202, claimed: 'STANDARD' });
  assert.equal(r.floor, 'ELEVATED'); assert.equal(r.final, 'ELEVATED'); assert.equal(r.debate.required, true);
  assert.ok(r.classes.includes('money') && r.classes.includes('tenancy'));
});

test('AC2: a typo-only ticket is not floored', () => {
  const r = RF.check({ ticketText: 'Fix typo in README: "teh" -> "the"', paths: ['README.md', 'docs/intro.md'], claimed: 'STANDARD' });
  assert.equal(r.floor, 'STANDARD'); assert.equal(r.final, 'STANDARD'); assert.equal(r.debate.required, false);
});

test('AC3: the floor can only raise; unknown claims resolve to ELEVATED', () => {
  const hi = RF.riskFloor({ ticketText: 'change billing' }), lo = RF.riskFloor({ ticketText: 'fix typo' });
  for (const c of ['STANDARD', 'ELEVATED', undefined, 'LOW', null, 42, '__proto__']) {
    assert.equal(RF.applyFloor(c, hi), 'ELEVATED');
    assert.equal(RF.applyFloor(c, lo), c === 'STANDARD' || c === undefined ? 'STANDARD' : 'ELEVATED');
  }
});

test('AC4: the record names floor, classes, claim, final, path count and digest, never raw paths or text', () => {
  const r = RF.check({ ticketText: SCRUM202, paths: ['src/secret-billing/x.ts'], claimed: 'STANDARD' });
  assert.match(r.record_line, /^risk-floor: floor=ELEVATED; classes=[a-z,-]+; claimed=STANDARD; final=ELEVATED; paths=1; input sha256:[0-9a-f]{64}$/);
  assert.ok(!r.record_line.includes('secret-billing') && !JSON.stringify(r.reasons).includes('secret-billing'));
});

test('M1: claim spellings are normalised; unknown claims never lower and exit non-zero', () => {
  for (const c of ['ELEVATED', 'elevated', 'Elevated', ' ELEVATED ']) { const r = RF.check({ ticketText: 'fix typo', claimed: c }); assert.equal(r.final, 'ELEVATED'); assert.equal(r.claimed, 'ELEVATED'); }
  for (const c of ['STANDARD', 'standard']) assert.equal(RF.check({ ticketText: 'fix typo', claimed: c }).final, 'STANDARD');
  for (const c of ['garbage', '', 'LOW', null, 42]) { const r = RF.check({ ticketText: 'fix typo', claimed: c }); assert.equal(r.final, 'ELEVATED'); assert.equal(r.error, 'bad_claim'); }
  for (const c of ['elevated', 'Elevated']) assert.equal(run(['check', '--ticket', '-', '--claimed', c], 'fix typo').status, 0);
  for (const c of ['garbage', '']) { const r = run(['check', '--ticket', '-', '--claimed', c], 'fix typo'); assert.equal(r.status, 1); assert.equal(out(r).final, 'ELEVATED'); }
  const rank = { STANDARD: 0, ELEVATED: 1 };
  for (const c of ['STANDARD', 'ELEVATED', 'x', undefined]) for (const t of ['typo', 'billing']) {
    const r = RF.check({ ticketText: t, claimed: c });
    assert.ok(rank[r.final] >= rank[r.floor] && rank[r.final] >= rank[RF.normClaim(c) ?? 'STANDARD'], `${c}/${t}`);
  }
});

test('malformed input fails closed (library): types, blanks, NUL, replacement char, null-like tickets, missing ticket', () => {
  const bad = [{ ticketText: T, paths: { a: 1 } }, { ticketText: T, paths: 'src/billing' }, { ticketText: T, paths: 5 }, { ticketText: 7 }, { ticketText: T, paths: [5] },
    { ticketText: T, paths: [null] }, { ticketText: T, paths: [''] }, { ticketText: '', paths: [''] }, { ticketText: ' ', paths: ['  '] }, { ticketText: {}, paths: [] },
    { ticketText: '' }, { paths: ['README.md'] }, { ticketText: null, paths: ['src/app/footer.ts'] }, { ticketText: 'null' }, { ticketText: ' undefined ' }, { ticketText: '​' },
    { ticketText: '---' }, { ticketText: 'fix typo�' }, { ticketText: 'fix\u0000typo' }, { ticketText: T, paths: ['src/lo\u0000gin.ts'] }, { ticketText: T, paths: ['src/�.ts'] }];
  for (const b of bad) { const r = RF.check({ claimed: 'STANDARD', ...b }); assert.equal(r.final, 'ELEVATED', JSON.stringify(b)); assert.ok(r.classes.includes('malformed_input'), JSON.stringify(b)); assert.equal(RF.exitCodeFor(r), 1); }
});

test('malformed input fails closed (CLI): bad paths JSON, undecodable bytes, UTF-16/32, NUL, missing --ticket, null-like stdin', () => {
  for (const p of ['{"paths":["src/billing/x.ts"]}', '"x"', 'null', '[1]', '[""]', '[bad']) {
    const r = run(['check', '--ticket', '-', '--paths', p, '--claimed', 'STANDARD'], 'typo fix'); assert.equal(r.status, 1, p); assert.equal(out(r).final, 'ELEVATED', p);
  }
  const bytes = {
    utf16le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('login', 'utf16le')]), utf16be: Buffer.from([0xfe, 0xff, 0, 0x6c]), utf16NoBom: Buffer.from('Change user roles', 'utf16le'),
    utf32: Buffer.from([0xff, 0xfe, 0, 0, 0x6c, 0, 0, 0]), invalid: Buffer.concat([Buffer.from('fix typo'), Buffer.from([0xff])]), nul: Buffer.from('fix\0typo'),
    cont: Buffer.from([0xc3, 0x28]) };
  for (const [k, b] of Object.entries(bytes)) {
    const viaFile = run(['check', '--ticket', tmpFile(b), '--claimed', 'STANDARD']); assert.equal(viaFile.status, 1, k); assert.equal(out(viaFile).final, 'ELEVATED', k);
    const viaPaths = run(['check', '--ticket', '-', '--paths', tmpFile(b), '--claimed', 'STANDARD'], 'fix typo'); assert.equal(viaPaths.status, 1, `${k} paths`);
  }
  assert.equal(run(['check', '--paths', '["README.md"]', '--claimed', 'STANDARD']).status, 1); // --ticket is required
  for (const p of ['["src/\\ud800/x.ts"]', '["\\udc00"]']) assert.equal(run(['check', '--ticket', '-', '--paths', p, '--claimed', 'STANDARD'], 'fix typo').status, 1, p); // JSON-escaped lone surrogate
  for (const t of ['', 'null', ' undefined\n', '​', '---']) assert.equal(run(['check', '--ticket', '-', '--paths', '["src/app/footer.component.ts"]', '--claimed', 'STANDARD'], t).status, 1, JSON.stringify(t));
  assert.equal(out(run(['check', '--ticket', '/nonexistent/x'])).final, 'ELEVATED');
  assert.equal(run(['check', '--ticket', tmpFile(Buffer.from('﻿fix typo')), '--claimed', 'STANDARD']).status, 0); // a UTF-8 BOM is fine
  const big = run(['check', '--ticket', '-', '--claimed', 'ELEVATED'], 'a '.repeat(1_100_000)); assert.equal(big.status, 1); assert.ok(out(big).classes.includes('malformed_input'));
});

// ---- INDEPENDENT ORACLE: a frozen, hand-written keyword list that does NOT come from the module. Deleting a catalog keyword
// turns the deletion test red; a form that regresses turns the forms test red. Extending the catalog needs a visible edit here.
const FROZEN = {
  money: ['price', 'pricing', 'bill', 'pay', 'paying', 'payment', 'payout', 'paypal', 'invoic', 'invoice', 'invoicing', 'refund', 'checkout', 'stripe', 'currenc', 'currency', 'subscri', 'subscription', 'discount', 'coupon',
    'tax', 'taxes', 'vat', 'fee', 'fees', 'money', 'charg', 'charge', 'charging', 'wallet', 'ledger', 'transaction', 'cart', 'order', 'orders', 'plan', 'plans', 'renewal'],
  tenancy: ['tenan', 'tenant', 'multi tenant', 'rls', 'row level security', 'org id', 'organization id', 'organisation id', 'workspace id', 'store id', 'shop id', 'merchant id', 'account id', 'team id', 'idor', 'ownership'],
  auth: ['auth', 'login', 'logout', 'log in', 'logged in', 'sign', 'sign in', 'signin', 'sign up', 'signup', 'session', 'jwt', 'oauth', 'oidc', 'saml', 'sso', 'password', 'permission', 'role', 'rbac', 'acl',
    'admin', 'staff', 'secret', 'credential', 'api key', 'access token', 'refresh token', 'recovery token', 'csrf token', 'bearer', 'cookie', 'mfa', '2fa', 'two factor', 'otp', 'cors', 'csrf', 'suspen'],
  'public-contract': ['public api', 'api', 'api contract', 'openapi', 'swagger', 'webhook', 'graphql', 'grpc', 'endpoint', 'route', 'breaking change', 'event schema', 'event', 'events'],
  'data-shape': ['migrat', 'migration', 'schema', 'alembic', 'drizzle', 'prisma', 'flyway', 'liquibase', 'sql', 'env', 'changelog xml'],
  shared: ['shared', 'design system']
};
const sq = (k) => k.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const SEEN = new Set(['invoice', 'currency', 'subscription', 'tenant', 'charge', 'charging', 'migration', 'invoicing']); // frozen examples that need not be catalog entries (a stem covers them)

test('oracle: every frozen keyword is still covered by the module catalog (deletion detection)', () => {
  for (const [cls, ks] of Object.entries(FROZEN)) {
    const have = RF.CLASSES[cls].map(sq);
    for (const k of ks) assert.ok(have.some((h) => h === sq(k) || (SEEN.has(k) && sq(k).includes(h))), `catalog lost ${cls}:${k}`);
  }
});

function forms(k) {
  const w = k.split(/\s+/), s = sq(k), U = s.toUpperCase(), camel = w.map(cap).join(''), lowerCamel = w[0] + w.slice(1).map(cap).join('');
  const f = [k, k.toUpperCase(), w.map(cap).join(' '), `${lowerCamel}Rate`, `${lowerCamel}Client`, `get${camel}Rate`, `x${camel}Y`, w.join('_'), w.join('-'), `${U}Rate`, `${U}Id`,
    `${s}2`, `v1${s}`, `${cap(s)}2`, `${U}2`, `V1${U}`, `src/${w.join('-')}/x.ts`, `src\\${s}\\x.ts`, `src/Xyz${camel}Client.ts`, `${lowerCamel}.service.ts`];
  if (!/\d/.test(s)) f.push(s.split('').join('.'), s.split('').join('-'), s.split('').join('_'), s.split('').join(':'));
  return f;
}
test('oracle: every frozen keyword floors ELEVATED (right class) in lower/UPPER/Cap/lowerCamel/camel/snake/kebab/dotted/digit/path forms', () => {
  const T0 = 'update the thing';
  for (const [cls, ks] of Object.entries(FROZEN)) for (const k of ks) for (const v of forms(k)) {
    assert.ok(RF.riskFloor({ ticketText: v }).classes.includes(cls), `text ${cls}:${k} -> ${JSON.stringify(v)}`);
    assert.ok(RF.riskFloor({ ticketText: T0, paths: [v] }).classes.includes(cls), `path ${cls}:${k} -> ${JSON.stringify(v)}`);
  }
});

test('regression: named counterexamples from the reviews', () => {
  const texts = ['taxRate', 'vatAmount', 'apiClient', 'jwtVerify', 'otpCode', 'rlsPolicy', 'getTaxRate', 'api2', 'v1api', 'Api2', 'Api2Client', 'sha256jwt', 'p.a.y', 'j-w-t', 's_q_l', 'a:p:i', 'Fix invoicing totals',
    'Stop double charging customers', 'Fix paying flow', 'Change plan limits', 'Rename payload; events', 'GraphQL', 'gRPC', '2Fa', '2FA', 'OTPId', 'ACLId', 'customerVATId', 'SQLDb', 'V1API', 'v2API', 'HS256JWT', 'Base64JWT', 'v1SSO', 'v2RBAC', 'x509SAML', 'S3ACL', 'JWTId', 'RBACId',
    'SSOId', 'RLSId', 'OIDCClient', 'JWTService', 'RLSPolicies', 'APIs', 'public APIs', 'Only authorized users', 'authorisation', 'unauthorized', 'Rotate API keys', 'taxes', 'VAT totals',
    'organisation id', 'Migrate OAuth2 client', 'auth0', 'storeId', 'store_id', 'tenantId', 'cart total', 'row level security', 'access tokens', 'Hash stored OTPs', 'two-factor', 'sign in', 'logged in'];
  for (const t of texts) assert.equal(RF.riskFloor({ ticketText: t }).floor, 'ELEVATED', t);
  for (const p of ['src/events/order-created.ts', 'db/changelog.xml', 'src/services/apiClient.ts', 'src/lib/jwtVerify.ts', 'src/clients/v2api.ts', 'src/p.a.y.ts', 'src/GraphQLClient.ts', 'src/gRPCClient.ts', 'src/OTPId.ts', 'src/2FA.ts', 'src/clients/v2API.ts', 'src/shared/ui/Button.tsx', 'alembic/versions/3f2a_add_column.py', 'drizzle/0001_x.sql',
    'prisma/schema.prisma', 'src/paymentservice.ts', 'src/authmiddleware.ts', '.env', 'apps/api/src/services/cart-validation.service.ts', 'src/páyment.ts', 'src\\billing\\invoice.ts', 'db/migrations/001_init.sql'])
    assert.equal(floorOf({ paths: [p] }), 'ELEVATED', p);
  for (const t of ['BILLING', 'multi \t\ntenant', 'Ｐａｙｍｅｎｔ', 'pri​cing', 'p‮ayment', 'row-level_security', 'updateTenantId helper']) assert.equal(RF.riskFloor({ ticketText: t }).floor, 'ELEVATED', t);
});

const CORPUS_RISKY = [
  ['Cart price reconciliation — flag lines whose price changed since add-to-cart', ['apps/api/src/services/cart-validation.service.ts', 'apps/storefront/src/app/features/cart/cart.component.ts']],
  ['Security F23: Cart recovery emails put the recovery token on an unverified custom domain', ['apps/api/src/emails/cart-recovery.ts']],
  ['Subscription renewal fails to retry after a declined card', ['apps/api/src/billing/renewal.job.ts']],
  ['Staff permissions: managers can edit roles of other staff', ['apps/api/src/staff/staff.controller.ts']],
  ['Store suspension should block storefront traffic for the store', ['apps/api/src/stores/suspend.ts']],
  ['Accounts: add login rate limit', ['apps/api/src/accounts/login.ts']], ['Apply coupon codes at checkout', ['apps/storefront/src/app/checkout/coupon.ts']],
  ['Add column to orders table', ['db/migrations/20260101_add_col.sql']], ['Refactor Button component used across the app', ['libs/shared/ui/button.tsx']],
  ['Expose GET /v2/products to partners', ['apps/api/openapi.yaml']], ['Rotate the signing secret for outbound webhooks', ['apps/api/src/webhooks/sign.ts']],
  ['Show VAT breakdown in the order summary', ['apps/storefront/src/order-summary.ts']], ['Fix IDOR on order lookup', ['apps/api/src/orders/get.ts']],
  ['Reports page: show each organisation\'s plans, fees and VAT totals. Read-only.', ['apps/web/reports.ts']]];
const CORPUS_BENIGN = ['Fix typo in README', 'Comment-only wording cleanup in the helper', 'Change button color token to blue-500', 'Bump prettier config line width',
  'Rename internal variable for clarity', 'Update changelog heading', 'Add unit test for date formatter', 'Fix alignment of footer links'];
test('corpus: realistic risky tickets all floor ELEVATED; benign ones may stay STANDARD', () => {
  for (const [t, p] of CORPUS_RISKY) assert.equal(RF.riskFloor({ ticketText: t, paths: p }).floor, 'ELEVATED', t);
  for (const t of CORPUS_BENIGN) assert.equal(RF.riskFloor({ ticketText: t, paths: ['README.md'] }).floor, 'STANDARD', t);
});

test('documented over-classification: author/discharge-style substrings floor; the floor never claims the opposite', () => {
  assert.equal(RF.riskFloor({ ticketText: 'author name capitalisation' }).floor, 'ELEVATED');
});

test('fail closed on size; very long benign and all-uppercase text stay fast', () => {
  assert.deepEqual(RF.riskFloor({ ticketText: 'a'.repeat(RF.MAX_INPUT + 1) }).classes, ['malformed_input']);
  assert.deepEqual(RF.riskFloor({ ticketText: 'a', paths: ['b'.repeat(RF.MAX_INPUT)] }).classes, ['malformed_input']); // total, not per string
  assert.equal(run(['check', '--ticket', tmpFile(Buffer.alloc(RF.MAX_INPUT + 1, 97)), '--claimed', 'ELEVATED']).status, 1); // bounded file read
  for (const text of ['word '.repeat(300_000), 'ABCDEFGHIJ'.repeat(150_000)]) { const t = Date.now(); RF.riskFloor({ ticketText: text }); assert.ok(Date.now() - t < 4000); }
});

test('CLI exit codes: 2 below the floor, 0 when met, 1 on usage errors; strict flag parsing', () => {
  const c = (args, input) => run(['check', ...args], input);
  const low = c(['--ticket', '-', '--claimed', 'STANDARD'], SCRUM202); assert.equal(low.status, 2); assert.equal(out(low).final, 'ELEVATED');
  assert.equal(c(['--ticket', '-', '--claimed', 'ELEVATED'], SCRUM202).status, 0);
  assert.equal(c(['--ticket', '-', '--claimed', 'STANDARD'], 'fix typo in readme').status, 0);
  assert.equal(c(['--ticket', '-', '--paths', '["src/pricing/x.ts"]', '--claimed', 'STANDARD'], 'x y').status, 2);
  assert.equal(c(['--ticket', '-'], SCRUM202).status, 2);
  assert.equal(run([]).status, 1);
  assert.equal(c(['--ticket', '-', '--claimed=ELEVATED'], 'fix typo').status, 0);
  assert.equal(c(['--ticket=-', '--claimed=standard'], 'fix typo').status, 0);
  const bads = [['--ticket', '-', '--paths'], ['--ticket', '-', '--claimed'], ['--ticket'], ['--ticket', '-', '--claimd', 'ELEVATED'], ['--ticket', '-', '--claimed', 'ELEVATED', '--claimed', 'STANDARD'],
    ['--ticket', '-', '--ticket', '-'], ['--ticket', '-', 'extra'], ['--ticket', '-', '--paths', '--claimed', 'STANDARD'], ['--ticket', '-', '--claimed=']];
  for (const a of bads) { const r = c(a, 'fix typo'); assert.equal(r.status, 1, a.join(' ')); assert.equal(out(r).final, 'ELEVATED', a.join(' ')); }
  for (const a of [['--ticket', '-', '--claimed', '--paths=[]'], ['--ticket', '-', '--paths', '--claimed=ELEVATED']]) assert.equal(out(c(a, 'fix typo')).error, 'bad_input', a.join(' '));
  assert.equal(run(['verify', '--plan', 'x']).status, 1); // verify is not part of this slice
});

test('docs: no file limits the plan debate to money/auth; skip only below the floor; honesty wording; no verify mention', () => {
  const root = new URL('../', import.meta.url);
  const files = ['SKILL.md', ...readdirSync(new URL('references/', root)).map((f) => `references/${f}`)];
  for (const f of files) {
    const t = readFileSync(new URL(f, root), 'utf8');
    assert.doesNotMatch(t, /debate runs only for money or auth|cross-model plan debate\s+only for money or auth|Skip it, and record the skip, for UI|only a ticket below the floor may record|only below the floor\./i, f);
    assert.doesNotMatch(t, /risk-floor\.mjs verify|verify --plan/, f);
  }
  const ref = (f) => readFileSync(new URL(f, root), 'utf8');
  assert.match(ref('references/cross-model.md'), /risk floor/i);
  assert.match(ref('SKILL.md'), /risk floor is ELEVATED/i);
  assert.match(ref('SKILL.md'), /neither money nor auth/i);
  for (const f of ['SKILL.md', 'references/plan.md']) assert.match(ref(f), /best-effort lexical floor/i);
  assert.match(ref('SKILL.md'), /advisory, not enforced/i);
  assert.doesNotMatch(ref('SKILL.md') + ref('scripts/risk-floor.mjs'), /never under-classify|is final: it forces/);
});
