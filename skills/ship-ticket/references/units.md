# Units (opt-in)

Load this file when the plan chooses to split the ticket into units (PLAN), and when any node of the bound DAG has `unit` (BUILD, PROVE, REVIEW). A run whose DAG has no `unit` field does not need it: [execution-harness.md](execution-harness.md) covers that run on its own.

## Planning a split

These blocks belong to the PLAN step "Decomposition: split or not" in [plan.md](plan.md); they apply once the plan chooses to split.

**Declare `config.acceptanceIds`** as the plan's own acceptance-criterion ids
(for example `AC1`..`ACn`, as written in the plan), and map each to at least one
node through `acceptance`. With unit reviews the final review must grade every id
by name (`acceptance_uncovered` otherwise; Final review on unit evidence, below). `config.unitReview` therefore requires `config.acceptanceIds`: `init`
refuses a DAG that sets it without them (`dag_invalid`), since coverage of no ids
would pass vacuously.

**Set `config.unitRecheckCeiling` for the unit count.** It is one run-wide
allowance (default 4) shared by every unit re-check, unit re-review, unit repair
and unit confirmation; the unit count never multiplies it. A unit repair cycle
needs 3 unheld slots (the repair, its re-check, its confirmation), and a stale
upstream unit costs each dependent a re-check and a re-review. Size it for the
cycles you expect (roughly 3 per unit that may need a repair plus 2 per dependent
of a churning contract) and record that reasoning in the plan. Disclosed limit
(held slots): while one unit's open repair holds its two slots, another unit's
re-check can exhaust the rest and raise a durable `parent_ceiling` that halts all
dispatch, that repair included, until the owner decides. A higher ceiling for a
multi-unit ticket is the mitigation; it is still a fixed, approved bound.

**Known over-review cost.** A dependent unit binds its upstream unit's evidence,
not the bytes of the contract they share. When the upstream unit is re-checked,
every dependent's evidence and unit review go stale and are redone, even if the
shared contract did not change. It is safe but costs ceiling and reviewer time;
AIS-HARNESS-3 Wave 4 measures it before any finer binding is built
(Engine rules, below).

## Engine rules

The run engine rules for nodes that carry `unit` ([execution-harness.md](execution-harness.md) holds the rest of the Run engine):

**Units (opt-in; AIS-HARNESS-3 Wave 2a).** Absent fields change nothing: a DAG without them
produces the same state, events and output as before (pinned by the golden test in
`run-engine-units.test.mjs`); there is no schema bump. A node may carry `unit` (a safe id,
distinct from every node id and `testCommands` name), `checks` (names of `config.testCommands`
entries; needs `unit`) and `acceptance` (acceptance criterion ids). The plan template carries no
machine-readable criteria, so the ids come from `config.acceptanceIds`, which the approved plan
binds with the DAG digest. `init` refuses (`dag_invalid`) an unknown check, a check without a
unit, an acceptance id outside `config.acceptanceIds`, `acceptance` without it, and, once any node
has `acceptance`, an id of `config.acceptanceIds` mapped to no node. Units may not form a cycle,
also not through unit-less nodes.
- **Checks.** Once every node of a unit is done, the engine holds new dispatch, waits until nothing
  is live, and runs the union of the unit's `checks` under the runner protocol (attempt kind
  `unit-check`, the unit's `resources` as durable locks, `retire()` before a result counts, a
  surviving or unknowable group is `quiescence_unknown` with nothing recorded; `resume` reconciles
  it like a RED runner). Each unit is checked at most once per engine command, and `--until` does
  not limit which units are checked (its scope includes every member of a unit an in-scope node
  depends on, since that dependency counts as done only once its whole unit is verified). A runner that cannot start is retried once (`UNIT_CHECK_RETRY`); a failing
  exit never is. The unit is `verified` only when every check exits 0 and the checks left the
  declared `reads` and `writes` of every node (unit-less upstream generators included) and the
  `config.base` commit unchanged; a check that changes any of them fails with that cause, so a
  dependent unit is never verified while a generator stays `done` on inputs its check rewrote.
  Checks that drift the approval binding (plan narrative or DAG bytes) record no evidence
  (`UNIT_CHECK_DROPPED`) and the drive returns the binding judgment, so no dependent dispatches. A unit with no `checks` is verified vacuously once its nodes are done (its evidence
  still binds, for invalidation). A node of another unit, or a unit-less node, counts a dependency as done
  only once that dependency's unit is verified. A failure before the freeze marks the unit's nodes
  `failed` (`node_failed`) and reports `unit_check_failed`: `mark failed->pending` of one node
  spends that node's retry and re-runs it, the unit's other nodes failed only by the check return
  to `done` without re-running, and the checks run again. After the freeze the nodes stay `done`
  and `unit_check_failed` goes to the owner. `gate review` and `gate ship-ready` refuse
  `units_unverified` while any unit is not verified.
