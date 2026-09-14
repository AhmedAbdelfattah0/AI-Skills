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
  PROVE it works and is not exploitable, REVIEW it with one discovery wave, one
  repair barrier and one terminal verdict, then SHIP it. UI work pins its design
  source and receives one complete parity comparison in round 1; the terminal
  reviewer checks only the dependency-closed UI slice changed by the repair.
  Runtime attacks remain in PROVE. Their evidence, parity evidence and the repair
  packet are reviewed together by the terminal reviewer, whose verdict is the
  signature.

  Every applicable rule, owned screen, trust boundary and attack class is covered
  at constant reasoning effort. Coverage may be degraded only when a companion is
  genuinely unavailable, and that loss is declared.

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
| the rule pass | **Checking the code against the project's rules** |
| parity | **Checking the screen matches the design** |
| VAPT | **Trying to break the new code on purpose** |
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
❌  STOP: attack testing has no local instance.
```

Rule IDs stay in findings, skips and artifacts — the ID *is* the citation — but
always with a clause saying what the rule requires.

**Two channels, and do not mix them.** The user gets phase names, consequences,
decisions and the outcome. Artifacts carry rule IDs, `F0`/`F1` manifest IDs, the
frozen-record digest, reviewer identities, finding IDs and verified coverage.
Persist lists and stable anchors; derive presentation counts instead of maintaining
them by hand.

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
| **REVIEW** | sweep and freeze the record; run A/B/C once; repair once; obtain one terminal verdict | predeclared run-state entries; one record-sweep batch before `F0`; one code-and-test repair batch | terminal PASS, or the current run ends unshipped |
| **SHIP** | one commit, one push, one PR, the enumerated CI gate, ticket to Done | the precommit projection and single gated commit; postcommit results stay external | a linked PR and a closed ticket |

**Phases are ordered. Independent work inside a phase runs concurrently** — that is
where the time is won, and it is the only place it is won. Never buy speed by
checking less.

**In REVIEW round 1 this is a requirement, not an optimisation.** Passes A, B and C
start together, B first because it is usually the longest, so the round costs the
longest pass rather than their sum. Running them one at a time is not a slower
mode of this phase, it is a stop: an orchestrator that cannot dispatch the three
concurrently ends the run rather than paying their summed wall clock for
identical coverage.

Load the phase's reference when you enter it, not before:

| Entering | Load |
|---|---|
| UNDERSTAND | [references/understand.md](references/understand.md) |
| PLAN | [references/plan.md](references/plan.md) + [references/codex-cli.md](references/codex-cli.md) |
| BUILD | — the spine is enough |
| PROVE | [references/prove.md](references/prove.md) |
| PROVE, if `ui_required` | [references/design-parity.md](references/design-parity.md) |
| REVIEW | [references/review.md](references/review.md) |
| REVIEW, for pass B | [references/codex-cli.md](references/codex-cli.md) — already loaded at PLAN |
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
5. **Coverage is applicability-driven and does not shrink with ticket size.**
   Every applicable rule and attack class runs. Every reference-backed owned
   screen receives one complete parity comparison in round 1; after a repair,
   only its dependency-closed impact slice is checked.
6. **Apply the rules while writing.** The review verifies a claim already made.
   A long finding list means the build-time checks were skipped.
7. **Round-1 reviewers are report-only and mutually blind.** The terminal reviewer
   is deliberately sighted on their findings and consequences, and is independent
   of the builder.
8. **REVIEW has one write barrier.** Sweep and freeze the ticket-owned record
   before `F0`; barrier 1 may then change code and tests once. After `F0` no
   candidate file and no frozen prefix may change; after the terminal verdict no
   candidate file may change at all. Before the commit, the append-only run-state
   slots and predeclared session-log projection are the exception; they record
   findings, dispositions, outcomes and timings without rewriting a reviewed
   prefix. The commit is the repository cutoff: SHIP outcomes that arise later
   are reported externally and never create another repository write.
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
| `[ARCH]` | architectural shape | the repo's own instruction file, project-wide only — **or** an established project architecture that passes the invoked specialist's **four-condition test**. That outcome is a `NOT_APPLICABLE — replaced by established project architecture` row carrying its evidence: not a skip, and not a ledger waiver |
| `[D]` | default convention | the repo's own instruction file, or an established repo convention |

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

Record the determination in the plan either way. The field requires an explicit
`security_outcome` in the terminal verdict; it adds no reviewer and removes no
attack coverage. Do the reasoning on the strong model, and prefer a test-first
repro: the failing test that proves the secure behaviour, then the implementation.

## The mutation budget

PROVE may need repair cycles; REVIEW may not. `mutation_round` counts every
post-BUILD candidate-changing repair batch before the terminal verdict:

- a PROVE repair batch;
- the one pre-`F0` batch, if it changes anything — formatter output, generator
  output and the record-sweep repair are that single batch, counted once;
- barrier 1's code-and-test repair batch.

**It is derived, not stored, and partitioned by run.** Human approval appends one
`run` `START` entry with a new opaque `run_id`; every later run-state entry carries
that ID. The active run is the final appended `START`, and `mutation_round` is the
count of `batch` entries whose `run_id` equals that active ID. Historical batches
remain append-only evidence but spend none of a later run's budget. There is no
scalar to read-then-edit inside the frozen prefix, which is what previously made
the counter and the record freeze contradict each other: every real repair would
have had to either break the count or trip the mismatch that ends the run.

Run-state events and result-slot writes are not candidate repairs and do not enter
`batches[]`. A read-only validation appends no batch and therefore spends nothing.

Always validate mutation 3. If validation requires another write, end the current
run before making it. Owner approval cannot extend the counter inside that run;
continuation requires a newly approved execution and a new `run_id`, appended
without removing or rewriting the concluded run.

Round 2 has no candidate write path and therefore cannot negotiate with this
budget. Any terminal finding is the outcome, not another mutation request.

## Verification has a stopping condition

The run ships only when:

> the terminal verdict is PASS · the enumerated CI gate is green · the frozen
> record prefixes are unchanged.

A terminal FAIL is not revalidated inside the same run. Preserve the branch,
report the evidence and end unshipped. If a required mechanical check never ran,
run that check directly before terminal review; do not wrap it in another review
wave.

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
| a fresh-reviewer route | pass A | **a UI or `security-sensitive` ticket STOPs** — pass A is the sole producer of the complete parity comparison that round 2 and CI both consume, and the terminal reviewer is forbidden from repeating it, so there would be nothing to degrade to. Otherwise declare pass A unavailable rather than presenting a builder self-review as independent; pass B and pass C still run |
| a one-shot independent reviewer route | every run's terminal verdict | a fresh reviewer subagent or read-only delegated review. No fallback to the builder. Check immediately after appending the REVIEW-start timing entry; absence ends the run there |
| round-1 concurrency | **nothing — this one is a STOP** | serial A, B and C costs their summed wall clock for identical coverage, which is the six-hour REVIEW this phase exists to end. There is no serial mode: end the run unshipped, recording "⛔ REVIEW stopped: this agent cannot dispatch A, B and C concurrently." Re-run REVIEW on an orchestrator that can fan out |
| the merge-blocking artifact checks | machine enforcement of the parity and attack artifacts | **GATE is detect-only**: list the repo's required checks (`gh api repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks`, or the Azure Repos branch policy) or read the CI config for a job naming the artifact paths. Present → validate the trigger and wait for it. Absent → record `enforcement_outcome: DEGRADED` with the locations checked and **do not wait for a check that does not exist**. Abuse tests still run in the existing test job. Install artifact enforcement only as explicit setup work with its CI paths in an approved Design Contract before that work's freeze |

**Two losses are STOPs, and they are the two the phase is built on.** The terminal
reviewer must be independent of the builder on every run — a one-shot route is
sufficient, and pass A's absence is a declared round-1 degradation while terminal
self-review is not. Round 1 must be dispatched concurrently; every other row above
trades coverage or evidence for availability, but serial execution trades only
time, and buying nothing with three times the wall clock is the failure this
rebuild was for.

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
4. **The stack is detected** — the repo's instruction file first, then manifests, then how the
   existing code is actually written, then the real lint/build/test commands.
   The repo's established pattern outranks anything this file or a quality skill
   prefers. Genuinely ambiguous → ask once.
5. **The gate is enumerated from the CI config, not from memory, and written into
   the plan.** Open the pipeline file — `azure-pipelines.yml`, `.github/workflows/`,
   `.gitlab-ci.yml`, `Jenkinsfile` — and list **every** step it runs. That list is
   the gate. Running a habitual subset and calling it green is how a branch
   reaches the pull request with checks that have never executed on it once.

   On one ticket this cost six hours of the user's day to discover at SHIP:
   `build`, `migrate:verify`, `check:suppressions`, `npm audit` and
   `openapi:check` were all in the pipeline, none had ever been run on the
   branch, and "the gate is green" had been reported many times meaning lint,
   typecheck and the two test suites. They all passed — which is the point. The
   cost was not a failure; it was not **knowing**, and finding out at the moment
   the branch was about to be pushed.

   **Every gate run runs the whole list.** A step you cannot run locally (a
   binary that is missing, something needing network or a secret) is
   `NOT-RUN`, declared in the run record, never counted as passing.

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
critique — it is a shell dispatch and needs no plan mode — then **branch** (the
artifact is a repository write like any other, and invariant 3 has no exception
for it), write the artifact with `approval_status: pending`, and ✋ **STOP**,
surfacing it as the approval ask.

The metadata header carries `approval_status`, `design_ref`, `ui_required` and
`owned_screens`. **It does not carry `mutation_round`; the mutation-budget
definition above is its sole definition.** Every owned screen is classified
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
2. **Build in the plan's sequence — and build a `Par` group together.**

   **Open `.specs/plans/<TICKET>.md` and read the `Par` column before writing any
   code.** Not from memory of having drafted it — the plan may be hours old, and a
   column you recall is not a column you read. Then **say the groups out loud
   before you start**: "group B is the endpoint and the screen, together." A group
   named aloud is one you notice serializing; a group left in the file is not.

   On a full-stack ticket this is the whole game. The frontend waits for the **API
   contract** — step 1's artifact — **never for the backend's implementation of
   it.** If you find yourself finishing the endpoint before opening a frontend
   file, the group was serialized: stop and say so. Waiting for a working endpoint
   before starting the screen is the single largest avoidable cost on a full-stack
   ticket, and it has happened on a real run that took six hours.

   Report which groups actually ran concurrently. **A group you serialized needs a
   stated reason written to the plan artifact** — an unrecorded serialization is
   indistinguishable from one that never happened, and it is a ✋ STOP.
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

**What must be true to leave**, each detailed in
[prove.md](references/prove.md): the security controls **exist** in the code,
traced through their whole static path including the parts this diff did not
touch, with any unmappable half *declared degraded* rather than assumed · they
**engage at runtime**, every applicable attack class against every in-scope route,
**applicability alone deciding which classes run** · the output is **committed
tests** in the repo's own runner, not a report · `test-quality` has run **once**
over the whole final test diff · the docs are true, **fixed now** · and for UI the
parity artifact is assembled with each screen classified, no grade produced, and
**nothing from BUILD reaching the reviewer**.

An `[NN]` finding is fixed, never cited away. Loosening or deleting the test is
not a fix. No local instance, or the only reachable one is shared → ✋ STOP.

## REVIEW

> "Three blind checks find problems once; one independent reviewer decides the
> repaired candidate once."

Load [references/review.md](references/review.md) and, for pass B,
[references/codex-cli.md](references/codex-cli.md).

Append the REVIEW-start entry to `timings[]` as this phase's first action, before
checking the terminal-reviewer route, sweeping the record or dispatching a pass.
It is the durable point of no return for this run. Once it exists, **every
REVIEW-phase stop concludes the run unshipped**, whether or not the terminal
reviewer returned a verdict. This replaces the old verdict-only resume condition.

First sweep the ticket-owned record once: the plan, parity and VAPT artifact
prefixes, changed comments and docblocks, ticket-produced docs, hand-maintained
counts and citations. Apply the mutation budget **before** running anything that
writes, formatters and generators included — they are writes, and a run already at
three must not spend a fourth while tidying up. Everything written before the
freeze is one batch. Then freeze the reviewed prefixes and compute `F0`. After `F0`, a record
mismatch ends the current run; it is never repaired inside REVIEW.

**Round 1 — find.** Dispatch A, B and C together, mutually blind and report-only,
over `F0`. Pass A is the fresh reviewer and performs the sole complete parity
comparison for every reference-backed owned screen. Pass B is Codex or its
declared fallback. Pass C walks every applicable rule row.

**Barrier 1 — reconcile and repair once.** A record finding ends the current run.
Give every code-or-test finding one disposition, capture preimages and apply at
most one batched repair. Build the fix packet while changing the files. For every
UI repair, include the dependency-closed nodes and properties it can affect.
If the repair changed code or tests, snapshot the candidate as `F1`; otherwise
the final candidate remains `F0` and no `F1` exists.

**Round 2 — terminal verdict.** One sighted reviewer independent of the builder
reads the round-1 findings, dispositions, frozen record, round-1 parity result and
runtime attack evidence, plus the fix packet and affected closure when barrier 1
changed the candidate. It does not rerun pass A, pass B, pass C or the attacks.

For parity, the reviewer consumes pass A's complete `F0` result. If barrier 1
changed UI, it compares only the affected nodes, selectors, tokens, states,
translations and their owned-screen consumers, in every applicable locale and
direction. If that impact cannot be bounded, parity is FAIL.

The terminal verdict is the signature. PASS proceeds to SHIP. Any finding,
uncertainty, overturned rejection, suspected regression, coverage failure,
record mismatch or non-PASS sub-outcome ends the current run unshipped. There is
no later candidate or frozen-narrative write; only predeclared run-state fields
through the precommit `SHIP_READY` cutoff may be appended.


## SHIP

> "Opening the PR and closing the ticket."

Load [references/ship.md](references/ship.md).

With the terminal verdict already appended, **write only the schema-defined
precommit SHIP fields and `SHIP_READY` session-log projection**, so facts that
already exist ride the commit. Recompute the terminal reviewer's
`reviewed_content_id`; verify the reviewed prefixes and prior append-only entries.
Any other code, test, comment, doc or artifact change ends the run as unreviewed.
Then make one commit and one push, open the PR, link the ticket and wait for the
enumerated CI gate.
**Transition the ticket only after the checks are green**, then tell the user the
PR is ready and ask them to run `/compact`. Commit, push, PR, CI, tracker and
completion facts are the external postcommit projection; never edit the committed
record or session log to add them.

## The terminal verdict is the signature

There is no separate signing phase. The terminal reviewer returns the one
canonical verdict shape defined in [review.md](references/review.md), including
the reviewer, manifest and reviewed-content identities, the frozen-record digest and status,
findings, every triggered sub-outcome and `overall_outcome`.

`parity_outcome` combines pass A's complete comparison bound to `F0` with the
terminal reviewer's targeted impact check bound to the final candidate.
`attack_review_outcome` judges the frozen runtime evidence; it never substitutes
for running the attacks in PROVE. `security_outcome` is mandatory when the plan
is security-sensitive.

The reviewer is report-only. The orchestrator appends that verdict once to the
plan's run-state block.
`overall_outcome: PASS` is the only result that proceeds. No second digest,
return dispatch, record repair or repeated attestation follows it.


## The run record

**One logical record, split at the commit.** The committed projection contains
only facts knowable before the commit; commit, push, PR, CI and tracker outcomes
form the postcommit projection reported to the user and tracker without another
repository write. **The full schema and cutoff are in
[ship.md](references/ship.md).**

**Two things must be done from the first phase, not reconstructed at the end:**

- **Capture phase timings as you go** — start and end per phase, agent time kept
  separate from human approval and external CI wait, and the overlap window of
  every intended parallel group. The committed projection ends at `SHIP_READY`;
  later wait/completion timing belongs to the external projection. Reconstructed
  timings cannot show whether things actually ran concurrently, which is the one
  thing they exist to prove.
- **Record verified coverage once** — round 1's reviewed paths and the terminal
  reviewer's affected closure, each bound to its manifest. A coverage mismatch
  ends the run; it does not trigger redispatch. Persist finding IDs and
  dispositions, and derive counts when rendering the report.
- **Declare the companion mode when you detect it**, not only at the end. A run
  that silently skipped a check is indistinguishable from one that failed it.


## Stop conditions

**STOP and tell the user.** Every condition below is unconditional. An unpinnable
reference is not an invitation to create one, and a terminal failure is not an
invitation to reopen review.

**What this list is not is a licence to stop elsewhere.** A difficulty not on it —
a finding you can fix, a test you can write — is work, and work does not stop the
run. **When you do stop, say what it means for the user and exactly what you need**,
so the answer is one message and not a negotiation.

*Getting started*
- You can't fetch the ticket, or can't tell which tracker it belongs to.
- **The tracker's completed state can't be resolved** for this work item type —
  don't guess a state name and don't close by approximation.
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
- A barrier-1 UI change has effects that cannot be bounded to nodes, properties
  and owned-screen consumers for terminal parity review.

*Security*
- No local instance to attack, or the only reachable environment is production or
  shared staging.
- An `[NN]` finding can't be fixed inside the ticket's scope, or the fix would
  require changing auth, tenancy or billing architecture — that is a decision.
- A security-sensitive run reaches terminal review without a reviewable runtime
  attack artifact or without an explicit terminal security outcome.

*Review — every item below concludes the current run, even before a verdict exists*
- A round-1 pass cannot return verifiable coverage after one schema-only
  correction request.
- The manifest changes while round 1 is running.
- A frozen record prefix changes after `F0`, or a reviewer finds it false.
- Barrier 1 requires a repository path outside the approved contract.
- `mutation_round` is already 3 and the record sweep or barrier 1 requires a write.
- The fix packet does not balance.
- An affected deterministic command is red after barrier 1's repair.
- A submodule is dirty at `F0` and is not manifested recursively.
- The independent terminal reviewer is unavailable.
- The terminal reviewer returns any finding, uncertainty, coverage failure,
  record mismatch or non-PASS outcome.

*Everywhere*
- A `Par` group was serialized with no stated reason, or the execution record is
  missing.
- You want to skip a finding and cannot name the rule ID, or claim a deviation and
  cannot name the human approver.
- SHIP recomputes a different `reviewed_content_id`, finds a changed frozen
  prefix/append-only entry, or needs a repository-byte fix.
- CI returns a deterministic red result rather than a host, network or explicitly
  rerunnable infrastructure failure.

An uncited skip is a fix you owe; a self-signed parity grade is not a verified
screen; an unpinned reference has nothing to verify against; an unfixed FAIL is
not a shipped ticket.

## Stopping and resuming

Most stops before REVIEW are pauses. Once the REVIEW-start timing entry exists,
every **REVIEW-phase** stop concludes the current run. A terminal PASS instead
transitions that run into SHIP. A host, network, PR-service, tracker-service or
explicitly rerunnable CI infrastructure failure pauses SHIP without reopening
REVIEW; resume only after recomputing the same `reviewed_content_id` and verifying
the frozen prefixes and append-only entries. A deterministic red check or any
required repository-byte change concludes the run and requires a new approved
execution. In every case leave the work recoverable:
**do not revert, reset, stash or delete the branch**, and **commit nothing to close
it out** — this skill never creates WIP commits. Report the branch, the phase that
stopped, what exists versus what is missing, which artifacts are on disk, and the
single concrete thing needed to continue. Say explicitly what is **not** done. A
stop that reads like a completion is worse than a loud failure.

| On disk | Means | Do |
|---|---|---|
| `.specs/plans/<TICKET>.md`, `approval_status: approved`, and no REVIEW-start entry in `timings[]` | the plan is settled and the run stopped before REVIEW | confirm it still stands, then resume after the pre-REVIEW phase that stopped. **Do not re-run plan mode**, and do not re-dispatch the critique — it is part of that plan |
| a REVIEW-start entry exists and `overall_outcome: PASS` does not | this run concluded unshipped, with or without a terminal verdict | ✋ STOP. Never re-enter REVIEW. Continuation needs renewed human approval and a new appended run partition |
| `overall_outcome: PASS` and no postcommit completion | REVIEW passed; SHIP is pending or paused | recompute `reviewed_content_id`, verify frozen prefixes and append-only entries, then continue only the missing idempotent SHIP operation; never rerun REVIEW |
| `.specs/plans/<TICKET>.md`, `pending` or absent | a previous run stopped *at* the approval ask | take it back through approval. Do not build on it |
| the run-state block holds `batches[]` | repair batches were already spent | keep every entry; count only those carrying the active `run_id` — **never truncate history to reset it** |
| a ticket branch | work exists | use it, rebased. WIP commits → ✋ STOP for the preserve-or-squash decision |
| the parity artifact | round-1 parity evidence exists | reuse it only when its `F0` manifest and immutable prefix still match. Otherwise start a new approved run; never rewrite historical locators to fit the current tree
| the vapt artifact | attacks ran | re-run its committed tests; only re-attack surfaces the resumed work changed |
| `design_ref` | the reference is pinned | **reuse that SHA.** Re-pinning silently changes what the screen is verified against |

**Re-check triage anyway** — blockers, assignees and open PRs all move.

## Scope

- One ticket, one branch, one PR. Don't batch unrelated fixes in.
- Don't preempt other tickets or over-engineer. An unbuilt dependency stops the
  run rather than getting stubbed.
- Unrelated problems you notice go to the user as a note or a new ticket, not into
  this diff.
- Parity covers the screens this ticket owns. A shared-component change creates
  one separate ticket enumerating the affected consumers as that ticket's owned
  screens. The current run does not execute that sweep, and the sweep ticket
  cannot create another sweep for the same component change.
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
orchestration around them: the contract, the `F0`/optional-`F1` manifests, the
discovery wave, the repair barrier, the terminal verdict and the mutation budget.

It does **not** choose or impose a stack — the stack is the repo's. It does not
provide the concurrency either: it requires it, and REVIEW stops on an
orchestrator that cannot fan out round 1. Concurrency changes the wall clock,
never a verdict — which is exactly why paying three times over for the same
verdict is not a trade this skill offers. It does not merge the PR or run `/compact` — both are the user's.

**Always follow the repository's own instruction file** — it outranks this file
on any conflict. **Read both `AGENTS.md` and `CLAUDE.md` if both exist**, and do
not assume either is present: repositories carry one, the other, both, or neither,
and reading only the name you expect silently ignores the instructions actually
written for you. Where both exist and disagree, the more specific statement wins;
where one is plainly a pointer to the other, follow the pointer. Neither present →
fall back to the repo's own code and config, per *Detecting the stack*.
