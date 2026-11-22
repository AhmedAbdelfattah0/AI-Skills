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

In an interactive session the orchestrator owns the Plan Mode lifecycle.
`EnterPlanMode` and `ExitPlanMode` are deferred tools in the main session, so
the first action of PLAN is to load them, when they are not already callable,
with ToolSearch query `select:EnterPlanMode,ExitPlanMode`. Then write the
predeclared PLAN timing markers and invoke `EnterPlanMode` before any PLAN
research or critique, unless the session is already in that mode. The tools are
unavailable only when that query returns neither tool (a headless carrier) or
the user explicitly opted out of Plan Mode; a tool that is merely not loaded yet
is not unavailable. The PLAN phase name, a read-only promise, and a model debate
are not replacements for the host permission mode: Plan Mode mechanically
restricts Claude to read-only exploration.

Research subagents (Plan, Explore, Opus planning or architecture agents) work
*inside* the orchestrator's Plan Mode: brief them read-only, tell them never to
call `EnterPlanMode` or `ExitPlanMode`, and take back their findings. They never
replace Plan Mode and never present the plan. The orchestrator writes the
complete plan to the native plan file and presents it with `ExitPlanMode`. If
you notice you drafted without entering Plan Mode, enter it now, present the plan
through `ExitPlanMode`, and record the miss in the run state.

**Only `ExitPlanMode` approves.** Chat text, an `AskUserQuestion` answer and a
typed "approve" are not plan approval; never ask the user to type one.
`AskUserQuestion` is allowed only to resolve planning questions before
`ExitPlanMode`, and its answers are clarification. The headless fallback below
is the only exception.

**The plan is complete before it is presented.** Every template section is
filled with repository facts: real paths, the DAG, the risks, section 3b and the
routing. No stub, "TBD", "to be decided" or placeholder remains; an open product
question is either resolved first or stated in Outstanding decisions with a
recommendation.

**Waves.** For several tickets handed over together, enter Plan Mode once,
draft every ticket's plan there (one section per ticket, each with its own
scope, contract and risks), and present them in a single `ExitPlanMode` call.
On approval, persist each ticket's plan to its own `.specs/plans/<KEY>.md` with
its own START event and digest. Each ticket's debate runs inside the same Plan Mode
before that one `ExitPlanMode`. A ticket whose plan cannot be completed yet (an
unmerged dependency) is left out of this approval and becomes its own later wave;
never start BUILD on a wave ticket whose plan was not in an approved
`ExitPlanMode`.

Remain in Plan Mode while drafting and throughout the host/counterpart debate.
Reconcile its result there. For a policy-2 plan with an execution DAG, run
`scripts/run-engine.mjs preflight --repo <dir> --ticket <key> --dag <file> --plan <draft>`
on the final draft. It runs init's plan checks with no START and no write. Fix
every refusal before you invoke `ExitPlanMode` with the final plan.
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

