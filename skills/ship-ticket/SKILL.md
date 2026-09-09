---
name: ship-ticket
description: |
  Implement a Jira or Azure DevOps ticket end-to-end, on ANY stack — the stack is
  detected from the repo, never prescribed. This skill is a delegator: it owns the
  workflow and routes every language and framework judgment to the code-quality
  family, to `vapt`, `test-quality` and `docs-accuracy`, and to the repo's own
  conventions. Angular, React, Vue, Express/Node, Django, Laravel, Go, Rails,
  Cloudflare Workers, Postgres/Supabase — all supported.

  Six phases: UNDERSTAND the ticket, PLAN it with human approval, BUILD it,
  PROVE it works and is not exploitable, REVIEW it with three independent
  reviewers over one frozen manifest, then SHIP it. Adds a mandatory
  design-source-of-truth read with a pinned SHA, a plan-mode approval gate, a
  CI-enforced design-parity check, adversarial abuse tests committed for every
  trust boundary the change introduces, and a cross-model review — a fresh Claude
  reviewer, the OpenAI Codex CLI, and a rule pass, each blind to the others.

  Every applicable rule, screen, surface and attack class runs on every ticket, at
  constant reasoning effort. Nothing about a ticket's size or labels reduces what
  is checked; only how much runs concurrently varies. Companion skills degrade
  loudly when absent — declared, never silently skipped.

  Takes one argument: the ticket key, work item ID, or URL.

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

# /ship-ticket — implement a ticket end-to-end

One argument: a ticket key, work item ID, or URL (`SCRUM-28`, `…/browse/SCRUM-28`,
`1234`, `AB#1234`, a `dev.azure.com/…/_workitems/edit/1234` link). Reusable across
projects — never hardcode a cloudId, site, org, or project; resolve whatever the
user gave against whatever tracker connection exists.

## How to talk to the user

The user is following their own ticket, not reading this file. **Lead with a plain
sentence; put the code in brackets after.** Never the code alone.

```
✅  Security check on the new endpoint: passed [BE-SEC-03]
❌  BE-SEC-03 | PASS
```

**Test: could someone who has never opened this file act on it?** If a name needs
its own glossary, it is not a name — say what happened instead.

| Instead of | Say |
|---|---|
| GATE 3 / the rule pass | **Checking the code against the project's rules** |
| GATE 4 / parity | **Checking the screen matches the design** |
| GATE 5 / VAPT | **Trying to break the new code on purpose** |
| pass A | **A second reviewer who didn't write the code** |
| pass B | **A different AI reviewing it independently** |
| pass C | **Going through the rule checklist one by one** |
| `AI-FM` | **Common AI coding mistakes** — fake success, swallowed errors, dead code |
| `UNIVERSAL` | **General code health** — simple, not repetitive, not over-built |
| `TEST-*` / `DOC-*` | **Whether the tests test anything** / **whether the docs still tell the truth** |
| `[NN]` / `[ARCH]` / `[D]` | **Must fix** / **structural, project-wide only** / **a convention** |

**When something stops, say what it means for the user**, not which check fired:

```
✅  Stopped: I can't run the app locally, so I can't test whether the new endpoint
    is actually protected. I need a way to run it.
❌  STOP: GATE 5 has no local instance.
```

Rule IDs stay in findings, skips and artifacts — the ID *is* the citation — but
always with a clause saying what the rule requires.

**Two channels, and do not mix them.** The user gets phase names, consequences,
decisions and the outcome. The artifacts and session log get the rule IDs,
manifest digests, scope digests, signer identities and coverage evidence.

**Announce each phase as it starts, in one line, and do not wait for a reply.**
Six lines over a whole ticket. This is the only progress reporting required, and
it is not a question.

## The six phases

