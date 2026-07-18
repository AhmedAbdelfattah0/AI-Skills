---
name: backend-code-quality
description: |
  Enforced backend code quality — the backend specialist of the code-quality
  family, in any language/framework/runtime. Applies BE-* rule IDs, security
  tiers, tenant isolation, input validation, webhook safety, audit integrity, and
  SOLID via a Design Contract gate and Verification Pass. Reads CLAUDE.md and
  detects the stack first.

  Trigger when:
  - creating an endpoint, route, controller/handler, middleware, webhook handler,
    or migration; adding an API; or reviewing/refactoring any server-side code
  - the work touches request handling, database access, auth, multi-tenancy,
    webhooks, or background jobs
  - asked about backend structure or how to implement an endpoint — even with no
    framework named

  Do NOT use for: frontend code (use angular-code-quality), or the universal
  constitution/guard (use code-quality).
---

# Backend Code Quality

Enforced, security-first backend review in any stack — rule IDs, endpoint
security tiers, a Design Contract gate, and an evidence-backed Verification Pass.

> **Family:** this is the **backend specialist** of the code-quality family. The
> `code-quality` skill is the hub — it owns the shared universal core
> (`universal-principles.md`, `ai-failure-modes.md`, `review-standard.md`) and
> routes backend work here for enforced, rule-ID-based review. This skill builds
> on that core; it does not restate it.

Stack-agnostic. This skill enforces a universal set of backend disciplines and adapts the
concrete implementation to whatever stack the project uses. It does not assume a language,
framework, runtime, or datastore. Stack-specific code lives in `references/` and is labeled as a
reference implementation to adapt — never as the only way.

**The principle is always the spine; the snippet is one expression of it.**

Design principles here are **enforced, not suggested**. Every rule has a stable ID. Nothing gets
written until it has been assigned a layer and a security tier (STEP 0B), and nothing is called
done until every in-force rule reports PASS or N/A with evidence (STEP 11).

Deviation is never silent. If a rule cannot be followed, you **stop and surface it** — you do not
implement the deviation and explain afterwards.

---

## Rule Tiers

| Tier | Meaning | Who may override |
|---|---|---|
| `[NN]` | **Non-negotiable.** Security or correctness invariant. | Nobody per-endpoint. Only an explicit, recorded user waiver — and you state the risk when you record it. |
| `[ARCH]` | **Architectural.** The system's design shape. | `CLAUDE.md`, **project-wide only**. Never per-file, never "just this once". |
| `[D]` | **Default.** Convention with a sane fallback. | `CLAUDE.md`, or an established repo convention. |

An `[ARCH]` rule may be *replaced across the project*; it may never be *skipped in one handler*.
A second pattern for the same concern is drift, not pragmatism.

---

## STEP 0 — Rule Precedence

Conflicts are resolved here, before implementation — never mid-handler.

1. `[NN]` invariants
2. `CLAUDE.md` project conventions
3. This skill's `[ARCH]` rules
4. This skill's `[D]` defaults
5. Existing repo convention (match it) — only where 1–4 are silent
6. Convenience, speed, "we'll harden it before launch" — **never a tiebreaker**

If 1 and 2 collide, stop and say so. Do not pick one silently. In backend work this collision is
usually the interesting finding, not a nuisance.

---

## STEP 1 — Read Context, Detect Stack, Persist a Profile

Never generate backend code before you know the stack and its conventions.

### 1a. Read project instructions

```bash
cat CLAUDE.md 2>/dev/null || echo "NO_CLAUDE_MD"
for d in api apps/api services server backend src; do
  cat "$d/CLAUDE.md" 2>/dev/null && echo "(found $d/CLAUDE.md)"
done
```

`CLAUDE.md` overrides every `[D]` default and may replace `[ARCH]` rules project-wide. It does
**not** override `[NN]`. Extract: route prefix, auth strategy, tenancy model, data-access pattern,
webhook providers, middleware order, logging conventions.

### 1b. Detect the stack (when CLAUDE.md is silent)

