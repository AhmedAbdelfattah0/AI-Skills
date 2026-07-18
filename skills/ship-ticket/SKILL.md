---
name: ship-ticket
description: |
  Implement a Jira ticket end-to-end: locked stack + SOLID, tiered model/cost
  routing, a mandatory design-source-of-truth read, a plan-mode gate (planned in
  Claude Code plan mode and user-approved before implementation; the approved
  plan is saved to .specs/plans/), a pinned + independently-verified +
  CI-enforced design-parity gate, the two-pass review flow, and full close-out
  (PR + Jira Done + session log + compact). Takes one argument: the Jira ticket
  key or URL.

  Trigger when the user:
  - types /ship-ticket or /ship.ticket
  - says "ship ticket", "implement ticket", or "build ticket"
  - gives a Jira ticket key or browse URL (e.g. SCRUM-28 or DAT-15) and asks to
    implement, build, or ship it
---

# /ship-ticket — implement a Jira ticket end-to-end

The user invokes this with a single argument: a **Jira ticket key or URL**
(e.g. `SCRUM-28`, `DAT-21`, or a full `…/browse/SCRUM-28` link). Run the full
workflow below for that ticket. Reusable across projects/instances — do **not**
hardcode any cloudId, site, or project; use whatever Atlassian connection is
available and resolve the key/URL the user gave.

## Step 0 — read the ticket first (hard gate)

Fetch and read the ticket's **full spec** before doing anything. If you cannot
fetch it (auth/IP error, wrong instance, missing permission), **STOP and tell
the user** — do not guess the spec, do not proceed.

## Step 0.5 — read AND pin the design source of truth before writing any UI (hard gate)

For any ticket that produces or changes UI, you MUST read the project's design
system **before writing a line of frontend code** — and you must actually open
the files, not skim the ticket's description of them. This step exists because
"there's a design reference" is worthless if the implementer never reads it;
available ≠ consulted. Treat this as a gate equal to Step 0.

**The design reference is not one file, and not one format.** Depending on how
the project's design was produced (see the `design-prompts` skill), it may be:

- a **Claude Design set** (`*.dc.html` screen + component files), or
- a **self-contained HTML showcase** (one file per surface, pages as
  `<section>` blocks), or
- **component files** (`.jsx / .tsx / .vue / …`), or a mix.

In **every** case there are three things you must open, in this order:

1. **The token / theme file** (e.g. `tokens.css`, `theme.*`, design-tokens).
   This is the single source of color, spacing, type, radius, and elevation.
   It is almost always the *most* important file and the one most often skipped.
2. **The conventions / Master-Orientation doc** if one exists (shared brand
   rules, RTL/bilingual rules, numeric-isolation rules, component inventory).
3. **The specific referenced screen AND the shared components it composes**
   (its table, form, drawer, pagination, banner, field-renderer, etc.).

**Self-locate the design system — do not depend on the ticket naming it.**
If the ticket doesn't point at the design files (or names them incompletely),
search the repo yourself: look for a token/theme file, a `design/` or
`design-files/` directory, a component library, or a Master-Orientation doc.
The read is mandatory even when Jira forgets to reference it. If UI is in scope
and you genuinely cannot find any design system, **STOP and ask the user** where
it lives — do not invent a visual language.

### Pin the reference (hard requirement — this is what makes GATE 4 real)

A parity check against a *moving* reference passes vacuously. So before building:

- **The reference must be committed to git before you build.** If the reference
  screen(s) you'll build against are not committed (uncommitted working-tree
  files, or not in the repo at all), **STOP** — there is no SHA to diff against
  later, and a screen closed against an uncommitted reference is unverifiable.
  (This is the SCRUM-108 failure: the ticket closed 46 minutes *before* its own
  reference was committed. Nothing could have diffed it.)
