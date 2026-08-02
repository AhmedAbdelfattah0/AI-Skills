---
name: ship-ticket
description: |
  Implement a Jira or Azure DevOps ticket end-to-end, on ANY stack — the stack
  is detected from the repo, never prescribed by this skill, which acts as a
  delegator: it owns the workflow and routes language/framework judgment to the
  code-quality family. Angular, React, Vue, Express/Node, Django, Laravel, Go,
  Rails, Cloudflare Workers, Postgres/Supabase — all supported. Adds SOLID,
  tiered model/cost routing, a mandatory design-source-of-truth read, a
  plan-mode gate (planned in Claude Code plan mode and user-approved before
  implementation; the approved plan is saved to .specs/plans/), a pinned +
  independently-verified + CI-enforced design-parity gate, an adversarial VAPT
  gate that commits abuse tests for every trust boundary the change introduces,
  the two-pass review flow, and full close-out (PR + ticket Done + session log +
  compact). Companion gates (code-quality family, test-quality, vapt,
  docs-accuracy, CodeRabbit) degrade loudly when not installed — declared, never
  silently skipped. Takes one argument: the ticket key, work item ID, or URL.

  Trigger when the user:
  - types /ship-ticket or /ship.ticket
  - says "ship ticket", "implement ticket", "build ticket", "ship work item",
    or "implement work item"
  - gives a Jira ticket key or browse URL (e.g. SCRUM-28 or DAT-15) and asks to
    implement, build, or ship it
  - gives an Azure DevOps work item ID or URL (e.g. 1234, #1234, AB#1234, or a
    dev.azure.com/…/_workitems/edit/1234 link) and asks to implement, build, or
    ship it
---

# /ship-ticket — implement a ticket end-to-end (Jira or Azure DevOps)

The user invokes this with a single argument: a **ticket key, work item ID, or
URL** (e.g. `SCRUM-28`, a full `…/browse/SCRUM-28` link, `1234`, `AB#1234`, or
a `dev.azure.com/…/_workitems/edit/1234` link). Run the full workflow below for
that ticket. Reusable across projects/instances — do **not** hardcode any
cloudId, site, org, or project; use whatever tracker connection is available
and resolve the key/URL the user gave.

## Step 1 — Tracker resolution

The argument names the tracker — resolve it **first**. Everything below is
tracker-neutral ("the ticket", "Done"); the three tracker-specific operations
map through this table:

| Argument looks like | Tracker | Fetch the spec | Transition to Done | Link the PR |
|---|---|---|---|---|
| `KEY-123` (letters-dash-number), `…/browse/KEY-123`, `*.atlassian.net` URL | **Jira** | Atlassian connection (get issue) | Jira workflow transition to "Done" | PR URL in a ticket comment (or dev-panel link if the integration exists) |
| bare number `1234`, `#1234`, `AB#1234`, `dev.azure.com` / `visualstudio.com` work-item URL | **Azure DevOps** | `wit_get_work_item` (expand relations) | `wit_update_work_item` → the type's **completed-category state** | `wit_link_work_item_to_pull_request` (Azure Repos PR) or `AB#<id>` in the PR description (GitHub repo with the ADO↔GitHub integration) |

Two ADO-specific rules — do not hardcode around them:

- **"Done" is a state category, not a fixed name.** The completed state depends
  on the project's process template (Scrum/Basic → `Done`, Agile → `Closed`,
  CMMI → `Closed`, plus custom processes). Resolve the work item type's actual
  completed-category state (`wit_get_work_item_type`) and set that — never
  assume the literal string "Done" exists.
- **The PR host and the tracker are independent.** An ADO work item's code may
  live in Azure Repos (open the PR with the ADO repo tools and link it with
  `wit_link_work_item_to_pull_request`) or on GitHub (open the PR with `gh` and
  put `AB#<id>` in the PR description so the ADO↔GitHub integration links it;
  if that integration isn't set up, fall back to `wit_add_artifact_link` /
  a work item comment carrying the PR URL). Check the repo's `git remote`
  before choosing.