```bash
for f in package.json deno.json requirements.txt pyproject.toml go.mod Gemfile \
         composer.json pom.xml build.gradle build.gradle.kts Cargo.toml mix.exs; do
  [ -f "$f" ] && echo "STACK_SIGNAL: $f"
done
[ -f wrangler.toml ] && echo "RUNTIME: cloudflare-workers"
[ -f Dockerfile ] && echo "RUNTIME: container"
[ -f vercel.json ] && echo "RUNTIME: vercel"
[ -f serverless.yml ] && echo "RUNTIME: serverless-lambda"
```

Read the manifest to identify framework, datastore client, and validation library. If still
ambiguous, ask — one focused question, not a survey:

> "What's the language/framework, the datastore + access pattern, and how is multi-tenancy
> handled (or is this single-tenant)?"

### 1c. Persist the profile (once, reused every session)

```bash
cat .claude/backend-code-quality/profile.md 2>/dev/null || echo "NO_PROFILE_CACHED"
```

If absent, gather the values and write it. Stage multiline content to a temp file; bash argument
passing collapses newlines.

```bash
mkdir -p .claude/backend-code-quality
cat > /tmp/bcq-profile.md <<'PROFILE'
# Backend Code Quality — Resolved Profile
language:            # e.g. TypeScript, Python, Go, PHP, Ruby, Java
framework:           # e.g. Express, Hono, FastAPI, Django, Gin, Laravel, Rails, Spring
runtime:             # e.g. Node, Deno, Bun, CF Workers, Lambda, container/VM
datastore:           # e.g. PostgreSQL, MySQL, MongoDB, DynamoDB
data_access:         # e.g. ORM (Prisma/SQLAlchemy/Eloquent), query builder, raw+parameterized
auth_strategy:       # e.g. session cookies, JWT, OAuth, provider (Auth0/Supabase/Cognito)
tenancy_model:       # single-tenant | row-level (RLS/scoping) | schema-per-tenant | db-per-tenant
input_validation:    # e.g. Zod, Pydantic, Joi, class-validator, struct tags
webhook_providers:   # e.g. Stripe, GitHub, none
secrets_source:      # e.g. env vars, secret manager, platform bindings
PROFILE
mv /tmp/bcq-profile.md .claude/backend-code-quality/profile.md
echo "Profile cached at .claude/backend-code-quality/profile.md"
```