Use this only when the carrier has no native interactive planning surface (the
ToolSearch query returned neither tool, for example a non-interactive
execution), or the user explicitly opted out of Plan Mode. An interactive Codex session without Claude's tool names does
not qualify. If native mode was explicitly requested and is genuinely unsupported,
report that limitation and ask for a supported host or explicit fallback choice.
Otherwise use the spine's headless fallback:
keep research read-only, run the Planning Debate, create the
ticket branch before saving the pending artifact, and request human approval
without implementing. Record `native_plan_mode: unavailable` and its reason in
the plan metadata.

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
     counterpart_agent: codex|claude|fable|other|unavailable
     debate_policy: 2                    every new implementation plan (START refuses a new plan without it)
     plan_debate: {outcome: CONVERGED|UNRESOLVED|LIMIT_REACHED|SKIPPED (SKIPPED only with an owner exception in section 7), carrier: {agent, kind, degraded}, rounds, calls, minutes, budget: {max_rounds: null, max_minutes: null}}   null = no cap
     codex_route: {dispatch, fresh_result, resume, cancellation, coverage}   PLAN carrier probe: each pass|fail with class permission_denied|auth|provider|relay
     worker_width: <available concurrent workers>
     parallelism_degradations: []
     approval_status: pending|approved   a human approval flips this, and only this
     design_ref: <SHA>                   the pin
     ui_required: <bool>                 contract owns a screen OR diff touches the view layer
     review_profile: STANDARD|ELEVATED
     review_profile_reasons: [<evidence-backed trigger>]
     risk_floor: <the `risk-floor.mjs check` record_line (planned paths), or `not declared` when the base has no `.ship-ticket/risk-paths.json` and the plan does not opt into test kinds>
     risk_reassess: <the `reassess` record_line (actual changed paths), recorded before release; omitted when risk_floor is `not declared`>
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
<The structural path floor (`risk-floor.mjs`, project paths from `.ship-ticket/risk-paths.json` at base) and your semantic assessment both apply: the review profile is the higher of the two and of the recorded claim. A floor of ELEVATED requires review ELEVATED; the §7 Planning Debate runs for every implementation plan, whatever the review profile. A floor only raises, and an unmatched path is not evidence of low risk. Git-ignored untracked files are outside release scope (a force-added one appears in the index/HEAD diffs); release-gating `reassess` should use `--head <final commit sha>`, since WORKTREE is a snapshot. Advisory, not enforced until the driver wiring (S-23/S-24). Deferred: a plan-record check (exactly one strict floor-record header line, final >= floor and claim, review_profile >= final, debate-status allowlist, duplicate keys fail) and a measured text-matching corpus experiment (findings of the dropped keyword floor: lowerCamel, digit-adjacent, single-character separators, encodings, inflections).>
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

**Decomposition:** <ONE unit (no unit fields) / SPLIT into N units: names> ·
rationale: <independent boundaries · shared contracts · acceptance criteria per
unit · file ownership · expected size and risk · overhead vs value>. <If split:
`config.acceptanceIds`, `config.unitRecheckCeiling` and its reasoning, and whether
`config.unitReview` is on.>

## 3. Risks & unknowns
| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| <spec doesn't say what happens on empty results> | blocks the empty state | ask user / assume Y and flag it |
<or: "None found — checked <what you checked>.">

### 3a. Security risk assessment
<Required when ELEVATED, security-sensitive, `riskLabels` non-empty or a vapt trigger fires; paste `security-plan.mjs select` output (`rows_md`). Otherwise paste the three-line compact form `select` prints for an empty selection: the line "No security-relevant surface: <evidence>", the `security-pairs` line and the machine block. See [security-risk.md](security-risk.md).>

Baseline: catalog v<N> `<catalog digest>`, policy 2, <N> controls / <M> pairs, unknown facts: <list or none>.

| Risk (control) | Why it applies | Pairs (boundary) | Verification | Success evidence | Blocks |
|---|---|---|---|---|---|
| <VAPT-API-01> | <cited fact> | <boundary id> | <named spec> | <spec passes, RED seen first> | <merge / none> |

Excluded: <control: reason from the catalog, or none>.

security-pairs sha256:<hex>
<!-- security-plan: {...} -->

### 3b. Impact and check applicability
<Always required. One row per component, flow or dependency the change touches. 3a's facts cite the business flows and data named here. Rules below the template.>

| Component / flow / dependency touched | Risk (technical · security · business · data-integrity · regression) | Check that covers it (test type, security control id, review skill or gate) | Runs when | Re-runs when | Status |
|---|---|---|---|---|---|
| <checkout total calculation> | <business · data-integrity: wrong charge> | <unit + `[kind:negative]` test; VAPT-ABUSE-04; primary review> | <PROVE> | <a repair touches pricing> | <planned> |
| <edge rate limit on /login> | <security: credential stuffing> | <Cloudflare rate-limiting rule, read-only API check (`cloudflare` skill)> | <external — needs: read-only Cloudflare API token scoped to the zone> | <the rule or route changes> | <unverified: no token in this run> |

Not applicable: <check>: <one-line reason>, ...

## 4. How I'll prove it works
- <one bullet per build step: the test or check that shows it's done>
- <security-sensitive: the failing test that comes FIRST>
- <tests assert behavior, not implementation>

## 5. Not in this ticket
- <explicitly out of scope>

## 6. Rejected alternative
<one line: the other approach considered, and why not>

