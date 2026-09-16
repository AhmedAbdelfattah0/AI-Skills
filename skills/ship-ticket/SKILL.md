---
name: ship-ticket
description: |
  Implement a Jira or Azure DevOps ticket end-to-end on the stack already present
  in the repository. Fetch and triage the tracker specification, obtain human
  approval for a repo-grounded plan, build on a ticket branch, run the repository's
  own checks and applicable security/UI proof, perform a bounded independent
  review, then create one commit and PR and close the ticket after CI passes.

  Takes one ticket key, work item ID, or URL. Trigger for /ship-ticket,
  /ship.ticket, "ship ticket", "implement ticket", "build ticket", "ship work
  item", or an implementation request containing a Jira key or Azure DevOps work
  item identifier.
---

# /ship-ticket — implement one tracker ticket end-to-end

The argument is a ticket key, work item ID, or URL. Resolve the tracker and
repository from the user's environment; never hardcode a cloud ID, site,
organization, project, host, framework, test runner or migration tool.

## Conversation and continuation

Use plain language with internal identifiers as citations:

```text
✅ The new endpoint rejected a cross-tenant request [VAPT-API-02].
❌ VAPT-API-02 | PASS
```

Announce each phase once, in one sentence. A phase announcement, tool result,
review finding, fallback notice or other progress report is never a reason to end
the turn.

**Continuation invariant:** after any non-terminal status message, immediately
execute the recorded next action in the same turn. Resume automatically after a
tool or delegated task returns. End the assistant turn only in one of these states:

| State | Meaning | End the turn? |
|---|---|---|
| **CONTINUE** | the next in-scope action is known | no |
| **AUTO_FIX** | a bounded in-scope defect can be repaired under the current contract | no |
| **WAIT_FOR_USER** | human approval, authority, product choice or unavailable required capability is needed | yes, with one precise request |
| **FAIL** | the bounded execution ended unshipped | yes, with evidence and what remains |
| **COMPLETE** | PR, CI and tracker completion succeeded | yes |

Do not ask whether to continue work the approved plan already authorizes. A
recoverable timeout or optional companion failure invokes its fallback and
continues; reporting the degradation is not a pause.

## Measurement

Load [references/observability.md](references/observability.md) at workflow start.
Before the first tracker/repository read, create one run ID and start the workflow
and UNDERSTAND timers with the bundled `scripts/run-log.mjs` helper. Time every
phase and the named expensive activities. End a phase before starting the next.

Immediately before a legitimate `WAIT_FOR_USER`, start a wait interval; end it as
the first action after resuming. An open phase with no open wait exposes the exact
place where execution stopped after a progress report. The log lives in the
target repository's Git metadata and never changes candidate identity.

Telemetry is best effort. A missing or failed logger is a declared degradation
and execution continues; measurement must never become a new blocker.

## Lifecycle

| Phase | Outcome |
|---|---|
| **UNDERSTAND** | full tracker specification, startable ticket, detected stack and commands, pinned UI design, review capability preflight |
| **PLAN** | independently critiqued, human-approved plan and Design Contract |
| **BUILD** | implementation and tests on the ticket branch |
| **PROVE** | green locally runnable CI commands, applicable static/runtime security evidence, truthful docs and UI evidence |
| **REVIEW** | one bounded independent semantic review workflow, internally partitioned only for a material full-stack diff, plus one concurrent second opinion only for elevated risk; at most one repair and targeted confirmation |
| **SHIP** | one commit, one push, one PR, green CI and completed tracker item |

Phases are ordered, but independent work inside every phase is dependency-driven
and concurrent by default. At each scheduling point, dispatch every material
ready node that has disjoint writes and no shared mutable runtime resource. Do
not wait for an unrelated slow node. Serial execution needs a named dependency,
write collision, exclusive resource, or unavailable concurrency capability.

Load a phase reference only when entering that phase:

| Entering | Load |
|---|---|
| Workflow start | [references/observability.md](references/observability.md) |
| UNDERSTAND | [references/understand.md](references/understand.md) |
| PLAN | [references/plan.md](references/plan.md) and [references/codex-cli.md](references/codex-cli.md) |
| BUILD | this spine |
| PROVE | [references/prove.md](references/prove.md) |
| PROVE with UI | [references/design-parity.md](references/design-parity.md) |
| REVIEW | [references/review.md](references/review.md) |
| REVIEW with elevated Codex | [references/codex-cli.md](references/codex-cli.md) |
| SHIP | [references/ship.md](references/ship.md) |

## Dependency-driven orchestration

Treat each phase as a directed acyclic graph, not a prose checklist. A node is
ready when all of its declared inputs exist. Two ready nodes run concurrently
when:

- their owned write paths do not overlap;
- neither can change an input the other is reading;
- they do not share an exclusive port, datastore, fixture set, generator output,
  lockfile, cache/output directory, or other mutable resource;
- the available carrier can isolate their permissions and return results.

When two or more material nodes satisfy those conditions and subagents or a
workflow fan-out are available, dispatch them together. A missing concurrency
carrier is a recorded performance degradation: run the same DAG serially and
continue; never use **WAIT_FOR_USER** merely because parallel execution is
unavailable.

Every writing subagent receives an ownership packet: approved plan and contract
IDs, owned paths, forbidden shared paths, dependencies, required tests, exclusive
resources and completion schema. Tell it that other workers are active, that it
must not revert their work, and that it must stop and report rather than edit
outside ownership. Workers do not commit, switch branches, install dependencies,
run whole-repo formatters/generators, or change an approved integration contract.
The orchestrator owns shared seams, barriers, reconciliation and Git operations.

## Invariants

- The specification comes from the tracker, including acceptance criteria,
  comments, parents and attachments. Never reconstruct it from code.
- A human approves the plan before implementation. A model critique is advice,
  not approval.
- Branch before the first repository write, including the plan artifact. Never
  implement on the default branch.
- The approved Design Contract names every file that may change. Needing another
  path is a material divergence and requires user approval.
- Apply repository and code-quality rules while writing. REVIEW verifies work; it
  is not where routine engineering begins.
- Coverage is applicability-driven. Review redundancy is risk-driven. A standard
  ticket still checks every applicable rule, screen and trust boundary; elevated
  risk adds a second opinion rather than a second rule catalogue.
- Runtime attacks target only a local disposable instance. Never production or
  shared staging.
- One ticket produces one branch, one final commit and one PR.
- Preserve user work. Never reset, stash, overwrite or delete unrelated changes.
- After REVIEW passes, candidate bytes do not change. The execution record and
  predeclared session-log entry may be appended before the commit because they are
  excluded from the reviewed candidate identity.

## Preflight the review before building

Determine these during UNDERSTAND and record them in the plan:

- a primary reviewer independent from the builder is available;
- whether **STANDARD** or **ELEVATED** applies;
- whether Codex and its fallback are available for an elevated second opinion;
- whether the available orchestrator can dispatch that optional opinion
  concurrently;
- the available concurrent worker width and whether the carrier safely supports
  simultaneous disjoint writes in the target worktree;
- the primary, optional and confirmation time ceilings.

**ELEVATED** applies to auth, authorization, tenancy, billing, payments, secrets,
migrations, schemas, public APIs or events, shared contracts/components, unusually
broad cross-subsystem changes, or an explicit repository/user requirement. The
preflight may also select it when the reviewed scope has a material, explicitly
recorded uncertainty.

If the independent primary route is absent, use **WAIT_FOR_USER** before REVIEW
begins. Missing optional Codex or concurrency is a declared degradation; do not
serialize optional work into the critical path.

## Security sensitivity

Read an explicit ticket marker, then independently classify the change. Auth,
multi-tenancy, billing, payments and secrets are security-sensitive regardless of
labels. Record the result in the plan.