> ✋ **STOP** — fill the profile from the real project (CLAUDE.md or the user's answers) before
> writing it. Do not cache the empty placeholders, and do not generate code until the profile
> reflects reality.

---

## STEP 0B — Emit the Design Contract (hard gate)

**You may not write a line of code for a unit that does not appear in this contract.**
Classification precedes construction. This is the mechanism that prevents diversion.

```
DESIGN CONTRACT
Task: <one line>

| Unit | Layer | Security tier | Single responsibility | Depends on | Rules in force |
|---|---|---|---|---|---|
| routes/orders.ts       | route      | Authenticated | Maps HTTP → OrderService     | OrderService      | BE-ARCH-02 · BE-VAL-01 |
| services/order.ts      | service    | —             | Order state transitions      | OrderRepo (iface) | BE-SOLID-01,05 |
| routes/stripe-hook.ts  | route      | Webhook       | Verifies + records Stripe evt | WebhookRepo      | BE-WHK-01…08 |

Tenancy model in force: <row-level RLS | scoped queries | single-tenant>
Deviations requested: none
```

Rules for the contract:
- Every endpoint gets a **security tier** (STEP 3). An endpoint with no tier does not get written.
- If a responsibility sentence needs the word **"and"**, the unit does two things. Split it
  (`BE-SOLID-01`).
- Every `[NN]` rule is in force whether or not it is listed.
- If `Deviations requested` is non-empty → **✋ STOP** and run the Deviation Protocol.

---

## STEP 0C — Deviation Protocol

When a rule cannot be followed:

1. **STOP.** Do not implement the deviation.
2. State: the **rule ID**, what blocks it, and two options with their costs.
3. Wait for the user.
4. If waived, record it. A waiver that isn't written down is a rule that quietly died:

```bash
mkdir -p .claude/backend-code-quality
cat > /tmp/bcq-dev.md <<'DEV'

## <YYYY-MM-DD> · <RULE-ID>
scope:     <file path + handler/function>
reason:    <why the rule cannot hold here>
risk:      <what an attacker or a bug gets from this>
expires:   <condition that removes this waiver, or a date>
DEV
cat /tmp/bcq-dev.md >> .claude/backend-code-quality/deviations.md
rm /tmp/bcq-dev.md
```

**A `[NN]` waiver is always reported to the user in plain language, at the time, with its risk.**
It never lands quietly in a ledger.

Never acceptable, and never a deviation you may take unilaterally:
- `// TODO: add auth before launch`
- A second pattern for a concern that already has one (two ways to scope a tenant = a leak waiting)
- "It's an internal endpoint" / "it's behind the VPN" / "it's just a prototype"

---

## STEP 2 — Resolve File Placement

`BE-ARCH-01` `[ARCH]` — Match the repo's existing structure first. Absent one, default to a
layered separation that exists in essentially every framework:

```
<api root>/
├── routes|controllers/   ← request handling, one unit per resource
├── middleware|filters/   ← cross-cutting concerns (auth, rate limit, logging)
├── services/             ← business logic, framework-agnostic
├── data|repositories/    ← datastore access, isolated behind an interface
├── schemas|validators/   ← request/response validation
├── lib|util/             ← pure helpers, no framework imports
└── types|models/         ← shared types / domain models
```

- `BE-ARCH-02` `[ARCH]` — **No business logic in a route.** Routes map HTTP to a service call.
- `BE-ARCH-03` `[ARCH]` — **No request/response objects inside a service.** A service that reads
  `req.body` is a route wearing a costume. Pass validated values in.
- `BE-ARCH-04` `[ARCH]` — **No datastore access inside a handler.** It lives in the repository
  layer, behind an interface.
- Webhook handler → inside its resource's route unit, not a catch-all webhook file.

---

## STEP 3 — Assign Every Endpoint a Security Profile

Classify before writing. The tiers are universal; the mechanism is yours.

| Tier | Applies to | Required controls |
|---|---|---|
| **Public** | health checks, public reads | Rate limit per IP; no sensitive/internal fields in response |
| **Authenticated** | user-owned resources | Verified identity; per-principal rate limit; authorization (ownership) check on every access |
| **Privileged** | admin / elevated actions | Stronger/step-up auth (e.g. MFA); role/permission check; audit log on mutation |
| **Webhook** | inbound provider callbacks | Signature verification; replay protection; idempotency; audit log |
| **System** | cron, service-to-service | Shared secret or mTLS; not publicly routable |

**The eight `[NN]` invariants. Never, in any stack, at any stage of the project:**

- `BE-SEC-01` — Using elevated/admin datastore credentials where a request-scoped credential
  would work. This bypasses the authorization layer entirely = data leak.
- `BE-SEC-02` — Returning internal fields (plan, status, email, internal IDs, tokens) from a
  public endpoint.
- `BE-SEC-03` — Using any external input (body, query, params, headers) without validating it
  against a schema first.
- `BE-SEC-04` — Logging passwords, tokens, session IDs, keys, card data, or MFA codes — at any
  log level.
- `BE-SEC-05` — Building queries by concatenating untrusted input. Always parameterize / use the
  ORM safely.
- `BE-SEC-06` — Skipping signature verification or idempotency on a webhook.
- `BE-SEC-07` — Swallowing errors silently (empty catch). Handle, log, or re-throw.
- `BE-SEC-08` — Returning stack traces or internal error messages to clients in production.

Authentication answers *who*. `BE-SEC-09` `[NN]` — **Authorization is checked on every protected
access**, not once at login. An authenticated user reaching another user's row is the most common
real breach.

---

## STEP 3B — Authentication & Credential Hardening

Auth endpoints (login, token, refresh, password-reset, MFA-verify) are the most attacked surface
in any app.

**Brute-force / automation resistance**
- `BE-AUTH-01` `[NN]` — Rate-limit the auth route specifically, keyed on **both** client IP and
  identifier, tighter than the global limit. Per-IP alone is defeated by password spraying across
  many accounts from one IP, or one account from many IPs.
- `BE-AUTH-02` `[D]` — Account lockout / progressive backoff after N failed attempts. Prefer
  cooldown or exponential backoff over a hard permanent lock — a hard lock is itself a DoS lever.
  Track attempts server-side, never in the client.
- `BE-AUTH-03` `[D]` — Bot mitigation (CAPTCHA / Turnstile) triggered *after* failed attempts,
  not on every request.
- `BE-AUTH-04` `[NN]` — Behind a proxy/LB, resolve the real client IP (trust-proxy / validated
  `X-Forwarded-For`) before keying any limit on it. Otherwise every request looks like the proxy's
  single IP and the limit does nothing.

**Credential handling**
- `BE-AUTH-05` `[NN]` — Store passwords with a slow, salted KDF (**bcrypt / argon2 / scrypt**).
  Never plaintext, never reversible encryption, never a bare fast hash — SHA-256 alone is not
  password storage.
- `BE-AUTH-06` `[NN]` — Enforce password policy (length + complexity) **server-side** at
  set/reset. Client checks are UX only.
- `BE-AUTH-07` `[NN]` — Never log credentials or reset tokens (reaffirms `BE-SEC-04`).

---

## STEP 4 — Validate Every External Input

Every byte crossing the trust boundary is validated against an explicit schema before use —
body, query string, route params, and security-relevant headers.

- `BE-VAL-01` `[NN]` — Define the schema in your stack's validator (Zod, Pydantic, Joi,
  class-validator, struct tags) and reject on failure with a clean 4xx — never a stack trace.
