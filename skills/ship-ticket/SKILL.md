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

**The approved plan is scoped authorization.** It authorizes that ticket's (or
that wave's) approved scope only, never later tickets and never permanently.
After the native approval, run implementation, tests, review, repair,
verification and PR preparation without routine questions. For a routine
decision inside the approved scope, apply the recommended default and record it
in the current phase's next execution event in RUN-STATE (for BUILD, the PROVE
event); a minor complementary change inside the Design Contract
that the ticket needs to be complete is allowed and recorded the same way. Stop
with **WAIT_FOR_USER** only for the cases listed in "When execution may yield":
a material scope change or Design Contract expansion, a security or assurance
exception, a destructive action, an unresolved blocker, or a decision that needs
explicit owner authority.

## Measurement

Load [references/observability.md](references/observability.md) at workflow start.
Before the first tracker/repository read, create one run ID and start the workflow
and UNDERSTAND timers with the bundled `scripts/run-log.mjs` helper. Time every
phase and the named expensive activities. End a phase before starting the next.

Immediately before a legitimate `WAIT_FOR_USER`, start a wait interval; end it as
the first action after resuming. An old open phase with no open wait warrants
checking transcript and log integrity; it alone cannot prove an agent stop. The log lives in the
target repository's Git metadata and never changes candidate identity.

Telemetry is best effort. A missing or failed logger is a declared degradation
and execution continues; measurement must never become a new blocker.

## Lifecycle

| Phase | Outcome |
|---|---|
| **UNDERSTAND** | full tracker specification, startable ticket, detected stack and commands, pinned UI design, review capability preflight |
| **PLAN** | one native-approved, complete plan (debated with the counterpart by default: the reciprocal Planning Debate) and Design Contract |
| **BUILD** | implementation and tests on the ticket branch |
| **PROVE** | green locally runnable CI commands, applicable static/runtime security evidence, truthful docs and UI evidence |
| **REVIEW** | one bounded independent semantic review workflow, internally partitioned only for a material full-stack diff, plus one mandatory second opinion (Codex, else Fable); at most one repair and targeted confirmation |
| **SHIP** | one commit, one push, one PR, green CI and completed tracker item |

Phases are ordered, but independent work inside every phase is dependency-driven
and concurrent by default. At each scheduling point, dispatch every material
ready node that has disjoint writes and no shared mutable runtime resource. Do
not wait for an unrelated slow node. Serial execution needs a named dependency,
write collision, exclusive resource that cannot be duplicated, or unavailable
concurrency capability.

Load a phase reference only when entering that phase:

| Entering | Load |
|---|---|
| Workflow start | [references/observability.md](references/observability.md) |
| UNDERSTAND | [references/understand.md](references/understand.md) and [references/cross-model.md](references/cross-model.md) (load it once; PLAN and REVIEW reuse it, reloading only if it is no longer in context) |
| PLAN | [references/plan.md](references/plan.md) |
| BUILD | this spine and [references/brief.md](references/brief.md) |
| PROVE | [references/prove.md](references/prove.md) |
| PROVE when the plan opts into test kinds | [references/test-kinds.md](references/test-kinds.md) |
| PROVE with UI | [references/design-parity.md](references/design-parity.md) |
| REVIEW | [references/review.md](references/review.md); [references/cross-model.md](references/cross-model.md) only if it is not in context |
| PLAN, PROVE or REVIEW of security-relevant work | [references/security-risk.md](references/security-risk.md) |
| SHIP | [references/ship.md](references/ship.md) |
| PLAN when the plan chooses SPLIT | [references/units.md](references/units.md) |
| BUILD, PROVE or REVIEW when any DAG node has `unit` | [references/units.md](references/units.md) |
| On demand, when the operator card names it | [references/harness-internals.md](references/harness-internals.md) |

## Execution harness (outside PLAN)

Bundled Node helpers turn the orchestration rules below into checks at the
process boundary: `scripts/harness.mjs` (wave schedule, live admission, model
tiers), `scripts/carrier.mjs` (approved, subscription-safe writer dispatch with
ownership checks and provider-reported usage), `scripts/usage.mjs` and
`scripts/docker-lifecycle.mjs` (label-owned containers only). On top of them,
`scripts/run-engine.mjs` drives the approved DAG and keeps durable, resumable
state, and `scripts/gate.mjs` verifies the RED, review and ship-ready gates.
Read [references/execution-harness.md](references/execution-harness.md) before BUILD.
The scheduler and carrier refuse PLAN (the usage and Docker helpers take no
phase; never call them during PLAN), and the carrier refuses REVIEW (it dispatches BUILD, PROVE, SHIP and REPAIR writers). An *unavailable*
helper (no Node, missing file, unsupported provider) is a declared degradation.
A *safety refusal* is not: missing approval evidence returns to approval,
unproven subscription billing is **WAIT_FOR_USER** for the user's billing
decision, and an ownership violation fails that node into bounded repair.

**Before HEAVY work** (full suites, builds, mutation runs) run
`node <SHIP_TICKET_SKILL>/scripts/host-admit.mjs --class heavy [--running N]` and reduce parallelism
or wait while it holds (exit 1); on non-macOS it prints `platform_unsupported`
(exit 2), which is not an allow: apply the manual rule (check memory and load
yourself, run one heavy job at a time). Details in execution-harness.md.