Security-sensitive work:

- is **ELEVATED**;
- starts with a failing test proving the secure behavior;
- runs the same applicability-driven attack inventory as any other trust-boundary
  change;
- requires explicit attack and security outcomes from the primary reviewer.

The label does not invent attack classes or replace static/runtime evidence.

## Rules and deviations

Load the routed code-quality skill rather than recalling it. A rule claim cites a
stable rule ID.

| Tier | Override |
|---|---|
| **[NN]** | only an explicit recorded user waiver |
| **[ARCH]** | a project-wide instruction or the owning specialist's established-architecture test |
| **[D]** | a project instruction or demonstrated repository convention |

Parity is not a code rule. A deviation from a pinned UI reference needs a named
human approver.

## Bounded repair

PROVE and REVIEW have separate limits:

- PROVE may apply at most two consolidated repair batches. Each batch fixes all
  currently known deterministic/static/runtime failures, then reruns affected
  evidence. A third batch requirement is **FAIL**.
- REVIEW may apply at most one consolidated candidate repair batch followed by
  one targeted confirmation. A confirmation finding never opens another repair
  cycle.

Read-only checks and execution-record appends do not spend either limit. A Design
Contract expansion is never counted as a repair; it is **WAIT_FOR_USER**.

## Companions and degradation

Check a CLI by executing its version command. Check a skill from the available
skill list or installed sibling folder. Detect capabilities before they become
critical.

| Missing | Behavior |
|---|---|
| routed code-quality specialist | use the hub; if the family is absent, apply repository conventions and universal principles, mark the rules check degraded, and do not invent rule IDs |
| vapt | run the family-appropriate reduced attacks from [references/prove.md](references/prove.md), commit them as tests, and name omitted families |
| test-quality | inspect behavior assertions and mocks directly and declare degraded coverage |
| docs-accuracy | run the repository-wide old-name/behavior search and declare the smaller coverage |
| codex-delegate or Codex during PLAN | present the plan with the missing cross-model critique declared; human approval remains the gate |
| Codex during elevated REVIEW | use CodeRabbit on the same candidate when available; otherwise declare the optional second opinion degraded and continue |
| independent primary reviewer | **WAIT_FOR_USER** before REVIEW starts; never let the builder self-approve |
| elevated concurrency | run only the required primary review and declare the optional opinion degraded |
| implementation/proof fan-out | execute the same dependency DAG serially, record `parallelism: DEGRADED` with the missing carrier/resource reason, and continue |
| artifact-specific CI check | record its absence and rely on committed tests in the repository's existing CI; never wait for a nonexistent check |

The /code-review command belongs to the CodeRabbit plugin. A fresh reviewer is
the primary independent route. Never launch a user-billed ultra review.

## UNDERSTAND

> Reading the ticket and determining what is actually involved.

Load [references/understand.md](references/understand.md).

In the first wave, fetch the ticket while concurrently checking repository-side
ownership signals, existing branches/PRs, prior plan artifacts, instructions,
stack manifests, commands, CI configuration, design sources and orchestration
capabilities. In the second wave, use the fetched relations to load blockers,
parents and attachments concurrently. Synthesize only after each wave joins.

Before leaving:

- the ticket is startable and has checkable acceptance criteria;
- nobody else is already implementing it, or the user has resolved the conflict;
- every locally runnable CI command is enumerated;
- UI references and design-system sources are read and committed at a recorded
  SHA;
- stack and repository conventions are detected;
- the review profile and required primary route are known.

Recon uses at most three dependency-driven waves. At the cap, an unresolved item
becomes a plan risk, **WAIT_FOR_USER**, or **FAIL**; it does not create another wave.

## PLAN

> Preparing a buildable plan and asking for approval.

Load [references/plan.md](references/plan.md) and
[references/codex-cli.md](references/codex-cli.md).