- `BE-VAL-02` `[ARCH]` — Validate at the edge of the handler, before any business logic runs.
- `BE-VAL-03` `[NN]` — Coerce and bound: enforce types, lengths, ranges, enums. Reject unknown
  fields on mutation endpoints (fail closed) rather than silently ignoring them.
- `BE-VAL-04` `[ARCH]` — Validation output is the only trusted shape downstream. Do not re-read
  the raw input after validating.

---

## STEP 5 — Enforce Data Isolation (Multi-Tenancy)

If the system serves more than one tenant, isolation is the most common and most damaging failure
mode. Pick ONE model and apply it uniformly (details in `references/multi-tenancy-patterns.md`):

1. **Database-enforced row isolation** (e.g. Postgres RLS) — strongest; fail-closed by default.
2. **Mandatory query scoping** — every query filtered by tenant through a shared data-access
   layer, never ad-hoc per handler. Enforce in one place so a forgotten filter is impossible.
3. **Schema-per-tenant / DB-per-tenant** — strong isolation, higher operational cost.

- `BE-TEN-01` `[ARCH]` — **One model, applied uniformly.** Two isolation models in one codebase
  is the leak. The chosen model is recorded in the Design Contract.
- `BE-TEN-02` `[NN]` — Derive the tenant from the **verified identity** (token claim, session).
  Never from a client-supplied body, param, or header.
- `BE-TEN-03` `[NN]` — **Default deny.** A query with no tenant context returns nothing, not
  everything.
- `BE-TEN-04` `[D]` — Every multi-tenant record carries its tenant key; index it.
- `BE-TEN-05` `[NN]` — If elevated credentials that bypass isolation are unavoidable, document
  *why* in a comment at the call site, keep the blast radius minimal, and surface it to the user.

---

## STEP 6 — Respect Runtime & Environment Constraints

Code that runs locally can still fail in production if it ignores the runtime's limits.

- `BE-RT-01` `[D]` — **Know your runtime's boundaries.** Edge/serverless runtimes often lack parts
  of the standard library (Node `Buffer`/`fs`/native `crypto`), cap execution time, and forbid
  long-lived state. Prefer Web Standard / portable APIs when targeting them.
- `BE-RT-02` `[NN]` — **Async correctness.** Background work must complete within the platform's
  request lifecycle — `await` it, or use the platform's "after response" primitive (`waitUntil`,
  background task, queue). An unawaited, unscheduled promise may be killed silently.