| Phase | Does | May write | Exits with |
|---|---|---|---|
| **UNDERSTAND** | read the ticket, triage it, pin the design reference, detect the stack | nothing | a startable ticket and a pinned `design_ref` |
| **PLAN** | draft, get an independent critique, get **human approval** | `.specs/plans/<TICKET>.md` only | an approved plan + the Design Contract |
| **BUILD** | branch, then implement in the plan's sequence inside the contract | contracted files | the feature, rules applied as it was written |
| **PROVE** | run the repo's commands; prove the security controls exist, then that they engage | production + test code | green commands, committed abuse tests |
| **REVIEW** | freeze a manifest; three blind reviewers; reconcile; fix; sign | fixes at barriers only | a signed, reconciled change |
| **SHIP** | one commit, one push, one PR, one CI wait, ticket to Done | the single gated commit | a linked PR and a closed ticket |

**Phases are ordered. Work inside a phase runs concurrently wherever two things do
not need each other's answer** — that is where the time is won, and it is the only
place it is won. Never buy speed by checking less.

Load the phase's reference when you enter it, not before:

| Entering | Load |
|---|---|
| UNDERSTAND | [references/understand.md](references/understand.md) |
| PLAN | [references/plan.md](references/plan.md) |
| BUILD | — the spine is enough |
| PROVE | [references/prove.md](references/prove.md) |
| PROVE, if `ui_required` | [references/design-parity.md](references/design-parity.md) |
| REVIEW | [references/review.md](references/review.md) |
| REVIEW, for the Codex pass | [references/codex-cli.md](references/codex-cli.md) |
| SHIP | [references/ship.md](references/ship.md) |

## The invariants

These bind in every phase. Everything else is procedure.

1. **The spec comes from the tracker.** Never guess it, never infer it from code.
2. **A human approves the plan.** Not you, not Codex. An edited plan is the new
   plan; approval is the only thing that sets `approval_status: approved`.
3. **Branch before the first repository write of any kind** — including the plan
   artifact. Never implement on the default branch.
4. **One contract governs which files may be written.** A file you need that is
   not in it means the plan was wrong: that is a material divergence and it goes
   back through plan mode. Do not widen the contract yourself.
5. **Coverage is constant.** Every applicable rule, screen, surface and attack
   class runs on every ticket, at constant reasoning effort. No ticket property —
   size, label, urgency — reduces it. `security-sensitive` *adds* an independent
   signature; it removes nothing.
6. **Apply the rules while writing.** The gates verify a claim you already made.
   A gate returning a long list means this was skipped.
7. **Reviewers are report-only and blind to each other. You are not.** A reviewer
   that edits code invalidates its peers. You collect findings and *you fix them*.
8. **Nothing writes to the repository during the review wave** — that is the whole
   basis of the manifest's integrity. Fixes happen at barriers.
9. **Attacks run against a local, disposable instance. Never production, never
   shared staging**, whoever owns it.
10. **Three mutations, then a human.** See *The mutation budget*.
11. **A skip cites a rule ID. A parity deviation cites a named human.** Neither
    accepts prose.
12. **Degrade loudly.** A missing companion is declared in the run record, up
    front and at the end. An undeclared degradation is itself a stop.
13. **One ticket, one branch, one commit, one PR.**

## Rules, tiers, and what may override them

The code-quality family assigns every rule a stable ID (`NG-ARCH-03`,
`BE-WHK-04`) and one tier. **A claim about a rule cites the rule** — prose about
"our conventions" is not a citation.

| Tier | Meaning | What can override it |
|---|---|---|
| `[NN]` | non-negotiable security or correctness invariant | **Never, per-file. Only an explicit recorded user waiver.** |
| `[ARCH]` | architectural shape | `CLAUDE.md`, project-wide only — **or** an established project architecture that passes the invoked specialist's **four-condition test**. That outcome is an `N/A — replaced by established project architecture` row carrying its evidence: not a skip, and not a ledger waiver |
| `[D]` | default convention | `CLAUDE.md`, or an established repo convention |

The four-condition test lives in the specialist that owns the rule — invoke it
rather than reasoning about the collision here. Its shape: enumerated repo-wide
evidence covering the cited rule's full applicability · ratified by a
project-level source predating the ticket or by the user, never a code comment ·
the rule protects structure, **never** a security, privacy, availability or
integrity control, judged by effect · and the alternative genuinely would be a
second pattern. Fewer than four and the rule stands.

