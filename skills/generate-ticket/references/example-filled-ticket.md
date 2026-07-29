# Example — a fully-filled ticket at the target depth

> This is what "maximum detail" looks like. It's a backend+UI example modeled on
> the kind of ticket that feeds ship-ticket cleanly. Use it to calibrate depth —
> not every ticket is this big, but this is the ceiling and the shape.
>
> **Note the reference style.** Every sibling ticket is named by its **slug**
> (`market-registry`, `gateway-live-paymob`) because none of them exist in the
> tracker yet. `MARKET-EPIC` is the one key-shaped reference, and only because the
> epic **already exists** — it was read from the tracker, not invented. Copy that
> discipline: slugs for the set you're generating, real keys only for things you
> actually verified.
>
> Its paired CSV row is `example-tickets-import.csv`.

---

## Summary

Payment provider interface + market-keyed registry + encrypted tenant credential storage + registry-driven Admin page

**Type:** Task
**Priority:** High — unblocks all downstream gateway work; nothing charges until the seam exists
**Suggested labels:** `backend`, `admin`, `payments`, `security-sensitive`, `design-parity`
**Epic / Parent:** MARKET-EPIC

---

## Context / why it matters

The API has zero live gateway processing today — COD is the only path and it
performs no charge. To add Paymob/Fawry/etc. without rewriting checkout each time,
we need the *seam*: a provider interface, a market-keyed registry of which
providers exist per market, encrypted per-tenant credential storage, and the Admin
page to configure them. Live charging is a **separate** ticket built on this. This
ticket must leave behaviour unchanged (still COD-only at runtime) while making
every gateway configurable.

---

## Blockers & dependencies

- **Depends on market-registry** — the `@storecraft/markets` registry; this reads
  market → available providers from it, not a hardcoded list.
- **Depends on crypto-service** — the `CryptoService` from the PII-encryption ticket;
  gateway secrets reuse it, no second crypto path.
- **Same-file contention:** registering the Admin route touches
  `apps/api/src/index.ts` — conflicts with queue-worker; sequence, do not parallelise.

---

## Design source of truth

- **Reference screen:** `templates/Admin/pages-sc1.jsx → GatewaysPage` — GATE 4 applies; pin the SHA before building.
- **Token file:** `templates/Admin/tokens.css`
- **Conventions doc:** follow `CLAUDE.md` (bilingual/RTL, numeric LTR-isolation).
- **[TODO-VERIFY: confirm GatewaysPage is the committed reference and not an uncommitted working-tree file]** — ship-ticket Step 0.5 will refuse to build against an unpinned reference.

---

## Scope / what to build

### API
- Define `PaymentProvider` interface: `createPayment`, `verifyWebhook`,
  `refund`, `testConnection`, plus a generic `subMethods` shape (proven by a
  fake-provider test — must model sub-methods generically even though flat
  providers don't use them).
- Market-keyed registry: `market → providers[]`, read from `@storecraft/markets`.
- Credential storage: encrypted at rest via `CryptoService`, tenant-scoped.

### Database
```sql
create table tenant_payment_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider_id text not null,
  encrypted_credentials bytea not null,   -- via CryptoService, never plaintext
  created_at timestamptz not null default now(),
  unique (tenant_id, provider_id)
);
-- RLS: tenant-scoped; writes via sanctioned path only
```

### UI
- Admin GatewaysPage per the reference: list market providers (Paymob/Fawry/etc.),
  per-provider enable toggle + credential form (flat fields), **masked on read**
  (`••••1234`, raw key write-only).
- States: empty (no providers configured), populated, saving, error.
- EN/AR + RTL; tokens-only.

---

## Invariants & security

- **Security-sensitive: yes** — route to strong model. Tenant payment credentials
  are the most sensitive per-tenant data in the platform.
- **Tenant isolation:** a cross-tenant read of credentials is catastrophic. Read/
  write via the sanctioned tenant-scoped path; add the call site to the RLS-refactor
  ticket's phase-2 list.
- **Fail-closed:** missing encryption key → deny (no plaintext fallback), same
  posture as PII keys.
- **Masked on read:** the API never returns a decrypted credential to the Admin
  surface. Verify no endpoint echoes the raw key.
- **Behaviour unchanged:** no live charging in this ticket — COD stays the only
  runtime path.

---

## Out of scope

- Live gateway charging (createPayment hitting Paymob, webhooks, refunds) → owned by gateway-live-paymob.
- Funnel checkout payment selector → owned by funnel-payment-selector.

---

## Acceptance criteria

- [ ] `PaymentProvider` interface + registry live; `subMethods` modelled generically (fake-provider test proves it)
- [ ] Registry reads providers from `@storecraft/markets`, not a hardcoded list
- [ ] `tenant_payment_credentials` table created, RLS tenant-scoped, encrypted via `CryptoService`
- [ ] Missing encryption key → writes fail closed (tested)
- [ ] Admin GatewaysPage renders per reference; credentials masked on read; raw key never returned by any endpoint
- [ ] Cross-tenant regression test — tenant A cannot read tenant B credentials
- [ ] Runtime behaviour unchanged — still COD-only, no live charge
- [ ] EN/AR + RTL correct
- [ ] `npx nx run-many -t build lint test` green *(this example's repo is nx — use **your** repo's real command)*
- [ ] GATE 4 parity passed against pinned SHA for GatewaysPage

---

## Recon required

- **[TODO-VERIFY]** GatewaysPage is committed (pinnable) — check `git ls-files templates/Admin/pages-sc1.jsx`.
- **[TODO-VERIFY]** `CryptoService` exposes an encrypt/decrypt API this can call — check the PII-encryption ticket's delivered service.

---

## Links

- Related: market-registry, crypto-service, gateway-live-paymob
- Blocked by: — · Blocks: gateway-live-paymob, funnel-payment-selector
- Source: market-expansion epic · Design: `templates/Admin/pages-sc1.jsx`