If the argument is ambiguous (can't tell which tracker) or both trackers are
plausibly connected and the ID resolves in neither, **STOP and ask the user** —
do not guess.

## Step 2 — Companion availability check (once, up front)

This workflow orchestrates companion skills and review engines that may not be
installed everywhere (standalone installs, other machines, other AI tools).
**Check availability once, before Step 6** — a companion is available if it
appears in the available-skills list (or as a sibling folder in
`~/.claude/skills`) — and declare the run's mode before any code is written.
A gate whose engine is missing **degrades loudly, never silently**:

| Companion | Owns | If missing — degraded fallback |
|---|---|---|
| `angular-code-quality` / `backend-code-quality` (whichever the detected stack routes to — see *Stack*) | Design Contract (STEP 0B) + GATE 3a Verification Pass (`NG-*` / `BE-*`) | **First fall back to the `code-quality` hub** if it is installed — it covers any language and still yields a rule-backed pass. Only if *no* family member is present does GATE 3a run **degraded**: no rule-ID table exists, so instead review every written file against SOLID, the Step 5 mechanical rules, and this file's conventions, reporting findings in `file:line` + quoted code + fix shape. The Design Contract degrades to a plain file-list contract derived from the approved plan. **The skip-by-citation protocol collapses to "fix everything"** — with no rule IDs loaded there is nothing to cite, so no review finding may be skipped. |
| `code-quality` (hub) | MODE D guard sweep (GATE 3b) | Sweep the whole diff yourself for the LLM failure modes (mock-success returns, swallowed errors, speculative flags, stray catch-alls, dead code); note the sweep was unassisted. |
| `vapt` | GATE 5 — adversarial abuse tests against every trust boundary the diff introduces (step 12) | **The gate does not disappear with the skill.** Run the reduced form yourself against a local instance: for each changed handler / auth path / rendering sink, commit at least a cross-principal authorization test (`VAPT-API-01`), an unauthenticated-access test (`VAPT-API-02`), and a response-leakage check (`VAPT-API-06`/`07`) in the repo's own runner. Declare that the wider rule set — mass assignment, injection, XSS, CORS, cookie flags, headers — went untested. |
| `test-quality` | TEST-\* guard on the test diff (step 9) **and on the GATE 5 abuse tests (step 12)** | Skip the TEST pass; still reject obvious implementation-detail assertions and unjustified mocks on your own judgment; note it. |
| `docs-accuracy` | DOC-\* rule set (step 16) | The step-16 grep for renamed/changed documented behavior is described inline and **still runs** — only the wider DOC rule set is skipped. |
| `/coderabbit:code-review` | Second review pass — CodeRabbit CLI on the local diff (step 14); the PR-side bot is never waited on | **Skip step 14 entirely.** The run becomes single-pass review; step 15's report says so explicitly instead of reporting a between-passes delta. |
| `/review` | First review pass (step 13) + one route to the GATE 4 independent signature | Run the review as a **fresh reviewer subagent with no build context** — GATE 4's independence requirement is about *who* reviews, not the command name, so this fallback still produces a valid signature. |
| `/session-logger` | Step 17 close-out log (written before the single push) | Write the session-log entry yourself to `session-log.md` with the same required content. |

What **never** degrades, because it doesn't depend on an installed skill:

- **Steps 3 / 4 / 5** — reading the ticket, triaging it, and pinning the design
  reference.
- **Steps 7 / 8** — branching and implementing; git and the approved plan, not a
  companion skill.
- **Step 6 plan-mode gate** — plan approval is a user action, not a skill.
- **GATE 4** (UI tickets) — the pin, the committed artifact, the independent
  signature, and the human-approved deviation record are all workflow-native.
- **GATE 5's existence** — the `vapt` skill owns the rule set, but "a change that
  crosses a trust boundary gets attacked at runtime before it ships" is a
  workflow rule. Without the skill the gate runs reduced (see the table), never
  zero.
- **Stop-on-failure** — a missing companion is a *degradation to declare*, not
  a stop; a degradation you did **not** declare is itself a stop-on-failure
  violation.

**Declare the mode in three places:** once up front when detected ("running
degraded: `backend-code-quality` and `/coderabbit:code-review` not installed"),
in the step-15 report, and in the step-17 session log. A run that silently
skipped a gate is indistinguishable from a run that failed it.

## Step 3 — read the ticket first (hard gate)

Fetch and read the ticket's **full spec** before doing anything, using the
fetch column of the tracker-resolution table. For ADO, that includes the
description, acceptance criteria field(s), comments, and linked parents/
attachments — the spec is often split across them. If you cannot fetch it
(auth/IP error, wrong instance/org, missing permission), **STOP and tell
the user** — do not guess the spec, do not proceed.

## Step 4 — triage the ticket before you plan (hard gate)

You have the spec; now check the ticket is **actually startable**. Each of these
is cheap here and expensive later — a blocked ticket discovered after planning
has already burned the plan, and a ticket someone else is mid-way through is a
merge conflict you chose.

1. **Blockers must be resolved.** If the ticket names blockers or "blocked by"
   links (`generate-ticket` writes these; trackers carry them as issue links),
   **fetch each one and check its state**. A blocker not in a completed state
   means **STOP and tell the user** — name the blocker, its state, and what it
   was supposed to provide. Do not start and hope. If the user says to proceed
   anyway, record that decision in the session log.
2. **Acceptance criteria must exist.** A ticket with no ACs cannot pass GATE 3 —
   there is nothing to verify against, and you'd be inventing the definition of
   done. If the description carries no checkable criteria, **ask the user** for
   them (or for approval of criteria you propose) before planning.
3. **Nobody else is on it.** Check the assignee, the ticket's state (already In
   Progress / In Review?), and the repo for an existing branch or open PR naming
   this ticket. If any of those exist, surface it rather than opening a second
   parallel implementation.
4. **Resume, don't restart.** If `.specs/plans/<TICKET>.md` already exists, a
   previous run got at least as far as plan approval. **Read it and offer to
   resume** from where it stopped rather than re-planning from scratch — see
   *Stopping and resuming*. Re-asking for approval of a plan the user already
   approved is waste, and re-planning risks a *different* plan than the one the
   half-finished code on disk was built against.
5. **Right-sized?** If the spec clearly spans multiple independently shippable
   units — a seam plus its consumers, several surfaces, more than one authoritative
   write path — say so **now**, propose the split, and let the user decide whether
   to proceed as one ticket or file the pieces. (`generate-ticket` owns the
   splitting heuristics; this is the same judgment applied in reverse.) Do not
   silently build a three-ticket epic as one PR: it defeats the one-ticket-one-PR
   rule and produces a diff nobody can review. If the user says build it as one,
   proceed and note it in the plan's *Size* line.

## Step 5 — read AND pin the design source of truth before writing any UI (hard gate)

For any ticket that produces or changes UI, you MUST read the project's design
system **before writing a line of frontend code** — and you must actually open
the files, not skim the ticket's description of them. This step exists because
"there's a design reference" is worthless if the implementer never reads it;
available ≠ consulted. Treat this as a gate equal to Step 3.

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
The read is mandatory even when the ticket forgets to reference it. If UI is in
scope and you genuinely cannot find any design system, **STOP and ask the user**
where it lives — do not invent a visual language.

### Pin the reference (hard requirement — this is what makes GATE 4 real)

A parity check against a *moving* reference passes vacuously. So before building:

- **The reference must be committed to git before you build.** If the reference
  screen(s) you'll build against are not committed (uncommitted working-tree
  files, or not in the repo at all), **STOP** — there is no SHA to diff against
  later, and a screen closed against an uncommitted reference is unverifiable.
  (This is the SCRUM-108 failure: the ticket closed 46 minutes *before* its own
  reference was committed. Nothing could have diffed it.)
