---
name: code-quality
description: |
  Code quality for ANY language: Clean Code, SOLID, DRY, KISS, YAGNI and
  LLM failure-mode checks, plus enforced stack rules (Angular NG-*, backend
  BE-*: security tiers, tenant isolation, webhook safety) behind a Design
  Contract gate and an evidence-backed Verification Pass. Writes a
  .code-quality.md constitution and runs a reactive guard pass (MODE D). Loads
  only the stack reference the task needs.

  Trigger when:
  - the user says "set up code quality", "review my code", "review this PR", "is
    this safe to merge?", "make this cleaner", "audit this code", "refactor this",
    "fix this bug", or "create a component/service/function/endpoint"
  - creating or reviewing a component, service, endpoint, route, middleware,
    webhook handler, or migration; or code touching auth, database access,
    multi-tenancy, or background jobs
  - starting ANY code task in a project that has no .code-quality.md
  - the user types /cq.init, /cq.load, /cq.update, or /cq.guard
  - after writing/editing/refactoring non-trivial code — run the MODE D guard
    before presenting, without being asked

  Do NOT use for: factual/conceptual questions, CI/tooling config, git workflow,
  prose writing, or data analysis.
---

# Code Quality

One skill, any stack. This file dispatches the mode, routes the stack, and holds
the gates every stack shares. Stack rules live in `references/` and load only
when the task needs them.

## Modes

Four modes:

| Mode | When | Command |
|---|---|---|
| **Init** | No `.code-quality.md` exists yet | `/cq.init` or start coding |
| **Load** | `.code-quality.md` already exists | `/cq.load` (auto on session start) |
| **Update** | Stack or rules changed | `/cq.update` |
| **Guard** | After code was written/edited, before presenting or committing | `/cq.guard` (also run proactively) |

Building or reviewing code runs STEP 0 → STEP 0B → the stack's rules → the
Verification Pass.

---

## Stack routing and LOAD TABLE

