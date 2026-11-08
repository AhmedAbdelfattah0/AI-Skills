# REVIEW — one independent review, one repair, one targeted confirmation

Loaded only when REVIEW starts. Counterpart selection and dispatch live in
[cross-model.md](cross-model.md); UI comparison depth lives in
[design-parity.md](design-parity.md).

The purpose of REVIEW is to catch semantic defects that deterministic PROVE
could not. It is not another build phase and it is not an audit of the workflow's
own bookkeeping.

## The bounded shape

```text
preflight     prove the candidate and required reviewers are ready
review        one independent checklist-backed review
second        one mandatory opposite-model opinion (host counterpart; CodeRabbit fallback)
clean         record PASS and continue to SHIP
findings      reconcile once, then apply at most one repair batch
confirmation  check only repaired findings and their affected closure
PASS          continue to SHIP
FAIL          end once with the exact evidence and required next decision
```

A clean standard ticket has one primary workflow: one dispatch for a small or
coupled diff, or one bounded concurrent coverage fan-out for a material full-stack
diff, run by Opus. Every ticket also gets exactly one opposite-model second
opinion, concurrently when possible. Only a
candidate repair or material cross-review disagreement creates confirmation.
There is no generic signing review after a clean result and no full review after
a repair.

## Preflight before REVIEW starts

Finish these checks before announcing REVIEW or appending its start event:

- the approved plan and Design Contract still match the intended change;
- the Integration Contract digest, generated outputs, provider conformance and
  consumer conformance pass when a producer/consumer seam changed;
- every CI-equivalent command runnable locally has passed;
- for security-sensitive work or a bug fix, a `RED` event precedes the first
  non-test write, with behavioral assertion failures (not missing-module or
  compile errors); otherwise the PROVE event declares `red: RETROACTIVE` and the
  report says so;
  When an engine state file exists, the RED event is `gate.mjs` `gateRed`
  evidence (runner-produced by the DAG-bound `config.testCommands` runner, bound to
  the spec digests and the baseline), not hand-written; unsupported runner output
  falls back to the manual event, marked degraded. The engine cannot release its RED
  barrier on a manual event, so `drive` keeps every dependent of that node blocked:
  either fix the runner format and re-run `gate red`, or continue the rest of the
  ticket in the manual workflow (record `harness degraded`, stop calling `drive`
  for it) and never present the engine's blocked state as a pass;
- test-quality, docs-accuracy, applicable static security rows and runtime attack
  work are complete or carry a named degradation;
- UI metadata and the parity artifact are complete when UI is in scope;
- formatters, generators, comments and ticket-produced docs are already current;
- one independent primary-reviewer route can enforce its deadline and cancel
  unfinished work, including all partitions;
- the review profile, time ceilings and the second-opinion route (the host's
  counterpart, else CodeRabbit) are recorded and preflighted.

An unavailable primary reviewer is `WAIT_FOR_USER` here. Do not enter REVIEW and
invalidate otherwise usable work merely to discover that required capability is
missing. The second opinion is required too: the host's counterpart first (Codex
for a Claude host, Claude for a Codex host); if it is unavailable or its usage
limit is reached, CodeRabbit on the same candidate; if neither is available,
`WAIT_FOR_USER`. Run CodeRabbit over the whole candidate, including untracked
files (`coderabbit review --agent --include-untracked`, or the CLI's equivalent
flag), and record the scope it reviewed. Missing concurrency only serializes the
two reviews; it never removes one.

A native timed wait only limits polling; it does not stop a reviewer. Verify the
carrier's actual deadline/cancellation mechanism before dispatch. Prefer a native
route with reliable enforcement; otherwise use an existing read-only delegate
relay with its watchdog and the complete coverage packet below. Do not build a
second delegation framework. If neither route is available, use `WAIT_FOR_USER`
for restored capability or an explicit advisory-only deadline exception. Record
that exception; never silently claim an advisory ceiling was enforced.