- **Record the pinned SHA.** Capture `git rev-parse HEAD -- <path to the design
  reference in this repo>` (or the repo HEAD SHA if the reference isn't isolated
  to a path) as `design_ref`.
  Write it in **two** places: the session log (step 17) and the `design_ref:` line
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
- **Respect the documented conventions** — whatever the conventions doc actually
  says. If the project is bilingual/RTL, that includes RTL mirroring and
  isolating numbers, IDs, dates, and prices LTR inside RTL text; a single-locale
  LTR project has no such rule and you should not invent one.
- **Deficient-reference carve-out.** If a shared design component is itself
  defective (e.g. a paginator that renders every page number with no windowing),
  fixing the component at its source takes precedence over literal fidelity.
  Note it, fix the component, and flag it to the user. In GATE 4 this is an
  *accepted deviation* — it still needs the human sign-off, not a self-waiver.

Reading Step 5's files is not optional context-gathering; skipping it is a
failure of the gate. If challenged later on why the UI matches the design, you
should be able to point to the pinned SHA, the token file, and the component
files you opened here.

## Step 6 — Plan in Claude Code plan mode (hard gate; every ticket)

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
| 1 | Add the state/data layer for X | <real path, in THIS repo's layout> | — |
| 2 | Build the X list screen | <real path(s), incl. template/style files> | 1 |

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
  architectural role names belong in the Design Contract, not here.
- **Real paths from this repo** in the "Files touched" column — derived from the
  detected stack's actual layout, not from an example in this file.
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

## Step 7 — branch before you write anything

The plan is approved; the next thing that happens is code, so the branch happens
**now**. The whole workflow assumes an isolated branch — one ticket, one PR, a
single gated commit — and none of that holds if the work lands on the default
branch. This is also the last cheap moment to sync: rebasing after a day of
implementation is strictly worse.

1. **Never implement on the default branch.** If `git rev-parse --abbrev-ref HEAD`
   is `main`/`master`/`develop` (or whatever the repo's default is), branch. You
   cannot open a PR from the default branch into itself.
2. **Start from a fresh base.** `git fetch` and branch from the up-to-date default
   branch. Building on a stale base is how a clean local build meets a red CI.
3. **Name it after the ticket** so the branch, the PR, the plan artifact, and the
   tracker all agree — follow the repo's existing convention if it has one (check
   `git branch -a` for the pattern in use); otherwise `<type>/<TICKET>-<slug>`,
   e.g. `feat/SCRUM-28-payment-provider-seam`, `fix/1234-cart-total-rounding`.
4. **Already on a ticket branch?** If Step 4 found an existing branch for this
   ticket, use it — don't open a second one. Rebase it on the current default
   branch and say what you did.
5. **Uncommitted changes in the working tree that aren't yours?** STOP and ask.
   Do not stash, revert, or build on top of someone else's in-flight work.

## Step 8 — implement, in the plan's sequence, inside the contract

Now build. This step is short to describe and is most of the actual work; the
constraints on it are what the previous seven steps were for.

- **Follow the approved plan's build sequence, in order.** The sequence encodes
  the dependencies; jumping ahead is how you end up writing a screen against a
  service that doesn't exist yet.
- **Write only files in the Design Contract.** A file you need that isn't in the
  contract means the plan was wrong — that is a **material divergence**, and it
  goes back through plan mode for re-approval (see *The plan constrains the
  contract* above). Do not widen the contract yourself.