## 7. Cross-model planning debate
<Every implementation plan; the debate rules live in cross-model.md "PLAN debate". Freeze this section before the final confirmation request.>
**Participants:** <host identity> ↔ <counterpart identity, CLI version, session ID>
**Result:** <CONVERGED / UNRESOLVED / LIMIT_REACHED / SKIPPED (only with the owner exception below) and why; a substitute carrier is stated as `carrier.degraded: true`, never as an outcome>
**Draft:** <final version; last version actually checked by counterpart>
**Timing and cost:** <start/end UTC, rounds, calls attempted, responses received, minutes, tokens when reported; budget none unless overridden> (information only)
Attestation: <debate-<ticket>-<yyyymmddThhmmZ>, predeclared; the attestation line itself lives in the RUN-STATE body>

| Finding ID / severity | Host response and evidence | Counterpart response | Final disposition |
|---|---|---|---|
| <P1 / major> | <changed design or evidence-backed challenge> | <conceded / defended, evidence> | <resolved / unresolved> |

### Debate carrier and exceptions requested
- carrier.degraded: <true|false>
- degradation acknowledgement: <none, or exactly: The owner accepts this degraded debate carrier for this ticket: it is not cross-model agreement and it resolves no finding.>
- exception: <none|SKIPPED|WAIVED>
- exception reason: <none, or the reason>
- exception acknowledgement: <none, or exactly: The owner approves skipping the Planning Debate for this ticket only. (SKIPPED) / The owner waives the listed debate findings for this ticket only. (WAIVED)>
- scope: this ticket

This is inspectable frozen content: approving the exact plan digest in `ExitPlanMode` is the owner's approval of it.

| Finding | Disposition | Resolution | Design change |
|---|---|---|---|
| <outstanding canonical ID, or LIMIT> | <accept_risk / decided / waived> | <the accepted-risk text, the actual decision, or the waiver> | <yes / no> |

**Outstanding decisions:** <remaining positions, recommendation and human choice
needed; or none>. Model agreement is advice, not approval. `decide` or `re-debate`
without the resolution is pending and blocks START.

## 8. Proof and review routing
| Work | Scope for this ticket | Execution |
|---|---|---|
| parity | <reference-backed screen paths, or not triggered> | primary workflow's frontend partition performs one complete comparison; a repair gets only a targeted affected-slice confirmation |
| attack inventory + design | <trust boundaries, or not triggered> | inventory may fan out; live attacks stay serial per shared environment, while already-isolated environments may overlap |
| rule coverage | <frontend/backend/shared families and stack references selected> | one primary workflow; material full-stack coverage partitions by ownership and joins at the contract seam |
| second opinion (mandatory) | every ticket | Codex in a fresh session when available and within quota, else a fresh Fable session (same-provider independent review); CodeRabbit optional extra coverage; concurrent with the primary workflow when resources allow |

**Ship threshold:** <which residual findings (found by the confirmation, or outside the Design Contract) ship with a recorded follow-up tracker item instead of another round. Default: display-only stale-state, cosmetic or test-hygiene issues of medium severity or lower, with server data correct, ship with a follow-up; anything touching data integrity, security, tenancy or money blocks. In-scope findings found while the repair batch is unspent are fixed. Reconciliation applies this without asking the human.>

<!-- RUN-STATE:BEGIN -->
<!-- Append one compact JSON object per execution event; never edit or reorder
     an existing entry. The event vocabulary is defined in ship.md. -->
<!-- After approval, append START with the workflow run_id,
     approved_plan_digest, approved_at (ISO-8601) and approved_by (the human
     approver, required). Every later event carries the same run_id. -->