## Bind reviewers to one candidate

Compute the candidate identity with the bundled helper:

```bash
node "/absolute/path/to/ship-ticket/scripts/candidate-id.mjs" \
  --repo "/absolute/path/to/repo" \
  --base "target-base-ref" \
  --exclude ".specs/plans/TICKET-ID.md" \
  --exclude "session-log.md"
```

Replace the executable prefix and placeholder values with the detected paths,
base and ticket ID; do not run the angle-bracket notation as shell syntax.

The helper hashes the final state of every changed and untracked candidate path,
normalizes renames to delete/add entries, represents deletions explicitly and
refuses dirty submodules. The approved plan is context, not candidate content;
its digest is verified separately. The append-only execution record and session
log are excluded so recording a verdict cannot invalidate the verdict.

Allocate one prefixed opaque `review_execution` ID before dispatch and bind all
phase, reviewer, repair and confirmation events to it. Record the candidate,
configured ceilings, enforcement capability, host/counterpart and skill
revision/content hash as described in [observability.md](observability.md).
Recovery and schema correction remain in this execution and its original budget.
A user-authorized retry gets a new ID with its predecessor under the same workflow
run; a new ID is not permission to retry or reset limits.

Give every initial reviewer the same `candidate_id`, changed-path list, retrieval
recipe, ticket, acceptance criteria, approved plan, Integration Contract, Design
Contract, deterministic results and applicable parity/VAPT evidence. Candidate
files do not change while they run. If the ID changes, discard their results and
classify why:

- an expected external formatter or generator was missed → return to PROVE;
- another actor changed the worktree → `WAIT_FOR_USER`;
- the orchestrator mutated the candidate during review → `FAIL` with the paths.

When a relay replaces a native primary, preserve the whole checklist: supply the
actual diff including staged/untracked/deleted paths, repository instructions,
applicable rule catalogues, pinned UI inputs and frozen proof/security evidence.
A carrier that cannot retrieve these inputs is not a valid primary route. A
short free-form counterpart prompt is not a substitute for primary coverage.

## Select the profile

`STANDARD` applies unless one of these evidence-based triggers is present:

- auth, authorization, tenancy, billing, payments or secrets;
- a migration, schema, public API, event or shared data contract;
- a shared component or library surface with multiple consumers;
- unusually broad cross-subsystem impact;
- repository instructions or the user explicitly require a second opinion;
- preflight records a material uncertainty that the review can resolve.

Those triggers select `ELEVATED`. They change reviewer redundancy, not rule,
screen or attack applicability. Every applicable check still runs in either
profile.

| Profile | Initial semantic review |
|---|---|
| `STANDARD` | the Opus primary workflow plus the mandatory second opinion |
| `ELEVATED` | the same, with partitioned primary coverage when the diff is material and the security outcome required |

Both reviews run concurrently when possible, otherwise one after the other. A
missing or timed-out counterpart route falls back to CodeRabbit on the same candidate;
if CodeRabbit is also unavailable, `WAIT_FOR_USER`. Record which route ran
(`second_opinion: codex | claude | coderabbit`).

## The primary review workflow

The primary workflow is independent of every builder and receives no BUILD
narrative conclusions. A small or tightly coupled candidate uses one reviewer.
A material full-stack candidate may partition coverage concurrently when the
approved Integration Contract and Design Contract give exact ownership:

| Partition | Owns |
|---|---|
| frontend | frontend paths, frontend rules, tests and parity |
| backend | backend paths, backend rules, tests and security evidence |
| seam coordinator | Integration Contract, shared paths, cross-stack acceptance criteria, exclusions and final output |