**Parity is not a rule.** Structural and visual fidelity maps to no rule ID, so
its citation is a named design decision plus a human approver. Passing every
`NG-*` / `BE-*` rule does not mean the screen is the design.

## Is this security-sensitive?

**Read the flag off the ticket first, then judge for yourself.** If the ticket
carries an explicit marker (`generate-ticket` writes one; trackers often carry a
label), honour it. **Its absence proves nothing** — so apply your own test: a
ticket touching auth, multi-tenancy, billing, payments, secrets, or any
cross-tenant isolation **is** security-sensitive whether or not anyone labelled it.

Record the determination in the plan either way. That field adds the independent
signature on the attack testing — **it changes no coverage**, so getting it wrong
costs the signature, never the attacks. Do the reasoning on the strong model, and
prefer a test-first repro: the failing test that proves the secure behaviour, then
the implementation.

## The mutation budget

Everything after BUILD can loop: a gate fix changes what the gate measured, an
attack fix moves the surface that was attacked, a review fix invalidates the
reviewers. Left uncapped these produce a twelfth round.

**One counter governs all of them.** `mutation_round` lives in the plan
artifact's metadata and starts at `0`.

- **Every batched mutation made in response to a gate, an attack, a review
  finding, or a scope change that invalidates a signature increments it once.**
- **Revalidation that changes nothing does not increment it.**
- **Always validate the third mutation.** If validation still requires a fourth,
  ✋ **STOP** and surface it: what is still changing each round, which check it
  keeps invalidating, the last round's unfixed findings, and your read on why it
  is not converging.
- **Only a human-approved re-plan resets it.**

**Increment it only at a write barrier**, as part of the batch whose result becomes
the next manifest. Touching it mid-wave mutates frozen state and invalidates every
running pass.

Non-convergence is a finding, not a retry. A fourth round costs more and learns
nothing; spawning agents to break the deadlock adds cost, not information.

## Companions, and what happens without them

Three kinds, three different tests — do not use the wrong one:

- **A skill** is available if it is in the available-skills list or a sibling
  folder in `~/.claude/skills` / `~/.agents/skills`.
- **A CLI** is available only if the binary answers: `codex --version`, `gh --version`.
- **Concurrency** is a property of the agent you are, not of anything installed:
  can you dispatch concurrent read-only subagents, and can you run a
  schema-validated resumable workflow? Declare what you have.

A skill that wraps a CLI needs both. An installed-but-unauthenticated CLI fails at
dispatch, not at the check; treat that as the same degradation when it happens.

| Missing | Costs | Fall back to |
|---|---|---|
| `angular-code-quality` / `backend-code-quality` | the Design Contract and the specialist rule rows | the `code-quality` hub; if no family member exists, review against SOLID and this repo's conventions, emit a `RULES \| DEGRADED` row rather than an empty table, and **no finding may be skipped** — with no IDs loaded there is nothing to cite |
| `code-quality` hub | the whole-diff `UNIVERSAL` row | walk the universal layer yourself; mark the row `DEGRADED` by name. Never drop it |
| `vapt` | the `VAPT-*` rule set — **not the gate** | run the reduced form yourself against a local instance, per family (see [prove.md](references/prove.md)), commit the tests, record `DEGRADED`, and name the untested **families** plus `rule_inventory: unavailable` — never invent an ID |
| `test-quality` | the guard's execution, **not the row** | reject obvious implementation-detail assertions and unjustified mocks yourself; emit `TEST \| DEGRADED \| <what you checked>` |
| `docs-accuracy` | the wider DOC rule set | the rename grep still runs |
| `codex-delegate` **+** `codex` CLI | the plan critique | present the plan for approval saying "no cross-model plan review — skill or CLI unavailable". The user's approval was always the gate |
| `codex` CLI | pass B | `/coderabbit:code-review` on the same manifest. If neither exists, say "**pass B unavailable: one free-form reviewer plus rule pass C**" — never a second self-review presented as pass B |
| a fresh-reviewer route | pass A and the independent signature | a fresh reviewer subagent, or a read-only `codex-delegate` dispatch. Independence is about *who reviews*, not the command name |
| concurrency | wall clock only | run the identical passes serially over the identical manifest and declare `orchestration: serial`, naming which wave |

