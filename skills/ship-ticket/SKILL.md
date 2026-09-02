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
  a **three-pass blind review wave** that is **cross-model** — a fresh Claude
  reviewer, the OpenAI Codex CLI (`codex review`), and a rule pass, each blind to
  the others over one frozen manifest, run concurrently where the orchestrator
  supports it and serially where it does not; the plan also goes to Codex
  read-only (`codex-delegate`) except in the FAST run lane — and full close-out
  (PR + ticket Done + session log + compact). Run lanes size the orchestration,
  never the gates. Companion gates (code-quality family,
  test-quality, vapt, docs-accuracy, Codex, CodeRabbit) degrade loudly when not
  installed — declared, never silently skipped. Takes one argument: the ticket
  key, work item ID, or URL.

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

## Speak plainly — the codes are for the audit trail, not the reader

The user is following their own ticket, not reading this file. **Lead with a
plain sentence; put the code in brackets afterwards** for traceability. Never the
other way round, and never the code alone.

```
✅  Security check on the new endpoint: passed [BE-SEC-03]
❌  BE-SEC-03 | PASS
❌  BE-SEC-03 — backend security rule | PASS
```

**Test for whether a name is plain: could someone who has never opened this file
act on it?** If the name needs its own glossary — "LLM failure modes",
"universal principles", "verification pass" — it is not a name, it is another
code. Say what actually happened instead.

| You are about to write | Say this instead |
|---|---|
| GATE 3 | **Checking the code against the project's rules** |
| GATE 4 | **Checking the screen matches the design** |
| GATE 5 | **Trying to break the new code on purpose** |
| Pass A | **A second reviewer who didn't write the code** |
| Pass B | **A different AI reviewing it independently** |
| Pass C | **Going through the rule checklist one by one** |
| Recon wave | **Reading the code to work out what to build** |
| Review wave | **Three reviewers checking the change at once** |
| `AI-FM` | **Common AI coding mistakes** (fake success, swallowed errors, dead code) |
| `UNIVERSAL` | **General code health** — is it simple, not repetitive, not over-built |
| `TEST-*` | **Whether the tests actually test anything** |
| `DOC-*` | **Whether the docs still tell the truth** |
| `VAPT-*` | **Attack tests** — proving a stranger can't get in |
| `NG-*` / `BE-*` | **The Angular rules** / **the backend rules** |
| `[NN]` | **Must fix** — a security or correctness rule, no exceptions |
| `[ARCH]` | **Structural rule** — changeable, but project-wide only |
| `[D]` | **A convention** — follow it unless the repo already does otherwise |
| FAST / STANDARD / HEAVY | **How much checking this ticket gets** (small / normal / thorough) |

**There is no GATE 1 or GATE 2.** The numbering is historical and means nothing —
another reason to lead with what the thing does.

**When something stops or fails, say what it means for the user**, not which
gate fired:

```
✅  Stopped: I can't run the app locally, so I can't test whether the new
    endpoint is actually protected. I need a way to run it. [GATE 5]
❌  STOP: GATE 5 has no local instance.
```

**Rule IDs stay in findings and skip citations** — the ID *is* the citation, and
the audit trail needs it — but always with a clause saying what the rule
requires, so the reader never has to look it up.

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
**Check availability once, before Step 6** — and declare the run's mode before
any code is written. A gate whose engine is missing **degrades loudly, never
silently**.

**Three kinds of companion, three different checks** — do not use the skill test
on an engine that is a binary, or either test on an orchestration capability:

- **A companion skill** is available if it appears in the available-skills list
  (or as a sibling folder in `~/.claude/skills` / `~/.agents/skills`).
- **A companion CLI** is available only if the binary answers: `codex --version`
  (Codex) and `gh --version` (GitHub PRs) actually succeed.