- **Dead ends and the owner clearing path.** A post-freeze `unit_check_failed` and a
  `unit_invalidation_storm` are cleared only by `run-engine.mjs clear-unit --unit <u>`, which
  requires a trusted RUN-STATE authority event `{"run_id", "event": "UNIT_CLEAR", "unit",
  "predecessor": <the unit's current evidence id, status.units.<u>.evidence.id>, "authorized_by",
  "reason"}`. It follows the RETRY authority model: honoured only when the engine first observed the
  line with nothing dispatched able to run (a worker that appends one is an ownership violation; a
  line seen while something may run is untrusted, `unit_clear_unauthorized`, and the owner re-appends
  a distinct line once `status` shows nothing live). No matching event, or one linked to other
  evidence, is `unit_clear_unauthorized`; a unit not at a dead end is `unit_clear_refused` (before
  the freeze a failed unit takes `mark failed->pending`). Refusals exit 1. The clear removes that
  unit's storm judgment, resets only that unit's evidence and invalidation counter (its causes stay)
  and records why: `UNIT_CLEARED` (engine event and RUN-STATE line, with `authorized_by` and
  `reason`) and `status.units.<u>.clears`. The next drive re-checks the unit, and that re-check
  spends the parent ceiling: a clear never lifts it.
- **Parent-wide ceiling.** `config.unitRecheckCeiling` (integer 0..100, needs a unit; default 4,
  applied at use and never written into the bound config, so it is covered by the DAG digest only
  when set) caps unit re-checks per run across ALL units together: every check round of a unit that
  already completed one in this run (after a failed result and a `mark`, an invalidation, or a
  clear) spends one (`UNIT_RECHECK`, with its kind `rerun|invalidation|cleared`); a first check and
  a `UNIT_CHECK_RETRY` infra retry spend none. Neither the unit count nor the node count scales it,
  so marking each of k nodes of a unit in turn, or a second unit, gets no fresh allowance. Once it
  is spent, the next re-check raises the durable judgment `parent_ceiling` instead (no automatic
  retry; neither `mark`, `resume` nor `clear-unit` clears it: the owner decides, and continuing
  means a re-`init` under a new owner-approved START). The ceiling is part of the bound DAG, so it
  can only be raised for that new run (a changed DAG under the old run is `dag_mismatch`). `init`
  refuses `state_exists` while the old ledger is there, and with engine state the carrier keeps
  reading it as REPAIR authority, so the owner retires it first: confirm `status` shows nothing live
  (no `intent|launched|running|unknown` attempt) and no worker of the run is still running, move
  `<TICKET>.state.json` aside (kept as evidence, e.g. renamed with the old run id, outside
  `ai-skills/ship-ticket/`), append the new START (and DAG_BOUND) with a new `run_id`, then `init`
  with that run id. The storm guard is evaluated first.
  `status.unit_ceiling` shows `{limit, used}`, plus `reserved` while an open unit repair holds slots.
  With unit reviews, the same allowance is also spent by every unit re-review, unit repair and unit
  confirmation (below), and held slots count as spent for every other unit's re-check.
