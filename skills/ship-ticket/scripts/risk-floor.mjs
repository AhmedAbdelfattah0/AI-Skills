#!/usr/bin/env node
/**
 * Deterministic risk floor (ASTF-11, S-10). Ticket text and planned paths in; a floor out. A floor can only RAISE a
 * classification: `applyFloor` returns the higher of the claimed profile and the floor, never lower, and an unknown
 * or missing claim counts as lower. Matching may over-classify (a keyword in a comment-only change still floors to
 * ELEVATED); it must never under-classify, so empty input and oversized input fail closed to ELEVATED.
 *
 *   risk-floor.mjs check --ticket <file|-> [--paths <file|json>] [--claimed STANDARD|ELEVATED]
 * Exit 0: the claim already meets the floor. Exit 2: the claim is below the floor (use `final`, run the debate).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT = 2_000_000;
// Class -> word/phrase patterns, matched on whole tokens of normalised text (never inside another word).
export const CLASSES = {
  money: ['price', 'prices', 'pricing', 'billing', 'payment', 'payments', 'invoice', 'invoices', 'refund', 'refunds', 'checkout',
    'stripe', 'currency', 'subscription', 'subscriptions', 'discount', 'coupon', 'tax', 'money', 'charge', 'charges', 'payout'],
  tenancy: ['tenant', 'tenants', 'tenancy', 'multi tenant', 'multitenant', 'rls', 'row level security', 'org id', 'organization id', 'workspace id'],
  auth: ['auth', 'authn', 'authz', 'authentication', 'authenticate', 'authorization', 'authorize', 'login', 'logout', 'session', 'sessions',
    'jwt', 'oauth', 'sso', 'password', 'passwords', 'permission', 'permissions', 'rbac', 'acl', 'secret', 'secrets', 'credential', 'credentials',
    'api key', 'access token', 'refresh token', 'bearer'],
  'public-contract': ['public api', 'openapi', 'swagger', 'webhook', 'webhooks', 'graphql', 'api contract', 'breaking change', 'event schema', 'endpoint', 'endpoints'],
  'data-shape': ['migration', 'migrations', 'schema', 'schemas'],
  shared: ['shared component', 'shared components', 'shared contract', 'shared library', 'design system', 'shared module']
};

// Lowercase, fold compatibility forms, drop zero-width/format characters, split camelCase, turn every separator into one space.
export function normalise(s) {
  return String(s).normalize('NFKC').replace(/[​-‏⁠﻿­]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = Object.entries(CLASSES).map(([cls, words]) =>
  [cls, new RegExp(`(?:^| )(${words.map((w) => esc(w)).join('|')})(?= |$)`, 'u')]);

function scan(text, source, hits) {
  const n = normalise(text);
  for (const [cls, re] of PATTERNS) { const m = re.exec(n); if (m) hits.push({ class: cls, signal: m[1], source }); }
}

const RANK = { STANDARD: 0, ELEVATED: 1 };
export function riskFloor({ ticketText = '', paths = [] } = {}) {
  const hits = [];
  const list = Array.isArray(paths) ? paths.map(String) : [];
  const size = String(ticketText).length + list.reduce((a, p) => a + p.length, 0);
  if (size > MAX_INPUT) hits.push({ class: 'input-too-large', signal: String(size), source: 'input' });
  else if (!String(ticketText).trim() && list.length === 0) hits.push({ class: 'no-input', signal: '', source: 'input' });
  else {
    scan(ticketText, 'ticket', hits);
    for (const p of list) scan(p, `path:${p.slice(0, 200)}`, hits); // backslash, slash, dot and dash all normalise to a space
  }
  const classes = [...new Set(hits.map((h) => h.class))].sort();
  const floor = hits.length ? 'ELEVATED' : 'STANDARD';
  return { floor, classes, reasons: hits.slice(0, 50),
    debate: floor === 'ELEVATED' ? { required: true, max_calls: 3, total_timeout: '20m' } : { required: false } };
}

// Never lowers: the result is at least the claim and at least the floor. An unknown claim counts as STANDARD.
export function applyFloor(claimed, result) {
  const c = Object.hasOwn(RANK, claimed) ? claimed : 'STANDARD';
  return RANK[result.floor] > RANK[c] ? result.floor : c;
}

export function check(input = {}) {
  const r = riskFloor(input);
  const final = applyFloor(input.claimed, r);
  const claimed = Object.hasOwn(RANK, input.claimed) ? input.claimed : 'unspecified';
  const digest = createHash('sha256').update(JSON.stringify([input.ticketText ?? '', input.paths ?? []])).digest('hex');
  return { ...r, claimed, final, raised: final !== claimed,
    record_line: `risk-floor: floor=${r.floor}; classes=${r.classes.join(',') || 'none'}; claimed=${claimed}; final=${final}; input sha256:${digest}` };
}

export const exitCodeFor = (r) => (r.final !== r.claimed ? 2 : 0); // anything but a claim that already equals the final is a raise

function argOf(argv, name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }
export function main(argv) {
  if (argv[0] !== 'check') return { code: 1, out: { ok: false, code: 'bad_input', usage: 'risk-floor.mjs check --ticket <file|-> [--paths <file|json>] [--claimed STANDARD|ELEVATED]' } };
  const t = argOf(argv, 'ticket'), p = argOf(argv, 'paths');
  let ticketText = '', paths = [];
  try {
    if (t) ticketText = readFileSync(t === '-' ? 0 : t, 'utf8');
    if (p) { const raw = p.trim().startsWith('[') ? p : readFileSync(p, 'utf8'); paths = JSON.parse(raw); }
  } catch { return { code: 1, out: { ok: false, code: 'bad_input' } }; }
  const r = check({ ticketText, paths, claimed: argOf(argv, 'claimed') });
  return { code: exitCodeFor(r), out: r };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