- `BE-RT-03` `[NN]` — **Secrets from config, never code.** Read from environment / secret manager /
  platform bindings. Never hardcode, never commit, never echo in logs or errors.
- `BE-RT-04` `[D]` — **Fail fast on missing critical config** at startup or first use, with a clear
  message — and no secret values in it.

---

## STEP 6B — Response Hardening, Headers & Exposure

Commonly missed because it's configuration, not logic. Set once at the app edge (framework
middleware such as helmet, or the reverse proxy) and verify it's present in responses.

- `BE-HDR-01` `[D]` — Security response headers on every response: `Content-Security-Policy` (as
  strict as the app allows), `Strict-Transport-Security` (long max-age once HTTPS is solid),
  `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, `Permissions-Policy`.
- `BE-HDR-02` `[D]` — Strip `X-Powered-By` / framework banner and server-version headers. Don't
  advertise the stack and version.
- `BE-HDR-03` `[D]` — Allow only the verbs the API uses. Disable `TRACE`. Disable `OPTIONS` unless
  you genuinely serve cross-origin CORS preflight — a same-origin front+back does not need it.
- `BE-HDR-04` `[NN]` — Enforce HTTPS, redirect HTTP→HTTPS, pair with HSTS. Never accept
  credentials over plaintext.
- `BE-HDR-05` `[NN]` — **Never expose data services to the internet.** Databases, caches, message
  brokers, admin/SSH ports bind to the internal network or an allowlist — never `0.0.0.0` on a
  public interface. **This outranks most application findings:** an internet-reachable database is
  a direct breach with no app logic in the way. It's an infra fix, but flag it the moment you see
  a service bound publicly.

---

## STEP 7 — Webhook Safety

Webhooks are the highest-risk endpoints — get them wrong and you get fraud or data corruption.
**The ordering is the invariant.** Reference implementations for Web Crypto (edge/Deno/Bun/
Workers) and Node are in `references/webhook-safety.md`.

- `BE-WHK-01` `[NN]` — **Verify the signature over the raw bytes, with a constant-time
  comparison, BEFORE parsing.** Never compare signatures with `==`/`===` (timing leak). Use the
  platform's verify primitive: `crypto.subtle.verify`, `hmac.compare_digest`,
  `crypto.timingSafeEqual`.
- `BE-WHK-02` `[NN]` — Parse only after verifying, and guard the parse. Malformed → 400, never an
  unhandled 500.
- `BE-WHK-03` `[NN]` — **Replay protection, fail closed.** Reject events whose timestamp is
  missing, unparseable, or outside a short tolerance window. A missing timestamp must reject, not
  slip through.
- `BE-WHK-04` `[NN]` — **Idempotency via a uniqueness constraint**, not check-then-insert. Dedupe
  on the provider's event id with a UNIQUE constraint and treat a duplicate-key error as "already
  processed". A prior `SELECT` is racy under concurrent redelivery.
- `BE-WHK-05` `[ARCH]` — Record the event **before** processing, so a failure still gets deduped
  on retry.
- `BE-WHK-06` `[D]` — Audit every outcome: `received`, `signature_invalid`, `replay_blocked`,
  `processing_failed`.
- `BE-WHK-07` `[NN]` — Return 2xx **only** on success. Return 5xx on processing failure so the
  provider retries.
- `BE-WHK-08` `[NN]` — **One secret per provider.** Never share a signing secret across providers.

---

## STEP 8 — Audit Logging

Log every state-changing or security-sensitive action to a durable audit trail.

- `BE-AUD-01` `[NN]` — **Append-only, enforced at the strongest layer the datastore offers.**
  Removing the update/delete *code path* is not enforcement — the writer (often an elevated
  credential) can still mutate. Enforce with privilege revocation (`REVOKE UPDATE, DELETE`), an
  immutable/WORM store, or a trigger that blocks mutation.
- `BE-AUD-02` `[NN]` — **Audit failure never blocks the main request.** Wrap in try/catch, report
  to your error tracker, continue.
- `BE-AUD-03` `[D]` — Severity levels: `info` (normal), `warning` (suspicious — failed login,
  rate-limit hit, data export), `critical` (security-relevant — invalid webhook signature, MFA
  lockout, privileged deletion).
- `BE-AUD-04` `[NN]` — Never put secrets or unnecessary PII in audit metadata. Stable IDs, not raw
  passwords, tokens, MFA codes, card data, or full personal records.

---

## STEP 9 — SOLID

| ID | Tier | Backend application (stack-neutral) |
|---|---|---|
| `BE-SOLID-01` | `[ARCH]` | **S** — One unit, one concern. Separate auth, tenancy, audit, rate-limiting, and business logic. Don't fuse them into a god-service. |
| `BE-SOLID-02` | `[ARCH]` | **O** — New providers/strategies are new implementations, not edits to working code (new webhook verifier, new payment provider). |
| `BE-SOLID-03` | `[ARCH]` | **L** — Abstractions are substitutable: every implementation honors the same contract **and the same error shape**. |
| `BE-SOLID-04` | `[ARCH]` | **I** — Small, focused interfaces. Don't force a unit to depend on methods it doesn't use. |
| `BE-SOLID-05` | `[ARCH]` | **D** — Handlers depend on service/repository abstractions, not concrete classes or module-level singletons. Pass dependencies in. |

Quality invariants that ride alongside:
- `BE-Q-01` `[NN]` — No untyped escape hatch (`any` / `interface{}` / `mixed`) where a real type fits.
- `BE-Q-02` `[NN]` — No debug logging or commented-out code left behind.

---

## STEP 11 — Verification Pass (hard gate)

The old checkbox list is gone. An unchecked box proves nothing; a box you tick yourself proves
less. Before declaring done, emit this table. **Evidence is a file path, a line, or a clause —
not the word "yes".**

```
VERIFICATION
| Rule | Status | Evidence |
|---|---|---|
| BE-SEC-01 | PASS | orders route uses request-scoped client, not service_role |
| BE-SEC-09 | PASS | services/order.ts:41 checks owner_id against principal |
| BE-TEN-02 | PASS | tenant read from JWT claim, never from body |
| BE-WHK-04 | PASS | UNIQUE(provider, event_id); dup-key caught as 200 |
| BE-AUD-01 | PASS | migration 0007 REVOKEs UPDATE,DELETE + blocking trigger |
| BE-HDR-05 | N/A  | no infra changed this task |
```

Rules:
- **Any FAIL blocks done.** Fix it, or run the Deviation Protocol. Do not report and ship.
- **N/A requires a reason.** "Not applicable" without a clause is a skipped check.
- Every `[NN]` rule is **always in force** and always appears in the table. `[ARCH]` and `[D]`
  rules appear when the Design Contract named them.
- A `[NN]` FAIL is stated to the user in plain language, not buried in a table row.
- **One `AI-FM` row is always in force**: walk the 15 LLM failure modes + The Floor
  (`../code-quality/references/ai-failure-modes.md`) against the diff and report it like any
  other rule — `AI-FM | PASS | no catch-alls, no mock returns, imports verified` — or FAIL with
  the offending mode named. These catch what BE-* rules can't: the model's own biases (e.g. a
  webhook handler that swallows the signature error it should propagate).
- **One `TEST` row is in force whenever the diff includes test files** (`*.test.ts`,
  `test_*.py`, `*_test.py`, `*Test.php`, `*_test.go`, files under `tests/`/`__tests__/`):
  walk TEST-01..12 from the `test-quality` skill against the test diff —
  `TEST | PASS | DB mocked only where persistence isn't the subject; real DTOs; parametrized variants`
  — or FAIL naming the ID. A must-fix violation (TEST-01/02/08) blocks done like any FAIL.