- **Unit review (opt-in; AIS-HARNESS-3 Wave 2b-ii).** `config.unitReview: true` (boolean, needs a
  unit; never defaulted, so the DAG digest covers it only when set) makes each unit need its own
  independent review chain. The engine never dispatches a reviewer: the orchestrator relays it
  (Unit review, below) and `gate unit-review` validates and records it under the
  lock, reusing `gate.mjs` `gateReview` (contract, enums, dispositions, builder roster, distinct
  reviewers). The input is `{unit, review_execution, kind: original|confirmation,
  approved_plan_digest, dag_digest, base_commit, primary, second_opinion?, reconciliation,
  graded_artifacts?, repair_ownership?, repair_prompt_file?}`, where the reviewers' `candidate_id`
  is the unit's evidence id (`status.units.<u>.evidence.id`); `--unit` may name the unit instead. It
  is accepted only when the unit is `verified`, nothing is live, the digests are the bound ones and
  the evidence id and base commit are the current evidence's. Refusals record nothing:
  `unit_review_disabled`, `unknown_unit`, `binding_mismatch`, `attempts_live`, `unit_unverified`,
  `stale_base`, `stale_evidence`, `chain_broken` (an execution id of another chain),
  `unit_review_current`, `unit_review_open`, `retry_unauthorized`, `repair_outside_unit`,
  `repair_prompt_missing`, `reviewers_same_provider`, `parent_ceiling` (not a durable judgment), and
  every `gateReview` refusal. A unit is risky when a member node carries a risk label or the ticket
  has `config.riskLabels`. Its review and its confirmation then need a second opinion
  (`missing_second_opinion`) from a provider other than the primary's (`reviewers_same_provider`;
  a CodeRabbit fallback is route `coderabbit` with identity `coderabbit:<model>`). Otherwise a
  second opinion is optional and validated when given. The record carries each reviewer's provider
  and model; model-name roles are the orchestrator's duty. The record (in `S.unit_reviews.<u>.chain`) binds the plan and DAG
  digests, the unit, the evidence id, its base commit and whole-tree candidate (`tree_candidate`),
  the reviewers, findings and outcome. The review state is recomputed at every read against the
  current evidence: `unreviewed`, `pass`, `stale` (the reviewed evidence no longer holds: a fresh
  original is due), `fail` awaiting `repair|recheck|confirmation`, or `fail` terminal (computed
  judgment `unit_review_terminal`). An accepted FAIL with findings to fix, before the freeze, enqueues
  `repair-<rx>` (kind `unit-review`) through the review-repair authorization (the FAIL record in the
  unit's chain, `rounds.unit_review_repairs`, finding-bound writes that must lie inside the unit's
  declared writes); `drive` dispatches it only while the unit's evidence is the reviewed one (else
  `UNIT_REPAIR_CANCELLED`), records it in the unit chain without freezing and re-checks the unit.
  The new evidence becomes the candidate of the one targeted confirmation only when, against the
  binding the FAIL reviewed, nothing but files inside the repair write set changed
  (`UNIT_REPAIR_BOUND`). A declared directory is compared file by file against its tree recorded
  at the FAIL, so a repair writing `src/a.txt` inside a declared `src` binds, while any other
  changed, added or removed entry inside it is outside the repair. A node re-run, a dependency unit's re-check, an upstream change or a base
  move instead marks the repair `unbound` (`UNIT_REPAIR_UNBOUND`) and the review stale. This
  bookkeeping is idempotent and runs on every `drive`, `resume`, `status` and gate, so a crash
  between a re-check and its binding is recovered. A failed confirmation, an overflow FAIL, a FAIL
  with nothing to fix, a failed repair, a FAIL whose cycle the ceiling cannot carry
  (`ceiling_refused`, recorded with `repair_opened: false`) and any FAIL after the freeze are
  terminal: only a trusted RUN-STATE `RETRY {review_execution, predecessor: <the unit's
  last execution>, authorized_by}` admits a new original. A re-review, a repair and a confirmation
  spend the parent-wide ceiling. Opening a repair needs 3 unheld slots: it spends 1 and holds its
  re-check and confirmation for the unit until the cycle ends or is cancelled
  (`UNIT_CEILING_RELEASED`). The spends are recorded
  (`UNIT_REVIEW_CYCLE` with kind `unit_rereview|unit_repair|unit_confirmation` and its trigger:
  stale evidence and its invalidation causes, the owner RETRY, the fixed findings, the repair).
  `gate review` (original and confirmation) and `gate ship-ready` refuse `unit_reviews_missing`
  until every unit has a current PASS (and `gate review` the two Wave 3 refusals below). The `drive` outcome `done` does not cover pending unit
  reviews; `status.unit_reviews_pending` is authoritative. The carrier's REPAIR authorization also
  reads the unit chains, but only a FAIL whose repair the engine opened (`repair_opened: true`).
