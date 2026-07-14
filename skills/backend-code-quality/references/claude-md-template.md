# CLAUDE.md — Backend

> Scaffold produced by the backend-code-quality skill. Fill every TODO, delete this line.
> This file is the source of truth; the skill defers to it over its own defaults.

## Stack

- Language: TODO (TypeScript / Python / Go / PHP / Ruby / Java / …)
- Framework: TODO (Express / Hono / FastAPI / Django / Gin / Laravel / Rails / Spring / …)
- Runtime: TODO (Node / Deno / Bun / CF Workers / Lambda / container / VM)
- Datastore: TODO (PostgreSQL / MySQL / MongoDB / DynamoDB / …)
- Data access: TODO (ORM / query builder / raw + parameterized)
- Validation: TODO (Zod / Pydantic / Joi / class-validator / struct tags / …)
- Webhooks: TODO (providers, or "none")

## Conventions

- **Route prefix:** TODO (e.g. `/api/`, `/v1/`)
- **Auth strategy:** TODO (session / JWT / OAuth / provider); step-up (MFA) for privileged? TODO
- **Tenancy model:** TODO (single-tenant / row-level isolation / schema-per-tenant / db-per-tenant)
- **Tenant identity source:** TODO (token claim / session) — never client input
- **Response envelope:** TODO (e.g. `{ data }` on success, `{ error, code? }` on failure)
- **Middleware/filter order:** TODO (e.g. securityHeaders → rateLimit → auth → tenant → audit → handler)
- **Logging:** structured only; never log secrets, tokens, card data, or MFA codes

## Directory layout

TODO — document the actual layout so generated files land in the right place. Default:

```
<api root>/
├── routes|controllers/
├── middleware|filters/
├── services/
├── data|repositories/
├── schemas|validators/
├── lib|util/
└── types|models/
```

## Secrets & config

- Source: TODO (env vars / secret manager / platform bindings)
- Required keys: TODO (datastore URL/keys, per-provider webhook secrets, …)

## Non-negotiables

- Every endpoint has a security tier; authorization checked on every protected access
- Every external input validated against a schema before use
- Queries parameterized / ORM-safe — no string-concatenated untrusted input
- Webhooks: constant-time signature verify → guarded parse → fail-closed replay → unique-constraint idempotency → audit
- Audit log append-only, enforced at the datastore layer (not just in code)
- Tenant data isolated via one uniform model; default-deny on missing tenant context
- Secrets from config only; never hardcoded, never logged

These map to the skill's `[NN]` rules (`BE-SEC-*`, `BE-VAL-*`, `BE-TEN-*`, `BE-WHK-*`,
`BE-AUD-*`, `BE-AUTH-*`, `BE-RT-02/03`, `BE-HDR-04/05`). **This file cannot override them.**
It can override `[D]` defaults freely, and replace `[ARCH]` rules project-wide.

## Architectural overrides

> Use this section to replace an `[ARCH]` rule across the whole project. Leave empty if none.
> A rule listed here is replaced everywhere; it is never skipped in a single handler.

- TODO or "none"

## Things the skill should NOT flag

> Project-specific decisions that look like violations but are intentional. Be precise —
> this section suppresses findings, so a vague entry suppresses too much.

- TODO or "none"