## Dependency-driven orchestration

Treat each phase as a directed acyclic graph, not a prose checklist. A node is
ready when all of its declared inputs exist. Two ready nodes run concurrently
when:

- their owned write paths do not overlap;
- neither can change an input the other is reading;
- they do not share an exclusive port, datastore, fixture set, generator output,
  lockfile, cache/output directory, or other mutable resource;
- the available carrier can isolate their permissions and return results.

A shared resource is a reason to isolate, never a reason to queue. When ready
nodes — or parallel tickets in one wave — collide only on a resource that can be
duplicated (a local database stack, a port, a fixture set, a cache or output
directory), give each one its own instance: uniquely named, created for that
run, and torn down on exit including failure. Then run them concurrently.
Serialize only on a true dependency (overlapping write paths, a shared contract,
merge order on overlapping code) or a resource that genuinely cannot be
duplicated, and record which. If the isolation tooling does not exist yet,
building it is the top-priority node and it must not wait behind the bottleneck
it removes.

When two or more material nodes satisfy those conditions and subagents or a
workflow fan-out are available, dispatch them together. A missing concurrency
carrier is a recorded performance degradation: run the same DAG serially and
continue; never use **WAIT_FOR_USER** merely because parallel execution is
unavailable.

Assign a fresh stable `parallel_group` ID to each dispatch wave and never reuse
an ID within the same run. Activities in one wave share its ID; a later ready
set gets a new ID even when it uses the same worker names.

Every writing subagent receives an ownership packet: approved plan and contract
IDs, owned paths, forbidden shared paths, dependencies, required tests, exclusive
resources and completion schema. Tell it that other workers are active, that it
must not revert their work, and that it must stop and report rather than edit
outside ownership. Workers do not commit, switch branches, install dependencies,
run whole-repo formatters/generators, or change an approved integration contract.
The orchestrator owns shared seams, barriers, reconciliation and Git operations.

### Never wait on a notification alone

A delegated agent's completion message can be lost (host sleep, a stopped
sub-worker, an interrupted handback). This adds recovery evidence. It does **not**
add a yield condition: the turn still ends only in the states of the continuation
table, and an in-flight worker is not one of them.

- **Fresh, bound markers.** Each dispatch names a fresh marker path that must not
  exist yet. The marker lives outside candidate paths, and the dispatch records
  its run, node, execution ID and candidate ID. Writing workers write their own
  marker (a `result.json`, a gate summary ending in `ALLDONE`, a RUN-STATE event
  carrying that execution ID). For read-only delegates the carrier owns the marker
  (for example the relay's result file, or the orchestrator persisting the
  returned schema). A marker from another dispatch, execution or candidate is
  ignored.
- **Watch only where the host can wake you.** Preflight whether the host
  re-invokes the orchestrator when a background command exits (`run_in_background`
  on Claude Code). If it does, arm one watcher per in-flight item: it exits when
  its marker appears, or after 20 minutes without a marker or owned-path change.
  If it doesn't, use the carrier's supported bounded wait inside the active turn,
  and declare recovery degraded.
- **On re-invocation, validate before advancing.** This covers a watcher exit, a
  host wake-up (date jump, `sleep` errors) or a user "status?". Read the markers
  first. A marker only lets you *collect* the result. The phase advances only
  after the substantive result passes its normal exit conditions: the REVIEW
  schema and PASS rules in [references/review.md](references/review.md), or the
  PROVE gate rules. A missing or invalid result uses that phase's bounded recovery
  budget.
- **Inactivity is a diagnostic, not proof of death.** Read-only reviewers and
  long tests may not write anything. Before replacing a worker, check its
  carrier/process status. Then verify cancellation, and keep REVIEW's deadline,
  recovery budget and reviewer-independence rules. The builder never takes over a
  review.
- A reply of "still running" is valid only if a watcher or an active bounded
  wait covers that item.

## Invariants

- The specification comes from the tracker, including acceptance criteria,
  comments, parents and attachments. Never reconstruct it from code.
- A human approves the plan before implementation. A model critique is advice,
  not approval.
- Branch before the first repository write, including the plan artifact. Never
  implement on the default branch.
- The approved Design Contract names every file that may change. Needing another
  path is a material divergence and requires the owner's re-approval: re-enter Plan Mode and present the revised plan with `ExitPlanMode` (Resume, changed plan).
- Apply repository and code-quality rules while writing. REVIEW verifies work; it
  is not where routine engineering begins.
- Never ship a feature switched off. A flag, env var or rollout fence that gates
  the ticket's feature must default to on in every environment the human tests
  in, unless the human explicitly asked for it to be off. If a fence seems
  necessary, ask during PLAN; never add one silently. SHIP checks the diff for
  any new or changed `false`/disabled feature switch and blocks on it, unless
  the human asked for that switch to be off (record the request in the plan).
- Coverage is applicability-driven. Every ticket checks every applicable rule,
  screen and trust boundary, and every ticket gets the mandatory second opinion
  (Codex in a fresh session when available and within quota; otherwise a fresh
  Fable session, recorded as a same-provider independent review; CodeRabbit is
  optional extra coverage, never required; leave `config.unitReview` off when
  Codex is unavailable, see [references/units.md](references/units.md)) — a
  second opinion, not a second rule catalogue.