- **Follow the detected stack's existing patterns**, not this file's examples and
  not the ones you'd pick on a greenfield repo (see *Stack*).
- **Compose, don't hand-roll** — for UI, the shared components from Step 5.
- **Security-sensitive work is test-first.** If the ticket is flagged
  security-sensitive (see *Security-sensitive note*), write the failing test that
  proves the secure behaviour before the implementation.
- **Tiering applies here:** the plan was STRONG-model work; building from an
  approved plan is MEDIUM work. Escalate for genuinely hard reasoning, not for
  routine wiring (see *Model / cost routing*).
- **Don't fix what the ticket didn't ask for.** Unrelated problems you notice go
  to the user as a note or a new ticket, not into this diff (see *Scope
  discipline*).

When the build sequence is done, continue to step 9.

## Stack — detected, never prescribed

**This skill is a delegator, not a stack.** It owns the *workflow* — read the
ticket, pin the design, plan, gate, review, close out — and delegates every
language- and framework-specific judgment to the code-quality family and to the
repo itself. It works on Angular + Cloudflare Workers, React + Express, Vue +
Django, a Go service, a Rails monolith, or anything else. **Do not assume a
stack, and never rewrite code to match one this skill prefers.**

**Detect before you plan** (cheap, and it decides the routing below):

1. **`CLAUDE.md` first** — if the repo documents its stack, conventions, or
   commands, that is authoritative and outranks anything inferred.
2. **Manifests** — `package.json` (and which framework is in `dependencies`),
   `composer.json`, `requirements.txt` / `pyproject.toml`, `go.mod`, `Cargo.toml`,
   `*.csproj`, `Gemfile`, `pom.xml`.
3. **The existing code** — how the current routes/components/services are
   actually written. **The repo's established pattern wins over any convention
   in this file or in a quality skill's defaults.** A ticket is not a licence to
   introduce a second architecture alongside the one already there.
4. **The commands** — read the real lint/build/test commands from the scripts
   block, Makefile, or CI config. Never assume a runner (see step 9).

If detection is genuinely ambiguous (two frameworks, no manifest, an unfamiliar
setup), **ask the user once** rather than guessing — a wrong stack assumption
surfaces as a broken build much later, after a plan was already approved.

**Then route to the right quality specialist:**

| The ticket touches | Invoke | Owns |
|---|---|---|
| **Angular** frontend | `angular-code-quality` | `NG-*` rules |
| **Any other frontend** (React, Vue, Svelte, Next/Nuxt, plain TS…) | `code-quality` (hub) | universal core; its `references/` carry per-stack rule sets |
| **Any backend**, any language/runtime | `backend-code-quality` | `BE-*` rules — it detects the stack itself |
| **A stack with no reference file** (Go, Rust, Java, C#…) | `code-quality` (hub) | universal principles applied to that language |

- **Full-stack tickets:** one Design Contract and one Verification Pass covering
  both sides — never two uncoordinated halves. If that means invoking two
  specialists, they still produce a single contract and a single GATE 3.
- **Always follow `CLAUDE.md`** — it outranks this file on any conflict.
- The ticket itself decides whether it's FE, BE, or both; each specialist routes
  from its cached profile.

**What stays constant across every stack** — these are the skill's actual
contract, and none of them depend on a framework: read the ticket (Step 3), pin
the design reference (Step 5), plan and get approval (Step 6), SOLID, the
rule-ID citation protocol, GATE 3, GATE 4, GATE 5, two-pass review, and
close-out.

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
Based on the ticket (FE / BE / full-stack) **and the detected stack**, invoke the
member the routing table above selects — `angular-code-quality`,
`backend-code-quality`, the `code-quality` hub, or a combination. The chosen
skill governs this build end to end:
its rules apply to every line, its **Design Contract (STEP 0B)** gates every
file, and its **Verification Pass is GATE 3** below. Both specialists build on
the `code-quality` hub's universal core (`ai-failure-modes`,
`universal-principles`, `review-standard`) — so "invoke the specialist" invokes
that core too. This is not optional context when the skill is installed; a
build that skipped an *available* specialist has no Design Contract and cannot
produce GATE 3. **If the specialist is not installed** (per the companion
availability check), run the degraded fallback from the availability table —
declared up front, never assumed silently.

Then run its **Design Contract** gate (STEP 0B), deriving the file list from the
Step 6 plan's build sequence. No file gets written that isn't in the contract.
(Degraded mode: the contract is the plain file list from the approved plan —
the "no file outside the contract" rule still holds.)

## Apply SOLID throughout

These are language-neutral. Express them in whatever the detected stack's idiom
is — the principle is fixed, the mechanism is the repo's.

- **Single responsibility:** one reason to change per class/service/component/
  module. FE = container vs presentational split; BE = handler → service → data
  layer, no business logic in the route/controller. True of Express, Nest, Hono,
  Django, Laravel, Rails, Go, or anything else.
- **Open/closed:** extend via new strategies/implementations, not by editing
  working code (e.g. payment gateways, shipping carriers = strategy pattern).