- **Record the pinned SHA.** Capture `git rev-parse HEAD -- templates/<app>` (or
  the repo HEAD SHA if the reference isn't isolated to a path) as `design_ref`.
  Write it in **two** places: the session log (Step 9) and the `design_ref:` line
  of the GATE 4 artifact. GATE 4 diffs against **this SHA**, not "latest" — so the
  result is reproducible and a later reference edit becomes a *detectable* event
  rather than a silent invalidation of a closed screen.

> **Companion control (proposed, not built here):** a scheduled drift-detector that
> walks every Done UI ticket's `design_ref` and auto-opens a `parity-reaudit` when
> the reference tree has changed since that SHA. Out of band from this per-ticket
> workflow; noted so the reason for pinning is legible. Until it exists, the pin +
> GATE 4 is the load-bearing move.

**Then build by composition, not by approximation:**

- **Compose the shared components.** "Reimplement in the app framework" means
  *reuse the existing components* (table, input, drawer, pager, badge, …) and
  supply columns / rows / field configs — it does **not** mean hand-roll
  equivalents from raw markup. Hand-rolled tables/inputs/pagers are the #1 cause
  of style drift, column collisions, and clipped controls.
- **Zero hardcoded color** outside the token file. All color / spacing / type /
  radius come from tokens. This is lint-enforceable — prefer to enforce it.
- **Respect the documented conventions** — bilingual/RTL handling, and isolating
  numbers, IDs, dates, prices, and store numbers LTR inside RTL text.
- **Deficient-reference carve-out.** If a shared design component is itself
  defective (e.g. a paginator that renders every page number with no windowing),
  fixing the component at its source takes precedence over literal fidelity.
  Note it, fix the component, and flag it to the user. In GATE 4 this is an
  *accepted deviation* — it still needs the human sign-off, not a self-waiver.

Reading Step 0.5's files is not optional context-gathering; skipping it is a
failure of the gate. If challenged later on why the UI matches the design, you
should be able to point to the pinned SHA, the token file, and the component
files you opened here.

## Step 0.75 — Plan in Claude Code plan mode (hard gate; every ticket)

Planning is STRONG-model work (see Model / cost routing) — this step is where it
actually happens, not an assumption. The ticket and the design reference have
been read; now decide **what to build and how to sequence it** before any Design
Contract or code. The plan is also the handoff object that makes the model
tiering real: STRONG plans, MEDIUM builds from the plan.

**Use Claude Code's native plan mode — this is the gate's mechanism:**

1. **Enter plan mode now** (the `EnterPlanMode` tool). From here until approval,
   you research and plan only — no file edits, no code. Plan mode enforces that
   mechanically, which is the point: the gate doesn't rely on your restraint.
2. Draft the plan **using exactly the template below** — same headings, same
   order, so every plan reads the same way.
3. **Present it through plan mode's approval flow** (`ExitPlanMode`). The user
   approves, edits, or rejects in the native UI. **Implementation starts only on
   approval** — an edited plan is the new plan; a rejection sends you back to
   step 2, not into the code.
4. **Immediately after approval, save the approved plan verbatim to
   `.specs/plans/<TICKET>.md`** (committed with the PR, like the GATE 4
   artifact). Plan mode itself persists nothing — this file is the durable
   record that the Design Contract derives from, the session log references,
   and the PR carries.

**Fallback — plan mode unavailable** (headless / workflow / subagent runs):
write the plan artifact and **STOP**, surfacing sections 1–3 as the approval
ask. Proceeding without an approval is a Stop-on-failure violation, not a
judgment call — a plan approved only by its author is not approved.

```markdown
# Plan — <TICKET>: <ticket title>

**Size:** <N> files · <FE / BE / full-stack> · security-sensitive: <yes/no>

## 1. What & why (read this first)
<2–4 plain sentences: what the user gets when this ticket is done, and the
chosen approach in one line. No jargon — write it for the person approving,
not for the builder.>

## 2. Build sequence
| # | Step (plain words) | Files touched | Depends on |
|---|---|---|---|
| 1 | Add the state service for X | features/x/services/x-state.service.ts | — |
| 2 | Build the X list screen | features/x/pages/x-list.page.ts (+html/scss) | 1 |

## 3. Risks & unknowns
| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| <e.g. spec doesn't say what happens on empty results> | blocks the empty state | ask user / assume Y and flag it |

<or: "None found — checked <what you checked>.">

## 4. How I'll prove it works
- <one bullet per build step: the test or check that shows it's done>
- <security-sensitive: the failing test that comes FIRST>
- <tests assert behavior, not implementation — per the test-quality skill>

## 5. Not in this ticket
- <explicitly out of scope — feeds Scope discipline>

## 6. Rejected alternative
<one line: the other approach considered, and why not>
```

Formatting rules that keep it readable:

- **Section 1 is the approval surface.** A reader should be able to approve from
  sections 1–3 alone, in under a minute. Everything below is for the builder.
- **Plain words in the "Step" column** — "Build the login form", not
  "Instantiate the auth presentational component per NG-ARCH-03". Rule IDs and
  MVVM roles belong in the Design Contract, not here.
- **Tables, not paragraphs**, for sequence and risks — they're scannable and
  they make an empty risks table impossible to fake ("None found" must name
  what was checked).
- **Short beats complete.** A plan nobody reads gates nothing. If the ticket is
  big, the build-sequence rows get more numerous — the prose does not get longer.

**The plan constrains the contract.** The Design Contract (STEP 0B) emitted next
draws its file list from the approved plan's build sequence. A file needed by
the contract but absent from the plan means the plan was wrong — a **material**
divergence (new files, changed approach, new risk) goes back through plan mode
for re-approval and updates `.specs/plans/<TICKET>.md`; don't silently build
past the plan the user approved.

## Locked stack

- **Frontend tasks:** Angular + Signals, MVVM, standalone + OnPush,
  component-scoped SCSS, EN/AR i18n. Follow the `angular-code-quality` skill —
  it owns the `NG-*` rule set.
- **Backend tasks:** Hono on Cloudflare Workers, Supabase + RLS, service-layer
  logic (not in routes). Follow the `backend-code-quality` skill — it owns the
  `BE-*` rule set.
- **Full-stack tickets:** one skill, one Design Contract, one Verification Pass
  covering both sides — never two uncoordinated halves.
- Always follow `CLAUDE.md`.
- The ticket itself decides whether it's FE, BE, or both — invoke
  `angular-code-quality`, `backend-code-quality`, or both accordingly (the
  "code-quality family"); each routes from its cached profile.

### Rule IDs and tiers (used throughout this workflow)

The code-quality family assigns every rule a stable ID (`NG-ARCH-03`, `BE-WHK-04`, …)
and one tier:

| Tier | Meaning | Override |
|---|---|---|
| `[NN]` | Non-negotiable security/correctness invariant | Never, per-file. Only an explicit recorded user waiver. |
| `[ARCH]` | Architectural shape | `CLAUDE.md`, project-wide only |
| `[D]` | Default convention | `CLAUDE.md` or established repo convention |

This workflow depends on those IDs in three places: the Design Contract before
implementation, the review passes below, and the session log at close-out. **A claim
about a rule cites the rule.** Prose about "our conventions" is not a citation.

**Note on design parity vs. rules.** Rule IDs govern *code correctness/convention*.
Structural/visual parity against the reference screen maps to **no lint-rule ID** —
so its "citation" (GATE 4) is a named design decision + a human approver, not an ID.
Don't conflate the two: passing every `NG-*`/`BE-*` rule does not mean the screen is
the design.

**Invoke the code-quality-family skill now — load it, don't just recall it.**
Based on the ticket (FE / BE / full-stack), invoke `angular-code-quality`
and/or `backend-code-quality`. The chosen skill governs this build end to end:
its rules apply to every line, its **Design Contract (STEP 0B)** gates every
file, and its **Verification Pass is GATE 3** below. Both specialists build on
the `code-quality` hub's universal core (`ai-failure-modes`,
`universal-principles`, `review-standard`) — so "invoke the specialist" invokes
that core too. This is not optional context; a build that never loaded the
skill has no Design Contract and cannot produce GATE 3.

