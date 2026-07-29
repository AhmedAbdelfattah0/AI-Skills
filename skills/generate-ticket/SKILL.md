---
name: generate-ticket
description: |
  Generate fully-detailed, implementation-ready Jira or Azure DevOps work items
  as CONTENT ONLY — it never creates them in a tracker. Produces per-ticket
  markdown (blockers, detailed scope, invariants, checkable acceptance criteria,
  recon, links) plus a bulk-import CSV and a dependency-ordered index, in the
  shape ship-ticket consumes downstream. Adding them to Jira/AZ is a separate,
  explicit step.

  Trigger when the user:
  - types /generate-ticket, /gen-ticket, or /new-ticket
  - says "generate a ticket", "write a ticket", "create tickets for", "break
    this into tickets", "generate the backlog for", or "turn this doc/spec/epic
    into tickets"
  - gives a feature, doc, spec, PRD, or epic and asks for Jira or Azure DevOps
    task content
  - the argument may be a description, a doc path, an epic, or nothing at all
    (then gather context per Step 1)

  Do NOT use for: creating work items in a tracker (that is the separate
  creation step), implementing a ticket that already exists (use ship-ticket),
  or feature specs and plans (use spec-driven).
---

# /generate-ticket — generate implementation-ready ticket content (no tracker writes)

This skill **generates the content** of one or many work items and writes them to
disk. It does **not** create anything in Jira or Azure DevOps — a later, explicit
step does that (via the Atlassian/AZ MCP, or by importing the CSV). Keeping
generation separate from creation is deliberate: the user reviews and edits before
anything lands in a tracker.

The output is consumed by the **ship-ticket** skill (or Codex, or any agentic
model). So the bar is: **a competent implementer who has never seen this
conversation can build the ticket from its text alone.** If a fact needed to build
it isn't on the ticket, the ticket is incomplete.

## Reference files — read these before writing

| File | Read it when | If missing |
|---|---|---|
| `references/ticket-template.md` | Always, before writing the first ticket — it is the exact section order every ticket follows. | Fall back to the 11 sections listed in Step 3 below. |
| `references/example-filled-ticket.md` | Always, once per run — this is the **depth calibration**. It shows what a full-detail ticket looks like end to end. | Aim for: named endpoints/columns/files, invariants stated, every AC objectively checkable. |
| `references/csv-format.md` | Before writing the CSV — per-tracker columns and escaping. | Jira: `Summary,Issue Type,Priority,Labels…,Epic Link,Description` (one repeated `Labels` column per label). AZ: `ID,Work Item Type,Title,Priority,Tags,Description,Acceptance Criteria` (`ID` empty for new items). |
| `references/example-tickets-import.csv` | Alongside `csv-format.md` — a real two-row Jira example with correct quoting. | Quote every field; `""` escapes a literal quote. |

Two terms below come from the **ship-ticket** skill, which consumes this output.
They are stated on the ticket so the implementer knows the gate exists; if
ship-ticket is not installed they are still meaningful instructions:

- **Step 0.5** — ship-ticket refuses to write UI code until it has read and
  git-SHA-pinned the design reference. A UI ticket with no design source of truth
  stalls there.
- **GATE 4** — the return leg: the built screen is diffed against that pinned SHA
  by an independent reviewer before the ticket can close.

## What this skill produces (always)

For a run that generates N tickets:

1. **One markdown file per ticket** — `tickets/<slug>.md`, full spec.
2. **One CSV** — `tickets/tickets-import.csv`, one row per ticket, for bulk import
   into Jira or Azure DevOps.
3. **A short index** — `tickets/INDEX.md`: the list, their dependency order, and
   which are ready vs. blocked.