- **Liskov:** implementations of an interface are truly substitutable.
- **Interface segregation:** small focused interfaces/inputs, not god objects.
- **Dependency inversion:** depend on abstractions; inject dependencies rather
  than hardcoding concretions — via whatever the stack provides (a DI container,
  constructor injection, a provider/context, a factory, or plain function
  parameters). No mechanism is required; the *inversion* is.

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

**Read the flag off the ticket first, then judge for yourself.** If the ticket
carries an explicit security-sensitive marker (`generate-ticket` writes one in its
*Invariants & security* section; trackers often carry a label), honour it. Its
absence proves nothing — so also apply your own test: if the ticket touches auth,
multi-tenancy, billing, payments, secrets, or any cross-tenant isolation, it is
security-sensitive whether or not anyone labelled it. Record the determination in
the plan's `security-sensitive:` field either way — **that field is what sets
GATE 5 to strict**, so getting it wrong silently downgrades the security gate.

When it is: do that reasoning on the strong model, and prefer a test-first repro
(write the failing test that proves the correct/secure behavior, then implement). Any DB migration must be additive
and committed to Git, using **this project's migration tool and naming
convention** (read the existing `migrations/` directory — Prisma, Drizzle,
Alembic, Flyway, Rails, Laravel, plain numbered SQL, …). Don't introduce a
second migration mechanism alongside the one already there.

## Steps 9–20 — verify, gate, review, close out

9. Run **the repo's own lint, build, and test commands** — read them from the
   `package.json` scripts block, Makefile, `composer.json`, `pyproject.toml`,
   `go.mod` tooling, or the CI config; never assume a runner (Vitest, Jest,
   pytest, PHPUnit, `go test`, `dotnet test`, `rspec` — whatever this repo
   actually uses). Fix any failures. **Tests green ≠ tests good:**
   run the `test-quality` guard pass on the test diff before GATE 3 (if
   installed — else the degraded fallback from the availability table) — a
   must-fix TEST violation (TEST-01/02/08: implementation-detail assertions,
   unjustified mocks, mocked state objects) blocks the review passes like any
   FAIL.

10. **GATE 3 — Code-Quality Audit.** This is the post-implementation audit by the
   code-quality family — the skill actually reviewing what you built, not a table
   filled from memory. It has two parts and both must pass before the review
   passes run. (If the family isn't installed, both parts run in the degraded
   form from the availability table — a lighter engine, not a waived gate: its
   must-fix findings still block review.)

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

   For UI tickets the pass includes the mechanical Step 5 rules: the screen
   **composes the shared components** rather than hand-rolling equivalents,
   **no hardcoded color/spacing/type outside the token file**, and the
   conventions doc's rules are honoured (bilingual/RTL handling and numeric
   LTR-isolation *if the project is bilingual/RTL* — skip if it isn't). On
   Angular these carry the IDs `NG-UI-01/02/03`; on other stacks cite the
   equivalent ID from the specialist you invoked, or state the rule in prose if
   the family isn't installed. These prove the code follows the design **rules**.
   **Structural/visual parity against the reference is NO LONGER self-attested
   here** — it is proven by GATE 4 below. Fix rule drift here; do not ship it to
   review.