Then run its **Design Contract** gate (STEP 0B), deriving the file list from the
Step 0.75 plan's build sequence. No file gets written that isn't in the contract.

## Apply SOLID throughout

- **Single responsibility:** one reason to change per class/service/component.
  FE = smart container vs presentational split; BE = route → service → data
  layer, no business logic in routes.
- **Open/closed:** extend via new strategies/implementations, not by editing
  working code (e.g. payment gateways, shipping carriers = strategy pattern).
- **Liskov:** implementations of an interface are truly substitutable.
- **Interface segregation:** small focused interfaces/inputs, not god objects.
- **Dependency inversion:** depend on abstractions; inject dependencies
  (Angular DI / injected services), don't hardcode concretions.

## Model / cost routing (when spinning up subagents/workflows)

Tier models by task difficulty to reduce token cost (the user runs on ultra
effort; this may run in workflow mode):

- **SMALL/fast (Haiku)** — gathering + mechanical work: reading/exploring files,
  inventorying the codebase, grep/trace, collecting context, simple repetitive
  edits.
- **MEDIUM (Sonnet)** — most implementation: writing standard components/
  services/endpoints, wiring, tests, applying straightforward review fixes.
- **STRONG (Opus)** — reasoning-heavy work: **planning and synthesis** (Step
  0.75 — deciding what to build and how to sequence it), architecture/design decisions,
  **security-sensitive logic** (auth, tenancy, billing, payments), tricky
  algorithms, and resolving non-trivial review findings.

