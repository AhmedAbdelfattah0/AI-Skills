# Ticket template — copy this structure for every generated ticket

> Fill every section. Delete a section only if it is genuinely N/A (e.g. no
> "Design source of truth" on a pure-backend ticket). Keep the headings so the
> downstream implementer and the ship-ticket skill find what they expect.
> Anything you could not verify becomes `**[TODO-VERIFY: …]**` inline AND a line
> in **Recon required**.
>
> **`<KEY>` below means: a real tracker key if you have one, otherwise the
> `<slug>` of another ticket in this generated set.** Never fill it with an
> invented key-shaped string — a fake key reads as real and is the exact
> phantom-reference failure this template guards against.

---

## Summary

`<Action-first one-liner. Name the thing concretely.>`

**Type:** Task | Story | Bug | Epic — *(use the project's real issue types; read them from the tracker)*
**Priority:** Highest | High | Medium | Low — `<one-line reason>` — *(map to the project's actual scheme; AZ uses 1–4)*
**Suggested labels:** `<comma-separated>` — *(no sprint label, no story points, no effort estimate — never invent planning metadata)*
**Epic / Parent:** `<real KEY if the epic exists, else — and note "set after the epic is created">`

---

## Context / why it matters

`<What is broken, missing, or needed, and the user-facing or business consequence.
2–5 sentences. Enough that an implementer understands the intent, not just the
mechanics — this is what lets them make good calls under ambiguity.>`

---

## Blockers & dependencies

- **Blocked by `<KEY>`** — `<what it provides>`; `<why this can't start without it>`.
- **Depends on `<KEY>`** — `<what this consumes from it>`.
- **Same-file contention:** touches `<path>` — conflicts with `<KEY>`; sequence, do not parallelise. *(omit if none)*
- `<or: "None — ready to start.">`

---

## Design source of truth  *(UI tickets only)*

- **Reference screen(s):** `<file path(s) to build against>` — GATE 4 applies; pin the SHA before building.
- **Token / theme file:** `<path>`
- **Conventions doc:** `<path or "none — follow CLAUDE.md">`
- `<If any unknown: **[TODO-VERIFY: locate design reference for X]** and add a Recon line.>`

---

## Scope / what to build

`<The detailed body. Use sub-sections. Be concrete.>`

### API  *(if applicable)*
- `METHOD /path` — purpose; request fields; response shape; auth/tenant scope.

### Database  *(if applicable)*
```sql
-- table with columns, types, constraints, indexes, RLS note
```

### UI  *(if applicable)*
- Structure, each state (empty / loading / error / populated), interactions,
  which shared components to compose.
- **i18n / direction:** name the project's **actual** locales and text direction
  (read them from the i18n config or `CLAUDE.md`) — e.g. "EN/AR, RTL mirroring
  required" for a bilingual RTL project, or omit this line entirely for a
  single-locale LTR one. Don't copy a locale set from this template.

### Behavior / logic
- The rules, the edge cases, the exact expected behavior.

---

## Defect report  *(Bug tickets — use INSTEAD of "Scope / what to build")*

**Steps to reproduce**
1. `<starting state — logged in as whom, which tenant/env, what data>`
2. `<exact action, with the exact input used>`
3. `<...>`

**Actual:** `<observed behaviour — paste the real error text / response, don't paraphrase>`
**Expected:** `<and what says so: spec, design ref, an AC on <KEY>, a documented invariant>`

**Environment & blast radius**
- Version / branch / commit: `<...>` · Runtime / browser: `<...>`
- Only reproduces for: `<tenant / role / locale / device — or "all">`
- Affected: `<how many users, rows, orders — or "unknown, needs measuring">`

**Regression window**
- Did it ever work? `<last known-good version, and the suspect change — or "unknown">`

**Evidence**
- `<stack trace / failing request+response / log line / screenshot path>`

**Suspected cause** *(optional — label it a hypothesis, never state it as a finding)*
- `<hypothesis, and what would confirm or kill it>`

---

## Invariants & security

- **Single-writer:** `<which authoritative path owns this write; who must NOT write it>`.
- **Tenant isolation / RLS:** `<how tenant scope is enforced; server-side ownership checks>`.
- **Fail-closed:** `<secrets/config that must deny when missing>`.
- **Validation:** `<what is validated server-side and never trusted from client>`.
- **Idempotency / audit:** `<retryable paths, audit logging>`.
- **Security-sensitive?** `<yes/no — if yes, ship-ticket routes to its strong model>`.
- `<omit lines that don't apply; keep the ones that do>`

---

## Out of scope

- `<Thing this deliberately does NOT do>` → owned by `<KEY>`.
- `<...>`

---

## Acceptance criteria

> Every line must be **objectively checkable** by a reviewer who didn't write the
> code. Banned: "works correctly", "is performant", "handles errors gracefully",
> "code is clean" — none of those can fail. Name what is observed and what makes
> it pass.

- [ ] `<Objectively checkable outcome — happy path>`
- [ ] `<Each invariant above, as a verifiable check>`
- [ ] `<Edge cases>`
- [ ] `<UI only: the project's locales/direction render correctly — omit if single-locale LTR>`
- [ ] `<Cross-tenant / security regression test if security-sensitive>`
- [ ] `<the project's REAL build/lint/test command>` green — read it from
      `package.json`, `CLAUDE.md`, the Makefile, or CI; do not copy a command
      from this template or the example
- [ ] `<UI only: GATE 4 parity passed against pinned SHA, per screen/template>`

**Bug tickets add, and lead with:**

- [ ] `<The repro steps above no longer produce the actual behaviour>`
- [ ] `<A regression test that FAILS before the fix and PASSES after — name it>`
- [ ] `<Root cause fixed, not the symptom — or, if this is deliberately a
      mitigation, say so and name the ticket that does the real fix>`

---

## Recon required

> Everything the generator could not verify. Empty is good.

- **[TODO-VERIFY]** `<assumption>` — check via `<command / file / person>`.
- `<or: "None — all assumptions verified against the repo/docs.">`

---

## Links

- Related: `<KEYs>`
- Blocks: `<KEYs>` · Blocked by: `<KEYs>`
- Source: `<doc/spec path>` · Design: `<ref path>`