**Two losses are STOPs, not degradations** — both are about signers. A UI ticket
with no independent reviewer route cannot sign its own parity. A
`security-sensitive` run is *defined* by that signature. Neither downgrades.

**`/code-review` is CodeRabbit's**, not Claude's — the repo reserves that name.
Pass A is a **fresh reviewer subagent with no build context**; `/coderabbit:code-review`
is pass B's fallback engine. Never let one command fill both slots.

**`/code-review ultra` is user-triggered and billed — never launch it.** If the
diff warrants it, say so and let the user decide.

**Declare the mode twice**: once up front when detected, once in the run record.
A run that silently skipped a check is indistinguishable from one that failed it.

---

## UNDERSTAND

> "Reading the ticket and working out what's involved."

Load [references/understand.md](references/understand.md) — it carries the tracker
table, the triage checks, the design-system formats, and how recon waves work.

**Everything in this phase is a read, and almost none of the reads need each
other's answer. Run them together.** A ticket can lose an hour here before a line
exists. Recon runs in waves because answers raise the next question; cap it at
three waves, and at the cap an unresolved question becomes a *Risks* row or a
STOP — never a fourth wave.

Four things must be true before you leave:

1. **You have the ticket's full spec**, from the tracker, including ACs, comments
   and linked parents. Cannot fetch it → ✋ STOP.
2. **The ticket is startable** — blockers resolved, ACs exist, nobody else is on
   it, and it is one shippable unit. Any of those fails → ✋ STOP or propose the
   split.
3. **For UI work, the design reference is read AND pinned.** Open the token file,
   the conventions doc and the screen — do not skim the ticket's description of
   them. Then record `design_ref`: the reference must already be committed, or
   there is no SHA to diff against and parity is unverifiable. Not committed → ✋ STOP.
4. **The stack is detected** — `CLAUDE.md` first, then manifests, then how the
   existing code is actually written, then the real lint/build/test commands.
   The repo's established pattern outranks anything this file or a quality skill
   prefers. Genuinely ambiguous → ask once.

**Resuming?** If `.specs/plans/<TICKET>.md` exists, read `approval_status` and
route through *Resuming* below rather than re-planning.

## PLAN

> "Working out what to build, and getting your approval before building it."

Load [references/plan.md](references/plan.md) — the plan template, the Codex
critique dispatch, and how the Design Contract is composed.

**Nothing has been written to the repository yet, and nothing may be until the
branch exists.** Plan mode enforces that mechanically; that is why it is the gate.

1. **Enter plan mode.** Research and plan only.
2. **Run the recon wave** (above). Stop when you can name every file the build
   sequence touches and every contract it depends on — not when curiosity ends.
3. **Draft the plan** using the template. Mark the **`Par` column**: steps that
   share a letter have no dependency on each other and touch no file in common,
   so they get built together. On a full-stack ticket the frontend does not wait
   for the backend — it waits for the **API contract**, which is its own first
   step and must name a real artifact, not an agreement.
4. **Run the deterministic pre-checks** — every path exists or is explicitly new,
   every command is real, the sequence is acyclic, nothing already implements
   this. These are free and they answer the cheapest questions a critique would
   otherwise spend its budget re-deriving.
5. **Send the finished draft to Codex, read-only, before the user sees it.**
   Send the pre-check results as *given*. Reconcile every finding into the draft
   or reject it with a reason a reader can check. Both outcomes get a row.
6. **Present the reconciled plan for approval** (`ExitPlanMode`). Implementation
   starts on approval and not before. A plan approved only by its author — or by
   its author and Codex — is not approved.