- Runtime attacks target only a local disposable instance. Never production or
  shared staging.
- One ticket produces one branch, one final commit and one PR. The only
  exception is the waiting-sibling stack in REVIEW ("Batch siblings that are
  still waiting"), which follows the multi-ticket contract in
  [references/ship.md](references/ship.md).
- Preserve user work. Never reset, stash, overwrite or delete unrelated changes.
- After REVIEW passes, candidate bytes do not change. The execution record and
  predeclared session-log entry may be appended before the commit because they are
  excluded from the reviewed candidate identity.

## Preflight the review before building

Determine these during UNDERSTAND and record them in the plan:

- a primary reviewer independent from the builder is available;
- whether **STANDARD** or **ELEVATED** applies;
- host identity, the PLAN counterpart and the REVIEW second-opinion route
  (Codex, else Fable), following [references/cross-model.md](references/cross-model.md);
- whether Codex is available and within quota, and whether Fable is available;
- whether the orchestrator can run that mandatory second opinion concurrently
  with the primary review;
- the available concurrent worker width and whether the carrier safely supports
  simultaneous disjoint writes in the target worktree;
- the primary, second-opinion and confirmation time ceilings and a verified
  deadline/cancellation route, not merely a timed native wait.

**ELEVATED** applies to auth, authorization, tenancy, billing, payments, secrets,
migrations, schemas, public APIs or events, shared contracts/components, unusually
broad cross-subsystem changes, or an explicit repository/user requirement. The
preflight may also select it when the reviewed scope has a material, explicitly
recorded uncertainty.

A structural path floor runs alongside your own judgement, only when the repository declares
it. When `.ship-ticket/risk-paths.json` does not exist at the base commit and the plan does not
opt into test kinds (the plan's test-kinds tag line, or a repository
test-kinds declaration file under `.ship-ticket/` at base; both are named in `references/test-kinds.md`), skip `risk-floor.mjs` and record the single plan line `risk_floor: not
declared`; your assessment is then the only protection. An opted-in test-kinds plan still runs
`check` and records its strict record line (`declaration=none`), because test kinds require it. The
repository declares its
sensitive paths in `.ship-ticket/risk-paths.json` (read from the base commit; see
[references/risk-paths.example.json](references/risk-paths.example.json); a pattern also covers
everything below a match). `node scripts/risk-floor.mjs check --base <c> --planned-paths <json>
--claimed <profile> --ai <profile>` computes the floor from the planned paths, and `reassess
--base <c> --head <c|WORKTREE> --recorded-line <file|-> ...` recomputes it from the ACTUAL changed
paths (base to HEAD, staged, unstaged and untracked; git-ignored untracked files are outside release
scope, and a force-added one appears in the index/HEAD diffs) before release. `--recorded-line` is a file or stdin holding the plan's `risk_floor:` record line
(the `check` line; paste it from the plan header; `risk_reassess:` lines are ignored). Pin `--base`
from the plan/run state: `reassess` refuses a base different from the recorded line, and the
recorded claim, assessment and final also count, so it can never return less than the plan said.
The recorded line is not authenticated until the driver slice. Planned directories and wildcards are
treated conservatively (a directory-like entry floors if a declared glob may match below it);
a dotted directory name without a trailing `/` is read as a file, which `reassess` catches later.
The final profile is never lower than the floor, the recorded claim or your own
semantic assessment (your assessment owns business impact, indirect dependencies and architecture).
A floor only raises, and a path that matches nothing is not evidence of low risk. A repository that
declares no paths gets no structural protection (`no_risk_paths_declared`); your assessment is then
the only protection and is still recorded. A change to the declaration itself is ELEVATED. Missing or
untrustworthy inputs mean ELEVATED. Record the `record_line` in the plan header. Today this is
advisory, not enforced: no gate or engine step reads it (wiring is the driver slice, S-23/S-24).
Text/keyword matching was evaluated and dropped; a measured corpus experiment is deferred.

If the independent primary route or enforceable deadline is absent, follow the
capability/explicit-exception procedure in the review reference before REVIEW
begins. Missing Codex falls back to a fresh Fable session; if neither can run, use
**WAIT_FOR_USER** — the second opinion is mandatory. Missing concurrency only
serializes the two reviews.

## Security sensitivity

Read an explicit ticket marker, then independently classify the change. Auth,
multi-tenancy, billing, payments, money and secrets are security-sensitive regardless of
labels. Record the result in the plan.

Security-sensitive work:

- is **ELEVATED**;
- starts with a failing test proving the secure behavior, recorded as a `RED`
  event before any production path is written (see BUILD);
- runs the same applicability-driven attack inventory as any other trust-boundary
  change;
- requires explicit attack and security outcomes from the primary reviewer.

The label does not invent attack classes or replace static/runtime evidence.
Which attack classes apply comes from the `vapt` control catalog, selected and
reassessed as [references/security-risk.md](references/security-risk.md) describes;
the profile, routing and labels above stay as written here.

## Rules and deviations

Load `code-quality` and the routed stack reference (`stack-angular.md`,
`stack-backend.md`, or both) rather than recalling them. A rule claim cites a
stable rule ID.

| Tier | Override |
|---|---|
| **[NN]** | only an explicit recorded user waiver |
| **[ARCH]** | a project-wide instruction or `code-quality`'s established-architecture test (STEP 0) |
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
Contract expansion is never counted as a repair; it is **WAIT_FOR_USER** for the
re-approval through `ExitPlanMode` (Resume, changed plan).

These limits apply per ticket and REVIEW execution, including multi-ticket
orchestration. An explicitly authorized retry follows Resume; it is never started
automatically. The finite sequence is:

| Check | Runs | Re-runs only when |
|---|---|---|
| Repository checks | all required locally runnable commands in PROVE, before REVIEW | after a consolidated repair, rerun commands whose direct or transitive inputs changed; reuse unchanged evidence |
| Scope selection | derive affected checks from repository commands and dependency relationships | include shared libraries, config, dependencies/lockfiles, tests/fixtures, generators and base/rebase changes; UI/docs labels alone do not establish scope; if scope cannot be established, run the full required suite |
| Confirmation | once after REVIEW repair, or to resolve a material review disagreement; checks findings, dispositions and their dependency-closed affected surface | a new actionable finding or failed check is terminal **FAIL**; no further candidate edits in this execution |
| Design parity | one complete comparison by REVIEW's independent primary workflow; after UI repair, one dependency-closed impact-slice comparison within confirmation | no later parity dispatch; screenshots supplement evidence for the human approver, they never replace the comparison or prior approval of deviations |

Complete required checks before REVIEW. SHIP verifies that their evidence still
applies to the immutable reviewed candidate; it does not schedule a fresh full run
merely because shipping is next. When reporting progress, name the step the
ticket is on so the human can see the sequence is finite.

## Companions and degradation

Check a CLI by executing its version command. Check a skill from the available
skill list or installed sibling folder. Detect capabilities before they become
critical.

| Missing | Behavior |
|---|---|
| `code-quality` or its routed stack reference | a retired alias is not a rule source; apply repository conventions and universal principles, mark the rules check degraded, and do not invent rule IDs |
| vapt | run the family-appropriate reduced attacks from [references/prove.md](references/prove.md), commit them as tests, and name omitted families |
| test-quality | inspect behavior assertions and mocks directly and declare degraded coverage |
| docs-accuracy | run the repository-wide old-name/behavior search and declare the smaller coverage |
| selected counterpart or its PLAN carrier | the PLAN-start probe reports the failure class (`codex_route`); then debate with a fresh Fable session as the declared substitute, recorded `carrier.degraded: true` with the frozen acknowledgement (same provider, not cross-model agreement; a transport label that does not by itself resolve or waive any finding, and the same convergence checks apply); if Fable also cannot run, **WAIT_FOR_USER** for restored access or an explicit owner exception |
| Codex during REVIEW (unavailable, failed, or usage limit reached) | run a fresh Fable session on the same candidate (`second_opinion: fable`; identity as [references/cross-model.md](references/cross-model.md) "Dispatching Fable" records it); if Fable also cannot produce a usable result, **WAIT_FOR_USER** — the second opinion is mandatory and never silently skipped. CodeRabbit is optional extra coverage, never a required route; because the engine requires a cross-provider second opinion for a risky unit, `config.unitReview` stays off when Codex is unavailable ([references/units.md](references/units.md)) |
| independent primary reviewer | **WAIT_FOR_USER** before REVIEW starts; never let the builder self-approve |
| review concurrency | run the primary review and the second opinion one after the other; both are still required |
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

Load [references/plan.md](references/plan.md); cross-model.md is already loaded
from UNDERSTAND.

**Before planning, settle two things with the owner.** Read the repository's
CLAUDE.md (or AGENTS.md) for the base branch (for example `main` or `qa`); if it
is unclear, ASK the owner before planning, never guess. At the START of the
ticket or wave, ask ONCE whether auto-merge is allowed after the reviews and CI
are green: yes means merge after every gate has passed; no means prepare the PR
and wait for the owner's "merge". Deploy is a separate decision and is never
implied. Merge stays manual unless the owner opted in.

In an interactive session the orchestrator owns the Plan Mode lifecycle; follow
the host-specific procedure in the plan reference. On Claude, `EnterPlanMode` and
`ExitPlanMode` are deferred tools: the first action of PLAN is to load them, when
they are not already callable, with ToolSearch query
`select:EnterPlanMode,ExitPlanMode`, then enter Plan Mode before any PLAN
research. Codex uses its actual Plan collaboration mode; interactive Codex in
Default mode must request the client's `/plan` switch when no native transition
tool is exposed, not silently take the headless path. Calling this phase PLAN is
not a substitute for changing the host mode. Research subagents (Plan, Explore,
Opus planning agents) work inside the orchestrator's Plan Mode and return
findings; they never enter or exit it. Keep native Plan Mode active through
research, drafting, deterministic prechecks, the read-only Planning Debate, and
reconciliation.

The orchestrator writes the complete plan (every template section filled, no
stubs or placeholders) to the native plan file and presents it through the host's
native approval handoff: `ExitPlanMode` on Claude, the host-prescribed final plan
format on Codex. A wave uses one `ExitPlanMode`. Hold `WAIT_FOR_USER` until
answered. Chat text, an `AskUserQuestion` answer and a typed "approve" are not
plan approval; `AskUserQuestion` may only resolve planning questions before
`ExitPlanMode`. Every counterpart answer is exactly one counterpart-response-v1 JSON
object, and free text is never approval evidence: a non-conforming answer fails the
round, and the host re-asks with a new `request_id`. The owner-approved dispositions
are one `debate-dispositions-v1:` narrative line, never section 7 Markdown. Do not exit
Plan Mode before the debate has been reconciled and
`brief.mjs debate-check` accepts the frozen plan (an `UNRESOLVED` plan is presented for the owner's disposition; see
[references/cross-model.md](references/cross-model.md) "PLAN debate"); state the
attestation line's sha256 in the text accompanying `ExitPlanMode`, and do not
treat either model's agreement as human approval. Quote the `debate-dispositions-v1:` line verbatim beside that hash in the ExitPlanMode text.
Before `ExitPlanMode` on a policy-2 plan with an execution DAG, run
`scripts/run-engine.mjs preflight --repo <dir> --ticket <key> --dag <file> --plan <draft>`.
It checks the plan and DAG as `init` will, with no START and no write. Fix any
refusal it prints before presenting the plan
([references/security-risk.md](references/security-risk.md) section 6).

There is exactly one plan approval. Once it is approved and the host permits
implementation, transition to **CONTINUE** and execute after-approval actions immediately.
Never ask the user to also say “go”, “continue”, or “confirm”. In the headless
fallback, the first explicit approval of the presented reconciled plan has the
same effect and must not be followed by another approval prompt.

Native Plan Mode is unavailable only when the ToolSearch query returns neither
tool (a genuinely headless carrier) or the user explicitly opted out of Plan
Mode. Only then follow the headless fallback below, record
`native_plan_mode: unavailable` with the reason, and make the ordinary approval
request **WAIT_FOR_USER**.

After approval:

- create or reuse the ticket branch from an up-to-date base;
- save the approved plan under .specs/plans/<TICKET>.md;
- copy the debate bundle to the retained locator with `brief.mjs debate-retain --plan <plan> --bundle <bundle root> --repo <repo>` before START (a failed copy is **WAIT_FOR_USER**, never a START without the retained evidence);
- append a **START** event with the workflow run ID and approved-plan digest (compute it with `brief.mjs plan-digest`, never `shasum`), plus `debate_attestation_sha256` (the hash stated at `ExitPlanMode`) on a `debate_policy: 2` plan; then run `brief.mjs start-check --plan <plan> --run-id <id> --repo <repo>`;
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
- With Node available, drive BUILD and PROVE with `run-engine.mjs`: bind the
  approved DAG at approval (`DAG_BOUND`), run `init` then `drive`, and read only
  `status`. Record RED, review and ship-ready with `run-engine.mjs gate
  red|review|ship-ready --repo <dir> --ticket <key> --run-id <id> --input <json-file>`
  rather than hand-run loops; a `gate review` FAIL enqueues its finding-bound repair,
  which the next `drive` dispatches. When any node has `unit` or the DAG sets `config.unitReview`, follow
  [units.md](references/units.md); unit reviews do not replace the final review, which stays mandatory. Judgment points (`status.judgments`) come back to you or the
  user. The manual flow below is the documented fallback when the engine or gate
  module is unavailable (record `harness degraded`). On an ELEVATED or
  security-sensitive run, falling back to the manual (engine-less) flow after plan
  approval is an assurance exception at fallback time: **WAIT_FOR_USER** for the
  owner's recorded approval (approve the manual flow, or restore the engine and
  resume on it); a STANDARD run records the degraded path with a
  warning and continues. A run that falls back after
  `init` stays manual for the rest of the ticket: do not `resume`, `drive` or `gate`
  it again, since its ledger no longer reflects the work. While that state file
  exists the carrier still treats it as REPAIR authority, so a REPAIR the ledger does
  not authorize is **WAIT_FOR_USER**, never a hand-edit of the state file.
