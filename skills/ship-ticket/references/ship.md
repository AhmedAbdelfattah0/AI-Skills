# SHIP — the run record, one commit, and an external completion projection

Loaded when the SHIP phase starts. The spine carries the two things that must be
done from phase 1: capture timings as you go, and declare the companion mode up
front.

## The run record — the full schema

**One logical record, two temporal projections.** The committed projection is the
plan run state plus the ticket-keyed session-log entry and stops at `SHIP_READY`:
it contains only facts knowable before the commit. The postcommit projection
contains the commit, push, PR, CI and tracker results. It is emitted to the user
and appended to the tracker when reachable; it never writes back into the
repository. The two projections share `run_id` and `reviewed_content_id`.

## Canonical outcome vocabulary

This is the sole owner of outcome tokens for `ship-ticket`, its routed rule rows
and VAPT evidence. Every row uses the parseable shape `subject_id | outcome |
evidence`; checks may add `execution_mode` and `reason_code` fields, but those are
not outcomes. A pre-`F0` producer records its row in the frozen evidence artifact;
a post-`F0` producer appends it to the plan run state.

OUTCOME_VOCABULARY
PASS             the subject ran and satisfied every applicable condition
FAIL             the subject did not pass; blocks acceptance and close-out
NOT_TRIGGERED    the check's trigger was false; requires detector, complete changed-file classification and digest
NOT_APPLICABLE   the rule or parity comparator does not apply; requires the specific applicability evidence
DEGRADED         a reduced capability ran; requires every omitted class by ID or, only when no inventory exists, named family

`execution_mode` is one of `FULL`, `REUSED`, `GROUPED` or `REDUCED`. `REUSED`
names the deterministic output and bound digest and is never used for semantic
judgment. `GROUPED` names the shared definitions and proves every route executed
against them. `REDUCED` accompanies `DEGRADED`, never `PASS`.

**Any `FAIL` rule row makes its check `FAIL`.** A blank table, omitted row or
unrecognized token is also `FAIL`. Coverage is applicability-driven, so a check
that examined less than it should is a bug. Presentation may aggregate rows
already computed per rule — naming the IDs and the identical detector, inputs,
digest and result behind them. Evaluation may not: a family-level detector
standing in for per-rule evaluation is coverage loss.

### Path, frozen prefix and allowed later fields

This map replaces the former conceptual artifact list with exact storage and
mutation boundaries.

| Path | Frozen at `F0` | The only later writes |
|---|---|---|
| `.specs/plans/<TICKET>.md` | metadata, approved plan and Design Contract above `RUN-STATE:BEGIN` | JSON-lines entries appended between the existing run-state markers: `runs[]`, `batches[]`, `reviewers[]`, `manifests[]`, `findings[]`, `dispositions[]`, `outcomes[]`, `timings[]`, `degradations[]`; every entry carries its `run_id` |
| `.specs/design-parity/<TICKET>.md` | the whole pre-`F0` evidence artifact | none; pass A and terminal parity results go to the plan's run-state block |
| `.specs/vapt/<TICKET>.md` | the whole runtime-evidence artifact | none; terminal attack/security outcomes go to the plan's run-state block |
| candidate comments and docblocks, plus ticket-produced docs inside the Design Contract | their complete `F0` images | before the terminal verdict, only barrier 1 change units whose `record_impact_id` belongs to the pre-mutation sealed slice, whose exact causal code/test unit actually falsified the `F0` claim, and whose `F0`/`F1` images balance; none after the verdict |
| `session-log.md` | all pre-existing entries | one new ticket-keyed `SHIP_READY` entry before the commit, derived from the run-state block; no earlier entry may change and no postcommit result is written back |

The run-state storage categories and repair-batch shape are defined in
[review.md](review.md); check outcomes use the enum above. The terminal verdict is
one `outcomes[]` entry with review.md's canonical verdict shape. The frozen
prefixes contain only pre-`F0` candidate claims; post-`F0` findings, dispositions
and reviewer conclusions belong in run state by design.

In the committed projection across the frozen evidence and the plan's run-state
block, record:

- companion degradations and orchestration mode;
- `F0`, the final candidate manifest and the frozen-record digest;
- round-1 reviewer identities and verified paths;
- finding IDs, dispositions and the fix-packet digest when barrier 1 repaired the
  candidate;