7. **Branch** (see BUILD), **then** save the approved plan to
   `.specs/plans/<TICKET>.md` with its metadata header, and emit the **Design
   Contract**: invoke the routed code-quality skill by name and derive the file
   list from the approved build sequence.

**Plan mode unavailable** (headless, workflow, subagent): still run the Codex
critique — it is a shell dispatch and needs no plan mode — then write the artifact
with `approval_status: pending` and ✋ **STOP**, surfacing it as the approval ask.

The metadata header carries `approval_status`, `design_ref`, `ui_required`,
`owned_screens`, and `mutation_round: 0`. Every owned screen is classified
**reference-backed** or **unreferenced** *now*, at plan time. An unreferenced
screen needs search evidence and a **named human approver** — a screen the ticket
invents has no comparator, and inventing one later is the self-attestation the
parity check exists to remove.

## BUILD

> "Building it."

1. **Branch first.** Never the default branch. Fetch, branch from an up-to-date
   base, name it after the ticket. An existing ticket branch is reused, not
   duplicated — and if it carries WIP commits, ✋ STOP for the preserve-or-squash
   decision *before* rebasing. Someone else's uncommitted work in the tree → ✋ STOP.
2. **Build in the plan's sequence — and build a `Par` group together.** Name the
   groups before you start; report which actually ran concurrently. **A group you
   serialized needs a stated reason, and the record is written to the plan
   artifact** — an unrecorded serialization is indistinguishable from one that
   never happened, and it is a ✋ STOP.
3. **Apply the rules as you write each file**, against the rules that govern its
   role. **This is the single biggest lever on how long the rest takes.** Every
   violation caught here never becomes a finding, never becomes a fix, and never
   invalidates a digest — and that invalidation is what turns one round into
   twelve.
4. **Check each screen as you finish it**, while the design files are still in
   context. Reference-backed → against its reference. Unreferenced → against the
   design system: tokens, shared components, conventions, states. Both are checks;
   only one is parity.
5. **Write only files in the contract.** Anything else is a material divergence.
6. **Compose, don't hand-roll.** Reuse the shared components; hand-rolled tables,
   inputs and pagers are the main cause of drift.
7. **Security-sensitive work is test-first** — the failing test that proves the
   secure behaviour comes before the implementation.
8. **Migrations are additive and committed**, using **this project's** migration
   tool and naming convention — read the existing `migrations/` directory rather
   than assuming one. Never introduce a second migration mechanism alongside the
   one already there.
9. **Build to done, then report.** Three things interrupt: a STOP condition, a
   material divergence, and a product decision the ticket does not settle. Short
   of those, stopping to ask whether to continue with something the plan already
   approved turns an approved plan back into a conversation.

## PROVE

> "Making sure it works, then trying to break it."

Load [references/prove.md](references/prove.md), plus
[references/design-parity.md](references/design-parity.md) if `ui_required`.

**Run the repo's own lint, build and test commands first** — read them from the
repo, never assume a runner. Fix what fails. Run them concurrently only where the
repo proves that is safe.

Then four ordered stages. **Only the first is concurrent:**

1. **Concurrent reads** — the static security rows, the parity artifact and its
   classifications, the attack surface inventory and abuse-case *design*, and the
   docs scan. All reads, none needing another's answer.
2. **Barrier → one batch of fixes → re-derive.** Compare the changed files against
   each product's inputs and re-run every product whose inputs moved. A surface
   enumerated before the fix that created it was never enumerated. Increments the
   mutation budget once.
3. **Live attacks, serially.** They share a port, a datastore and destructive
   state. Never before stage 2 settles, or you are attacking a map of the old code.
4. **Barrier → fix → back to stage 2.** An attack fix is production code: it can
   move a route, a middleware, a rendering sink. Bounded by the mutation budget.

**What must be true to leave:**

- **The security controls exist in the code** — traced through their whole static
  path, including unchanged middleware, config and base classes. Where no static
  mapping exists, that half is *declared degraded*, not proven.
