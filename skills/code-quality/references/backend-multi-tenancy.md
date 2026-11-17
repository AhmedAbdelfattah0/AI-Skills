# Multi-Tenancy Isolation — Reference

Pick ONE model and apply it uniformly. Mixing models, or applying a model inconsistently,
is how cross-tenant leaks happen. In all models the tenant identity comes from the
**verified principal** (token claim / session), never from client-supplied input.

---

## Model 1 — Database-enforced row isolation (strongest)

The datastore itself filters rows by tenant, independent of application code. Postgres
Row-Level Security is the canonical example (see `postgres-rls-migration.sql`).

- **Pro:** fail-closed by default; a forgotten `WHERE` clause cannot leak data; isolation
  survives bugs in the app layer.
- **Con:** requires a datastore that supports it; policies must be written and tested;
  elevated/admin credentials bypass it (use sparingly, document why).
- **Rule:** every tenant table has isolation enabled AND at least one policy. A table with
  isolation enabled and no policy = no access (correct fail-closed behavior).

## Model 2 — Mandatory query scoping (most portable)

Every query is filtered by tenant through a **single shared data-access layer** — a
repository, base query, or ORM global scope — so no individual handler can forget it.

- **Pro:** works on any datastore; explicit and debuggable.
- **Con:** only as safe as your discipline — an ad-hoc query that bypasses the layer leaks.
  The enforcement must be structural, not a convention.
- **Rules:**
  - All reads/writes for tenant data go through the scoped layer; raw/ad-hoc queries are
    forbidden for tenant tables (lint/review for this).
  - The tenant filter is injected from the verified principal in one place, not passed by
    each caller.
  - Default deny: if tenant context is absent, the query returns nothing.

## Model 3 — Schema-per-tenant / Database-per-tenant (hard isolation)

Each tenant gets its own schema or database; the connection is selected per request.

- **Pro:** strongest blast-radius isolation; easy per-tenant backup/export/delete; noisy-
  neighbor isolation.
- **Con:** higher operational cost; migrations must fan out across all tenants; connection
  management and pooling get more complex; cross-tenant analytics is harder.
- **Rule:** tenant→schema/db resolution happens from the verified principal in middleware,
  before any handler runs; never trust a tenant key from the request body.

---

## Universal checklist (regardless of model)

```
□ Tenant identity derived from verified principal (token/session), never from client input
□ One isolation model, applied to every tenant table/collection
□ Default-deny on missing tenant context (returns nothing, not everything)
□ Tenant key present and indexed on every tenant record
□ Elevated/bypass credentials used only where justified, with a comment explaining why
□ A test proves tenant A cannot read or mutate tenant B's data
```
