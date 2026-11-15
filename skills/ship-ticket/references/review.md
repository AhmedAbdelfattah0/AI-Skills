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
second        one mandatory opposite-model opinion (engine run: the Codex relay only; manual: host counterpart, CodeRabbit fallback)
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
- the review profile, time ceilings and the second-opinion route (with the run
  engine: the installed `codex-delegate` relay, nothing else; without it: the
  host's counterpart, else CodeRabbit) are recorded and preflighted.

An unavailable primary reviewer is `WAIT_FOR_USER` here. Do not enter REVIEW and
invalidate otherwise usable work merely to discover that required capability is
missing. With the run engine (the default `config.reviewProvenance`), the
reviewers are the engine's own dispatches (below) and an unavailable Codex relay is
`BLOCKED` `review_relay_unavailable`, then `WAIT_FOR_USER`: CodeRabbit may still run
as advisory input, but it never satisfies `gate review`. Without the engine, or
with the approved opt-out `config.reviewProvenance: "unbound"`, the second opinion is
required too: the host's counterpart first (Codex
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

## Engine-dispatched reviewers (receipt-bound)

With the run engine and the default `config.reviewProvenance` (`engine`), the
gate does not accept an agent-authored review file as proof of an independent
review (`engine-review-dispatch.mjs`). The supported path is the relay route:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs review-dispatch --repo <R> --ticket <T> --run-id <ID> --role primary --candidate <candidate_id>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs review-dispatch --repo <R> --ticket <T> --run-id <ID> --role second  --candidate <candidate_id>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs review-collect  --repo <R> --ticket <T> --run-id <ID>   # or just `next`
```

- **The engine launches the reviewer.** `primary` and `confirmation` run the
  installed `claude-delegate` relay read-only with model `opus`
  (`claude:opus`); `second` runs the `codex-delegate` relay read-only with the
  CLI's default model (`codex:provider-default`). Relays are found by name under
  the account's home directory as the OS reports it (`os.userInfo`, never
  `$HOME`): `<home>/.agents/skills`, then `<home>/.claude/skills`. The first
  dispatch pins each relay's path and sha256; a later dispatch of another file or
  other bytes is `review_relay_drift`. The engine builds the
  argv array and the prompt itself: the frozen candidate id, the approved plan
  narrative, the acceptance inventory, the candidate's paths, diff and untracked
  contents, and the output contract. Nothing of the command comes from you.
- **The receipt comes first.** `REVIEW_DISPATCHED` `{attempt_id, role,
  requested_identity, candidate_id, argv_sha256, prompt_sha256, started_at}` is
  committed before the launcher starts, then the durable attempt handshake
  runs (intent, spawn, pid, release). The command returns while the detached
  reviewer runs; dispatch `primary` and `second` back to back so they overlap.
  Refusals: `review_candidate_mismatch` (not the current candidate),
  `review_role_mismatch` (not the role owed: `confirmation` only after the
  repair), `review_not_owed`, `review_dispatch_live` (never a second launch),
  `review_already_collected`, `review_identity_shared`, `review_build_live`,
  `review_launch_failed`, `review_relay_drift`, `review_diff_unavailable` (a git
  call for the brief failed or overflowed: no reviewer launches on a partial
  diff), `review_fail_unconsumed` (a reviewer FAIL, or a failed reviewer, for an
  earlier candidate of this owed review: submit that FAIL to `gate review` on its
  candidate, or the owner appends a `RETRY` whose `predecessor` is that dispatch's
  attempt id; editing the candidate never buys a fresh reviewer), and
  `review_relay_unavailable` (recorded: the stage is `BLOCKED`, never waived).
- **Collection.** `review-collect`, `next`, `resume` and `drive` settle a finished
  reviewer once: the whole process group is retired, the relay's `result.json`
  is read from the engine-chosen directory, the last fenced JSON object in its
  final message is the review, and `reviewer_identity`, `candidate_id` and
  `route` are overwritten from the receipt (a different claim is kept as
  `claimed_*`, detected only). `REVIEW_COLLECTED` `{attempt_id, exit_code,
  output_sha256, completed_at, parsed_result_sha256}` is recorded and the parsed
  file is listed in `next`'s `gate_review` `results`. A relay exit 127 or an
  `*_unavailable` status is `review_relay_unavailable`; any other failure is
  `review_dispatch_failed`. Both are `BLOCKED` for the owner: fix the relay or the
  CLI login, then dispatch that role again. The launcher hashes `result.json` when
  the reviewer exits and writes the digest into its envelope; a file replaced
  between that exit and the collection is `review_output_substituted` (an
  envelope without the digest: `review_output_unverified`), collected as a
  failure and never as a review.
- **The gate.** Submit the parsed files as `primary` and `second_opinion` (add
  the reconciliation as before). `gate review` matches each to a collection by
  its content digest and refuses `review_unbound` (a hand-written or edited file,
  including one that only copies the current candidate id; a native review
  without the owner key; any second opinion the engine's Codex relay did not
  produce), `review_role_mismatch`, `review_receipt_candidate` (a receipt for
  another candidate: dispatch again for the current one), `review_receipt_base`
  (the receipt's merge base is not the one the review binds to: a rebase or merge
  that left the candidate id unchanged; dispatch again), `review_receipt_spent`,
  `review_identity_shared`, `review_identity_spoofed` (the file names another
  identity, candidate or route than its receipt) and `review_output_changed`. The
  identity, role and candidate it judges come from the receipt, never from the
  review JSON. The review binding records `provenance` per slot.
- **Native reviews.** A native Agent-tool (subagent) review cannot be bound by
  this mechanism. It is refused unless `config.acceptNativeReview: true` is approved
  in the plan narrative for this run (below); then a primary or confirmation that matches no
  collection is accepted and labelled `native_unbound` (detected only), and the
  run is `RELAXED` on every `next`, `status` and `authorize` answer. The second
  opinion is never native.
- **Strict is the release policy.** `gate ship-ready` and `authorize publish`
  refuse an authorizing review whose binding is not engine-dispatched for every
  slot (`review_provenance_unbound`, also a binding from before receipts), and one
  with no freshness binding (`review_binding_missing`): both need an owner
  `RETRY` and a new review. `reviewProvenance` and `acceptNativeReview` are
  assurance settings: `init` accepts a relaxing value only when the DAG is bound
  by the approved plan narrative itself (its digest listed there, never a
  `DAG_BOUND` line; the engine verifies placement in the text START's digest
  covers, not that a human read it) and the narrative carries the exact
  `ship-ticket-assurance-policy: {...}` line of the relaxed values
  (`policy_unapproved`). Before every command the engine compares the state's
  config with the bound DAG (`policy_drift`, `config_drift`: a same-user edit of
  the state file is DETECTED and refused, not prevented).
- **Builders.** A builder recorded as `<provider>:provider-default` counts as every
  model of its provider, so with unmapped Claude builders the `claude:opus`
  primary is refused at dispatch (`reviewer_is_builder`); map the builders' tier in
  `config.modelMap`.
- **Honest limits.** The brief does not attach rule catalogues, UI captures or
  proof evidence (see Bind reviewers to one candidate). None of this is
  cryptographic or server-attested. A process of the same user can rewrite the
  engine state, the relay output and the launcher envelope together, replace the
  relay before its first dispatch, or import the engine modules and call them
  with the in-process seams (`ctx.relayHome`, `ctx.ciProvider`); the receipt then
  proves only which file the engine started. The relay contracts (the claude and
  codex argv, `result.json`) are verified against fakes here, not in functional
  qualification. `gate unit-review` is not covered. An approved
  `config.reviewProvenance: "unbound"` restores the earlier gate for that run,
  with every binding labelled `unbound` and the run `RELAXED`.

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
A carrier that cannot retrieve these inputs is not a valid primary route. The
engine-built brief (`review-dispatch`) carries only the plan narrative, the
acceptance inventory, `AGENTS.md`/`CLAUDE.md`, the candidate paths, diff and
untracked contents: the read-only reviewer runs in the repository and can read
catalogues and evidence files, but nothing in the brief makes it. That is a
known coverage limit of the engine route, not a waiver of the checklist. A
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

Both reviews run concurrently when possible, otherwise one after the other. With
the run engine the second opinion is the engine-dispatched Codex relay and nothing
substitutes for it (`review_relay_unavailable` is `BLOCKED`, then `WAIT_FOR_USER`).
Without the engine, a missing or timed-out counterpart route falls back to
CodeRabbit on the same candidate; if CodeRabbit is also unavailable,
`WAIT_FOR_USER`. Record which route ran (`second_opinion: codex | claude | coderabbit`).

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
- return an explicit `security_outcome` for a security-sensitive ticket;
- under security policy 2, return one primary `rule_row` per effective pair,
  `subject_id` `<boundary>:<control>`, with the pair's spec evidence (see
  [security-risk.md](security-risk.md)).

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
10-minute budget; without the run engine, the CodeRabbit fallback (used when the
counterpart is unavailable, fails, times out or is out of quota) runs after it on
its own 10-minute budget. With the engine there is no fallback: the stage is
`BLOCKED` until the Codex relay produces a usable result. It is mandatory: when the primary finishes first, wait for it
within its budget. Follow [cross-model.md](cross-model.md) for carrier, cancellation and
fallback; do not import the PLAN debate into REVIEW.

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
`WAIT_FOR_USER`; a still-unusable second opinion falls back to CodeRabbit once
(without the run engine; with it, dispatch the Codex relay again or `WAIT_FOR_USER`),
then `WAIT_FOR_USER`. A second opinion with `outcome: FAIL` and an empty
`findings[]` is unusable: there is nothing to reconcile, so it follows the same
single CodeRabbit fallback, then `WAIT_FOR_USER`.

`PASS` requires complete path coverage, all applicable rows present, every
acceptance criterion passing, no actionable findings, every triggered sub-outcome
passing and `overflow: false`. Under security policy 2, `NOT_TRIGGERED` for
`security_outcome` is rejected while unwaived pairs are effective, and
`NOT_APPLICABLE` is rejected for a pair without a trusted `SECURITY_WAIVER`.

## Reconcile once

Give every finding one disposition:

| Disposition | When | Evidence required |
|---|---|---|
| `fix` | a real in-scope defect | affected contract path and planned repair |
| `reject — factually wrong` | its premise is false | cited code or ticket fact |
| `reject — out of scope` | real but excluded from this ticket | approved exclusion, or the user's same-run answer: queued as its own ticket in this run, or explicitly deferred (a gap the user folds in becomes `fix`) |
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
finding (the security or architecture class of Repair routing in [units.md](units.md)), the second opinion on the repair (from a provider
other than the primary's: Codex for the Opus primary, dispatched by the engine as
`--role second`; without the engine, CodeRabbit if it is unavailable) runs before this confirmation and returns `PASS` or `FAIL`
with evidence. Record it as the confirmation's `second_opinion` (`route`,
`reviewer_identity`, `candidate_id`, `checked_findings`, `outcome`, `evidence`): the
gate counts a supplied one (the confirmation is PASS only when both are), and
requires it (`missing_second_opinion`) when the repair's write set overlaps a node
labelled `concurrency` or `security`. A security or architecture finding on a node
without such a label is not detectable by the gate: supplying the second opinion
there stays the orchestrator's duty. Default ceiling: 6 minutes. The confirmation returns `PASS` or `FAIL` with evidence. It may not
request another repair. A new actionable finding or failed check is the terminal
result for this execution, not the start of another review cycle.

Apply the same preflighted watchdog/cancellation route to confirmation. Its
ceiling covers partitions and synthesis together, not six minutes per worker.

When the affected closure spans independent frontend/backend partitions, their
targeted checks may run concurrently; the seam coordinator still emits one
confirmation after both return.

With `config.unitReview`, the per-unit reviews, the unit repair routing and the final review on unit evidence are in [units.md](units.md); without it none of that applies.

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
With engine-dispatched reviewers the identity is the receipt's (`claude:opus`,
`codex:provider-default`), never the file's. Otherwise write `reviewer_identity` as
`<provider>:<model>` (a suffix may follow): the gate
refuses a reviewer equal to any builder the engine dispatched and a second opinion
equal to the primary (also when only the suffix differs). A builder recorded as
`<provider>:provider-default` ran the CLI's unresolved default model, so it counts
as every model of that provider: a reviewer of that provider is `reviewer_is_builder`
(choose a reviewer of another provider, or map the builders' tiers in `modelMap`). An accepted FAIL needs `repair_prompt_file` (the repair brief);
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