- **They engage at runtime.** Every applicable attack class runs against every
  in-scope route. **Applicability alone decides which classes run** —
  `security-sensitive` adds an independent signature and changes no coverage.
- **The output is committed tests** in the repo's own runner, asserting the
  refusal. Not a report: CI blocks, not a summary.
- **`test-quality` has run once** over the whole final test diff, ordinary and
  abuse tests together.
- **The docs are true**, fixed now — a doc edit after the review is unreviewed
  content in the commit.
- **For UI: the parity artifact is assembled**, each screen classified, no grade
  produced, and **nothing from BUILD reaches the reviewer.**

An `[NN]` finding is fixed, never cited away. Loosening or deleting the test is
not a fix. No local instance, or the only reachable one is shared → ✋ STOP.

## REVIEW

> "Three reviewers checking the change at once, then I fix what they find."

Load [references/review.md](references/review.md) and, for pass B,
[references/codex-cli.md](references/codex-cli.md).

Everything that writes is now done. **Freeze the manifest** — a shared, stable
description of what is being reviewed, computed **once** and handed identically to
every pass. It is an integrity check over the live tree, not a commit and not a
stash. Its safety rests on the passes being read-only and on you writing nothing
during the wave.

**Dispatch all three together**, each bound to the manifest, each blind to the
others, each report-only: **pass A** a fresh reviewer with no build context (and,
for UI, the sole parity investigation), **pass B** `codex` — a different model in
a different process, started **first** because it is routinely the longest — and
**pass C** the rule checklist, one row per rule in force.

They are expected to confirm what BUILD already did — and they must still find and
report every violation at full severity, exactly as if no build-time check had
run. A long list means BUILD skipped its checks; it never means a pass should have
looked less hard.

**Then one barrier, one batch:** verify each pass's coverage against the manifest
and re-run any that reviewed less; re-run any pass the manifest outran; reconcile
into one attributed set and apply **one batched fix set**; re-run the affected
commands; revalidate only the delta. Each round increments the mutation budget,
and the budget bounds the sequence.

**Do the work; don't narrate it.** After the barrier you have the findings and the
authority. Two things go to the user first: a STOP condition, and a genuine
product decision. **Everything else you fix.** If you are writing "here are the
findings, shall I…", the answer is yes — you already had it.

**Fixing is the default; skipping requires a citation** — a `[D]` or `[ARCH]` rule
named by ID. "It conflicts with our conventions" can be written about any finding,
which is exactly why it is not accepted. If you reach for the ID and the rule does
not say what you need, the reviewer was right. A finding contradicting an `[NN]`
rule is never skipped → ✋ STOP.

**A finding can also simply be wrong.** Reject it with the code or ticket fact
that disproves it — not with intuition, and not by implementing it anyway.

**Then sign, once the payload is final.** Residual Blocker/Major clears only with
a named human approver and date. Every stub links its follow-up ticket. Only then
does the independent reviewer sign — a signature written before close-out edits
binds to a payload that no longer exists.

## SHIP

> "Opening the PR and closing the ticket."

Load [references/ship.md](references/ship.md).

1. **Write the run record and the session log before the commit**, so they ride it.
2. **Verify every change since the last accepted manifest is on the allowlist.**
   Code, tests or docs outside it are unreviewed content — re-run the wave for them.
3. **One commit** — code, plan artifact, parity artifact, vapt artifact and its
   abuse tests, doc updates, session log — and **one push**.
4. **Open the PR on the repo's actual host**, link the ticket, report the URL.
5. **Wait once** for CI. Do not poll the PR-side bots; they are informational.
   **Push nothing further unless a gate actually fails** — a doc-only commit after
   green re-triggers the whole cycle.
6. **Transition the ticket to Done** only after the checks are green, then tell
   the user the PR is ready and ask them to run `/compact`.

---

## The run record

**One schema, three consumers.** The user's report, the session log, and the
success criteria are the same facts — write them once. The user's version leads
with plain sentences; the log and artifacts carry the identifiers.

Every gate and row declares exactly one outcome:

```
PASS_FULL                          ran in full
PASS_REUSED                        deterministic output reused — name it and the digest
                                   it bound to. Never a semantic judgment
PASS_GROUPED                       shared test definitions — name them, and confirm every
                                   route was executed against them
FAIL                               did not pass. Blocks acceptance and close-out
NOT_TRIGGERED                      + detector name and version, the complete changed-file
                                   classification, and a digest of that output
NOT_APPLICABLE_NO_SCREEN_REFERENCE + approver, date, and reference-search evidence
DEGRADED                           + the classes that could not run, by ID
```

**A blank table, an omitted row, or a bare "N/A" is a FAIL.** Coverage is
constant, so a check that examined less than it should is a bug. Presentation may
aggregate rows already computed per rule — naming the IDs and the identical
detector, inputs, digest and result behind them. Evaluation may not: a
family-level detector standing in for per-rule evaluation is coverage loss.

Record, in the artifacts:

- the **companion mode** and every degraded check, by name
- the **orchestration mode of each wave** — recon and review; they can differ,
  and a run that fanned out its review while serializing an hour of recon is not
  a concurrent run
- **every manifest ID** and which is the accepted one
- **each check's outcome**, from the list above
- **the complete finding count first, at full severity** — then, separately, how
  many BUILD should have caught. **That classification never changes whether a
  finding is reported, its severity, or a verdict.** A high count is a BUILD
  problem to drive down, never a reason to report less
- **which `Par` groups actually ran concurrently**, and the reason for any that
  did not
- **which engine ran pass B**, at what effort, and whether it timed out
- the **plan critique's disposition**, and the **final `mutation_round`**
- per reference-backed screen: its grade, its signer, and the scope digest;
  per unreferenced one: its approver, date and search evidence
- the attack surfaces, the committed abuse tests, every class **degraded by ID**,
  and every changed file excluded and why
- every **skipped finding with its rule ID**, and every human-approved deviation
  with its approver and date
- the design files read and the pinned `design_ref`
- **phase timings** — start and end per phase, agent time kept separate from
  human-approval and CI wait, plus the overlap window of each intended parallel
  group

**Written so it survives the context.** "Tried to break the new endpoint — all
attacks refused" is recoverable months later; "GATE 5: PASS" is not. "Skipped some
findings that conflicted with our conventions" is worthless.

## Stop conditions

**STOP and tell the user.** Every one of these is unconditional — none may be
reclassified as work. An unpinnable reference is not an invitation to commit one;
a missing signer is not an invitation to sign it.

**What this list is not is a licence to stop elsewhere.** A difficulty not on it —
a finding you can fix, a test you can write — is work, and work does not stop the
run. **When you do stop, say what it means for the user and exactly what you need**,
so the answer is one message and not a negotiation.

*Getting started*
- You can't fetch the ticket, or can't tell which tracker it belongs to.
- A blocker is not in a completed state — name it and its state.
- The ticket has no acceptance criteria and none you proposed were approved.
- Someone else is already on it — assignee, In Progress, or an existing branch/PR.

*Plan and contract*
- You're about to write implementation code without a human-approved plan.
- You'd be implementing on the default branch, on an unsynced base, or on top of
  someone else's uncommitted work.
- A file you need is outside the Design Contract.

*Design*
- You can't locate the design system for a UI ticket.
- A UI ticket's reference screen is not committed — it cannot be pinned.
- A screen grades Major or Not-built and you can neither fix it nor clear it as a
  human-approved deviation.
- No independent signer can be obtained for a UI ticket, in any mode. Parity never
  self-signs.

*Security*
- No local instance to attack, or the only reachable environment is production or
  shared staging.
- An `[NN]` finding can't be fixed inside the ticket's scope, or the fix would
  require changing auth, tenancy or billing architecture — that is a decision.
- No independent signer for a `security-sensitive` run. It is *defined* by that
  signature; losing it is a stop, not a downgrade.

*Review*
- A finding contradicts an `[NN]` rule.
- The rule pass reports a FAIL you cannot fix.
- The manifest changed during the wave and you cannot re-run the passes it
  invalidated.