- Schedule the execution DAG continuously: whenever a node finishes, dispatch
  every newly ready conflict-free node without waiting for unrelated siblings.
  When Node is available, derive waves with the harness `schedule` (run ID as
  `groupPrefix`), `admit` each wave before dispatch, and dispatch external-CLI
  writers through `carrier.mjs run` so approval, billing, timeout and ownership
  are enforced; import its usage on the activity's end event with `--metrics-from`.
  Copy each scheduled node's `risk` and `complexity` into its dispatch JSON, and
  its `model` (if any) as `modelTier`, the carrier's model-tier input: the
  carrier routes the tier only from those fields, so omitting them turns a
  high-risk node's required `strong` tier into `inherit` and drops a requested tier.
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
- **Red before production code.** For security-sensitive work, and for any bug
  fix, the plan's test node runs first and ends with a `RED` event (see
  [references/ship.md](references/ship.md)). Until that event exists, write
  only test files, fixtures and test stubs; no other Design Contract path. The
  red run must fail on a behavioral assertion. A missing module, import or type
  error is not red: stub the seam the test needs (a bare export or signature
  that throws), then run again. If the new behavior cannot be reached without
  production changes, first write the smallest stub that compiles, and record
  it in the event. A red run produced afterwards against the base branch is a
  declared degradation (`red: RETROACTIVE`), never test-first.