This is one primary review workflow, not three opinions: candidate paths and rule
rows are assigned exactly once, while the seam coordinator checks only the shared
interactions. All partitions receive the same candidate ID and run concurrently.
Resume the seam coordinator with the two bounded partition results; it detects
coverage gaps and emits the one primary output without rereading their owned
paths. If the candidate cannot be partitioned without overlap, or the carrier
cannot run the partitions concurrently, use one reviewer; never serialize three
partition dispatches.

Whether partitioned or not, the primary workflow combines the former free-form
and rule-catalogue work:

- verify every acceptance criterion and approved scope boundary;
- inspect behavior, edge cases, errors and regression risk;
- walk every applicable specialist rule plus the separate `AI-FM` and
  `UNIVERSAL` rows;
- include `TEST` and `DOC` rows when their surfaces changed;
- for UI, perform the complete parity comparison against the pinned reference;
- for trust boundaries, review the static control trace and frozen runtime attack
  evidence without rerunning attacks;
- return an explicit `security_outcome` for a security-sensitive ticket.

Coverage is still applicability-driven. Combining the checks removes duplicate
repository reads; it does not permit a family-level PASS without per-rule
evidence.

Default ceiling: 12 minutes for the whole primary workflow, including partition
synthesis. If it expires and the carrier has a resumable
session, allow one three-minute request for the already-completed, severity-ordered
result. Do not restart the semantic read. Without a usable independent result,
record `WAIT_FOR_USER` and the missing capability.

Set the watchdog to the remaining ceiling before dispatch. Stop unfinished
analysis at expiry and verify cancellation before recovery; a background worker
must not continue a semantic read while its recovery call asks for results.
Schema-only correction also spends the remaining budget, never a fresh allowance.

The result is bounded to twelve actionable findings, blockers and majors first,
with at most three minors. More than twelve blockers/majors returns
`overflow: true` and `outcome: FAIL`; it does not spend time narrating an
unbounded catalogue.

## The mandatory opposite-model opinion

On every ticket, start Codex for a Claude host or Claude for a Codex host,
concurrently with the primary workflow in a fresh session. It is a free-form
second opinion, not another rule pass or approver. The counterpart has a
10-minute budget; the CodeRabbit fallback (used when the counterpart is
unavailable, fails, times out or is out of quota) runs after it on its own
10-minute budget. It is mandatory: when the primary finishes first, wait for it
within its budget. Follow [cross-model.md](cross-model.md) for carrier, cancellation and
fallback; do not import the PLAN debate into REVIEW.

## Output contract

The primary workflow returns the complete schema below. The second-opinion counterpart
returns identity, candidate ID, findings, overflow and an outcome; its free-form
opinion does not claim the primary workflow's checklist coverage.

```text
reviewer_identity
candidate_id
reviewed_paths[]
reasoned_exclusions[]
coverage_partitions[]: identity · owned paths/rules · outcome
acceptance_criteria[]: criterion · outcome · evidence
rule_rows[]: subject_id · outcome · evidence
parity_outcome: PASS | FAIL | NOT_TRIGGERED
attack_review_outcome: PASS | FAIL | NOT_TRIGGERED
security_outcome: PASS | FAIL | NOT_TRIGGERED
findings[]: id · severity · path · quoted evidence · consequence · fix shape
overflow: true | false
outcome: PASS | FAIL
```

Allow one schema-only correction using the completed analysis. A correction does
not reopen the repository or restart review. A still-unusable primary result is
`WAIT_FOR_USER`; a still-unusable second opinion falls back to CodeRabbit once,
then `WAIT_FOR_USER`. A second opinion with `outcome: FAIL` and an empty
`findings[]` is unusable: there is nothing to reconcile, so it follows the same
single CodeRabbit fallback, then `WAIT_FOR_USER`.

`PASS` requires complete path coverage, all applicable rows present, every
acceptance criterion passing, no actionable findings, every triggered sub-outcome
passing and `overflow: false`.

## Reconcile once

Give every finding one disposition:

