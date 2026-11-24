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
second        one mandatory second opinion (Codex; else Fable, same-provider)
clean         record PASS and continue to SHIP
findings      reconcile once, then apply at most one repair batch
confirmation  check only repaired findings and their affected closure
PASS          continue to SHIP
FAIL          end once with the exact evidence and required next decision
```

A clean standard ticket has one primary workflow: one dispatch for a small or
coupled diff, or one bounded concurrent coverage fan-out for a material full-stack
diff, run by Opus. Every ticket also gets exactly one mandatory second opinion,
concurrently when resources allow. Only a
candidate repair or material cross-review disagreement creates confirmation.
There is no generic signing review after a clean result and no full review after
a repair.

## Preflight before REVIEW starts

Finish these checks before announcing REVIEW or appending its start event:

- the approved plan and Design Contract still match the intended change;
  run `node scripts/check-pr-scope.mjs check --repo <repo> --ticket <ticket> --run-id <id> --base <base> --plan <plan> [--dag <dag>]`
  on the candidate before announcing REVIEW (manual flow too) and give the scope
  record to the primary reviewer. It reads only the plan's one fenced
  `scope-contract` block (see [plan.md](plan.md)), never the Files touched
  table, and classifies every candidate path as planned, supporting or material.
  The ExitPlanMode request quoted the block inside a four-backtick fence; the orchestrator extracts ONLY the four-backtick quote block from the approval request it sent and saves that, then runs `node scripts/check-pr-scope.mjs contract --verify-quote <saved-quote> --plan <plan> --record <scope.json>`, and the reviewer re-runs it. The saved file must hold the quote and nothing else (whitespace-only lines and CRLF aside); any other line fails. This is a precise input definition, not an attempt to detect contradictory prose.
  It byte-compares the quoted body with the plan block and `record.contract`.
  Verification does not by itself prove what the owner saw and does not authorize
  execution: native ExitPlanMode approval remains mandatory, and it counts only
  when given on a qualified approval surface (see [plan.md](plan.md); browser,
  GitHub and editor previews never count). If the approval was not a native
  ExitPlanMode approval on a qualified surface, report `scope approval NOT verified: the approval was not a native ExitPlanMode approval on a qualified approval surface; do not build` and stop.
  Raw HTML in the plan is no longer refused by the check; a viewer that lets it
  hide or run content does not qualify, by that policy. The reviewer reads the block and checks every supporting path, which lies outside the Design Contract (on an
  engine policy-2 run reassess reports it as out-of-plan; supporting is most
  useful in manual mode). Exit 1 (a material
  path) is a Design Contract expansion: **WAIT_FOR_USER** and re-approve through
  `ExitPlanMode`. An engine-mode contract always needs `--dag` (`dag_required`),
  also after a failed engine init; a manual-mode contract refuses `--dag` and any
  engine evidence of the run. A contract or mode change is a plan change: re-approval through `ExitPlanMode`.
  Exit 2 or 3 is never a pass. When the plan text itself must change (a missing,
  ambiguous, noncanonical or invalid contract block), the remedy is re-approval
  through `ExitPlanMode`, since an edited plan changes the digest and gives
  `approval_mismatch`; fix and rerun only a wrong flag, path or git state.
  Exit 0 proves only the path set, not the behaviour inside a planned file;
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
  for it; on an ELEVATED or security-sensitive run that is **WAIT_FOR_USER** at fallback time, SKILL.md stop list) and never present the engine's blocked state as a pass;
- test-quality, docs-accuracy, applicable static security rows and runtime attack
  work are complete or carry a named degradation;
- UI metadata and the parity artifact are complete when UI is in scope;
- formatters, generators, comments and ticket-produced docs are already current;
- one independent primary-reviewer route can enforce its deadline and cancel
  unfinished work, including all partitions;
- the review profile, time ceilings and the second-opinion route (Codex, else
  Fable) are recorded and preflighted.

An unavailable primary reviewer is `WAIT_FOR_USER` here. Do not enter REVIEW and
invalidate otherwise usable work merely to discover that required capability is
missing. The second opinion is required too: Codex in a fresh session first; if
it is unavailable or its usage limit is reached, a fresh Fable session on the
same candidate; if neither is available, `WAIT_FOR_USER`. CodeRabbit is optional
extra coverage, never required ([cross-model.md](cross-model.md)); when it runs,
cover the whole candidate including untracked files and record the scope it
reviewed. Missing concurrency only serializes the two reviews; it never removes
one.

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

Time the round with `run-log.mjs` as [observability.md](observability.md) lists: a
`start`/`end` pair per primary reviewer, second opinion, repair, confirmation and
`review_reconcile`, each at the real start and end, never backfilled. Missing ceilings or
revision are recorded `unknown` and never block the round or its repair. `summary` flags
`missing_review_intervals`; `eval.mjs` reports the round timeline and concurrency.

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
- repository instructions or the user explicitly require ELEVATED review;
- preflight records a material uncertainty that the review can resolve.

Those triggers select `ELEVATED`. They change reviewer redundancy, not rule,
screen or attack applicability. Every applicable check still runs in either
profile.

| Profile | Initial semantic review |
|---|---|
| `STANDARD` | the Opus primary workflow plus the mandatory second opinion |
| `ELEVATED` | the same, with partitioned primary coverage when the diff is material and the security outcome required |

Both reviews run concurrently when possible, otherwise one after the other. A
missing or timed-out Codex route falls back to a fresh Fable session on the same
candidate; if Fable is also unavailable, `WAIT_FOR_USER`. Record which route ran
(`second_opinion: codex | fable`, plus `coderabbit` when the optional extra pass
ran) and record Fable as a same-provider independent review.

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
- walk every applicable stack-reference rule plus the separate `AI-FM` and
  `UNIVERSAL` rows;
- include `TEST` and `DOC` rows when their surfaces changed;
- for UI, perform the complete parity comparison against the pinned reference;
- for trust boundaries, review the static control trace and frozen runtime attack
  evidence without rerunning attacks;
- return an explicit `security_outcome` for a security-sensitive ticket;
- under security policy 2, return one primary `rule_row` per effective pair,
  `subject_id` `<boundary>:<control>`, with the pair's spec evidence, and one per
  dropped pair of a block format 3: `NOT_APPLICABLE` citing its evidence path when
  the cited fact holds (and the surface's exact file is where the boundary's code lives, not a decoy), `FAIL` to dispute it. A counterpart that disputes a drop
  gives its finding `subject_id: '<boundary>:<control>'`, which, on an original
  review, records the same run-wide dispute (see
  [security-risk.md](security-risk.md) section 9). No file is exempted by its
  name: a test file that registers a route or sits on an auth path is a §3a
  surface with its own pairs, like any other file.

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

## The mandatory second opinion

On every ticket, start Codex in a fresh session, concurrently with the primary
workflow when resources allow. It is a free-form second opinion, not another rule
pass or approver. Codex has a 10-minute budget; the Fable fallback (used when
Codex is unavailable, fails, times out or is out of quota) runs after it on its
own 10-minute budget. It is mandatory: when the primary finishes first, wait for
it within its budget. Follow [cross-model.md](cross-model.md) for carrier,
cancellation and fallback; do not import the PLAN debate into REVIEW.

## Output contract

The primary workflow returns the complete schema below. The second-opinion counterpart
(given the §3a security plan in its prompt) returns identity, candidate ID, findings, overflow and an outcome; its free-form
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
`WAIT_FOR_USER`; a still-unusable Codex second opinion falls back to Fable once,
then `WAIT_FOR_USER`. A second opinion with `outcome: FAIL` and an empty
`findings[]` is unusable: there is nothing to reconcile, so it follows the same
single Fable fallback, then `WAIT_FOR_USER`.

`PASS` requires complete path coverage, all applicable rows present, every
acceptance criterion passing, no actionable findings, every triggered sub-outcome
passing and `overflow: false`. Under security policy 2, for an original review,
`NOT_TRIGGERED` for `security_outcome` is rejected while unwaived pairs are effective
or a current primary row of a dropped pair is `FAIL` (other recorded disputes block
confirmation and ship-ready instead), `NOT_APPLICABLE` is rejected for an effective pair without a trusted
`SECURITY_WAIVER`, and `PASS` is rejected for a dropped pair. A disputed dropped pair
is never cleared by repair and confirmation (`security_na_disputed`).

## Reconcile once

Give every finding one disposition:

| Disposition | When | Evidence required |
|---|---|---|
| `fix` | a real in-scope defect | affected contract path and planned repair |
| `reject — factually wrong` | its premise is false | cited code or ticket fact |
| `reject — out of scope` | real but excluded from this ticket | approved exclusion; a residual within the plan's recorded ship threshold plus the follow-up tracker item opened for it; or the user's same-run answer: queued as its own ticket in this run, or explicitly deferred (a gap the user folds in becomes `fix`) |
| `not applicable` | a rule does not fire | named rule ID and applicability evidence |
| `human waiver` | an `[NN]` invariant would bend | `WAIT_FOR_USER`; never self-approve |

A disposition row carries `finding_id` and `source` (`primary` or the second opinion's
route); `id`s are unique per reviewer.
The gate stores only the primary `outcome`, refusing a primary `PASS` with a finding
disposed `fix` (`outcome_inconsistent`). The reviewer re-judges the outcome; never edit it by hand. Repair and
confirmation follow. Run `usage.mjs import-session` (and `import-codex`)
after every review execution (reviews are unmetered), naming `--subagent-role reviewer` when the
subagents reviewed (an unnamed import is `unattributed`). Phase-0 plans set `config.auditRecord: true` and
record per review: wall, tokens by role, findings by severity, repairs and confirmations (review
`api_ms` has no source: `unknown`).

A rejected second-opinion finding that could affect correctness, security or
parity must be included in the targeted confirmation even when no bytes change.
**An in-scope minor is `fix`, not a follow-up.** A minor inside a Design Contract
path that can be repaired without changing behavior (a false or stale comment, a
formatting or escaping slip, a wrong count) goes into the one repair batch.
"Follow-up" is reserved for residuals within the plan's recorded ship threshold
(a confirmation finding, or one outside the Design Contract): they ship with a
recorded follow-up tracker item, without a question. Any other gap outside the
Design Contract gets the spine's same-run question: fold it into this ticket, queue it as
its own ticket in this run, or defer it. A gap the user folds in is re-dispositioned
`fix` after the scope re-approval through `ExitPlanMode` and joins the one repair batch if it is still
unspent. It never opens another batch. Once the batch is spent, or if the
confirmation finds the gap, the execution stays FAIL and the gap needs an
authorized retry or a queued ticket. Outside the recorded ship threshold, a deferred tracker item exists only when the user chooses to defer. No follow-up is ever a line in the final report left for the user to
pick up: each is a tracker item the report links.

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
Give it the original findings and dispositions, the plan's recorded ship threshold, the old and new candidate IDs,
the repair diff, affected callers/contracts, relevant command results, attack
reruns and UI slice. It checks only:

- each accepted finding is fixed;
- each material rejection remains justified;
- the affected closure has no regression;
- changed rule rows and triggered sub-outcomes pass.

Confirmation is finding-specific in what it checks: the prior findings, their dependency-closed surface and
anything the repair introduced, on a frozen packet, in addition to the checks above. This narrows the scope
only; a new actionable finding is still the terminal result below, and a blocker is never suppressed to
satisfy the cap.

Pass it only the captures of screens the repair changed. When the repair
touches a `concurrency`-labelled node, or repairs a security or architecture
finding (the security or architecture class of Repair routing in [units.md](units.md)), the second opinion on the repair (Codex;
Fable if it is unavailable) runs before this confirmation and returns `PASS` or `FAIL`
with evidence. Record it as the confirmation's `second_opinion` (`route`,
`reviewer_identity`, `candidate_id`, `checked_findings`, `outcome`, `evidence`): the
gate counts a supplied one (the confirmation is PASS only when both are), and
requires it (`missing_second_opinion`) when the repair's write set overlaps a node
labelled `concurrency` or `security` (its reads or writes), or touches an effective
pair's spec file. The gate cannot infer a security or architecture finding on a node
without such a label: supplying the second opinion there stays the orchestrator's
duty. A confirmation records no dispute of a dropped
pair, whatever its rows, findings or evidence say: only an original review does
([security-risk.md](security-risk.md) section 13, L2). Default ceiling: 6 minutes. The confirmation returns `PASS` or `FAIL` with evidence. It may not
request another repair. A new actionable finding or failed check is the terminal
result for this execution, not the start of another review cycle. A residual
within the plan's recorded ship threshold is not actionable here: the confirmation
names it in its `evidence`, and it ships with a recorded follow-up tracker item.

Apply the same preflighted watchdog/cancellation route to confirmation. Its
ceiling covers partitions and synthesis together, not six minutes per worker.

When the affected closure spans independent frontend/backend partitions, their
targeted checks may run concurrently; the seam coordinator still emits one
confirmation after both return.

With `config.unitReview`, the per-unit reviews, the unit repair routing and the final review on unit evidence are in [units.md](units.md); without it none of that applies.

## Two-cycle limit

In force from 2026-11-23 (owner P0 priority); engine enforcement of the assessment step arrives with FR-4c.

A review cycle is counted per implementation revision (head), not per reviewer. Opus and Codex on the same head
are one cycle. There are at most two cycles per implementation attempt:

- **Cycle 1:** the independent reviews of one head. Reconcile their findings into one consolidated repair plan
  (the one repair batch above).
- **Cycle 2:** the targeted confirmation above, the independent review of the consolidated repair. It is not a
  new full review, and it does not allow any number of repair batches.

An implementation attempt is never reset by a commit or a new head: "new head = new attempt" is not a way round
the cap. A new attempt starts only through owner authority: a RUN-STATE `RETRY` for ticket runs; for Factory-dev
PRs, a recorded owner-approved revised plan or strategy.

A failed confirmation is the terminal `FAIL` above. When cycle 2 still returns a qualifying Major or Blocker,
STOP automatic repair and write a structured Root-Cause / Architecture Assessment. The same applies when the
confirmation fails on the same defect class as a primary finding, whatever its severity (including a Minor) and
including a failed check: any confirmation that fails on the same defect class requires re-assessment, never
another patch. There is no third automatic repair cycle, and no second repair batch clears it. Owner approval is
required before resuming with a revised plan or an explicitly justified corrective strategy; a revised plan
returns to the one native approval, and a change beyond the approved scope needs the owner. Never waive a failing
mandatory gate, never downgrade a severity to meet the limit, and never treat the escalation as approval to
ship. Preserve the unresolved findings, the primary review and the confirmation in the record. Challenge a
finding that is wrong with evidence (`reject — factually wrong`) rather than patching to it.

A provider refusal of a review brief is recorded as `provider_refused`, with the provider's message. No engine or
record field exists for it yet, so it is recorded manually (ledger or PR note) until one does. Never reword, split
or re-scope a brief to pass a provider safeguard, and never resubmit an altered brief.

**Assessment template** (file `.specs/reviews/<KEY>/assessment-<review_execution>.md`):

1. Evidence: the cycle 1 and cycle 2 findings, by id.
2. Classification, one or more of: architecture defect, implementation defect, unclear acceptance contract,
   trust-boundary failure, incomplete test strategy.
3. Why the consolidated repair did not hold.
4. The smallest defensible corrective approach: revise the approved plan, simplify the architecture, or replace
   the implementation mechanism (or challenge a wrong finding with evidence). Also weigh a stronger model or a
   fresh builder, and whether to reuse instead of repair.
5. What changes in the next attempt and which guarantees it keeps.

**Manual versus engine today.** The engine enforces only: one repair per review execution (`round_limit`), one
confirmation per review execution (`confirmation_spent`), and that a new original review needs a RUN-STATE
`RETRY` (`retry_unauthorized`). Until FR-4c, writing the assessment, binding it to the record and obtaining the
owner's approval to resume are orchestrator duties, and nothing checks that the assessment file exists. The
agents reason about the cause and pick the approach; the owner approves the resumption.

## Packets and instances

Review packets are frozen and read-only: reviewers never execute project code, they read the frozen
candidate and the recorded command output. A review reports all instances of a defect class it finds, not the first one, so the
single repair batch can fix the class.

## Record and transition

Append one compact `REVIEW` event to the plan's execution block. When repair ran,
append `REPAIR` and `CONFIRM` events as well. Record identities, candidate IDs,
review profile, findings, dispositions, command outcomes, degradations and final
outcome; do not copy source bytes into the plan.

With the run engine, also evaluate each review artifact through `gate.mjs`
(`gateReview` for the original and the confirmation, `gateShipReady` before
SHIP), recorded with `run-engine.mjs gate review|ship-ready` (unit reviews: `gate unit-review`, [units.md](units.md)). They bind the artifact
chain, reviewer identity, candidate ID and second opinion, and refuse an incomplete or
stale record; a refusal is a failed review step, not something to patch by hand.
Write `reviewer_identity` as `<provider>:<model>` (a suffix may follow): the gate
refuses a reviewer equal to any builder the engine dispatched and a second opinion
equal to the primary (also when only the suffix differs). A builder recorded as
`<provider>:provider-default` ran the CLI's unresolved default model, so it counts
as every model of that provider: a reviewer of that provider is `reviewer_is_builder`
(choose a reviewer of another provider, or map the builders' tiers in `modelMap`). An accepted non-overflow FAIL with at least one finding to fix needs
`repair_prompt_file` (the repair brief); the engine then enqueues and dispatches the
finding-bound repair, records it, and the confirmation reviews the repaired candidate.
Any other accepted FAIL (an overflow FAIL, or one with no finding to fix) opens no
repair. A new original review after a FAIL needs
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