- **One `DOC` row is in force whenever the diff touches docs surfaces** (`*.md`, docstrings,
  OpenAPI/route docs): walk DOC-01..10 from the `docs-accuracy` skill — documented endpoints
  match route registrations; config keys match the code that reads them; renamed symbols
  grepped across doc surfaces — `DOC | PASS | endpoints match router; 0 false claims` — or
  FAIL naming the ID. Must-fix violations (DOC-01..04: false claims) block done.
- **Scope discipline**: the pass verifies the diff, not the repo — pre-existing violations in
  untouched files are flagged only in an explicit audit, marked `pre-existing`. Full findings
  contract: `../code-quality/references/review-standard.md`.

Fast mechanical checks (adapt the paths to the stack):

```bash
grep -rniE "service_role|SUPABASE_SERVICE|admin_key|root_key" src && echo "REVIEW BE-SEC-01" || echo "PASS BE-SEC-01"
grep -rniE "console\.log|print\(|fmt\.Println" src && echo "REVIEW BE-Q-02" || echo "PASS BE-Q-02"
grep -rnE "catch\s*\([^)]*\)\s*\{\s*\}" src && echo "FAIL BE-SEC-07" || echo "PASS BE-SEC-07"
grep -rniE "===\s*signature|==\s*signature|signature\s*===" src && echo "FAIL BE-WHK-01" || echo "PASS BE-WHK-01"
grep -rniE "\+\s*req\.(body|query|params)|f\"SELECT|\`SELECT.*\\$\{" src && echo "REVIEW BE-SEC-05" || echo "PASS BE-SEC-05"
```