| Disposition | When | Evidence required |
|---|---|---|
| `fix` | a real in-scope defect | affected contract path and planned repair |
| `reject — factually wrong` | its premise is false | cited code or ticket fact |
| `reject — out of scope` | real but excluded from this ticket | approved exclusion, or the user's same-run answer: queued as its own ticket in this run, or explicitly deferred (a gap the user folds in becomes `fix`) |
| `not applicable` | a rule does not fire | named rule ID and applicability evidence |
| `human waiver` | an `[NN]` invariant would bend | `WAIT_FOR_USER`; never self-approve |

A rejected second-opinion finding that could affect correctness, security or
parity must be included in the targeted confirmation even when no bytes change.
**An in-scope minor is `fix`, not a follow-up.** A minor inside a Design Contract
path that can be repaired without changing behavior (a false or stale comment, a
formatting or escaping slip, a wrong count) goes into the one repair batch.
"Follow-up" is reserved for work outside the Design Contract. Even then, the
default is the spine's same-run question: fold it into this ticket, queue it as
its own ticket in this run, or defer it. A gap the user folds in is re-dispositioned
`fix` after the scope re-approval and joins the one repair batch if it is still
unspent. It never opens another batch. Once the batch is spent, or if the
confirmation finds the gap, the execution stays FAIL and the gap needs an
authorized retry or a queued ticket. A deferred tracker item exists only when the user chooses to defer. It is never a line in the final report left for the user to
pick up.

## One repair batch

If there are accepted in-scope findings, apply one batch containing all of them.
The batch may change only Design Contract paths.

**Fix the defect class, not the cited lines.** A finding names one instance; the
batch fixes every instance. Before declaring the batch complete, turn each
accepted finding into a search (a regex, a grep for the false phrase, the same
escape or pattern) and run it over **every candidate path in full**, not only
the range the reviewer cited. Record the search and its zero-hit result in the
`REPAIR` event. A confirmation that finds another instance of an accepted
finding's class means this step was skipped, and there is no second batch to
catch it.