When the host exposes native Plan Mode, start the predeclared PLAN timing and
then invoke `EnterPlanMode` before any PLAN research unless it is already active.
Calling this phase PLAN is not a substitute for changing the host mode. Keep
native Plan Mode active through research, drafting, deterministic prechecks, the
bounded read-only Codex critique, and reconciliation.

Present the reconciled plan with `ExitPlanMode`; that native transition is the
human approval handoff and holds `WAIT_FOR_USER` until answered. Do not exit Plan
Mode before Codex's findings have been reconciled, and do not treat Codex's
response as approval.

There is exactly one plan approval. When `ExitPlanMode` returns approved,
transition to **CONTINUE** and execute the after-approval actions immediately.
Never ask the user to also say “go”, “continue”, or “confirm”. In the headless
fallback, the first explicit approval of the presented reconciled plan has the
same effect and must not be followed by another approval prompt.

If native Plan Mode is unavailable, follow the headless fallback below and make
the ordinary approval request **WAIT_FOR_USER**.

After approval:

- create or reuse the ticket branch from an up-to-date base;
- save the approved plan under .specs/plans/<TICKET>.md;
- append a **START** event with the workflow run ID and approved-plan digest;
- invoke the routed quality skill and write one Design Contract derived from the
  approved execution DAG;
- for full-stack work, materialize or generate the approved Integration Contract,
  record its digest, and make both frontend and backend nodes depend on that same
  contract ID.

In a headless environment, branch, write the plan with approval status pending,
and use **WAIT_FOR_USER**; do not implement. This fallback does not weaken the
approval gate or permit implementation before approval.

## BUILD

> Building the approved change.

Read the plan and Design Contract from disk before writing.

- Reuse an existing ticket branch. If it contains unknown WIP commits, use
  **WAIT_FOR_USER** for the preserve-or-squash decision.
- Schedule the execution DAG continuously: whenever a node finishes, dispatch
  every newly ready conflict-free node without waiting for unrelated siblings.
- On full-stack work, after the Integration Contract is materialized and frozen,
  dispatch frontend and backend implementation workers concurrently. Neither
  waits for the other's implementation, tests, or review; both depend only on
  the same approved contract and their own prerequisites.
- Give each writing worker exclusive file ownership and a completion report of
  changed paths, tests, unresolved dependencies and contract assumptions. The
  orchestrator owns shared files and the integration join.
- Apply routed rules while each file is written.
- Build UI from existing tokens and shared components, checking each owned screen
  while its design is in context.
- For security-sensitive behavior, add the failing refusal/isolation test first.
- Use the repository's existing migration mechanism.
- Keep every write inside the Design Contract.

At the full-stack join, verify the contract digest is unchanged, every changed
path has exactly one owner, generated clients/types are current, and both provider
and consumer conformance checks pass. Only then run real endpoint integration,
end-to-end checks, and attacks. Contract drift pauses both sides and returns to
PLAN approval; it is never repaired independently by one worker.

Continue until implementation is complete. Report progress without yielding.

## PROVE

> Running the repository's checks and testing the change under hostile inputs.

Load [references/prove.md](references/prove.md) and, for UI,
[references/design-parity.md](references/design-parity.md).

Build the PROVE ready set from command inputs and resource locks. Run independent
repository commands and read-only static-security, test-quality, docs,
parity-preparation and attack-design nodes concurrently where
[references/prove.md](references/prove.md) permits it. Consolidate failures before
repairing them. After each repair, rederive every affected inventory and rerun
every affected command.

Leave PROVE only when:

- every locally runnable CI command is green and every non-runnable command is
  declared;
- tests and docs describe final behavior;
- applicable controls exist statically and engage at runtime;
- abuse cases are committed in the repository's runner;
- UI parity metadata is complete;
- the primary review route is still available;
- the candidate has no known deterministic defect.

Do not announce REVIEW until its preflight in
[references/review.md](references/review.md) passes.

## REVIEW

> Performing the bounded independent review.