- **Final review on unit evidence (AIS-HARNESS-3 Wave 3; only with `config.unitReview`).** Unit
  reviews do not replace the final review (Final review on unit evidence, below).
  After the refusals above, `gate review` also refuses, recording nothing:
  `acceptance_uncovered` when an original's `primary.acceptance_criteria` has no row whose
  `id` (when that is an acceptance id; else its `criterion`: one row covers one id) is an acceptance id mapped on a node (every id of `config.acceptanceIds`),
  and `units_consumed_stale` when an original or a confirmation does not name, in the input field
  `units_consumed: [{unit, evidence_id}]`, every unit exactly once with its current verified
  evidence id (`status.units.<u>.evidence.id`): a missing, unknown, duplicated or old entry is
  refused. The accepted record carries `units_consumed`, and `gate ship-ready` re-checks the record
  that authorizes ship (the last accepted original or confirmation) by the same rule, refusing
  `units_consumed_stale` when a unit's evidence moved since (for example the resolved base moved
  and the units were re-checked and re-reviewed on a byte-identical candidate). `init` refuses
  (`dag_invalid`) `config.unitReview: true` without `config.acceptanceIds`. Without
  `config.unitReview` none of this runs and `units_consumed` is a usage error (exit 1), so the
  final review is unchanged.
- **Known over-review cost (measured in AIS-HARNESS-3 Wave 4, not fixed).** Unit evidence binds a dependency
  unit's evidence id, not the bytes of the contract it shares. When an upstream unit is re-checked
  (after its repair, a rebuild or an input change), every dependent unit's evidence and unit review
  go stale and are re-checked and re-reviewed, even when the shared contract bytes did not change.
  This is safe (it never reuses stale evidence) but spends the parent-wide ceiling and reviewer
  time. A finer binding to the shared contract's fingerprints is deferred until Wave 4 measures the
  cost.
- **Evidence.** The stored check result is bound, as it stands after the checks ran, to the
  fingerprints of the unit's reads and writes, the resolved `config.base` commit, each node's
  attempt count, each dependency unit's evidence, and the attempt count and state of every
  transitive dependency node outside the unit, unit-less ones included (with their declared paths'
  fingerprints): a stale or failed upstream node leaves the unit unverified. Only declared `reads`
  and `writes` are bound; undeclared inputs (test files, lockfiles, config) are not, so declare what
  a check depends on. The candidate id is recorded with it but does not bind it, because another unit's
  writes change the candidate. Validity is recomputed at every use. Any change makes the evidence
  `stale`, together with the units of its dependent closure only (`UNIT_INVALIDATED`, with the
  cause: changed paths, base moved, nodes re-run or a dependency), and the checks run again; a
  fingerprint refresh after a repair is never renewed evidence. Every stale-to-re-check transition is
  recorded as an invalidation first, also between checks inside one drive. Verified evidence invalidated more
  than twice in one run raises `unit_invalidation_storm` (durable) instead of another re-run; the
  owner decides (the decomposition or the contract churns); see the dead ends above.
- **Projection.** `status.units` and the `eval` report's `units` list per unit `state`
  (`verified|stale|failed|pending`), `nodes`, `deps`, `acceptance`, `checks`, current
  `fingerprints`, `evidence` (`id`, `state`, `candidate_id`, `base_commit`, per-check results),
  `stale_cause`, `invalidations` and their `causes`, `clears` once the owner cleared it, and with
  unit reviews its `review` (`state`, `awaiting`, `terminal`, `review_execution`, `evidence_id`,
  `reviewed_evidence`, `risky`, `risk_labels`, `records`). It is computed, never authority.