Grep is a smoke test, not the verification. A `PASS` here still needs the evidence clause.

---

## Reference Files

Load only the one the task needs.

| File | Load when |
|---|---|
| `references/claude-md-template.md` | No CLAUDE.md exists — scaffold a stack-neutral one |
| `references/webhook-safety.md` | Implementing or reviewing any webhook (Web Crypto + Node reference impls) |
| `references/multi-tenancy-patterns.md` | Designing or reviewing tenant isolation |
| `references/postgres-rls-migration.sql` | The project specifically uses PostgreSQL + RLS |
| `../code-quality/references/ai-failure-modes.md` | Before the Verification Pass on any non-trivial diff — the 15 LLM failure modes + The Floor (shared with the `code-quality` skill; if installed standalone and the file is absent, still walk the modes from its summary: no catch-all error swallowing, no impossible-case guards, no single-user abstractions, no mock-success returns, verify imports exist, no speculative flags, refactors preserve behavior) |
| `../test-quality/references/pytest.md` / `phpunit.md` / `jest-vitest.md` | The diff includes test files — TEST-01..12 concretized per stack (shared with the `test-quality` skill; if absent, walk from its summary: assert behavior not internals, mock only at true boundaries, real DTOs/models not MagicMocks, parametrize value-only variants, real DB when persistence is the subject, regression tests are sacred) |

---

## What this skill does not do

- Frontend code — `angular-code-quality` owns components/templates/state.
- Test-code review — `test-quality` owns TEST-* (this skill only carries the wiring row).
- Docs accuracy — `docs-accuracy` owns DOC-* (wiring row only).
- Security *audits* — `security-audit` owns whole-surface scans and runtime/deployment checks; this skill enforces BE-SEC-*/BE-AUTH-* on the diff.
- Run linters/tests — judgment layer above the tooling, not a replacement.

## Success criteria

Working when: every endpoint declares its security tier in the Design
Contract; tenancy is enforced at the data layer, not the route; webhooks
verify signatures before parsing; the Verification Pass carries evidence for
every [NN] rule; AI-FM/TEST/DOC rows appear whenever their trigger files are
in the diff.

## Troubleshooting

- **A rule blocks a legitimate pattern:** run the Deviation Protocol (STEP 0C) —
  cite the rule ID, record the waiver with a risk note; an `[NN]` waiver is always
  surfaced to the user in plain language, never buried.
- **Stack not in `references/`:** the rules are the spine — adapt the concrete
  snippet to the stack; the principle (parameterized queries, tenant scoping,
  signature verification) holds regardless.
- **Unsure of an endpoint's tier:** default to the stricter tier (Privileged over
  Authenticated) until proven otherwise; an untiered endpoint doesn't get written.