Load [references/review.md](references/review.md).

Compute the candidate ID. Dispatch one checklist-backed independent primary
workflow. For a material full-stack diff, partition frontend, backend and shared
contract coverage as defined in the review reference; otherwise use one reviewer.
On **ELEVATED**, start the optional Codex opinion concurrently when available.

Reconcile once. A clean primary PASS continues directly to SHIP. Accepted
findings receive one consolidated repair batch and one targeted confirmation by
the primary reviewer. A material elevated-review disagreement gets the same
targeted confirmation without inventing a repair. Confirmation PASS continues;
any required further candidate change is **FAIL**.

Within the one repair batch, disjoint finding units may be assigned concurrently
under the same ownership protocol. Join them, rerun the union of affected proof,
and dispatch only one targeted confirmation. Parallel repairs do not create extra
review rounds.

The review checks acceptance criteria, behavior, every applicable rule, UI parity
when triggered and frozen runtime evidence when trust boundaries are triggered.
It does not repeat deterministic commands or attacks unless a repair invalidates
their inputs.

## SHIP

> Creating the commit and PR, waiting for CI, and completing the ticket.

Load [references/ship.md](references/ship.md).

Verify the approved-plan digest and recompute the candidate ID. It must equal the
reviewed final candidate. Append only the compact **SHIP_READY** execution event
and predeclared session-log entry, then create one commit and push once.

Open and link the PR on the repository's actual host. Wait for the enumerated CI
gate, not optional PR review bots. When CI is green, transition the tracker item
to its actual completed-category state and report the PR.

Transport or service failures pause only the missing idempotent SHIP operation;
resume after verifying the same candidate ID. A deterministic red CI result or
any candidate-byte change is **FAIL** and never silently reopens REVIEW.

## When execution may yield

Use **WAIT_FOR_USER** only for:

- plan approval or approval of changed scope;
- missing acceptance criteria or unresolved product behavior;
- a live blocker, ownership conflict or unknown WIP history;
- an uncommitted or missing UI design reference;
- no safe local environment for required attacks;
- an explicit [NN] waiver;
- absence of the required independent primary reviewer;
- credentials, permissions or external authority only the user can provide.

Use **FAIL** for:

- a PROVE third repair batch would be required;
- REVIEW confirmation fails or requests another candidate change;
- a reviewer result overflows with blockers or majors;
- candidate identity changes unexpectedly during REVIEW or before commit;
- deterministic CI fails after the reviewed commit;
- an unfixable correctness or security defect remains inside the approved scope.

All other in-scope work is **CONTINUE** or **AUTO_FIX**.

When yielding, preserve the branch and artifacts. State the phase, branch, what
exists, what remains, and exactly one user action needed. Never make a progress
message look like completion.

## Resume

- Approved plan, no review result: recheck ticket ownership and resume the phase
  that stopped. Do not repeat the plan critique.
- Failed REVIEW: preserve its event. A user-authorized retry reuses the approved
  plan when scope is unchanged, reruns affected PROVE evidence, and starts one new
  bounded REVIEW execution. It does not replay UNDERSTAND or PLAN.
- REVIEW PASS, SHIP incomplete: verify the same candidate ID and resume only the
  missing idempotent external operation. Never rerun REVIEW.
- Changed scope, Design Contract or approved plan: return to human approval.
- Existing attack or parity evidence may be reused only when its inputs and
  candidate paths are unchanged; otherwise rerun the affected proof, not the
  entire workflow.

Never reset, stash, delete the branch or create WIP commits to manufacture a clean
resume.

## Scope boundary

This skill orchestrates; companion skills own their rule catalogues and detailed
methods. Repository instructions outrank this skill. Read both AGENTS.md and
CLAUDE.md when present and follow pointers rather than duplicating them.

Unrelated defects become follow-up notes or tickets. Do not expand the current
Design Contract to fix them. The user merges the PR and runs any requested context
compaction; this skill does neither.
