# PLAN — the template, the metadata, and the Design Contract

Loaded when the PLAN phase starts. The debate and host routing live in
[cross-model.md](cross-model.md).

Planning is strong-model work: this is where deciding *what to build and how to
sequence it* actually happens. The plan is also the handoff that makes model
tiering real — strong plans, medium builds from the plan. Review passes are
excluded from tiering; they run at constant effort.

## Native Plan Mode is the mechanical boundary

Select the mode mechanism by host; missing Claude tools do not mean Codex lacks
Plan Mode.

### Codex

Read the host-provided collaboration mode. If it is Plan, stay there throughout
research and the cross-model debate. If interactive Codex is in Default mode,
use an exposed native mode-transition tool if one exists. Otherwise stop before
PLAN research with `WAIT_FOR_USER` and one concrete instruction: “Run `/plan` in
this conversation, then resume this ticket.” Preserve completed UNDERSTAND work;
do not create the pending plan artifact as a substitute for entering the mode.
This is a host-control handoff, not plan approval. Do not run `/plan` in a shell,
invent `EnterPlanMode`, or claim that prose, a task checklist, or a read-only
subprocess changes the parent session's mode.

The [Codex CLI documentation](https://developers.openai.com/codex/cli/slash-commands)
documents `/plan` as a client command that is unavailable while a turn is running.
For a fresh CLI run, users can submit `/plan Use $ship-ticket for <TICKET>`.
For another Codex client, use its actual Plan control and verify the host's mode
instructions; do not assume a keyboard shortcut or an agent-callable API exists.

Present the reconciled plan using the output format prescribed by Codex's active
Plan Mode instructions (including `<proposed_plan>` when required), so the client
can offer its native implementation handoff. Human approval is consumed once,
but approval does not override host mode restrictions: begin BUILD only after the
host leaves Plan Mode. If the user approved while the host still reports Plan,
request only the mode transition, never another approval or “go”. Resume the
approved plan immediately once the host permits implementation.

### Claude

When `EnterPlanMode` and `ExitPlanMode` are available, use them. After the
predeclared PLAN timing markers, invoke `EnterPlanMode` before PLAN research or
critique unless the session is already in that mode. The PLAN phase name, a
read-only promise, and a model debate are not replacements for the host
permission mode: Plan Mode mechanically restricts Claude to read-only
exploration.

Remain in Plan Mode while drafting and throughout the host/counterpart debate.
Reconcile its result there, then invoke `ExitPlanMode` with the final plan.
That tool presents the approval surface and exits only through the host's approval
flow. Do not emit a separate approval message and end the turn before calling it.
The pending tool approval is the PLAN phase's `WAIT_FOR_USER` state.

Approval is edge-triggered and consumed once. An approved `ExitPlanMode` result
immediately authorizes the already presented plan: close PLAN telemetry, create
the branch, persist the approved plan and continue BUILD. Do not report that the
plan is approved and then request “go”, “continue”, “confirm”, or any equivalent
second signal. For the headless fallback, one explicit user approval of the
reconciled plan is likewise sufficient; a product-answer or clarification given
before the complete plan was presented is not plan approval.

### Genuinely headless fallback

Use this only when the carrier has no native interactive planning surface (for
example, a non-interactive execution), or the user explicitly authorizes plain
approval instead. An interactive Codex session without Claude's tool names does
not qualify. If native mode was explicitly requested and is genuinely unsupported,
report that limitation and ask for a supported host or explicit fallback choice.
Otherwise use the spine's headless fallback:
keep research read-only, run the bounded debate, create the ticket branch before saving
the pending artifact, and request human approval without implementing. Record
`native_plan_mode: unavailable` in the plan metadata.

## The template

Use it exactly — same headings, same order, so every plan reads the same way.

```markdown
# Plan — <TICKET>: <ticket title>

<!-- the YAML header above this body carries:
     run_id: <opaque ID created when workflow timing began>
     timing_telemetry: active|degraded
     native_plan_mode: active|already_active|unavailable
     plan_mode_carrier: codex|claude|headless
     host_agent: claude|codex|other|unknown
     counterpart_agent: codex|claude|other|unavailable
     plan_debate: {max_calls: 3, total_timeout: 20m, status: CONVERGED|UNRESOLVED|DEGRADED}
     worker_width: <available concurrent workers>
     parallelism_degradations: []
     approval_status: pending|approved   a human approval flips this, and only this
     design_ref: <SHA>                   the pin
     ui_required: <bool>                 contract owns a screen OR diff touches the view layer
     review_profile: STANDARD|ELEVATED
     review_profile_reasons: [<evidence-backed trigger>]
     review_timeouts: {primary: 12m, optional: 10m, confirmation: 6m}
     owned_screens:                      one entry per screen:
       - impl: <path>
         reference: <path or null>
         # when reference is null, also:
         #   reference_search: {at_sha, locations, method, result}
         #   carve_out_approved_by: <a named human>
         #   carve_out_date: <YYYY-MM-DD>  -->

**Shape:** <FE / BE / full-stack> · security-sensitive: <yes/no> · review:
<STANDARD/ELEVATED>
<Security-sensitive selects ELEVATED and requires explicit attack and security
outcomes. It does not change attack-class applicability.>

## 1. What & why (read this first)
<2–4 plain sentences: what the user gets when this is done, and the approach in
one line. No jargon — write it for the person approving, not for the builder.>

## 2. Integration contract and execution DAG

### Integration contract
<For full-stack work or any shared API/event/schema. Otherwise: NOT_TRIGGERED —
no producer/consumer boundary changes.>

| Field | Approved value |
|---|---|
| contract ID | <stable ticket-scoped identifier> |
| source of truth | <existing/generated artifact path, or plan-bound shape until materialized> |
| approved shape binding | <approved-plan digest; materialized artifact digest is recorded after approval> |
| operations | <method + path, event identity, RPC, or equivalent> |
| request | <fields, types, requiredness, nullability and validation> |
| success response | <status/event and fields> |
| error model | <statuses/codes and payload shape> |
| access rules | <authentication, authorization and tenancy behavior> |
| side effects | <idempotency, ordering, pagination/versioning where applicable> |
| client mechanism | <generated client/shared DTO/temporary adapter and deletion point> |
| consumer conformance | <command/fixture/mock proving frontend expectations> |
| provider conformance | <command/test proving backend implementation> |
| frontend compatibility | ACCEPTED — <path-backed evidence> |
| backend compatibility | ACCEPTED — <path-backed evidence> |

### Execution DAG
| ID | Owner | Step (plain words) | Files touched | Depends on | Exclusive resources |
|---|---|---|---|---|---|
| contract | orchestrator | Materialize the approved contract artifact | <real path> | — | generator outputs |
| backend | backend worker | Build provider and provider tests | <real paths> | contract | <database/none> |
| frontend | frontend worker | Build consumer and consumer tests | <real paths> | contract | <output dir/none> |
| integration | orchestrator | Join and verify the real integration | <real paths> | backend, frontend | local app + datastore |

## 3. Risks & unknowns
| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| <spec doesn't say what happens on empty results> | blocks the empty state | ask user / assume Y and flag it |
<or: "None found — checked <what you checked>.">

## 4. How I'll prove it works
- <one bullet per build step: the test or check that shows it's done>
- <security-sensitive: the failing test that comes FIRST>
- <tests assert behavior, not implementation>

## 5. Not in this ticket
- <explicitly out of scope>

## 6. Rejected alternative
<one line: the other approach considered, and why not>

## 7. Cross-model planning debate
**Participants:** <host identity> ↔ <counterpart identity, CLI version, session ID>
**Result:** <CONVERGED / UNRESOLVED / DEGRADED and why>
**Draft:** <final version; last version actually checked by counterpart>
**Timing:** <start/end UTC, calls attempted, responses received, total budget>

| Finding ID / severity | Host response and evidence | Counterpart response | Final disposition |
|---|---|---|---|
| <P1 / major> | <changed design or evidence-backed challenge> | <conceded / defended, evidence> | <resolved / unresolved> |

**Outstanding decisions:** <remaining positions, recommendation and human choice
needed; or none>. Model agreement is advice, not approval.

## 8. Proof and review routing
| Work | Scope for this ticket | Execution |
|---|---|---|
| parity | <reference-backed screen paths, or not triggered> | primary workflow's frontend partition performs one complete comparison; a repair gets only a targeted affected-slice confirmation |
| attack inventory + design | <trust boundaries, or not triggered> | inventory may fan out; live attacks stay serial per shared environment, while already-isolated environments may overlap |
| rule coverage | <frontend/backend/shared families and specialist selected> | one primary workflow; material full-stack coverage partitions by ownership and joins at the contract seam |
| optional second opinion | <profile reason or not triggered> | ELEVATED only, concurrent with the primary workflow |

<!-- RUN-STATE:BEGIN -->
<!-- Append one compact JSON object per execution event; never edit or reorder
     an existing entry. The event vocabulary is defined in ship.md. -->
<!-- After approval, append START with the workflow run_id and
     approved_plan_digest. Every later event carries the same run_id. -->
<!-- RUN-STATE:END -->
```

When the human approves an execution, append `START` before another event using
the run ID already created by workflow telemetry. A later execution of the same
ticket gets a new `run_id`; it never edits or clears prior entries. Approval
without the matching start event is not executable.

## Contract convergence before debate

For a full-stack boundary, draft one Integration Contract and dispatch two
read-only checks concurrently while native Plan Mode is active:

- the **frontend consumer check** traces the screens/services that consume the
  shape and returns `ACCEPTED` or `CHANGE_REQUESTED` with path-backed evidence;
- the **backend provider check** traces the route/service/data constraints that
  produce the shape and returns the same bounded result.

They inspect the same draft; neither authors a competing contract and neither is
a human approver. Reconcile evidence-backed requests once and recheck only a side
whose contract surface changed. If the two sides still cannot accept one shape,
record the disagreement in Risks and use `WAIT_FOR_USER` for the missing product
decision. That answer is clarification, not approval of an unfinished plan.
After resolving it, send the
semantically complete plan to the selected counterpart for the broader debate.
If that debate changes the contract, refresh affected compatibility checks before
calling the revised plan converged; the debate budget does not reset.

The approved plan digest binds the plan-form contract. After approval, the first
candidate-writing node materializes or generates its source-of-truth artifact
and records that artifact's digest. Every producer and consumer worker receives
the same contract ID and digest.

## The execution DAG

`Depends on` is the scheduler; table order is presentation only. At any moment,
all nodes whose dependencies are complete form the ready set. Dispatch every
material ready node concurrently when its file ownership and exclusive resources
do not conflict. Do not hold a ready node for another node it does not depend on.

Every file has one owner. Shared schema/generator outputs, lockfiles, route
registries and integration seams belong to the orchestrator unless the DAG names
one dedicated owner. A worker that discovers an unlisted dependency reports it;
it does not widen its ownership. If concurrency is unavailable, preserve the DAG,
run ready nodes serially and record the performance degradation and reason.

### Full-stack: the frontend does not wait for the backend

What the frontend depends on is the **API contract — the request and response
shape — not the backend's implementation of it.** Pin the contract as its own
first node; frontend and backend then become ready together:

| ID | Owner | Step | Depends on | Exclusive resources |
|---|---|---|---|---|
| contract | orchestrator | Produce the artifact both sides compile or test against | — | generator outputs |
| backend | backend worker | Build the endpoint: handler, service, data access and provider tests | contract | backend-owned resources |
| frontend | frontend worker | Build the screen, client/service and consumer tests | contract | frontend-owned resources |
| integration | orchestrator | Verify contract digests, wire the real endpoint and test end to end | backend, frontend | local app + datastore |

**Step 1 must name an artifact, not an agreement.** "We agreed the shape" is not
something a compiler accepts:

- the repo **generates its client** from a committed schema (`openapi.json`, a
  `.proto`, a GraphQL SDL) → step 1 is *generate and commit that schema*;
- there is a **shared types package or DTO file** both sides import → that file;
- neither → the plan-bound shape plus a consumer fixture and provider conformance
  test; the frontend may hand-write a temporary adapter only when the repo permits
  it, and deletes it at the integration node.

Check for a generator before assuming the third case: a repo that generates *and*
forbids hand-written shapes — a conformance test, a lint rule — will reject the
temporary interface.

**Even then, usually only part of the frontend waits, and which part is a question
about this repo, not a category.** Blocking the whole frontend on a generated
client blocks more than the generator gates; assuming components and tests are
independent blocks less, because many codebases import the generated DTOs
directly. **Derive the split from the imports**: trace what actually consumes the
generated types and put only those files in the waiting group. Anything provably
clear of them starts immediately. If a file's dependency is unclear, it waits.

At the integration join, verify the materialized contract digest, generated
outputs, changed-path ownership, provider conformance and consumer conformance
before exercising the real endpoint. If the shape is *not* settled — the ticket
is vague, or it depends on a decision nobody has made — that is a *Risks* row or
`WAIT_FOR_USER`, not a parallelism problem. Building both halves against different
guesses is worse than serialising.

## Formatting rules that keep it readable

- **Section 1 is the approval surface.** A reader should be able to approve from
  sections 1–3, plus any *rejected blocker* row in section 7, in under a minute.
- **Plain words in the Step column** — "Build the login form", not "Instantiate
  the auth presentational component per NG-ARCH-03". Rule IDs belong in the
  contract, not here.
- **Real paths from this repo**, derived from the detected layout.
- **Tables, not paragraphs**, for sequence and risks — they make an empty risks
  table impossible to fake ("None found" must name what was checked).
- **Short beats complete.** A plan nobody reads gates nothing. A big ticket gets
  more rows, not more prose.

## The Design Contract

The contract governs **which files may be written**, so it must exist before any
code. It is distinct from the Integration Contract: the Integration Contract
governs behavior exchanged across a producer/consumer seam; the Design Contract
governs file ownership and rules. Branch first, then:

1. **Confirm the routing** still selects the same family member now the plan is
   final.
2. **Invoke that skill by name** — load it, do not recall it.
3. **Run its Design Contract gate**, deriving the file list from the approved
   execution DAG.

### When the routed skill has no contract gate of its own

`angular-code-quality` and `backend-code-quality` each define one. **The
`code-quality` hub does not** — so every stack that routes to the hub (React, Vue,
Svelte, Go, Rust, Java, C#) uses the workflow-owned shape below. This is not a
degradation; it is the contract for those stacks.

```
file path | why it exists (the build-sequence step) | its role in this repo's
own architecture | the rules in force for that role
```

Roles come from the repo's actual layout, not from a framework this skill
prefers. The rules in force are every `[NN]` rule, plus the hub's universal core,
plus whatever the repo's own conventions document requires.

### Full-stack: one contract, two specialists

A full-stack ticket invokes two specialists and produces **one** contract and
**one** rule pass — never two uncoordinated halves. Their schemas differ, so
compose rather than concatenate: **one table, one row per file, each row carrying
the role vocabulary of the side that owns it.** A file appears exactly once. Two
tables mean two half-reviews, and a rule that fell between them is invisible.

Invoke the frontend and backend specialists concurrently as read-only row
proposals against the approved execution DAG. The orchestrator owns shared seam
files, resolves duplicate ownership, and composes their proposals into the one
Design Contract before any implementation worker starts. A specialist may flag a
missing path; it may not expand the approved plan or write candidate files.

### The parity metadata

Record `ui_required` and `owned_screens` in the plan's header. `ui_required` is
`contract-owns-a-screen OR diff-touches-the-view-layer`; the first half is known
now, the second is recomputed at the freeze because it cannot be known before
implementation.

**`reference: null` is a human decision made at plan time, never a gate-time
convenience.** It needs the `reference_search` block — where you looked at the
pinned SHA, how, and what you found, so "no reference exists" is reproducible
rather than asserted — and a **named human approver** recorded in the plan the
user approved. CI validates the approver, the date and the search evidence, and
fails closed without them.

**Missing, unparseable or internally inconsistent metadata fails closed** to
`ui_required: true` with no artifact, which is a FAIL.

## The plan constrains the contract

A file the contract needs but the plan lacks means the plan was wrong. That is a
**material divergence**: it goes back through plan mode for re-approval and
updates the artifact. Do not silently build past the plan the user approved.