11. **GATE 4 — Design-Parity Close-out (UI tickets only; hard gate, independently
   verified, CI-enforced).** This is the return leg of Step 5: Step 5 read and
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
   (the `design_ref` SHA from Step 5) at three layers, one row per divergence
   with exact `ref file:line ↔ impl file:line` and a severity:
   - **Structure** — node-by-node: presence/absence and composition of sections,
     states (empty/loading/error), and components.
   - **Style** — class/declaration: layout, spacing, tokens, color, type, shadow.
   - **Behavior + i18n** — interactions, state, and correctness in **every locale
     and text direction the project actually ships** (drop this layer entirely if
     it's single-locale LTR).

   Grade each screen: **Faithful** (no Blocker/Major) · **Minor** (token/spacing
   drift only) · **Major** (structural/visual divergence) · **Not-built** (a
   reference screen/section with no implementation). Reuse the parity-audit table
   shape.

   **b. The builder's grade is a DRAFT — an INDEPENDENT reviewer signs it.** Spin
   up a parity-reviewer that has **no build context for this screen** — a fresh
   subagent, or `/review` (step 13) extended to diff impl-vs-reference — to re-run /
   adversarially spot-check the diff against the **pinned** reference and **sign
   the grade in the artifact**. Only the independent signature counts. *The builder
   never signs their own parity grade* — a self-graded artifact just relocates the
   self-attestation this gate exists to remove.

   **c. Residual Blocker/Major clears ONLY with human approval.** A residual
   Blocker/Major divergence (including the Step 5 deficient-reference carve-out)
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
   **this repo's view layer** — write the glob from the actual layout, e.g.
   `**/*.{html,scss,css}` plus component files (`*.component.ts`, `*.tsx`,
   `*.vue`, `*.svelte`, `*.blade.php`, `templates/**/*.html`, …). Derive it from
   where the UI really lives; the point is the signal, not a fixed pattern — the
   same signal Step 5 uses. Because the tracker's `Done` transition (step 19)
   follows the green CI, this **hard-gates `Done`** without relying on the agent
   to self-enforce — closing the "same agent builds it and transitions it" hole.

   If the reference wasn't pinnable at Step 5, you cannot run this gate — **STOP**
   (Step 5 must pin it first).

12. **GATE 5 — Adversarial Security Testing (any diff touching a trust boundary;
   hard gate, CI-enforced).** GATE 3 proved the security controls *exist in the
   code*. This proves they *engage at runtime* — the two are not the same claim,
   and only the second one survives a middleware registered in the wrong order or
   a guard whose route matcher misses the new path. Invoke the `vapt` skill (or
   the degraded fallback from the availability table).

   **Scope — trust boundaries, not files.** It fires when the diff introduces or
   changes a request handler, an auth/session path, a query taking external
   input, a sink rendering values it didn't author, an upload or path handler,
   client-side storage, an outbound call carrying credentials, a queue consumer,
   or security config (CORS, headers, cookie options, secrets). Skip **only** when
   the diff touches none of those — and name every changed file you excluded and
   why. "Test every changed file" is unbounded and turns into rubber-stamping; an
   unexplained exclusion is the hole this scoping rule closes.

   **a. Attack a local, disposable instance — never production, never shared
   staging**, no matter who owns it. If the only reachable environment is shared,
   ✋ STOP and ask. If the app cannot be run locally at all, STOP — there is no
   runtime evidence to be had, and the gate would be theater.

   **b. The output is committed tests, not a report.** Each abuse case becomes a
   test in **this repo's own runners** (detected the same way as step 9, never
   assumed), named for the rule it defends (`VAPT-API-01: user B cannot read user
   A's invoice`) and asserting the *refusal* rather than the guard's internals.
   They ride the step-18 commit with everything else and keep running in CI long
   after the ticket closes. Run the `test-quality` guard over them — abuse tests
   are test code and get no exemption from `TEST-*`.

   **c. Strict vs light.** **Strict** — the full `VAPT-API-*` / `VAPT-WEB-*` /
   `VAPT-CFG-*` set plus an **independent signature** — when the plan's
   `security-sensitive:` field is true. **Light** otherwise: the classes that ship
   silently in ordinary CRUD work (cross-principal authz, unauthenticated access,
   excessive data exposure, error leakage, XSS, client-stored credentials, cookie
   flags).

   **d. Fix in production code, then re-run.** An `[NN]` finding is fixed, never
   cited away — only an explicit recorded user waiver clears one. A fix that
   changes production code **re-runs step 9 and the GATE 3 rules for the files it
   touched**. Loosening or deleting the test is not a fix.

   **e. Missing principals degrade loudly.** Authorization classes need
   anonymous + two cross-tenant users (+ roles, if the system has them). If the
   project cannot produce those fixtures, `VAPT-API-01/02/03` and `VAPT-WEB-02`
   are declared **DEGRADED by ID** — they do not silently pass.

   **PASS** ⇔ every in-scope surface carries a green committed test for every
   applicable rule · zero unfixed `[NN]` findings · every excluded changed file
   and every degraded rule **named** in `.specs/vapt/<TICKET>.md` · plus the
   independent signature in strict mode.
   **FAIL** ⇔ otherwise — including a rule marked PASS with no test behind it.

   **Enforcement is machine, not honor-system.** The abuse tests run in the
   repo's existing test job; alongside them, a merge-blocking CI check (same
   PR-side slot as `nn-guard` and the GATE 4 check) rejects a
   trust-boundary-touching PR unless `.specs/vapt/<TICKET>.md` exists and is
   PASS. Because the `Done` transition (step 19) follows the green CI, this
   hard-gates `Done` without relying on the agent to self-enforce.

13. Run `/review` (or, if unavailable, the fresh-reviewer-subagent fallback from
   the availability table) — for UI tickets this pass also carries the **GATE 4
   independent parity check** (impl-vs-reference against the pinned SHA) and
   produces the independent signature, unless a separate reviewer subagent
   already did.
   Fix every finding, **except** a finding that contradicts a specific `[D]` or
   `[ARCH]` rule you can **name by ID**. (Degraded GATE 3 = no rule IDs loaded =
   **no skips at all** — fix every finding.)

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

   A skipped finding is a deviation. Record it in the deviations ledger of
   **whichever family member you actually invoked** —
   `.claude/<invoked-skill>/deviations.md`.
   (Design-parity deviations live in the GATE 4 artifact instead — they carry a human
   approver, not a rule ID.)

14. Then run `/coderabbit:code-review` on the **local diff** — **if installed.**
   This CLI pass is the **authoritative CodeRabbit gate**, and it runs here,
   before the PR exists. If not installed, skip this pass entirely (it was
   declared up front in the availability check); do not substitute a second
   self-review and present it as the CodeRabbit pass. When it runs, fix remaining
   findings under the same rule: cite an ID or fix it.

   **The PR-side CodeRabbit bot is NOT a second gate — never wait on it.** Once
   the PR is open (step 18), CodeRabbit's GitHub app re-reviews the same diff. Do
   **not** poll or block the workflow on that report: it is a duplicate of the
   review you just ran, and polling it re-costs the wait loop on every push. Read
   it only if it has already posted; treat it as informational, not a gate.