- Use the repository's existing migration mechanism.
- Keep every write inside the Design Contract.

At the full-stack join, verify the contract digest is unchanged, every changed
path has exactly one owner, generated clients/types are current, and both provider
and consumer conformance checks pass. Only then run real endpoint integration,
end-to-end checks, and attacks. Contract drift pauses both sides and returns to
PLAN approval through `ExitPlanMode`; it is never repaired independently by one worker.

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
On every ticket, start the mandatory second opinion (Codex, else Fable)
concurrently in a fresh session when resources allow. Keep the planning debate
out of the bounded code review.

The orchestrator runs the independent reviewers itself: it opens a shell, calls
the Codex CLI (else Fable) and a separate subagent with the standard brief, triages findings
by evidence, fixes, then runs the targeted confirmation. If the confirmation
fails: STOP, write the root-cause assessment and re-plan; resuming needs the
owner's approval (review.md "Two-cycle limit"); there is no third
cycle (see
[references/review.md](references/review.md) "Two-cycle limit").

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

**Token budget comes first.** Concurrency is capped by cost, not only by
dependencies:

- **Model.** Set `model` on every subagent call:
  - `haiku` for lookups, survey sweeps, status checks and screenshot capture;
  - `sonnet` for building and testing;
  - `opus` for the one primary review (code review and the UI-parity grade
    together) and for designing money, auth or security logic. A Sonnet primary
    reviewer missed design and validation defects that a later Opus pass caught
    (StoreCraft SCRUM-140/96, 2026-11-05); one strong review costs less than a
    cheap one plus a fix ticket on merged code;
  - `fable` for the fresh second-opinion session when Codex is unavailable
    ([references/cross-model.md](references/cross-model.md)).

  Never let a subagent inherit the main model by default.