**When the defect sits behind a function, search by caller, not by pattern.** For
a cost/complexity finding (per-item re-enumeration, an unbounded scan, quadratic
work), or for any finding whose bad behaviour lives inside a helper, list
**every call site of that helper**, including those that reach it through
wrappers (`grep -n "helperName("` and then `grep` each wrapper's own callers),
and fix or clear each one by name in the `REPAIR` event. A pattern grep that only
matches the cited caller is not a class search. The regression test must also go
through each fixed caller, not only the one the reviewer cited. (#27666: guarding
`pushLevel` left the guard-findings loop calling `positionOf → orderKeyOf` once
per finding, and confirmation failed.)

Update directly affected tests, comments and docs in the same batch; ordinary
diff review is sufficient—there is no repository-wide prose inventory or
byte-preimage ledger.

Finding units with disjoint write ownership and exclusive resources may be fixed
concurrently by workers that receive the same old candidate ID and exact finding
IDs. Workers never edit the Integration Contract or each other's paths. Join all
units before any command rerun, candidate-ID recomputation or confirmation; they
remain one repair batch.

Then:

- run the deterministic commands affected by the repair;
- rerun test-quality or docs-accuracy only if their inputs changed;
- rerun mapped abuse tests when a control implementation changed;
- enumerate and test a newly introduced trust boundary before confirmation;
- derive the dependency-closed UI slice and recheck only that slice;
- recompute `candidate_id` and record changed paths plus finding attribution.

A red deterministic command is `AUTO_FIX` only while this one repair batch is
still being assembled. Once the batch is declared complete, another candidate
change is not allowed in this REVIEW execution.

## Targeted confirmation

Use the same independent primary workflow, preserving its coordinator and
partition sessions when possible.
Give it the original findings and dispositions, the old and new candidate IDs,
the repair diff, affected callers/contracts, relevant command results, attack
reruns and UI slice. It checks only:

- each accepted finding is fixed;
- each material rejection remains justified;
- the affected closure has no regression;
- changed rule rows and triggered sub-outcomes pass.

Pass it only the captures of screens the repair changed. When the repair
touches a `concurrency`-labelled node, or repairs a security or architecture
finding (Repair routing, below), the second opinion on the repair (the
host's counterpart: Codex for a Claude host, Claude for a Codex host; CodeRabbit
if it is unavailable) runs before this confirmation and returns `PASS` or `FAIL`
with evidence. Default ceiling: 6 minutes. The confirmation returns `PASS` or `FAIL` with evidence. It may not
request another repair. A new actionable finding or failed check is the terminal
result for this execution, not the start of another review cycle.

Apply the same preflighted watchdog/cancellation route to confirmation. Its
ceiling covers partitions and synthesis together, not six minutes per worker.

When the affected closure spans independent frontend/backend partitions, their
targeted checks may run concurrently; the seam coordinator still emits one
confirmation after both return.

## Unit review (opt-in: `config.unitReview`)

When the approved DAG splits the ticket into units and sets `config.unitReview: true`,
per-unit independent review is the main code inspection. **Unit reviews do not
replace the final review.** The final review in this file is still mandatory on
the exact assembled candidate, with the same Opus primary, the mandatory second
opinion and the same repair, confirmation and RETRY policy. Only its scope
changes: it is risk-focused and consumes the verified unit evidence (Final review
on unit evidence, below). The engine never dispatches a
reviewer: the orchestrator relays each unit review, and the engine validates and
records it.

- **When.** A unit is ready once `status.units.<u>.state` is `verified` (its
  checks passed) and nothing is live. `status.unit_reviews_pending` lists the
  units without a current PASS and is the authoritative signal: a `drive`
  outcome of `done` does not include pending unit reviews. Units may be reviewed in any order and
  concurrently, within the same width and memory limits as other dispatches.
  Each record is serialized by the engine lock: retry a `lock_held` refusal.
- **Who.** An Opus primary reviewer that is independent of every builder, under
  the rules in this file. The gate refuses a reviewer whose identity equals a
  builder's. A **risky** unit (`status.units.<u>.review.risky`: a member node
  carries a risk label, or the ticket has `config.riskLabels`) also needs the
  host's counterpart second opinion (Codex for a Claude host), on its review and
  on its confirmation. If the counterpart is unavailable or its usage limit is
  reached, run CodeRabbit on the unit's paths and record it as route `coderabbit`
  with identity `coderabbit:<model>`. If neither can run, stop and ask
  (`WAIT_FOR_USER`); never record the risky unit without it. For a risky unit the
  gate requires the second opinion to come from a different provider than the
  primary (`reviewers_same_provider`) and records each reviewer's provider and
  model. It does not check model names: assigning Opus as primary and Codex as
  second is the orchestrator's duty under the owner rule. For a unit that is not
  risky the second opinion is optional; when it is given, the gate validates it.
- **Input.** Give the reviewer the unit's exact files and diff (its nodes'
  declared reads and writes), its acceptance ids, the contract versions it reads,
  its check results, the approved plan and the threat model. The artifact uses
  the output contract above, with `candidate_id` set to
  `status.units.<u>.evidence.id`. The gate input adds `unit`,
  `approved_plan_digest`, `dag_digest` and `base_commit`
  (`status.units.<u>.evidence.base_commit`). Record it with
  `run-engine.mjs gate unit-review --input <file>`. Use a unique
  `review_execution` for each unit review (`review-<opaque>`); the final review
  may not reuse it.
- **Staleness.** The engine recomputes each unit review's validity on every
  read. Anything that invalidates the unit's evidence (its inputs, a contract it
  reads, a dependency unit, the base commit) makes the review `stale`, and a
  fresh unit review is due. The gate refuses a review that names an old evidence
  id. An unrelated unit keeps its review.