Match the model to the difficulty: exploration on small, routine build on
medium, planning/design/security on strong. Keep parallel subagents proportional
to the task — don't fan out more than the work needs.

**The GATE 4 parity-reviewer is a separate agent from the builder** (see below) —
that independence is the whole point of it, so never let the building agent grade
its own parity.

## Security-sensitive note

If the ticket touches auth, multi-tenancy, billing, payments, or any
cross-tenant isolation, treat it as security-sensitive: do that reasoning on the
strong model, and prefer a test-first repro (write the failing test that proves
the correct/secure behavior, then implement). Any DB migration must be additive
and committed to Git as a numbered file.

## When implementation is complete

1. Run lint, build, and Vitest — fix any failures. **Tests green ≠ tests good:**
   run the `test-quality` guard pass on the test diff before GATE 3 — a must-fix
   TEST violation (TEST-01/02/08: implementation-detail assertions, unjustified
   mocks, mocked state objects) blocks the review passes like any FAIL.

2. **GATE 3 — Code-Quality Audit.** This is the post-implementation audit by the
   code-quality family — the skill actually reviewing what you built, not a table
   filled from memory. It has two parts and both must pass before the review
   passes run:

   **a. Verification Pass (per-rule, on the contracted files).** Run the invoked
   specialist's Verification Pass. Emit the `rule → PASS/FAIL/N-A → evidence`
   table. Evidence is a file path, a line, or a clause — never the word "yes".
   **Any FAIL blocks the review passes.** Every `[NN]` rule is always in force and
   always appears; the always-on `AI-FM` row (15 LLM failure modes + The Floor)
   and the `TEST`/`DOC` rows (when the diff touches tests/docs) are part of it.

   **b. Guard sweep (whole diff).** Beyond the contracted files, run the
   `code-quality` hub's **MODE D guard** reasoning over the *entire* diff — the
   `universal-principles` + `ai-failure-modes` walk — to catch what a per-rule
   table scoped to the contract can miss (a stray catch-all, a mock-success
   return, a speculative flag in a file the contract didn't foreground). Report
   findings in the `review-standard` shape (`file:line` + quoted code + fix);
   fix must-fix findings here, before review.

   For UI tickets the pass includes the mechanical Step 0.5 rules: the screen
   composes the shared components (`NG-UI-01`), no hardcoded color outside the
   token file (`NG-UI-02`), bilingual/RTL + numeric LTR-isolation per the
   conventions doc (`NG-UI-03`). These prove the code follows the design **rules**.
   **Structural/visual parity against the reference is NO LONGER self-attested
   here** — it is proven by GATE 4 below. Fix rule drift here; do not ship it to
   review.

3. **GATE 4 — Design-Parity Close-out (UI tickets only; hard gate, independently
   verified, CI-enforced).** This is the return leg of Step 0.5: Step 0.5 read and
   *pinned* the reference; this proves the built screen **is** that reference. Skip
   on tickets with no UI; **never** skip on a UI ticket.

   **Scope — per OWNED screen, not per consumer.** GATE 4 fires for the screen(s)
   this ticket exists to build. It does **not** force a node-by-node diff of every
   screen that merely consumes a shared component you touched. A shared-component
   change opens a **separate, flagged parity-sweep task** across its consumers.
   This bounds per-ticket cost and removes the incentive to under-scope "touched"
   or rubber-stamp a grade.

   **a. Produce the committed artifact** `.specs/design-parity/<TICKET>.md`. For
   each owned screen it DIFFS the implementation against the **pinned** reference
   (the `design_ref` SHA from Step 0.5) at three layers, one row per divergence
   with exact `ref file:line ↔ impl file:line` and a severity:
   - **Structure** — node-by-node: presence/absence and composition of sections,
     states (empty/loading/error), and components.
   - **Style** — class/declaration: layout, spacing, tokens, color, type, shadow.
   - **Behavior + i18n/RTL** — interactions, state, EN/AR + RTL correctness.

   Grade each screen: **Faithful** (no Blocker/Major) · **Minor** (token/spacing
   drift only) · **Major** (structural/visual divergence) · **Not-built** (a
   reference screen/section with no implementation). Reuse the parity-audit table
   shape.

   **b. The builder's grade is a DRAFT — an INDEPENDENT reviewer signs it.** Spin
   up a parity-reviewer that has **no build context for this screen** — a fresh
   subagent, or `/review` (step 4) extended to diff impl-vs-reference — to re-run /
   adversarially spot-check the diff against the **pinned** reference and **sign
   the grade in the artifact**. Only the independent signature counts. *The builder
   never signs their own parity grade* — a self-graded artifact just relocates the
   self-attestation this gate exists to remove.

   **c. Residual Blocker/Major clears ONLY with human approval.** A residual
   Blocker/Major divergence (including the Step 0.5 deficient-reference carve-out)
   passes **only** if the **human who merges the PR** approves it, recorded in the
   artifact as: named design decision + approver + date. Visual drift has no rule
   ID; that record IS the citation. **No self-written waiver clears a
   Blocker/Major** — ✋ STOP and surface it to the user for an explicit decision.

   **d. Link every stub.** Every `coming-soon` route this ticket introduces names
   its follow-up build ticket key in the artifact (closes the stub-and-forget hole).

   **PASS / FAIL (per owned screen):**
   - **PASS** ⇔ grades **Faithful or Minor** after fixes, **or** every residual
     Blocker/Major carries a **human-approved** accepted deviation — **and** the
     artifact carries the **independent signature** — **and** every introduced stub
     links a follow-up ticket.
   - **FAIL** ⇔ otherwise (any residual Blocker/Major with no human approval;
     missing independent signature; missing artifact; an unlinked stub).

   **Enforcement is machine, not honor-system.** A merge-blocking **CI check**
   (install it alongside the `nn-guard` CI job — same PR-side, deterministic slot)
   rejects a UI-scoped PR unless `.specs/design-parity/<TICKET>.md` exists, is
   independently signed, and is PASS. A PR is *UI-scoped* when its diff touches
   `apps/**/*.html`, `*.scss`, or component `*.ts` templates — the same signal
   Step 0.5 uses. Because Jira `Done` follows the merge (step 8), this **hard-gates
   `Done`** without relying on the agent to self-enforce — closing the "same agent
   builds it and transitions it" hole.

   If the reference wasn't pinnable at Step 0.5, you cannot run this gate — **STOP**
   (Step 0.5 must pin it first).

4. Run `/review` — for UI tickets this pass also carries the **GATE 4 independent
   parity check** (impl-vs-reference against the pinned SHA) and produces the
   independent signature, unless a separate reviewer subagent already did.
   Fix every finding, **except** a finding that contradicts a specific `[D]` or
   `[ARCH]` rule you can **name by ID**.

   **Skipping requires a citation.** Format:

   ```
   skip: conflicts with NG-STD-06 — signal two-way binding is valid for
         single-value inputs with no validation graph
   ```

   No ID, no skip — fix the finding. "It conflicts with our conventions" is not a
   citation; that sentence can be written about any finding, which is exactly why
   it must not be accepted. If you reach for the ID and the rule doesn't actually
   say what you need it to say, the reviewer was right. (This protocol's
   canonical, library-wide statement lives at
   `../code-quality/references/review-standard.md`; the full text is kept here
   so the workflow is self-contained.)

   **A finding that contradicts an `[NN]` rule is never skipped.** If a reviewer and
   an `[NN]` rule disagree, the reviewer is almost certainly right and you have a
   real problem. **STOP and tell the user** — do not skip, do not "note why".

   A skipped finding is a deviation. Record it in the invoked skill's deviations
   ledger (`.claude/angular-code-quality/deviations.md` or the backend equivalent).
   (Design-parity deviations live in the GATE 4 artifact instead — they carry a human
   approver, not a rule ID.)

5. Then run `/coderabbit:code-review`. Fix remaining findings under the same rule:
   cite an ID or fix it.

6. Report what changed between the two review passes, list every skipped finding
   with its rule ID, and state each owned screen's **final GATE 4 grade + who signed
   it**. A skip with no ID, or a parity grade with no independent signer, is a bug in
   the report.

7. **Docs owe their change (DOC-06):** if the ticket renamed or changed any
   documented behavior (symbol, endpoint, flag, default), grep every docs
   surface (README, docs/, docstrings) for the old name and update it — the
   `docs-accuracy` skill owns the full rule set. Then commit and push
   everything **including `.specs/design-parity/<TICKET>.md` and
   `.specs/plans/<TICKET>.md`**, open a PR, and report the PR URL.

8. Transition the Jira ticket to **"Done"** — **only after the GATE 4 CI check is
   green** — and tell the user the PR is open and ready to merge. (The user merges
   manually right after; the workflow has no "In Review" state. For UI tickets, the
   user is also the human approver of any accepted deviation in step 3c.)

9. Run `/session-logger`; ensure the log is written to disk before continuing.
   Record, so the decisions stay auditable after `/compact`:
   - the **approved plan's artifact path** (`.specs/plans/<TICKET>.md`), any
     **re-approval round-trips** (material divergences that went back through plan
     mode), and any **divergence between the approved plan and what was actually
     built** — a silent divergence is the failure this records against
   - which design files were read in Step 0.5 **and the pinned `design_ref` SHA**
   - the **GATE 4 per-screen grade(s), the independent signer, and the artifact path**
   - every **human-approved design deviation** (decision + approver + date) and the
     coming-soon → follow-up-ticket map
   - every skipped review finding **with its rule ID**

   An entry that says "skipped some findings that conflicted with our conventions",
   or "matches the design", is worthless the moment the context is gone. That is the
   failure this records against.

10. Then instruct the user to run `/compact` (this is a built-in CLI command you
    cannot invoke yourself — tell the user to run it).

## Stop-on-failure guard

**STOP and tell the user** if any of these happen. Don't guess the spec, don't invent
a visual language, don't mark anything complete, don't push past a failure silently.

- You can't fetch the ticket.
- You can't locate the design system for a UI ticket.
- You're about to write implementation code **without a plan approved through
  plan mode** (Step 0.75) — including headless/workflow runs where plan mode is
  unavailable and no user approval was obtained. Do not start implementing on
  the strength of your own plan.
- A UI ticket's reference screen is **not committed to git** (unpinnable) — pin it
  first; do not build against an uncommitted reference.
- GATE 4 grades an owned screen **Major or Not-built** and you cannot fix it or clear
  it as a **human-approved** accepted deviation — do not mark the ticket Done.
- A GATE 4 artifact would ship **unsigned by an independent reviewer**, or you're
  about to sign your own build's parity grade.
- Any PR / Jira / review step fails, or the GATE 4 CI check is not green.
- A review finding contradicts an `[NN]` rule.
- The Verification Pass reports a FAIL you cannot fix.
- You want to skip a finding, or claim a design deviation, and cannot name the rule
  ID (for a review finding) or the human approver (for a parity deviation).

The rationalized-away ones: an uncited skip is a fix you owe; a self-signed parity
grade is not a verified screen; an unpinned reference has nothing to verify against;
and an unfixed FAIL is not a shipped ticket.

## Scope discipline

- Don't batch unrelated fixes or other tickets into this one's branch/PR — one
  ticket, one isolated PR.
- Don't preempt other tickets' scope or over-engineer. Keep the ticket's scope
  honest; if the ticket depends on something unbuilt, stop and surface it rather
  than stubbing or inventing.
- GATE 4 diffs the screens this ticket **owns**, not every consumer of a shared
  component — a shared-component change spawns a separate parity-sweep task.

## What this skill does not do

- Define the code rules — it **orchestrates** the code-quality family
  (`angular-code-quality` / `backend-code-quality`); GATE 3 is their Verification
  Pass.
- Run the review engines — it invokes `/review`, `/coderabbit:code-review`,
  `test-quality`, and `docs-accuracy`, then reconciles their findings.
- Invent scope — one ticket, one PR; unbuilt dependencies stop the workflow
  rather than getting stubbed.
- Merge the PR or run `/compact` — both are the user's action; the skill opens
  the PR and tells the user.

## Success criteria

Working when a ticket closes with: a plan-mode-approved `.specs/plans/<TICKET>.md`,
a passing GATE 3, an independently-signed GATE 4 for every owned UI screen, both
review passes reconciled with every skip citing a rule ID, a green CI, Jira in
Done, and a written session log — no self-attested gate anywhere in the chain.