- the sealed record-impact basis, prose inventory, slice digest, exclusions,
  causal edges and `F0`/`F1` result rows when barrier 1 repaired the candidate;
- terminal reviewer identity and every terminal sub-outcome;
- per reference-backed screen: round-1 grade, stable divergences, barrier-1
  impact slice and terminal parity outcome;
- per unreferenced screen: approver, date and search evidence;
- attack surfaces, named abuse tests, excluded files and degraded rule IDs;
- plan-critique dispositions and the append-only repair-batch entries;
- phase timings and concurrency windows through `SHIP_READY`; later external wait
  and completion timing belongs to the postcommit projection.

The external postcommit projection carries `run_id`, `reviewed_content_id`,
commit OID, push result, PR URL, CI result, tracker transition and completion
timestamp, plus `ship_outcome: PASS | FAIL` once terminal. A paused operation has
`ship_outcome` absent and carries `paused_operation` plus its error instead of
pretending to be terminal. Facts absent at the cutoff are absent, not predicted
or backfilled.

Persist lists, not hand-maintained totals. Derive counts when presenting the
record.

**Written so it survives the context.** "Tried to break the new endpoint — all
attacks refused" is recoverable months later; "security gate: PASS" is not. "Skipped some
findings that conflicted with our conventions" is worthless.

## Before the commit

**Confirm the terminal verdict is already present in `outcomes[]`, then append the
`SHIP_READY` run event, SHIP-start timing and precommit session-log projection.**
Do not claim a commit OID, push, PR, CI result, tracker transition, completion
timestamp or final SHIP outcome: none exists yet. Run `/session-logger`, or write
the entry yourself to `session-log.md`; either way this cutoff must be on disk
before the commit.

**Then recompute `reviewed_content_id` and verify the frozen record and exact
append slots.** It must equal the terminal reviewer's value. The reviewed prefixes
must still match their digests, and every later byte must belong to the terminal
verdict, `SHIP_READY`, timing or session-log fields defined before `F0`. Any code,
test, comment, doc or narrative artifact change ends the run as unreviewed.

## The commit

**One commit, containing everything:**

- the code
- `.specs/plans/<TICKET>.md` — with its immutable prefix and append-only run state
- `.specs/design-parity/<TICKET>.md` — **iff `ui_required`**
- `.specs/vapt/<TICKET>.md` **and the abuse tests it produced** — **iff the diff
  touched a trust boundary**
- the doc updates
- `session-log.md`

A non-UI ticket produces no parity artifact and a ticket touching no trust
boundary produces no attack artifact. Their absence is correct, and the run record
says `NOT_TRIGGERED` with the detector evidence rather than leaving a silent gap.

**Push it once.**

The commit is the repository cutoff. From this point through ticket completion,
write no repository file. Collect results in the external postcommit projection;
never amend or add a second commit merely to record an outcome that did not exist
at the cutoff.

## The PR

Open it **on the repo's actual host** — Azure Repos via the ADO repo tools, or
GitHub via `gh`, per the tracker table in [understand.md](understand.md). Link the
ticket to the PR and report the URL.

Then wait for the one enumerated CI execution. Do not wait for PR-side review
bots. A host, network or explicitly rerunnable CI infrastructure failure pauses
SHIP. On resume, recompute the same `reviewed_content_id`, verify the frozen
prefixes and append-only record, inspect which external operations already
succeeded, and perform only the missing idempotent operation. Never rerun REVIEW.
A deterministic red check, a changed identity or any required repository fix
concludes the run unshipped and requires a new human-approved execution.

## Closing the ticket

Transition it to **Done** only after the gate checks are green, using the
tracker's transition operation — the Jira workflow transition, or
`wit_update_work_item` to the work item type's resolved completed-category state.

Record each postcommit event only after it happens. After the transition succeeds,
append the final projection to the ticket when the tracker supports comments;
the transition's own history is evidence for its result. If the tracker is the
unavailable service that paused SHIP, report the partial projection to the user
and continue it when the same run resumes. The tracker history/comment and user
report are the durable homes for these facts; the committed projection remains
truthfully cut off at `SHIP_READY`.

Then tell the user the PR is open and ready to merge, and ask them to run
`/compact`. Both the merge and `/compact` are theirs; this skill does neither.

For UI tickets, the user is also the human approver of any accepted deviation.