The unit commands of the Run engine:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs clear-unit --repo <R> --ticket <T> --run-id <ID> --unit <unit>   # needs an owner UNIT_CLEAR (Units)
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs gate unit-review --repo <R> --ticket <T> --run-id <ID> --input <file> [--unit <unit>]   # config.unitReview (Units)
```

### Unit rules inside other engine sections

Each of these completes a section of [execution-harness.md](execution-harness.md) for a DAG with units.

`status` prints, besides the fields named in the card, `units` and `unit_ceiling` only when the DAG has units (`unit_checks` and `unit_ceiling` in state likewise), `unit_reviews_pending` only with `config.unitReview` (`unit_reviews` in state likewise).

Round counters (card): a unit review execution: `rounds.unit_review_repairs[<review_execution>]`, present once one ran.

`rebind` (card) is also refused with units (`rebind_units`: unit evidence is not re-bound).

Judgment points (card): with units also `unit_check_failed`, `unit_invalidation_storm` and `parent_ceiling`, and with unit reviews `unit_review_terminal`. Gate refusals: its `units_unverified` and `unit_reviews_missing` refusals are not judgment points (`drive` runs the checks; the orchestrator relays the unit reviews).

`gate ship-ready` (card), with units:

With units, the unit conjuncts are re-checked after the proof
  ran: a proof command that leaves the tree but makes unit evidence stale (for example an
  empty commit moving `config.base`) is refused with the existing code (`units_unverified`,
  `unit_reviews_missing` or `units_consumed_stale`) and its proof dropped; the next `drive`
  re-checks the units (spending rechecks), and the proof command must be fixed or it moves the
  base again on the next ship-ready.

Eval report (card), metrics: `units` (the per-unit projection above) when the run has units.

## Unit review (opt-in: `config.unitReview`)

When the approved DAG splits the ticket into units and sets `config.unitReview: true`,
per-unit independent review is the main code inspection. **Unit reviews do not
replace the final review.** The final review in [review.md](review.md) is still mandatory on
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
- **Who.** An Opus primary reviewer that is independent of every builder, under the rules in [review.md](review.md). The gate refuses a reviewer whose identity equals a
  builder's. A **risky** unit (`status.units.<u>.review.risky`: a member node
  carries a risk label, or the ticket has `config.riskLabels`) also needs a
  second opinion from a provider other than the primary's (Codex for the Opus
  primary, whatever the host: on a Codex host the counterpart Claude would share
  the primary's provider and is refused), on its review and on its confirmation. If the counterpart is unavailable or its usage limit is
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
  the output contract in [review.md](review.md), with `candidate_id` set to
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
- **FAIL and repair.** Reconcile as in [review.md](review.md). An accepted FAIL with `fix` findings
  needs `repair_prompt_file` and opens one repair. Its write set (the fixed
  findings' paths plus `repair_ownership`) must lie inside the unit's declared
  writes; anything outside is `repair_outside_unit`, so leave that finding to the
  final review: record the unit review with that finding dispositioned to the
  final review (for example `final-review`, never `fix`) and its rows judged on
  the unit alone, so the unit can PASS (a unit FAIL with nothing to fix is
  terminal), then carry the finding into the final review as a primary finding
  to `fix`, whose one repair may cross units. `drive` runs the repair only while the unit's evidence is still
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
gate: leave it to the final review, whose one repair batch may cross units (record
it in the unit review dispositioned to the final review, not `fix`; see FAIL and
repair above). Every
repair still spends the run's ceilings; routing never adds a repair round.

## Final review on unit evidence

When unit reviews exist (`config.unitReview`), the final review in [review.md](review.md) is
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
  duplicated or old entry (`units_consumed_stale`); `gate ship-ready` re-checks the
  record that authorizes ship the same way. If a unit is stale, re-review
  that unit first; never reuse its old record.
- **Every mapped acceptance id is covered.** Each id in `config.acceptanceIds` is
  the `id` (or, when the row's `id` is not an acceptance id, the `criterion`) of one `acceptance_criteria` row (one row covers one id), so the end-to-end
  outcome of every criterion is graded on the assembled candidate. A row may cite
  unit evidence for a criterion verified inside one unit, but it still gets a row.
  `gate review` refuses an original that omits one (`acceptance_uncovered`).
- A final-review repair that changes a unit makes that unit's evidence and review
  stale: re-check and re-review the unit, then give the targeted confirmation a
  `units_consumed` list with the new evidence ids.

## Timing activities

The `unit_review*` activities occur only with `config.unitReview` (Unit review, above): give each the metrics `unit=<u>` and `review_execution=review-<opaque>`. The engine state
keeps the authoritative record (`status.units.<u>.review`, `UNIT_REVIEW_CYCLE` events with each
cycle's kind and trigger).