Never output only the CSV (it can't hold the full body well) and never output only
markdown (the user wants the importable file). Both, every time.

**Where.** `tickets/` at the **repo root** (or the user's cwd if there's no repo),
unless the user names a directory. Say the absolute path in the hand-off.

**Don't clobber.** If `tickets/` already holds a `tickets-import.csv` or `INDEX.md`
from an earlier run, do not overwrite silently — either write into
`tickets/<batch-name>/` or tell the user what would be replaced and let them
choose. Per-ticket `.md` files with a colliding slug get the same treatment.

**Ticket identity before the tracker exists.** At generation time no real keys
exist yet, so the ticket's identity is its **slug** (`payment-provider-seam`), and
blockers/out-of-scope/links reference **slugs from this same set**. Never invent a
key-shaped string (`PAY-101`, `MARKET-REG`) for a ticket you are generating — a
fake key is indistinguishable from a real one and is exactly the phantom-reference
failure this skill exists to prevent. Cite a real key **only** when the user gave
it or you read it from the tracker. `INDEX.md` carries a slug → key column the
user fills in after creation.

## Step 1 — gather context (be smart about the source)

Do **not** immediately ask the user questions. First exhaust what's already
available, in this order, and only ask for what's genuinely missing:

1. **The session context.** If this conversation already contains the feature,
   the design decisions, the repo layout, the constraints — use it. Much of what
   makes a good ticket has usually already been said.
2. **Provided docs.** If the user pointed at a doc, spec, PRD, epic, or design
   file (path or pasted), read it fully before writing. If the project uses the
   **spec-driven** skill, `.spec/tasks.md` (and `spec.md` / `plan.md` beside it)
   is an already-decomposed task list — read it before decomposing anything
   yourself, and reuse its boundaries rather than inventing a second split.
3. **The repo.** If a repo is available and the ticket is about code, verify the
   things that make tickets wrong when assumed: real file paths, whether a
   referenced component/table/endpoint actually exists, the design-token file
   location, existing conventions in `CLAUDE.md`. This is what prevents the
   "ticket describes a file that doesn't exist" failure.
4. **The tracker — read-only.** If a Jira/AZ connection is available, **search it
   before writing.** This is not a contradiction of the content-only rule: the ban
   is on *creating*, and reading is what makes the output correct. It buys three
   things:
   - **Dedupe.** Generating a backlog for an existing project without checking
     what's already filed produces duplicates that someone has to reconcile by
     hand. Search the epic, the component, the feature name.
   - **Real keys.** A blocker that already exists gets its *actual* key instead of
     a slug or a `[TODO-VERIFY]`.
   - **House style.** Read two or three existing tickets for the project's real
     conventions — issue types in use, label vocabulary, priority scheme, whether
     ACs live in the description or a dedicated field.

   If a near-duplicate exists, say so and ask whether to skip it, extend it, or
   generate alongside it — don't silently emit a twin.
5. **Ask the user — last, and only the gaps.** If after 1–4 you still lack
   something load-bearing (a blocker's ticket key, which market/tenant, an
   intended sprint, an ambiguous scope boundary), ask — batched, specific, and
   only the parts you couldn't resolve yourself.

**The unverified-assumption rule (important).** When you must state something you
could not verify — a file path, a design reference, a schema field, a flag name —
do **not** silently assume it. Mark it inline as `**[TODO-VERIFY: …]**` in the
ticket body, and collect all such items into the ticket's **Recon required**
section. A ticket that looks authoritative but is built on guesses is worse than
one that admits what it doesn't know — that admission is what stops the implementer
building the wrong thing. (This whole project has repeatedly hit tickets whose
cited design/paths didn't exist; TODO-VERIFY is the antidote.)

## Step 2 — decide scope: one ticket or many

- If the input is a single well-bounded piece of work → **one ticket**.
- If the input is an epic, a doc, or "build feature X" that spans DB + API + UI or
  multiple surfaces → **split into a set**, each ticket independently shippable,
  and record the dependency order in `INDEX.md`.

**Splitting heuristics (learned on this project):**
- **Seam before implementation.** The primitive/interface/registry is its own
  ticket; the thing built on it is another (e.g. "provider interface + registry"
  separate from "live provider integration"). This keeps each PR reviewable and
  lets the interface be proven before real implementations plug in.
- **One writer per invariant.** If several tickets would touch the same
  authoritative write path (a stock column, subscription state, an order total),
  say so explicitly and make exactly one of them the owner. Note the others as
  read-only consumers.
- **Don't defer into the void.** If ticket A defers work to "a follow-up", the
  follow-up must be a real ticket in this same set (or an existing key), named.
  Never write "coordinate with a future ticket" — that's how work loops forever.
- **Same-file contention is a scheduling fact.** If two tickets edit the same hot
  file (e.g. a Worker entry, a shared route registry), state
  "conflicts with <KEY> — sequence, do not parallelise" on both.
- **Per-surface UI.** If a design renders across multiple templates/layouts, that
  multiplies the UI work — either one ticket that says "×N templates" in scope, or
  N tickets. Make the multiplier explicit so it isn't estimated as one screen.

**Right-size the set, not just each ticket.** The depth rule in *Guardrails*
governs how deep one ticket goes; this governs how many there are. Splitting is
not free — every extra ticket is another PR, another review, another dependency
edge. Bias toward **fewer, deeper, independently shippable** tickets over many
thin ones; a ticket that can't ship on its own isn't a ticket, it's a checklist
item inside another one. **Past ~10–12, stop and checkpoint:** show the user the
proposed list (one line each) and get agreement on the split *before* writing
full bodies. Writing thirty full specs the user then re-cuts wastes their review
and your budget.

**The epic, when there isn't one.** Generating a backlog for a new project means
no epic exists yet, and Jira's `Epic Link` cannot point at a key that isn't there.
So:

- If the work clearly rolls up to one epic and none exists, **generate the epic as
  the first item of the set** — its own `.md` (summary, the outcome it delivers,
  the child list by slug, and what "epic done" means), and its own CSV row typed
  `Epic`.
- Leave every child's `Epic Link` / parent **blank**, and say in `INDEX.md`: create
  the epic first, then set the parent on the children (bulk-edit after import, or
  pass the real key at MCP-creation time). An `Epic Link` naming a non-existent key
  fails the import row.
- If an epic **already exists** (you read its key from the tracker in Step 1), use
  that real key and skip generating one.
- If the work doesn't roll up to a single outcome, don't manufacture an epic to
  have one.

## Step 3 — write each ticket to the template

Use `references/ticket-template.md` as the exact structure. Every ticket contains,
in order:

1. **Summary** — one line, action-first, specific. Not "Payments" but
   "Payment provider interface + market-keyed registry + encrypted credential storage".
2. **Type / Priority / (suggested) labels** — Task/Story/Bug; priority with a
   one-line reason; labels as *suggestions*. **No invented planning metadata** —
   no sprint label, no story points, no effort estimate (see *Guardrails*).
3. **Context / why it matters** — what's broken or missing and the user-facing or
   business consequence. An implementer who knows *why* makes better calls.
4. **Blockers & dependencies** — real ticket keys (or `[TODO-VERIFY]`), each with
   *what* it provides and *why* it blocks. Include same-file contention notes.
5. **Design source of truth** (UI tickets) — the reference file(s) to build
   against, the token file, the conventions doc. State GATE 4 applies.
   **Try hardest to resolve this one.** ship-ticket's Step 0.5 *refuses to build*
   a UI ticket without it, so an unresolved design reference doesn't just add a
   recon item — it stops the ticket dead. If a repo is available, locate the real
   file now (and confirm it is committed, so it can be SHA-pinned). Only when you
   genuinely cannot, write `[TODO-VERIFY]` + a Recon line, and flag that ticket in
   the hand-off as "will stall at Step 0.5 until resolved".
6. **Scope / what to build** — the detailed, sectioned body: API endpoints with
   methods and fields, DB tables with columns and constraints, UI structure and
   states, the exact behavior. This is the bulk. Concrete beats vague every time —
   name the endpoint, the column, the file, the state.
7. **Invariants & security** — single-writer rules, tenant-scoping/RLS,
   fail-closed secrets, server-side validation, idempotency, audit. Anything that,
   if violated, is a correctness or security bug. Flag security-sensitive tickets
   so ship-ticket routes them to its strong model.
8. **Out of scope** — what this ticket deliberately does NOT do, with the ticket
   key that owns it. Prevents scope creep and phantom deferrals.
9. **Acceptance criteria** — a checklist a *reviewer* can verify, not vibes. Each
   line is objectively checkable. Cover the happy path, the invariants, the edge
   cases, i18n/RTL if UI, and build/lint/test green. If UI: "GATE 4 parity passed
   against pinned SHA per template/screen."
10. **Recon required** — every `[TODO-VERIFY]` collected: the assumption + the
    command or file to check it against. Empty section is fine (and good) when
    everything was verified.
11. **Links** — related/blocks/blocked-by keys, source doc, design refs.

Write in the same voice as this project's best tickets: precise, imperative,
concrete file/endpoint/column names, and reasons attached to decisions.

**Bug tickets take a different section 6.** Everything above still applies, but a
bug's "Scope / what to build" is wrong-shaped — you don't yet know what to build,
you know what's broken. Replace it with **Defect report**, and keep the rest:

- **Steps to reproduce** — numbered, from a stated starting state, with the exact
  input/data used. A repro nobody can follow is the #1 reason bugs bounce back.
- **Actual vs. expected** — both, explicitly. "It's broken" is not a bug report;
  name the observed behaviour and cite what says it should be otherwise (spec,
  design, an AC on another ticket, a documented invariant).
- **Environment & scope** — version/branch/commit, browser or runtime, tenant or
  role if it only reproduces for some, and **how many users/rows are affected**.
- **Regression window** — did this ever work? If yes, the last known-good version
  and the suspect change. If unknown, say unknown — don't guess a culprit commit.
- **Evidence** — error text, stack trace, failing request/response, log line, or
  screenshot path. Paste the real string; don't paraphrase an error.
- **Suspected cause** — optional, and explicitly labelled a *hypothesis*, not a
  finding. A wrong hypothesis stated as fact sends the implementer down it.

A bug's **acceptance criteria** lead with the repro: *"the steps above no longer
produce the actual behaviour"*, plus **a regression test that fails before the fix
and passes after** — that test is what stops it coming back. Root-cause fix, not
symptom suppression; if the ticket is deliberately a mitigation, say so and name
the follow-up ticket that does the real fix.

## Step 4 — write the CSV

`references/csv-format.md` defines the columns for each tracker. Default to Jira;
switch to Azure DevOps if the user says so or the project is AZ.

- **Body-in-CSV limits.** Trackers mangle long markdown in CSV cells. Put the full
  body in the `.md` file; in the CSV `Description` column put a **condensed but
  complete** version (summary + blockers + ACs at minimum), and reference the md
  filename. Escape newlines/quotes per the tracker's CSV rules.
- One row per ticket. Include the columns the user's tracker needs for import
  (Summary, Issue Type, Priority, Labels, Description, and Epic Link / Parent if
  part of an epic).

**The CSV is the lossy path — say so.** Downstream, `ship-ticket` reads the ticket
**from the tracker**, not from `tickets/*.md`. So whatever lands in the tracker
description is all the implementer gets. Two routes, and they are not equivalent:

- **MCP creation (preferred)** — the Atlassian/AZ create call has no CSV cell
  limits, so the creation step should push the **full `.md` body** into the
  description. Nothing is lost.
- **CSV import (fallback)** — only the condensed row survives. Anything trimmed
  out of `Description` is invisible to the implementer.

State this in the hand-off so the user picks knowingly, and make each condensed
`Description` self-sufficient enough to build from on its own.

## Step 5 — the consistency pass (do not skip; it is the only enforcement)

Everything above is a rule you *followed*. This step is where you *check* you
followed it. Run it over the whole set before writing `INDEX.md` — every rule
below is mechanically checkable, so check it rather than trusting the draft.

**Reference integrity**
- [ ] Every slug named in a **Blockers**, **Out of scope**, or **Links** section
      resolves to either a `.md` file in this set, or a key you actually read
      from the tracker in Step 1. Anything else is a **phantom reference** — the
      failure this skill exists to prevent. Fix it: point at a real ticket,
      generate the missing one, or fold the work back in.
- [ ] No key-shaped string (`ABC-123`) appears anywhere you did not verify.
- [ ] Every "follow-up" / "later" / "separate ticket" phrase names something.

**The dependency graph**
- [ ] It is **acyclic.** Walk `blocked by` edges; if A → B → A, nothing in that
      cycle can ever start. Break it — usually one of them is really two tickets,
      split at the seam.
- [ ] Every `blocks` has the matching `blocked by` on the other ticket, and vice
      versa. One-directional edges produce a ship order that lies.
- [ ] Same-file contention is noted on **both** tickets, not just one.
- [ ] At least one ticket is startable now. If every ticket is blocked, the set is
      either cyclic or missing its first ticket.

**Per ticket**
- [ ] Every inline `[TODO-VERIFY]` also appears in that ticket's **Recon
      required** section. An uncollected one is invisible at hand-off.
- [ ] It has **at least one** acceptance criterion, and every AC is objectively
      checkable. Reject the unfalsifiable: "works correctly", "is performant",
      "handles errors gracefully", "code is clean". Each must name what is
      observed and what makes it pass.
- [ ] The build/lint/test AC names the **repo's real command**, not the
      template's placeholder.
- [ ] UI tickets have a Design source of truth (or a flagged `[TODO-VERIFY]`).
- [ ] No sprint label, no story points, no effort estimate.
- [ ] Bug tickets have repro steps, actual vs. expected, and a regression test AC.

**The CSV**
- [ ] Header column count == every row's column count. Re-parse the file you wrote
      rather than eyeballing it — one unescaped `"` shifts every field after it
      and the import lands data in the wrong columns.
- [ ] Every `(full spec: X.md)` names a file that exists.
- [ ] Every non-empty `Epic Link` / parent is a key that actually exists.
- [ ] One tracker's schema only — never two in one file.

Report what you fixed. **If something can't be fixed, say so in the hand-off** —
an unresolvable dangling reference or a cycle you couldn't break is exactly what
the user needs to see, and burying it re-creates the problem this step exists to
catch.

## Step 6 — write the index and hand off

Write `tickets/INDEX.md`: the ticket list with a **slug → tracker key** column
(keys blank until creation), the **dependency-ordered ship sequence**, which are
ready-now vs. blocked, any parallel-lane notes (independent tickets that can run
beside each other, same-file conflicts that can't), and the CSV conventions you
chose (tracker, label encoding, newline handling) so the import behaves. Then tell
the user:

- the files produced and the absolute path,
- the recommended ship order,
- that **nothing has been added to Jira/AZ** — the next step (their choice) is
  either "add these to Jira/AZ" via MCP (full body, lossless) or importing the CSV
  (condensed body, lossy),
- **any ticket still carrying `[TODO-VERIFY]`**, named — those are the ones that
  will stall an implementer,
- **anything Step 5 could not fix** — a dangling reference, a cycle, a missing
  design source of truth,
- that each ticket then feeds `ship-ticket` for implementation.

**For a single ticket, skip the index.** `INDEX.md` earns its place by carrying a
ship order and a dependency graph; with one ticket there is neither, and a
one-row index is pure ceremony. Emit the `.md` + the one-row CSV, and put the
slug → key note and the CSV conventions directly in the hand-off message. Step 5
still runs — the per-ticket and CSV checks all apply.

Do **not** create anything in a tracker in this skill, even if asked in the same
breath — confirm generation is what they wanted, produce it, and let the creation
be its own explicit step.

## Guardrails

- **Content only.** This skill never calls a Jira/AZ create tool. Generation and
  creation are separate steps by design.
- **No invented planning metadata.** Suggest labels, never a `sprint-N` — the user
  assigns sprints manually. The same rule covers **story points, effort, and
  t-shirt sizes**: an estimate you made up is indistinguishable from one the team
  agreed on, and it silently feeds velocity and capacity planning. Leave the field
  blank, or ask. "This looks like a large one" in the Context section is fine —
  a `5` in a Story Points column is not.
- **Verify before asserting; TODO-VERIFY when you can't.** An authoritative-looking
  ticket built on unchecked assumptions is the failure mode this skill exists to
  prevent.
- **Every deferral names a real ticket.** No "future follow-up" without a key or a
  ticket in the same generated set — referenced by its slug, never by an invented
  key (see *Ticket identity* above).
- **Use the project's real build command.** The template's green-build AC is a
  placeholder — read the actual command from `package.json` scripts, `CLAUDE.md`,
  the Makefile, or CI config and write *that*. A ticket whose AC names a build
  command the repo doesn't have is a ticket the implementer can't close.
- **Match the project's stack and conventions** when known (read `CLAUDE.md`, the
  design system, existing tickets). Don't impose a generic template's assumptions
  over the repo's reality.
- **Right-size the detail.** A one-line config change doesn't need a 12-section
  spec; a payments integration does. Depth scales with the work — but blockers,
  ACs, and out-of-scope are never skipped.
