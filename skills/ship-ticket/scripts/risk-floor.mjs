#!/usr/bin/env node
/**
 * Best-effort LEXICAL risk floor (ASTF-11, S-10). Ticket text and planned paths in; a floor out. It raises, never lowers:
 * `applyFloor` returns the higher of the claimed profile and the floor. A match is evidence of risk; the ABSENCE of a match
 * is NOT evidence of low risk. The keyword catalog is amendable by the owner. It is English-only, knows no synonyms and
 * folds no homoglyphs. Unusable input (missing, empty, undecodable, oversized, malformed, unknown claim) fails closed to ELEVATED.
 *
 * Matching uses additive views of each input (nothing is split or rewritten, so no supported token can be destroyed):
 *  - squashed: lowercase alphanumerics concatenated; a keyword of 4+ characters (or one containing a digit, such as 2fa) matches by SUBSTRING (GraphQLClient, V1API,
 *    store_id, src/billing/x.ts). Over-classification such as `author` for `auth` or `prevent`-style noise is accepted.
 *  - tokens: whole lowercase tokens plus capitalised camel words; a keyword of 1-3 characters matches a whole token.
 *  - uppercase runs: every run of 2+ uppercase letters/digits in the original casing, matched by substring, so JWTService,
 *    OTPId, ACLId, HS256JWT and V1API yield JWT, OTP, ACL and API.
 *
 *   risk-floor.mjs check --ticket <file|-> [--paths <file|json array of strings>] [--claimed STANDARD|ELEVATED, any case]
 * `--ticket` is required and must hold meaningful text even when paths are given. Flags take `--flag value` or `--flag=value`; a
 * missing value, an unknown or repeated flag, or a positional argument is an error. Files are read as strict UTF-8: UTF-16/32
 * byte-order marks, NUL bytes and invalid UTF-8 are malformed input.
 * Exit codes: 0 = the claim already meets the floor; 2 = the claim was below the floor (use `final`, run the debate);
 * 1 = unusable input, unknown claim or usage error. An exit-1 output still carries final=ELEVATED, never a lower profile, and
 * exit 1 holds even when the claim is ELEVATED.
 * ADVISORY, NOT ENFORCED: no script reads the plan's recorded line. Checking the plan record is deferred to the S-23/S-24 wiring.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT = 2_000_000;
// Class -> keywords (plain text; separators are irrelevant). Length after squashing decides substring (4+) or whole-token (1-3).
export const CLASSES = {
  money: ['price', 'pricing', 'bill', 'payment', 'payout', 'pay', 'paypal', 'invoice', 'refund', 'checkout', 'stripe', 'currency', 'currencies', 'subscri', 'discount', 'coupon',
    'tax', 'taxes', 'vat', 'fee', 'fees', 'money', 'charge', 'wallet', 'ledger', 'transaction', 'cart', 'renewal'],
  tenancy: ['tenan', 'rls', 'row level security', 'org id', 'organization id', 'organisation id', 'workspace id', 'store id', 'shop id', 'merchant id', 'account id', 'team id', 'idor', 'ownership'],
  auth: ['auth', 'login', 'logout', 'sign in', 'signin', 'log in', 'logged in', 'sign up', 'signup', 'session', 'jwt', 'jwts', 'oidc', 'saml', 'sso', 'password', 'permission', 'role', 'rbac', 'acl', 'acls',
    'admin', 'staff', 'secret', 'credential', 'api key', 'access token', 'refresh token', 'recovery token', 'csrf token', 'auth token', 'api token', 'session token', 'reset token',
    'id token', 'verification token', 'bearer', 'cookie', 'mfa', '2fa', 'two factor', 'otp', 'otps', 'cors', 'csrf', 'suspen'],
  'public-contract': ['public api', 'api', 'apis', 'openapi', 'swagger', 'webhook', 'graphql', 'grpc', 'endpoint', 'route', 'breaking change', 'event schema'],
  'data-shape': ['migrat', 'schema', 'alembic', 'drizzle', 'prisma', 'flyway', 'liquibase', 'sql', 'env'],
  shared: ['shared', 'design system']
};

const squash = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '');
// Fold compatibility forms and accents, drop invisible/format characters. Casing and word boundaries are kept.
export function fold(s) { return String(s).normalize('NFKD').replace(/[\p{Cf}\p{M}᠎]/gu, '').normalize('NFKC'); }
const KEYWORDS = Object.entries(CLASSES).flatMap(([cls, ks]) => ks.map((k) => ({ cls, k, sq: squash(k.toLowerCase()) })));

function views(text) {
  const c = fold(text), lower = c.toLowerCase();
  const tokens = new Set(lower.replace(/[^\p{L}\p{N}]+/gu, ' ').split(' '));
  for (const w of c.match(/\p{Lu}[\p{Ll}\p{N}]+/gu) ?? []) tokens.add(w.toLowerCase());
  return { squashed: squash(lower), tokens, runs: (c.match(/[\p{Lu}\p{N}]{2,}/gu) ?? []).join(' ').toLowerCase() };
}
function scan(text, source, hits) {
  const v = views(text);
  for (const { cls, k, sq } of KEYWORDS) {
    if (sq.length >= 4 || /\d/.test(sq) ? v.squashed.includes(sq) : v.tokens.has(sq) || v.runs.includes(sq)) hits.push({ class: cls, signal: k, source });
  }
}

const RANK = { STANDARD: 0, ELEVATED: 1 };
export const normClaim = (c) => (typeof c === 'string' && Object.hasOwn(RANK, c.trim().toUpperCase()) ? c.trim().toUpperCase() : null);
// A usable string: no NUL, no replacement character (a decoding failure), and something left after folding and squashing.
const usable = (x) => typeof x === 'string' && !/[\u0000\uFFFD]/.test(x) && squash(fold(x)) !== '';
const NOT_A_TICKET = /^\s*(null|undefined|nan|none)\s*$/i; // what a failed tracker/jq extraction prints

export function riskFloor({ ticketText, paths = [] } = {}) {
  const hits = [];
  const malformed = !usable(ticketText) || NOT_A_TICKET.test(ticketText) || !Array.isArray(paths) || !paths.every(usable);
  if (malformed) hits.push({ class: 'malformed_input', signal: '', source: 'input' });
  else if (ticketText.length + paths.reduce((a, p) => a + p.length, 0) > MAX_INPUT) hits.push({ class: 'input-too-large', signal: '', source: 'input' });
  else { scan(ticketText, 'ticket', hits); paths.forEach((p, i) => scan(p, `path:${i}`, hits)); }
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
  try { digest = createHash('sha256').update(JSON.stringify([input.ticketText ?? null, input.paths ?? null]) ?? '').digest('hex'); } catch { digest = '0'.repeat(64); }
  const claimed = c ?? (bad ? 'invalid' : 'unspecified');
  const nPaths = Array.isArray(input.paths) ? input.paths.length : 0;
  // The record names classes and counts only, never raw paths or ticket text.
  return { ...r, claimed, final, ...(bad ? { error: 'bad_claim' } : {}), raised: bad || RANK[final] > RANK[c ?? 'STANDARD'] || (c === null && final === 'ELEVATED'),
    record_line: `risk-floor: floor=${r.floor}; classes=${r.classes.join(',') || 'none'}; claimed=${claimed}; final=${final}; paths=${nPaths}; input sha256:${digest}` };
}
export const exitCodeFor = (r) => (r.error || r.classes.includes('malformed_input') || r.classes.includes('input-too-large') ? 1 : r.raised ? 2 : 0);

// Strict decoding: invalid UTF-8, NUL bytes and UTF-16/32 byte-order marks throw.
export function decodeStrict(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) throw new Error('utf16_or_utf32');
  if (buf.includes(0)) throw new Error('nul');
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}
const readStrict = (f) => decodeStrict(readFileSync(f === '-' ? 0 : f));

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
  if (!f || f.ticket === undefined) return { code: 1, out: usage };
  let ticketText = null, paths = [];
  try { ticketText = readStrict(f.ticket); } catch { /* stays null: malformed */ }
  if (f.paths !== undefined) { try { paths = JSON.parse(f.paths.trim().startsWith('[') ? f.paths : readStrict(f.paths)); } catch { paths = null; } }
  const r = check({ ticketText, paths, claimed: f.claimed });
  return { code: exitCodeFor(r), out: r };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