- **Concurrency.** Run at most 2–3 agents at once.
- **Survey and planning.** Use one survey agent. The reciprocal Planning Debate
  is the default for every implementation plan, STANDARD and ELEVATED alike;
  risk classification alone never skips it. `SKIPPED` needs an explicit owner
  exception frozen in the plan ([references/cross-model.md](references/cross-model.md)
  "PLAN debate"). The REVIEW second opinion is never skipped (see REVIEW).
- **Owner budget.** A human request to save tokens overrides this skill's
  parallelism and redundancy defaults.
- **Fresh orchestrator per ticket or wave.** Start each ticket or wave in a
  fresh session and hand over through the plan file and its RUN-STATE, which
  hold the state. A wave the human hands over together runs in one session,
  in parallel or stacked as the work allows; never refuse or split a requested
  wave citing this rule. Compact between tickets of a wave when the context
  has grown. What to avoid is unrelated work (other waves, skill changes,
  deploys, long side discussions) in the same orchestrator session: cache
  reads of the growing context dominate cost.
- **Orchestrator tier.** Mechanical orchestration (dispatching, logging, gates,
  git, tracker) runs on the economy or balanced tier (for example Sonnet as the
  session model). Planning, review and reconciliation run as `strong` (Opus)
  subagents.
- **Ship threshold.** The plan records up front which residual findings ship
  with a follow-up ticket instead of another round. A residual is a finding this
  execution can no longer fix: one the confirmation reports, or one outside the
  Design Contract. An in-scope finding found while the repair batch is unspent is
  always `fix`. Default: display-only stale-state, cosmetic or test-hygiene issues
  of medium severity or lower, with server data correct, ship with a recorded
  follow-up tracker item; anything touching data integrity, security, tenancy or
  money blocks. Reconciliation applies the recorded threshold without asking the
  human.
- **Concurrency routing.** A node that changes client or server async state
  ordering (state machines, optimistic concurrency or CAS, request ordering,
  client-side async state with races) carries the `concurrency` risk label and
  routes `strong`. Its repair gets the second opinion (Codex, else Fable) before
  the primary confirmation, not after it; it returns `PASS` or `FAIL`. Record it as
  the confirmation's `second_opinion`: `gate review` requires it when the repair
  overlaps a `concurrency`- or `security`-labelled node, and counts it whenever supplied.
- **Repair briefs.** Dispatch repairs as phase `REPAIR`. A repair worker must
  (a) verify assumptions about inherited or global styles by measuring, not
  reading; (b) never override a shared component's internals (no `::ng-deep` or
  negative-margin compensation): accept the shared value and record it; (c)
  prefer the simplest design that removes the race over adding coordination
  machinery; (d) record RED evidence per spec (`redSpecs` and `redEvidence` in
  the dispatch).

**Keep review cheap.** These rules apply to every ticket, and to multi-ticket
waves especially:

- **One reviewer.** When REVIEW does not partition a material full-stack diff,
  one agent does the code review and the UI-parity grade together, and writes
  the parity artifact. Do not run a separate parity grader as well. When REVIEW
  partitions frontend, backend and shared-contract coverage, keep those
  partitions; the frontend partition owns the parity grade and artifact.