- **FAIL and repair.** Reconcile as above. An accepted FAIL with `fix` findings
  needs `repair_prompt_file` and opens one repair. Its write set (the fixed
  findings' paths plus `repair_ownership`) must lie inside the unit's declared
  writes; anything outside is `repair_outside_unit`, so leave that finding to the
  final review. `drive` runs the repair only while the unit's evidence is still
  the one that was reviewed; otherwise it cancels the repair and the review goes
  stale. Then `drive` re-checks the unit. The re-checked evidence becomes the
  repaired candidate only when the repair's own writes are the sole change; a node
  rebuild, a dependency unit's re-check or any other change makes the review stale
  instead, so a fresh review is due. The same primary (plus the second opinion
  when the unit is risky) then gives one targeted confirmation on the repaired
  evidence (`kind: "confirmation"`). Each unit review execution gets one repair
  and one confirmation. The following are terminal for the unit
  (`unit_review_terminal`): a failed confirmation, an overflow FAIL, a FAIL with
  nothing to fix, a failed repair, a FAIL the ceiling cannot carry, and any unit FAIL after the REVIEW freeze
  (after the freeze, only the final review's repair may change the candidate).
  Only an owner RUN-STATE `RETRY` linked to the unit's last execution continues,
  never an automatic retry.
- **Ceiling.** A re-review, a repair and a confirmation each spend the run-wide
  `config.unitRecheckCeiling`, the same allowance the unit re-checks spend.
  Opening a repair needs three unheld slots: it spends one and holds two (its
  re-check and its confirmation), which no other unit can take. The holds are
  released when the cycle ends or is cancelled. A FAIL whose cycle the ceiling
  cannot carry is still recorded, as terminal with no repair; a PASS re-review
  the ceiling cannot carry is refused (`parent_ceiling`). Neither raises a
  durable judgment, so already-accepted repairs still run. The owner decides.
- **Final gate.** `gate review` (the original and the confirmation) and
  `gate ship-ready` refuse `unit_reviews_missing` until every unit has a current
  PASS. A final-review repair that changes a unit makes that unit's review stale:
  re-review the unit before the final confirmation.

## Repair routing (units)

Route each accepted finding by where its defect lives, not by which reviewer found
it. The write set of the repair and what must be reviewed again follow the class.

| Defect class | Repair writes | Re-check and re-review |
|---|---|---|
| Local defect inside one unit | that unit's declared writes (a unit FAIL: `gate unit-review`) | that unit's checks and its one targeted confirmation |
| Shared contract (schema, API shape, event, generated client) | the contract's owner node plus the readers' closure (inside one unit: a unit repair; across units: the final review's repair) | the contract unit and every unit that reads it (their evidence goes stale), then their unit reviews |
| Integration defect (the units are each right, the join is wrong) | the integration node and the affected tests (the final review's repair) | the integration node's checks and the final review's targeted confirmation |
| Security or architecture | the full affected closure, through the final review's repair | the full closure, plus the opposite-model second opinion on the repair before the confirmation |

A finding whose write set leaves the unit is `repair_outside_unit` at the unit
gate: leave it to the final review, whose one repair batch may cross units. Every
repair still spends the run's ceilings; routing never adds a repair round.

## Final review on unit evidence

When unit reviews exist (`config.unitReview`), the final review in this file is
mandatory and runs on the exact assembled candidate, with the same Opus primary,
the mandatory opposite-model second opinion (Codex for a Claude host; CodeRabbit
if it is unavailable or out of quota; if none can run, stop and ask with
`WAIT_FOR_USER`), and the same reconcile, one-repair, targeted-confirmation and
owner-RETRY policy. Unit reviews do not replace it, and aggregated unit PASSes are
never accepted in its place.

**Brief.** Give the final reviewers:

- the valid unit records: per unit its id, current evidence id, the PASS review
  execution, the findings and dispositions, its acceptance ids and check results
  (`status.units.<u>`);
- the threat model, the approved plan and the assembled diff;
- the scope: the risks that cannot be verified inside one unit:
  - cross-module behaviour and the end-to-end acceptance criteria;
  - security and authorization, tenancy isolation;
  - state and concurrency (request ordering, optimistic concurrency, client async state);
  - payment and refund idempotency;
  - database consistency (migrations, constraints, transactions across units);
  - contracts between units (producer and consumer agree on the materialized artifact);
  - drift from the approved plan and assembly regressions (a unit change that broke another unit's behaviour).

**Rules.**

- The final review **still inspects code** in the high-risk areas above on the
  assembled candidate. Unit evidence narrows where it reads, it does not replace
  reading.
- It **refuses stale unit evidence**. Before it starts, read `status.units` and
  check that every unit is `verified` with a review state `pass` on its current
  evidence id. The engine checks the same: the gate input names
  `units_consumed: [{unit, evidence_id}]`, each unit once with
  `status.units.<u>.evidence.id`, and `gate review` refuses a missing, unknown,
  duplicated or old entry (`units_consumed_stale`). If a unit is stale, re-review
  that unit first; never reuse its old record.
- **Every mapped acceptance id is covered.** Each id in `config.acceptanceIds` is
  the `criterion` (or `id`) of one `acceptance_criteria` row, so the end-to-end
  outcome of every criterion is graded on the assembled candidate. A row may cite
  unit evidence for a criterion verified inside one unit, but it still gets a row.
  `gate review` refuses an original that omits one (`acceptance_uncovered`).
- A final-review repair that changes a unit makes that unit's evidence and review
  stale: re-check and re-review the unit, then give the targeted confirmation a
  `units_consumed` list with the new evidence ids.

## Record and transition

Append one compact `REVIEW` event to the plan's execution block. When repair ran,
append `REPAIR` and `CONFIRM` events as well. Record identities, candidate IDs,
review profile, findings, dispositions, command outcomes, degradations and final
outcome; do not copy source bytes into the plan.

With the run engine, also evaluate each review artifact through `gate.mjs`
(`gateReview` for the original and the confirmation, `gateShipReady` before
SHIP), recorded with `run-engine.mjs gate review|ship-ready` (unit reviews:
`gate unit-review`, above). They bind the artifact
chain, reviewer identity, candidate ID and second opinion, and refuse an incomplete or
stale record; a refusal is a failed review step, not something to patch by hand.
Write `reviewer_identity` as `<provider>:<model>` (a suffix may follow): the gate
refuses a reviewer equal to any builder the engine dispatched and a second opinion
equal to the primary. An accepted FAIL needs `repair_prompt_file` (the repair brief);
the engine then enqueues and dispatches the finding-bound repair, records it, and the
confirmation reviews the repaired candidate. A new original review after a FAIL needs
the owner's RUN-STATE `RETRY` event naming its predecessor execution, appended while nothing
dispatched is live (a line that appears while a worker or runner could run is never honoured). Without the engine, the manual
record above is the fallback. Details: [execution-harness.md](execution-harness.md).

- Clean primary PASS, with a usable second opinion whose findings are all
  reconciled (its own `outcome` need not be PASS) → `COMPLETE` for this phase and
  continue immediately to SHIP.
- Confirmation PASS → continue immediately to SHIP.
- Unusable required reviewer → `WAIT_FOR_USER` with the single capability needed.
- Contract expansion or a needed explicit `[NN]` waiver → `WAIT_FOR_USER`, as in
  the spine; never treat waiting for that decision as permission to mutate.
- Failed confirmation, overflow or a non-waivable unresolved defect →
  `FAIL`; preserve the branch and report exactly what remains.

Reporting any of these transitions is not itself a reason to yield. Only
`WAIT_FOR_USER`, `FAIL`, or final workflow `COMPLETE` ends the assistant turn.