15. Report what changed between the two review passes (or state explicitly that
   the run was **single-pass** because `/coderabbit:code-review` isn't
   installed), list every skipped finding with its rule ID, state each owned
   screen's **final GATE 4 grade + who signed it**, state **GATE 5's verdict —
   the surfaces attacked, the abuse tests committed, and every rule declared
   degraded by ID** — and restate any **degraded gates** from the availability
   check. A skip with no ID, a parity grade with no independent signer, a VAPT
   rule marked PASS with no test behind it, or an undeclared degradation is a bug
   in the report.

16. **Docs owe their change (DOC-06):** if the ticket renamed or changed any
   documented behavior (symbol, endpoint, flag, default), grep every docs
   surface (README, docs/, docstrings) for the old name and update it — the
   `docs-accuracy` skill owns the full rule set.

17. **Write the session log BEFORE the push** — so it rides the single gated
   commit, never a second one. Run `/session-logger` (or, if not installed,
   write the entry yourself to `session-log.md`); ensure it is on disk before the
   commit. Everything it records is already known here — none of it needs the PR
   URL or the CI result, so nothing forces a later commit:
   - the run's **availability mode** — which companion skills were missing and
     which gates ran degraded (or "full mode — all companions installed")
   - the **approved plan's artifact path** (`.specs/plans/<TICKET>.md`), any
     **re-approval round-trips** (material divergences that went back through plan
     mode), and any **divergence between the approved plan and what was actually
     built** — a silent divergence is the failure this records against
   - which design files were read in Step 5 **and the pinned `design_ref` SHA**
   - the **GATE 4 per-screen grade(s), the independent signer, and the artifact path**
   - the **GATE 5 verdict**: the surfaces attacked, the target it ran against,
     the abuse tests committed (by path), and every rule declared **degraded by
     ID** — plus every changed file excluded from scope and why
   - every **human-approved design deviation** (decision + approver + date) and the
     coming-soon → follow-up-ticket map
   - every skipped review finding **with its rule ID**

   An entry that says "skipped some findings that conflicted with our conventions",
   or "matches the design", is worthless the moment the context is gone. That is the
   failure this records against.

18. **One commit, one push, one wait.** Commit **everything in a single commit** —
   the code, `.specs/plans/<TICKET>.md`, `.specs/design-parity/<TICKET>.md`,
   `.specs/vapt/<TICKET>.md` **and the abuse tests it produced**, the step-16 doc
   updates, and `session-log.md` — and push it **once**. Open a PR **on
   the repo's actual host** (Azure Repos via the ADO repo tools, or GitHub via
   `gh` — per the tracker-resolution table's PR column), link the ticket to the PR
   the same way, and report the PR URL. Then wait **exactly once** for the CI
   checks — including the GATE 4 CI check — to report.

   **Do not poll or block on the PR-side CodeRabbit bot** (step 14 already gated
   the diff via the CLI pass; its PR re-review is informational). **Push nothing
   further unless a gate actually fails and needs a code fix.** A doc-only commit
   pushed after the gates go green — a stray session-log tweak, a README touch-up
   — re-triggers the entire CI + CodeRabbit cycle from scratch and makes the
   wait-for-gates poll run all over again for nothing. That re-trigger is the
   waste this ordering (session log written in step 17, everything in this one
   commit) exists to prevent — so the session log and every artifact go in *this*
   push, not after it.

19. Transition the ticket to **Done** — **only after the GATE 4 and GATE 5 CI
    checks are green** — using the tracker-resolution table's transition column (Jira: the
    "Done" workflow transition; ADO: `wit_update_work_item` to the work item
    type's resolved completed-category state). Then tell the user the PR is open
    and ready to merge. (The user merges manually right after; the workflow has
    no "In Review" state. For UI tickets, the user is also the human approver of
    any accepted deviation in step 11c.)

20. Then instruct the user to run `/compact` (this is a built-in CLI command you
    cannot invoke yourself — tell the user to run it).

## Stop-on-failure guard

**STOP and tell the user** if any of these happen. Don't guess the spec, don't invent
a visual language, don't mark anything complete, don't push past a failure silently.

- You can't fetch the ticket.
- **A blocker on the ticket is not in a completed state** (Step 4.1) — name it and
  its state; don't start and hope.
- **The ticket has no acceptance criteria** and the user hasn't approved any you
  proposed (Step 4.2) — there is nothing for GATE 3 to verify against.
- **Someone else is already on it** — an assignee, an In Progress state, or an
  existing branch/PR for this ticket (Step 4.3).
- **You'd be implementing on the default branch**, or on a base you didn't sync,
  or on top of someone else's uncommitted working-tree changes (Step 7).
- **A file you need is outside the Design Contract** — that's a material
  divergence; it goes back through plan mode, it is not a judgment call (Step 8).
- You can't locate the design system for a UI ticket.
- You're about to write implementation code **without a plan approved through
  plan mode** (Step 6) — including headless/workflow runs where plan mode is
  unavailable and no user approval was obtained. Do not start implementing on
  the strength of your own plan.
