# REVIEW — one independent review, one repair, one targeted confirmation

Loaded only when REVIEW starts. Codex invocation details live in
[codex-cli.md](codex-cli.md); UI comparison depth lives in
[design-parity.md](design-parity.md).

The purpose of REVIEW is to catch semantic defects that deterministic PROVE
could not. It is not another build phase and it is not an audit of the workflow's
own bookkeeping.

## The bounded shape

```text
preflight     prove the candidate and required reviewers are ready
review        one independent checklist-backed review
elevated      optionally add one concurrent Codex opinion
clean         record PASS and continue to SHIP
findings      reconcile once, then apply at most one repair batch
confirmation  check only repaired findings and their affected closure
PASS          continue to SHIP
FAIL          end once with the exact evidence and required next decision
```

A clean standard ticket has one primary workflow: one dispatch for a small or
coupled diff, or one bounded concurrent coverage fan-out for a material full-stack
diff. An elevated ticket adds at most one concurrent optional opinion. Only a
candidate repair or material cross-review disagreement creates confirmation.
There is no generic signing review after a clean result and no full review after
a repair.

## Preflight before REVIEW starts

Finish these checks before announcing REVIEW or appending its start event:

- the approved plan and Design Contract still match the intended change;
- the Integration Contract digest, generated outputs, provider conformance and
  consumer conformance pass when a producer/consumer seam changed;
- every CI-equivalent command runnable locally has passed;
- test-quality, docs-accuracy, applicable static security rows and runtime attack
  work are complete or carry a named degradation;
- UI metadata and the parity artifact are complete when UI is in scope;
- formatters, generators, comments and ticket-produced docs are already current;
- one independent primary-reviewer route is available;
- the review profile, time ceilings and optional-engine fallback are recorded.

An unavailable primary reviewer is `WAIT_FOR_USER` here. Do not enter REVIEW and
invalidate otherwise usable work merely to discover that required capability is
missing. Missing optional Codex or concurrency degrades the elevated second
opinion; it does not block the primary review.

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

Give every initial reviewer the same `candidate_id`, changed-path list, retrieval
recipe, ticket, acceptance criteria, approved plan, Integration Contract, Design
Contract, deterministic results and applicable parity/VAPT evidence. Candidate
files do not change while they run. If the ID changes, discard their results and
classify why:

- an expected external formatter or generator was missed → return to PROVE;
- another actor changed the worktree → `WAIT_FOR_USER`;
- the orchestrator mutated the candidate during review → `FAIL` with the paths.

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
| `STANDARD` | one independent primary workflow |
| `ELEVATED` | the primary workflow plus Codex, concurrently when available |

When elevated concurrency is unavailable, run the required primary workflow and
record `second_opinion: DEGRADED — concurrent route unavailable`; do not serialize
an optional review into the critical path. A missing or timed-out Codex route uses
its documented fallback, then degrades if the fallback is also unavailable.

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

The result is bounded to twelve actionable findings, blockers and majors first,
with at most three minors. More than twelve blockers/majors returns
`overflow: true` and `outcome: FAIL`; it does not spend time narrating an
unbounded catalogue.

## The optional Codex opinion

On `ELEVATED`, start Codex concurrently with the primary workflow. Codex is a
free-form second opinion, not another rule pass and never the approver. Its
default ceiling is 10 minutes. Timeout or invalid output follows the fallback in
[codex-cli.md](codex-cli.md) without restarting the primary review.

## Output contract

Each reviewer returns:

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
`WAIT_FOR_USER`; a still-unusable optional result is a declared degradation.

`PASS` requires complete path coverage, all applicable rows present, every
acceptance criterion passing, no actionable findings, every triggered sub-outcome
passing and `overflow: false`.

## Reconcile once

Give every finding one disposition:

| Disposition | When | Evidence required |
|---|---|---|
| `fix` | a real in-scope defect | affected contract path and planned repair |
| `reject — factually wrong` | its premise is false | cited code or ticket fact |
| `reject — out of scope` | real but excluded from this ticket | approved exclusion or follow-up ticket |
| `not applicable` | a rule does not fire | named rule ID and applicability evidence |
| `human waiver` | an `[NN]` invariant would bend | `WAIT_FOR_USER`; never self-approve |

A rejected optional-review finding that could affect correctness, security or
parity must be included in the targeted confirmation even when no bytes change.
Minors that do not affect correctness, security, the ticket contract or repository
rules are reported as follow-ups; they do not force churn in this ticket.

## One repair batch

If there are accepted in-scope findings, apply one batch containing all of them.
The batch may change only Design Contract paths. Update directly affected tests,
comments and docs in the same batch; ordinary diff review is sufficient—there is
no repository-wide prose inventory or byte-preimage ledger.

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

Default ceiling: 6 minutes. It returns `PASS` or `FAIL` with evidence. It may not
request another repair. A new actionable finding or failed check is the terminal
result for this execution, not the start of another review cycle.

When the affected closure spans independent frontend/backend partitions, their
targeted checks may run concurrently; the seam coordinator still emits one
confirmation after both return.

## Record and transition

Append one compact `REVIEW` event to the plan's execution block. When repair ran,
append `REPAIR` and `CONFIRM` events as well. Record identities, candidate IDs,
review profile, findings, dispositions, command outcomes, degradations and final
outcome; do not copy source bytes into the plan.

- Clean primary PASS, with any optional findings reconciled → `COMPLETE` for this
  phase and continue immediately to SHIP.
- Confirmation PASS → continue immediately to SHIP.
- Unusable required reviewer → `WAIT_FOR_USER` with the single capability needed.
- Failed confirmation, overflow, contract expansion or unresolved `[NN]` issue →
  `FAIL`; preserve the branch and report exactly what remains.

Reporting any of these transitions is not itself a reason to yield. Only
`WAIT_FOR_USER`, `FAIL`, or final workflow `COMPLETE` ends the assistant turn.