- **An orchestration capability** is a property of the agent you are running as,
  not of anything installed: can you dispatch concurrent read-only subagents, and
  can you run a schema-validated resumable workflow? Neither list can tell you —
  determine it from your own tooling and declare the resulting mode. A skill that wraps a
  CLI needs **both** — `codex-delegate` present *and* `codex --version` green.
  An installed-but-unauthenticated CLI fails at dispatch rather than at the
  check; when that happens, treat it as the same degradation and declare it then
  (the fix is `codex login`, which is the user's action, not yours).

| Companion | Owns | If missing — degraded fallback |
|---|---|---|
| `angular-code-quality` / `backend-code-quality` (whichever the detected stack routes to — see *Stack*) | Design Contract (STEP 0B) + the specialist rule rows of GATE 3 (pass C, step 13a) and the pre-VAPT security rows (step 10) — `NG-*` / `BE-*` | **First fall back to the `code-quality` hub** if it is installed — it covers any language and still yields a rule-backed pass. Only if *no* family member is present do those rows run **degraded**: no rule-ID table exists, so instead review every written file against SOLID, the Step 5 mechanical rules, and this file's conventions, reporting findings in `file:line` + quoted code + fix shape. The Design Contract degrades to a plain file-list contract derived from the approved plan. **The skip-by-citation protocol collapses to "fix everything"** — with no rule IDs loaded there is nothing to cite, so no review finding may be skipped. **The table still has rows:** emit a single `RULES | DEGRADED | no rule inventory available — reviewed against SOLID, the Step 5 mechanical rules, and this file's conventions` sentinel row rather than an empty table, so "no rows" can never be mistaken for "nothing applied". |
| `code-quality` (hub) | The whole-diff `UNIVERSAL` row in GATE 3 (step 13a) — `universal-principles` + the project constitution — **and**, for any stack with no specialist, the `AI-FM` row and the rule vocabulary too (it is the router as well as the hub) | Walk the universal layer yourself over the entire diff: Clean Code, the SOLID smell table, command/query separation, DRY-as-knowledge + the Rule of Three, the complexity/nesting ceilings + KISS, and the ranked YAGNI list — plus the project's own `.code-quality.md` Always/Never lists if one exists. Note the row ran unassisted. When a specialist **is** installed it owns `AI-FM`; when neither hub nor specialist is present, **both** rows run from this file's descriptions and are marked `DEGRADED` by name — they are never dropped. |
| `vapt` | GATE 5 — adversarial abuse tests against every trust boundary the diff introduces (step 12) | **The gate does not disappear with the skill.** Run the reduced form yourself against a local instance, using **GATE 5's per-family minimum table** (step 12) rather than a fixed set — an API minimum asserted over a config-only surface proves nothing. That table is reproduced inline in step 12 precisely so it survives `vapt`'s absence. Commit those tests in the repo's own runner and record **PASS-DEGRADED**. For the *unexercised* rules you cannot enumerate by ID without the skill, name the **families** that went untested (mass assignment, injection, XSS, CORS, cookie flags, headers) and state that the full ID list was unavailable — an honest family-level declaration, never a silent omission or an invented ID. |
| `test-quality` | The single TEST-\* guard over the whole final test diff — ordinary + abuse tests together (step 12.4) — reused as GATE 3's `TEST` row | Skip the companion's **execution**, never the **row**: still reject obvious implementation-detail assertions and unjustified mocks on your own judgment, and emit `TEST \| DEGRADED \| test-quality unavailable; reduced manual check: <what you actually checked>`. A missing engine changes the evidence, not whether the row exists. |
| `docs-accuracy` | DOC-\* rule set (step 12.5, before the freeze) | The pre-freeze grep for renamed/changed documented behavior is described inline and **still runs** — only the wider DOC rule set is skipped. |
| `codex-delegate` **+** the `codex` CLI | **Step 6 plan review** — the drafted plan goes to Codex read-only for an independent critique *before* it reaches the user's approval | Present the plan for approval **without** the cross-model pass, and say so in the approval ask ("no Codex plan review — skill or CLI unavailable"). **A plan review that timed out counts as unavailable once step 6.4's session-resume recovery is exhausted** — that means the recovery came back empty, OR there was no `threadId` to resume, OR the resume was rejected / exited non-zero, OR the bounded recovery itself timed out. Any of those four is a valid route to the degradation; a watchdog expiry *alone*, with a resumable session, is not — it is a recoverable event, not a missing companion. Do not confuse this with the FAST lane's `Not run — FAST lane`: one is a degradation, the other a recorded decision. The gate itself is unaffected either way: the user's approval was always the gate and Codex was only ever a contributor. |
| the `codex` CLI (`codex review`) | **Pass B** — Codex reviews the **local** diff concurrently with passes A and C (step 13c), before the PR exists | **Fall back to `/coderabbit:code-review`** if it is installed — same slot, same manifest, same skip-by-citation rules, different engine; step 16 names which engine actually ran. Only if **neither** exists does pass B disappear, leaving one free-form reviewer plus rule pass C — stated explicitly in step 16. A pass B that exceeds its declared time ceiling degrades the same way. |
| `/code-review` (Claude Code's built-in review — formerly `/review`) | **Pass A** — the fresh no-build-context reviewer (step 13b) + the default route to the GATE 4 independent signature | Run the review as a **fresh reviewer subagent with no build context**, or as a read-only `codex-delegate` dispatch — GATE 4's independence requirement is about *who* reviews, not the command name, so either fallback still produces a valid signature. If **no** fresh-reviewer route exists at all: a **UI** ticket ✋ STOPs (GATE 4 cannot self-sign), and a **non-UI** ticket continues with pass A run by the building agent — declared explicitly as `pass A ran WITHOUT reviewer independence`, which is a named loss, not a silent one. |
| the orchestrator's **concurrency capability** (workflow runner / fresh subagents) | Orchestration **only**, for **both** waves: the **recon wave** (steps 4–6, read-only investigations) and the **step-13 review wave** over one frozen manifest — schema-validated and resumable where a workflow runner exists. It owns no quality rule and no gate verdict. | If a workflow runner is absent but plain subagent fan-out exists, launch the same read-only passes concurrently without schemas or resume. If only serial execution exists, run the same investigations and the same passes, in the same scope, one after another — declare `orchestration degraded: serial`, **naming which wave** (they can differ: a run may fan out its review and serialize its recon). **No pass and no gate is skipped in any mode.** If no fresh-reviewer route exists at all for a UI ticket, ✋ **STOP** — GATE 4 never degrades to self-signing. |
| an **independent reviewer route** for the strict GATE 5 signature (fresh subagent, `/code-review`, or read-only `codex-delegate`) | Signing the strict-mode GATE 5 payload in step 15c | There is no fallback: `security-sensitive: true` mandates strict mode, and strict mode is defined by having an independent signer. If **no** route exists, ✋ **STOP** — a strict run that quietly signs itself, or quietly drops to light, is the exact self-attestation this gate removes. |
| `/session-logger` | Step 18 close-out log (written before the single push) | Write the session-log entry yourself to `session-log.md` with the same required content. |

What **never** degrades, because it doesn't depend on an installed skill:

- **Steps 3 / 4 / 5** — reading the ticket, triaging it, and pinning the design
  reference.
- **Steps 7 / 8** — branching and implementing; git and the approved plan, not a
  companion skill.
- **The run lane** — it is computed from the repo, so it is always available; and
  it never removes a gate whose trigger fired.
- **The review freeze and the reconciliation barrier** — the manifest is `git`
  plus hashing. Concurrency can be absent; the freeze cannot.
- **Step 6 plan-mode gate** — plan approval is a user action, not a skill. The
  Codex plan review *contributes to* the plan the user approves; it never
  approves, and its absence degrades the review, never the gate.
- **GATE 4** (UI tickets) — the pin, the committed artifact, the independent
  signature, and the human-approved deviation record are all workflow-native.
- **GATE 5's existence** — the `vapt` skill owns the rule set, but "a change that
  crosses a trust boundary gets attacked at runtime before it ships" is a
  workflow rule. Without the skill the gate runs reduced (see the table), never
  zero.
- **Stop-on-failure** — a missing companion is a *degradation to declare*, not
  a stop; a degradation you did **not** declare is itself a stop-on-failure
  violation. **Two exceptions, both about signers:** losing every independent
  reviewer route is a STOP for a UI ticket (GATE 4 cannot self-sign) and for a
  strict GATE 5 run (strict mode is *defined* by that signature). Those two do not
  degrade — they stop.

**Declare the mode in three places:** once up front when detected ("running
degraded: `backend-code-quality` not installed; `codex` CLI unavailable — pass B
falls back to CodeRabbit and the plan gets no cross-model review; orchestration
serial"), in the step-16 report, and in the step-18 session log. The declaration
covers which companions are missing and the **intended orchestration mode of
each wave** (recon and review — they can differ) up front,
together with the **tentative** lane (the only one that exists that early — the
provisional lane is declared at the end of Step 6, before the 6.4 decision); the **effective** lane does not exist
until the freeze computes it, so it is declared in the step-16 report and the
session log, never in the up-front line. A lane-based omission (the FAST lane's skipped
Codex plan review) is a **recorded decision**, not a degradation — label the two
differently so a missing engine never hides behind a lane. A run that silently
skipped a gate is indistinguishable from a run that failed it.

## Concurrent recon — how every read-only investigation runs

Steps 3–6 are dominated by **reading**: the ticket and its links, the design
system, the existing implementation, the contracts the plan will depend on, the
precedents this repo already sets. Almost none of those reads depend on each
other, and doing them one at a time — read, think, read, think — is the same
serialization mistake the review wave had, in the phase that runs *before* any
code exists. A ticket can spend an hour here without a line being written.

**The rule: if two investigations do not need each other's answer, they run
together.** Everything below applies to steps 4, 5 and 6.

**Recon runs in waves, because the questions are not all known up front.**
Discovering that a component already exists *creates* the next question. So:

1. **Enumerate the questions the plan must answer**, then dispatch the
   independent ones concurrently as read-only investigations.
2. **Synthesize the answers yourself**, and let what they reveal raise the next
   wave's questions.
3. **Stop when a wave raises no new question that would change the plan.**

**The stopping rule — this is what keeps recon from becoming research.** Stated
naively ("know every file and every contract") it is circular, since the build
sequence is what recon informs, and "every contract" invites unbounded transitive
traversal. Bound it:

- **Closure = the candidate touched-file set, plus for each of those files its
  *direct* consumed and exposed interfaces, plus the known callers those
  interfaces affect.** One hop, not the transitive graph. A dependency of a
  dependency is out of scope unless the plan actually calls it.
- **Cap the waves** — three is plenty. Each wave must either resolve a
  plan-changing question or end the recon.
- **At the cap, unresolved questions stop being recon and become output:** each
  one is a row in the plan's *Risks & unknowns* table with what you would do about
  it, or — if it genuinely blocks the plan — a ✋ STOP for a user decision. It
  never becomes another wave.

**Defer the *detail* of test knowledge, never the *paths*.** Recon must still
establish the repo's real lint/build/test commands and the **exact test and
fixture files the plan will create or touch** — those go in the build sequence,
which is where the Design Contract comes from, and a test file outside the
contract forces a step-8 divergence or quietly pressures you to skip the test.
What defers to steps 9 and 12 is the *internal* detail: how an assertion is
spelled, how a fixture is constructed, the abuse-suite's conventions. Note the
*existence* of a constraint you trip over; don't go read it out.

**What the investigators are, and are not:**

- **Read-only, and *enforced* — not merely instructed.** Telling a subagent not
  to write is a prompt, and plan mode's guarantee is supposed to be mechanical.
  Dispatch investigators through a carrier that **restricts their tools** to reads
  (a read-only sandbox, or a subagent type without edit tools). If your carrier
  cannot enforce that, run the investigations **through the plan-mode agent
  itself** rather than trusting a prompt. Either way, **snapshot `HEAD` and the
  worktree state around each wave and abort if anything mutated** — that check is
  what makes the guarantee real rather than assumed.
- **They answer questions; they do not make the plan.** Each returns findings as
  data — paths, signatures, quoted lines, a direct answer. Synthesis is yours.
  A subagent that hands back a plan has skipped the step where you reconcile its
  answer against every other answer.
- **They get exploration-tier models** (see *Model / cost routing*) — this is
  gathering, not architecture.
- **Fan-out is proportional to the ticket.** Two questions do not need six
  agents. Keep the width to the number of genuinely independent questions.
- **Use the strongest carrier available**, in this order — the same three
  *Orchestration modes* the review wave uses:
  1. **workflow** — a schema-validated, resumable run. Preferred whenever the
     orchestrator has one, and **this skill's instructions are the authorization
     to use it**: a recon wave is exactly the deterministic fan-out it exists for.
     Schema-validating the findings is worth real money here, because a recon
     answer that comes back as prose instead of `path` + `signature` + `quoted
     line` has to be re-asked.
  2. **fan-out** — plain concurrent read-only subagents. Same questions, no schema
     or resume.
  3. **serial** — the same investigations one at a time. Same scope, worse wall
     clock; declare it.
  Whichever ran, name it in the step-16 report and the session log alongside the
  review wave's mode — the two can differ, and a run that fanned out its review
  but serialized an hour of recon should not read as fully concurrent.

**Questions that are almost always independent, and therefore a good first wave:**

| Investigation | Answers |
|---|---|
| **Does this already exist?** | a component/service/endpoint the ticket is about to duplicate — the single most expensive thing to learn late |
| **What contracts does it depend on?** | the API shapes, service methods, types and permissions the plan will call |
| **What precedent does the repo set?** | how this codebase already does this kind of thing, so the plan matches it |
| **What consumes the surface being changed?** | who breaks, and which tests cover it |
| **What does the design say?** (UI tickets) | Step 5's reads — token file, conventions doc, screen, shared components |

## Step 3 — read the ticket first (hard gate)

Fetch and read the ticket's **full spec** before planning, before reading the
design system, and before any implementation, using the fetch column of the
tracker-resolution table. (Step 2's availability check needs nothing from the
ticket, so it may run alongside this fetch rather than ahead of it.) For ADO, that includes the
description, acceptance criteria field(s), comments, and linked parents/
attachments — the spec is often split across them. If you cannot fetch it
(auth/IP error, wrong instance/org, missing permission), **STOP and tell
the user** — do not guess the spec, do not proceed.

## Step 4 — triage the ticket before you plan (hard gate)

You have the spec; now check the ticket is **actually startable**. Each of these
is cheap here and expensive later — a blocked ticket discovered after planning
has already burned the plan, and a ticket someone else is mid-way through is a
merge conflict you chose.

**Run these lookups concurrently** (see *Concurrent recon*) — every blocker's
state, the assignee, the ticket state, the branch/PR search, and the plan-artifact
check are independent of one another. Several blockers means several fetches at
once, not a queue. They are pure reads; the only thing that depends on them is
your decision after they all return.

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
4. **Resume, don't restart.** If `.specs/plans/<TICKET>.md` already exists,
   read the literal `approval_status:` line. **`approved`** → a previous run got
   at least as far as plan approval. **`pending`** (or the key is absent) → a
   previous run stopped *at* the approval ask: take it back through approval, do
   not build on it. Only the human approval flips that field, and flipping it is
   the *only* thing that approval writes. **Read it and offer to
   resume** from where it stopped rather than re-planning from scratch — see
   *Stopping and resuming*. Re-asking for approval of a plan the user already
   approved is waste, and re-planning risks a *different* plan than the one the
   half-finished code on disk was built against.
5. **Form the `tentative_lane`** (see *Run lanes*) from the ticket and the scope
   you expect. It is **tentative on purpose and binds nothing** — it only shapes
   how much plan the ticket warrants. The `provisional_lane` is finalized from the
   completed plan at the end of Step 6, and the `actual_lane` at the review freeze.
   Record the tentative value in the plan's *Size* line.
6. **A STOP here cancels concurrent work.** Steps 4 and 5 may run alongside each
   other; if triage stops the ticket, stop the design read too rather than letting
   it finish into a run that will not happen.
7. **Right-sized?** If the spec clearly spans multiple independently shippable
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

In **every** case there are three things you must open — and they take **two
waves**, because the first three tell you what the fourth is:

1. **The token / theme file** (e.g. `tokens.css`, `theme.*`, design-tokens).
   This is the single source of color, spacing, type, radius, and elevation.
   It is almost always the *most* important file and the one most often skipped.
2. **The conventions / Master-Orientation doc** if one exists (shared brand
   rules, RTL/bilingual rules, numeric-isolation rules, component inventory).
3. **The specific referenced screen** — its composition and imports.

**Wave 1 is items 1–3 concurrently** (they genuinely do not need each other).
**Then synthesize a component inventory** — the conventions doc names required
shared components, and the screen's imports name the rest — and **wave 2 opens
the union of those shared components concurrently** (table, form, drawer,
pagination, banner, field-renderer, …). Opening the components in wave 1 would
mean guessing which ones matter; that guess is the dependency this staging
exists to respect.

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
  Write it in **two** places: the session log (step 18) and the `design_ref:` line
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

## Step 5.5 — detect the stack (before planning)

Detect the stack now, **before** drafting the plan — the plan's file paths come
from the repo's real layout, and the step-6.4 Codex brief has to state the
detected stack and the repo's real lint/build/test commands. Detection is
read-only, so it may run as early as Step 4 alongside triage. The routing table
lives in *Stack — detected, never prescribed*; **Step 6.5 confirms that routing,
invokes the specialist, and emits the contract.** Detection here, invocation
there.

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
2. **Run the recon wave first** (see *Concurrent recon*) — dispatch the
   independent investigations the plan needs concurrently, synthesize what comes
   back, and let it raise the next wave if it must. **This is where a slow run
   loses its hour**: read-then-think-then-read over a couple of dozen questions is
   an afternoon, and the same questions asked at once are minutes. Stop at the
   stopping rule — you can name every file the build sequence touches and every
   contract it depends on — not when curiosity is satisfied.
3. Draft the plan **using exactly the template below** — same headings, same
   order, so every plan reads the same way.
4. **Send the draft to Codex for an independent critique — read-only, before
   the user ever sees it** (see *Cross-model plan review* below). Reconcile its
   findings into the draft. Two things skip it, and they are recorded
   differently: the companion check said Codex is **unavailable** (a
   degradation), or the run is in the **FAST lane** (a recorded decision). Say
   which in the approval ask.
5. **Present the reconciled plan through plan mode's approval flow**
   (`ExitPlanMode`). The user approves, edits, or rejects in the native UI.
   **Implementation starts only on approval** — an edited plan is the new plan;
   a rejection sends you back to item 3 above (redraft), not into the code.
6. **Immediately after approval, save the approved plan to
   `.specs/plans/<TICKET>.md`** — the plan **body** verbatim, beneath a single YAML
   front-matter header carrying `approval_status`, `design_ref`, `ui_required`, and
   `owned_screens`. The header is metadata *about* the plan, so adding it is not an
   edit *to* the approved text; Step 6.5 fills in and validates the GATE 4 fields
   rather than rewriting the body (committed with the PR, like the GATE 4
   artifact) — including its section 7 Codex-review disposition. Plan mode
   itself persists nothing — this file is the durable record that the Design
   Contract derives from, the session log references, and the PR carries.

**Fallback — plan mode unavailable** (headless / workflow / subagent runs):
still run the Codex review — unless the finalized provisional lane is FAST, or
Codex is unavailable — since it needs no plan mode, being a shell dispatch;
then write the plan artifact **with `approval_status: pending`** and **STOP**,
surfacing sections 1–3 and 7 as the approval ask. **The status field is
load-bearing:** resume treats an approved plan as settled, so a pending artifact
that looked approved would let a later run build on a plan no human ever saw.
Only `approval_status: approved` permits resuming past Step 6. Proceeding without an approval is a Stop-on-failure violation, not
a judgment call — a plan approved only by its author is not approved, and a plan
approved only by its author *and Codex* is still not approved.

### The plan template

```markdown
# Plan — <TICKET>: <ticket title>

<!-- the YAML front-matter header above this body carries:
     approval_status: pending|approved   (a human approval flips this, and only this)
     design_ref: <SHA>                   (Step 5's pin)
     ui_required: <bool>                 (Step 6.5)
     owned_screens: [<paths>]            (Step 6.5) -->
**Size:** <N> files · <FE / BE / full-stack> · security-sensitive: <yes/no>
**Provisional lane:** <FAST / STANDARD / HEAVY> — <the numbers it came from>
<security-sensitive: yes forces HEAVY. The binding lane is recomputed from the
actual diff at the review freeze and may only escalate.>

## 1. What & why (read this first)
<2–4 plain sentences: what the user gets when this ticket is done, and the
chosen approach in one line. No jargon — write it for the person approving,
not for the builder.>

## 2. Build sequence
| # | Step (plain words) | Files touched | Depends on | Par |
|---|---|---|---|---|
| 1 | Add the state/data layer for X | <real path, in THIS repo's layout> | — | A |
| 2 | Add the Y lookup service | <real path> | — | A |
| 3 | Build the X list screen | <real path(s), incl. template/style files> | 1 | B |

**`Par` is the parallel group** — steps sharing a letter have no dependency on
each other and **touch no file in common**, so they can be built concurrently.
Steps with no peer just get their own letter. Two rules make the column honest:
a step may only share a group with steps it does **not** list in *Depends on*,
and **two steps that touch the same file are never in the same group** — that is
a write conflict, not parallelism. If everything is sequential, say so; a column
of A B C D is a real answer.


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

## 7. Codex plan review (cross-model second opinion)
**Ran:** <yes — codex <version>, session <threadId>> / <no — `Not run — FAST
lane; deterministic path/command/dependency/duplicate checks passed`> / <no —
`codex` CLI unavailable>

| Finding (severity) | Disposition | Reason / what changed |
|---|---|---|
| <blocker: step 2 imports X, which step 4 creates> | incorporated | resequenced — X now lands in step 1 |
| <minor: extract a shared helper> | rejected | one call site today; YAGNI until there's a second |

<or, when it didn't run: "Not run — `codex` CLI unavailable. This plan carries
no cross-model review.">

## 8. Gate fan-out (filled in at plan time, executed at gate time)
State what will run concurrently later, so it is a decision made once here rather
than improvised under time pressure at step 11:

| Stage | Fans out by | Count for this ticket |
|---|---|---|
| GATE 4 parity draft | owned screen | <N screens → N investigators, or "n/a — no UI"> |
| GATE 5 inventory + abuse design | trust boundary | <N surfaces, or "n/a — no trust boundary"> |
| GATE 3 rule pass (pass C) | rule family | <the families the diff puts in force> |

GATE 5's **live attacks stay serial** regardless — shared port and datastore.
```

Formatting rules that keep it readable:

- **Section 1 is the approval surface.** A reader should be able to approve from
  sections 1–3 — plus any *rejected blocker* row in section 7 — in under a
  minute. Everything else is for the builder.
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

### Cross-model plan review (step 6.4)

A plan reviewed by the model that wrote it inherits that model's blind spots,
and the expensive failures — a sequence that can't build in that order, a path
that doesn't exist in this repo, a module that already does the thing — are all
cheap to catch here and expensive to catch at step 8. So the draft goes to a
**different model, in a different process, with the repo in front of it**.

**Run the deterministic checks first — they are free and they answer the
cheapest questions Codex is currently asked.** Before any dispatch, verify
mechanically: every path the plan names exists or is explicitly new; every
command it cites exists in the repo's own config; the build sequence is acyclic
and each step's dependencies land before it; and a repo search finds no existing
implementation of what the plan is about to build. Findings here go straight into
the draft. In the **FAST lane** these checks are the whole of section 7 — record
`Not run — FAST lane` with their results and move to approval.

**Dispatch only a semantically complete plan.** Codex receives the drafted plan
*verbatim* and the user approves the *reconciled* plan, so sending an unfinished
draft to start the clock earlier reviews the wrong object — a false latency win,
not a real one. Sections 1–6 are finished before dispatch. While it runs, prepare
only derivative, read-only material (the rule-surface matrix, the approval
summary, the command inventory, the degradation report); do not implement, do not
finalize the contract, and do not change the semantic plan underneath it.

Invoke the **`codex-delegate` skill by name** (it supplies its own relay path —
never hardcode one; it is not a sibling of this skill in every install) and use
its read-only dispatch:

- **Read-only, always.** `--read-only` puts Codex in a sandbox that *cannot*
  write — which is what plan mode requires, enforced rather than trusted.
- **Nothing lands in the repo.** Pipe the brief in on stdin (heredoc) and leave
  the relay's `--out-dir` at its default temp dir, so plan mode's clean tree
  survives the round trip.
- **Set the reasoning effort explicitly — do not inherit the account default.**
  Same lever, same reason as pass B (step 13c): many accounts set
  `model_reasoning_effort = "xhigh"` globally, and a plan critique at xhigh across
  a large tree is how this dispatch blows its own watchdog. Pass
  `--effort medium` for STANDARD and `high` for HEAVY; reserve `xhigh` for a
  critique you have a specific reason to want deeper. (FAST does not reach this
  step at all — it records `Not run — FAST lane` — so it has no effort to set.)
- **Size the watchdog to the read, not to a fixed number.** `--timeout 15m` suits
  **one** repo of ordinary size. What actually drives the duration is the volume
  Codex must read and reason over — scoped files and bytes, the tool calls that
  takes, and the effort setting — so repository *count* is only a coarse proxy for
  it. Treat **+10m per additional repository as a conservative floor**, then raise
  it for a large tree or a higher effort. A watchdog shorter than the read
  guarantees a timeout and buys nothing.
- **Multi-repo tickets: `--cd` must be a git repository.** A container directory
  that merely *holds* two repos is not one, and Codex refuses in under a second.
  Root the dispatch **inside one repo** (the one the plan changes most) and give
  the other's **absolute path** in the brief, with a line telling Codex it may
  read there. Say which repo is the root so its findings' relative paths are
  unambiguous. **The read-only sandbox does not confine reads to the `--cd`
  subtree** — verified on `codex-cli 0.145.0`: a run rooted in one repo read a
  sibling repo by absolute path — so this works, and `--cd` is about giving git a
  valid repository, not about scoping what may be read.
- **A watchdog expiry is not a total loss — recover before you re-dispatch.**
  When the relay times out it writes `result.json` with no `finalMessage`, but the
  watchdog killed the live **process**, not the persisted **session** — so what
  Codex already read is still reachable. **Resume it** with a short delta brief
  asking for its findings **from what it has already read**, bounded and
  severity-ordered.

  Three conditions make that recovery safe rather than a second failure:
  - **A non-empty `threadId` must exist** in the timed-out `result.json`. No
    thread id, no recovery — go straight to the degradation.
  - **Reuse the original dispatch's `--cd`, `--read-only`, and explicit
    `--effort`.** A resume that re-derives them can repeat the not-a-git-repo
    failure, silently inherit a write-capable sandbox, or fall back to the
    account's global effort — which is what caused the timeout in the first place.
  - **Bound the recovery itself** with its own short `--timeout`. An unbounded
    "just finish up" resume is the same failure with a longer fuse.

  Re-dispatching from zero instead pays the whole read again and will likely hit
  the same ceiling. **If there is no `threadId`, the resume is rejected or exits
  non-zero, or the bounded recovery itself times out**, the review is unavailable
  — declare the degradation.
- **Read `finalMessage` from `result.json`** — that is Codex's report. Record
  `threadId`; it identifies the session for a follow-up question, it is what the
  timeout recovery above resumes, and it is the audit trail for a signature if
  this same route signs GATE 4 later.

**What the brief must carry** — Codex has no memory of this conversation and
sees only your text plus the working tree:

| Block | Contents |
|---|---|
| `<task>` | The ticket's spec + ACs, the **drafted plan verbatim**, the detected stack, the repo's **real** lint/build/test commands, and the **deterministic pre-check results as given** (paths present/absent, commands real, sequence acyclic, no duplicate implementation) with an instruction not to re-verify them. |
| `<grounding_rules>` | Every claim cites a path or a line from this repo; label anything inferred as an inference. Read the files the plan names before judging them. |
| `<structured_output_contract>` | Findings **severity-ordered, blockers first, minors truncatable**, capped: severity · the plan section it hits · evidence (`file:line`) · the concrete change proposed. Then one line: is this plan buildable as sequenced? |

**Ask it the questions only a repo-grounded second model can answer** — not "is
this a good plan?". **Two of the five are already answered before you dispatch**:
the deterministic pre-checks above cover path existence and duplicate
implementation mechanically, for free. Send their *results* and tell Codex not to
re-derive them — re-reading the tree to confirm what `test -e` already proved is
the single biggest avoidable cost here.

So the brief carries the pre-check results as **given**, and asks only the three
that need judgment:

1. Is the build sequence actually buildable in that order (does step *n* depend
   on something step *n+2* creates)?
2. What is missing from the plan that the ticket's ACs require?
3. What in section 3 (risks) is wrong, and what risk is absent?

**Bound the ask, exactly as pass B does.** An unbounded "tell me everything" over
a large tree at high effort is what turns this dispatch into the run's longest
block — and unlike pass B it sits directly in front of a human waiting to
approve. Demand findings **severity-ordered, blockers first**, say minors may be
truncated, and cap the total. A critique that spends its budget on nits has spent
it in the wrong place. (Same lever, measured on pass B: 384s to 177s.)

**Then reconcile — this is your judgment, not Codex's.** Every finding is
either **incorporated into the draft** or **rejected with a stated reason**, and
both outcomes get a row in the plan's section 7. Plan findings carry no rule IDs,
so *the stated reason is the citation* — the same standard as step 14's
reconciliation, in the
only form available here. A blocker-severity finding you reject needs a reason a
reader can check, not "considered and dismissed".

**Codex contributes; the user approves.** Never present Codex's agreement as
approval, never skip `ExitPlanMode` because the critique came back clean, and
never let a Codex objection alone kill a plan the ticket requires — surface the
disagreement in section 7 and let the user decide. If the critique changes the
approach materially, **redraft before presenting**: the user approves the
reconciled plan, not the draft plus a list of things you'd change.

**The plan constrains the contract.** The Design Contract (STEP 0B) emitted next
draws its file list from the approved plan's build sequence. A file needed by
the contract but absent from the plan means the plan was wrong — a **material**
divergence (new files, changed approach, new risk) goes back through plan mode
for re-approval and updates `.specs/plans/<TICKET>.md`; don't silently build
past the plan the user approved.

## Step 6.5 — emit the Design Contract (before the branch, before any code)

The plan is approved. The contract that governs **which files may be written**
must exist *now* — step 8 forbids writing outside it, and a rule you reach only
after writing is not a gate. Do these in order, before Step 7:

1. **Confirm the routing.** The stack was already detected before Step 6 (the
   plan-review brief needs it, and the plan's file paths depend on it) — confirm
   the routing table still selects the same code-quality family member now that the
   plan is final.
2. **Invoke that skill by name** — load it, don't recall it.
3. **Run its Design Contract gate (STEP 0B)**, deriving the file list from the
   approved plan's build sequence. If no family member is installed, the contract
   degrades to the plan's plain file list — the "no file outside the contract"
   rule still holds.
4. **Record the GATE 4 metadata where CI can find it** — the ticket/AC/contract
   half now, **recomputed at the freeze** once the diff exists (step 13 updates the
   header; the value is `contract-owns-a-screen OR diff-touches-the-view-layer`). GATE 4's CI check cannot
   re-derive a ticket/AC judgment from repository state, so pin an exact committed
   location and exact keys — a path CI must guess is a check that silently passes.
   **Update** the YAML front-matter header Step 6 already created at the top of
   `.specs/plans/<TICKET>.md` — fill in these fields, never prepend a second header:

   ```yaml
   ui_required: true            # bool — contract owns a screen OR diff touches the view layer
   owned_screens:               # list of repo-relative paths; [] iff ui_required is false
     - src/app/invoices/invoice-list.component.ts
   ```

   **Missing, unparseable, or internally inconsistent metadata fails closed** —
   CI treats it as `ui_required: true` with no artifact, which is a FAIL.

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
   ticket, use it — don't open a second one. **Inspect it for WIP commits BEFORE
   touching it:** if `<default-branch>..HEAD` is non-empty, those commits collide
   with the single-gated-commit rule, and a rebase would quietly rewrite them. ✋
   STOP and get the human's preserve-or-squash decision **first** (see *Stopping
   and resuming*), then rebase on the current default branch and say what you did.
   Rebasing before asking destroys the very history the question is about.
5. **Uncommitted changes in the working tree that aren't yours?** STOP and ask.
   Do not stash, revert, or build on top of someone else's in-flight work.

## Step 8 — implement, in the plan's sequence, inside the contract

Now build. This step is short to describe and is most of the actual work; the
constraints on it are what the previous seven steps were for.

- **Follow the approved plan's build sequence — in dependency order, but build a
  parallel group together.** The plan's `Par` column already did this analysis:
  steps sharing a letter have no dependency on each other and touch no file in
  common, so build them concurrently. Steps in different groups stay ordered;
  jumping a dependency is still how you write a screen against a service that
  doesn't exist yet. Building a four-step `A` group one at a time is throwing away
  work the plan already did.
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
- **Sharding is presentation, not partition.** When the wave fans GATE 3 out by
  rule family, every shard still aggregates into **one** Verification table and
  **one** contract. Two tables mean two half-reviews, and a rule that fell between
  them is invisible.
- **Always follow `CLAUDE.md`** — it outranks this file on any conflict.
- The ticket itself decides whether it's FE, BE, or both; each specialist routes
  from its cached profile.

**What stays constant across every stack** — these are the skill's actual
contract, and none of them depend on a framework: read the ticket (Step 3), pin
the design reference (Step 5), plan and get approval (Step 6), SOLID, the
rule-ID citation protocol, GATE 3, GATE 4, GATE 5, the three-pass blind review
wave (including its two cross-model free-form passes), and close-out.

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

**The code-quality-family skill is invoked at Step 6.5 — this section defines
*which* member, not *when*.** Based on the ticket (FE / BE / full-stack) **and the
detected stack**, Step 6.5 invokes the member the routing table above selects — `angular-code-quality`,
`backend-code-quality`, the `code-quality` hub, or a combination. The chosen
skill governs this build end to end:
its rules apply to every line, its **Design Contract (STEP 0B)** gates every
file, and its **Verification Pass — plus the whole-diff `AI-FM` and `UNIVERSAL`
rows and the conditional `TEST`/`DOC` rows — is GATE 3** below. Both specialists build on
the `code-quality` hub's universal core (`ai-failure-modes`,
`universal-principles`, `review-standard`) — so "invoke the specialist" invokes
that core too. This is not optional context when the skill is installed; a
build that skipped an *available* specialist has no Design Contract and cannot
produce GATE 3. **If the specialist is not installed** (per the companion
availability check), run the degraded fallback from the availability table —
declared up front, never assumed silently.

Then run its **Design Contract** gate (STEP 0B), deriving the file list from the
Step 6 plan's build sequence — **this is Step 6.5, before the branch and before
any code**. No file gets written that isn't in the contract.
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
- **STRONG (Opus)** — reasoning-heavy work: **planning and synthesis** (Step 6 —
  deciding what to build and how to sequence it), architecture/design decisions,
  **security-sensitive logic** (auth, tenancy, billing, payments), tricky
  algorithms, and resolving non-trivial review findings.

Match the model to the difficulty: exploration on small, routine build on
medium, planning/design/security on strong. Keep parallel subagents proportional
to the task — don't fan out more than the work needs.

**Model tiers are not run lanes.** SMALL/MEDIUM/STRONG above pick *which model
answers a question*. FAST/STANDARD/HEAVY (see *Run lanes*) pick *how much
orchestration the run gets*. They are independent: a FAST-lane ticket with one
genuinely hard decision still routes that decision to a strong model, and a HEAVY
lane still does its routine wiring on a medium one. Never let one stand in for the
other.

**The GATE 4 parity-reviewer is a separate agent from the builder** (see below) —
that independence is the whole point of it, so never let the building agent grade
its own parity. It signs only the snapshot and grade it actually reviewed: a
signature binds to that gate's **scope digest** (see *Signature binding*), and a
later fix inside that scope makes it stale rather than merely old.

**The Codex passes sit outside this tiering.** The plan review (step 6.4), the
`codex review` pass (pass B, step 13c), and an optional Codex parity signature
run in a separate process on a separate account — they cost nothing from the
budget above and gain nothing from routing a subagent at them. Two rules keep
them cheap: **one full-snapshot dispatch per decision point** — a plan review
(skipped in the FAST lane), a diff review — plus **one delta dispatch** only if the
accepted fixes changed reviewed content — and **read-only unless it is
implementing**, which in this workflow it never is. Ship-ticket delegates *judgment* to Codex, never
the build: the code in the PR is written here, against a plan the user approved.

## Security-sensitive note

**Read the flag off the ticket first, then judge for yourself.** If the ticket
carries an explicit security-sensitive marker (`generate-ticket` writes one in its
*Invariants & security* section; trackers often carry a label), honour it. Its
absence proves nothing — so also apply your own test: if the ticket touches auth,
multi-tenancy, billing, payments, secrets, or any cross-tenant isolation, it is
security-sensitive whether or not anyone labelled it. Record the determination in
the plan's `security-sensitive:` field either way — **that field is what sets
GATE 5 to strict and forces the HEAVY run lane**, so getting it wrong silently
downgrades both the security gate and the orchestration it gets.

When it is: do that reasoning on the strong model, and prefer a test-first repro
(write the failing test that proves the correct/secure behavior, then implement). Any DB migration must be additive
and committed to Git, using **this project's migration tool and naming
convention** (read the existing `migrations/` directory — Prisma, Drizzle,
Alembic, Flyway, Rails, Laravel, plain numbered SQL, …). Don't introduce a
second migration mechanism alongside the one already there.

## Run lanes, the review freeze, and the concurrent wave

Three mechanics are shared by everything from Step 4 onward. They are defined
once here so the steps below can just refer to them.

### Run lanes — computed, never judged

The same twenty steps applied to a two-file fix and a forty-file feature is how a
small ticket costs an afternoon. The lane sizes the *orchestration*; it never
decides whether a gate applies.

Let, computed from the repo — never estimated:

- **F** = changed non-generated files, **including untracked**, **excluding this
  workflow's own mandatory artifacts** (`.specs/plans/<TICKET>.md`,
  `.specs/design-parity/<TICKET>.md`, `.specs/vapt/<TICKET>.md`, `session-log.md`).
  Every run writes those, so counting them would put a two-file change at `F ≥ 3`
  and make the FAST lane unreachable by construction. Implementation, test, and
  documentation changes all still count.
- **L** = added + deleted non-generated lines, with the same artifact exclusion
- **S** = distinct Design Contract subsystems
- **security_sensitive** = the plan's `security-sensitive:` field
- **ui_required** = the ticket, its ACs, or the approved Design Contract **owns a
  screen** — OR the diff touches this repo's view layer. **Both halves matter:** a
  diff-only trigger would let a ticket that was supposed to build a screen, and
  didn't, skip the very gate whose `Not-built` grade exists to catch exactly that.
- **tb_touched** = the GATE 5 trust-boundary detector, unchanged

**FAST** — two predicates, because `L` cannot exist before the code does:
- *provisional* (end of Step 6): `F ≤ 2`, `S = 1`; `security_sensitive` false and
  `tb_touched` false; no schema/migration, dependency, CI/runtime-config, public
  contract, or cross-subsystem shared-component change; and **every file the plan's
  build sequence names is one the plan introduces or already owns** — a property
  computable from the plan alone. It deliberately does **not** reference the
  approved Design Contract: that is emitted at Step 6.5, *after* this decision, so
  depending on it would be circular. **`L` is not referenced either** — it is
  unmeasurable here, and treating an unmeasurable input as "uncomputable → HEAVY"
  would make the FAST lane unreachable by construction.
- *actual* (freeze): the same, **plus** `L ≤ 80`, now checked against the contract.

**STANDARD** iff not FAST and *all*: `F ≤ 12`, `S ≤ 2`, and (at the freeze)
`L ≤ 500`; `security_sensitive` false; no unresolved architecture/scope uncertainty.

**HEAVY** otherwise — and **mandatory** whenever `security_sensitive` is true,
when any threshold cannot be computed, or when the classification is uncertain.

> These names are deliberately **not** SMALL/MEDIUM/STRONG. Those are the *model*
> tiers in *Model / cost routing*, a different axis entirely: a FAST lane can
> still route a hard question to a strong model.

**Three moments, three names.** Different inputs, different jobs — keep them
distinct, because conflating them is how a lane decision gets made on data that
does not exist yet:

| Moment | When | Inputs | Binds |
|---|---|---|---|
| **`tentative_lane`** | Step 4 triage | the ticket alone | **nothing** — it only shapes how much plan the ticket warrants |
| **`provisional_lane`** | end of Step 6, **immediately before the 6.4 decision** | the *completed* plan's file list (`F`, `S`) | the plan-review decision, and nothing else |
| **`actual_lane`** | the review freeze | the real working tree (`F`, `S`, `L`) | everything downstream |

`S` counts distinct top-level modules of the repo's own layout; "generated" means
whatever the repo's own ignore/generated config says. **Any value a predicate
actually references and you cannot compute forces HEAVY.** (`L` before the freeze
is not such a value — no earlier predicate references it.)

**The plan review keys off the PROVISIONAL lane, and that decision is historical.**
A FAST provisional lane skips step 6.4; if the run later escalates to STANDARD or
HEAVY, that escalation **does not retroactively owe a pre-approval critique** — the
plan was already approved and the moment has passed. What it does owe is honesty:
the report and session log record `Not run — FAST at approval; escalated to
<lane> at freeze`. If you want the critique after an escalation, the plan changed
materially and goes back through plan mode, which is a re-plan, not a patch.

**The anti-gaming rule.** The freeze recomputation is what binds; print the raw
numbers.

```
effective_lane = max(provisional_lane, actual_lane)
```

The lane may **escalate automatically**; it may **never downgrade** after plan
approval without an explicit human decision recorded in the plan and the session
log. Unknown means HEAVY. Because F, L and the detectors are read off the tree
rather than asserted, you cannot argue your way into a cheaper lane — the diff
decides.

**What the lane changes — and what it never changes:**

| | FAST | STANDARD | HEAVY |
|---|---|---|---|
| Plan-mode approval | required | required | required |
| Codex **plan** review (6.4) | **not run** — recorded as a lane decision | required, `--effort medium` | required, `--effort high` |
| GATE 3 (all rows) | required | required | required |
| GATE 4 | **iff `ui_required`** | iff `ui_required` | iff `ui_required` |
| GATE 5 | **iff `tb_touched`** | iff `tb_touched`, light | iff `tb_touched`; strict when `security_sensitive` |
| Diff review passes A **and** B | both | both | both |
| Pass B reasoning effort | `medium` | `medium`/`high` | `high`/`xhigh` |
| Review-wave orchestration | serial is fine | concurrent | concurrent |
| Recon-wave orchestration | concurrent where independent | concurrent | concurrent |

**No lane suppresses pass B.** If pass B is absent it is because the *engine* was
unavailable or timed out — a declared degradation, reported as "one free-form
reviewer plus rule pass C", never a lane decision. **And passes A and B are never
partitioned:** each receives the whole manifest, because a free-form reviewer
split across files cannot see cross-file behavior. Only pass C's rule families and
GATE 4's owned screens may shard, and both re-aggregate into one table.

**A lane never turns off a gate whose trigger fired.** `ui_required` and
`tb_touched` are computed from the ticket and the diff, so GATE 4 and GATE 5 are
outside the lane's reach entirely. **Both diff-review engines run in every lane** — the
cross-model two-pass guarantee is not a lane-scoped luxury. The only thing FAST
actually drops is the Codex *plan* critique, and that is recorded as
`Not run — FAST lane` rather than omitted silently.

### The review freeze — a manifest, not a commit

**This skill creates no review-freeze commit** — the single gated commit is still
step 19. (A *resumed* run may carry pre-existing WIP commits on the branch; those
stay in scope and the manifest's committed layer covers them.) What
the concurrent passes need is not a commit but a **stable, shared description of
what they are reviewing**.

Compute the manifest **once** and hand the identical copy to every pass:

1. **Repository identity** — canonical path, branch, `HEAD` OID, target-base OID,
   merge-base OID.
2. **NUL-safe git state, across all four layers** — the committed delta
   `merge-base…HEAD` (a resumed run may carry WIP commits, and status cannot see
   them), plus porcelain-v2-equivalent status for index and worktree kept
   **separate**, plus all untracked files. A manifest built from status alone
   misses everything already committed on the branch.
3. **Per path** — exact path bytes; index status and worktree status; rename/copy
   origin and destination; explicit deletion tombstones; HEAD/index/worktree file
   type and mode; index blob OID plus an independent content digest; worktree
   content digest.
4. **Special types** — symlinks recorded **as** symlinks with the link-target
   bytes hashed, never dereferenced; permission bits recorded separately from
   content; and submodules either **rejected dirty at the freeze** or manifested
   **recursively** (their HEAD/index/worktree/untracked paths and digests). A bare
   dirty bit cannot tell one dirty submodule state from another, so it is not a
   freeze.
5. **Untracked files** — type, mode, path, content digest. `git diff` cannot
   represent them, and they are in scope.
6. **Ignored but load-bearing inputs** — only those the local app, tests, or
   review actually consume (local config, fixtures). Record **opaque digests**;
   never copy secret contents into the manifest.
7. **Review policy** — reviewed paths; excluded generated/vendor/lock artifacts
   **with reasons**; `design_ref`; owned screens; VAPT surfaces; the effective lane.
8. **Post-freeze allowlist** — the exact derived outputs that may be appended
   **once every pass has returned and been validated**, never during the wave:
   GATE 4 / GATE 5 signature blocks; the step-15 close-out fields (each accepted
   deviation's decision/approver/date, and each stub's follow-up ticket key); the
   step-16 report; session-log fields. **List them explicitly** — a close-out field
   the allowlist forgot makes step 19 reject every run that used it. Name
   the **fields**, not just the files — a path-level allowlist would permit
   arbitrary edits inside an allowed artifact, so record the permitted field names
   and the immutable-prefix digest of each artifact and verify them. **Any code,
   test, or docs mutation outside this allowlist voids the reports.**
9. **Manifest ID** — a digest over the manifest under **one deterministic
   serialization**: fields in a fixed order, paths as raw bytes sorted
   bytewise, NUL-delimited, with a named hash algorithm. The serialization is named
   **`ship-ticket-manifest-v1`** and the digest is **SHA-256** — pinned here rather
   than left to each repo, so two runs of this skill produce comparable IDs. Recompute before dispatch and after every pass; any mismatch discards
   the affected outputs.

**Computing the scope once is safer, not just cheaper.** A bare `git diff` hides
staged changes, and a pass that reviewed a narrower set than the change has
**gated nothing**. One manifest removes N independent chances to under-scope.

**A manifest is an integrity check, not an immutable snapshot.** It cannot detect
a mutate-and-restore inside the wave. Its safety therefore rests on the passes
being read-only and the orchestrator writing nothing during the wave. If you need
a genuine snapshot, materialize one that carries untracked, symlink, and
submodule state — **`git stash create` alone does not**, because it has no
include-untracked form here and untracked files are explicitly in scope.

### Report-only, one barrier, one fix batch

- **Every pass in the wave is report-only.** No pass edits code while its peers
  are reading; a fix invalidates every concurrent conclusion about the file it
  touched. Findings come back as data; the orchestrator decides and applies.
- **Independence forbids sharing findings — it does not forbid running at the
  same time.** No pass sees another's output, before or during.
- **One reconciliation barrier.** Collect every pass, verify each one's coverage
  **against the manifest** (not against a freshly derived file list), then apply
  **one batched fix set**.
- **Then revalidate the delta only.** Re-run passes A and B over the latest
  adjacent delta `F(n−1) → Fn` concurrently; re-run only the rule rows and tests
  the fixes touched; **re-derive** the unsigned GATE 4 verdict if an owned screen,
  its reference, or the artifact changed (nothing is signed until step 15c, so
  "re-sign" applies only to a resumed artifact that already carried a signature);
  re-attack only the GATE 5 surfaces the fix touched. Append-only derived output
  on the allowlist needs no re-review.

### Signature binding

A signature is an **assertion returned as data**, which is why a report-only
reviewer can still sign: the reviewer asserts, the orchestrator writes.

**Common bindings** (every signature carries these):

```
scope digest · reviewer identity + run/session ID · verdict ·
manifest ID (provenance only)
```

The **scope digest** — not the global manifest ID — is what validity binds to. It
digests only the paths **that gate actually depends on**. Binding to the global ID
would make an unrelated backend fix invalidate a UI signature, which trains
everyone to re-sign mechanically; binding to the gate's own scope means a
signature goes stale exactly when it should.

**GATE 4 payload:** `design_ref` · owned-screen list · per-screen grade · digest
of the screens' implementation + reference files.
**GATE 5 payload (strict mode only):** the surface inventory · the rule→test map ·
digest of the abuse tests and the production files they defend. Its signer is
**an independent reviewer with no build context**, obtained the same three ways
GATE 4's is (fresh subagent, `/code-review`, read-only `codex-delegate`) — strict
mode names a signer or it is not strict.

**Sign the FINAL payload, not an intermediate one.** Assemble everything the
payload digests — including step-15's human-approved deviations and stub mappings
— **before** signing. A signature written first and then appended to is a
signature over something that no longer exists. Close-out fields that CI validates
separately are excluded from the digest and named as excluded.

A signature whose scope digest is not the final one is **stale, not valid**. On
the normal path nothing is signed until step 15c, so an accepted fix inside that
gate's scope requires **verdict re-derivation**; "re-signing" applies only when
resuming an artifact that already carried a signature.

### Orchestration modes

The wave is an orchestration convenience, never a source of verdicts. Three modes,
declared like any other degradation:

> **Carrier modes are shared; result schemas are not.** The three modes below
> (workflow / fan-out / serial) apply to **both** waves. The schema each wave's
> agents return does **not**: recon returns `question` · `answer` · `paths` ·
> `signatures` · `quoted lines` · `confidence`, with no manifest and no verdict,
> because recon is answering questions about code that does not exist yet. The
> review-pass schema below is review-only — do not require `manifest_id` or a gate
> verdict from a recon investigator.

- **workflow** — a schema-validated, resumable, blind concurrent run, and the
  preferred carrier whenever the orchestrator has one; **this skill's instructions
  authorize it** for both waves. Every **review** pass returns the same shape,
  whatever the mode: `manifest_id` · `reviewed_paths` ·
  `excluded_paths` (each with a reason) · `findings` (severity, `file:line`,
  quoted line, fix) · **`gate_verdicts[]`** — a list, because one run can owe both a
  GATE 4 and a strict GATE 5 verdict, each carrying `gate`, `scope_digest`, the
  verdict, and the reviewer's identity. **The wave returns verdicts, not
  signatures** — signing is step 15c, and its result carries `gate`,
  `scope_digest`, `payload_digest`, signer identity and run ID · `verdict` · reviewer/run ID ·
  `error`. Malformed output is re-requested or the pass is re-run — never
  silently accepted, because a pass that returned nothing readable has gated
  nothing.
- **fan-out** — plain concurrent read-only subagents; same passes, no schema/resume.
- **serial** — the same passes, in the same scope, one after another against the
  unchanged manifest.

Fan-out shape, when concurrency exists: shard **GATE 3 by rule family**, **GATE 4
by owned screen**, and GATE 5's **inventory and test design** by surface — but
**never** its live attacks (see GATE 5). Every shard aggregates into **one**
Verification table and **one** contract. Keep fan-out proportional to the work.

## Steps 9–20 — verify, gate, review, close out

The ordering below is deliberate: all ordinary implementation and gate-authored
content finishes first, then the tree is frozen at **`F0`**, then the three blind
diff-analysis passes A/B/C run at once. Two reads sit outside that wave by design
— step 12d's unsigned GATE 5 review precedes the freeze, and step 15c's signing
follows the barrier — and writes after `F0` are not forbidden forever, they are
barrier-controlled: batched fixes happen only once every pass has returned, and
each is delta-validated and promoted to a new accepted manifest. See *Run lanes,
the review freeze, and the concurrent wave* above for the shared mechanics.

9. **Run the repo's own lint, build, and test commands** — read them from the
   `package.json` scripts block, Makefile, `composer.json`, `pyproject.toml`,
   `go.mod` tooling, or the CI config; never assume a runner (Vitest, Jest,
   pytest, PHPUnit, `go test`, `dotnet test`, `rspec` — whatever this repo
   actually uses). Fix any failures.

   **Run them concurrently only where the repo says that is safe.** Commands that
   contend over the same build output, cache, or database must stay serial — and
   if you cannot establish independence from the repo's own config, keep them
   serial. Prefer the repo's changed-path selector when it has one; the full
   command still runs, here or in CI.

   **No `test-quality` pass here.** It runs **once**, after GATE 5 has added its
   abuse tests, so a single pass covers ordinary and abuse tests together (step
   12.4). Running it now would only have to run again.

**Steps 10–12.5 are a WAVE, not a queue.** This is the second place a run loses
half an hour. Almost all of this block is **reading**, and the reads do not need
each other:

| Runs concurrently, from step 9's green tree | Why it is independent |
|---|---|
| **10** — the static security rows | reads the changed surfaces |
| **11** — the GATE 4 parity draft, **fanned out one agent per owned screen** | each screen diffs against the pinned reference alone |
| **12a–c** — GATE 5's surface inventory and abuse-case *design*, fanned out per surface | enumerating and designing are reads |
| **12.5** — the docs scan | greps docs surfaces |

**Only two things in this block are serial, and only because they write:**
GATE 5's **live attacks** (shared port, shared datastore, destructive state — see
12c) and the **fixes** any of the above produce. Collect every finding from the
wave, then apply fixes once, then run 12.4's single `test-quality` pass over the
resulting test diff.

A UI ticket with four owned screens is four concurrent parity diffs, not one
agent walking four screens in sequence — that alone is the difference between
thirty minutes and eight. Fan-out width stays proportional (see *Concurrent
recon*), and the orchestration mode is declared per wave.

10. **Pre-VAPT static security proof.** Before GATE 5 attacks anything, run the
   invoked specialist's **security rows only** (`BE-SEC-*` / `BE-AUTH-*` /
   `BE-TEN-*`, or the stack's equivalents) over the changed surfaces. This is what
   makes GATE 5's claim meaningful: *the control exists in the code* has to be
   established before *the control engages at runtime* is worth testing. Fix
   failures here. The **full** GATE 3 table runs later in the wave (step 13a);
   these rows are re-asserted there against the frozen manifest.

   **Trace the control, don't assume the diff contains it.** A surface's control
   often lives in **unchanged** middleware, config, or a base class. Follow each
   in-scope surface through its whole static control path, including the parts this
   ticket didn't touch. Where no static mapping exists — a hub-only stack, no
   specialist installed, a control with no readable owner — say so: that half is
   **declared degraded**, not proven. GATE 5 then tests a claim you actually made.

   **A fix here re-runs step 9** for the files it touched; a static-security change
   is production code like any other.

11. **GATE 4 draft — Design-Parity artifact.** Runs **iff `ui_required`** — the
   same test the lane table and the CI check use, never a looser "is this a UI
   ticket?" judgment. Produce `.specs/design-parity/<TICKET>.md`.

   **Fan out one investigator per owned screen — the count is in the approved
   plan's section 8.** Each screen's three-layer diff
   against the pinned reference is independent of every other screen's — nothing
   is shared but the reference SHA. They return unsigned per-screen verdicts as
   data; you assemble the artifact. Serializing them is the single most expensive
   avoidable cost in this block.

   **Scope — per OWNED screen, not per consumer.** GATE 4 fires for the screen(s)
   this ticket exists to build. It does **not** force a node-by-node diff of every
   screen that merely consumes a shared component you touched. A shared-component
   change opens a **separate, flagged parity-sweep task** across its consumers.

   For each owned screen, DIFF the implementation against the **pinned** reference
   (the `design_ref` SHA from Step 5) at three layers, one row per divergence with
   exact `ref file:line ↔ impl file:line` and a severity:
   - **Structure** — node-by-node: presence/absence and composition of sections,
     states (empty/loading/error), and components.
   - **Style** — class/declaration: layout, spacing, tokens, color, type, shadow.
   - **Behavior + i18n** — interactions, state, and correctness in **every locale
     and text direction the project actually ships** (drop this layer entirely if
     it's single-locale LTR).

   Grade each screen: **Faithful** (no Blocker/Major) · **Minor** (token/spacing
   drift only) · **Major** (structural/visual divergence) · **Not-built** (a
   reference screen/section with no implementation).

   Where the repo already ships render/snapshot/DOM/component tooling, use it to
   generate the structural, token, state, and direction differences mechanically —
   it is faster and reproducible. It does **not** replace the independent read:
   a harness cannot see visual hierarchy, interaction feel, or rendering defects
   outside its own scope.

   **This grade is a DRAFT.** Pass A (step 13b) independently **reviews and
   grades** the same screens against the pinned reference and returns an
   **unsigned** verdict; signing happens later, in step 15c. *The builder never signs their own parity grade.*

   **Regenerate the draft if a later step changes UI production code** — a GATE 5
   fix, for instance. A draft describing the pre-fix screen would send pass A to
   sign the wrong thing.

   If the reference wasn't pinnable at Step 5, you cannot run this gate — **STOP**
   (Step 5 must pin it first).

12. **GATE 5 — Adversarial Security Testing (any diff touching a trust boundary;
   hard gate, CI-enforced).** Step 10 either proved the security controls *exist
   in the code* or **explicitly declared that static half degraded**. This proves they *engage at runtime* — the two are not the same claim,
   and only the second survives a middleware registered in the wrong order or a
   guard whose route matcher misses the new path. Invoke the `vapt` skill (or the
   degraded fallback from the availability table).

   **Scope — trust boundaries, not files.** It fires when the diff introduces or
   changes a request handler, an auth/session path, a query taking external input,
   a sink rendering values it didn't author, an upload or path handler,
   client-side storage, an outbound call carrying credentials, a queue consumer,
   or security config (CORS, headers, cookie options, secrets). Skip **only** when
   the diff touches none of those — and name every changed file you excluded and
   why.

   **a. Attack a local, disposable instance — never production, never shared
   staging**, no matter who owns it. If the only reachable environment is shared,
   ✋ STOP and ask. If the app cannot be run locally at all, STOP.

   **b. The output is committed tests, not a report.** Each abuse case becomes a
   test in **this repo's own runners** (detected as in step 9, never assumed),
   named for the rule it defends (`VAPT-API-01: user B cannot read user A's
   invoice`) and asserting the *refusal* rather than the guard's internals.

   **c. Inventory and test design fan out by surface — the count is in the
   approved plan's section 8; live attacks do NOT fan out.**
   Enumerating surfaces and designing abuse cases are read-only and parallelize
   cleanly. **Running** the attacks does not: concurrent workers share the port,
   the disposable datastore, the principal fixtures, and each other's destructive
   state. **In GATE mode the live attacks run serially, full stop** — the
   conditional "unless each worker is isolated" belongs to AUDIT mode, where the
   run owns its environment. (`vapt`'s risk-ordered *waves* are that AUDIT mode;
   GATE mode is this ticket's diff.)

   **d. In strict mode the signer is dispatched, not assumed.** Spin up an
   independent reviewer with no build context — the same three routes GATE 4 uses
   — brief it on the surface inventory, the rule→test map, and the abuse tests,
   and have it return an **unsigned** verdict **stamped with the scope digest it
   actually reviewed**. It is signed in step 15c alongside GATE 4's, for the same
   reason — and 15c compares the two digests: if step 12.4's test edits, step
   12.5's doc edits, or a later delta round moved that scope, the verdict is
   re-derived before signing rather than signed as-is.

   A strict run with no dispatched signer is not strict — and because
   `security-sensitive` *mandates* strict mode, losing every independent-reviewer
   route here is a ✋ **STOP**, never an implicit downgrade to light.

   **e. Strict vs light.** **Strict** — the full `VAPT-API-*` / `VAPT-WEB-*` /
   `VAPT-CFG-*` set plus an **independent signature** — when the plan's
   `security-sensitive:` field is true (which also forces the HEAVY lane).
   **Light** otherwise — name the IDs rather than paraphrasing the set, and read
   them from `vapt` itself so the two never drift: `VAPT-API-01/02/03/06/07`,
   `VAPT-WEB-01/02/03`, and `VAPT-CFG-03/04`.

   **f. Fix in production code, then re-run.** An `[NN]` finding is fixed, never
   cited away — only an explicit recorded user waiver clears one. A fix that
   changes production code **re-runs step 9 and step 10's rows for the files it
   touched**. Loosening or deleting the test is not a fix.

   **g. Missing principals degrade loudly.** Authorization classes need anonymous
   + two cross-tenant users (+ roles, if the system has them). If the project
   cannot produce those fixtures, `VAPT-API-01/02/03` and `VAPT-WEB-02` are
   declared **DEGRADED by ID** — they do not silently pass.

   **PASS** ⇔ every in-scope surface carries a green committed test for every
   applicable rule · zero unfixed `[NN]` findings · a green step-12.4
   `test-quality` pass, **or its declared `TEST | DEGRADED` row** when that engine
   is unavailable · every excluded changed file **named** in
   `.specs/vapt/<TICKET>.md` · plus, in strict mode, an independent signature bound to
   GATE 5's final **scope digest** (the manifest ID is provenance only).
   **PASS-DEGRADED** ⇔ all of the above **except** that named rules could not be
   exercised — the `vapt` skill is absent, or principals could not be built. It
   requires the reduced set actually committed and green, **chosen by each
   surface's family rather than defaulting to the API set** — read the IDs from
   `vapt` itself so the two never drift:

   | Surface family | Degraded minimum |
   |---|---|
   | API / request handler | `VAPT-API-01`, `VAPT-API-02`, `VAPT-API-06`/`07` |
   | Browser / rendering sink | `VAPT-WEB-01`, `VAPT-WEB-02` |
   | Configuration (CORS, headers, cookies, secrets) | `VAPT-CFG-03`, `VAPT-CFG-04` |

   An API minimum asserted over a config-only surface proves nothing, which is why
   the family picks the set. It also requires **every unexercised rule listed by
   ID**, and the degradation carried into the step-16 report and the session log.
   A degraded run is a declared result, not a quieter PASS.

   **The disclosure contract, and its one exception.** Normally every unexercised
   rule is named **by ID**. When `vapt` itself is unavailable you do not have the
   ID inventory to name — so the degraded disclosure becomes
   `untested_families: [...]` **plus** `rule_inventory: unavailable`, and that form
   satisfies every consumer below (PASS-DEGRADED, FAIL, the CI check, the step-16
   report, the session log, and success criteria). It is accepted **only** when
   `vapt` is absent; with the skill installed, families instead of IDs is an
   under-declaration and therefore a FAIL. Never invent an ID to fill the gap.

   **In strict mode both verdicts stay provisional until step 15c signs them** —
   an unsigned strict verdict is a verdict in progress, not a pass.
   **FAIL** ⇔ otherwise — including a rule marked PASS with no test behind it, or
   a degradation that was not declared by ID — or, with `vapt` absent, not
   declared as `untested_families` + `rule_inventory: unavailable`.

   **Enforcement is machine, not honor-system.** The abuse tests run in the repo's
   existing test job; alongside them, a merge-blocking CI check (same PR-side slot
   as `nn-guard` and the GATE 4 check) rejects a trust-boundary-touching PR unless
   `.specs/vapt/<TICKET>.md` exists and reads **PASS or PASS-DEGRADED**. For
   `PASS-DEGRADED` the check does more, not less: it verifies each in-scope surface
   carries its family's reduced set, green, and that every unexercised rule is
   listed by ID — accepting the `untested_families` + `rule_inventory: unavailable`
   form when the artifact records that `vapt` was absent. **In strict mode CI also validates the signature** — signer
   identity, payload digest, and GATE 5's final scope digest — exactly as the GATE
   4 check does; a strict artifact whose signature CI cannot verify is a FAIL. A
   verdict CI cannot parse is a FAIL. (A check accepting only
   `PASS` would make the declared degraded path unreachable — which is how a
   "loud" degradation quietly becomes a silent one.)

12.4. **`test-quality` — ONCE, over the whole final test diff.** Runs **whenever
   the final diff contains test files**, whether or not GATE 5 fired: ordinary
   tests from step 9 and any abuse tests from step 12 together, in one pass. Abuse
   tests are test code and get no exemption from `TEST-*`. That single result is
   the evidence for step 9's guard, GATE 3's `TEST` row, and GATE 5. A must-fix
   violation (TEST-01/02/08) is fixed here; **GATE 5's verdict stays provisional
   until this pass is green**, and any test edit it causes re-runs the affected
   tests. This is a step of its own precisely so a change that adds tests but
   touches no trust boundary — skipping all of step 12 — still produces `TEST`
   evidence rather than an empty row.

12.5. **Docs before the freeze.** Two things, with different triggers:
   **whenever the diff touches docs surfaces**, run the full `docs-accuracy` guard
   (DOC-01..10) — that is what GATE 3's `DOC` row reuses as evidence, and a row
   backed only by a rename grep would be overclaiming. **Additionally, whenever the
   ticket renamed or changed documented behavior** (symbol, endpoint, flag,
   default), grep every docs surface (README, docs/, docstrings) for the old name
   (DOC-06) and **fix it now**. Doc changes are part of the diff
   the wave reviews; a doc edit made *after* review would be unreviewed content in
   the commit. Keep the scan's output: it is GATE 3's `DOC` evidence and step 16's
   confirmation.

13. **FREEZE, then the concurrent review wave.** Everything that writes is now
   done. Compute the **manifest** — call it **`F0`** and record that ID in every pass's
   input (see *The review freeze*) — recompute the **effective lane** from the
   actual tree, and print both. Then dispatch **all**
   of the following **together**, each bound to the manifest ID, each **blind to
   the others**, each **report-only**:

   **a. Pass C — GATE 3, the Code-Quality Audit.** The invoked specialist's
   Verification Pass over the contracted files, plus whole-diff rows. Emit one
   table: `rule → PASS/FAIL/N-A → evidence`. Evidence is a file path, a line, or a
   clause — never the word "yes".

   ```
   specialist rule rows (the Design Contract's [ARCH]/[D] rules)
   + every [NN] row — always in force, always present
   + AI-FM  row — whole diff: the 15 LLM failure modes + The Floor + refactoring discipline
   + UNIVERSAL row — whole diff: universal-principles (Clean Code · the SOLID smell
     table · CQS · DRY-as-knowledge + Rule of Three · the complexity/nesting ceilings
     + KISS · the ranked YAGNI list) + the project constitution's Always/Never lists
     and Self-Check, when one exists
   + TEST row — when the diff includes test files (reuse step 12.4's result)
   + DOC  row — when the diff touches docs surfaces (reuse step 12.5's scan)
   ```

   > **The `UNIVERSAL` row is why there is no separate MODE D sweep any more.**
   > Folding the hub's guard into `AI-FM` alone would silently drop SOLID, DRY,
   > KISS, CQS, the complexity ceilings, the full YAGNI list, and the project's own
   > constitution. `AI-FM` catches the model's failure modes; `UNIVERSAL` catches
   > the engineering ones. Both are whole-diff. A `UNIVERSAL` row that walked only
   > the failure modes is a degradation to declare, not a fold.

   **A row may not be omitted.** Every `[NN]` rule **in the successfully loaded
   inventory** is always in force and always appears. The `RULES | DEGRADED`
   sentinel applies only where **no inventory could be loaded at all**, and it
   replaces **only the inventory-derived rows** — the specialist `[ARCH]`/`[D]`
   rows and the `[NN]` rows. It never replaces `AI-FM`, `UNIVERSAL`, `TEST`, or
   `DOC`: those are walked from this file's and the hub's descriptions, so a
   missing rule inventory does not make them unavailable, and dropping them would
   silently delete the whole-diff coverage the degraded table still owes. A
   mechanically-derived `N/A` needs an applicability reason. **Never infer `N/A` just because the handler that owns a
   rule didn't change** — an indirect service, middleware, config, or migration
   change can move the surface. Unknown applicability goes to semantic review, not
   to `N/A`.

   **b. Pass A — a fresh Claude reviewer with no build context**, via
   `/code-review` on the local diff (Claude Code's built-in review, **renamed from
   `/review`**) or the fresh-reviewer-subagent fallback. Run it with **no PR
   argument** — the PR does not exist yet. Give it the **manifest**, the ticket's
   ACs, the approved plan's *Not in this ticket* list, and the rule vocabulary;
   never let it derive its own scope. It owns ACs, behavior, edge cases, and scope
   creep — the systematic rule catalogue is pass C's job, not a thing to repeat.

   **For UI tickets pass A also carries the GATE 4 independent parity check** — it
   re-derives the parity verdict against the pinned reference and returns it as
   **unsigned data stamped with the scope digest it reviewed**. It does not sign
   *here*: step 15 has not yet added the
   human-approved deviations and stub mappings the signed payload must cover, so a
   signature written now would bind to a payload that no longer exists at
   close-out. Signing happens in **step 15c**, once the payload is final.

   **`/code-review ultra` is user-triggered and billed — never launch it**, from
   here or through a shell. Skill invocation authorizes the local read-only
   passes; it does not authorize billed cloud review. If the diff warrants it, say
   so and let the user decide.

   **c. Pass B — `codex review`, a different model in a different process.** This
   is what makes the review genuinely two-pass: a model reviewing itself twice is
   one pass. Run it from the repo root **in the background**, concurrently with A
   and C — it is routinely the longest pass, so it must start at the freeze rather
   than after the others:

   ```bash
   # Instructed (default) — NO scope flag: the scope goes in the prompt text.
   # ALWAYS set the effort explicitly; never inherit the account's global default.
   codex review -c model_reasoning_effort=<lane effort> \
     "<review instructions — the manifest's scope + ticket context>"
   ```

   **Set the reasoning effort per lane — this is the largest single lever on pass
   B's wall clock, and inheriting the account default is how a review silently
   costs 3x what it needs to.** Measured on this repo, same diff, same prompt,
   `codex-cli 0.145.0`: `codex review` instructed at `xhigh` **384s**; the same
   work at `medium` via the relay **177s** — **2.2x**, with no change to what was
   asked. Many accounts set `model_reasoning_effort = "xhigh"` globally in
   `~/.codex/config.toml`, which is right for an architectural critique and
   wasteful for a routine diff.

   | Lane | Effort |
   |---|---|
   | FAST | `medium` |
   | STANDARD | `medium`, or `high` if the diff is broad |
   | HEAVY, or `security-sensitive: true` | `high` / `xhigh` — buy the depth here |

   **Bound what you ask for, not just how long you wait.** An unbounded
   "report everything" over a large diff at high effort is the combination that
   produces 40-minute passes. Ask for findings **severity-ordered, blockers and
   majors first**, and say plainly that minors may be truncated — a reviewer that
   spends its budget enumerating nits has spent it in the wrong place.

   **`codex exec --sandbox read-only` is a valid alternative carrier** (the flag is
   `-s` / `--sandbox`; there is no `--read-only` on `codex exec` — that is the
   `codex-delegate` relay's own flag) for this pass and
   measured ~1.3x faster than `codex review` on identical input (289s vs 384s),
   because you hand it the diff instead of having it rediscover the scope. It
   takes the same ticket context and the same effort flag. Either is acceptable;
   what is **not** acceptable is inheriting the global effort silently.

   **`codex review` accepts a scope flag OR a custom prompt, never both.** Verified
   on `codex-cli 0.145.0`: `--uncommitted`, `--base`, and `--commit` each conflict
   with `[PROMPT]` — the `-` stdin form included — and the command exits during
   argument parsing without reviewing anything. Re-check `codex review --help` if
   the installed version differs.

   **Give every pass the same retrieval recipe, not just a file list** — a list of
   paths and digests does not tell a reviewer how to see the change. Hand over: the
   exact tracked-diff command from the merge-base through the final working tree
   (covering committed, staged, and unstaged layers), plus instructions to read every
   **untracked** file in full, plus the manifest's per-path stage metadata so
   deletions and renames are visible as such. The normal path is uncommitted work,
   and a bare `git diff` hides staged changes.
   Give it the ticket's ACs, the plan's *Not in this ticket* list, and a demand for
   `file:line` + quoted code + fix shape. Let it use its own judgment about what to
   look for — it does not need to re-run the rule catalogue.

   **Bound its wait.** A pass-B run — `codex review` or `codex exec` alike — can
   take tens of minutes; the ceiling and the fallback below apply to both carriers. **Default
   ceiling: 15 minutes**, overridable by the repo or the user — record which
   applied *before* dispatching. On timeout, declare the degradation exactly like a
   missing engine and fall back to `/coderabbit:code-review` on the same manifest. Never
   let an unbounded external wait silently become the run's critical path.

   Codex prints its **final report block twice** — deduplicate — and emits
   **absolute paths** — strip them.

   **If the `codex` CLI is unavailable**, fall back to `/coderabbit:code-review`
   on the same manifest; if neither exists, report it precisely — **"pass B
   unavailable: one free-form reviewer plus rule pass C"**, not "single-pass",
   since pass C still ran — stated in
   step 16. Do **not** substitute a second self-review and present it as pass B.

   **PR-side bots are NOT a gate — never wait on one.** Once the PR is open (step
   19), CodeRabbit's GitHub app (and any Codex cloud review wired to the repo) may
   re-review the same diff. Read them only if they have already posted; treat them
   as informational.

14. **Reconcile — one barrier, one fix batch.** Wait for all three passes once.
   Then:

   **a. Verify coverage against the manifest.** Compare what each pass says it
   reviewed against the manifest's path list — not against a freshly derived file
   list, which may have drifted. A pass that reviewed a narrower set has **gated
   nothing**: re-run it against the missing paths and treat the union as the pass.

   **b. Check the manifest ID.** If it changed during the wave, the passes that
   predate the change do not describe the current tree. Re-run them. A stale pass
   is not a pass.

   **c. GATE 3's verdict gates acceptance.** Any `FAIL` in pass C blocks
   **acceptance and close-out** — it does not retroactively invalidate the
   concurrent work. (Running the passes together cannot turn a FAIL into a PASS;
   it only risks discarding review work when GATE 3 fails.)

   **d. Reconcile all findings into one attributed set** — `[rules]` (pass C),
   `[claude]` (pass A), `[codex]` (pass B) — and apply **one batched fix set**.

   **Fixes obey the Design Contract too.** Check every proposed fix path against
   the approved contract *before* applying it. A fix that needs a file outside the
   contract is a material divergence and goes back through plan mode — review
   findings are not a side door around the gate that governs implementation.

   **Fixing is the default; skipping requires a citation.** Fix every finding
   **except** one that contradicts a specific `[D]` or `[ARCH]` rule you can
   **name by ID**:

   ```
   skip: conflicts with NG-STD-06 — signal two-way binding is valid for
         single-value inputs with no validation graph
   ```

   No ID, no skip. "It conflicts with our conventions" is not a citation — that
   sentence can be written about any finding, which is exactly why it must not be
   accepted. If you reach for the ID and the rule doesn't say what you need it to
   say, the reviewer was right. (Degraded GATE 3 = no rule IDs loaded = **no skips
   at all**.) Codex findings get no special deference *and* no discount for coming
   from another vendor.

   **A finding that contradicts an `[NN]` rule is never skipped.** If a reviewer
   and an `[NN]` rule disagree, the reviewer is almost certainly right and you have
   a real problem. **STOP and tell the user.**

   A skipped finding is a deviation: record it in the deviations ledger of
   whichever family member you actually invoked —
   `.claude/<invoked-skill>/deviations.md`. (Design-parity deviations live in the
   GATE 4 artifact instead — they carry a human approver, not a rule ID.)

   **e. Re-run the repo's commands, then revalidate the delta.** A review fix can
   break compilation or lint without touching a test, so re-run the affected
   lint/build/test commands first (scoped only where the repo proves that safe).
   Then snapshot `F1`. Fixes here intentionally
   change code, tests, and docs — that is the point of the batch, and none of it
   belongs on the post-freeze allowlist. Once the delta pass is clean, **promote
   `F1` to the `accepted_manifest`**: it, not `F0`, is what step 19 compares
   against. (Without this promotion every accepted review fix would make step 19
   fail its own allowlist check.) If a further round of fixes is needed, continue monotonically —
   `F1 → F2 → …` — validating each *adjacent* delta and promoting the latest
   accepted manifest each time. Re-run passes A and B over the latest adjacent delta
   `F(n−1) → Fn` **concurrently**; re-run only the rule rows and tests the fixes
   touched; re-derive pass A's unsigned parity verdict if an owned screen, its
   reference, or the artifact changed (on the normal path nothing is signed yet —
   "re-sign" applies only to a resumed artifact that already carried a signature); re-attack only the GATE 5 surfaces the fix touched. Append-only derived
   output on the manifest's allowlist needs no re-review.

15. **Close-out and signing.** Pass A returned an unsigned parity verdict; the
   strict GATE 5 reviewer (if it ran) returned an unsigned verdict too. Finish the
   payloads, *then* sign them:

   **a. Residual Blocker/Major clears ONLY with human approval** — recorded as
   named design decision + approver + date. Visual drift has no rule ID; that
   record IS the citation. **No self-written waiver clears a Blocker/Major** — ✋
   STOP and surface it.

   **b. Link every stub.** Every `coming-soon` route this ticket introduces names
   its follow-up build ticket key in the artifact.

   **c. NOW sign — the payload is final.** With deviations and stub links in
   place, the canonical payload stops changing, so hand it back to the **same
   independent reviewer** that produced the unsigned verdict and have it sign
   (see *Signature binding*). This is a narrow signing pass over an assembled
   payload, not a re-review. Do the same for the strict GATE 5 payload. Signing
   before this point is the bug this ordering exists to prevent: a signature over
   a payload that close-out then edits binds to nothing.

   **PASS (per owned screen)** ⇔ grades **Faithful or Minor** after fixes, **or**
   every residual Blocker/Major carries a **human-approved** accepted deviation —
   **and** the artifact carries an **independent signature bound to the gate's
   final scope digest** — **and** every introduced stub links a follow-up ticket.
   **FAIL** ⇔ otherwise, including a signature whose scope digest is stale.

   **Enforcement is machine, not honor-system.** A merge-blocking **CI check**
   (install it alongside the `nn-guard` CI job) rejects a UI-scoped PR unless
   `.specs/design-parity/<TICKET>.md` exists, is independently signed, and is PASS
   — and the check validates the signature's **binding fields** (scope digest,
   payload digest, signer identity), not merely that a signer string is present.
   **CI evaluates `persisted ui_required` OR the view-layer diff — never the
   persisted value alone.** Step 6.5 writes the ticket/AC/contract half of the
   determination, but it runs *before* implementation and therefore cannot know what
   the eventual diff touches; **the freeze recomputes it and updates the header**.
   CI then ORs the persisted value with its own repository-derived view-layer
   detector, so neither half can suppress the other: a stale `ui_required: false`
   cannot hide a diff that actually touched the view layer, and a diff that touched
   nothing cannot hide a ticket that owed a screen and never built one — the case
   the `Not-built` grade exists to catch. A missing or unparseable header fails
   closed to `true`. Write the glob from the actual layout, e.g.
   `**/*.{html,scss,css}` plus component files (`*.component.ts`, `*.tsx`,
   `*.vue`, `*.svelte`, `*.blade.php`, `templates/**/*.html`, …). Derive it from
   where the UI really lives. Because the tracker's `Done` transition (step 20)
   follows green CI, this **hard-gates `Done`**.

16. **Report — one reconciled account of the wave.** **Written for the person who asked for the
   ticket, not for this file** (see *Speak plainly*): every line leads with what
   happened in plain words, with any code in brackets after. A report a reader has
   to decode is a report they will not read. Not "what changed between
   passes": there is one wave and one reconciliation. State:
   - the **effective lane** (with the raw numbers) and the **provisional** one it
     came from — plus, if they differ, why it escalated, and whether the plan
     review's FAST-lane omission predates that escalation
   - the **manifest ID** and each pass's verified coverage
   - the **orchestration mode** for **each wave** — recon and review — as
     workflow / fan-out / serial; they can differ, and a run that fanned out its
     review while serializing an hour of recon must not report as concurrent
   - **which engine ran pass B** (`codex review`, `codex exec`, CodeRabbit
     fallback, or none → one free-form reviewer plus rule pass C), **the reasoning
     effort it ran at**, and whether it timed out
   - the **Codex plan review's disposition** — incorporated vs. rejected, or
     `Not run — FAST lane`, or unavailable
   - every **skipped finding with its rule ID**
   - each owned screen's **final GATE 4 grade + who signed it + the scope digest
     the signature binds to**
   - **GATE 5's verdict** — surfaces attacked, abuse tests committed, every rule
     declared degraded **by ID** (or the `untested_families` +
     `rule_inventory: unavailable` form when `vapt` was absent), every changed file
     excluded and why
   - the final **TEST** and **DOC** evidence
   - the **delta pass** result, if fixes triggered one
   - every **degraded gate** from the availability check

   A skip with no ID, a parity grade with no independent signer, a VAPT rule marked
   PASS with no test behind it, a signature whose scope digest is stale, or an
   undeclared degradation is a bug in the report.

17. **Confirm the docs scan is represented** — step 12.5 already made the doc
   changes and GATE 3's `DOC` row already carries its evidence. This is the
   confirmation that it is clean and reflected, **not** the point where docs first
   change: a doc edit introduced here would be unreviewed content in the commit.

18. **Write the session log BEFORE the push** — so it rides the single gated
   commit, never a second one. Run `/session-logger` (or write the entry yourself
   to `session-log.md`); ensure it is on disk before the commit. Record:
   - the run's **availability mode**, and the **orchestration mode of each wave**
     (recon and review), and which gates ran degraded (or "full mode — all
     companions installed")
   - the **provisional and effective lane**, the raw classifier numbers, and any
     escalation
   - **every manifest ID** — `F0` and each promoted `Fn` — and which one is the
     `accepted_manifest`
   - the **approved plan's artifact path** (`.specs/plans/<TICKET>.md`), any
     **re-approval round-trips**, and any **divergence between the approved plan
     and what was actually built**
   - the **cross-model review record**: whether the Codex plan review ran (session
     id) or was a FAST-lane decision, how many findings were incorporated vs.
     rejected, **which engine ran pass B**, and each pass's run ID
   - which design files were read in Step 5 **and the pinned `design_ref` SHA**
   - the **GATE 4 grade(s), the independent signer, and the scope digest the
     signature binds to**, and the artifact path
   - the **GATE 5 verdict**: surfaces attacked, the target it ran against, the
     abuse tests committed (by path), every rule declared **degraded by ID** (or
     the `untested_families` + `rule_inventory: unavailable` form), and
     every changed file excluded and why
   - every **human-approved design deviation** (decision + approver + date) and the
     coming-soon → follow-up-ticket map
   - every skipped review finding **with its rule ID**

   **Same in the log.** It is read months later by someone without this file
   open: "Tried to break the new endpoint — all attacks refused [GATE 5]" is
   recoverable; "GATE 5: PASS" is not.

   An entry that says "skipped some findings that conflicted with our conventions",
   or "matches the design", is worthless the moment the context is gone.

19. **One commit, one push, one wait.** First **recompute the manifest** and verify
   that every change since the **`accepted_manifest`** (the latest promoted `Fn`, or
   `F0` if no fixes were needed) is on the **post-freeze allowlist** — if
   code, tests, or docs moved outside it, that content is unreviewed and the wave
   must be re-run for it. Then commit **everything in a single commit** — the code,
   `.specs/plans/<TICKET>.md`, `.specs/design-parity/<TICKET>.md`,
   `.specs/vapt/<TICKET>.md` **and the abuse tests it produced**, the step-12.5 doc
   updates, and `session-log.md` — and push it **once**. Open a PR **on the repo's
   actual host** (Azure Repos via the ADO repo tools, or GitHub via `gh` — per the
   tracker-resolution table's PR column), link the ticket to the PR, and report the
   PR URL. Then wait **exactly once** for the CI checks — including the GATE 4 and
   GATE 5 checks — to report.

   **Do not poll or block on the PR-side review bots.** **Push nothing further
   unless a gate actually fails and needs a code fix.** A doc-only commit pushed
   after the gates go green re-triggers the entire CI + PR-bot cycle from scratch.
   That re-trigger is the waste this ordering exists to prevent.

20. Transition the ticket to **Done** — **only after the GATE 4 and GATE 5 CI
    checks are green** — using the tracker-resolution table's transition column
    (Jira: the "Done" workflow transition; ADO: `wit_update_work_item` to the work
    item type's resolved completed-category state). Then tell the user the PR is
    open and ready to merge. (The user merges manually right after; the workflow
    has no "In Review" state. For UI tickets, the user is also the human approver
    of any accepted deviation in step 15a.) Then instruct the user to run
    `/compact` (a built-in CLI command you cannot invoke yourself — tell the user
    to run it).

## Stop-on-failure guard

**STOP and tell the user** if any of these happen. Don't guess the spec, don't invent
a visual language, don't mark anything complete, don't push past a failure silently.
**Say what it means for the user and what you need from them** — "I can't run
the app locally, so I can't test whether the new endpoint is actually protected"
is actionable; "GATE 5 failed" sends the reader hunting.

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
- **The manifest changed during the review wave and you cannot re-run the passes
  it invalidated** — a stale pass is not a pass, and shipping on one is the
  self-attestation the freeze exists to remove.
- **A pass returned without verifiable coverage** of the manifest's path list, or
  without the required finding shape, and cannot be re-run.
- **Content outside the post-freeze allowlist changed** after the freeze — code,
  tests, or docs went into the commit unreviewed.
- **The run lane was downgraded** after plan approval without an explicit recorded
  human decision. Escalation is automatic and fine; a downgrade is not yours.
- **A GATE 4 or strict GATE 5 signature is stale** — its scope digest is not the
  final one for that gate — and you cannot obtain a fresh independent signature.
- **No independent signer can be obtained for a UI ticket** in any orchestration
  mode. GATE 4 never degrades to self-signing.
- **No independent signer can be obtained for a strict GATE 5 run.** Strict mode
  is mandated by `security-sensitive: true` and is *defined* by that signature —
  losing it is a STOP, not a downgrade to light.
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
  written. (The review freeze does not stash: it is a *manifest* over the live
  working tree, precisely so this rule and the single-gated-commit rule both keep
  holding.) Destroying half-finished work to "leave things clean" throws away the
  expensive part and is not yours to decide.
- **Commit nothing to close it out.** The single-gated-commit rule (step 19) still
  holds; a stopped run has not passed its gates. **This skill never creates WIP
  commits** — leave the work uncommitted in the tree and say so.
- **Resuming a branch that already carries WIP commits from elsewhere?** They stay
  in scope (the manifest's committed layer covers them), but they collide with the
  single-commit guarantee, and that collision is **not yours to resolve**: ✋ STOP
  and ask whether to preserve them or squash them into the single gated commit.
  Record the answer in the session log.
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

- **`.specs/plans/<TICKET>.md` exists with `approval_status: approved`** → the
  plan was approved. Read it, confirm
  with the user that it still stands, and re-enter at the step after the one that
  stopped. **Do not re-run plan mode for an already-approved plan** — unless the
  plan itself was what turned out to be wrong, in which case it is a material
  divergence and *does* go back through plan mode. **The Codex plan review is
  part of that plan, not part of the resume** — its disposition is in section 7;
  re-dispatching it re-critiques a plan the user already approved. Only a
  re-planned plan earns a fresh critique.
- **A ticket branch exists** → use it (Step 7.4), rebased.
- **`.specs/design-parity/<TICKET>.md` exists** → GATE 4 ran; check its grade and
  **whether its signature still binds to the gate's current scope digest** rather
  than regenerating the artifact. A signature that bound to a superseded scope
  needs re-signing, not re-drafting.
- **`.specs/vapt/<TICKET>.md` exists** → GATE 5 ran; read its verdict and its
  committed-test paths, and re-run those tests rather than re-deriving the whole
  surface inventory. Only re-attack surfaces the resumed work actually changed.
- **The pinned `design_ref`** is in the plan artifact's YAML header, the GATE 4
  artifact, and the session log — reuse that SHA, do not re-pin to a newer HEAD. Re-pinning silently changes what the
  screen is being verified against, which is the exact failure Step 5 exists to
  prevent.
- **Recompute the run lane** from the current tree. It may escalate; it may not
  silently downgrade to match what the stopped run assumed.
- **A recorded workflow/wave run resumes only if its manifest ID still equals the
  current state.** Otherwise its cached pass results describe a tree that no
  longer exists — recompute the manifest and re-run.
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
- The **manifest is the scope of record** for the review wave: it lists what was
  reviewed and names every exclusion with a reason. An unexplained exclusion is
  the hole the manifest exists to close.
- **No repository writes at all during the wave** — not even allowlisted ones.
  The allowlist governs what may be appended **after** every pass has returned and
  been validated at the barrier; during the wave the tree is inert, which is the
  whole basis of the manifest's integrity argument.

## What this skill does not do

- Define the code rules — it **orchestrates** the code-quality family
  (`angular-code-quality`, `backend-code-quality`, or the `code-quality` hub);
  GATE 3 is their Verification Pass.
- **Choose or impose a stack.** The stack is the repo's, detected in *Stack —
  detected, never prescribed*. This skill never migrates a project toward a
  framework it prefers, and never assumes one the repo doesn't use.
- **Define or implement** the review engines — it invokes `/code-review`,
  `codex review` (or `/coderabbit:code-review` as the fallback), `test-quality`,
  `vapt`, and `docs-accuracy`, then reconciles their findings. **It does own the
  orchestration** around them: the run lane, the manifest, the wave, the
  reconciliation barrier, and the delta routing are this skill's, not any
  companion's.
- **Provide the concurrency.** The wave is dispatched with whatever the running
  agent offers; a serial orchestrator runs the identical passes over the identical
  manifest and says so. Concurrency changes the wall clock, never a verdict.
- **Own the delegation mechanics.** `codex-delegate` owns the brief format, the
  relay, the sandbox modes, and the `result.json` contract; this skill only
  decides *when* Codex is asked and *what it is asked about*. If that skill isn't
  installed, the plan review degrades per the availability table — do not
  reimplement its relay here.
- **Define the attack classes** — `vapt` owns the `VAPT-*` rules, the trust-boundary
  taxonomy, and the rules of engagement; GATE 5 is its gate run.
- Invent scope — one ticket, one PR; unbuilt dependencies stop the workflow
  rather than getting stubbed.
- Merge the PR or run `/compact` — both are the user's action; the skill opens
  the PR and tells the user.

## Success criteria

Working when a ticket closes with: a plan-mode-approved `.specs/plans/<TICKET>.md`
carrying its section 7 cross-model review disposition (a real critique, or a
recorded `Not run — FAST lane`); a **declared effective run lane** with the raw
numbers behind it; a **frozen manifest whose coverage every pass verifiably
reviewed**, with every exclusion named; a passing GATE 3 whose table carries the
specialist rows, every `[NN]` row, and the whole-diff `AI-FM` and `UNIVERSAL` rows
(full or **declared** degraded); an **independently-signed GATE 4 whose signature
binds to that gate's final scope digest** for every owned UI screen; a passing GATE 5
(or a declared **PASS-DEGRADED**, with each surface's
family minimum green and every unexercised rule listed by ID — or, with `vapt`
absent, `untested_families` + `rule_inventory: unavailable`) with committed abuse
tests for every trust boundary the change introduced, and a green final
`test-quality` pass over ordinary and abuse tests together — **or its declared
`TEST | DEGRADED` row**; passes A and B **both reconciled** into one attributed
finding set — or pass B's engine unavailability, or a non-UI run's named loss of
reviewer independence, **declared by name** — with every skip citing a rule ID; a clean delta pass if fixes triggered one; every post-freeze change on
the allowlist; a green CI; the ticket in Done (Jira transition or ADO completed
state); a PR linked to the ticket; and a written session log naming the run's
availability mode **and each wave's orchestration mode** — no self-attested gate, no stale
signature, and no silent degradation anywhere in the chain.

Wall-clock is a **target, not a guarantee**: ticket scope, runtime attacks, human
decisions, and CI are all variable. The wave removes serialized waiting; it does
not bound the work.
