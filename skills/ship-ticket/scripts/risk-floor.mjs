#!/usr/bin/env node
/**
 * Best-effort LEXICAL risk floor (ASTF-11, S-10). Ticket text and planned paths in; a floor out. It raises, never lowers:
 * `applyFloor` returns the higher of the claimed profile and the floor. A match is evidence of risk; the ABSENCE of a match
 * is NOT evidence of low risk (a lexical list cannot know every wording). Matching may over-classify; the keyword list is
 * amendable by the owner. Unusable input (empty, oversized, malformed, unknown claim) fails closed to ELEVATED.
 *
 *   risk-floor.mjs check --ticket <file|-> [--paths <file|json array of strings>] [--claimed STANDARD|ELEVATED, any case]
 * Flags take `--flag value` or `--flag=value`; a missing value, an unknown flag, a repeated flag or a positional argument is an error.
 * Exit codes: 0 = the claim already meets the floor; 2 = the claim was below the floor (use `final`, run the debate);
 * 1 = unusable input (empty after normalisation, malformed, oversized), unknown claim or usage error. The output of an exit-1 run
 * still carries final=ELEVATED, never a lower profile, and exit 1 holds even when the claim is ELEVATED.
 * ADVISORY, NOT ENFORCED: no script reads the plan's recorded line. Checking the plan record is deferred to the S-23/S-24 wiring.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT = 2_000_000;
// Class -> { words: regex fragments matched on whole tokens of the normalised text; stems: substrings matched inside tokens
// (concatenated identifiers such as paymentservice.ts). Stems are only long, unambiguous roots; over-matching is accepted.
export const CLASSES = {
  money: { words: ['prices?', 'pricing', 'bill\\w*', 'pay(?:ments?|outs?|ing|pal)?', 'invoic\\w*', 'refund\\w*', 'check ?out', 'stripe', 'currenc\\w*', 'subscri\\w*',
    'discount\\w*', 'coupons?', 'tax(?:es)?', 'vat', 'fees?', 'money', 'charg\\w*', 'wallets?', 'ledgers?', 'transactions?', 'carts?', 'cart totals?', 'orders?', 'plans?', 'renewals?'],
    stems: ['payment', 'billing', 'invoice', 'checkout', 'subscription', 'stripe'] },
  tenancy: { words: ['tenan\\w*', 'multi ?tenan\\w*', 'rls', 'row level security', '(?:org|organi[sz]ation|workspace|store|shop|merchant|account|team) ids?', 'idor', 'ownership'],
    stems: ['tenant'] },
  auth: { words: ['auth', 'authn', 'authz', 'authenticat\\w*', '(?:un)?authori[sz]\\w*', 'log ?(?:in|ins|out|ged)', 'sign ?(?:in|up|ed)?', 'sessions?', 'jwts?', 'oauth', 'oidc', 'saml', 'sso',
    'passwords?', 'permissions?', 'roles?', 'rbac', 'acls?', 'admin\\w*', 'staff', 'secrets?', 'credentials?', 'api ?keys?', '(?:access|refresh|recovery|csrf|bearer|auth|api|session|reset|jwt|id|verification) tokens?', 'bearer', 'cookies?',
    'mfa', '2fa', 'otp', 'cors', 'csrf', 'suspen\\w*'],
    stems: ['password', 'credential', 'authoriz', 'authentic', 'oauth', 'apikey', 'authmiddleware', 'nextauth'] },
  'public-contract': { words: ['public apis?', 'apis?', 'openapi', 'swagger', 'webhooks?', 'graphql', 'grpc', 'routes?', 'endpoints?', 'breaking changes?', 'event schemas?', 'events?', 'api contracts?'],
    stems: ['webhook', 'openapi'] },
  'data-shape': { words: ['migrat\\w*', 'schemas?', 'alembic', 'drizzle', 'prisma', 'flyway', 'liquibase', 'sql', 'changelog xml', 'env'], stems: ['migration'] },
  shared: { words: ['shared', 'shared (?:components?|contracts?|librar(?:y|ies)|modules?)', 'design systems?'], stems: [] }
};

// Lowercase, fold compatibility forms and accents, drop invisible/format characters, split camelCase (including acronym runs
// such as JWTService) and letter/digit boundaries, turn every other separator into one space.
export function normalise(s) {
  return String(s).normalize('NFKD').replace(/[\p{Cf}\p{M}᠎]/gu, '').normalize('NFKC')
    .replace(/(JWT|RBAC|SSO|RLS|OIDC|SAML|MFA|CSRF|CORS)(?=[A-Z])/g, '$1 ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(\d)([A-Z][a-z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const PATTERNS = Object.entries(CLASSES).map(([cls, { words, stems }]) =>
  [cls, new RegExp(`(?:^| )(${words.join('|')})(?= |$)`, 'u'), stems.length ? new RegExp(`(${stems.join('|')})`, 'u') : null]);

function scan(text, source, hits) {
  const n = normalise(text), squashed = n.replace(/ /g, '');
  for (const [cls, re, stem] of PATTERNS) {
    const m = re.exec(n) || (stem && (stem.exec(n) || stem.exec(squashed)));
    if (m) hits.push({ class: cls, signal: m[1], source });
  }
}

const RANK = { STANDARD: 0, ELEVATED: 1 };
export const normClaim = (c) => (typeof c === 'string' && Object.hasOwn(RANK, c.trim().toUpperCase()) ? c.trim().toUpperCase() : null);
const isStr = (x) => typeof x === 'string' && x.trim() !== '';

export function riskFloor({ ticketText = '', paths = [] } = {}) {
  const hits = [];
  const malformed = typeof ticketText !== 'string' || !Array.isArray(paths) || !paths.every((p) => isStr(p) && normalise(p) !== '') || (normalise(ticketText) === '' && paths.length === 0);
  if (malformed) hits.push({ class: 'malformed_input', signal: '', source: 'input' });
  else if (ticketText.length + paths.reduce((a, p) => a + p.length, 0) > MAX_INPUT) hits.push({ class: 'input-too-large', signal: '', source: 'input' });
  else { scan(ticketText, 'ticket', hits); for (const p of paths) scan(p, `path:${p.slice(0, 200)}`, hits); }
  const classes = [...new Set(hits.map((h) => h.class))].sort();
  const floor = hits.length ? 'ELEVATED' : 'STANDARD';
  return { floor, classes, reasons: hits.slice(0, 50),
    debate: floor === 'ELEVATED' ? { required: true, max_calls: 3, total_timeout: '20m' } : { required: false } };
}

// Never lowers: the result is at least the (normalised) claim and at least the floor; an unknown claim resolves to ELEVATED.
export function applyFloor(claimed, result) {
  const c = normClaim(claimed);
  if (c === null) return claimed === undefined ? result.floor : 'ELEVATED';
  return RANK[result.floor] > RANK[c] ? result.floor : c;
}

export function check(input = {}) {
  const r = riskFloor(input);
  const c = normClaim(input.claimed), bad = c === null && input.claimed !== undefined;
  const final = applyFloor(input.claimed, r);
  let digest;
  try { digest = createHash('sha256').update(JSON.stringify([input.ticketText ?? '', input.paths ?? []]) ?? '').digest('hex'); } catch { digest = '0'.repeat(64); }
  const claimed = c ?? (bad ? 'invalid' : 'unspecified');
  return { ...r, claimed, final, ...(bad ? { error: 'bad_claim' } : {}), raised: bad || RANK[final] > RANK[c ?? 'STANDARD'] || (c === null && final === 'ELEVATED'),
    record_line: `risk-floor: floor=${r.floor}; classes=${r.classes.join(',') || 'none'}; claimed=${claimed}; final=${final}; input sha256:${digest}` };
}
export const exitCodeFor = (r) => (r.error || r.classes.includes('malformed_input') || r.classes.includes('input-too-large') ? 1 : r.raised ? 2 : 0);

const FLAGS = ['ticket', 'paths', 'claimed'];
// Strict parser: `--flag value` or `--flag=value`; null on any missing value, unknown or repeated flag, or positional argument.
export function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(args[i]);
    if (!m || !FLAGS.includes(m[1]) || Object.hasOwn(o, m[1])) return null;
    let v = m[2];
    if (v === undefined) { v = args[++i]; if (v === undefined || v.startsWith('--')) return null; }
    o[m[1]] = v;
  }
  return o;
}

export function main(argv) {
  const usage = { ok: false, final: 'ELEVATED', error: 'bad_input', usage: 'risk-floor.mjs check --ticket <file|-> [--paths <file|json>] [--claimed <profile>]' };
  const f = argv[0] === 'check' ? parseFlags(argv.slice(1)) : null;
  if (!f) return { code: 1, out: usage };
  let ticketText = '', paths = [], unreadable = false;
  try { if (f.ticket !== undefined) ticketText = readFileSync(f.ticket === '-' ? 0 : f.ticket, 'utf8'); } catch { unreadable = true; }
  if (f.paths !== undefined) { try { paths = JSON.parse(f.paths.trim().startsWith('[') ? f.paths : readFileSync(f.paths, 'utf8')); } catch { paths = null; } }
  const r = check({ ticketText: unreadable ? null : ticketText, paths, claimed: f.claimed });
  return { code: exitCodeFor(r), out: r };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
