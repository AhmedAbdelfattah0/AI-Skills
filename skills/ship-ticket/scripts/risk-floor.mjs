#!/usr/bin/env node
/**
 * Best-effort LEXICAL risk floor (ASTF-11, S-10). Ticket text and planned paths in; a floor out. It raises, never lowers:
 * `applyFloor` returns the higher of the claimed profile and the floor. A match is evidence of risk; the ABSENCE of a match
 * is NOT evidence of low risk (a lexical list cannot know every wording). Matching may over-classify; the keyword list is
 * amendable by the owner. Unusable input (empty, oversized, malformed, unknown claim) fails closed to ELEVATED.
 *
 *   risk-floor.mjs check  --ticket <file|-> [--paths <file|json array of strings>] [--claimed STANDARD|ELEVATED, any case]
 *   risk-floor.mjs verify --plan <plan file>
 * Exit codes. check: 0 = the claim already meets the floor; 2 = the claim was below the floor (use `final`, run the debate);
 * 1 = unusable input, unknown claim or usage error (output still carries final=ELEVATED, never a lower profile).
 * verify: 0 = the plan's recorded `risk_floor` line, `review_profile` and `plan_debate.status` agree with the floor;
 * 1 = `errors` lists why. verify is ADVISORY, NOT ENFORCED: no gate or engine step runs it yet (wiring is S-23/S-24);
 * the orchestrator MUST run it before plan approval. It checks the plan is self-consistent, not that the floor was honestly run.
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
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1 $2')
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
  const malformed = typeof ticketText !== 'string' || !Array.isArray(paths) || !paths.every(isStr);
  if (malformed) hits.push({ class: 'malformed_input', signal: '', source: 'input' });
  else if (ticketText.length + paths.reduce((a, p) => a + p.length, 0) > MAX_INPUT) hits.push({ class: 'input-too-large', signal: '', source: 'input' });
  else if (!ticketText.trim() && paths.length === 0) hits.push({ class: 'no-input', signal: '', source: 'input' });
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
export const exitCodeFor = (r) => (r.error || r.classes.includes('malformed_input') ? 1 : r.raised ? 2 : 0);

const REC = /risk-floor: floor=(STANDARD|ELEVATED); classes=[^;]*; claimed=\w+; final=(STANDARD|ELEVATED); input sha256:[0-9a-f]{64}/;
export function verifyPlan(text) {
  const errors = [], m = REC.exec(text);
  if (!m) return ['no_record'];
  const [, floor, final] = m;
  if (RANK[final] < RANK[floor]) errors.push('final_below_floor');
  if (floor === 'ELEVATED') {
    const prof = /^[ \t]*review_profile:[ \t]*(STANDARD|ELEVATED)[ \t]*$/m.exec(text);
    if (!prof || prof[1] !== 'ELEVATED') errors.push('profile_below_floor');
    const st = /plan_debate:[^\n]*status:[ \t]*(\w+)[ \t]*[},]/.exec(text);
    if (!st) errors.push('debate_missing'); else if (st[1] === 'SKIPPED') errors.push('debate_skipped');
  }
  return errors;
}

function argOf(argv, name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }
export function main(argv) {
  const usage = { ok: false, final: 'ELEVATED', error: 'bad_input', usage: 'risk-floor.mjs check --ticket <file|-> [--paths <file|json>] [--claimed <profile>] | verify --plan <file>' };
  if (argv[0] === 'verify') {
    let text; try { text = readFileSync(argv[1] === '--plan' ? argv[2] : '', 'utf8'); } catch { return { code: 1, out: { ...usage, errors: ['plan_unreadable'] } }; }
    const errors = verifyPlan(text); return { code: errors.length ? 1 : 0, out: { ok: !errors.length, errors } };
  }
  if (argv[0] !== 'check') return { code: 1, out: usage };
  const t = argOf(argv, 'ticket'), p = argOf(argv, 'paths');
  let ticketText = '', paths = [], unreadable = false;
  try { if (t) ticketText = readFileSync(t === '-' ? 0 : t, 'utf8'); } catch { unreadable = true; }
  if (p !== undefined) { try { paths = JSON.parse(p.trim().startsWith('[') ? p : readFileSync(p, 'utf8')); } catch { paths = null; } }
  const r = check({ ticketText: unreadable ? null : ticketText, paths, claimed: argv.includes('--claimed') ? (argOf(argv, 'claimed') ?? '') : undefined });
  return { code: exitCodeFor(r), out: r };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