- A UI ticket's reference screen is **not committed to git** (unpinnable) — pin it
  first; do not build against an uncommitted reference.
- GATE 4 grades an owned screen **Major or Not-built** and you cannot fix it or clear
  it as a **human-approved** accepted deviation — do not mark the ticket Done.
- A GATE 4 artifact would ship **unsigned by an independent reviewer**, or you're
  about to sign your own build's parity grade.
- **GATE 5 has no local instance to attack** — the app can't be run, or the only
  reachable environment is production or shared staging. Never point abuse tests
  at infrastructure this ticket doesn't own.
- **A GATE 5 `[NN]` finding can't be fixed inside the ticket's scope** (it's
  architectural), or a fix would require changing auth, tenancy, or billing
  architecture — that's a decision, not a patch.
- Any PR / tracker / review step fails, or the GATE 4 or GATE 5 CI check is not
  green.
- You can't resolve which tracker the argument belongs to, or the ADO
  completed-category state can't be determined for the work item type.
- A review finding contradicts an `[NN]` rule.
- The Verification Pass reports a FAIL you cannot fix.
- You want to skip a finding, or claim a design deviation, and cannot name the rule
  ID (for a review finding) or the human approver (for a parity deviation).

The rationalized-away ones: an uncited skip is a fix you owe; a self-signed parity
grade is not a verified screen; an unpinned reference has nothing to verify against;
and an unfixed FAIL is not a shipped ticket.

## Stopping and resuming

A stop is a pause, not an abort — the user decides what happens next, and they
need the state to decide.

**When you stop, leave the work recoverable:**

- **Do not revert, reset, stash, or delete the branch.** Whatever is written stays
  written. Destroying half-finished work to "leave things clean" throws away the
  expensive part and is not yours to decide.
- **Commit nothing to close it out.** The single-gated-commit rule (step 18) still
  holds; a stopped run has not passed its gates. Leave the work in the tree or in
  WIP commits on the ticket branch — say which.
- **Report the state precisely:** the branch name, which step you stopped at, what
  is written vs. still missing, which artifacts exist (`.specs/plans/<TICKET>.md`,
  `.specs/design-parity/<TICKET>.md`, `.specs/vapt/<TICKET>.md`), and the single
  concrete thing needed to
  continue. "It failed" is not a state report.
- **Say what is NOT done**, explicitly — the ticket is not transitioned, the PR is
  not open, the gates did not pass. A stop that reads like a completion is worse
  than a loud failure.

**Resuming (Step 4.4 routes here).** Re-invoking the skill on the same ticket must
not blindly restart:

- **`.specs/plans/<TICKET>.md` exists** → the plan was approved. Read it, confirm
  with the user that it still stands, and re-enter at the step after the one that
  stopped. **Do not re-run plan mode for an already-approved plan** — unless the
  plan itself was what turned out to be wrong, in which case it is a material
  divergence and *does* go back through plan mode.
- **A ticket branch exists** → use it (Step 7.4), rebased.
- **`.specs/design-parity/<TICKET>.md` exists** → GATE 4 ran; check its grade and
  signature rather than regenerating it.
- **`.specs/vapt/<TICKET>.md` exists** → GATE 5 ran; read its verdict and its
  committed-test paths, and re-run those tests rather than re-deriving the whole
  surface inventory. Only re-attack surfaces the resumed work actually changed.
- **The pinned `design_ref`** is in the plan artifact and the session log — reuse
  that SHA, do not re-pin to a newer HEAD. Re-pinning silently changes what the
  screen is being verified against, which is the exact failure Step 5 exists to
  prevent.
- **Re-check Step 4's triage anyway** — blockers, assignee, and open PRs can all
  have changed since the run stopped.

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
  (`angular-code-quality`, `backend-code-quality`, or the `code-quality` hub);
  GATE 3 is their Verification Pass.
- **Choose or impose a stack.** The stack is the repo's, detected in *Stack —
  detected, never prescribed*. This skill never migrates a project toward a
  framework it prefers, and never assumes one the repo doesn't use.
- Run the review engines — it invokes `/review`, `/coderabbit:code-review`,
  `test-quality`, `vapt`, and `docs-accuracy`, then reconciles their findings.
- **Define the attack classes** — `vapt` owns the `VAPT-*` rules, the trust-boundary
  taxonomy, and the rules of engagement; GATE 5 is its gate run.
- Invent scope — one ticket, one PR; unbuilt dependencies stop the workflow
  rather than getting stubbed.
- Merge the PR or run `/compact` — both are the user's action; the skill opens
  the PR and tells the user.

## Success criteria

Working when a ticket closes with: a plan-mode-approved `.specs/plans/<TICKET>.md`,
a passing GATE 3 (full or **declared** degraded), an independently-signed GATE 4
for every owned UI screen, a passing GATE 5 with committed abuse tests for every
trust boundary the change introduced, the review pass(es) reconciled with every
skip citing a rule ID, a green CI, the ticket in Done (Jira transition or ADO
completed state), a PR linked to the ticket, and a written session log naming the
run's availability mode — no self-attested gate and no silent degradation
anywhere in the chain.
