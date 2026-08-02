---
name: vapt
description: |
  Adversarial security testing of code that was just written — the runtime layer
  the static security skills structurally cannot reach. Enumerates the trust
  boundaries a change introduces, attacks each one, and leaves the abuse cases
  behind as COMMITTED TESTS in the repo's own runners so CI re-runs them forever.
  Stack-agnostic: detects the runners and the harness, never prescribes them.
  Runs in two modes — GATE (the diff, as ship-ticket's GATE 5) and AUDIT
  (backfill over already-shipped code in the base branch).

  Trigger when:
  - the user types /vapt, /vapt.audit, or /vapt.fix
  - the user says "pentest this", "VAPT", "penetration test", "security test
    this API", "can this be exploited", "try to break in", "abuse case", "test
    for IDOR", "check authz", or "is this endpoint safe to expose"
  - an endpoint, auth path, upload, form, or rendering surface was just built or
    changed and nothing has yet sent it a hostile request
  - ship-ticket reaches GATE 5

  Do NOT use for: secure-by-default patterns while writing (use security),
  static rule enforcement on the diff (use backend-code-quality BE-SEC-*),
  reading the whole codebase for vulnerabilities without running it (use
  security-audit), or functional correctness (that is the repo's unit tests).
---

# VAPT — adversarial testing of what was just built

Every other security layer in this library **reads code**. This one **attacks a
running instance** and commits the attack as a test.

That distinction is the whole justification for the skill. `BE-SEC-09` passing
means an ownership check *exists in the file*. It does not mean the guard's
route matcher actually covers the new path, that middleware runs in the order
you think, that the ORM didn't serialize a joined row, or that the body binder
won't happily accept `role: "admin"`. Those only surface when something returns
`200` with a body it should never have produced.

**Output is tests, not a report.** A report is an agent's word. A committed test
is a merge-blocking fact that keeps running after everyone forgets the ticket.

## Commands

| Command | Mode | Scope |
|---|---|---|
| `/vapt` | **GATE** | The current diff (vs. the base branch). This is ship-ticket's GATE 5. |
| `/vapt.audit` | **AUDIT** | Already-shipped code in the base branch, in risk-ordered waves, resumable. |
| `/vapt.fix <ID>` | either | Jump to one tracked finding with minimum context load. |

Artifacts live in `.specs/vapt/` — `<TICKET>.md` per gate run, `surfaces.md` +
`findings.md` for the audit.

---

## STEP 1 — Rules of engagement (hard gate, both modes)

Read this before anything else. Getting it wrong is not a bug, it's an incident.

1. **The target is a local or disposable instance the user controls.** Never
   production. Never shared staging. Never a third-party host, even one the
   project pays for. If the only reachable environment is shared, **STOP and
   ask** — do not "just be careful."
2. **The datastore is disposable.** Abuse cases write garbage, escalate
   privileges, and delete things. Seeded local DB or ephemeral container only.
3. **No destructive or exhausting abuse that outlives the test.** Rate-limit
   probes are bounded (prove the limiter engages, do not flood). Nothing that
   leaves the box.
4. **Fixtures carry fake credentials only.** Never commit a real token, key, or
   customer record into an abuse test. If reproducing a class needs a real
   secret, the test is wrong.
5. **AUDIT mode finds live vulnerabilities in shipped code.** Report those to the
   user **privately first**. Do not open a public PR, issue, or commit message
   that describes an exploitable path before the fix exists in the same change.

Confirm the target and state it in the artifact: what you attacked, on what host,
against which datastore.

## STEP 2 — Enumerate the surfaces (this is the scoping decision)

**Bounded by trust boundaries, not by files.** "Test every changed file" is
unbounded and collapses into rubber-stamping — a date formatter has no adversary,
so a security test of it produces cost and nothing else.

A changed (GATE) or existing (AUDIT) file is **in scope** if it introduces or
changes any of:

| # | Trust boundary | Examples (detect the repo's idiom, don't assume one) |
|---|---|---|
| 1 | Request handler or its route registration | controller, handler, resolver, RPC method, route table |
| 2 | Auth / session / token lifecycle | login, refresh, verify, logout, guard, middleware, policy |
| 3 | Query or command taking external input | ORM call, raw SQL, search filter, sort/pagination param |
| 4 | Rendering a value it did not author | template, component, `innerHTML`-class sink, markdown/HTML render |
| 5 | Input that reaches a server | form, upload widget, URL/query param binding |
| 6 | File or path handling | upload, download, archive, path join, static serve |
| 7 | Client-side storage | cookie, `localStorage`, `sessionStorage`, IndexedDB |
| 8 | Outbound call carrying credentials or user data | webhook send, third-party SDK, server-to-server fetch |
| 9 | Async consumer of external payloads | queue worker, cron, webhook receiver, event handler |
| 10 | Security-relevant config | CORS, headers, cookie options, secret wiring, ACL/policy files |

**Explicitly out of scope:** pure functions over trusted input, type/DTO
declarations, styling, copy, existing tests, build config that touches none of
the above.

**Name every exclusion.** The artifact lists each changed file you excluded and
which reason applies. An unexplained exclusion is the hole this step exists to
close — the same reason GATE 4 forces every stub to link a follow-up ticket.

## STEP 3 — Principals (without these, half the rules cannot be tested)

Most real findings are authorization findings, and authorization is only
provable with more than one identity. Build (or find) fixtures for:

- **anonymous** — no credential at all
- **user A** and **user B** in *different* tenants/orgs, each owning at least one
  object of every type the surface exposes
- **low-privilege** and **high-privilege** roles, if the system has roles
- **expired / tampered / wrong-audience** credentials

Reuse the repo's existing test fixtures and auth helpers if they exist; add to
them if they don't.

**If the project cannot produce these**, say so by rule ID — `VAPT-API-01/02/03`
and `VAPT-WEB-02` run **DEGRADED**, declared in the artifact and the ship-ticket
report. They do not silently pass. A gate that quietly skips its authorization
classes is worse than no gate, because it reads as coverage.

## STEP 4 — The rule set

Every rule is a *class of attack*, and every in-scope surface is tested against
each rule that applies to it. Tiers follow the code-quality family: `[NN]` is a
non-negotiable invariant (only an explicit recorded user waiver), `[D]` is a
default a documented project convention may override.

### `VAPT-API-*` — server request surface

| ID | Tier | The attack |
|---|---|---|
| `VAPT-API-01` | `[NN]` | **BOLA / IDOR.** User A reads, updates, or deletes an object owned by user B by swapping the identifier. Test every identifier the route accepts, including nested and in-body ones. |
| `VAPT-API-02` | `[NN]` | **Broken authentication.** The route answers with no credential, an expired one, a tampered signature, a token issued for another audience/tenant, or one that was revoked. |
| `VAPT-API-03` | `[NN]` | **Broken function-level authz.** A low-privilege principal reaches an operation meant for a higher role — including the method nobody guarded (`GET` protected, `DELETE` forgotten). |
| `VAPT-API-04` | `[NN]` | **Mass assignment.** A privileged field submitted in the body is persisted — `role`, `is_admin`, `tenant_id`, `verified`, `balance`, `price`, `created_by`. |
| `VAPT-API-05` | `[NN]` | **Injection.** Untrusted input reaching an interpreter — SQL/NoSQL, command, template, LDAP, or path traversal on any file/path parameter. |
| `VAPT-API-06` | `[NN]` | **Excessive data exposure.** The response body carries fields this caller must not see — password hashes, internal IDs, other users' data, plan/billing internals, soft-deleted rows. |
| `VAPT-API-07` | `[NN]` | **Error leakage.** A malformed or hostile request returns a stack trace, driver error, file path, or query text. |
| `VAPT-API-08` | `[D]` | **Resource abuse.** No throttle on an expensive or auth-adjacent route; unbounded page size, upload size, or payload depth. |

### `VAPT-WEB-*` — browser surface

| ID | Tier | The attack |
|---|---|---|
| `VAPT-WEB-01` | `[NN]` | **XSS.** A stored or reflected value reaches an HTML, attribute, URL, or script sink and executes. Test what the *server* stores, not just what the form accepts. |
| `VAPT-WEB-02` | `[NN]` | **Client-side-only authorization.** The UI hides the control, but the underlying request still succeeds when issued directly. The hidden button is not a permission. |
| `VAPT-WEB-03` | `[NN]` | **Credential exposure in the client.** Session token in `localStorage`, a secret/API key inlined into the built bundle, PII in a client-side log. |
| `VAPT-WEB-04` | `[NN]` | **CSRF / unsafe cross-origin state change.** A state-changing request succeeds without an anti-CSRF token or an equivalent `SameSite` guarantee. |
| `VAPT-WEB-05` | `[D]` | **Unsafe navigation.** Open redirect, unvalidated `postMessage` origin, `target="_blank"` without `rel="noopener"`. |

### `VAPT-CFG-*` — config and transport

| ID | Tier | The attack |
|---|---|---|
| `VAPT-CFG-01` | `[NN]` | **CORS.** A credentialed request from an unintended origin is accepted — reflected `Origin`, wildcard with credentials, a too-loose regex. |
| `VAPT-CFG-02` | `[D]` | **Missing security headers** on the surface this change ships — CSP, `X-Content-Type-Options`, frame-ancestors, HSTS. |
| `VAPT-CFG-03` | `[NN]` | **Reachable secret.** A key committed to the repo, baked into a build artifact, or written to a log. |
| `VAPT-CFG-04` | `[NN]` | **Cookie flags.** A session cookie set without `httpOnly` + `secure` + an explicit `SameSite`. |

### How this maps onto the static rules

The symmetry is deliberate — `backend-code-quality` **asserts** the control
exists; this skill **proves** it engages:

| Static (`backend-code-quality`) | Runtime (this skill) |
|---|---|
| `BE-SEC-09` authorization on every protected op | `VAPT-API-01`, `VAPT-API-03` |
| `BE-TEN-02/03` tenant derived from identity, default deny | `VAPT-API-01` cross-tenant |
| `BE-SEC-03` validate all external input | `VAPT-API-04`, `VAPT-API-05` |
| `BE-SEC-02` don't return internal fields | `VAPT-API-06` |
| `BE-SEC-08` no stack traces to clients | `VAPT-API-07` |
| `BE-SEC-05` parameterized queries | `VAPT-API-05` |

*(If `backend-code-quality` isn't installed, this column is just context — the
`VAPT-*` rules stand on their own and none of them depend on it.)*

## STEP 5 — Write the abuse cases as committed tests

**Detect the runners; never prescribe them.** Read `package.json` scripts, the
Makefile, `pyproject.toml`, `composer.json`, `go.mod`, or the CI config — the
same way ship-ticket's step 9 does. Then:

| Surface | Harness |
|---|---|
| Server request surface | The repo's test runner against an **in-process** app instance (supertest, `httpx.AsyncClient`, `httptest`, `TestClient`, Laravel/Rails request tests…) — whatever this repo already uses. |
| Browser surface | The repo's e2e/browser runner (Playwright, Cypress, …). If it has none and the class is provable at the request layer, prove it there and say so. If it's genuinely browser-only with no runner, that class is **DEGRADED by ID**. |
| Config and transport | A test that boots the app and asserts the actual response header / CORS behavior / cookie attributes — not a test that reads the config file back. |

Rules for the tests themselves:

- **Assert the refusal, not the mechanism.** `expect(res.status).toBe(404)` for
  B's object under A's token. Never assert that a specific guard function was
  called — that's `TEST-01` implementation-detail coupling and it rots.
- **Both directions.** The owner still succeeds. A test that only proves denial
  passes trivially against a broken-for-everyone endpoint.
- **No mocking the thing under attack.** Mocking the auth layer to test
  authorization tests nothing. Third-party *outbound* calls may be stubbed.
- **Name the rule in the test name** — `VAPT-API-01: user B cannot read user A's
  invoice` — so a CI failure says which invariant broke.
- **Tag them consistently** so they're greppable and runnable alone. Pick the
  repo's idiom once (a filename suffix, a describe tag, a marker) and record the
  choice in the artifact so later runs match it.
- Run the `test-quality` guard on the abuse tests before calling the gate done —
  they are test code and get no exemption. *(If `test-quality` isn't installed:
  reject implementation-detail assertions and unjustified mocks on your own
  judgment and note it.)*

## STEP 6 — Fix, then re-run

A finding is fixed in **production code**, not by loosening the test.

- `[NN]` findings: fix them. There is no citation that clears one — only an
  explicit, recorded user waiver.
- `[D]` findings: fix, or cite the documented project convention that overrides
  it. Prose about "our conventions" is not a citation. *(The library-wide
  statement of this protocol lives at
  `../code-quality/references/review-standard.md` — in short: a claim about a
  rule must name the rule, and no ID means no skip.)*
- A fix that changes production code **re-runs the repo's lint/build/test** and
  the static rules for the files it touched. Don't ship a security fix that
  broke something else.
- Re-run the abuse tests after every fix. Red → green on the same test is the
  proof; a deleted test is not a fix.

## STEP 7 — The artifact and the verdict

Write `.specs/vapt/<TICKET>.md` (GATE) or `.specs/vapt/findings.md` (AUDIT):

```
target:      http://localhost:3000 · disposable seed DB (docker compose)
mode:        GATE · strict          # strict when the ticket is security-sensitive
surfaces:    POST /api/orders · GET /api/orders/:id · OrderList component
excluded:    src/utils/format-date.ts (no trust boundary, reason 0)
principals:  anon · userA(tenantA) · userB(tenantB) · admin
degraded:    VAPT-WEB-01 — no browser runner in this repo; proved at request layer

| Rule | Surface | Verdict | Evidence |
|---|---|---|---|
| VAPT-API-01 | GET /api/orders/:id | PASS | test/abuse/orders.spec.ts:24 — B→A's id returns 404 |
| VAPT-API-04 | POST /api/orders | FIXED | accepted `tenant_id` from body; now derived from token (services/order.ts:31) |
| VAPT-API-08 | POST /api/orders | N/A  | [D], no rate limiter in this project — documented in CLAUDE.md |

signed-off: <independent reviewer>        # strict mode only
```

**PASS** ⇔ every in-scope surface has a committed test for every applicable
rule · all those tests are green · zero unfixed `[NN]` findings · every excluded
file and every degraded rule named · and, in strict mode, an **independent**
signature from an agent that did not build the code.

**FAIL** ⇔ anything else. An unfixed `[NN]`, an unexplained exclusion, a
"probably fine", or a rule marked PASS with no test behind it.

**Strict mode** is required when the ticket is flagged security-sensitive (auth,
tenancy, billing, payments, secrets). Otherwise the gate runs light: `VAPT-API-01
/02/03/06/07`, `VAPT-WEB-01/02/03`, `VAPT-CFG-03/04` — the classes that ship
silently in ordinary CRUD work.

## STEP 8 — CI enforcement (this is what makes it real)

The abuse tests run in the repo's existing test job for free — that half is
already machine-enforced.

Add one merge-blocking check in the **same slot as `nn-guard`'s CI job and
ship-ticket's GATE 4 check**: if the PR's diff touches a trust boundary (derive
the glob from where this repo's handlers, components, and config actually live —
the point is the signal, not a fixed pattern), then `.specs/vapt/<TICKET>.md`
must exist and be **PASS**. Without this, the gate is honor-system, which is the
failure mode it was built to remove.

---

## AUDIT mode — backfilling already-shipped code

`/vapt.audit` runs the same rules against the base branch, for surfaces that
shipped before this skill existed. It is **not** `security-audit`: that skill
reads the codebase in waves and reasons about it. This one runs it and attacks it,
and its output is tests. Run both — they catch different things.

Work in **risk-ordered waves**, committing tests as you go so a stopped run keeps
its value:

1. **Auth & session** — login, refresh, password reset, invite/verify, logout.
2. **Money** — checkout, webhooks, refunds, plan/entitlement changes.
3. **Tenancy** — every route taking an identifier owned by someone.
4. **Writes** — remaining state-changing endpoints.
5. **Reads** — remaining data-returning endpoints, prioritized by sensitivity.
6. **Client & config** — rendering sinks, storage, CORS, headers, bundle secrets.

Track in `.specs/vapt/`:
- `surfaces.md` — the enumerated inventory with a wave and a status per surface.
  This is what makes the audit resumable across sessions.
- `findings.md` — findings with rule ID, severity, surface, and status.

Stop each wave and report before starting the next; a CRITICAL finding stops the
sweep entirely, because the fix may invalidate everything downstream of it.

Audit findings are **fixed in their own PRs**, sized by severity — not folded
into whatever feature ticket happens to be open. Follow the STEP 1 disclosure
rule: exploitable paths go to the user privately before anything public.

## Companion degradation

| Companion | Contributes | If missing |
|---|---|---|
| `backend-code-quality` | `BE-SEC-*` static mapping; the tenancy model | The `VAPT-*` rules stand alone; you lose the "static asserted it, runtime proved it" pairing — note it. |
| `test-quality` | `TEST-*` guard on the abuse tests | Reject implementation-detail assertions and unjustified mocks yourself; note it. |
| `security` | Write-time patterns for the fix | Apply the fix from the rule's own description; note it. |
| `security-audit` | Static whole-surface complement | Runtime-only coverage — say so; a passing VAPT run is not a security audit. |

Never skip a gate silently. A degradation you did not declare is itself a
failure, not a shortcut.

## Stop and tell the user

- The only reachable environment is **production or shared staging** (STEP 1).
- The app **cannot be run locally** at all — no harness means no runtime
  evidence, and the whole gate would be theater.
- An `[NN]` finding **cannot be fixed** within the ticket's scope (it's an
  architectural problem) — surface it; do not waive it yourself.
- A fix would require changing **auth, tenancy, or billing architecture** — that
  is a decision, not a patch.
- AUDIT mode finds an **exploitable vulnerability in shipped code** — report it
  privately, immediately, before continuing the sweep.

## What this skill does not do

- **Write secure code in the first place** — that's `security`. This runs after.
- **Enforce static rules on the diff** — that's `backend-code-quality`
  (`BE-SEC-*`) at ship-ticket's GATE 3.
- **Read the whole codebase for vulnerabilities** — that's `security-audit`.
- **Test functionality** — the repo's own unit and integration tests own that.
  Every test this skill writes asserts a *refusal* or a *leak*, never a feature.
- **Run scanners.** No SAST/DAST/dependency tooling is invoked; if the project
  has such tooling, it's complementary, and this skill neither replaces nor wraps it.
- **Touch infrastructure you don't own.** Ever. See STEP 1.

## Success criteria

Working when: every trust boundary a change introduces has a committed,
rule-named abuse test that failed before the fix and passes after; every excluded
file and degraded rule is named in the artifact; no `[NN]` finding ships
unfixed or unwaived; and a merge-blocking CI check — not an agent's summary —
is what actually stops a regression.