<!-- RUN-STATE:END -->
```

When the human approves an execution, append `START` before another event using
the run ID already created by workflow telemetry. A later execution of the same
ticket gets a new `run_id`; it never edits or clears prior entries. Approval
without the matching start event is not executable.

Write the START only after the narrative is final. Compute `approved_plan_digest`
with `node scripts/brief.mjs plan-digest --plan <plan>` (it prints
`sha256:<64 hex>`: the digest of the plan with the RUN-STATE body removed), never
with `shasum` and never over the whole file. A START carries `approved_plan_digest`,
`approved_at` (not `at`) and `approved_by` (descriptive metadata only: it is presence-checked, not validated; the approval authority is native Plan Mode approval (ExitPlanMode) plus the approved-plan digest binding). Run `node scripts/brief.mjs start-check --plan <plan> --run-id <id>`
before dispatching any worker (`--run-id` is required); it refuses a malformed
RUN-STATE block, a stale or malformed digest, a missing approval time or a missing `approved_by`.
On a `debate_policy: 2` plan the START also carries `debate_attestation_sha256` (the
attestation line's hash stated at `ExitPlanMode`); pass `--repo <repo>` so start-check
verifies the retained debate bundle (`debate_attestation_missing`,
`debate_attestation_changed`, `debate_evidence_missing`, `debate_disposition_pending`,
`debate_reconfirm_required`); a new plan without `debate_policy` is `debate_policy_missing`.
Its `ok` is necessary but not sufficient: it cannot see the engine's trusted-START
rule. Never edit the narrative after START: the digest no
longer matches and the run is not executable. A CRLF plan and its LF twin have
different digests; the tool does not normalise line ends.

## Section 3b: impact and check applicability

Section 3b is the plan's applicability ledger. Name every component, user or
business flow, data set and dependency the change touches, the risk it carries,
and the check that covers it: a test type (including a required test kind), a
`vapt` control or pair from 3a, a review skill, or a gate. Section 3a stays the
catalog-bound security selection; 3b names the flows and data its facts cite and
adds the checks the catalog does not hold.

- **The plan is not complete** when an applicable check is missing from the
  table or silently skipped. Every check considered and not applicable is listed
  under `Not applicable:` with a one-line reason.
- **Never claim equivalent coverage without evidence.** A check that covers a
  row names what it runs and what it proves; "covered by review" needs the
  review item that covers it.
- **Status vocabulary:** `verified`, `partially verified`, `unverified`,
  `failed` (it ran and did not pass), `not applicable`, plus `planned` before
  PROVE runs. Update the status in RUN-STATE (`PROVE` event), never by editing
  the approved narrative. After approval a row may change to `not applicable`
  only with a recorded one-line reason.

**External checks.** Some checks need an environment the local run does not have:
Cloudflare edge configuration (WAF, bot and edge rate-limiting rules), edge TLS
and HSTS, DNS and email authentication (SPF, DKIM, DMARC), Access policies and
origin exposure, public preview URLs. Record them in 3b with `Runs when:
external — needs: <tooling and permission>`, preferring the earliest stage that
can verify them: a static review of the committed configuration
(`wrangler.toml`/`wrangler.jsonc`), `wrangler deploy --dry-run`, a staging
environment, then a read-only Cloudflare API check with a least-privilege token.
Use the existing `cloudflare`, `wrangler`, `workers-best-practices`,
`cloudflare-one` and `security-audit` skills where they apply. Run an applicable
external check automatically when its tooling and permission are available; ask
the owner only for a missing token or permission or a production-changing action,
and ask for a missing token or permission as a planning question before
`ExitPlanMode`.
A check that cannot run now is `unverified` with the reason, in its 3b row and
in the PROVE event, and is never reported as covered. A row whose "Runs when"
comes after PROVE runs before SHIP when its tooling and permission allow. At
release, an applicable security row whose status is anything other than
`verified` or `not applicable` (`planned`, `partially verified`, `unverified`, `failed`) is
a security exception: it blocks SHIP (**WAIT_FOR_USER**) unless the owner
explicitly accepts it for this candidate, recorded as the `SECURITY_WAIVER`
record [ship.md](ship.md) defines for 3b rows (`boundary: "plan-3b"`). Record
only the external checks the change touches. This is orchestrator-enforced; no
gate reads 3b yet.

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
calling the revised plan converged.

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

**Units are opt-in.** The bound engine DAG may tag nodes with `unit`, `checks`
(names of its `testCommands`) and `acceptance` (criterion ids listed in
`config.acceptanceIds`, which must then be the ticket's acceptance criteria, each
mapped to at least one node). Leave them out and the run is unchanged. When they
are present, a unit's checks must pass before another unit's nodes depending on it
start and before REVIEW; the rules are in
[units.md](units.md). Whether to
split a ticket into units is the planner's recorded judgment, approved with the plan.
Adding `config.unitReview: true` (also opt-in, and approved with the plan) makes each
unit need its own independent review before the final review
([units.md](units.md), Unit review).
New runs may set `config.auditRecord: true` to keep both reviewers' verdicts and timestamps (opt-in, off by default; see harness-internals.md).

### Decomposition: split or not

Every plan records a **split/no-split rationale** in the template's
`Decomposition` line, and the human approves it with the plan. There is no
numeric size threshold: the planner judges. Changed lines, file counts and seam
counts are reported as signals, never as triggers. Weigh, and write down:

- **Independent boundaries.** Could a unit be built, checked and reviewed without
  reading another unit's code beyond a declared contract?
- **Shared contracts.** Name each contract the units share (schema, API shape,
  event, generated client) and which unit owns it.
- **Acceptance criteria per unit.** Which criteria each unit can prove on its own;
  criteria that only hold end to end belong to the final review and an
  integration node.
- **File ownership.** Every file has one owning unit; a file several units must
  write is a reason to merge them or to give it to an orchestrator node.
- **Expected size and risk.** Rough size, risk labels, and where review effort
  would concentrate.
- **Overhead vs value.** Each unit adds checks, a unit review (two reviewers when
  risky) and ceiling spend; split only where that buys smaller, independent
  reviews.

Then decide:

- **One unit** (leave the unit fields out) for a small ticket or tightly coupled
  work where every change reads every other. The run is then exactly today's.
- **Split at contract seams and acceptance-criterion boundaries**: producer and
  consumer of an approved contract, or areas that each own their own criteria.
  Never split inside a tightly coupled module just to make units smaller.
- Units are opt-in through the DAG fields (`unit`, `checks`, `acceptance`,
  `config.acceptanceIds`, `config.unitRecheckCeiling`, `config.unitReview`);
  they are fixed at approval and never re-decomposed at run time.

When the plan chooses to split, read [units.md](units.md) before writing the DAG: it holds the `config.acceptanceIds` declaration, the `config.unitRecheckCeiling` sizing and the known over-review cost.

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

1. **Confirm the routing** still selects the same stack references now the plan
   is final.
2. **Load `code-quality` and those references** — load them, do not recall them.
3. **Run its Design Contract gate** (STEP 0B), deriving the file list from the
   approved execution DAG.

### Contract shapes

`code-quality` STEP 0B owns every shape: `stack-angular.md` (file, MVVM role),
`stack-backend.md` (unit, layer, security tier), and, for code with no stack
reference (React, Vue, Svelte, Go, Rust, Java, C#), the shape below. That last
shape is not a degradation; it is the contract for those stacks.

```
file path | why it exists (the build-sequence step) | its role in this repo's
own architecture | the rules in force for that role
```

Roles come from the repo's actual layout, not from a framework this skill
prefers. The rules in force are every `[NN]` rule, plus the universal core,
plus whatever the repo's own conventions document requires.

### Full-stack: one contract, composed coverage

A full-stack ticket composes the frontend's coverage (`stack-angular.md` only when
the frontend is Angular; otherwise the core and the no-stack-reference shape above)
with the backend's `stack-backend.md`, and produces **one** contract and
**one** rule pass — never two uncoordinated halves. Their schemas differ, so
compose rather than concatenate: **one table, one row per file, each row carrying
the role vocabulary of the side that owns it.** A file appears exactly once. Two
tables mean two half-reviews, and a rule that fell between them is invisible.

Run the frontend and backend row proposals concurrently, each read-only against
the approved execution DAG with its own coverage. The orchestrator owns
shared seam files, resolves duplicate ownership, and composes the proposals into
the one Design Contract before any implementation worker starts. A proposal may
flag a missing path; it may not expand the approved plan or write candidate files.

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

**A screen with no reference gets a sketch in the plan.** For each approved
no-reference screen, include an ASCII layout in the plan artifact and the approval
message, showing labels, columns, actions and relevant states. Explicit approval
makes it an acceptance criterion, subject to the pinned design system. Literal
reference parity remains `NOT_APPLICABLE` unless a committed reference is obtained
before implementation. An unsketched screen redesigned after review costs a full
repair cycle.

**Missing, unparseable or internally inconsistent metadata fails closed** to
`ui_required: true` with no artifact, which is a FAIL.

## The plan constrains the contract

A file the contract needs but the plan lacks means the plan was wrong. That is a
**material divergence**: it goes back through plan mode for re-approval and
updates the artifact. Do not silently build past the plan the user approved.