Detect the stack from the diff, `CLAUDE.md` and the manifests. Read only what the
situation needs. **Security rules are never progressive:** a backend diff loads
the whole of `references/stack-backend.md`, never a part of it. Backend code in
any language (Node, PHP/Laravel, Python, Go, Rust, Java, C#) is always backend:
it loads `stack-backend.md`, never only the core.

| Situation | Load |
|---|---|
| Any review or build | this file + `references/universal-principles.md` + `references/ai-failure-modes.md` |
| Angular | + `references/stack-angular.md` (`NG-*`) |
| UI with a design reference | + `references/angular-design-fidelity.md` |
| Any backend, any language | + `references/stack-backend.md` (`BE-*`) |
| Webhook / tenancy / PostgreSQL RLS | + `references/backend-webhook-safety.md` / `references/backend-multi-tenancy.md` / `references/backend-postgres-rls.sql` |
| No `CLAUDE.md` to read | + `references/angular-profile-template.md` or `references/backend-profile-template.md` |
| Full-stack | both stack references, one Design Contract (STEP 0B) |
| Other frontends and non-backend code (React, Vue, Svelte, libraries, CLIs, any language) | the core only; per-stack summaries via `references/constitution.md` |
| INIT / LOAD / UPDATE | + `references/constitution.md` |
| GUARD | + `references/guard.md` |
| Findings or a formal review | + `references/review-standard.md` |

Stack-specific supplements (test-runner references, profile templates) are
listed at the end of each stack reference.

---

## Rule Tiers

Every rule below carries one tier marker. The tier decides who may override it.

| Tier | Meaning | Who may override |
|---|---|---|
| `[NN]` | **Non-negotiable.** Security or correctness invariant. | Nobody per-file. Only an explicit, recorded user waiver — and you state the risk when you record it. |
| `[ARCH]` | **Architectural.** The system's design shape. | `CLAUDE.md`, **project-wide only**. Never per-file, never "just this once". |
| `[D]` | **Default.** Convention with a sane fallback. | `CLAUDE.md`, or an established repo convention. |

The distinction that matters: `[ARCH]` rules may be *replaced across the project*; they may
never be *skipped in one file*. A second pattern for the same concern is drift, not pragmatism.


---

## STEP 0 — Rule Precedence

Conflicts are resolved here, before implementation — never mid-file.

1. `[NN]` invariants
2. `CLAUDE.md` project conventions
3. This skill's `[ARCH]` rules **and** the `code-quality` hub's core
   (`universal-principles.md`, `ai-failure-modes.md`) — applied **jointly**, not
   ranked. This skill builds on that core; where both speak, both apply.
4. This skill's `[D]` defaults
5. Existing repo convention (match it) — only where 1–4 are silent
6. Convenience, speed, "simpler for now", "we'll refactor later" — **never a tiebreaker**

If 1 and 2 collide, stop and say so. Do not pick one silently.

**When an `[ARCH]` rule and the core genuinely collide.** They usually don't —
`[ARCH]` prescribes a structure, the core asks whether the structure earns its
keep. But one collision is real and recurring: the rule says *build this
abstraction*, while the core says **never introduce a second pattern for
something the repo already does one way** (Clean Code "match the neighbors") and
flags one-implementation interfaces and pass-through adapters on sight (YAGNI).

Resolving it is a **four-condition test, and all four must hold**:

1. **Evidence covering the rule's full applicability — not "the concern".**
   "Concern" is whatever you decide it is, which is exactly the loophole. Derive
   the search universe from **the cited rule's own text**: `NG-ARCH-04` governs
   *every* `HttpClient` injection, so the evidence set is every injection site in
   the repo, not every list screen. Record the **search method** and **every
   exclusion with its reason**. A subset silently narrowed to the sites that agree
   is not evidence.
2. **Ratified at project level, or by the user.** Uniformity proves prevalence,
   not correctness — a uniformly bad legacy system is uniformly bad. Accept only:
   a **project-level architecture source that predates this ticket** (`CLAUDE.md`,
   an ADR, an architecture doc), **or explicit ratification by the user** for this
   ticket. **A code comment is not ratification** — a docblock asserting the choice
   is deliberate can be written, or cited, by whoever wants the rule switched off.
   It may *support* a project-level source; it can never stand alone.
3. **The rule protects structure, not safety — judged by effect, not by list.**
   This resolution is **forbidden wherever the rule directly enforces or isolates
   any security, privacy, availability, or integrity control**, *regardless of its
   tier letter*. Non-exhaustive examples: authentication, authorization, tenancy,
   validation, idempotency and replay protection, secrets and credential handling,
   cryptographic or signature verification, output safety, auditability, rate
   limiting, data integrity. **The list is illustrative — the test is the effect.**
   If switching the rule off would remove or weaken a control, it is a safety rule
   whatever its label says, and this resolution does not apply. `[NN]` rules are
   always excluded.
4. **The alternative would genuinely be a second pattern** — building it here
   adds a competing way to do something the repo already settles, rather than
   filling a gap.

All four hold → **the rule does not fire.** Fewer than four → it stands, and the
normal Deviation Protocol applies.

**Record it, even though it is not a waiver.** There is no violation to waive, so
it does not enter the deviation ledger — but it must not vanish either, or
nothing shows the four conditions were ever checked. Emit a Verification Pass row:

```
NG-ARCH-04 | NOT_APPLICABLE — replaced by established project architecture
           | evidence: grep -rn "inject(HttpClient)" src/ -> 11/11 sites are feature
           | services; 0 in components; 0 exclusions
           | ratified: CLAUDE.md "Data access" section (predates ticket)
           | effect test: transport wiring; enforces no security/privacy/
           | availability/integrity control
```

Same shape for `BE-*`. The row carries the rule ID, the enumerated evidence, and
the resolved pattern.

What this does **not** license: skipping an `[ARCH]` rule because one file finds
it inconvenient, or because the repo is merely *inconsistent* here. If the repo
has no settled pattern, levels 3 and 4 apply normally.

Backend wording of Rule Tiers and STEP 0: `references/stack-backend.md`.

---

## STEP 0B — Emit the Design Contract (hard gate)

**You may not write a line of code for a file that does not appear in this contract.**
This is the mechanism that prevents diversion: classification precedes construction.

Each stack reference carries its contract shape: `stack-angular.md` (file, MVVM
role) and `stack-backend.md` (unit, layer, security tier). The rules under each
shape are part of this gate.

**Code with no stack reference** (other frontends and non-backend code: React, Vue,
Svelte, libraries, CLIs, in any language) uses
this shape:

```
file path | why it exists (the build-sequence step) | its role in this repo's
own architecture | the rules in force for that role
```

Roles come from the repo's actual layout, not from a framework this skill
prefers. The rules in force are every `[NN]` rule, plus the universal core,
plus whatever the repo's own conventions document requires.

**Full-stack: one contract.** Compose rather than concatenate: **one table, one
row per file, each row carrying the role vocabulary of the side that owns it.** A
file appears exactly once. Two tables mean two half-reviews, and a rule that fell
between them is invisible.

---

## STEP 0C — Deviation Protocol

When a rule cannot be followed:

1. **STOP.** Do not implement the deviation.
2. State: the **rule ID**, what blocks it, and two options with their costs.
3. Wait for the user.
4. If waived, record it: Angular and backend in the stack reference's STEP 0C
   ledger (with its never-acceptable list); code with no stack reference as in
   Rules for Claude, **No silent drift**.

---

## Verification Pass (hard gate)

The old checkbox list is gone. An unchecked box proves nothing; a box you tick yourself proves
less. Before declaring done, emit this table. **Evidence is a file path, a line, or a clause —
not the word "yes".**

Each stack reference gives its table example, which rules are in force, its
`TEST`/`DOC` rows and its fast mechanical checks (Angular STEP 8, backend
STEP 11). The table shape:

```
VERIFICATION
| Subject ID | Outcome | Evidence |
|---|---|---|
```

Rules:
- **Any FAIL blocks done.** Fix it, or run the Deviation Protocol. Do not report and ship.
- **NOT_APPLICABLE requires a reason.** The token without a clause is a skipped check.
- **One `AI-FM` row is always in force**: walk the 15 LLM failure modes + The Floor
  (`references/ai-failure-modes.md`) against the diff and report it like any
  other rule — `AI-FM | PASS | no catch-alls, no mock returns, imports verified` — or FAIL with
  the offending mode named. These catch what NG-* rules can't: the model's own biases.
- **One `UNIVERSAL` row is always in force**: walk
  `references/universal-principles.md` against the diff — naming, function
  size, SOLID smells, DRY, complexity ceilings, YAGNI — and report it like any
  other rule, with evidence, or FAIL naming the principle.
- **Code with no stack reference** reports the `UNIVERSAL` and `AI-FM` rows
  plus one row per rule of the project's `.code-quality.md`, each with evidence.
- **Scope discipline**: the pass verifies the diff, not the repo — pre-existing violations in
  untouched files are flagged only in an explicit audit, marked `pre-existing`. Full findings
  contract: `references/review-standard.md`.

---

## Project files (legacy paths are protocol identifiers)

Read and write these unchanged; no project migrates: `.code-quality.md`,
`.claude/angular-code-quality/{profile,deviations}.md`,
`.claude/backend-code-quality/{profile,deviations}.md`,
`.claude/hooks/nn-guard.sh`, `.claude/nn-guard/exclude`.

---

## Rules for Claude

- **Load before code**: Always read `.code-quality.md` before writing any code in the project
- **Constitution wins**: If `.code-quality.md` contradicts this SKILL.md, the constitution wins
- **No silent drift**: If asked to violate a rule, flag it explicitly and ask for confirmation.
  A granted exception is documented in a code comment naming the rule, the reason, and a
  **revisit trigger** (the condition under which to reconsider) — an exception with no exit
  is just deferred debt, and shows up as a finding on the next guard pass
- **Guard before presenting**: MODE D runs after every non-trivial code change — it is part
  of finishing the task, not an extra the user must request
- **Keep it lean**: The constitution should be actionable checklists, not a textbook
- **Inline bash only**: All bash runs inline — never reference external `.sh` files that may not exist
- **Temp file pattern**: Use `mktemp` + `mv` for writing constitution to avoid multiline arg issues

## What this skill does not do

- Test-code review — `test-quality` owns TEST-* (this skill only carries the wiring row).
- Docs accuracy — `docs-accuracy` owns DOC-* (wiring row only).
- Security *audits* — `security-audit` owns whole-surface scans (deployment facts it cannot see become `needs_validation`); this skill enforces NG-SEC-*, BE-SEC-*/BE-AUTH-* on the diff.
- Run linters/type-checkers/tests — it's the judgment layer above the tooling.
- Deterministically block a PR — that's `nn-guard` (hook + CI).

## Success criteria

Working when: a new project gets a tailored `.code-quality.md`; every later
session loads it in one line; the MODE D guard runs after non-trivial changes
without being asked; and Angular/backend work runs its stack reference's gates
rather than being half-reviewed.

## Troubleshooting

- **CLAUDE.md and an `[ARCH]` rule disagree:** CLAUDE.md wins project-wide (STEP 0),
  but never per-file — a second pattern for one concern is drift.
- **Verification Pass feels heavy for a tiny change:** only rules named in the
  Design Contract (plus every `[NN]`) need a row — not the whole catalogue.
- **Constitution and this SKILL.md disagree:** the constitution wins.