- **Minor findings** go into the one repair batch and never become a question
  to the human. Every repair, minor included, is covered by the primary
  reviewer's targeted confirmation before SHIP; keep that confirmation scoped to
  the repaired findings rather than adding a round per finding. For UI repairs
  it receives only the captures of the screens the repair changed, not the full set.
- **Rebases.** A rebase onto a merged sibling that applies cleanly reruns the
  automated gates only. It never triggers a full new review. Re-check lines
  whose logic changed, and when the rebase delta changes a shared dependency
  (a helper, type, contract or schema the ticket calls), run a targeted review
  of the ticket's call sites of that dependency.
- **Don't gate on merge order.** Review each ticket as soon as its own code is
  final; a sibling's merge is not a reason to wait. A ticket built against
  stand-ins for unmerged sibling code gets its stand-in swap re-checked, not a
  second full review.
- **Batch siblings that are still waiting.** When two or more wave tickets
  are all unmerged, are waiting on the same base, and touch shared files
  (registration files, migrations, grants lists), stack them on one branch.
  Rebase once, run the gates once, do one review, and open one PR that
  closes every ticket in the stack. Each ticket keeps its own plan and, when
  UI is in scope for it, its own UI parity artifact. SHIP follows the
  multi-ticket contract in [references/ship.md](references/ship.md).
- **Evidence.** Screenshots cover owned screens at two widths in the primary
  language, plus one shot in a second language when the project ships one. Add
  the full theme and language matrix only when the ticket changes theme or
  i18n.

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

This list is the single owner of the stop points, by category: a stop named in a
reference (a gate or engine refusal, an owner-authority event) belongs to one of
these categories and still stops. Use **WAIT_FOR_USER** only for:

- **plan approval and material scope change:** the one native plan approval, a
  Design Contract expansion, or changed scope;
- **security or assurance exceptions:** an explicit [NN] waiver, an applicable
  security check in plan section 3b whose status is anything other than
  `verified` or `not applicable` at release, no safe local environment for
  required attacks, enforceable primary-review deadlines missing without an
  explicit advisory-only exception, a fallback to the manual flow after plan
  approval on an ELEVATED or security-sensitive run, a degraded harness at SHIP on an ELEVATED or
  security-sensitive run ([references/ship.md](references/ship.md)), an
  `ADD_CONTROLS` reassessment awaiting the owner's `SECURITY_ADDENDUM`, or a
  security-plan refusal of `plan_block_missing` or `plan_block_invalid`
  ([references/security-risk.md](references/security-risk.md));
- **engine and gate safety refusals:** a nonzero `ship-ready-check` (a gate
  failure, never relabelled as harness degradation), a REPAIR the ledger does not
  authorize, an engine judgment point whose message names the user (the others
  return to the orchestrator and are resolved in scope), or an unresolved
  `strong` model ([references/execution-harness.md](references/execution-harness.md));
- **destructive or shared-state actions:** squashing, resetting or deleting work
  you did not create (unknown WIP history), a force-push, deleting a remote
  branch, changing shared staging or a shared database, or a production-changing
  operation. Never force-push without explicit owner authority;
- **unresolved blockers after bounded recovery:** a required native host mode
  transition that has no agent-callable control, no independent primary
  reviewer, no usable second opinion from Codex or Fable, a PLAN debate
  that neither Codex nor Fable could hold (unless the owner approved an exception), an
  uncommitted or missing UI design reference, or a refusal of a missing or
  invalid security catalog;
- **explicit owner authority:** missing acceptance criteria or unresolved
  product behavior, a live blocker or ownership conflict (including another
  actor changing the worktree or a base move that overlaps owned paths), an
  unproven subscription-billing route, or credentials, permissions and external
  authority only the user can provide.

**When the engine refuses a step**, read the refusal and the code, then decide
whether the cause is the work, the run data or the gate. Fix the work or the run
data inside the approved plan and retry, at most 2 re-issues of the same refusal
for the same candidate. Never bypass or waive a gate. STOP and return to the
owner for an owner-reserved class (security, approval, ownership, spent budget,
RETRY authority), for any category listed above, when the cause is the gate
itself, or when the same problem repeats.

Everything else inside the approved scope takes the recommended default and is
recorded: for example, a fixable input refusal is corrected and rerun, a Codex
outage switches to Fable, and on a STANDARD run a degraded harness is recorded
with SHIP's manual confirmations in the SHIP_READY event and the PR body.

Use **FAIL** for:

- a PROVE third repair batch would be required;
- REVIEW confirmation fails or requests another candidate change (a residual
  within the plan's recorded ship threshold is a follow-up, not a failure);
- a reviewer result overflows with blockers or majors;
- candidate identity changes unexpectedly during REVIEW or before commit;
- deterministic CI fails after the reviewed commit;
- an unfixable correctness or security defect remains inside the approved scope.

All other in-scope work is **CONTINUE** or **AUTO_FIX**.

When yielding, preserve the branch and artifacts. State the phase, branch, what
exists, what remains, and exactly one user action needed. On **FAIL**, also run
the run-scoped teardown that SHIP would have run: `usage.mjs summary` and
`docker-lifecycle.mjs cleanup <owner> <run-id>` (dry run, then `--apply`), so
no labelled container outlives the run. WAIT_FOR_USER keeps containers for the
resume. Never make a progress
message look like completion.

## Resume

- Approved plan, no review result: recheck ticket ownership and resume the phase
  that stopped. Do not repeat the planning debate. When an engine state file
  exists, run `run-engine.mjs resume`: it reconciles attempts, staleness and
  pending events, and never starts a second writer.
- Repeated failure: when a finding or failure repeats, do not keep patching.
  Determine whether the cause is the plan, the implementation, the test or
  validation mechanism, the review finding itself, or the technical approach.
  Challenge a wrong finding with evidence (`reject — factually wrong`) and
  reconsider the approach. A revised plan goes back through the one native
  approval (changed plan, below); a change beyond the approved scope needs the
  owner. This adds no repair batch or review round.
- Failed REVIEW: preserve its event. A user-authorized retry reuses the approved
  plan when scope is unchanged, reruns affected PROVE evidence, and starts one new
  bounded REVIEW execution with a new `review_execution` ID and predecessor under
  the same workflow run. The ID itself never authorizes retry. It does not replay
  UNDERSTAND or PLAN.
- REVIEW PASS, SHIP incomplete: verify the same candidate ID and resume only the
  missing idempotent external operation. Never rerun REVIEW.
- Changed scope, Design Contract or approved plan: return to human approval.
  On Claude that means re-entering Plan Mode (`EnterPlanMode`), updating the plan
  file and presenting the revised plan with `ExitPlanMode`; on Codex, the host's
  native plan handoff. A chat reply, an `AskUserQuestion` answer or the gap
  question's answer is never that approval.
- Approved plan that fails the Factory's own prerequisites (an internal defect,
  such as a missing security-plan block) and `init` has not run: this bullet takes
  precedence over the one above. Re-enter Plan Mode (on Codex, the host's native
  plan handoff), fix only the defective section, re-present with `ExitPlanMode`
  (native approval, never typed; accepting it records the new START, which the
  orchestrator then appends) and record the evidence in the plan's RUN-STATE.
  Renewed approval of the substance is needed only if the pairs, DAG, surfaces or
  review profile change; even a deterministic completion goes through
  `ExitPlanMode`, and derived sections are never auto-approved. After `init`, any
  narrative change needs a new approved START/run (the engine refuses
  `approval_mismatch`; [execution-harness.md](references/execution-harness.md)),
  so the bullet above applies.
- Existing attack or parity evidence may be reused only when its inputs and
  candidate paths are unchanged; otherwise rerun the affected proof, not the
  entire workflow.

Never reset, stash, delete the branch or create WIP commits to manufacture a clean
resume.

## Scope boundary

This skill orchestrates; companion skills own their rule catalogues and detailed
methods. Repository instructions outrank this skill. Read both AGENTS.md and
CLAUDE.md when present and follow pointers rather than duplicating them.

**Close gaps in the same run, don't defer them by default.** A residual within
the plan's recorded ship threshold is not a gap question: it ships with a
recorded follow-up tracker item (REVIEW, Ship threshold). When PLAN, PROVE or
REVIEW confirms any other real gap outside the Design Contract, closing it is a
material scope change: ask the user once, as soon as it is confirmed. Batch every
open gap into one `WAIT_FOR_USER` question, and offer these options, recommending
the first:

1. **Fold it into this ticket.** This is a Design Contract expansion and returns
   to human approval through `ExitPlanMode` as the Resume rules require; the
   user's choice of this option is routing, not the approval. After approval, route the gap
   by the phase that found it:
   - **Before REVIEW** (PLAN, BUILD or PROVE): it returns to the matching
     implementation and proof work like any other contract path.
   - **During REVIEW**: its disposition is `fix`, and it joins the unspent repair
     batch, with the same proof and confirmation coverage as the rest.
   - **Batch already spent, or found by the confirmation**: the execution keeps
     its terminal FAIL. The gap ships only through an explicitly authorized retry
     (Resume) or as a queued ticket.

   Folding a gap in never opens an extra repair batch.
2. **Queue it as its own ticket in this run.** Open the tracker item now and add
   it to an explicit run queue. Each queued ticket is a separate, complete
   workflow: its own UNDERSTAND, plan approval, branch, candidate, review
   execution and repair limits. When the current ticket ships, report its own
   COMPLETE, then start the next queued ticket. The run is finished only when
   every queued ticket has shipped or the user explicitly defers it.
3. **Defer.** Open a tracker item outside this run.

Never file a follow-up silently. Do not expand the Design Contract without that
approval. **A defect
inside a Design Contract path is never a follow-up while the repair batch is
unspent**: fix it before the freeze (REVIEW's repair batch fixes the whole defect
class, not the cited line). The COMPLETE report carries no untracked
"follow-ups" for the user to pick up: it links each follow-up tracker item the
ship threshold opened; if an in-scope residue is found after merge, ship the fix,
then report it.

The user merges the PR and runs any requested context compaction; this skill
does neither. The one exception is merging, when the owner opted in to
auto-merge at the start (see PLAN): then merge only after every review and CI
gate is green. Deploy is never implied.