- A pass returned without verifiable coverage, or without the required finding
  shape, and cannot be re-run.
- Content outside the post-freeze allowlist changed.
- **The mutation budget reached its third round and validation still requires a
  fourth.**
- A signature is stale — its scope digest is not the final one — and no fresh
  independent signature can be obtained.

*Everywhere*
- A `Par` group was serialized with no stated reason, or the execution record is
  missing.
- You want to skip a finding and cannot name the rule ID, or claim a deviation and
  cannot name the human approver.
- Any PR, tracker or CI check fails.

An uncited skip is a fix you owe; a self-signed parity grade is not a verified
screen; an unpinned reference has nothing to verify against; an unfixed FAIL is
not a shipped ticket.

## Stopping and resuming

A stop is a pause. Leave the work recoverable: **do not revert, reset, stash or
delete the branch**, and **commit nothing to close it out** — this skill never
creates WIP commits. Report the branch, the phase you stopped in, what exists
versus what is missing, which artifacts are on disk, and the single concrete thing
needed to continue. Say explicitly what is **not** done. A stop that reads like a
completion is worse than a loud failure.

| On disk | Means | Do |
|---|---|---|
| `.specs/plans/<TICKET>.md`, `approval_status: approved` | the plan is settled | confirm it still stands, re-enter after the phase that stopped. **Do not re-run plan mode**, and do not re-dispatch the critique — it is part of that plan |
| `.specs/plans/<TICKET>.md`, `pending` or absent | a previous run stopped *at* the approval ask | take it back through approval. Do not build on it |
| `mutation_round` > 0 | rounds were already spent | read it, carry it forward. **Never auto-reset** |
| a ticket branch | work exists | use it, rebased. WIP commits → ✋ STOP for the preserve-or-squash decision |
| the parity artifact | parity ran | check whether its signature still binds to the current scope digest. A superseded signature needs re-signing, not re-drafting |
| the vapt artifact | attacks ran | re-run its committed tests; only re-attack surfaces the resumed work changed |
| `design_ref` | the reference is pinned | **reuse that SHA.** Re-pinning silently changes what the screen is verified against |
| a recorded wave | passes ran | resume only if the manifest ID still equals the current state |

**Re-check triage anyway** — blockers, assignees and open PRs all move.

## Scope

- One ticket, one branch, one PR. Don't batch unrelated fixes in.
- Don't preempt other tickets or over-engineer. An unbuilt dependency stops the
  run rather than getting stubbed.
- Unrelated problems you notice go to the user as a note or a new ticket, not into
  this diff.
- Parity covers the screens this ticket **owns**, not every consumer of a shared
  component you touched — that spawns a separate, flagged sweep.
- The **manifest is the scope of record** for the review, and it names every
  exclusion with a reason. An unexplained exclusion is the hole it exists to close.

## What this skill does not do

It **orchestrates**; it does not define. Keeping this boundary is what keeps the
file short enough to follow.

| Owned elsewhere | By |
|---|---|
| the code rules, SOLID, the universal principles, the AI failure modes | `code-quality` and its specialists |
| the attack classes, the trust-boundary taxonomy, the rules of engagement | `vapt` |
| what makes a test or a doc honest | `test-quality`, `docs-accuracy` |
| the brief format, the relay, the sandbox modes, `result.json` | `codex-delegate` |
| the review engines themselves | `/coderabbit:code-review`, `codex`, the reviewer subagent |

This skill owns *when* each is asked, *what it is asked about*, and the
orchestration around them: the contract, the manifest, the wave, the barriers, the
mutation budget and the delta routing.

It does **not** choose or impose a stack — the stack is the repo's. It does not
provide the concurrency; a serial orchestrator runs identical passes over an
identical manifest and says so. Concurrency changes the wall clock, never a
verdict. It does not merge the PR or run `/compact` — both are the user's.

**Always follow `CLAUDE.md`** — it outranks this file on any conflict.
